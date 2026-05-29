/**
 * FlightTraceSink — adapter that maps domain events to the existing
 * flight recorder event schema.
 *
 * This is the bridge between the domain-level TraceSink interface and
 * the flight recorder internals (FLIGHT_KIND, FlightPathEventInput, etc).
 *
 * The adapter:
 *   - Maps domain event kinds to FLIGHT_KIND constants
 *   - Maps domain severity to FlightPriority
 *   - Delegates to the provided recordFlightPathEvent callback
 *   - Is non-blocking (recordPath queues internally via the callback)
 */

import type { TraceSink, DomainTraceEvent, DomainPathTraceEvent } from "../observability/traceSink";
import { FLIGHT_KIND, type FlightKind, type FlightPathEventInput } from "./flightEvents";

type FlightPathRecorder = (event: FlightPathEventInput) => void;

/**
 * Map domain event kinds to FLIGHT_KIND constants.
 * Only rename-admission events are mapped in this phase.
 */
const DOMAIN_TO_FLIGHT_KIND: Record<string, string> = {
	"rename.observed": FLIGHT_KIND.diskRenameObserved,
	"rename.admission.invariant-failed": FLIGHT_KIND.renameAdmissionInvariantFailed,
};

/**
 * Map domain severity to flight priority.
 */
function severityToPriority(severity: DomainTraceEvent["severity"]): "critical" | "important" | "verbose" {
	switch (severity) {
		case "error": return "critical";
		case "warn": return "important";
		case "info": return "important";
		case "debug": return "verbose";
	}
}

export class FlightTraceSink implements TraceSink {
	constructor(private readonly recordFlight: FlightPathRecorder) {}

	record(_event: DomainTraceEvent): void {
		// Non-path events not yet mapped in this phase.
		// Future: map to FlightEventInput via a non-path recorder.
	}

	recordPath(event: DomainPathTraceEvent): void {
		const flightKind = DOMAIN_TO_FLIGHT_KIND[event.kind];
		if (!flightKind) {
			// Unknown domain event — no flight mapping.
			// TODO: In QA/dev mode, emit a debug counter or log so dropped events
			// are visible during development. Silent drops in production are
			// acceptable, but invisible drops during RCA are not.
			// See: engineering/autophagy-plan.md follow-ups.
			return;
		}

		this.recordFlight({
			priority: severityToPriority(event.severity),
			kind: flightKind as FlightKind,
			severity: event.severity,
			scope: event.scope,
			source: "vaultEvents",
			layer: event.kind.startsWith("rename.admission") ? "policy" : "disk",
			opId: event.opId ?? event.data?.["opId"] as string | undefined,
			path: event.path,
			data: event.data,
		});
	}

	async flush(): Promise<void> {
		// Flight recorder handles its own flushing.
		// This is a no-op unless we need to wait for pending path HMAC work.
	}
}
