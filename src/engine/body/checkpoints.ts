/**
 * Remote checkpoints (DESIGN §d.9): duty, the CAS write and the outcome table.
 *
 * Body/canvas: compact first so snapshotCoversSeq = appliedSeq = C, seal the
 * snapshot as a yjsStateV1 checkpoint (checkpoint AAD), putCheckpoint(stream,
 * C, remoteCheckpointCoversSeq). ns / cfg: only candidate seqs (§b.5, same
 * rule for cfg) with the fold bytes the fold runtime kept for the newest
 * candidate. cfg uses the ns row / byte thresholds (decision: the cfg stream
 * is small; one tuning pair for both folds).
 *
 * Two triggers. Hot: rows / bytes behind the remote checkpoint reach the
 * threshold, then a short idle. Settle: anything a fresh device would open
 * beyond one envelope (settleWanted), then a long idle, so a quiescent vault
 * has no tail. The duty device writes; any other device falls back after
 * fallbackMs + jitter and first re-reads the remote checkpoint seq (refreshFirst),
 * since the duty device has usually written it already.
 */

import { CheckpointEncoding } from "../../core/envelope";
import {
	FOLD_RULES_VERSION, NS_CHECKPOINT_BYTES, NS_CHECKPOINT_ROWS, REMOTE_CHECKPOINT_BYTES, REMOTE_CHECKPOINT_IDLE_MS, REMOTE_CHECKPOINT_ROWS,
	REMOTE_CHECKPOINT_SETTLE_DAILY, REMOTE_CHECKPOINT_SETTLE_MS,
} from "../../core/limits";
import { streamClass, type Seq, type StreamName, type VaultId } from "../../core/types";
import type { CryptoPort } from "../../ports/crypto";
import type { PutCheckpointResult, RelaySession } from "../../ports/relay";
import { sealCheckpoint } from "../ingest/envelope";
import type { Mut, Repo } from "../store/repo";
import type { StreamRecord } from "../store/schema";
import type { FoldRuntime } from "../sync/foldRuntime";
import { encodeCheckpointContent } from "../../core/codec/contents";
import { compactBody, type CompactDeps } from "./compaction";

export const CHECKPOINT_FALLBACK_MS = 10 * 60_000;
/** Backoff after "ahead-of-stream" / "stream-not-found" (both should not happen; avoid a tight loop). */
export const CHECKPOINT_SKIP_BACKOFF_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface CheckpointTuning {
	/** Hot rule (body/canvas): rows or bytes behind the remote checkpoint, then idleMs idle. */
	readonly rows: number;
	readonly bytes: number;
	readonly idleMs: number;
	/** Settle rule (every class): any excess open (settleWanted), then max(idleMs, settleMs) idle. */
	readonly settleMs: number;
	/** Non-duty devices wait this long (plus a per-stream jitter in [0, fallbackMs)) once the condition holds. */
	readonly fallbackMs: number;
	/** Hot rule for ns / cfg / snap (no idle gate). */
	readonly nsRows: number;
	readonly nsBytes: number;
}

export const DEFAULT_CHECKPOINT_TUNING: CheckpointTuning = {
	rows: REMOTE_CHECKPOINT_ROWS, bytes: REMOTE_CHECKPOINT_BYTES, idleMs: REMOTE_CHECKPOINT_IDLE_MS, settleMs: REMOTE_CHECKPOINT_SETTLE_MS,
	fallbackMs: CHECKPOINT_FALLBACK_MS, nsRows: NS_CHECKPOINT_ROWS, nsBytes: NS_CHECKPOINT_BYTES,
};

export type CheckpointOutcome =
	| { readonly t: "ok"; readonly coversSeq: Seq }
	| { readonly t: "conflict"; readonly current: Seq; readonly retry: boolean }
	| { readonly t: "not-advancing"; readonly refreshed: Seq }
	| { readonly t: "skipped"; readonly reason: string }
	| { readonly t: "refused"; readonly reason: Extract<PutCheckpointResult, { t: "refused" }>["reason"] };

