/**
 * Retired streams (DESIGN §b.5 "retired", §c.9, §d.9): the relay rows and local records of dead docs.
 *
 * A doc is dead when no reader will ever materialize its `b:` / `c:` stream again, on positive evidence only:
 *  - merged: its committed ns entry is a merged alias (final: ops on it are redirected, nothing revives it);
 *  - pruned: it has no committed ns entry, but a record of its deleted entry's prune: the committed state's
 *    pruned-delete stub (NsFoldState.pruned), or the delete base this device kept when its own fold removed the entry
 *    (NsRuntime.removedDeletes, StreamRecord.prunedDeleteBase). Either way a fold folded its create, its delete and
 *    the prune (docIds are never reused; a restore of a pruned docId is ignored), so nothing revives it. And the fold
 *    provably saw every ns row up to the stream's last row (FoldCompleteness).
 * Absence is not evidence. A doc with no entry and no record of a prune is kept, whatever the fold saw: its create
 * may not be folded yet (a body row can reach the relay before its create's ns row: sim suite-1 seed 264 retired such
 * a body and lost the doc), its stub may have aged out of PRUNED_STUB_CAP on a device that never folded the prune, or
 * it was a merged alias pruned (they leave no stub). Keeping such a stream costs relay space, never content.
 * A deleted doc is not dead: its body stays for a restore (§c.7) and its stream is checkpointed as any other.
 *
 * Writer (maintenance.ts, bounded per tick): a dead stream with rows beyond the relay's checkpoint gets a
 * `retired` checkpoint at coversSeq = its lastSeq (appliedSeq of a caught-up stream), CAS on the known checkpoint
 * seq. A checkpoint at lastSeq retires the relay stream (server H7: every segment and the open rows go, gcSeq =
 * lastSeq; the head row and the small checkpoint stay). Duty: the device whose ns frame pruned or merged the doc
 * (RetireState.noteFold), or the author of the stream's newest row (a merged loser's junk rows, a long-offline
 * device's late edit of a pruned doc). Every other device re-reads the checkpoint seqs of such streams in batches
 * (refreshRetiredBatch, one readBatch per tick) and drops the ones found retired; it puts one itself only after
 * RETIRE_GRACE_MS + jitter (retireGrace), which also covers duty lost to a restart. Outcomes follow the checkpoint
 * table (checkpoints.ts applyOutcome): conflict records the current seq and retries next tick, not-advancing
 * re-reads. A row committed after the retirement (a late writer) leaves the stream above its checkpoint again: the
 * next pass retires it again.
 *
 * Local cleanup: once the relay holds nothing beyond its checkpoint (remoteCheckpointCoversSeq >= remoteHeadSeq,
 * caught up), the dead stream's records leave the store, a tick's drops in one bounded transaction (Repo.tDropStreams),
 * and its replica is dropped. Never while the outbox holds an own frame of it, a read runs, or its replica is pinned / bound / has an
 * open frame.
 */

import { CheckpointEncoding } from "../../core/envelope";
import { FOLD_RULES_VERSION } from "../../core/limits";
import { encodeCheckpointContent } from "../../core/codec/contents";
import type { DeviceId, DocId, NsEntry, NsFoldEvent, NsPrunedStub, Seq, StreamName } from "../../core/types";
import type { RelaySession } from "../../ports/relay";
import { sealCheckpoint } from "../ingest/envelope";
import type { Mut } from "../store/repo";
import type { StreamRecord } from "../store/schema";
import { applyOutcome, type CheckpointDeps, type CheckpointOutcome, type CheckpointState } from "./checkpoints";

/** Retired-checkpoint puts per maintenance tick. */
export const RETIRES_PER_TICK = 4;
/**
 * Dead streams dropped from the store per maintenance tick, all in one transaction (Repo.tDropStreams), and the
 * tail rows those streams may hold together (the first stream always goes). I5: a tick's drop is one IDB
 * transaction of at most 128 stream records, snapshots and quarantine ranges plus 4,096 tail rows (or one stream's
 * tail, at most TAIL_HARD_ROWS), whatever the backlog: a flood's 2,400 dead streams leave in about 20 ticks, not 150.
 */
