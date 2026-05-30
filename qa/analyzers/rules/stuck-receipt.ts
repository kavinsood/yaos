import type { FlightEvent } from "../flight-event";
import type { AnalyzerFinding } from "../report";

const STUCK_WINDOW_MS = 60_000;

/**
 * Rule: stuck receipt
 *
 * Flag when server.receipt.candidate_captured is seen, the device was online
 * (provider.connected present), and no server.receipt.confirmed appears within
 * 60 seconds.
 */
export function checkStuckReceipt(events: FlightEvent[]): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];

	const candidates = events.filter((e) => e.kind === "server.receipt.candidate_captured");
	if (candidates.length === 0) {
		findings.push({
			rule: "stuck-receipt",
			severity: "warning",
			eventSeqs: [],
			description:
				"COVERAGE: no server.receipt.candidate_captured events seen — " +
				"stuck-receipt rule could not fire (no writes were attempted in this trace)",
		});
		return findings;
	}

	const connectedTimes = events
		.filter((e) => e.kind === "provider.connected" || e.kind === "provider.sync.complete")
		.map((e) => e.ts);

	const confirmedTimes = events
		.filter((e) => e.kind === "server.receipt.confirmed")
		.map((e) => e.ts);

	for (const candidate of candidates) {
		const capturedAt = candidate.ts;

		// Check if device was online around capture time (within ±30s)
		const wasOnline = connectedTimes.some(
			(t) => Math.abs(t - capturedAt) <= 30_000,
		);
		if (!wasOnline) continue; // offline capture — expected

		// Check if confirmed within STUCK_WINDOW_MS
		const confirmed = confirmedTimes.some(
			(t) => t >= capturedAt && t - capturedAt <= STUCK_WINDOW_MS,
		);
		if (!confirmed) {
			findings.push({
				rule: "stuck-receipt",
				severity: "warning",
				opId: candidate.opId,
				eventSeqs: [candidate.seq],
				description:
					`server.receipt.candidate_captured while online but no server.receipt.confirmed ` +
					`within ${STUCK_WINDOW_MS}ms (capturedAt=${new Date(capturedAt).toISOString()})`,
			});
		}
	}

	return findings;
}
