/**
 * Scenario: s11a-passive-stale-echo-witness (Requirement 13)
 *
 * Three explicit phases:
 *   Phase A — preBurstBaseline: both devices witness initial hash
 *   Phase B — activeBurst: negative-window checks (no stale regression, no recovery old hash, editor stable)
 *   Phase C — postBurstConvergence: Device A witnesses final hash locally first,
 *              then both devices eventually converge to that hash
 *
 * Expected final hash is derived from Device A's LOCAL witness (CRDT+disk+editor agree),
 * not from disk content alone. This prevents using a premature/incorrect hash.
 *
 * Clock discipline (Requirement 3): controller-side monotonic timer only.
 * Device identity (Requirement 2): deviceId (stable UUID), never deviceName.
 */

import type { DeviceHandle } from "../witness-primitives";
import {
	witnessQuorum,
	witnessQuorumEventually,
	noStaleHashAfterNewerWitness,
	noRecoveryEmittedOldHash,
	editorStableDuring,
} from "../witness-primitives";
import type { WitnessQuorumEventuallyResult } from "../witness-primitives";

export const SCENARIO_ID = "s11a-passive-stale-echo-witness";

export interface S11aConfig {
	deviceA: DeviceHandle;
	deviceB: DeviceHandle;
	path: string;
	initialContent: string;
	/** Burst window in ms. Default: 30000 for desktop. */
	burstWindowMs?: number;
	/** Quorum timeout in ms. Default: 30000. */
	quorumTimeoutMs?: number;
	/** Min stable after ms for quorum. Default: 1000 (desktop). */
	minStableAfterMs?: number;
	/**
	 * Perform burst typing on Device A.
	 * Must resolve the actual final hash that Device A witnessed locally
	 * (CRDT+disk+editor all agree). This is the cross-device convergence target.
	 */
	performBurst(deviceA: DeviceHandle, path: string): Promise<{
		/** The stateHash that Device A's tracker emitted as settled after the burst. */
		finalHashWitnessedByA: string;
	}>;
}

export interface S11aPhaseResult {
	ok: boolean;
	reason?: string;
	summary: string;
	evidence?: unknown[];
}

export interface S11aResult {
	/** Overall pass/fail */
	ok: boolean;
	/** Phase A: pre-burst baseline quorum */
	preBurst: S11aPhaseResult;
	/** Phase B: active burst negative-window checks */
	activeBurst: {
		noStaleOnB: S11aPhaseResult;
		noRecoveryOnB: S11aPhaseResult;
		editorStableOnA: S11aPhaseResult;
		ok: boolean;
	};
	/** Phase C: post-burst eventual convergence */
	postBurst: WitnessQuorumEventuallyResult & { finalHashWitnessedByA: string };
	summary: string;
}

/**
 * Run s11a-passive-stale-echo-witness with explicit three-phase structure.
 *
 * Phase B forbidden divergences on Device B: stale_hash_after_newer_witness, recovery_emitted_old_hash
 * Phase B forbidden divergences on Device A: editor_crdt_mismatch, editor_unhealthy
 * Phase C: Device A must locally witness final hash H before B is asked to converge to H
 */
