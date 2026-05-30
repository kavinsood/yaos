import type { FlightEvent } from "../flight-event";
import type { AnalyzerFinding } from "../report";

/**
 * Rule: false safe-to-close (placeholder)
 *
 * When YAOS emits a dedicated "safe-to-close" event, this rule will check
 * that durable receipt was actually confirmed before it was emitted.
 *
 * Currently the event is not yet in the taxonomy, so this rule is a
 * warning placeholder that fires if it ever sees an unexpected pattern.
 */
export function checkFalseSafeToClose(events: FlightEvent[]): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];

	// Future: check for "receipt.safe_to_close" kind and cross-reference
	// against server.receipt.confirmed timing.
	// For now, emit nothing — the rule exists so the analyzer skeleton is complete.
	void events;

	return findings;
}
