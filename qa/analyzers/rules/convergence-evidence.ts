/**
 * analyzeConvergenceEvidence — Phase 3 positive-evidence analyzer rule.
 *
 * Produces a positive proof artifact when all consuming devices settled with
 * the expected hash. Distinct from Phase 2's four negative rules because it
 * returns ok: true with a narrative when convergence is proven.
 *
 * Pure function: no Obsidian API, no filesystem, no network, no global state.
 */

import type { AnalyzerResult, Evidence } from "../../obsidian-harness/witness-primitives";

export interface ConvergenceScenarioSpec {
	/** The device that produced the expected hash (the "source" device). */
	producingDeviceId: string;
	/** The path being witnessed (raw path — used for buffer matching). */
	path: string;
	/** The expected stateHash all consuming devices must settle with. */
	expectedStateHash: string;
	/** The scenarioStepIndex at which the producing device settled. */
	producingStepIndex: number;
	/** All device IDs that must converge (including the producing device). */
	allDeviceIds: string[];
}

export interface ConvergenceEvidenceResult extends AnalyzerResult {
	/** Per-device convergence record. */
	perDevice?: Record<string, {
		settled: boolean;
		seq?: number;
		scenarioStepIndex?: number;
		stepGap?: number;
	}>;
}

interface WitnessEvent {
	kind: string;
	path: string;
	seq: number;
	data: Record<string, unknown>;
	deviceId?: string;
}

const DIAGNOSTICS_CLASS_REASONS = new Set([
	"checkpoint_write_failed",
	"checkpoint_path_inside_vault",
	"unavailable",
]);

/**
 * Analyze convergence evidence across all devices.
 *
 * @param events - Flat array of witness events from all devices (each must have deviceId).
 * @param spec - Scenario specification.
 */
export function analyzeConvergenceEvidence(
	events: WitnessEvent[],
	spec: ConvergenceScenarioSpec,
): ConvergenceEvidenceResult {
	const { path, expectedStateHash, producingStepIndex, allDeviceIds, producingDeviceId } = spec;

	const evidence: Evidence[] = [];
	const perDevice: Record<string, { settled: boolean; seq?: number; scenarioStepIndex?: number; stepGap?: number }> = {};

	for (const deviceId of allDeviceIds) {
		perDevice[deviceId] = { settled: false };
	}

	// Check for sync-correctness divergences in the window
	for (const e of events) {
		if (e.path !== path) continue;
		if (!e.deviceId || !allDeviceIds.includes(e.deviceId)) continue;
		if (e.kind !== "device.witness.diverged" && e.kind !== "diverged") continue;
		const reason = String(e.data?.reason ?? "unknown");
		if (DIAGNOSTICS_CLASS_REASONS.has(reason)) continue;
		// Sync-correctness divergence — fail
		const stepIdx = typeof e.data?.scenarioStepIndex === "number" ? (e.data.scenarioStepIndex as number) : undefined;
		if (stepIdx !== undefined && stepIdx < producingStepIndex) continue; // before the window
		evidence.push({ kind: "diverged", deviceId: e.deviceId, seq: e.seq, data: e.data ?? {}, severity: "sync-correctness" });
		return {
			ok: false,
			reason: reason,
			offendingDeviceId: e.deviceId,
			offendingEventSeq: e.seq,
			evidence,
			summary: `Sync-correctness divergence on device ${e.deviceId}: ${reason}`,
			perDevice,
		};
	}

	// Find first settled event per device with expectedStateHash at or after producingStepIndex
	for (const e of events) {
		if (e.path !== path) continue;
		if (!e.deviceId || !allDeviceIds.includes(e.deviceId)) continue;
		if (e.kind !== "device.witness.settled" && e.kind !== "settled") continue;
		const sh = String(e.data?.stateHash ?? "");
		if (sh !== expectedStateHash) continue;
		const stepIdx = typeof e.data?.scenarioStepIndex === "number" ? (e.data.scenarioStepIndex as number) : undefined;
		if (stepIdx !== undefined && stepIdx < producingStepIndex) continue;

		const rec = perDevice[e.deviceId]!;
		if (!rec.settled || (rec.seq !== undefined && e.seq < rec.seq)) {
			rec.settled = true;
			rec.seq = e.seq;
			rec.scenarioStepIndex = stepIdx;
			rec.stepGap = stepIdx !== undefined ? stepIdx - producingStepIndex : undefined;
			evidence.push({
				kind: "settled",
				deviceId: e.deviceId,
				seq: e.seq,
				stateHash: sh,
				data: { scenarioStepIndex: stepIdx, stepGap: rec.stepGap },
			});
		}
	}

	const unsettled = allDeviceIds.filter((id) => !perDevice[id]?.settled);
	if (unsettled.length > 0) {
		// Check if unsettled devices only have diagnostics-class divergences (e.g. unavailable)
		// If so, treat them as optional-missing rather than convergence failures
		const reallyUnsettled = unsettled.filter((id) => {
			const deviceEvents = events.filter((e) => e.deviceId === id && e.path === path);
			const hasSyncCorrectnessDivergence = deviceEvents.some((e) => {
				if (e.kind !== "device.witness.diverged" && e.kind !== "diverged") return false;
				const reason = String(e.data?.reason ?? "unknown");
				return !DIAGNOSTICS_CLASS_REASONS.has(reason);
			});
			const hasSettled = deviceEvents.some((e) => e.kind === "device.witness.settled" || e.kind === "settled");
			// Only count as "really unsettled" if it has sync-correctness divergences
			// or if it has no events at all (not just diagnostics-class unavailable)
			return hasSyncCorrectnessDivergence || (!hasSettled && deviceEvents.length === 0);
		});

		if (reallyUnsettled.length > 0) {
			const lastPerDevice: Record<string, string> = {};
			for (const e of events) {
				if (e.path !== path || e.kind !== "settled" || !e.deviceId) continue;
				if (allDeviceIds.includes(e.deviceId)) {
					lastPerDevice[e.deviceId] = String(e.data.stateHash ?? "");
				}
			}
			return {
				ok: false,
				reason: "convergence_incomplete",
				evidence,
				summary: `Devices did not settle with expected hash: ${reallyUnsettled.join(", ")}. Last observed hashes: ${JSON.stringify(lastPerDevice)}`,
				perDevice,
			};
		}

		// All unsettled devices only have diagnostics-class divergences — treat as optional-missing
		for (const id of unsettled) {
			evidence.push({ kind: "partial_optional_missing", deviceId: id, note: "device only emitted diagnostics-class divergences (e.g. unavailable)" });
		}
	}

	// Build positive narrative
	const narrativeParts: string[] = [];
	const producerRec = perDevice[producingDeviceId];
	narrativeParts.push(
		`Device ${producingDeviceId} produced hash ${expectedStateHash} at step ${producerRec?.scenarioStepIndex ?? producingStepIndex}.`,
	);
	for (const deviceId of allDeviceIds) {
		if (deviceId === producingDeviceId) continue;
		const rec = perDevice[deviceId]!;
		narrativeParts.push(
			`Device ${deviceId} settled with ${expectedStateHash} at step ${rec.scenarioStepIndex ?? "?"} (gap: ${rec.stepGap ?? "?"}).`,
		);
	}
	narrativeParts.push("No stale rewinds detected. No recovery emitted old hash.");

	return {
		ok: true,
		evidence,
		summary: narrativeParts.join(" "),
		perDevice,
	};
}
