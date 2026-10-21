/**
 * Stream catch-up reads (DESIGN §d.7 step 4).
 *
 * readStream() pages read(stream, appliedSeq, preferCheckpoint = appliedSeq
 * === 0), gates every page BEFORE its transaction and commits it with
 * T_read_page. Rows are classified as live ones are (classifyRow, ingestRow.ts): a late receipt (committed
 * stale: renamed to a copy), else gated (tail / quarantine / accounted); another device's row matching an
 * adoptable settles it (stored, not re-applied), and so does a body/canvas checkpoint adopted on the page that
 * already holds the adoptable's content (its commit lies under the checkpoint, the row may be GC'd).
 *
 * Checkpoint with coversSeq > snapshotCoversSeq (after the gate):
 *  - retired (a dead doc's b: / c: stream, DESIGN §b.5): nothing adopted, counted `checkpoint-retired`;
 *  - fresh stream (no snapshot, no tail): stored as the snapshot in the page tx;
 *  - body/canvas otherwise: union job (scratch doc = snapshot + tail <= C +
 *    checkpoint) -> T_snapshot(fromRemote);
 *  - ns/cfg otherwise: the verified fold state replaces the snapshot (tail <= C
 *    deleted) and the caller reloads the fold.
 * A checkpoint that fails the gate (DESIGN §d.7 "Checkpoint gate failures"):
 *  - newer rules or format on ns/cfg/snap (GateFail.newer): "held" at once, upgrade = true. Nothing of the
 *    page is stored, no row past it is folded on these rules, nothing is marked: the caller halts the fold
 *    (upgrade-required) and an upgraded client adopts the checkpoint on its next read;
 *  - otherwise reader-dependent (a key, a pin or `k` not judged yet; a newer body checkpoint): if
 *    preferCheckpoint was set the page is re-read without it (the rows gate on their own, as live rows do);
 *    if it comes back the rows below it are gone and the read is "held" (upgrade = GateFail.newer), the
 *    stream stale, nothing marked: the next session or keyring change reads it again;
 *  - deterministic (bad bytes from a writer of this version): "disputed". If preferCheckpoint was set the
 *    page is re-read without it (rows may still exist); if it comes back the rows below it are gone, the
 *    stream is frozen `checkpoint-disputed` and the read stops without completing (the stream stays stale).
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
import { unionBodyCheckpoint, updateCoveredBy, type CompactDeps } from "../body/compaction";
import { gate, type GateCtx } from "../ingest/gate";
import type { LiveItem, OutboxRename, OwnCommitCopy } from "../store/repo";
import type { OutboxRecord, QuarantineRecord, SnapshotRecord, StreamRecord, TailRecord } from "../store/schema";
import { classifyRow, notApplied } from "./ingestRow";

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
	readonly t: "done" | "aborted" | "retry" | "disputed" | "held" | "partial";
	readonly pages: number;
	readonly rows: number;
	/** body/canvas checkpoint state adopted (fresh or union): apply to a resident replica. */
	readonly checkpointState: Uint8Array | null;
	/** ns/cfg snapshot replaced by a checkpoint: reload the fold. */
	readonly replacedFold: boolean;
	readonly removed: OutboxRecord[];
	/** Commit seqs of the receipted records among `removed`. */
	readonly receipts: Map<ClientFrameId, Seq>;
	readonly updated: OutboxRecord[];
	readonly renamed: OutboxRename[];
	/** Every tail row written. */
	readonly tailPut: TailRecord[];
	/** Seqs of tailPut not to apply to a replica: late receipts and settled adoptables (notApplied). */
	readonly skip: ReadonlySet<Seq>;
	readonly stream: StreamRecord | null;
	readonly error?: string;
	/** t = "held": the checkpoint this reader cannot use yet; upgrade = only a newer client can (GateFail.newer). */
	readonly held?: { readonly coversSeq: Seq; readonly upgrade: boolean; readonly detail: string };
}

function isFresh(rec: StreamRecord | undefined): boolean {
	return !rec || (rec.snapshotCoversSeq === 0 && rec.tailRows === 0);
}