export interface CheckpointDeps extends CompactDeps {
	readonly vaultId: VaultId;
	readonly crypto: CryptoPort;
	monotonic(): number;
	authorNsSeq(): Seq;
	diag(code: string, fields: Record<string, string | number | boolean | null>): void;
	onForbidden(): void;
}

/** Holds and per-stream state of the outcome table. */
export class CheckpointState {
	/** daily-limit: no checkpoint until this monotonic time. */
	holdUntilMono = 0;
	/**
	 * too-large: no checkpoint until the snapshot shrinks below 75 % of `bytes`. Not due again while the stream
	 * still ends at `seq` (no new row, so no smaller snapshot).
	 */
	readonly tooLarge = new Map<StreamName, { readonly bytes: number; readonly seq: Seq }>();
	readonly backoffUntil = new Map<StreamName, number>();
	/** Monotonic time the checkpoint condition (idle included) was first seen true (fallback duty). */
	readonly condSince = new Map<StreamName, number>();
	readonly jitter = new Map<StreamName, number>();
	/** Last activity (row or own edit) per stream, monotonic. */
	readonly lastActivity = new Map<StreamName, number>();
	/** When this engine run first went live (markLive): a stream with no activity seen counts as active then. */
	private liveSince = -Infinity;
	written = 0;
	results: Record<string, number> = {};
	private windowStart = -Infinity;
	private windowBase = 0;

	count(k: string): void {
		this.results[k] = (this.results[k] ?? 0) + 1;
	}

	/**
	 * The first live maintenance tick of this engine run. Activity before it is unknown (a restart may come in the
	 * middle of an edit session), so the idle windows of streams with no activity seen start here.
	 */
	markLive(nowMono: number): void {
		if (this.liveSince === -Infinity) this.liveSince = nowMono;
	}

	/** Last activity on `stream`, or the start of this live run if none was seen. */
	activityAt(stream: StreamName): number {
		return this.lastActivity.get(stream) ?? this.liveSince;
	}

	/** Settle duty is open while this device wrote fewer than REMOTE_CHECKPOINT_SETTLE_DAILY puts in the current 24 h. */
	settleOpen(nowMono: number): boolean {
		if (nowMono - this.windowStart >= DAY_MS) {
			this.windowStart = nowMono;
			this.windowBase = this.written;
		}
		return this.written - this.windowBase < REMOTE_CHECKPOINT_SETTLE_DAILY;
	}
}

/**
 * Settle condition (DESIGN §d.9): a fresh device would open more than one envelope for this stream, i.e. a row
 * lies behind the remote checkpoint, or there is no checkpoint and at least two rows. A stream whose only row is
 * its first frame stays as it is (a checkpoint would replace one open with one open). Only rows this device has
 * applied count, so a stream it has not caught up on (stale) is never due.
 */
export function settleWanted(rec: StreamRecord): boolean {
	return rec.appliedSeq > rec.remoteCheckpointCoversSeq && rec.rowsSinceRemoteCheckpoint + (rec.remoteCheckpointCoversSeq > 0 ? 1 : 0) >= 2;
}

/** Idle for `needMs` (no row, no own frame on the stream); resets the fallback clock while the stream is busy. */
function idleFor(st: CheckpointState, stream: StreamName, nowMono: number, needMs: number): boolean {
	if (nowMono - st.activityAt(stream) >= needMs) return true;
	st.condSince.delete(stream);
	return false;
}

/** The duty device now; any other after fallbackMs + jitter of the condition holding. */
function dutyOrFallback(st: CheckpointState, stream: StreamName, hasDuty: boolean, tuning: CheckpointTuning, nowMono: number, jitterMs: number): boolean {
	if (!st.condSince.has(stream)) st.condSince.set(stream, nowMono);
	if (hasDuty) return true;
	return nowMono - st.condSince.get(stream)! >= tuning.fallbackMs + jitterMs;
}

