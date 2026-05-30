import type { FlightEvent } from "../flight-event";
import type { AnalyzerFinding } from "../report";

/**
 * Rule: disk/CRDT idle mismatch
 *
 * At every qa.checkpoint, check if any path shows diskHash !== crdtHash
 * while reconcileInFlight=false and no pending blob transfers.
 */
export function checkDiskCrdtIdleMismatch(events: FlightEvent[]): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];

	const checkpoints = events.filter((e) => e.kind === "qa.checkpoint");
	if (checkpoints.length === 0) {
		findings.push({
			rule: "disk-crdt-idle-mismatch",
			severity: "warning",
			eventSeqs: [],
			description:
				"COVERAGE: no qa.checkpoint events seen — " +
				"disk-crdt-idle-mismatch rule could not fire (harness checkpoints not enabled)",
		});
		return findings;
	}

	for (const cp of checkpoints) {
		const state = (cp.data as Record<string, unknown> | undefined)?.state as Record<string, unknown> | undefined;
		if (!state) continue;

		const reconcileInFlight = state.reconcileInFlight === true;
		const pendingBlobUploads = Number(state.pendingBlobUploads ?? 0);
		const pendingBlobDownloads = Number(state.pendingBlobDownloads ?? 0);
		const safetyBrakeActive = state.safetyBrakeActive === true;

		if (reconcileInFlight || pendingBlobUploads > 0 || pendingBlobDownloads > 0 || safetyBrakeActive) {
			continue; // not idle
		}

		const hashMismatches = Number(state.hashMismatches ?? 0);
		if (hashMismatches > 0) {
			findings.push({
				rule: "disk-crdt-idle-mismatch",
				severity: "hard",
				eventSeqs: [cp.seq],
				description:
					`qa.checkpoint at seq=${cp.seq} shows ${hashMismatches} disk/CRDT hash ` +
					`mismatch(es) while idle (reconcileInFlight=false, no pending transfers)`,
			});
		}
	}

	return findings;
}
