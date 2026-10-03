import type { ObjectStorePort } from "./platformPorts";
import type { RecoveryAuthorityStore, RecoveryStateHead } from "./recoveryAuthorityStore";
import { contentObjectKey } from "./recoveryProtocol";
import { encodeRecoveryStateObject, MAX_RECOVERY_STATE_HISTORY_BYTES, RECOVERY_STATE_CONTENT_TYPE } from "./shared/recoveryStateObject";

/**
 * Vault-side recovery projection (b3 P2, snapshot format 4).
 *
 * The vault DO writes each changed body's stored CRDT bytes (checkpoint, journal
 * rows, relay-tail records) to R2 as one opaque, content-addressed state object
 * and records it in `recovery_content_index`. Nothing here decodes Yjs or reads
 * text: the client decodes on restore and verifies size and sha256.
 *
 * Progress is one watermark row (`recovery_state_projection`). A pass covers the
 * document ids changed in (watermark, target] from PK range seeks, resolves each
 * head, skips content already indexed, and puts the rest sequentially, bounded
 * for the Free plan (subrequests, memory, wall time). Idle passes read two rows
 * and write none.
 */
export const STATE_PROJECTION_LIMITS = {
	/** R2 puts per pass (sequential: one connection). */
	maxPuts: 64,
	/** History bytes put per pass. */
	maxBytes: 24 * 1024 * 1024,
	/**
	 * Largest single state object (32 MiB, above `maxBytes`): a body larger than
	 * what is left of a pass is deferred and then projected alone in a fresh pass
	 * (solo pass). Larger bodies are left to the capture fallback (`missing_history`).
	 * See MAX_RECOVERY_STATE_HISTORY_BYTES for the memory bound.
	 */
	maxObjectBytes: MAX_RECOVERY_STATE_HISTORY_BYTES,
	/** Head resolutions per pass. */
	maxIds: 256,
	/** Change-source rows read per pass. */
	maxRows: 2_000,
	/** Wall-clock budget per pass. */
	maxWallMs: 10_000,
	/** Ids carried between passes. */
	maxPending: 4_096,
};
export type StateProjectionLimits = typeof STATE_PROJECTION_LIMITS;

export interface StateProjectionPorts {
	store: RecoveryAuthorityStore;
	objectStore: ObjectStorePort;
	vaultId: string;
	vaultGeneration: string;
	now?: () => number;
}

export interface StateProjectionPassResult {
	idle: boolean;
	/** Work remains (budget or window truncated): owe another pass soon. */
	more: boolean;
	projected: number;
	skipped: number;
	deferred: number;
	pending: number;
	sourceRows: number;
	watermark: number;
}

type Outcome =
	| { kind: "projected"; bytes: number }
	| { kind: "present" }
	| { kind: "dropped" }
	| { kind: "deferred"; solo?: boolean };

interface Budget { puts: number; bytes: number; deadline: number }

function budgetFor(limits: StateProjectionLimits, now: number): Budget {
	return { puts: limits.maxPuts, bytes: limits.maxBytes, deadline: now + limits.maxWallMs };
}

function stateKey(ports: StateProjectionPorts, hash: string): string {
	return contentObjectKey(ports.vaultId, ports.vaultGeneration, hash);
}

/**
 * Build and put the state object for `head` at `boundary`, then index it.
 * The recipe is read synchronously right after the head, so head and bytes agree.
 */
async function putState(
	ports: StateProjectionPorts,
	documentId: string,
	head: RecoveryStateHead,
	boundary: number,
	maximumBytes: number,
	record: (key: string) => void,
): Promise<{ kind: "projected"; bytes: number } | { kind: "too_large" } | { kind: "busy" } | { kind: "missing" }> {
	const built = ports.store.recoveryStateUpdates(documentId, boundary, maximumBytes);
	if (built === "too_large") return { kind: "too_large" };
	if (built.updates.length === 0 && head.size > 0) return { kind: "missing" };
	const key = stateKey(ports, head.contentHash);
	const object = encodeRecoveryStateObject({ kind: head.kind, contentHash: head.contentHash, size: head.size, updates: built.updates,
		...(head.revision ? { identity: "revision" as const } : {}) });
	const bytes = built.bytes;
	// Release the history before the put: only the encoded object stays live (memory bound).
	built.updates.length = 0;
	if (!ports.store.beginStateObjectWrite(key)) return { kind: "busy" };
	try {
		await ports.objectStore.put(key, object, {
			contentType: RECOVERY_STATE_CONTENT_TYPE,
			customMetadata: { contentSha256: head.contentHash, contentSize: String(head.size) },
		});
		record(key);
	} finally {
		ports.store.endStateObjectWrite(key);
	}
	return { kind: "projected", bytes };
}

