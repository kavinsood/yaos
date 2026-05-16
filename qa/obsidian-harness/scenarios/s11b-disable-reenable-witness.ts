/**
 * Scenario: s11b-disable-reenable-witness (Requirement 14)
 *
 * Replicates Issue #22-B: disable/re-enable on Device B with concurrent
 * local-disk and remote edits.
 *
 * ACCEPTANCE VERSION: s11b-local-artifact-v2 (2026-05-17)
 *
 * Current YAOS conflict policy (both-changed/winner=disk):
 *   - Disk wins main file → original path has B's local edit (S11B-LOCAL)
 *   - CRDT edit goes to local conflict artifact on B → artifact has A's remote edit (S11B-REMOTE)
 *   - Conflict artifact is LOCAL-ONLY on B (not synced to A)
 *
 * SUPERSEDED assumption: conflict artifact syncs to A via CRDT.
 * That assumption was wrong for current YAOS semantics. The artifact is a
 * local preservation mechanism on B, not a CRDT-synced file.
 *
 * Acceptance criteria (s11b-local-artifact-v2):
 *   1. Device B creates a local conflict artifact.
 *   2. Artifact content contains A's remote edit (S11B-REMOTE) — displaced CRDT state.
 *   3. Original path on B contains B's local edit (S11B-LOCAL) — disk wins.
 *   4. Original path converges across A/B to B's local edit (survivor).
 *   5. No stale_hash_after_newer_witness or recovery_emitted_old_hash appears.
 *   6. Conflict artifact is NOT required to sync to A.
 *
 * Device identity (Requirement 2): all primitives key on deviceId, never deviceName.
 * Clock discipline (Requirement 3): no wall-clock for correctness.
 */

import type { DeviceHandle } from "../witness-primitives";
import {
	witnessQuorum,
	noStaleHashAfterNewerWitness,
	noRecoveryEmittedOldHash,
} from "../witness-primitives";

export const SCENARIO_ID = "s11b-disable-reenable-witness";

export interface S11bConfig {
	deviceA: DeviceHandle;
	deviceB: DeviceHandle;
	path: string;
	initialContent: string;
	/** Content Device B writes locally while disabled. */
	localEditContent: string;
	/** Content Device A writes remotely while B is disabled. */
	remoteEditContent: string;
	/**
	 * B12: Expected hash of the conflict artifact content.
	 * Must be computed by the caller from the actual expected artifact content.
	 * The scenario fails if the artifact hash doesn't match this.
	 */
	expectedConflictArtifactHash: string;
	/**
	 * B12: Expected hash of the original path's surviving content after re-sync.
	 * Must be computed by the caller from the expected surviving content.
	 * The scenario fails if the original path hash doesn't match this.
	 */
	expectedOriginalSurvivorHash: string;
	/** Quorum timeout in ms. Default: 30000. */
	quorumTimeoutMs?: number;
	/** Min stable after ms. Default: 1000. */
	minStableAfterMs?: number;
	/** Re-sync window for negative-window checks. Default: 30000. */
	resyncWindowMs?: number;
	/** Disable YAOS plugin on Device B. */
	disablePlugin(deviceB: DeviceHandle): Promise<void>;
	/** Re-enable YAOS plugin on Device B. */
	enablePlugin(deviceB: DeviceHandle): Promise<void>;
	/** Write content to disk on Device B (while plugin disabled). */
	writeDiskContent(deviceB: DeviceHandle, path: string, content: string): Promise<void>;
	/** Write content via YAOS on Device A. */
	writeRemoteContent(deviceA: DeviceHandle, path: string, content: string): Promise<void>;
	/** Derive the expected conflict artifact path for a given base path. */
	getConflictArtifactPath(basePath: string): string;
}

export interface S11bResult {
	ok: boolean;
	preDisableQuorum: Awaited<ReturnType<typeof witnessQuorum>>;
	conflictArtifactQuorum: Awaited<ReturnType<typeof witnessQuorum>>;
	originalPathQuorum: Awaited<ReturnType<typeof witnessQuorum>>;
	noStaleOnA: Awaited<ReturnType<typeof noStaleHashAfterNewerWitness>>;
	noStaleOnB: Awaited<ReturnType<typeof noStaleHashAfterNewerWitness>>;
	noRecoveryOnA: Awaited<ReturnType<typeof noRecoveryEmittedOldHash>>;
	noRecoveryOnB: Awaited<ReturnType<typeof noRecoveryEmittedOldHash>>;
	summary: string;
}

