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
 *
 * INVARIANT: every kind registered in PRODUCT_EVENT_KIND must have an entry
 * in DOMAIN_TO_FLIGHT_KIND. The CI check in tests/client/trace-sink.ts enforces
 * _droppedEventCount === 0 for all known product event kinds.
 */

import type { TraceSink, DomainTraceEvent, DomainPathTraceEvent } from "../../observability/traceSink";
import { FLIGHT_KIND, type FlightKind, type FlightLayer, type FlightSource } from "../../observability/flightTaxonomy";
import type { FlightPathEventInput } from "../../observability/flightEnvelope";

type FlightPathRecorder = (event: FlightPathEventInput) => void;

/**
 * Map domain event kinds to FLIGHT_KIND constants.
 * All PRODUCT_EVENT_KIND values must appear here.
 */
const DOMAIN_TO_FLIGHT_KIND: Record<string, string> = {
	// Rename cluster
	"rename.observed": FLIGHT_KIND.diskRenameObserved,
	"rename.admission.invariant-failed": FLIGHT_KIND.renameAdmissionInvariantFailed,
	"rename.admission.canonical-collision": FLIGHT_KIND.renameAdmissionCanonicalCollision,
	// Disk observation cluster
	"disk.create.observed": FLIGHT_KIND.diskCreateObserved,
	"disk.modify.observed": FLIGHT_KIND.diskModifyObserved,
	"disk.delete.observed": FLIGHT_KIND.diskDeleteObserved,
	"disk.event.suppressed": FLIGHT_KIND.diskEventSuppressed,
	// CRDT lifecycle cluster (migrated from vaultSync.ts direct FLIGHT_KIND usage)
	"crdt.file.created": FLIGHT_KIND.crdtFileCreated,
	"crdt.file.renamed": FLIGHT_KIND.crdtFileRenamed,
	"crdt.file.tombstoned": FLIGHT_KIND.crdtFileTombstoned,
	"crdt.file.revived": FLIGHT_KIND.crdtFileRevived,
	// Reconcile deferred (open/bound file skipped; convergence via editor binding path)
	"reconcile.file.deferred": FLIGHT_KIND.reconcileFileDeferred,
};

/**
 * Map domain event kinds to flight layer.
 */
function kindToLayer(kind: string): FlightLayer {
	if (kind.startsWith("rename.admission") || kind === "disk.event.suppressed") {
		return "policy";
	}
	if (kind.startsWith("crdt.")) {
		return "crdt";
	}
	if (kind.startsWith("reconcile.")) {
		return "reconcile";
	}
	return "disk";
}

/**
 * Map domain event kinds to flight source.
 */
function kindToSource(kind: string): FlightSource {
	if (kind.startsWith("crdt.") || kind.startsWith("reconcile.")) {
		return "vaultSync";
	}
	return "vaultEvents";
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
	 * Count of domain events dropped because no FLIGHT_KIND mapping exists.
	 * Visible via getDroppedEventCount() for QA/dev mode observability.
	 * Also counts record() drops (non-path events not yet mapped).
	 */
	private _droppedEventCount = 0;

	constructor(private readonly recordFlight: FlightPathRecorder) {}

	record(event: DomainTraceEvent): void {
		// Non-path events not yet mapped — count the drop.
		// When non-path PRODUCT_EVENT_KIND values are added, add them to
		// a DOMAIN_TO_FLIGHT_EVENT mapping and route through recordFlight.
		void event;
		this._droppedEventCount++;
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
			source: kindToSource(event.kind),
			layer: kindToLayer(event.kind),
			opId: event.opId ?? event.data?.["opId"] as string | undefined,
			path: event.path,
			// Lift structured fields out of data for flight schema compatibility
			fileId: event.data?.["fileId"] as string | undefined,
			reason: event.data?.["reason"] as string | undefined,
			decision: event.data?.["decision"] as string | undefined,
			data: event.data,
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
	 *   - record() was called (non-path events are not yet mapped)
	 */
	getDroppedEventCount(): number {
		return this._droppedEventCount;
	}
}