async function projectDocument(ports: StateProjectionPorts, documentId: string, budget: Budget, limits: StateProjectionLimits): Promise<Outcome> {
	const now = ports.now ?? Date.now;
	if (now() >= budget.deadline) return { kind: "deferred" };
	const boundary = ports.store.currentSequence();
	const head = ports.store.recoveryStateHead(documentId, boundary);
	// b3-a1fix: a head without a known plaintext hash resolves to its revision
	// identity (never "pending"), so it is projected like any other head.
	if (head === null) return { kind: "dropped" };
	if (ports.store.missingIndexedContent([head.contentHash], ports.store.sweepingGcEpoch()).length === 0) return { kind: "present" };
	if (budget.puts <= 0 || budget.bytes <= 0) return { kind: "deferred" };
	// A fresh pass (nothing put yet) may spend up to the per-object bound on one
	// body, which then uses up the pass: the solo pass for an oversized note.
	const fresh = budget.puts === limits.maxPuts && budget.bytes === limits.maxBytes;
	const allowance = fresh ? limits.maxObjectBytes : Math.min(limits.maxObjectBytes, budget.bytes);
	const result = await putState(ports, documentId, head, boundary, allowance,
		(key) => ports.store.recordProjectedContent(head.contentHash, key, head.size, ports.store.sweepingGcEpoch()));
	if (result.kind === "projected") {
		budget.puts--;
		budget.bytes -= result.bytes;
		return result;
	}
	if (result.kind === "busy") return { kind: "deferred" };
	// Too large for what is left of this pass: retry first in a fresh pass (solo),
	// unless it exceeds the per-object bound (then the capture fallback records a defect).
	if (result.kind === "too_large" && allowance < limits.maxObjectBytes) return { kind: "deferred", solo: true };
	console.warn("[yaos-recovery-state] body not projected", { reason: result.kind });
	return { kind: "dropped" };
}

/**
 * One bounded watermark pass. Throws on an R2 or storage failure without saving
 * progress (the next pass redoes the window; content already indexed is a 1-read
 * skip). Never arms an alarm itself: the caller owes the next wake when `more`.
 */
export async function runStateProjectionPass(
	ports: StateProjectionPorts,
	limits: StateProjectionLimits = STATE_PROJECTION_LIMITS,
): Promise<StateProjectionPassResult> {
	const now = ports.now ?? Date.now;
	const state = ports.store.recoveryStateProjection();
	let target = state.target;
	if (target === null) {
		const current = ports.store.currentSequence();
		if (current <= state.watermark && state.pending.length === 0) {
			return { idle: true, more: false, projected: 0, skipped: 0, deferred: 0, pending: 0, sourceRows: 0, watermark: state.watermark };
		}
		target = Math.max(current, state.watermark);
	}
	const work = new Set(state.pending);
	const collected = ports.store.recoveryStateChanges(
		state.watermark, target, state.cursor, Math.max(0, limits.maxIds - work.size), limits.maxRows,
	);
	for (const id of collected.ids) work.add(id);
	const budget = budgetFor(limits, now());
	const deferred: string[] = [];
	const solo: string[] = [];
	let projected = 0;
	let skipped = 0;
	for (const id of work) {
		const outcome = await projectDocument(ports, id, budget, limits);
		if (outcome.kind === "projected") projected++;
		else if (outcome.kind === "present" || outcome.kind === "dropped") skipped++;
		else if (outcome.solo) solo.push(id);
		else deferred.push(id);
	}
	// Oversized bodies go first so the next pass starts fresh for them (solo pass).
	let carried = [...solo, ...deferred];
	if (carried.length > limits.maxPending) {
		console.warn("[yaos-recovery-state] pending projection ids truncated", { carried: carried.length });
		carried = carried.slice(0, limits.maxPending);
	}
	const next = collected.cursor === null
		? { watermark: target, target: null, cursor: null, pending: carried }
		: { watermark: state.watermark, target, cursor: collected.cursor, pending: carried };
	const unchanged = next.watermark === state.watermark && next.target === state.target
		&& JSON.stringify(next.cursor) === JSON.stringify(state.cursor)
		&& JSON.stringify(next.pending) === JSON.stringify(state.pending);
	if (!unchanged) ports.store.saveRecoveryStateProjection(next, now());
	return {
		idle: false,
		more: deferred.length > 0 || solo.length > 0 || collected.cursor !== null,
		projected,
		skipped,
		deferred: deferred.length + solo.length,
		pending: 0,
		sourceRows: collected.rowsRead,
		watermark: next.watermark,
	};
}

