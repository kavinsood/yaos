/**
 * Verification Gate 1 — Schema and event semantics (Requirement Gate 1)
 *
 * Tests that device.witness.settled and device.witness.diverged events
 * conform to the Phase 2 schema invariants:
 *   - causedByEvents is always object-shaped (never null, never missing)
 *   - deviceId is a non-empty string
 *   - seq is a non-negative integer
 *   - runtimeState is one of the four valid values
 *   - stateKind is "present" or "deleted"
 *   - Three Phase 2 DivergenceReasons are valid
 */

import assert from "node:assert/strict";
import type { DivergenceReason, RuntimeState, CausedByEvents } from "../src/telemetry/diagnostics/deviceWitnessTracker";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): void {
	Promise.resolve().then(fn).then(() => {
		console.log(`  PASS  ${name}`);
		passed++;
	}).catch((err: unknown) => {
		console.error(`  FAIL  ${name}`);
		console.error(`        ${err instanceof Error ? err.message : String(err)}`);
		failed++;
	});
}

// -----------------------------------------------------------------------
// Schema validation helpers
// -----------------------------------------------------------------------

function validateCausedByEvents(obj: unknown): void {
	assert.ok(obj !== null && typeof obj === "object", "causedByEvents must be an object");
	const allowed = new Set([
		"lastDiskWriteSeq", "lastCrdtUpdateSeq", "lastRecoverySeq",
		"lastRemoteApplySeq", "lastConflictArtifactSeq", "lastTombstoneSeq",
	]);
	for (const key of Object.keys(obj as Record<string, unknown>)) {
		assert.ok(allowed.has(key), `causedByEvents has unexpected key: ${key}`);
		assert.ok(typeof (obj as Record<string, unknown>)[key] === "number", `causedByEvents.${key} must be a number`);
	}
}

function validateRuntimeState(val: unknown): void {
	const valid: RuntimeState[] = ["foreground", "background", "suspended", "unknown"];
	assert.ok(valid.includes(val as RuntimeState), `runtimeState must be one of ${valid.join(", ")}, got: ${val}`);
}

function validateStateKind(val: unknown): void {
	assert.ok(val === "present" || val === "deleted", `stateKind must be "present" or "deleted", got: ${val}`);
}

function validateSeq(val: unknown): void {
	assert.ok(typeof val === "number" && Number.isInteger(val) && val >= 0, `seq must be a non-negative integer, got: ${val}`);
}

function validateDeviceId(val: unknown): void {
	assert.ok(typeof val === "string" && val.length > 0, `deviceId must be a non-empty string, got: ${val}`);
}

// -----------------------------------------------------------------------
// Fixture corpus
// -----------------------------------------------------------------------

const VALID_SETTLED_EVENT = {
	kind: "device.witness.settled",
	seq: 42,
	deviceId: "550e8400-e29b-41d4-a716-446655440000",
	stateKind: "present",
	runtimeState: "foreground",
	causedByEvents: { lastDiskWriteSeq: 10, lastCrdtUpdateSeq: 11 },
	stateHash: "h:abcdef1234567890abcdef1234567890",
};

const VALID_DIVERGED_EVENT = {
	kind: "device.witness.diverged",
	seq: 43,
	deviceId: "550e8400-e29b-41d4-a716-446655440000",
	stateKind: "present",
	runtimeState: "foreground",
	causedByEvents: {},
	reason: "disk_crdt_mismatch",
};

const VALID_UNAVAILABLE_EVENT = {
	kind: "device.witness.diverged",
	seq: 44,
	deviceId: "550e8400-e29b-41d4-a716-446655440000",
	stateKind: "present",
	runtimeState: "background",
	causedByEvents: {},
	reason: "unavailable",
};

const VALID_CHECKPOINT_WRITE_FAILED = {
	kind: "device.witness.diverged",
	seq: 45,
	deviceId: "550e8400-e29b-41d4-a716-446655440000",
	stateKind: "present",
	runtimeState: "foreground",
	causedByEvents: {},
	reason: "checkpoint_write_failed",
};

const VALID_CHECKPOINT_PATH_INSIDE_VAULT = {
	kind: "device.witness.diverged",
	seq: 46,
	deviceId: "550e8400-e29b-41d4-a716-446655440000",
	stateKind: "present",
	runtimeState: "foreground",
	causedByEvents: {},
	reason: "checkpoint_path_inside_vault",
};

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

test("valid settled event passes schema", () => {
	validateSeq(VALID_SETTLED_EVENT.seq);
	validateDeviceId(VALID_SETTLED_EVENT.deviceId);
	validateStateKind(VALID_SETTLED_EVENT.stateKind);
	validateRuntimeState(VALID_SETTLED_EVENT.runtimeState);
	validateCausedByEvents(VALID_SETTLED_EVENT.causedByEvents);
	assert.ok(VALID_SETTLED_EVENT.stateHash.startsWith("h:"), "stateHash must start with h:");
});

test("valid diverged event passes schema", () => {
	validateSeq(VALID_DIVERGED_EVENT.seq);
	validateDeviceId(VALID_DIVERGED_EVENT.deviceId);
	validateStateKind(VALID_DIVERGED_EVENT.stateKind);
	validateRuntimeState(VALID_DIVERGED_EVENT.runtimeState);
	validateCausedByEvents(VALID_DIVERGED_EVENT.causedByEvents);
});

test("unavailable reason is valid DivergenceReason", () => {
	const reason: DivergenceReason = "unavailable";
	assert.equal(reason, VALID_UNAVAILABLE_EVENT.reason);
	assert.equal(VALID_UNAVAILABLE_EVENT.runtimeState, "background");
});

test("checkpoint_write_failed reason is valid DivergenceReason", () => {
	const reason: DivergenceReason = "checkpoint_write_failed";
	assert.equal(reason, VALID_CHECKPOINT_WRITE_FAILED.reason);
});

test("checkpoint_path_inside_vault reason is valid DivergenceReason", () => {
	const reason: DivergenceReason = "checkpoint_path_inside_vault";
	assert.equal(reason, VALID_CHECKPOINT_PATH_INSIDE_VAULT.reason);
});

test("causedByEvents empty object is valid", () => {
	validateCausedByEvents({});
});

test("causedByEvents with all fields is valid", () => {
	const full: CausedByEvents = {
		lastDiskWriteSeq: 1,
		lastCrdtUpdateSeq: 2,
		lastRecoverySeq: 3,
		lastRemoteApplySeq: 4,
		lastConflictArtifactSeq: 5,
		lastTombstoneSeq: 6,
	};
	validateCausedByEvents(full);
});

test("causedByEvents with unexpected key fails", () => {
	assert.throws(() => {
		validateCausedByEvents({ lastDiskWriteSeq: 1, unknownKey: 2 });
	});
});

test("runtimeState unknown is valid (conservative treatment)", () => {
	validateRuntimeState("unknown");
});

test("runtimeState invalid value fails", () => {
	assert.throws(() => validateRuntimeState("active"));
});

test("stateKind deleted is valid", () => {
	validateStateKind("deleted");
});

test("stateKind invalid value fails", () => {
	assert.throws(() => validateStateKind("text")); // "text" is the reviewer alias, not the internal type
});

test("seq 0 is valid (non-negative integer)", () => {
	validateSeq(0);
});

test("seq negative fails", () => {
	assert.throws(() => validateSeq(-1));
});

test("deviceId empty string fails", () => {
	assert.throws(() => validateDeviceId(""));
});

// -----------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------

setTimeout(() => {
	console.log(`\nResults: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}, 100);
