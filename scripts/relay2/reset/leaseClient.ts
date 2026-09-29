/**
 * Relay v2 spike (§5.5): client flow for lease-based semantic reset.
 *
 *   policy (phase 1) → POST compaction-lease → [currency gate] → build fresh
 *   doc (builder.ts) → policy (phase 2) → POST semantic-reset
 *     ├─ installed → switch to the new epoch
 *     └─ CAS loss  → rebase onto the server's new epoch (or retry/abort)
 *
 * Rebase semantics are the EXISTING client's, reused verbatim:
 * `src/sync/semanticEpochTransition.ts` `prepareSemanticEpochTransition`
 * (the function `vaultSync.ts` `rebaseBodyAcrossSemanticEpoch` calls on 4409 /
 * stale-epoch catch-up). It installs a brand-new Y.Doc from the new epoch's
 * exact server state and re-applies ONLY the user's textual intent: a
 * three-way merge of (durableBaseline → current local text) onto the new
 * epoch's content, emitted as a new-epoch Yjs update. Old-lineage Yjs updates
 * never cross the fence.
 *
 * Why no edit can be lost (the invariant the server CAS must provide):
 *   An edit acknowledged on epoch E is either contained in the snapshot that
 *   installs E+1, or the reset CAS fails. The server guarantees this by
 *   requiring `coveredSequence == body head latest_sequence` (exact, not ≤) and
 *   `expectedEpoch == current epoch` inside the same transaction that installs
 *   the snapshot. Therefore every device's durableBaseline (text at its last
 *   settle, all ≤ head) is contained in the new epoch, and its unacknowledged
 *   delta (current text − durableBaseline) is exactly what the three-way merge
 *   re-applies. An old-epoch append arriving after install is rejected (4409),
 *   stays unacknowledged, and is carried by the same delta.
 *
 * The lease holder must be *current* when it snapshots: no pending local
 * updates and applied sequence == the head sequence returned by the lease.
 * (Otherwise the snapshot would contain content the covered sequence doesn't,
 * and the holder's own later rebase would see its edit on both sides.)
 */
import * as Y from "yjs";
import {
	prepareSemanticEpochTransition,
	type ReadySemanticEpochTransition,
	type SemanticEpochTransitionInput,
	type SemanticEpochTransitionResult,
} from "../../../src/sync/semanticEpochTransition";
import { canonicalizeMarkdown } from "@shared/markdownCodec";
import { buildFreshSnapshot, BODY_TEXT_ROOT, type FreshSnapshot } from "./builder";
import { confirmAfterBuild, evaluateClientTrigger, type SemanticCompactionState } from "./policy";

// ---------------------------------------------------------------------------
// Wire shapes (see docs/relay2-protocol.md once server-core publishes it).
// ---------------------------------------------------------------------------

export interface LeaseRequest {
	/** Epoch the device is on; lease is refused for any other epoch. */
	expectedEpoch: number;
	ttlMs?: number;
}

export type LeaseResponse =
	| {
		granted: true;
		leaseId: string;
		expiresAt: number;
		epoch: number;
		/** Body head latest_sequence at grant time: what the snapshot must cover. */
		headSequence: number;
		/** Optional merged-state SV at headSequence (lets the holder verify currency exactly). */
		stateVector?: Uint8Array;
		/** Shared cooldown/hysteresis state (all devices must see the same one). */
		policy?: SemanticCompactionState;
	}
	| {
		granted: false;
		reason: "held" | "epoch_mismatch" | "cooldown" | "not_found" | string;
		epoch: number;
		headSequence: number;
		holderDeviceId?: string;
		expiresAt?: number;
	};

export interface SemanticResetRequest {
	leaseId: string;
	expectedEpoch: number;
	coveredSequence: number;
	/** canonicalMarkdownHash of the snapshot's body text. */
	contentHash: string;
	contentBytes: number;
	snapshot: Uint8Array;
}

export type SemanticResetResponse =
	| { ok: true; epoch: number; previousEpoch: number; sequence: number; fencedSockets?: number }
	| {
		ok: false;
		reason: "epoch_mismatch" | "head_advanced" | "lease_invalid" | "lease_expired" | "hash_mismatch" | string;
		epoch: number;
		headSequence: number;
	};

export interface BodyStateResponse {
	epoch: number;
	headSequence: number;
	encodedState: Uint8Array;
}