/**
 * Inline best-effort projection for b3-bulk. Call after the bulk-create
 * transaction has committed, under `waitUntil` so the response is not held.
 * Never throws and never moves the watermark (the next watermark pass rechecks
 * these ids; an indexed hash costs it one read and no put). Bounded to
 * `maxPuts` ids and `maxBytes`; the rest is left to the alarm.
 */
export async function projectStateDocuments(
	ports: StateProjectionPorts,
	documentIds: readonly string[],
	limits: StateProjectionLimits = STATE_PROJECTION_LIMITS,
): Promise<{ projected: number; skipped: number }> {
	const budget = budgetFor(limits, (ports.now ?? Date.now)());
	let projected = 0;
	let skipped = 0;
	for (const id of documentIds.slice(0, limits.maxPuts)) {
		try {
			const outcome = await projectDocument(ports, id, budget, limits);
			if (outcome.kind === "projected") projected++;
			else skipped++;
		} catch (error) {
			console.warn("[yaos-recovery-state] inline projection failed", error);
			return { projected, skipped: skipped + 1 };
		}
	}
	skipped += Math.max(0, documentIds.length - limits.maxPuts);
	return { projected, skipped };
}

export type CaptureStateResult =
	| { status: "materialized"; objectKey: string; contentHash: string; plainBytes: number }
	| { status: "busy" }
	| { status: "defect"; code: "missing_history" | "corrupt_history"; message: string };

/**
 * Capture fallback (content not yet projected at the capture boundary): build the
 * state object from the recipe at the boundary, put it, and record it in the
 * content index and the capture's membership. Runs in the vault DO.
 */
export async function materializeCaptureState(
	ports: StateProjectionPorts,
	input: { captureId: string; documentId: string; generation: number },
	limits: StateProjectionLimits = STATE_PROJECTION_LIMITS,
): Promise<CaptureStateResult> {
	const head = ports.store.captureStateHead(input.captureId, input.documentId, input.generation);
	if (!head) return { status: "defect", code: "missing_history", message: "body generation is outside capture plan" };
	const key = stateKey(ports, head.contentHash);
	const record = () => ports.store.recordCaptureStateMaterialized({
		captureId: input.captureId, documentId: input.documentId, generation: input.generation,
		contentHash: head.contentHash, objectKey: key, plainBytes: head.size, gcEpoch: head.gcEpoch,
	});
	if (ports.store.missingIndexedContent([head.contentHash], head.gcEpoch).length === 0) {
		record();
		return { status: "materialized", objectKey: key, contentHash: head.contentHash, plainBytes: head.size };
	}
	let result: Awaited<ReturnType<typeof putState>>;
	try {
		result = await putState(ports, input.documentId, head, head.boundarySequence, limits.maxObjectBytes, record);
	} catch (error) {
		if (error instanceof Error && /recipe|checkpoint/i.test(error.message)) {
			return { status: "defect", code: "corrupt_history", message: error.message };
		}
		throw error;
	}
	if (result.kind === "busy") return { status: "busy" };
	if (result.kind === "too_large") return { status: "defect", code: "missing_history", message: "body history exceeds the recovery state bound" };
	if (result.kind === "missing") return { status: "defect", code: "missing_history", message: "body history is missing" };
	return { status: "materialized", objectKey: key, contentHash: head.contentHash, plainBytes: head.size };
}
