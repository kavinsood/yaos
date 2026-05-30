export const FLIGHT_EVENT_SCHEMA_VERSION = 1;
export const FLIGHT_TAXONOMY_VERSION = 10; // bumped: editor-bound localOnly amplifier guard — recovery.amplification.quarantined

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
	flightEventsDropped: "flight.events.dropped",
	flightLogsRotated: "flight.logs.rotated",
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
	diskWriteOk: "disk.write.ok",
	diskWriteFailed: "disk.write.failed",                  // priority: critical

	// Disk — rename
	diskRenameObserved: "disk.rename.observed",
	/** Emitted when an excluded markdown destination reaches applyRenameBatch despite admission policy. Bug. */
	renameAdmissionInvariantFailed: "rename.admission.invariant_failed",

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
	reconcileComplete: "reconcile.complete",

	// Recovery — all now emitted from reconciliationController
	recoveryDecision: "recovery.decision",
	recoveryApplyStart: "recovery.apply.start",
	recoveryApplyDone: "recovery.apply.done",
	recoveryPostconditionFailed: "recovery.postcondition.failed",
	recoveryLoopDetected: "recovery.loop.detected",
	recoveryQuarantined: "recovery.quarantined",
	/**
	 * Emitted when the monotonic-growth amplification detector trips.
	 * Distinct from `recovery.quarantined` (fingerprint-keyed) — this
	 * fires when N consecutive bound-file-local-only-divergence
	 * recoveries within a window all exhibit non-decreasing prevLen and
	 * nextLen with strictly positive deltas. See spec:
	 * .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R3.
	 */
	recoveryAmplificationQuarantined: "recovery.amplification.quarantined",
	/**
	 * Emitted when the controller short-circuits a recovery pass without
	 * entering any recovery branch. `data.reason` is constrained at the
	 * type level by `RecoverySkippedReason`. When `reason` is
	 * `"frontmatter-ingest-blocked"`, `data` matches the typed shape
	 * `RecoverySkippedFrontmatterData` (carries `wasBound` plus a closed-
	 * enum `branch` of type `FrontmatterIngestBlockBranch`); the only
	 * production constructor of that payload is
	 * `ReconciliationController.recordFrontmatterIngestBlocked`.
	 *
	 * See specs:
	 *   .kiro/specs/controller-recovery-orchestration/requirements.md R2.
	 *   .kiro/specs/frontmatter-guard-orchestration/requirements.md R2.
	 */
	recoverySkipped: "recovery.skipped",

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
	// QA scenario step (Layer 4 Phase 3 — cross-device ordering for manual runs)
	qaScenarioStep: "qa.scenario.step",
	// Editor binding orchestration (controller recovery orchestration spec)
	editorRepairApplied: "editor.repair.applied",
	editorHealApplied: "editor.heal.applied",
} as const;

export type FlightKind = typeof FLIGHT_KIND[keyof typeof FLIGHT_KIND];

// -----------------------------------------------------------------------
// recovery.skipped — typed reason discriminator and frontmatter payload
// -----------------------------------------------------------------------

/**
 * Closed-enum reason discriminator for `recovery.skipped` events. The
 * controller picks exactly one of these per emission. New reasons require
 * extending this union AND updating the spec.
 *
 * - "crdt-current-no-op"          CRDT and disk already agree.
 * - "recovery-lock-active"        bound recovery lock is still active.
 * - "recent-editor-activity"      crdtOnly branch idle-grace bail.
 * - "frontmatter-ingest-blocked"  shouldBlockFrontmatterIngest returned
 *                                 true at one of the six block sites.
 *                                 See FrontmatterIngestBlockBranch.
 *
 * See specs:
 *   .kiro/specs/controller-recovery-orchestration/requirements.md R2.
 *   .kiro/specs/frontmatter-guard-orchestration/requirements.md R2.
 */
export type RecoverySkippedReason =
	| "crdt-current-no-op"
	| "recovery-lock-active"
	| "recent-editor-activity"
	| "recent-editor-activity-local-only"
	| "frontmatter-ingest-blocked";

/**
 * Closed string-literal union covering every site at which
 * ReconciliationController calls shouldBlockFrontmatterIngest. Used as the
 * `branch` discriminator on `recovery.skipped` events with
 * `data.reason === "frontmatter-ingest-blocked"`. New emission sites
 * require extending this union AND updating the spec.
 *
 * See spec: .kiro/specs/frontmatter-guard-orchestration/requirements.md R2.
 */
export type FrontmatterIngestBlockBranch =
	| "disk-to-crdt-existing"
	| "disk-to-crdt-seed"
	| "bound-file-local-only-divergence"
	| "bound-file-local-only-seed"
	| "bound-file-open-idle-disk-recovery"
	| "bound-file-open-idle-seed";

/**
 * Typed payload shape for the `frontmatter-ingest-blocked` variant of
 * `recovery.skipped.data`. The helper
 * `ReconciliationController.recordFrontmatterIngestBlocked` is the only
 * production constructor of this payload.
 *
 * Required fields: `reason`, `wasBound`, `branch`. The `data` carrier on
 * `FlightEventBase` is `Record<string, unknown>`, so this type is the
 * compile-time guarantee that the helper builds the right shape.
 */
export type RecoverySkippedFrontmatterData = {
	reason: "frontmatter-ingest-blocked";
	wasBound: boolean;
	branch: FrontmatterIngestBlockBranch;
};

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