export interface ResetTransport {
	requestLease(bodyId: string, request: LeaseRequest): Promise<LeaseResponse>;
	semanticReset(bodyId: string, request: SemanticResetRequest): Promise<SemanticResetResponse>;
	/** Exact current server state (GET /vault/:id/body/:bodyId). */
	fetchBody(bodyId: string): Promise<BodyStateResponse>;
	releaseLease?(bodyId: string, leaseId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// What the flow needs from the client's loaded body (models bodyManager's LoadedBody).
// ---------------------------------------------------------------------------

export interface ResetBodyHandle {
	readonly bodyId: string;
	epoch(): number;
	doc(): Y.Doc;
	/** Canonical body text at the device's last fully-settled point (bodyManager durableBaseline). */
	durableBaseline(): string;
	/** Highest server sequence whose effect this doc is known to contain. */
	appliedSequence(): number;
	/** Local updates not yet acknowledged by the server. */
	hasPendingLocal(): boolean;
	/** Swap in the fresh-epoch doc (bodyManager.installSemanticEpochTransition) and submit rebasedUpdate if any. */
	installEpoch(transition: ReadySemanticEpochTransition, headSequence: number): Promise<void>;
	/** Wait until acks/catch-up land (bounded); resolves true if current w.r.t. `sequence`. */
	awaitCurrent?(sequence: number, timeoutMs: number): Promise<boolean>;
	/** Preserve un-mergeable local intent (production: onSemanticEpochRebaseConflict writes a conflict copy). */
	preserveConflict?(result: Exclude<SemanticEpochTransitionResult, ReadySemanticEpochTransition>): Promise<void>;
}

export type RebaseOutcome =
	| { status: "rebased"; epoch: number; outcome: ReadySemanticEpochTransition["outcome"]; rebasedUpdateBytes: number }
	| { status: "already-current"; epoch: number }
	| {
		/** Local intent could not be merged; it was handed to `preserveConflict` (production: conflict copy). */
		status: "conflict" | "too-large";
		epoch: number;
		result: Exclude<SemanticEpochTransitionResult, ReadySemanticEpochTransition>;
		/** True when the authoritative epoch was installed after preserving the intent; false = failed closed on the old epoch. */
		installed: boolean;
	};

export type CompactionOutcome =
	| { status: "not-due"; reasons: string[] }
	| { status: "lease-denied"; reason: string; holderDeviceId?: string }
	| { status: "not-current"; appliedSequence: number; headSequence: number }
	| { status: "aborted-after-build"; reasons: string[]; fresh: FreshSnapshotSummary }
	| { status: "installed"; epoch: number; sequence: number; fresh: FreshSnapshotSummary; timings: CompactionTimings }
	| { status: "lost"; reason: string; rebase: RebaseOutcome | null; fresh: FreshSnapshotSummary | null; timings: Partial<CompactionTimings> };

export interface FreshSnapshotSummary {
	uploadBytes: number;
	contentBytes: number;
	contentHash: string;
	structsBefore: number;
	structsAfter: number;
	encodedBefore: number;
	buildMs: number;
}

export interface CompactionTimings {
	leaseMs: number;
	buildMs: number;
	uploadMs: number;
	installMs: number;
	totalMs: number;
}

export interface CompactionOptions {
	policyState?: SemanticCompactionState;
	now?: () => number;
	ttlMs?: number;
	/** Skip phase-1 policy (tests / forced runs). Phase 2 still applies unless `force`. */
	force?: boolean;
	/** Bounded wait for the holder to become current (acks / tail catch-up). */
	currencyWaitMs?: number;
	/** head_advanced retries within one lease (catch up, rebuild, re-upload). */
	maxHeadRetries?: number;
	/** Hook between build and upload (tests use it to inject races). */
	beforeUpload?: (fresh: FreshSnapshot) => Promise<void> | void;
}

function summarize(fresh: FreshSnapshot): FreshSnapshotSummary {
	return {
		uploadBytes: fresh.snapshot.byteLength,
		contentBytes: fresh.contentBytes,
		contentHash: fresh.contentHash,
		structsBefore: fresh.before.totalStructs,
		structsAfter: fresh.after.totalStructs,
		encodedBefore: fresh.before.encodedStateBytes,
		buildMs: fresh.timings.totalMs,
	};
}

/**
 * Wrapper over the real client rebase. One spike-found gap is handled here:
 * `mergeThreeWayText` returns `too-large` whenever ANY input exceeds 2M chars
 * (checked before its identical/one-sided shortcuts), so a >2 MB note could
 * never cross an epoch even with zero local intent. When the device has no
 * local intent (pending == durableBaseline) the three-way result is by
 * definition "authoritative wins" (outcome body-only/identical, no rebased
 * update), so we construct exactly that without diffing. Everything else goes
 * through `prepareSemanticEpochTransition` unchanged.
 */
export function prepareTransition(input: SemanticEpochTransitionInput): SemanticEpochTransitionResult & { fastPath?: boolean } {
	const baseline = canonicalizeMarkdown(input.previousBaseline);
	const pending = canonicalizeMarkdown(input.pendingMarkdown);
	if (baseline !== pending) return prepareSemanticEpochTransition(input);
	if (input.nextBodyEpoch <= input.previousBodyEpoch) throw new Error("semantic body epoch must advance monotonically");
	const document = new Y.Doc({ guid: input.bodyId });
	try {
		if (input.authoritativeEncodedState.byteLength > 0) Y.applyUpdate(document, input.authoritativeEncodedState, "semantic-epoch-baseline");
		const raw = document.getText(BODY_TEXT_ROOT).toJSON();
		const authoritativeContent = canonicalizeMarkdown(raw);
		if (raw !== authoritativeContent) throw new Error("semantic epoch baseline is not canonical Markdown");
		return {
			kind: "ready", bodyId: input.bodyId, bodyEpoch: input.nextBodyEpoch, document,
			authoritativeContent, rebasedContent: authoritativeContent, rebasedUpdate: null,
			outcome: authoritativeContent === pending ? "identical" : "body-only", edits: [], fastPath: true,
		};
	} catch (error) {
		document.destroy();
		throw error;
	}
}

function transitionFrom(handle: ResetBodyHandle, nextEpoch: number, authoritativeEncodedState: Uint8Array): SemanticEpochTransitionResult {
	return prepareTransition({
		bodyId: handle.bodyId,
		previousBodyEpoch: handle.epoch(),
		nextBodyEpoch: nextEpoch,
		previousBaseline: handle.durableBaseline(),
		pendingMarkdown: handle.doc().getText(BODY_TEXT_ROOT).toJSON(),
		authoritativeEncodedState,
	});
}

async function installTransition(
	handle: ResetBodyHandle,
	transition: SemanticEpochTransitionResult,
	headSequence: number,
	authoritativeEncodedState: Uint8Array,
): Promise<RebaseOutcome> {
	if (transition.kind !== "ready") {
		// Mirror vaultSync.rebaseBodyAcrossSemanticEpoch: preserve the user's intent
		// outside the retired lineage (onSemanticEpochRebaseConflict → conflict
		// copy), then install the authoritative epoch with no local intent. Without
		// a preservation hook, fail closed and keep the old local document.
		if (!handle.preserveConflict) return { status: transition.kind, epoch: transition.nextBodyEpoch, result: transition, installed: false };
		await handle.preserveConflict(transition);
		const clean = prepareTransition({
			bodyId: handle.bodyId, previousBodyEpoch: handle.epoch(), nextBodyEpoch: transition.nextBodyEpoch,
			previousBaseline: transition.authoritativeContent, pendingMarkdown: transition.authoritativeContent,
			authoritativeEncodedState,
		});
		if (clean.kind !== "ready") throw new Error("authoritative semantic epoch transition did not converge");
		await handle.installEpoch(clean, headSequence);
		return { status: transition.kind, epoch: transition.nextBodyEpoch, result: transition, installed: true };
	}
	await handle.installEpoch(transition, headSequence);
	return {
		status: "rebased", epoch: transition.bodyEpoch, outcome: transition.outcome,
		rebasedUpdateBytes: transition.rebasedUpdate?.byteLength ?? 0,
	};
}

/**
 * Loser / fenced / offline-device path: fetch the new epoch's exact state and
 * rebase local intent onto it (what vaultSync does on 4409 or a stale-epoch head).
 */
export async function rebaseOntoCurrent(handle: ResetBodyHandle, transport: ResetTransport): Promise<RebaseOutcome> {
	const state = await transport.fetchBody(handle.bodyId);
	if (state.epoch === handle.epoch()) return { status: "already-current", epoch: state.epoch };
	if (state.epoch < handle.epoch()) throw new Error(`server epoch ${state.epoch} is behind device epoch ${handle.epoch()}`);
	return installTransition(handle, transitionFrom(handle, state.epoch, state.encodedState), state.headSequence, state.encodedState);
}

function isCurrent(handle: ResetBodyHandle, headSequence: number): boolean {
	return !handle.hasPendingLocal() && handle.appliedSequence() === headSequence;
}

/** Full lease → build → reset flow for one loaded body. */
export async function runCompaction(
	handle: ResetBodyHandle,
	transport: ResetTransport,
	options: CompactionOptions = {},
): Promise<CompactionOutcome> {
	const now = options.now ?? Date.now;
	let policyState: SemanticCompactionState = options.policyState ?? { lastCompactedAt: null, postCompactionEncodedStateBytes: null };
	const started = performance.now();
	if (!options.force) {
		const verdict = evaluateClientTrigger(handle.doc(), policyState, now());
		if (!verdict.requestLease) return { status: "not-due", reasons: verdict.decision.reasons };
	}
	const epoch = handle.epoch();
	const leaseStarted = performance.now();
	const lease = await transport.requestLease(handle.bodyId, { expectedEpoch: epoch, ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}) });
	const leaseMs = performance.now() - leaseStarted;
	if (!lease.granted) {
		return { status: "lease-denied", reason: lease.reason, ...(lease.holderDeviceId ? { holderDeviceId: lease.holderDeviceId } : {}) };
	}
	if (lease.policy) policyState = lease.policy;
	const release = async () => { try { await transport.releaseLease?.(handle.bodyId, lease.leaseId); } catch { /* lease expires anyway */ } };

