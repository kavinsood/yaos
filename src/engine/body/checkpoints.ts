/**
 * Remote checkpoints (DESIGN §d.9): duty, the CAS write and the outcome table.
 *
 * Body/canvas: compact first so snapshotCoversSeq = appliedSeq = C, seal the
 * snapshot as a yjsStateV1 checkpoint (checkpoint AAD), putCheckpoint(stream,
 * C, remoteCheckpointCoversSeq). ns / cfg: only candidate seqs (§b.5, same
 * rule for cfg) with the fold bytes the fold runtime kept for the newest
 * candidate. cfg uses the ns row / byte thresholds (decision: the cfg stream
 * is small; one tuning pair for both folds).
 */

import { CheckpointEncoding } from "../../core/envelope";
import { FOLD_RULES_VERSION, REMOTE_CHECKPOINT_BYTES, REMOTE_CHECKPOINT_IDLE_MS, REMOTE_CHECKPOINT_ROWS, NS_CHECKPOINT_BYTES, NS_CHECKPOINT_ROWS } from "../../core/limits";
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

export interface CheckpointTuning {
	readonly rows: number;
	readonly bytes: number;
	readonly idleMs: number;
	readonly fallbackMs: number;
	readonly nsRows: number;
	readonly nsBytes: number;
}

export const DEFAULT_CHECKPOINT_TUNING: CheckpointTuning = {
	rows: REMOTE_CHECKPOINT_ROWS, bytes: REMOTE_CHECKPOINT_BYTES, idleMs: REMOTE_CHECKPOINT_IDLE_MS, fallbackMs: CHECKPOINT_FALLBACK_MS,
	nsRows: NS_CHECKPOINT_ROWS, nsBytes: NS_CHECKPOINT_BYTES,
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
	/** too-large: no checkpoint until the snapshot shrinks below 75 % of this size. */
	readonly tooLarge = new Map<StreamName, number>();
	readonly backoffUntil = new Map<StreamName, number>();
	/** Monotonic time the checkpoint condition was first seen true (fallback duty). */
	readonly condSince = new Map<StreamName, number>();
	readonly jitter = new Map<StreamName, number>();
	/** Last activity (row or own edit) per stream, monotonic. */
	readonly lastActivity = new Map<StreamName, number>();
	written = 0;
	results: Record<string, number> = {};

	count(k: string): void {
		this.results[k] = (this.results[k] ?? 0) + 1;
	}
}

/** Duty test for a body/canvas stream (DESIGN §d.9). */
export function bodyCheckpointDue(rec: StreamRecord, hasDuty: boolean, st: CheckpointState, tuning: CheckpointTuning, nowMono: number, jitterMs: number): boolean {
	if (rec.stale || rec.frozen) return false;
	const cond = rec.rowsSinceRemoteCheckpoint >= tuning.rows || rec.bytesSinceRemoteCheckpoint >= tuning.bytes;
	if (!cond) {
		st.condSince.delete(rec.stream);
		return false;
	}
	if (nowMono < st.holdUntilMono) return false;
	if ((st.backoffUntil.get(rec.stream) ?? 0) > nowMono) return false;
	const idle = nowMono - (st.lastActivity.get(rec.stream) ?? -Infinity) >= tuning.idleMs;
	if (!idle) return false;
	if (!st.condSince.has(rec.stream)) st.condSince.set(rec.stream, nowMono);
	if (hasDuty) return true;
	return nowMono - st.condSince.get(rec.stream)! >= tuning.fallbackMs + jitterMs;
}