export const DROPS_PER_TICK = 128;
export const DROP_TAIL_ROWS_PER_TICK = 4_096;
/**
 * Non-duty retire grace: a dead stream another device should have retired is put by this device once it has been
 * seen dead for min(fallbackMs, RETIRE_GRACE_MS) plus a jitter as long (scaled from the checkpoint jitter). Short, not
 * the body checkpoint's 10 min: the duty device puts on its next tick, so a stream still not retired after a minute
 * has lost its duty (the duty device restarted, went to the background or offline), and a second device's put costs
 * nothing on the relay (a CAS conflict or a non-advancing put writes no row). Before that, batched refreshes
 * (refreshRetiredBatch, every grace / 4) find the duty device's retirements without a put.
 */
export const RETIRE_GRACE_MS = 60_000;

export function retireGrace(fallbackMs: number): number {
	return Math.min(fallbackMs, RETIRE_GRACE_MS);
}

/** A non-duty dead stream's checkpoint seq is re-read every grace / 4 (15 s), at most once a second. */
export function retireRefreshEvery(grace: number): number {
	return Math.max(grace / 4, 1_000);
}

export type DeadReason = "pruned" | "merged";

/**
 * Whether the committed ns fold has folded every ns row a body row up to some seq could depend on: the ns stream is
 * caught up and not frozen, the fold has no gap (FoldRuntime.gap: not halted, every tail row opened and folded),
 * and the vault cursor accounts for every seq through `vaultSeq` (so every ns row up to it is known).
 */
export interface FoldCompleteness {
	readonly complete: boolean;
	readonly vaultSeq: Seq;
}

/**
 * What this device knows of a pruned deleted entry (header): the committed state's stub, and the delete base its own
 * fold kept when it removed the entry (NsRuntime.removedDeletes until written, then StreamRecord.prunedDeleteBase).
 */
export interface PruneEvidence {
	readonly stub: NsPrunedStub | undefined;
	readonly keptBase: Seq | undefined;
}

/** Why the stream's doc is dead, or null (alive, or not provably dead). `entry`: the committed ns entry. */
export function deadReason(
	rec: Pick<StreamRecord, "cls" | "docId" | "remoteHeadSeq">, entry: NsEntry | undefined, pruned: PruneEvidence,
	fold: FoldCompleteness, pendingCreate: (docId: DocId) => boolean,
): DeadReason | null {
	if ((rec.cls !== "body" && rec.cls !== "canvas") || !rec.docId) return null;
	if (entry) return entry.state === "merged" ? "merged" : null;
	if (pruned.stub === undefined && pruned.keptBase === undefined) return null;
	if (!fold.complete || fold.vaultSeq < rec.remoteHeadSeq || pendingCreate(rec.docId)) return null;
	return "pruned";
}

/**
 * Retire bookkeeping of one engine run. In memory: an engine start refolds the uncompacted ns tail (noteFold finds
 * the duty again); duty compacted away is covered by the short grace (retireGrace).
 */
export class RetireState {
	/** Docs an own ns frame pruned or merged: this device has the retire duty (DESIGN §d.9). */
	readonly duty = new Set<DocId>();
	/** Monotonic time the stream was first seen dead with rows to retire (fallback clock). */
	readonly since = new Map<StreamName, number>();
	readonly backoffUntil = new Map<StreamName, number>();
	/** Monotonic time a batched refresh last read the stream's checkpoint seq (refreshRetiredBatch). */
	readonly refreshedAt = new Map<StreamName, number>();
	/** refreshed: refreshes (batched or a put's own) that found the stream retired; batches: readBatch requests. */
	stats = { written: 0, dropped: 0, refreshed: 0, conflicts: 0, batches: 0 };
	/** Dead streams still held locally as of the last maintenance tick (to retire or to drop; sim quiescence). */
	pending = 0;

	/** Own frames that pruned docs or folded a create as merged hand this device the retire duty for those docs. */
	noteFold(frames: readonly { readonly deviceId: DeviceId; readonly events: readonly NsFoldEvent[] }[], self: DeviceId): void {
		for (const f of frames) {
			if (f.deviceId !== self) continue;
			for (const e of f.events) {
				if (e.outcome.kind === "pruned") for (const d of e.outcome.docIds) this.duty.add(d);
				else if (e.outcome.kind === "merged" && e.docId) this.duty.add(e.docId);
			}
		}
	}

