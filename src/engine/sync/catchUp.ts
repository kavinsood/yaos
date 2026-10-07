/**
 * Stream catch-up reads (DESIGN §d.7 step 4).
 *
 * readStream() pages read(stream, appliedSeq, preferCheckpoint = appliedSeq
 * === 0), gates every page BEFORE its transaction and commits it with
 * T_read_page:
 *  - own row whose clientFrameId is in the outbox  -> late receipt (committed stale: renamed to a copy,
 *                                                     ownCommitCopy);
 *  - other device's row matching an adoptable      -> settle (stored, not re-applied);
 *  - everything else                               -> gateRow (tail / quarantine / accounted).
 *
 * Checkpoint with coversSeq > snapshotCoversSeq (after the gate):
 *  - fresh stream (no snapshot, no tail): stored as the snapshot in the page tx;
 *  - body/canvas otherwise: union job (scratch doc = snapshot + tail <= C +
 *    checkpoint) -> T_snapshot(fromRemote);
 *  - ns/cfg otherwise: the verified fold state replaces the snapshot (tail <= C
 *    deleted) and the caller reloads the fold.
 * A checkpoint that fails the gate is "disputed": if preferCheckpoint was set
 * the page is re-read without it (rows may still exist); if it comes back the
 * rows below it are gone, the stream is frozen `checkpoint-disputed` and the
 * read stops without completing (the stream stays stale).
 *
 * A batched read (sessionLoop) hands its page in as `first`; it stands in for the first read() only when it
 * was read from the same cursor and checkpoint preference this read starts with.
 *
 * Completion: the last page (more = false) carries completeThrough =
 * max(session H, lastSeq). It is only valid in the session the read started
 * in: stillValid() is checked after every await before committing.
 */

import { CheckpointEncoding } from "../../core/envelope";
import { NS_STREAM, streamClass, type ClientFrameId, type DeviceId, type Seq, type StreamName } from "../../core/types";
import type { HashPort } from "../../ports/crypto";
import type { RandomPort } from "../../ports/random";
import type { ReadPage, RelaySession } from "../../ports/relay";
import { unionBodyCheckpoint, type CompactDeps } from "../body/compaction";
import { gate, type GateCtx } from "../ingest/gate";
import type { OutboxRename, OwnCommitCopy } from "../store/repo";
import type { OutboxRecord, QuarantineRecord, SnapshotRecord, StreamRecord, TailRecord } from "../store/schema";
import { gateRow, ownCommitCopy } from "./ingestRow";

export interface CatchUpDeps extends CompactDeps {
	readonly gateCtx: GateCtx;
	readonly hash: HashPort;
	readonly self: DeviceId;
	/** Ids for the copies of own stale commits. */
	readonly random: RandomPort;
	/** Own adoptable shadowing (deviceId, clientFrameId), if any (DESIGN §d.5 settle). */
	adoptFor(deviceId: DeviceId, clientFrameId: ClientFrameId): ClientFrameId | null;
	diag(code: string, fields: Record<string, string | number | boolean | null>): void;
}

export interface ReadOptions {
	/** Session VAULT_READY head. */
	readonly headSeq: Seq;
	/** Override the start (causal-hole re-read from snapshotCoversSeq). */
	readonly fromSeq?: Seq;
	/** False once the session that started the read is gone. */
	stillValid(): boolean;
	/** Stop after this many pages (tests); the stream stays stale. */
	readonly maxPages?: number;
	/** The first page, already read by a batched read with these arguments. */
	readonly first?: { readonly afterSeq: Seq; readonly preferCheckpoint: boolean; readonly page: ReadPage };
}

export interface ReadResult {
	readonly t: "done" | "aborted" | "retry" | "disputed" | "partial";
	readonly pages: number;
	readonly rows: number;
	/** body/canvas checkpoint state adopted (fresh or union): apply to a resident replica. */
	readonly checkpointState: Uint8Array | null;
	/** ns/cfg snapshot replaced by a checkpoint: reload the fold. */
	readonly replacedFold: boolean;
	readonly removed: OutboxRecord[];
	readonly updated: OutboxRecord[];
	readonly renamed: OutboxRename[];
	/** Tail rows to apply to a resident replica (late receipts and settled adoptables excluded). */
	readonly apply: TailRecord[];
	/** Every tail row written. */
	readonly tailPut: TailRecord[];
	readonly stream: StreamRecord | null;
	readonly error?: string;
}

