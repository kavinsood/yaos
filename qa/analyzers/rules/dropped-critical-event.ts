import type { FlightEvent } from "../flight-event";
import type { AnalyzerFinding } from "../report";

/**
 * Rule: dropped critical event
 *
 * flight.events.dropped with data.droppedByPriority.critical > 0 means the
 * recorder ran out of buffer and dropped events we needed. Hard failure.
 */
export function checkDroppedCriticalEvent(events: FlightEvent[]): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];

	for (const e of events) {
		if (e.kind !== "flight.events.dropped") continue;
		const data = (e.data ?? {}) as Record<string, unknown>;
		const byPriority = (data.droppedByPriority ?? {}) as Record<string, unknown>;
		const criticalCount = Number(byPriority.critical ?? 0);
		if (criticalCount > 0) {
			findings.push({
				rule: "dropped-critical-event",
				severity: "hard",
				eventSeqs: [e.seq],
				description:
					`flight.events.dropped at seq=${e.seq}: ` +
					`${criticalCount} critical event(s) dropped ` +
					`(total dropped=${data.count ?? "?"}, reason=${data.reason ?? "?"})`,
			});
		}
	}

	return findings;
}