/** Duty test for a body/canvas stream (DESIGN §d.9): hot after idleMs, settle after settleMs. */
export function bodyCheckpointDue(rec: StreamRecord, hasDuty: boolean, st: CheckpointState, tuning: CheckpointTuning, nowMono: number, jitterMs: number): boolean {
	if (rec.stale || rec.frozen || st.tooLarge.get(rec.stream)?.seq === rec.appliedSeq) return false;
	const hot = rec.rowsSinceRemoteCheckpoint >= tuning.rows || rec.bytesSinceRemoteCheckpoint >= tuning.bytes;
	if (!hot && (!settleWanted(rec) || !st.settleOpen(nowMono))) {
		st.condSince.delete(rec.stream);
		return false;
	}
	if (nowMono < st.holdUntilMono) return false;
	if ((st.backoffUntil.get(rec.stream) ?? 0) > nowMono) return false;
	if (!idleFor(st, rec.stream, nowMono, hot ? tuning.idleMs : Math.max(tuning.idleMs, tuning.settleMs))) return false;
	return dutyOrFallback(st, rec.stream, hasDuty, tuning, nowMono, jitterMs);
}

/**
 * The remote checkpoint now covers `c`: no row behind it, or at least one when rows were applied above `c` meanwhile
 * (a live row during the put; for ns / cfg the rows after the candidate), which keeps such a stream settle-due.
 */
function coveredTo(r: Mut<StreamRecord>, c: Seq): void {
	r.rowsSinceRemoteCheckpoint = r.appliedSeq > c ? 1 : 0;
	r.bytesSinceRemoteCheckpoint = 0;
}

/**
 * Fallback devices re-read the stream's checkpoint seq before compacting and uploading (relay checkpoints are not
 * broadcast): when it already covers `want` someone else did the job, and the counters are reset. One read with
 * after = appliedSeq (no rows, no checkpoint payload unless the relay has collected rows above it).
 */
async function refreshRemote(deps: CheckpointDeps, st: CheckpointState, session: RelaySession, rec: StreamRecord, want: Seq): Promise<CheckpointOutcome | null> {
	const page = await session.read(rec.stream, rec.appliedSeq, false);
	const cur = page.checkpointSeq;
	if (cur <= rec.remoteCheckpointCoversSeq) return null;
	await deps.repo.tPatchStreams([{ stream: rec.stream, patch: (r) => {
		r.remoteCheckpointCoversSeq = Math.max(r.remoteCheckpointCoversSeq, cur);
		if (cur >= want) coveredTo(r, cur);
	} }], deps.nowMs());
	if (cur < want) return null;
	st.condSince.delete(rec.stream);
	st.count("refreshed");
	return { t: "not-advancing", refreshed: cur };
}

/** Nothing above the remote checkpoint here: counters that still say otherwise are stale (a refresh without reset). */
async function clearCounters(deps: CheckpointDeps, rec: StreamRecord): Promise<void> {
	if (rec.rowsSinceRemoteCheckpoint === 0 && rec.bytesSinceRemoteCheckpoint === 0) return;
	await deps.repo.tPatchStreams([{ stream: rec.stream, patch: (r) => {
		if (r.appliedSeq <= r.remoteCheckpointCoversSeq) coveredTo(r, r.remoteCheckpointCoversSeq);
	} }], deps.nowMs());
}

export interface WriteCheckpointOpts {
	/** Fallback (non-duty) write: re-read the remote checkpoint seq first (refreshRemote). */
	readonly refreshFirst?: boolean;
}

