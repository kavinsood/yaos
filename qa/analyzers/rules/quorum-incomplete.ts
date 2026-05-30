/**
 * Analyzer rule: quorum-incomplete (Requirement 15)
 *
 * Hard finding when a scenario's required-device set did not all emit
 * device.witness.settled for a declared pathId by the scenario deadline.
 *
 * B8: deadlineStepIndex is enforced — only events with stepIndex <= deadlineStepIndex
 * are considered. If events lack stepIndex, the rule fails closed with
 * reason="missing_scenario_step_index".
 *
 * Pure function of (events, scenarioSpec) — no side effects, no Obsidian API.
 */

import type { FlightEvent } from "../flight-event";
import type { AnalyzerResult, Evidence } from "../../obsidian-harness/witness-primitives";

export interface QuorumSpec {
	pathId: string;
	requiredDeviceIds: string[];
	/**
	 * Scenario step index at which the deadline was reached (NOT a wall-clock value).
	 * Only settled events with stepIndex <= deadlineStepIndex are accepted.
	 * If events lack stepIndex, the rule fails closed.
	 */
	deadlineStepIndex: number;
}

/**
 * analyzeWitnessQuorum — pure function.
 *
 * Input: all device.witness.settled events from the trace, keyed by deviceId.
 * Deadline is a scenario step index (never wall-clock).
 */
export function analyzeWitnessQuorum(
	events: FlightEvent[],
	spec: QuorumSpec,
): AnalyzerResult {
	const settled = events.filter(
		(e) => e.kind === "device.witness.settled" && e.pathId === spec.pathId,
	);

	// B8: check if any settled events have stepIndex or scenarioStepIndex; if none do, fail closed
	const hasStepIndex = settled.some(
		(e) => {
			const d = e.data as Record<string, unknown> | undefined;
			return typeof d?.stepIndex === "number" || typeof d?.scenarioStepIndex === "number";
		},
	);

	// If there are settled events but none have stepIndex, we cannot enforce the deadline
	if (settled.length > 0 && !hasStepIndex) {
		return {
			ok: false,
			reason: "missing_scenario_step_index",
			evidence: settled.slice(0, 3).map((e) => ({ kind: "settled", deviceId: e.deviceId, pathId: spec.pathId, seq: e.seq })),
			summary: `Cannot enforce deadlineStepIndex=${spec.deadlineStepIndex}: settled events lack stepIndex field. Add stepIndex to event data or use a different deadline mechanism.`,
		};
	}

	// B8: only accept settled events at or before the deadline
	// Accept both legacy stepIndex and Phase 3 scenarioStepIndex
	const settledByDeadline = settled.filter((e) => {
		const d = e.data as Record<string, unknown> | undefined;
		const si = typeof d?.scenarioStepIndex === "number" ? d.scenarioStepIndex : d?.stepIndex;
		// If stepIndex is absent on this specific event but others have it, skip this event
		if (typeof si !== "number") return false;
		return si <= spec.deadlineStepIndex;
	});

	const settledByDevice = new Map<string, FlightEvent>();
	for (const e of settledByDeadline) {
		if (e.deviceId && !settledByDevice.has(e.deviceId)) {
			settledByDevice.set(e.deviceId, e);
		}
	}

	const missing = spec.requiredDeviceIds.filter((id) => !settledByDevice.has(id));

	if (missing.length === 0) {
		const evidence: Evidence[] = spec.requiredDeviceIds.map((id) => {
			const e = settledByDevice.get(id)!;
			return {
				kind: "settled",
				deviceId: id,
				pathId: spec.pathId,
				seq: e.seq,
				stateHash: String((e.data as Record<string, unknown> | undefined)?.stateHash ?? ""),
			};
		});
		return {
			ok: true,
			evidence,
			summary: `All ${spec.requiredDeviceIds.length} required devices settled for pathId=${spec.pathId} by step ${spec.deadlineStepIndex}`,
		};
	}

	const evidence: Evidence[] = missing.map((id) => ({
		kind: "missing_settled",
		deviceId: id,
		pathId: spec.pathId,
		note: `Device ${id} did not emit device.witness.settled for pathId=${spec.pathId} by step ${spec.deadlineStepIndex}`,
	}));

	// Include last observed event per missing device (any event, not just settled)
	for (const id of missing) {
		const last = [...events].reverse().find((e) => e.deviceId === id);
		if (last) {
			evidence.push({ kind: "last_observed", deviceId: id, seq: last.seq, data: last.data });
		} else {
			evidence.push({ kind: "last_observed", deviceId: id, note: "no events observed" });
		}
	}

	return {
		ok: false,
		reason: "quorum_incomplete",
		evidence,
		summary: `Quorum incomplete: missing devices [${missing.join(", ")}] for pathId=${spec.pathId} at step ${spec.deadlineStepIndex}`,
	};
}