function resetCounters(r: Mut<StreamRecord>): void {
	r.rowsSinceRemoteCheckpoint = 0;
	r.bytesSinceRemoteCheckpoint = 0;
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
				resetCounters(r);
			} }], now);
			return { t: "ok", coversSeq: c };
		case "conflict": {
			const current = res.currentCoversSeq;
			await repo.tPatchStreams([{ stream, patch: (r) => {
				r.remoteCheckpointCoversSeq = current;
				if (current >= c) resetCounters(r);
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
						if (cur >= c) resetCounters(r);
					} }], now);
					return { t: "not-advancing", refreshed: cur };
				}
				case "ahead-of-stream":
				case "stream-not-found":
					deps.diag("checkpoint-refused", { reason: res.reason, coversSeq: c });
					st.backoffUntil.set(stream, deps.monotonic() + CHECKPOINT_SKIP_BACKOFF_MS);
					return { t: "refused", reason: res.reason };
				case "too-large":
					st.tooLarge.set(stream, snapshotBytes);
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
export async function writeBodyCheckpoint(deps: CheckpointDeps, st: CheckpointState, session: RelaySession, stream: StreamName): Promise<CheckpointOutcome> {
	let rec = deps.repo.stream(stream);
	if (!rec) return { t: "skipped", reason: "unknown" };
	if (rec.snapshotCoversSeq < rec.appliedSeq) {
		const c = await compactBody(deps, stream);
		if (c.t !== "ok") return { t: "skipped", reason: `compact-${c.reason}` };
		rec = deps.repo.stream(stream)!;
	}
	if (rec.stale || rec.snapshotCoversSeq !== rec.appliedSeq) return { t: "skipped", reason: "not-compacted" };
	const c = rec.snapshotCoversSeq;
	if (c <= rec.remoteCheckpointCoversSeq) return { t: "skipped", reason: "not-advancing-local" };
	const snap = await deps.repo.getSnapshot(stream);
	if (!snap || snap.coversSeq !== c || snap.encoding !== CheckpointEncoding.yjsStateV1) return { t: "skipped", reason: "snapshot" };
	const tl = st.tooLarge.get(stream);
	if (tl !== undefined) {
		if (snap.bytes.length > tl * 0.75) return { t: "skipped", reason: "too-large" };
		st.tooLarge.delete(stream);
	}
	const content = encodeCheckpointContent({ encoding: CheckpointEncoding.yjsStateV1, coversSeq: c, foldRulesVersion: FOLD_RULES_VERSION, state: snap.bytes });
	const sealed = await sealCheckpoint(deps.crypto, deps.vaultId, stream, c, content, deps.authorNsSeq());
	if (sealed.length > session.limits.maxCheckpointBytes) {
		st.tooLarge.set(stream, snap.bytes.length);
		st.count("too-large-local");
		return { t: "skipped", reason: "too-large-local" };
	}
	const res = await session.putCheckpoint(stream, c, rec.remoteCheckpointCoversSeq, sealed);
	return applyOutcome(deps, st, session, stream, c, snap.bytes.length, res);
}

/** ns / cfg duty: candidate exists above the remote checkpoint and enough rows/bytes accumulated. */
export function foldCheckpointDue(rec: StreamRecord | undefined, fold: FoldRuntime<unknown, unknown>, st: CheckpointState, tuning: CheckpointTuning, nowMono: number, jitterMs: number): boolean {
	const cand = fold.candidate;
	const stream = fold.stream;
	if (!rec || !cand || rec.stale || fold.halted) return false;
	if (cand.seq <= rec.remoteCheckpointCoversSeq) return false;
	if (nowMono < st.holdUntilMono) return false;
	if ((st.backoffUntil.get(stream) ?? 0) > nowMono) return false;
	const cond = rec.rowsSinceRemoteCheckpoint >= tuning.nsRows || rec.bytesSinceRemoteCheckpoint >= tuning.nsBytes;
	if (!cond) {
		st.condSince.delete(stream);
		return false;
	}
	if (!st.condSince.has(stream)) st.condSince.set(stream, nowMono);
	if (cand.authoredBySelf) return true;
	return nowMono - st.condSince.get(stream)! >= tuning.fallbackMs + jitterMs;
}

export async function writeFoldCheckpoint(deps: CheckpointDeps, st: CheckpointState, session: RelaySession, fold: FoldRuntime<unknown, unknown>): Promise<CheckpointOutcome> {
	const stream = fold.stream;
	const rec = deps.repo.stream(stream);
	const cand = fold.candidate;
	if (!rec || !cand) return { t: "skipped", reason: "no-candidate" };
	if (cand.seq <= rec.remoteCheckpointCoversSeq) return { t: "skipped", reason: "not-advancing-local" };
	const content = encodeCheckpointContent({ encoding: fold.encoding, coversSeq: cand.seq, foldRulesVersion: fold.rulesVersion, state: cand.bytes });
	const sealed = await sealCheckpoint(deps.crypto, deps.vaultId, stream, cand.seq, content, deps.authorNsSeq());
	if (sealed.length > session.limits.maxCheckpointBytes) {
		st.tooLarge.set(stream, cand.bytes.length);
		return { t: "skipped", reason: "too-large-local" };
	}
	const res = await session.putCheckpoint(stream, cand.seq, rec.remoteCheckpointCoversSeq, sealed);
	return applyOutcome(deps, st, session, stream, cand.seq, cand.bytes.length, res);
}
