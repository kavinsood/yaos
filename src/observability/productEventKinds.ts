/**
 * Product-owned event kind constants.
 *
 * Product sync/runtime code uses these constants instead of importing
 * FLIGHT_KIND from debug/flightEvents.ts. This breaks the product→lab
 * dependency and allows lab code to be dynamically loaded or evicted.
 *
 * The lab layer (FlightTraceSink) maps these to the flight recorder schema.
 * The string values must match FLIGHT_KIND values exactly for compatibility.
 */

export const PRODUCT_EVENT_KIND = {
	// CRDT lifecycle
	crdtFileCreated: "crdt.file.created",
	crdtFileUpdated: "crdt.file.updated",
	crdtFileRenamed: "crdt.file.renamed",
	crdtFileTombstoned: "crdt.file.tombstoned",
	crdtFileRevived: "crdt.file.revived",

	// Disk observations
	diskWriteOk: "disk.write.ok",
	diskWriteFailed: "disk.write.failed",
	diskEventNotSuppressed: "disk.event.not_suppressed",

	// Reconcile
	reconcileStart: "reconcile.start",
	reconcileComplete: "reconcile.complete",
	reconcileFileDecision: "reconcile.file.decision",
	reconcileSafetyBrakeTriggered: "reconcile.safety_brake.triggered",

	// Recovery
	recoveryDecision: "recovery.decision",
	recoveryApplyStart: "recovery.apply.start",
	recoveryApplyDone: "recovery.apply.done",
	recoverySkipped: "recovery.skipped",
	recoveryPostconditionFailed: "recovery.postcondition.failed",
	recoveryQuarantined: "recovery.quarantined",
	recoveryLoopDetected: "recovery.loop.detected",
	recoveryAmplificationQuarantined: "recovery.amplification.quarantined",

	// Editor
	editorHealApplied: "editor.heal.applied",
	editorRepairApplied: "editor.repair.applied",
} as const;

export type ProductEventKind =
	typeof PRODUCT_EVENT_KIND[keyof typeof PRODUCT_EVENT_KIND];
