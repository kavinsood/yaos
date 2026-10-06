/**
 * Local compaction and checkpoint union (DESIGN §d.7 union job, §d.8).
 *
 * Always through a scratch Y.Doc({gc: true}) re-encoded with the counted
 * encodeStateAsUpdate; never Y.mergeUpdates over stored rows. The resident
 * replica is not touched. T_snapshot is a CAS on snapshotCoversSeq and deletes
 * exactly the tail keys that were folded in.
 *
 * ns: the snapshot is the nsFoldV1 encoding of the fold state at its coversSeq.
 * cfg: snapshot = cfgFoldV1 of the cfg fold at its coversSeq (compactCfg).
 */

import * as Y from "yjs";
import { CheckpointEncoding } from "../../core/envelope";
import { streamClass, type Seq, type StreamName } from "../../core/types";
import type { Repo } from "../store/repo";
import type { SnapshotRecord, StreamRecord, TailRecord } from "../store/schema";
import type { OutboxCache } from "../runtime/outboxCache";
import type { FoldRuntime } from "../sync/foldRuntime";
import { encodeStateAsUpdate, ORIGIN } from "./yjsCounters";

export interface CompactDeps {
	readonly repo: Repo;
	readonly outbox: OutboxCache;
	/** Resolve a bodyUpdateRef tail row (null = not available: compaction aborts). */
	resolveRef(row: TailRecord): Promise<Uint8Array | null>;
	nowMs(): number;
}

export type CompactResult =
	| { readonly t: "ok"; readonly coversSeq: Seq; readonly bytes: number; readonly rows: number }
	| { readonly t: "skip"; readonly reason: "unknown" | "stale" | "frozen" | "outbox" | "nothing" | "unresolved-ref" | "cas" | "halted" | "class" };

/** Every precondition of DESIGN §d.8 (plus: frozen streams keep their tail, so released quarantine rows still land). */
export function compactionBlocked(rec: StreamRecord | undefined, outbox: OutboxCache): CompactResult | null {
	if (!rec) return { t: "skip", reason: "unknown" };
	if (rec.stale) return { t: "skip", reason: "stale" };
	if (rec.frozen) return { t: "skip", reason: "frozen" };
	if (outbox.blocksCompaction(rec.stream)) return { t: "skip", reason: "outbox" };
	return null;
}

/** Fold snapshot + rows into a scratch doc and re-encode. Refs must already be resolved. */
export function foldToState(snapshot: Uint8Array | null, updates: readonly Uint8Array[], extra: Uint8Array | null = null): Uint8Array {
	const scratch = new Y.Doc({ gc: true });
	try {
		scratch.transact(() => {
			if (snapshot && snapshot.length > 0) Y.applyUpdate(scratch, snapshot, ORIGIN.LOAD);
			for (const u of updates) if (u.length > 0) Y.applyUpdate(scratch, u, ORIGIN.LOAD);
			if (extra && extra.length > 0) Y.applyUpdate(scratch, extra, ORIGIN.LOAD);
		}, ORIGIN.LOAD);
		return encodeStateAsUpdate(scratch);
	} finally {
		scratch.destroy();
	}
}

async function resolveRows(deps: Pick<CompactDeps, "resolveRef">, rows: readonly TailRecord[]): Promise<Uint8Array[] | null> {
	const out: Uint8Array[] = [];
	for (const row of rows) {
		if (row.kind === "bodyUpdate" || row.kind === "canvasUpdate") out.push(row.content);
		else if (row.kind === "bodyUpdateRef") {
			const u = await deps.resolveRef(row);
			if (!u) return null;
			out.push(u);
		}
	}
	return out;
}

