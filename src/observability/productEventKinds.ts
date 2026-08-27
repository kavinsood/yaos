/**
 * Product-owned event kinds — the capability-restricted view of the flight
 * taxonomy.
 *
 * This is NOT a second table. Every entry references the canonical constant in
 * ./flightTaxonomy.ts, so the strings cannot drift and no comment is needed to
 * keep them in step.
 *
 * Why the narrowed view still exists: capability restriction. `FLIGHT_KIND`
 * contains harness- and recorder-only kinds (`qa.phase`, `qa.checkpoint`,
 * `debug.trace.started`, `flight.events.dropped`, `export.manifest`, …) that
 * product runtime code must never emit — only the QA harness and the recorder
 * itself may. `ProductEventKind` is a strict subset of `FlightKind`, so a
 * product callsite reaching for a harness-only kind is a compile error rather
 * than a lint rule.
 *
 * (The historical rationale — "breaks the product→lab dependency so lab code
 * can be dynamically loaded or evicted" — is obsolete: the telemetry bundle is
 * compiled into the product, so there is no dynamic load to protect.)
 *
 * Adding a kind here is a deliberate widening of what product code may emit.
 */

import { FLIGHT_KIND, type FlightKind } from "./flightTaxonomy";

export const PRODUCT_EVENT_KIND = {
	// CRDT lifecycle
	crdtFileCreated: FLIGHT_KIND.crdtFileCreated,
	crdtFileUpdated: FLIGHT_KIND.crdtFileUpdated,
	crdtFileRenamed: FLIGHT_KIND.crdtFileRenamed,
	crdtFileTombstoned: FLIGHT_KIND.crdtFileTombstoned,
	crdtFileRevived: FLIGHT_KIND.crdtFileRevived,

	// Disk observations
	diskWriteOk: FLIGHT_KIND.diskWriteOk,
	diskWriteFailed: FLIGHT_KIND.diskWriteFailed,
	diskEventNotSuppressed: FLIGHT_KIND.diskEventNotSuppressed,
	deleteRemoteObserved: FLIGHT_KIND.deleteRemoteObserved,
	deleteDiskApplied: FLIGHT_KIND.deleteDiskApplied,
	serverReceiptCandidateCaptured: FLIGHT_KIND.serverReceiptCandidateCaptured,
	serverReceiptConfirmed: FLIGHT_KIND.serverReceiptConfirmed,
	attachmentRevived: FLIGHT_KIND.attachmentRevived,
	attachmentTombstoned: FLIGHT_KIND.attachmentTombstoned,
	attachmentRenamed: FLIGHT_KIND.attachmentRenamed,
	attachmentUploadDecision: FLIGHT_KIND.attachmentUploadDecision,
	attachmentUploadComplete: FLIGHT_KIND.attachmentUploadComplete,
	attachmentDownloadDecision: FLIGHT_KIND.attachmentDownloadDecision,
	attachmentDownloadComplete: FLIGHT_KIND.attachmentDownloadComplete,
	attachmentIntegrityFailed: FLIGHT_KIND.attachmentIntegrityFailed,

	// Reconcile
	reconcileStart: FLIGHT_KIND.reconcileStart,
	reconcileComplete: FLIGHT_KIND.reconcileComplete,
	reconcileFileDecision: FLIGHT_KIND.reconcileFileDecision,
	reconcileFileDeferred: FLIGHT_KIND.reconcileFileDeferred,
	reconcileSafetyBrakeTriggered: FLIGHT_KIND.reconcileSafetyBrakeTriggered,

	// Recovery
	recoveryCaptureStart: FLIGHT_KIND.recoveryCaptureStart,
	recoveryCaptureComplete: FLIGHT_KIND.recoveryCaptureComplete,
	recoveryRestoreRestarted: FLIGHT_KIND.recoveryRestoreRestarted,
	recoveryDecision: FLIGHT_KIND.recoveryDecision,
	recoveryApplyStart: FLIGHT_KIND.recoveryApplyStart,
	recoveryApplyDone: FLIGHT_KIND.recoveryApplyDone,
	recoverySkipped: FLIGHT_KIND.recoverySkipped,
	recoveryPostconditionFailed: FLIGHT_KIND.recoveryPostconditionFailed,
	recoveryQuarantined: FLIGHT_KIND.recoveryQuarantined,
	recoveryLoopDetected: FLIGHT_KIND.recoveryLoopDetected,
	recoveryAmplificationQuarantined: FLIGHT_KIND.recoveryAmplificationQuarantined,

	// Editor
	editorHealApplied: FLIGHT_KIND.editorHealApplied,
	editorRepairApplied: FLIGHT_KIND.editorRepairApplied,

	// Rename admission
	renameAdmissionCanonicalCollision: FLIGHT_KIND.renameAdmissionCanonicalCollision,
} as const satisfies Record<string, FlightKind>;

/**
 * Strict subset of `FlightKind`.
 *
 * The `satisfies Record<string, FlightKind>` on the table above is
 * load-bearing and zero-cost: it makes the subset relationship a compile-time
 * fact (so a `ProductEventKind` is accepted anywhere a `FlightKind` is
 * expected) while `ProductEventKind` itself stays narrow enough to reject a
 * harness-only kind such as `FLIGHT_KIND.qaPhase`.
 */
export type ProductEventKind =
	typeof PRODUCT_EVENT_KIND[keyof typeof PRODUCT_EVENT_KIND];