/** Apply the outcome table to the stream record / holds. */
async function applyOutcome(
	deps: CheckpointDeps, st: CheckpointState, session: RelaySession, stream: StreamName, c: Seq, snapshotBytes: number, res: PutCheckpointResult,
): Promise<CheckpointOutcome> {
	const repo = deps.repo;
	const now = deps.nowMs();
	st.count(res.t === "refused" ? res.reason : res.t);
	switch (res.t) {
		case "ok":
			st.written++;
			st.condSince.delete(stream);
			await repo.tPatchStreams([{ stream, patch: (r) => {
				r.remoteCheckpointCoversSeq = Math.max(r.remoteCheckpointCoversSeq, c);
				coveredTo(r, c);
			} }], now);
			return { t: "ok", coversSeq: c };
		case "conflict": {
			const current = res.currentCoversSeq;
			await repo.tPatchStreams([{ stream, patch: (r) => {
				r.remoteCheckpointCoversSeq = current;
				if (current >= c) coveredTo(r, current);
			} }], now);
			deps.diag("checkpoint-conflict", { cls: streamClass(stream), current, coversSeq: c });
			return { t: "conflict", current, retry: current < c };
		}
		case "refused":
			switch (res.reason) {
				case "not-advancing": {
					const page = await session.read(stream, c, false);
					const cur = page.checkpointSeq;
					await repo.tPatchStreams([{ stream, patch: (r) => {
						r.remoteCheckpointCoversSeq = Math.max(r.remoteCheckpointCoversSeq, cur);
						if (cur >= c) coveredTo(r, cur);
					} }], now);
					return { t: "not-advancing", refreshed: cur };
				}
				case "ahead-of-stream":
				case "stream-not-found":
					deps.diag("checkpoint-refused", { reason: res.reason, coversSeq: c });
					st.backoffUntil.set(stream, deps.monotonic() + CHECKPOINT_SKIP_BACKOFF_MS);
					return { t: "refused", reason: res.reason };
				case "too-large":
					st.tooLarge.set(stream, { bytes: snapshotBytes, seq: c });
					return { t: "refused", reason: res.reason };
				case "daily-limit":
					st.holdUntilMono = deps.monotonic() + Math.max(1_000, res.retryAfterMs ?? 60 * 60_000);
					return { t: "refused", reason: res.reason };
				case "forbidden":
					deps.onForbidden();
					return { t: "refused", reason: res.reason };
			}
	}
}

/** Write a body/canvas checkpoint (compact first). */
export async function writeBodyCheckpoint(deps: CheckpointDeps, st: CheckpointState, session: RelaySession, stream: StreamName, opts: WriteCheckpointOpts = {}): Promise<CheckpointOutcome> {
	let rec = deps.repo.stream(stream);
	if (!rec) return { t: "skipped", reason: "unknown" };
	if (opts.refreshFirst && !rec.stale && rec.appliedSeq > rec.remoteCheckpointCoversSeq) {
		const done = await refreshRemote(deps, st, session, rec, rec.appliedSeq);
		if (done) return done;
		rec = deps.repo.stream(stream)!;
	}
	if (rec.snapshotCoversSeq < rec.appliedSeq) {
		const c = await compactBody(deps, stream);
		if (c.t !== "ok") return { t: "skipped", reason: `compact-${c.reason}` };
		rec = deps.repo.stream(stream)!;
	}
	if (rec.stale || rec.snapshotCoversSeq !== rec.appliedSeq) return { t: "skipped", reason: "not-compacted" };
	const c = rec.snapshotCoversSeq;
	if (c <= rec.remoteCheckpointCoversSeq) {
		await clearCounters(deps, rec);
		return { t: "skipped", reason: "not-advancing-local" };
	}
	const snap = await deps.repo.getSnapshot(stream);
	if (!snap || snap.coversSeq !== c || snap.encoding !== CheckpointEncoding.yjsStateV1) return { t: "skipped", reason: "snapshot" };
	const tl = st.tooLarge.get(stream);
	if (tl !== undefined) {
		if (snap.bytes.length > tl.bytes * 0.75) {
			st.tooLarge.set(stream, { bytes: tl.bytes, seq: c });
			return { t: "skipped", reason: "too-large" };
		}
		st.tooLarge.delete(stream);
	}
	const content = encodeCheckpointContent({ encoding: CheckpointEncoding.yjsStateV1, coversSeq: c, foldRulesVersion: FOLD_RULES_VERSION, state: snap.bytes });
	const sealed = await sealCheckpoint(deps.crypto, deps.vaultId, stream, c, content, deps.authorNsSeq());
	if (sealed.length > session.limits.maxCheckpointBytes) {
		st.tooLarge.set(stream, { bytes: snap.bytes.length, seq: c });
		st.count("too-large-local");
		return { t: "skipped", reason: "too-large-local" };
	}
	const res = await session.putCheckpoint(stream, c, rec.remoteCheckpointCoversSeq, sealed);
	return applyOutcome(deps, st, session, stream, c, snap.bytes.length, res);
}

