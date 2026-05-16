export const FLIGHT_EVENT_SCHEMA_VERSION = 1;
export const FLIGHT_TAXONOMY_VERSION = 7; // bumped: Phase 2 — recoveryStateHash on recovery.decision, causedByEvents + runtimeState on device.witness.*

export type FlightSeverity = "debug" | "info" | "warn" | "error";
export type FlightScope =
	| "file"
	| "folder"
	| "vault"
	| "blob"
	| "connection"
	| "server-room"
	| "diagnostics";

export type FlightLayer =
	| "lifecycle"
	| "disk"
	| "crdt"
	| "provider"
	| "server"
	| "reconcile"
	| "recovery"
	| "policy"
	| "editor"
	| "blob"
	| "diagnostics";

export type FlightSource =
	| "vaultSync"
	| "vaultEvents"        // main.ts vault event handlers (disk observations before dispatch)
	| "diskMirror"
	| "editorBinding"
	| "reconciliationController"
	| "connectionController"
	| "blobSync"
	| "serverAckTracker"
	| "traceRuntime"
	| "diagnostics"
	| "deviceWitness"
	| "server";

export type FlightPriority = "critical" | "important" | "verbose";

// -----------------------------------------------------------------------
// Canonical event taxonomy
// -----------------------------------------------------------------------

export const FLIGHT_KIND = {
	// QA / diagnostics
	qaTraceStarted: "qa.trace.started",
	qaTraceStopped: "qa.trace.stopped",
	qaCheckpoint: "qa.checkpoint",
	/**
	 * Emitted at the start of each QA scenario phase (setup/run/assert/cleanup).
	 * Analyzers use this to distinguish scenario-under-test events from
	 * teardown/cleanup events, eliminating the need for heuristics like
	 * "was there a disk.delete.observed before this tombstone?"
	 */
	qaPhase: "qa.phase",
	qaInvariantFailed: "qa.invariant.failed",
	flightEventsDropped: "flight.events.dropped",
	flightLogsRotated: "flight.logs.rotated",
	flightLogsCleared: "flight.logs.cleared",
	pathIdentityDegraded: "path.identity.degraded",
	redactionFailure: "redaction.failure",
	exportManifest: "export.manifest",

	// Provider
	providerConnected: "provider.connected",
	providerDisconnected: "provider.disconnected",
	providerSyncComplete: "provider.sync.complete",

	// Server receipt
	serverReceiptCandidateCaptured: "server.receipt.candidate_captured",
	serverSvEchoSeen: "server.sv_echo.seen",
	serverReceiptConfirmed: "server.receipt.confirmed",

	// Disk — local observations (external edits, not YAOS self-writes)
	diskCreateObserved: "disk.create.observed",
	diskModifyObserved: "disk.modify.observed",
	diskDeleteObserved: "disk.delete.observed",
	diskEventSuppressed: "disk.event.suppressed",         // meta: YAOS decided to suppress
	diskEventNotSuppressed: "disk.event.not_suppressed",  // meta: suppression failed (priority: critical)

	// Disk — YAOS writes
	diskWritePlanned: "disk.write.planned",
	diskWriteOk: "disk.write.ok",
	diskWriteFailed: "disk.write.failed",                  // priority: critical

	// Disk — rename
	diskRenameObserved: "disk.rename.observed",

	// CRDT
	crdtFileCreated: "crdt.file.created",
	crdtFileUpdated: "crdt.file.updated",
	crdtFileRenamed: "crdt.file.renamed",
	crdtFileTombstoned: "crdt.file.tombstoned",            // priority: critical
	crdtFileRevived: "crdt.file.revived",                  // priority: critical

	// Reconcile
	reconcileStart: "reconcile.start",
	reconcileFileDecision: "reconcile.file.decision",      // priority: critical when conflictRisk=ambiguous
	reconcileSafetyBrakeTriggered: "reconcile.safety_brake.triggered", // priority: critical
	reconcileWritebackApplied: "reconcile.writeback.applied",
	reconcileWritebackSkipped: "reconcile.writeback.skipped",
	reconcileComplete: "reconcile.complete",

	// Recovery — all now emitted from reconciliationController
	recoveryDecision: "recovery.decision",
	recoveryApplyStart: "recovery.apply.start",
	recoveryApplyDone: "recovery.apply.done",
	recoveryPostconditionFailed: "recovery.postcondition.failed",
	recoveryLoopDetected: "recovery.loop.detected",
	recoveryQuarantined: "recovery.quarantined",

	// Tombstone / remote delete lifecycle
	/** Emitted by diskMirror: CRDT remote delete observed, deciding action. */
	deleteRemoteObserved: "delete.remote.observed",
	/** Emitted by diskMirror: disk file removed because tombstone applied. */
	deleteDiskApplied: "delete.disk.applied",
	/** Emitted by diskMirror: file preserved instead of deleted (dirty local copy). */
	deletePreserved: "delete.preserved",

	// Device witness (Layer 4 Phase 1)
	deviceWitnessSettled: "device.witness.settled",
	deviceWitnessDiverged: "device.witness.diverged",
} as const;