	forget(stream: StreamName, docId: DocId | null): void {
		this.since.delete(stream);
		this.backoffUntil.delete(stream);
		this.refreshedAt.delete(stream);
		if (docId) this.duty.delete(docId);
	}
}

export interface RetireOpts {
	/** Non-duty write: re-read the stream's checkpoint seq first (another device has usually retired it). */
	readonly refreshFirst?: boolean;
}

/**
 * Re-read the relay checkpoint seq and last seq of several dead streams in one readBatch (afterSeq = the record's
 * remoteHeadSeq: a retired stream has no row above it, so the page is small). Relay checkpoints are not broadcast:
 * without this every non-duty device learnt of a retirement only through its own put's refresh, a few per tick, and
 * a flood's thousands of dead streams outlasted the heal (sim SOAK-FLOOD-RETIRE-BACKLOG). A stream found covered at
 * its last seq is retired: the next drop takes it. Rows above the record (a late writer) make it stale: catch-up
 * reads them first. Returns the streams the batch served and how many of them are retired.
 */
export async function refreshRetiredBatch(deps: Pick<CheckpointDeps, "repo">, session: RelaySession, recs: readonly StreamRecord[]): Promise<{ readonly served: StreamName[]; readonly retired: number }> {
	const pages = await session.readBatch(recs.map((r) => ({ stream: r.stream, afterSeq: r.remoteHeadSeq, preferCheckpoint: false })));
	const served: StreamName[] = [];
	const patches: { stream: StreamName; patch: (r: Mut<StreamRecord>) => void }[] = [];
	let retired = 0;
	recs.forEach((rec, i) => {
		const page = pages[i];
		if (!page) return;
		served.push(rec.stream);
		const [last, cur] = [page.lastSeq, page.checkpointSeq];
		if (cur >= Math.max(last, rec.remoteHeadSeq)) retired++;
		if (last <= rec.remoteHeadSeq && cur <= rec.remoteCheckpointCoversSeq) return;
		patches.push({ stream: rec.stream, patch: (r) => {
			r.remoteHeadSeq = Math.max(r.remoteHeadSeq, last);
			r.remoteCheckpointCoversSeq = Math.max(r.remoteCheckpointCoversSeq, cur);
		} });
	});
	if (patches.length > 0) await deps.repo.tPatchStreams(patches);
	return { served, retired };
}

/**
 * Put a `retired` checkpoint at the stream's lastSeq (the caught-up record's remoteHeadSeq), CAS on the known
 * checkpoint seq. "not-advancing" with `refreshed` >= the stream's last seq: someone else retired it.
 */
export async function writeRetired(deps: CheckpointDeps, st: CheckpointState, session: RelaySession, stream: StreamName, opts: RetireOpts = {}): Promise<CheckpointOutcome> {
	let rec = deps.repo.stream(stream);
	if (!rec || rec.stale) return { t: "skipped", reason: "not-caught-up" };
	if (opts.refreshFirst) {
		const page = await session.read(stream, rec.appliedSeq, false);
		const [last, cur] = [page.lastSeq, page.checkpointSeq];
		await deps.repo.tPatchStreams([{ stream, patch: (r) => {
			r.remoteHeadSeq = Math.max(r.remoteHeadSeq, last);
			r.remoteCheckpointCoversSeq = Math.max(r.remoteCheckpointCoversSeq, cur);
		} }]);
		if (cur >= last) return { t: "not-advancing", refreshed: cur };
		rec = deps.repo.stream(stream);
		// Rows this device has not read yet: catch-up reads them first.
		if (!rec || rec.stale) return { t: "skipped", reason: "not-caught-up" };
	}
	const c = rec.remoteHeadSeq;
	if (c <= rec.remoteCheckpointCoversSeq) return { t: "skipped", reason: "not-advancing-local" };
	const content = encodeCheckpointContent({ encoding: CheckpointEncoding.retired, coversSeq: c, foldRulesVersion: FOLD_RULES_VERSION, state: new Uint8Array(0) });
	const sealed = await sealCheckpoint(deps.crypto, deps.vaultId, stream, c, content, deps.authorNsSeq());
	const res = await session.putCheckpoint(stream, c, rec.remoteCheckpointCoversSeq, sealed);
	return applyOutcome(deps, st, session, stream, c, 0, res, false);
}