/**
 * ns / cfg / snap duty: a candidate exists above the remote checkpoint, and either enough rows / bytes accumulated
 * (hot, no idle gate) or the stream wants settling and has been idle for max(idleMs, settleMs). Duty: the
 * candidate's author.
 */
export function foldCheckpointDue(rec: StreamRecord | undefined, fold: FoldRuntime<unknown, unknown>, st: CheckpointState, tuning: CheckpointTuning, nowMono: number, jitterMs: number): boolean {
	const cand = fold.candidate;
	const stream = fold.stream;
	if (!rec || !cand || rec.stale || fold.halted) return false;
	if (cand.seq <= rec.remoteCheckpointCoversSeq || st.tooLarge.get(stream)?.seq === cand.seq) return false;
	if (nowMono < st.holdUntilMono) return false;
	if ((st.backoffUntil.get(stream) ?? 0) > nowMono) return false;
	const hot = rec.rowsSinceRemoteCheckpoint >= tuning.nsRows || rec.bytesSinceRemoteCheckpoint >= tuning.nsBytes;
	if (!hot) {
		if (!settleWanted(rec) || !st.settleOpen(nowMono)) {
			st.condSince.delete(stream);
			return false;
		}
		if (!idleFor(st, stream, nowMono, Math.max(tuning.idleMs, tuning.settleMs))) return false;
	}
	return dutyOrFallback(st, stream, cand.authoredBySelf, tuning, nowMono, jitterMs);
}

export async function writeFoldCheckpoint(deps: CheckpointDeps, st: CheckpointState, session: RelaySession, fold: FoldRuntime<unknown, unknown>, opts: WriteCheckpointOpts = {}): Promise<CheckpointOutcome> {
	const stream = fold.stream;
	let rec = deps.repo.stream(stream);
	const cand = fold.candidate;
	if (!rec || !cand) return { t: "skipped", reason: "no-candidate" };
	if (opts.refreshFirst && !rec.stale && cand.seq > rec.remoteCheckpointCoversSeq) {
		const done = await refreshRemote(deps, st, session, rec, cand.seq);
		if (done) return done;
		rec = deps.repo.stream(stream)!;
	}
	if (cand.seq <= rec.remoteCheckpointCoversSeq) return { t: "skipped", reason: "not-advancing-local" };
	const content = encodeCheckpointContent({ encoding: fold.encoding, coversSeq: cand.seq, foldRulesVersion: fold.rulesVersion, state: cand.bytes });
	const sealed = await sealCheckpoint(deps.crypto, deps.vaultId, stream, cand.seq, content, deps.authorNsSeq());
	if (sealed.length > session.limits.maxCheckpointBytes) {
		st.tooLarge.set(stream, { bytes: cand.bytes.length, seq: cand.seq });
		return { t: "skipped", reason: "too-large-local" };
	}
	const res = await session.putCheckpoint(stream, cand.seq, rec.remoteCheckpointCoversSeq, sealed);
	return applyOutcome(deps, st, session, stream, cand.seq, cand.bytes.length, res);
}