function isFresh(rec: StreamRecord | undefined): boolean {
	return !rec || (rec.snapshotCoversSeq === 0 && rec.tailRows === 0);
}

export async function readStream(deps: CatchUpDeps, session: RelaySession, stream: StreamName, opts: ReadOptions): Promise<ReadResult> {
	const repo = deps.repo;
	const cls = streamClass(stream);
	const removed: OutboxRecord[] = [];
	const updated: OutboxRecord[] = [];
	const renamed: OutboxRename[] = [];
	const apply: TailRecord[] = [];
	const tailPut: TailRecord[] = [];
	let checkpointState: Uint8Array | null = null;
	let replacedFold = false;
	let pages = 0;
	let rowsSeen = 0;
	const result = (t: ReadResult["t"], error?: string): ReadResult => ({
		t, pages, rows: rowsSeen, checkpointState, replacedFold, removed, updated, renamed, apply, tailPut, stream: repo.stream(stream) ?? null, ...(error ? { error } : {}),
	});
	if (cls === "other") return result("done");
	const start = repo.stream(stream);
	let after = opts.fromSeq ?? start?.appliedSeq ?? 0;
	// `k` has no checkpoints (e2ee-design §18.3): every record is read.
	let preferCheckpoint = after === 0 && cls !== "keyring";
	let disputedRetry = false;
	let first = opts.first && opts.first.afterSeq === after && opts.first.preferCheckpoint === preferCheckpoint ? opts.first.page : null;
	for (;;) {
		if (opts.maxPages !== undefined && pages >= opts.maxPages) return result("partial");
		let page;
		try {
			page = first ?? await session.read(stream, after, preferCheckpoint);
			first = null;
		} catch (e) {
			return result("aborted", e instanceof Error ? e.message : String(e));
		}
		if (!opts.stillValid()) return result("aborted");
		pages++;
		let freshSnapshot: SnapshotRecord | null = null;
		const ck = cls === "keyring" ? null : page.checkpoint;
		const rec = repo.stream(stream);
		if (ck && ck.coversSeq > (rec?.snapshotCoversSeq ?? 0)) {
			const disputedBefore = rec !== undefined && rec.disputedCheckpointCoversSeq === ck.coversSeq;
			const g = disputedBefore ? null : await gate(deps.gateCtx, { t: "checkpoint", stream, coversSeq: ck.coversSeq, payload: ck.bytes });
			if (!opts.stillValid()) return result("aborted");
			if (!g || !g.ok || g.t !== "checkpoint") {
				const detail = g && !g.ok ? `${g.reason}: ${g.detail}` : disputedBefore ? "disputed before" : "not a checkpoint";
				deps.diag("checkpoint-disputed", { cls, coversSeq: ck.coversSeq, detail });
				if (preferCheckpoint && !disputedRetry) {
					disputedRetry = true;
					preferCheckpoint = false;
					await repo.tPatchStreams([{ stream, patch: (r) => { r.disputedCheckpointCoversSeq = ck.coversSeq; } }], deps.nowMs());
					continue;
				}
				// Rows below the checkpoint are gone: nothing can complete this stream.
				await repo.tPatchStreams([{ stream, patch: (r) => {
					r.disputedCheckpointCoversSeq = ck.coversSeq;
					r.frozen = 1;
					r.frozenReason = "checkpoint-disputed";
				} }], deps.nowMs());
				return result("disputed", detail);
			}
			const content = g.checkpoint;
			if (content.encoding === CheckpointEncoding.retired) {
				// Retired streams (x: / pruned bodies) are not adopted locally (gap: retirement handling).
				deps.diag("checkpoint-retired", { cls, coversSeq: ck.coversSeq });
			} else if (isFresh(rec)) {
				freshSnapshot = { stream, coversSeq: ck.coversSeq, encoding: content.encoding, bytes: content.state, createdAtMs: deps.nowMs() };
				if (cls === "body" || cls === "canvas") checkpointState = content.state;
				else replacedFold = true;
			} else if (cls === "body" || cls === "canvas") {
				const out = await unionBodyCheckpoint(deps, stream, ck.coversSeq, content.state);
				if (!opts.stillValid()) return result("aborted");
				if (!out || out.snapshotCoversSeq < ck.coversSeq) return result("retry", "union failed (CAS or unresolved ref)");
				checkpointState = content.state;
			} else if (cls === "ns" || cls === "cfg" || cls === "snap") {
				const cur = repo.stream(stream)!;
				const tail = await repo.getTail(stream, 0, ck.coversSeq);
				const out = await repo.tSnapshot({
					stream, expectSnapshotCoversSeq: cur.snapshotCoversSeq,
					snapshot: { stream, coversSeq: ck.coversSeq, encoding: content.encoding, bytes: content.state, createdAtMs: deps.nowMs() },
					deleteSeqs: tail.map((r) => r.seq), fromRemote: true,
				});
				if (!opts.stillValid()) return result("aborted");
				if (!out) return result("retry", "fold snapshot CAS");
				replacedFold = true;
			}
		}
		const rows: TailRecord[] = [];
		const quarantines: QuarantineRecord[] = [];
		const lateReceipts: { clientFrameId: ClientFrameId; seq: Seq; copy?: OwnCommitCopy }[] = [];
		const settleAdoptables: ClientFrameId[] = [];
		const settledSeqs = new Set<Seq>();
		const receiptSeqs = new Set<Seq>();
		for (const r of page.rows) {
			rowsSeen++;
			if (r.deviceId === deps.self) {
				const ob = deps.outbox.get(r.clientFrameId);
				if (ob && ob.stream === stream) {
					const copy = ownCommitCopy(deps.gateCtx, deps.random, deps.self, ob, r.seq);
					lateReceipts.push(copy ? { clientFrameId: r.clientFrameId, seq: r.seq, copy } : { clientFrameId: r.clientFrameId, seq: r.seq });
					receiptSeqs.add(r.seq);
					continue;
				}
			}
			const g = await gateRow(deps.gateCtx, deps.hash, { stream, seq: r.seq, deviceId: r.deviceId, clientFrameId: r.clientFrameId, payload: r.payload }, deps.nowMs());
			if (g.t === "row") rows.push(g.row);
			else if (g.t === "quarantine") quarantines.push(g.rec);
			if (r.deviceId !== deps.self) {
				const a = deps.adoptFor(r.deviceId, r.clientFrameId);
				if (a) {
					settleAdoptables.push(a);
					settledSeqs.add(r.seq);
				}
			}
		}
		if (!opts.stillValid()) return result("aborted");
		const completeThrough = page.more ? null : Math.max(opts.headSeq, page.lastSeq);
		const out = await repo.tReadPage({
			stream, rows, quarantines, lateReceipts, settleAdoptables, freshSnapshot, completeThrough, lastSeq: page.lastSeq, checkpointSeq: page.checkpointSeq,
		}, deps.nowMs());
		removed.push(...out.removed);
		updated.push(...out.updated);
		renamed.push(...out.renamed);
		tailPut.push(...out.tailPut);
		for (const row of out.tailPut) if (!receiptSeqs.has(row.seq) && !settledSeqs.has(row.seq)) apply.push(row);
		if (!page.more) return result("done");
		after = Math.max(after, page.nextAfterSeq);
		preferCheckpoint = false;
	}
}

/** Streams to read, lowest priority value first (bound docs, ns, cfg, bodies, x:). */
export function staleOrder(streams: Iterable<StreamRecord>, priority: (r: StreamRecord) => number, skip: (r: StreamRecord) => boolean): StreamRecord[] {
	const out: StreamRecord[] = [];
	for (const r of streams) if (r.stale && !skip(r)) out.push(r);
	return out.sort((a, b) => priority(a) - priority(b) || (a.stream === NS_STREAM ? -1 : b.stream === NS_STREAM ? 1 : 0) || a.appliedSeq - b.appliedSeq);
}
