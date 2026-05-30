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
 *   - Tracks dropped events for observability in QA/dev mode
 */

import type { TraceSink, DomainTraceEvent, DomainPathTraceEvent } from "../../observability/traceSink";
import { FLIGHT_KIND, type FlightKind, type FlightPathEventInput, type FlightLayer } from "./flightEvents";

type FlightPathRecorder = (event: FlightPathEventInput) => void;

/**
 * Map domain event kinds to FLIGHT_KIND constants.
 * Rename cluster + disk observation cluster.
 */
const DOMAIN_TO_FLIGHT_KIND: Record<string, string> = {
	// Rename cluster
	"rename.observed": FLIGHT_KIND.diskRenameObserved,
	"rename.admission.invariant-failed": FLIGHT_KIND.renameAdmissionInvariantFailed,
	// Disk observation cluster
	"disk.create.observed": FLIGHT_KIND.diskCreateObserved,
	"disk.modify.observed": FLIGHT_KIND.diskModifyObserved,
	"disk.delete.observed": FLIGHT_KIND.diskDeleteObserved,
	"disk.event.suppressed": FLIGHT_KIND.diskEventSuppressed,
};

/**
 * Map domain event kinds to layer.
 * Policy layer: admission decisions, suppression decisions.
 * Disk layer: raw observations.
 */
function kindToLayer(kind: string): FlightLayer {
	if (kind.startsWith("rename.admission") || kind === "disk.event.suppressed") {
		return "policy";
	}
	return "disk";
}

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
	/**
	 * Count of domain events that were dropped because no FLIGHT_KIND mapping exists.
	 * Visible via getDroppedEventCount() for QA/dev mode observability.
	 */
	private _droppedEventCount = 0;

	constructor(private readonly recordFlight: FlightPathRecorder) {}

	record(_event: DomainTraceEvent): void {
		// Non-path events not yet mapped in this phase.
		// Future: map to FlightEventInput via a non-path recorder.
	}

	recordPath(event: DomainPathTraceEvent): void {
		const flightKind = DOMAIN_TO_FLIGHT_KIND[event.kind];
		if (!flightKind) {
			// Unknown domain event — no flight mapping.
			// Count the drop for QA/dev observability. Silent drops in production
			// are acceptable, but invisible drops during RCA are not.
			this._droppedEventCount++;
			return;
		}

		this.recordFlight({
			priority: event.priority ?? severityToPriority(event.severity),
			kind: flightKind as FlightKind,
			severity: event.severity,
			scope: event.scope,
			source: "vaultEvents",
			layer: kindToLayer(event.kind),
			opId: event.opId ?? event.data?.["opId"] as string | undefined,
			path: event.path,
			data: event.data,
			// Lift reason/decision from data for disk.event.suppressed compatibility
			reason: event.data?.["reason"] as string | undefined,
			decision: event.data?.["decision"] as string | undefined,
		});
	}

	async flush(): Promise<void> {
		// Flight recorder handles its own flushing.
		// This is a no-op unless we need to wait for pending path HMAC work.
	}

	/**
	 * Returns the number of domain events dropped because no FLIGHT_KIND mapping exists.
	 * Use this in QA/dev mode to detect when domain events are being lost silently.
	 * A non-zero count indicates that either:
	 *   - A new domain event kind needs to be added to DOMAIN_TO_FLIGHT_KIND
	 *   - A trace call is using the wrong event kind
	 */
	getDroppedEventCount(): number {
		return this._droppedEventCount;
	}
}