export type FlightKind = typeof FLIGHT_KIND[keyof typeof FLIGHT_KIND];

// -----------------------------------------------------------------------
// Envelope types
// -----------------------------------------------------------------------

export type FlightEventBase = {
	eventSchemaVersion: number;
	taxonomyVersion: number;

	ts: number;
	mono?: number;
	seq: number;

	kind: FlightKind;
	severity: FlightSeverity;
	scope: FlightScope;
	source: FlightSource;
	layer: FlightLayer;

	traceId: string;
	bootId: string;
	deviceId: string;

	vaultIdHash: string;
	serverHostHash: string;
	pluginVersion: string;
	docSchemaVersion?: number;

	opId?: string;
	causedByOpId?: string;
	pathId?: string;
	path?: string;      // full/local-private mode only; absent in safe/qa-safe
	fileId?: string;
	candidateId?: string;
	svHash?: string;
	updateHash?: string;
	generation?: number;
	connectionGeneration?: number;

	decision?: string;
	reason?: string;

	/**
	 * data must NEVER contain these keys in safe/qa-safe mode:
	 * path, requestedPath, resolvedPath, oldPath, newPath,
	 * host, token, vaultId, deviceName, qaTraceSecret
	 */
	data?: Record<string, unknown>;
};

export type FlightEvent = FlightEventBase & {
	priority: FlightPriority;
};

/**
 * What callers provide. The recorder fills envelope fields.
 * Omits: eventSchemaVersion, taxonomyVersion, ts, mono, seq,
 *        traceId, bootId, deviceId, vaultIdHash, serverHostHash, pluginVersion.
 */
export type FlightEventInput = Omit<
	FlightEvent,
	| "eventSchemaVersion"
	| "taxonomyVersion"
	| "ts"
	| "mono"
	| "seq"
	| "traceId"
	| "bootId"
	| "deviceId"
	| "vaultIdHash"
	| "serverHostHash"
	| "pluginVersion"
> & {
	mono?: number;
};

/**
 * For path-scoped events: caller supplies raw `path`; the controller
 * resolves it to `pathId` (+ optional raw path in full mode).
 * `path` must never appear inside `data`.
 */
export type FlightPathEventInput = Omit<FlightEventInput, "pathId"> & {
	scope: "file" | "folder";
	path: string;
};

// -----------------------------------------------------------------------
// FlightSink — typed module boundary
// -----------------------------------------------------------------------

export type FlightSink = {
	record(event: FlightEventInput): void;
	recordPath(event: FlightPathEventInput): Promise<void>;
};

// -----------------------------------------------------------------------
// Misc supporting types
// -----------------------------------------------------------------------

export type SkipReason =
	| "excluded-path"
	| "oversized-text-file"
	| "frontmatter-unsafe"
	| "external-policy-never"
	| "external-policy-open-file"
	| "suppressed-remote-writeback"
	| "pending-rename-target"
	| "tombstoned-path"
	| "safety-brake"
	| "r2-unavailable"
	| "server-update-required"
	| "auth-failed";

export type FlightMode = "safe" | "qa-safe" | "full" | "local-private";

export type PathIdentity = {
	pathId: string;
	path?: string;
};

export type TraceContext = {
	traceId: string;
	bootId: string;
	deviceId: string;
	vaultIdHash: string;
	serverHostHash: string;
	pluginVersion: string;
	docSchemaVersion?: number;
};

// -----------------------------------------------------------------------
// Export result type
// -----------------------------------------------------------------------

export type FlightExportResult =
	| { ok: true; path: string; includesFilenames: boolean }
	| {
		ok: false;
		reason:
			| "trace-not-active"
			| "trace-unsafe-for-safe-export"
			| "trace-not-exportable"
			| "trace-degraded-path-identity"
			| "write-failed"
			| "flush-failed";
	};
