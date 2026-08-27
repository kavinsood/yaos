/**
 * Flight taxonomy — the published vocabulary of the exported trace format.
 *
 * A user turns on debug mode, reproduces a bug, and hands the resulting
 * NDJSON file to a maintainer or an LLM. This module is the vocabulary that
 * file is written in, so it is owned by the product, not by the recorder that
 * happens to serialise it. `src/telemetry/debug/*` consumes this module; it
 * does not define it.
 *
 * WIRE CONTRACT. Every string value below appears verbatim in exported
 * traces and in the analyzer rules under `qa/analyzers/`. Changing a value is
 * a breaking format change, not a rename:
 *
 *   - Adding, removing or renaming a kind REQUIRES bumping
 *     FLIGHT_TAXONOMY_VERSION.
 *   - Never repurpose an existing string for a different event.
 *   - The key (e.g. `crdtFileCreated`) is a compile-time handle and may be
 *     renamed freely; the value (`"crdt.file.created"`) may not.
 *
 * `PRODUCT_EVENT_KIND` in ./productEventKinds.ts is a narrowed view of
 * FLIGHT_KIND — the subset product runtime code is permitted to emit. It
 * references these constants rather than repeating their strings.
 */

export const FLIGHT_TAXONOMY_VERSION = 13; // added unified debug trace event/checkpoint kinds

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
	| "traceRuntime"
	| "diagnostics"
	| "server";

export type FlightPriority = "critical" | "important" | "verbose";

// -----------------------------------------------------------------------
// Canonical event taxonomy
// -----------------------------------------------------------------------

export const FLIGHT_KIND = {
	// Debug-trace lifecycle (emitted when settings.debug arms/disarms the recorder)
	debugTraceStarted: "debug.trace.started",
	debugTraceStopped: "debug.trace.stopped",
	debugTraceEvent: "debug.trace.event",
	debugTraceCheckpoint: "debug.trace.checkpoint",
	// QA harness only
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
	/** Emitted when same-identity rename fires but CRDT already has distinct entries for both NFC/NFD forms. */
	renameAdmissionCanonicalCollision: "rename.admission.canonical-collision",

	// CRDT
	crdtFileCreated: "crdt.file.created",
	crdtFileUpdated: "crdt.file.updated",
	crdtFileRenamed: "crdt.file.renamed",
	crdtFileTombstoned: "crdt.file.tombstoned",            // priority: critical
	crdtFileRevived: "crdt.file.revived",                  // priority: critical

	// Attachment root catalog and transfer lifecycle
	attachmentRevived: "attachment.revived",
	attachmentTombstoned: "attachment.tombstoned",
	attachmentRenamed: "attachment.renamed",
	attachmentUploadDecision: "attachment.upload.decision",
	attachmentUploadComplete: "attachment.upload.complete",
	attachmentDownloadDecision: "attachment.download.decision",
	attachmentDownloadComplete: "attachment.download.complete",
	attachmentIntegrityFailed: "attachment.integrity.failed",

	// Reconcile
	reconcileStart: "reconcile.start",
	reconcileFileDecision: "reconcile.file.decision",      // priority: critical when conflictRisk=ambiguous
	reconcileFileDeferred: "reconcile.file.deferred",      // priority: verbose — open/bound file skipped, convergence via editor binding
	reconcileSafetyBrakeTriggered: "reconcile.safety_brake.triggered", // priority: critical
	reconcileComplete: "reconcile.complete",

	// Recovery — all now emitted from reconciliationController
	recoveryCaptureStart: "recovery.capture.start",
	recoveryCaptureComplete: "recovery.capture.complete",
	recoveryRestoreRestarted: "recovery.restore.restarted",
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
	 * nextLen with strictly positive deltas.
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
	 * All three types live in ./recoveryEventTypes.ts.
	 */
	recoverySkipped: "recovery.skipped",

	// Tombstone / remote delete lifecycle
	/** Emitted by diskMirror: CRDT remote delete observed, deciding action. */
	deleteRemoteObserved: "delete.remote.observed",
	/** Emitted by diskMirror: disk file removed because tombstone applied. */
	deleteDiskApplied: "delete.disk.applied",
	/** Emitted by diskMirror: file preserved instead of deleted (dirty local copy). */
	deletePreserved: "delete.preserved",

	// Editor binding orchestration (controller recovery orchestration spec)
	editorRepairApplied: "editor.repair.applied",
	editorHealApplied: "editor.heal.applied",
} as const;

export type FlightKind = typeof FLIGHT_KIND[keyof typeof FLIGHT_KIND];