export async function readStream(deps: CatchUpDeps, session: RelaySession, stream: StreamName, opts: ReadOptions): Promise<ReadResult> {
	const repo = deps.repo;
	const cls = streamClass(stream);
	const removed: OutboxRecord[] = [];
	const receipts = new Map<ClientFrameId, Seq>();
	const updated: OutboxRecord[] = [];
	const renamed: OutboxRename[] = [];
	const tailPut: TailRecord[] = [];
	const skip = new Set<Seq>();
	let checkpointState: Uint8Array | null = null;
	let replacedFold = false;
	let pages = 0;
	let rowsSeen = 0;
	const result = (t: ReadResult["t"], error?: string, held?: ReadResult["held"]): ReadResult => ({
		t, pages, rows: rowsSeen, checkpointState, replacedFold, removed, receipts, updated, renamed, tailPut, skip, stream: repo.stream(stream) ?? null,
		...(error ? { error } : {}), ...(held ? { held } : {}),
	});
	if (cls === "other") return result("done");
	const start = repo.stream(stream);
	let after = opts.fromSeq ?? start?.appliedSeq ?? 0;
	// `k` has no checkpoints (e2ee-design §18.3): every record is read.
	let preferCheckpoint = after === 0 && cls !== "keyring";
	let disputedRetry = false;
	let heldRetry = false;
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
		/** body/canvas checkpoint state adopted on this page. */
		let pageCheckpoint: Uint8Array | null = null;
		const ck = cls === "keyring" ? null : page.checkpoint;
		const rec = repo.stream(stream);
		if (ck && ck.coversSeq > (rec?.snapshotCoversSeq ?? 0)) {
			const disputedBefore = rec !== undefined && rec.disputedCheckpointCoversSeq === ck.coversSeq;
			const g = disputedBefore ? null : await gate(deps.gateCtx, { t: "checkpoint", stream, coversSeq: ck.coversSeq, payload: ck.bytes });
			if (!opts.stillValid()) return result("aborted");
			if (g && !g.ok && g.readerDependent) {
				// Not this checkpoint's fault: never disputed, never frozen, nothing stored.
				const detail = `${g.reason}: ${g.detail}`;
				const fold = cls === "ns" || cls === "cfg" || cls === "snap";
				if (g.newer && fold) {
					// Rows past it would be folded on rules this reader does not have: halt here (§c.10).
					deps.diag("checkpoint-upgrade-required", { cls, coversSeq: ck.coversSeq, detail });
					return result("held", detail, { coversSeq: ck.coversSeq, upgrade: true, detail });
				}
				if (preferCheckpoint && !heldRetry) {
					deps.diag("checkpoint-held", { cls, coversSeq: ck.coversSeq, detail, reread: true });
					heldRetry = true;
					preferCheckpoint = false;
					continue;
				}
				deps.diag("checkpoint-held", { cls, coversSeq: ck.coversSeq, detail, reread: false });
				return result("held", detail, { coversSeq: ck.coversSeq, upgrade: g.newer, detail });
			}
			if (!g || !g.ok || g.t !== "checkpoint") {
				const detail = g && !g.ok ? `${g.reason}: ${g.detail}` : disputedBefore ? "disputed before" : "not a checkpoint";
				deps.diag("checkpoint-disputed", { cls, coversSeq: ck.coversSeq, detail });
				if (preferCheckpoint && !disputedRetry) {
					disputedRetry = true;
					preferCheckpoint = false;
					await repo.tPatchStreams([{ stream, patch: (r) => { r.disputedCheckpointCoversSeq = ck.coversSeq; } }]);
					continue;
				}
				// Rows below the checkpoint are gone: nothing can complete this stream.
				await repo.tPatchStreams([{ stream, patch: (r) => {
					r.disputedCheckpointCoversSeq = ck.coversSeq;
					r.frozen = 1;
					r.frozenReason = "checkpoint-disputed";
				} }]);
				return result("disputed", detail);
			}
			const content = g.checkpoint;
			if (content.encoding === CheckpointEncoding.retired) {
				// A dead doc's stream (pruned, or a merged alias; body/retire.ts): a checkpoint with no state. Nothing is
				// adopted (the union adds nothing), rows above it still apply, and the page completes the stream as any
				// other. The maintenance tick drops the stream's records once the fold says the doc is dead and nothing
				// lies above the checkpoint (Repo.tDropStream); a reader whose fold still has the doc keeps them.
				deps.diag("checkpoint-retired", { cls, coversSeq: ck.coversSeq });
			} else if (isFresh(rec)) {
				freshSnapshot = { stream, coversSeq: ck.coversSeq, encoding: content.encoding, bytes: content.state, createdAtMs: deps.nowMs() };
				if (cls === "body" || cls === "canvas") checkpointState = pageCheckpoint = content.state;
				else replacedFold = true;
				deps.diag("checkpoint-adopted", { cls, coversSeq: ck.coversSeq, how: "fresh" });
			} else if (cls === "body" || cls === "canvas") {
				const out = await unionBodyCheckpoint(deps, stream, ck.coversSeq, content.state);
				if (!opts.stillValid()) return result("aborted");
				if (!out || out.snapshotCoversSeq < ck.coversSeq) return result("retry", "union failed (CAS or unresolved ref)");
				checkpointState = pageCheckpoint = content.state;
				deps.diag("checkpoint-adopted", { cls, coversSeq: ck.coversSeq, how: "union" });
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
				deps.diag("checkpoint-adopted", { cls, coversSeq: ck.coversSeq, how: "replace" });
			}
		}
		const items: LiveItem[] = [];
		for (const r of page.rows) items.push(await classifyRow(deps, { stream, seq: r.seq, deviceId: r.deviceId, clientFrameId: r.clientFrameId, payload: r.payload }));
		rowsSeen += items.length;
		const rows: TailRecord[] = [];
		const quarantines: QuarantineRecord[] = [];
		const lateReceipts: { clientFrameId: ClientFrameId; seq: Seq; copy?: OwnCommitCopy }[] = [];
		const settleAdoptables: ClientFrameId[] = [];
		for (const it of items) {
			if (it.t === "receipt") lateReceipts.push(it.copy ? { clientFrameId: it.clientFrameId, seq: it.seq, copy: it.copy } : { clientFrameId: it.clientFrameId, seq: it.seq });
			else if (it.t === "row") rows.push(it.row);
			else if (it.t === "quarantine") quarantines.push(it.rec);
			// "stale" needs a payload not held: a read page holds every one.
			if (it.t !== "receipt" && it.t !== "stale" && it.settleAdoptable) settleAdoptables.push(it.settleAdoptable);
		}
		// A checkpoint over rows this read will never see (GC'd) may hold the commit an adoptable shadows: settle it
		// when the checkpoint already holds its content, rather than re-send it after provisionalAdoptMs (DESIGN §d.5).
		if (pageCheckpoint) {
			for (const r of deps.outbox.ofStream(stream)) {
				if (r.state === "adoptable" && !settleAdoptables.includes(r.clientFrameId) && updateCoveredBy(pageCheckpoint, r.content)) settleAdoptables.push(r.clientFrameId);
			}
		}
		if (!opts.stillValid()) return result("aborted");
		const completeThrough = page.more ? null : Math.max(opts.headSeq, page.lastSeq);
		const out = await repo.tReadPage({
			stream, rows, quarantines, lateReceipts, settleAdoptables, freshSnapshot, completeThrough, lastSeq: page.lastSeq, checkpointSeq: page.checkpointSeq,
		});
		removed.push(...out.removed);
		for (const [cfid, seq] of out.receipts) receipts.set(cfid, seq);
		updated.push(...out.updated);
		renamed.push(...out.renamed);
		tailPut.push(...out.tailPut);
		notApplied(items, skip);
		if (!page.more) return result("done");
		after = Math.max(after, page.nextAfterSeq);
		preferCheckpoint = false;
	}
}

/** Streams to read, lowest priority value first (keyring, bound docs, ns, cfg, snap, bodies, other). */
export function staleOrder(streams: Iterable<StreamRecord>, priority: (r: StreamRecord) => number, skip: (r: StreamRecord) => boolean): StreamRecord[] {
	const out: StreamRecord[] = [];
	for (const r of streams) if (r.stale && !skip(r)) out.push(r);
	return out.sort((a, b) => priority(a) - priority(b) || (a.stream === NS_STREAM ? -1 : b.stream === NS_STREAM ? 1 : 0) || a.appliedSeq - b.appliedSeq);
}
