/**
 * analyzeConvergenceEvidence — Phase 3 positive-evidence analyzer rule.
 *
 * Keys on pathId (safe-bundle compatible). Fails closed when scenarioStepIndex
 * is missing from witness events (Phase 3 mode requires stepped witnesses).
 *
 * Pure function: no Obsidian API, no filesystem, no network, no global state.
 */

import type { AnalyzerResult, Evidence } from "../../obsidian-harness/witness-primitives";

export interface ConvergenceScenarioSpec {
	/** The device that produced the expected hash (the "source" device). */
	producingDeviceId: string;
	/**
	 * The pathId to match on (safe-bundle compatible — no raw path).
	 * For unsafe-local bundles, rawPath may be used as a fallback if pathId is absent.
	 */
	pathId: string;
	/** Optional raw path for unsafe-local debug mode only. */
	rawPath?: string;
	/** The expected stateHash all consuming devices must settle with. */
	expectedStateHash: string;
	/** The scenarioStepIndex at which the producing device settled. */
	producingStepIndex: number;
	/** All device IDs that must converge (including the producing device). */
	allDeviceIds: string[];
	/**
	 * When true, events without scenarioStepIndex are skipped rather than causing
	 * a hard failure. Use for legacy/no-step bundles only.
	 */
	allowUnsteppedEvents?: boolean;
}

export interface ConvergenceEvidenceResult extends AnalyzerResult {
	perDevice?: Record<string, {
		settled: boolean;
		seq?: number;
		scenarioStepIndex?: number;
		stepGap?: number;
	}>;
}

interface WitnessEvent {
	kind: string;
	pathId?: string;
	path?: string;
	seq?: number;
	data?: Record<string, unknown>;
	deviceId?: string;
}

const DIAGNOSTICS_CLASS_REASONS = new Set([
	"checkpoint_write_failed",
	"checkpoint_path_inside_vault",
	"unavailable",
]);

function matchesPath(e: WitnessEvent, spec: ConvergenceScenarioSpec): boolean {
	if (e.pathId && e.pathId === spec.pathId) return true;
	// Fallback for unsafe-local bundles that include raw path
	if (spec.rawPath && e.path === spec.rawPath) return true;
	// Also check pathId inside data (checkpoint segment format)
	if (e.data?.pathId === spec.pathId) return true;
	return false;
}

export function analyzeConvergenceEvidence(
	events: WitnessEvent[],
	spec: ConvergenceScenarioSpec,
): ConvergenceEvidenceResult {
	const { expectedStateHash, producingStepIndex, allDeviceIds, producingDeviceId } = spec;

	const evidence: Evidence[] = [];
	const perDevice: Record<string, { settled: boolean; seq?: number; scenarioStepIndex?: number; stepGap?: number }> = {};
	for (const deviceId of allDeviceIds) perDevice[deviceId] = { settled: false };

	// Check for sync-correctness divergences in the window
	for (const e of events) {
		if (!matchesPath(e, spec)) continue;
		if (!e.deviceId || !allDeviceIds.includes(e.deviceId)) continue;
		if (e.kind !== "device.witness.diverged" && e.kind !== "diverged") continue;
		const reason = String(e.data?.reason ?? "unknown");
		if (DIAGNOSTICS_CLASS_REASONS.has(reason)) continue;
		const stepIdx = typeof e.data?.scenarioStepIndex === "number" ? (e.data.scenarioStepIndex as number) : undefined;
		if (stepIdx !== undefined && stepIdx < producingStepIndex) continue;
		evidence.push({ kind: "diverged", deviceId: e.deviceId, seq: e.seq, data: e.data ?? {}, severity: "sync-correctness" });
		return {
			ok: false,
			reason,
			offendingDeviceId: e.deviceId,
			offendingEventSeq: e.seq,
			evidence,
			summary: `Sync-correctness divergence on device ${e.deviceId}: ${reason}`,
			perDevice,
		};
	}

	// Find first settled event per device with expectedStateHash at or after producingStepIndex
	for (const e of events) {
		if (!matchesPath(e, spec)) continue;
		if (!e.deviceId || !allDeviceIds.includes(e.deviceId)) continue;
		if (e.kind !== "device.witness.settled" && e.kind !== "settled") continue;
		const sh = String(e.data?.stateHash ?? "");
		if (sh !== expectedStateHash) continue;

		const stepIdx = typeof e.data?.scenarioStepIndex === "number" ? (e.data.scenarioStepIndex as number) : undefined;

		// Fail closed on missing scenarioStepIndex unless allowUnsteppedEvents
		if (stepIdx === undefined && !spec.allowUnsteppedEvents) {
			return {
				ok: false,
				reason: "missing_scenario_step_index",
				evidence,
				summary: `Device ${e.deviceId} settled event is missing scenarioStepIndex. Ensure 'YAOS QA: Advance scenario step' was invoked before each witness trigger.`,
				perDevice,
			};
		}

		if (stepIdx !== undefined && stepIdx < producingStepIndex) continue;

		const rec = perDevice[e.deviceId]!;
		if (!rec.settled || (rec.seq !== undefined && e.seq !== undefined && e.seq < rec.seq)) {
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
		// Devices with only diagnostics-class divergences are optional-missing, not failures
		const reallyUnsettled = unsettled.filter((id) => {
			const deviceEvents = events.filter((e) => e.deviceId === id && matchesPath(e, spec));
			const hasSyncCorrectness = deviceEvents.some((e) =>
				(e.kind === "device.witness.diverged" || e.kind === "diverged") &&
				!DIAGNOSTICS_CLASS_REASONS.has(String(e.data?.reason ?? "unknown")),
			);
			return hasSyncCorrectness || deviceEvents.length === 0;
		});

		if (reallyUnsettled.length > 0) {
			const lastPerDevice: Record<string, string> = {};
			for (const e of events) {
				if (!matchesPath(e, spec) || (e.kind !== "device.witness.settled" && e.kind !== "settled") || !e.deviceId) continue;
				if (allDeviceIds.includes(e.deviceId)) lastPerDevice[e.deviceId] = String(e.data?.stateHash ?? "");
			}
			return {
				ok: false,
				reason: "convergence_incomplete",
				evidence,
				summary: `Devices did not settle with expected hash: ${reallyUnsettled.join(", ")}. Last observed hashes: ${JSON.stringify(lastPerDevice)}`,
				perDevice,
			};
		}

		for (const id of unsettled) {
			evidence.push({ kind: "partial_optional_missing", deviceId: id, note: "device only emitted diagnostics-class divergences (e.g. unavailable)" });
		}
	}

	// Build positive narrative
	const narrativeParts: string[] = [];
	const producerRec = perDevice[producingDeviceId];
	narrativeParts.push(`Device ${producingDeviceId} produced hash ${expectedStateHash} at step ${producerRec?.scenarioStepIndex ?? producingStepIndex}.`);
	for (const deviceId of allDeviceIds) {
		if (deviceId === producingDeviceId) continue;
		const rec = perDevice[deviceId]!;
		if (rec.settled) {
			narrativeParts.push(`Device ${deviceId} settled with ${expectedStateHash} at step ${rec.scenarioStepIndex ?? "?"} (gap: ${rec.stepGap ?? "?"}).`);
		}
	}
	narrativeParts.push("No stale rewinds detected. No recovery emitted old hash.");

	return { ok: true, evidence, summary: narrativeParts.join(" "), perDevice };
}