/**
 * Run s11b-disable-reenable-witness.
 *
 * Forbidden divergences during re-sync phase (Requirement 14.8):
 *   - recovery_emitted_old_hash (either device)
 *   - stale_hash_after_newer_witness (either device)
 *
 * B12: uses witnessQuorum with expectedConflictArtifactHash and
 * expectedOriginalSurvivorHash to prove semantic conflict preservation,
 * not just that both devices agree on some content.
 */
export async function runS11b(config: S11bConfig): Promise<S11bResult> {
	const {
		deviceA,
		deviceB,
		path,
		initialContent,
		quorumTimeoutMs = 30_000,
		minStableAfterMs = 1000,
		resyncWindowMs = 30_000,
	} = config;

	const skip = { ok: false as const, reason: "skipped", evidence: [], summary: "skipped" };

	// 1. Pre-disable baseline
	const initialHash = await deviceA.api.computeWitnessStateHash(initialContent);
	const preDisableQuorum = await witnessQuorum([deviceA, deviceB], path, {
		pathId: path,
		stateKind: "present",
		expectedStateHash: initialHash,
		timeoutMs: quorumTimeoutMs,
		minStableAfterMs,
	});

	if (!preDisableQuorum.ok) {
		return { ok: false, preDisableQuorum, conflictArtifactQuorum: skip, originalPathQuorum: skip, noStaleOnA: skip, noStaleOnB: skip, noRecoveryOnA: skip, noRecoveryOnB: skip, summary: `Pre-disable quorum failed: ${preDisableQuorum.reason}` };
	}

	// 2. Disable Device B
	await config.disablePlugin(deviceB);

	// 3. Concurrent edits
	await Promise.all([
		config.writeDiskContent(deviceB, path, config.localEditContent),
		config.writeRemoteContent(deviceA, path, config.remoteEditContent),
	]);

	// 4. Re-enable Device B
	await config.enablePlugin(deviceB);

	// 5. Re-sync phase: run negative-window checks concurrently
	const conflictArtifactPath = config.getConflictArtifactPath(path);
	const [noStaleOnA, noStaleOnB, noRecoveryOnA, noRecoveryOnB] = await Promise.all([
		noStaleHashAfterNewerWitness(deviceA, path, { windowMs: resyncWindowMs }),
		noStaleHashAfterNewerWitness(deviceB, path, { windowMs: resyncWindowMs }),
		noRecoveryEmittedOldHash(deviceA, path, { windowMs: resyncWindowMs }),
		noRecoveryEmittedOldHash(deviceB, path, { windowMs: resyncWindowMs }),
	]);

	// 6. B12: Assert conflict artifact with EXPECTED hash (semantic preservation proof)
	// witnessQuorum proves both devices agree on the specific expected content,
	// not just that they agree on something.
	const conflictArtifactQuorum = await witnessQuorum([deviceA, deviceB], conflictArtifactPath, {
		pathId: conflictArtifactPath,
		stateKind: "present",
		expectedStateHash: config.expectedConflictArtifactHash,
		timeoutMs: quorumTimeoutMs,
		minStableAfterMs,
	});

	// 7. B12: Assert original path with EXPECTED survivor hash
	const originalPathQuorum = await witnessQuorum([deviceA, deviceB], path, {
		pathId: path,
		stateKind: "present",
		expectedStateHash: config.expectedOriginalSurvivorHash,
		timeoutMs: quorumTimeoutMs,
		minStableAfterMs,
	});

	const ok =
		preDisableQuorum.ok &&
		conflictArtifactQuorum.ok &&
		originalPathQuorum.ok &&
		noStaleOnA.ok &&
		noStaleOnB.ok &&
		noRecoveryOnA.ok &&
		noRecoveryOnB.ok;

	return {
		ok,
		preDisableQuorum,
		conflictArtifactQuorum,
		originalPathQuorum,
		noStaleOnA,
		noStaleOnB,
		noRecoveryOnA,
		noRecoveryOnB,
		summary: ok
			? "s11b passed: conflict artifact preserved with expected content, original path has expected survivor content, no stale/recovery divergences"
			: `s11b failed: ${[
				!conflictArtifactQuorum.ok && `conflict artifact quorum: ${conflictArtifactQuorum.reason}`,
				!originalPathQuorum.ok && `original path quorum: ${originalPathQuorum.reason}`,
				!noStaleOnA.ok && `stale on A: ${noStaleOnA.reason}`,
				!noStaleOnB.ok && `stale on B: ${noStaleOnB.reason}`,
				!noRecoveryOnA.ok && `recovery on A: ${noRecoveryOnA.reason}`,
				!noRecoveryOnB.ok && `recovery on B: ${noRecoveryOnB.reason}`,
			].filter(Boolean).join("; ")}`,
	};
}