/** T_compact for a body/canvas stream: C = appliedSeq. */
export async function compactBody(deps: CompactDeps, stream: StreamName): Promise<CompactResult> {
	const cls = streamClass(stream);
	if (cls !== "body" && cls !== "canvas") return { t: "skip", reason: "class" };
	const rec = deps.repo.stream(stream);
	const blocked = compactionBlocked(rec, deps.outbox);
	if (blocked || !rec) return blocked ?? { t: "skip", reason: "unknown" };
	const c = rec.appliedSeq;
	const expect = rec.snapshotCoversSeq;
	const { snapshot, tail } = await deps.repo.loadStream(stream);
	const rows = tail.filter((r) => r.seq <= c);
	if (rows.length === 0 && c <= expect) return { t: "skip", reason: "nothing" };
	const updates = await resolveRows(deps, rows);
	if (!updates) return { t: "skip", reason: "unresolved-ref" };
	const base = snapshot && snapshot.encoding === CheckpointEncoding.yjsStateV1 ? snapshot.bytes : null;
	const bytes = foldToState(base, updates);
	const snap: SnapshotRecord = { stream, coversSeq: Math.max(c, expect), encoding: CheckpointEncoding.yjsStateV1, bytes, createdAtMs: deps.nowMs() };
	const out = await deps.repo.tSnapshot({ stream, expectSnapshotCoversSeq: expect, snapshot: snap, deleteSeqs: rows.map((r) => r.seq), fromRemote: false });
	if (!out) return { t: "skip", reason: "cas" };
	return { t: "ok", coversSeq: snap.coversSeq, bytes: bytes.length, rows: rows.length };
}

/**
 * Checkpoint union (DESIGN §d.7): scratch = local snapshot + every local tail
 * row <= coversSeq + the checkpoint state -> T_snapshot(fromRemote). Returns the
 * new stream record, or null when the CAS failed / a ref is unresolved.
 */
export async function unionBodyCheckpoint(deps: CompactDeps, stream: StreamName, coversSeq: Seq, state: Uint8Array): Promise<StreamRecord | null> {
	const rec = deps.repo.stream(stream);
	if (!rec || coversSeq <= rec.snapshotCoversSeq) return rec ?? null;
	const expect = rec.snapshotCoversSeq;
	const { snapshot, tail } = await deps.repo.loadStream(stream);
	const rows = tail.filter((r) => r.seq <= coversSeq);
	const updates = await resolveRows(deps, rows);
	if (!updates) return null;
	const base = snapshot && snapshot.encoding === CheckpointEncoding.yjsStateV1 ? snapshot.bytes : null;
	const bytes = foldToState(base, updates, state);
	return deps.repo.tSnapshot({
		stream, expectSnapshotCoversSeq: expect,
		snapshot: { stream, coversSeq, encoding: CheckpointEncoding.yjsStateV1, bytes, createdAtMs: deps.nowMs() },
		deleteSeqs: rows.map((r) => r.seq), fromRemote: true,
	});
}

/** ns compaction: snapshot = nsFoldV1(state) at state.coversSeq; deletes tail rows <= it. */
/** ns / cfg compaction (§d.8): snapshot = the fold's canonical bytes at its coversSeq, tail <= coversSeq deleted. */
export async function compactFold(deps: Pick<CompactDeps, "repo" | "nowMs">, fold: FoldRuntime<unknown, unknown>): Promise<CompactResult> {
	const stream = fold.stream;
	const rec = deps.repo.stream(stream);
	if (!rec) return { t: "skip", reason: "unknown" };
	if (rec.stale) return { t: "skip", reason: "stale" };
	await fold.advance();
	if (fold.halted) return { t: "skip", reason: "halted" };
	const c = fold.coversSeq;
	const expect = rec.snapshotCoversSeq;
	if (c <= expect) return { t: "skip", reason: "nothing" };
	const rows = await deps.repo.getTail(stream, 0, c);
	const bytes = fold.encodeState();
	const out = await deps.repo.tSnapshot({
		stream, expectSnapshotCoversSeq: expect,
		snapshot: { stream, coversSeq: c, encoding: fold.encoding, bytes, createdAtMs: deps.nowMs() },
		deleteSeqs: rows.map((r) => r.seq), fromRemote: false,
	});
	if (!out) return { t: "skip", reason: "cas" };
	return { t: "ok", coversSeq: c, bytes: bytes.length, rows: rows.length };
}

/** Local compaction trigger (DESIGN §d.8). */
export function needsCompaction(rec: StreamRecord, rows: number, bytes: number): boolean {
	return rec.tailRows > rows || rec.tailBytes > bytes;
}
