import type { FlightEvent } from "../flight-event";
import type { AnalyzerFinding } from "../report";

/**
 * Rule: redaction failure
 *
 * Any redaction.failure event is a hard failure — it means sensitive data
 * (path, token, host) almost leaked into a safe trace.
 */
export function checkRedactionFailure(events: FlightEvent[]): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];

	for (const e of events) {
		if (e.kind === "redaction.failure") {
			const data = (e.data ?? {}) as Record<string, unknown>;
			findings.push({
				rule: "redaction-failure",
				severity: "hard",
				eventSeqs: [e.seq],
				description:
					`redaction.failure at seq=${e.seq}: ` +
					`originalKind=${data.originalKind ?? "?"} leakedKey=${data.leakedKey ?? "?"}`,
			});
		}
	}

	return findings;
}
