/**
 * Analyzer rule: recovery-stale-precise (Requirement 18)
 *
 * Inform-level finding when the precision path emits recovery_emitted_old_hash.
 * Distinguishes precision-path detections from indirect-path detections.
 *
 * B10: precision-path detection requires joining to the actual recovery.decision
 * event (via causedByEvents.lastRecoverySeq) and verifying it carried recoveryStateHash.
 *
 * Does NOT flag conflict-artifact paths (Requirement 18.5).
 *
 * Pure function — no side effects, no Obsidian API.
 */

import type { FlightEvent } from "../flight-event";
import type { AnalyzerResult, Evidence } from "../../obsidian-harness/witness-primitives";

export interface RecoveryStaleSpec {
	deviceId?: string;
	pathId?: string;
	/** Set of pathIds that are known conflict artifacts — NOT flagged (Req 18.5). */
	conflictArtifactPathIds?: Set<string>;
}

/**
 * analyzeRecoveryEmittedOldHash — pure function.
 *
 * B10: precision-path detection joins to the recovery.decision event via
 * causedByEvents.lastRecoverySeq and verifies recoveryStateHash is present.
 */
export function analyzeRecoveryEmittedOldHash(
	events: FlightEvent[],
	spec: RecoveryStaleSpec,
): AnalyzerResult {
	const diverged = events.filter(
		(e) =>
			e.kind === "device.witness.diverged" &&
			(e.data as Record<string, unknown> | undefined)?.reason === "recovery_emitted_old_hash" &&
			(!spec.deviceId || e.deviceId === spec.deviceId) &&
			(!spec.pathId || e.pathId === spec.pathId),
	);

	if (diverged.length === 0) {
		return {
			ok: true,
			evidence: [],
			summary: "No recovery_emitted_old_hash divergences observed",
		};
	}

	// B10: build a map of recovery.decision events by (deviceId, seq) for joining
	const recoveryDecisions = new Map<string, FlightEvent>(); // key: `${deviceId}:${seq}`
	for (const e of events) {
		if (e.kind === "recovery.decision" && e.deviceId && typeof e.seq === "number") {
			recoveryDecisions.set(`${e.deviceId}:${e.seq}`, e);
		}
	}

	const findings: Evidence[] = [];

	for (const e of diverged) {
		// Skip conflict artifact paths (Requirement 18.5)
		if (spec.conflictArtifactPathIds?.has(e.pathId ?? "")) continue;

		const data = e.data as Record<string, unknown> | undefined ?? {};
		const causedByEvents = data.causedByEvents as Record<string, unknown> | undefined ?? {};
		const lastRecoverySeq = causedByEvents.lastRecoverySeq as number | undefined;
		const recoveryStateHashOnWitness = data.recoveryStateHash as string | undefined;

		// B10: determine if this is a precision-path detection by joining to recovery.decision
		let isPrecisionPath = false;
		let recoveryStateHash: string | undefined;
		let recoveryDecisionSeq: number | undefined;

		if (lastRecoverySeq !== undefined && e.deviceId) {
			// Join to the recovery.decision event on the same device
			const recoveryEvent = recoveryDecisions.get(`${e.deviceId}:${lastRecoverySeq}`);
			if (recoveryEvent) {
				const rData = recoveryEvent.data as Record<string, unknown> | undefined ?? {};
				recoveryStateHash = rData.recoveryStateHash as string | undefined;
				recoveryDecisionSeq = recoveryEvent.seq;
				// Precision path: recovery.decision carried recoveryStateHash
				isPrecisionPath = typeof recoveryStateHash === "string" && recoveryStateHash.startsWith("h:");
			}
		}

		// Also accept precision path flag from the witness event itself (set by tracker)
		if (!isPrecisionPath && Boolean(data.precisionPath) && recoveryStateHashOnWitness) {
			isPrecisionPath = true;
			recoveryStateHash = recoveryStateHashOnWitness;
		}

		findings.push({
			kind: isPrecisionPath ? "recovery_stale_precise" : "recovery_stale_indirect",
			deviceId: e.deviceId,
			pathId: e.pathId,
			seq: e.seq,
			data: {
				recoveryStateHash: recoveryStateHash ?? recoveryStateHashOnWitness,
				lastRecoverySeq,
				recoveryDecisionSeq,
				precisionPath: isPrecisionPath,
			},
			note: isPrecisionPath
				? `Precision-path detection: recovery.decision seq=${recoveryDecisionSeq} carried recoveryStateHash=${recoveryStateHash ?? "?"}`
				: "Indirect-path detection (post-stability-window; no recovery.decision join)",
			severity: "sync-correctness",
		});
	}

	if (findings.length === 0) {
		return {
			ok: true,
			evidence: [],
			summary: "All recovery_emitted_old_hash events were on conflict-artifact paths (expected)",
		};
	}

	return {
		ok: false,
		reason: "recovery_emitted_old_hash",
		evidence: findings,
		summary: `${findings.length} recovery_emitted_old_hash divergence(s) detected (${findings.filter((f) => f.kind === "recovery_stale_precise").length} precision-path)`,
	};
}

/**
 * analyzeStaleHashAfterNewerWitness — pure function.
 *
 * Hard finding when stale_hash_after_newer_witness divergence is observed.
 * Does NOT flag conflict-artifact paths.
 */
export function analyzeStaleHashAfterNewerWitness(
	events: FlightEvent[],
	spec: RecoveryStaleSpec,
): AnalyzerResult {
	const diverged = events.filter(
		(e) =>
			e.kind === "device.witness.diverged" &&
			(e.data as Record<string, unknown> | undefined)?.reason === "stale_hash_after_newer_witness" &&
			(!spec.deviceId || e.deviceId === spec.deviceId) &&
			(!spec.pathId || e.pathId === spec.pathId),
	);

	if (diverged.length === 0) {
		return {
			ok: true,
			evidence: [],
			summary: "No stale_hash_after_newer_witness divergences observed",
		};
	}

	const findings: Evidence[] = diverged
		.filter((e) => !spec.conflictArtifactPathIds?.has(e.pathId ?? ""))
		.map((e) => ({
			kind: "diverged",
			deviceId: e.deviceId,
			pathId: e.pathId,
			seq: e.seq,
			data: e.data as Record<string, unknown>,
			severity: "sync-correctness" as const,
		}));

	if (findings.length === 0) {
		return { ok: true, evidence: [], summary: "All stale_hash events were on conflict-artifact paths" };
	}

	return {
		ok: false,
		reason: "stale_hash_after_newer_witness",
		evidence: findings,
		summary: `${findings.length} stale_hash_after_newer_witness divergence(s) detected`,
	};
}