	let headSequence = lease.headSequence;
	let fresh: FreshSnapshot | null = null;
	let buildMs = 0;
	for (let attempt = 0; attempt <= (options.maxHeadRetries ?? 2); attempt++) {
		if (!isCurrent(handle, headSequence)) {
			const ok = await handle.awaitCurrent?.(headSequence, options.currencyWaitMs ?? 2_000) ?? false;
			if (!ok || !isCurrent(handle, headSequence)) {
				await release();
				return { status: "not-current", appliedSequence: handle.appliedSequence(), headSequence };
			}
		}
		// Snapshot + covered sequence captured in the same synchronous turn.
		const coveredSequence = handle.appliedSequence();
		const buildStarted = performance.now();
		fresh = await buildFreshSnapshot(handle.doc());
		buildMs += performance.now() - buildStarted;
		if (!options.force) {
			const decision = confirmAfterBuild(fresh, policyState, now());
			if (!decision.semanticResetRecommended) {
				await release();
				return { status: "aborted-after-build", reasons: decision.reasons, fresh: summarize(fresh) };
			}
		}
		await options.beforeUpload?.(fresh);
		const uploadStarted = performance.now();
		const result = await transport.semanticReset(handle.bodyId, {
			leaseId: lease.leaseId,
			expectedEpoch: epoch,
			coveredSequence,
			contentHash: fresh.contentHash,
			contentBytes: fresh.contentBytes,
			snapshot: fresh.snapshot,
		});
		const uploadMs = performance.now() - uploadStarted;
		if (result.ok) {
			const installStarted = performance.now();
			// The new epoch's state IS our snapshot (byte-identical), so no download:
			// rebase any edits made since the snapshot onto it; socket sync brings
			// anything other devices appended to the new epoch meanwhile.
			const transition = transitionFrom(handle, result.epoch, fresh.snapshot);
			const rebase = await installTransition(handle, transition, result.sequence, fresh.snapshot);
			if (rebase.status !== "rebased") throw new Error(`holder could not rebase onto its own snapshot: ${rebase.status}`);
			const installMs = performance.now() - installStarted;
			return {
				status: "installed", epoch: result.epoch, sequence: result.sequence, fresh: summarize(fresh),
				timings: { leaseMs, buildMs, uploadMs, installMs, totalMs: performance.now() - started },
			};
		}
		if (result.reason === "head_advanced" && result.epoch === epoch) {
			// Someone appended to the old epoch after our lease. Catch up and rebuild.
			headSequence = result.headSequence;
			continue;
		}
		if (result.reason === "epoch_mismatch" || result.epoch !== epoch) {
			// Another device's reset won. Rebase exactly like a fenced device.
			const rebase = await rebaseOntoCurrent(handle, transport);
			return { status: "lost", reason: result.reason, rebase, fresh: summarize(fresh), timings: { leaseMs, buildMs, uploadMs } };
		}
		await release();
		return { status: "lost", reason: result.reason, rebase: null, fresh: summarize(fresh), timings: { leaseMs, buildMs, uploadMs } };
	}
	await release();
	return { status: "lost", reason: "head_advanced_retries_exhausted", rebase: null, fresh: fresh ? summarize(fresh) : null, timings: { leaseMs, buildMs } };
}