export async function runS11a(config: S11aConfig): Promise<S11aResult> {
	const {
		deviceA,
		deviceB,
		path,
		initialContent,
		burstWindowMs = 30_000,
		quorumTimeoutMs = 30_000,
		minStableAfterMs = 1000,
	} = config;

	const skip: S11aPhaseResult = { ok: false, reason: "skipped", summary: "skipped" };

	// ── Phase A: Pre-burst baseline quorum ──────────────────────────────

	const initialHash = await deviceA.api.computeWitnessStateHash(initialContent);
	const preBurstRaw = await witnessQuorum([deviceA, deviceB], path, {
		pathId: path,
		stateKind: "present",
		expectedStateHash: initialHash,
		timeoutMs: quorumTimeoutMs,
		minStableAfterMs,
	});
	const preBurst: S11aPhaseResult = {
		ok: preBurstRaw.ok,
		reason: preBurstRaw.ok ? undefined : (preBurstRaw as { reason?: string }).reason,
		summary: preBurstRaw.summary,
		evidence: preBurstRaw.evidence,
	};

	if (!preBurst.ok) {
		return {
			ok: false,
			preBurst,
			activeBurst: { noStaleOnB: skip, noRecoveryOnB: skip, editorStableOnA: skip, ok: false },
			postBurst: { ok: false, reason: "skipped", evidence: [], intermediateHashes: {}, summary: "skipped", finalHashWitnessedByA: "" },
			summary: `Phase A failed: ${preBurst.reason}`,
		};
	}

	// ── Phase B: Active burst + negative-window checks ──────────────────
	// Anchor post-burst quorum to BEFORE the burst starts, so events emitted
	// during the burst (Device B converging mid-burst) are also considered.

	const preBurstSeqA = deviceA.api.currentWitnessSeq?.() ?? 0;
	const preBurstSeqB = deviceB.api.currentWitnessSeq?.() ?? 0;

	let finalHashWitnessedByA = "";

	const [noStaleRaw, noRecoveryRaw, editorStableRaw] = await Promise.all([
		noStaleHashAfterNewerWitness(deviceB, path, { windowMs: burstWindowMs }),
		noRecoveryEmittedOldHash(deviceB, path, { windowMs: burstWindowMs }),
		editorStableDuring(deviceA, path, burstWindowMs),
		// Perform burst concurrently; captures final hash witnessed by A
		config.performBurst(deviceA, path).then((r) => { finalHashWitnessedByA = r.finalHashWitnessedByA; }),
	]).then(([a, b, c]) => [a, b, c] as const);

	const activeBurst = {
		noStaleOnB: { ok: noStaleRaw.ok, reason: noStaleRaw.ok ? undefined : noStaleRaw.reason, summary: noStaleRaw.summary, evidence: noStaleRaw.evidence },
		noRecoveryOnB: { ok: noRecoveryRaw.ok, reason: noRecoveryRaw.ok ? undefined : noRecoveryRaw.reason, summary: noRecoveryRaw.summary, evidence: noRecoveryRaw.evidence },
		editorStableOnA: { ok: editorStableRaw.ok, reason: editorStableRaw.ok ? undefined : editorStableRaw.reason, summary: editorStableRaw.summary, evidence: editorStableRaw.evidence },
		ok: noStaleRaw.ok && noRecoveryRaw.ok && editorStableRaw.ok,
	};

	// ── Phase C: Post-burst eventual convergence ─────────────────────────
	// Use the hash that Device A's tracker actually witnessed (CRDT+disk+editor agree),
	// not disk content alone. If A never witnessed a final hash, fail with evidence.

	if (!finalHashWitnessedByA) {
		const postBurst: WitnessQuorumEventuallyResult & { finalHashWitnessedByA: string } = {
			ok: false,
			reason: "device_a_no_final_witness",
			evidence: [],
			intermediateHashes: {},
			summary: "Device A did not witness a final settled hash after the burst — cannot establish cross-device convergence target",
			finalHashWitnessedByA: "",
		};
		return {
			ok: false,
			preBurst,
			activeBurst,
			postBurst,
			summary: `Phase C failed: Device A produced no final witness hash`,
		};
	}

	const postBurstRaw = await witnessQuorumEventually([deviceA, deviceB], path, {
		pathId: path,
		stateKind: "present",
		expectedStateHash: finalHashWitnessedByA,
		timeoutMs: quorumTimeoutMs,
		minStableAfterMs,
		// Anchor to pre-burst seqs so events emitted during the burst are also considered.
		// Device B may converge mid-burst; we must not exclude those events.
		startSeqOverride: {
			[deviceA.deviceId]: preBurstSeqA,
			[deviceB.deviceId]: preBurstSeqB,
		},
	});
	const postBurst = { ...postBurstRaw, finalHashWitnessedByA };

	const ok = preBurst.ok && activeBurst.ok && postBurst.ok;

	return {
		ok,
		preBurst,
		activeBurst,
		postBurst,
		summary: ok
			? `s11a PASSED: pre-burst quorum ✓, no stale/recovery/editor divergences during burst ✓, post-burst convergence to ${finalHashWitnessedByA} ✓`
			: `s11a FAILED: ${[
				!preBurst.ok && `Phase A: ${preBurst.reason}`,
				!activeBurst.noStaleOnB.ok && `Phase B stale on B: ${activeBurst.noStaleOnB.reason}`,
				!activeBurst.noRecoveryOnB.ok && `Phase B recovery on B: ${activeBurst.noRecoveryOnB.reason}`,
				!activeBurst.editorStableOnA.ok && `Phase B editor on A: ${activeBurst.editorStableOnA.reason}`,
				!postBurst.ok && `Phase C: ${postBurst.reason} (intermediates: ${Object.values(postBurst.intermediateHashes).flat().length})`,
			].filter(Boolean).join("; ")}`,
	};
}
