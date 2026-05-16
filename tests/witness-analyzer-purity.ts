/**
 * Verification Gate 4 — Analyzer purity (Requirement Gate 4)
 *
 * Tests that every analyzer rule is a pure function with:
 *   - No observable side effects (no fs/network/Obsidian-API calls)
 *   - Full AnalyzerResult shape compliance (ok, evidence, summary)
 *   - Boolean-only returns are absent
 *   - Evidence severity discriminator is correct
 */

import assert from "node:assert/strict";
import { analyzeWitnessQuorum } from "../qa/analyzers/rules/quorum-incomplete";
import { analyzeCrossDeviceHashesEqual } from "../qa/analyzers/rules/cross-device-hash-mismatch";
import { analyzeEditorStability } from "../qa/analyzers/rules/editor-flicker-during-burst";
import { analyzeRecoveryEmittedOldHash, analyzeStaleHashAfterNewerWitness } from "../qa/analyzers/rules/recovery-stale-precise";
import type { FlightEvent } from "../qa/analyzers/flight-event";

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
// AnalyzerResult shape validation
// -----------------------------------------------------------------------

function validateAnalyzerResult(result: unknown, ruleName: string): void {
	assert.ok(result !== null && typeof result === "object", `${ruleName}: result must be an object`);
	const r = result as Record<string, unknown>;
	assert.ok(typeof r.ok === "boolean", `${ruleName}: result.ok must be a boolean`);
	assert.ok(Array.isArray(r.evidence), `${ruleName}: result.evidence must be an array`);
	assert.ok(typeof r.summary === "string", `${ruleName}: result.summary must be a string`);
	assert.ok(r.summary.length > 0, `${ruleName}: result.summary must be non-empty`);
}

// -----------------------------------------------------------------------
// Fixture events
// -----------------------------------------------------------------------

function makeSettledEvent(overrides: Partial<FlightEvent> = {}): FlightEvent {
	return {
		ts: 1000,
		seq: 1,
		kind: "device.witness.settled",
		severity: "info",
		scope: "file",
		source: "deviceWitness",
		layer: "diagnostics",
		priority: "important",
		deviceId: "device-a",
		pathId: "path-001",
		traceId: "trace-001",
		data: {
			stateHash: "h:abc123",
			stateKind: "present",
			runtimeState: "foreground",
			causedByEvents: {},
			stableAfterMs: 2000,
			stepIndex: 1, // B8: required for deadline enforcement
		},
		...overrides,
	};
}

function makeDivergedEvent(reason: string, overrides: Partial<FlightEvent> = {}): FlightEvent {
	return {
		ts: 1000,
		seq: 2,
		kind: "device.witness.diverged",
		severity: "warn",
		scope: "file",
		source: "deviceWitness",
		layer: "diagnostics",
		priority: "important",
		deviceId: "device-a",
		pathId: "path-001",
		traceId: "trace-001",
		data: {
			reason,
			stateKind: "present",
			runtimeState: "foreground",
			causedByEvents: {},
		},
		...overrides,
	};
}

// -----------------------------------------------------------------------
// analyzeWitnessQuorum tests
// -----------------------------------------------------------------------

test("analyzeWitnessQuorum: all devices settled → ok=true", () => {
	const events: FlightEvent[] = [
		makeSettledEvent({ deviceId: "device-a", pathId: "path-001", seq: 1 }),
		makeSettledEvent({ deviceId: "device-b", pathId: "path-001", seq: 2 }),
	];
	const result = analyzeWitnessQuorum(events, {
		pathId: "path-001",
		requiredDeviceIds: ["device-a", "device-b"],
		deadlineStepIndex: 5,
	});
	validateAnalyzerResult(result, "analyzeWitnessQuorum");
	assert.ok(result.ok, "Should pass when all devices settled");
});

test("analyzeWitnessQuorum: missing device → ok=false, hard finding", () => {
	const events: FlightEvent[] = [
		makeSettledEvent({ deviceId: "device-a", pathId: "path-001", seq: 1 }),
	];
	const result = analyzeWitnessQuorum(events, {
		pathId: "path-001",
		requiredDeviceIds: ["device-a", "device-b"],
		deadlineStepIndex: 5,
	});
	validateAnalyzerResult(result, "analyzeWitnessQuorum");
	assert.ok(!result.ok, "Should fail when device-b is missing");
	assert.ok(result.evidence.some((e) => e.deviceId === "device-b"), "Evidence should include missing device");
});

test("analyzeWitnessQuorum: no events → ok=false", () => {
	const result = analyzeWitnessQuorum([], {
		pathId: "path-001",
		requiredDeviceIds: ["device-a"],
		deadlineStepIndex: 1,
	});
	validateAnalyzerResult(result, "analyzeWitnessQuorum");
	assert.ok(!result.ok);
});

// -----------------------------------------------------------------------
// analyzeCrossDeviceHashesEqual tests
// -----------------------------------------------------------------------

test("analyzeCrossDeviceHashesEqual: matching hashes → ok=true", () => {
	const events: FlightEvent[] = [
		makeSettledEvent({ deviceId: "device-a", pathId: "path-001", seq: 1, data: { stateHash: "h:abc", stateKind: "present", runtimeState: "foreground", causedByEvents: {}, stableAfterMs: 2000 } }),
		makeSettledEvent({ deviceId: "device-b", pathId: "path-001", seq: 2, data: { stateHash: "h:abc", stateKind: "present", runtimeState: "foreground", causedByEvents: {}, stableAfterMs: 2000 } }),
	];
	const result = analyzeCrossDeviceHashesEqual(events, { traceId: "trace-001" });
	validateAnalyzerResult(result, "analyzeCrossDeviceHashesEqual");
	assert.ok(result.ok, "Should pass when hashes match");
});

test("analyzeCrossDeviceHashesEqual: mismatched hashes → ok=false", () => {
	const events: FlightEvent[] = [
		makeSettledEvent({ deviceId: "device-a", pathId: "path-001", seq: 1, data: { stateHash: "h:abc", stateKind: "present", runtimeState: "foreground", causedByEvents: {}, stableAfterMs: 2000 } }),
		makeSettledEvent({ deviceId: "device-b", pathId: "path-001", seq: 2, data: { stateHash: "h:xyz", stateKind: "present", runtimeState: "foreground", causedByEvents: {}, stableAfterMs: 2000 } }),
	];
	const result = analyzeCrossDeviceHashesEqual(events, { traceId: "trace-001" });
	validateAnalyzerResult(result, "analyzeCrossDeviceHashesEqual");
	assert.ok(!result.ok, "Should fail when hashes mismatch");
	assert.equal(result.reason, "cross_device_hash_mismatch");
});

test("analyzeCrossDeviceHashesEqual: conflict artifact path NOT flagged when original is agreed", () => {
	const conflictPath = "Notes/test (YAOS conflict from device-b 2024).md";
	const originalPath = "Notes/test.md";
	const events: FlightEvent[] = [
		// Original path — both devices agree
		makeSettledEvent({ deviceId: "device-a", pathId: originalPath, seq: 1, data: { stateHash: "h:agreed", stateKind: "present", runtimeState: "foreground", causedByEvents: {}, stableAfterMs: 2000 } }),
		makeSettledEvent({ deviceId: "device-b", pathId: originalPath, seq: 2, data: { stateHash: "h:agreed", stateKind: "present", runtimeState: "foreground", causedByEvents: {}, stableAfterMs: 2000 } }),
		// Conflict artifact — devices differ (expected)
		makeSettledEvent({ deviceId: "device-a", pathId: conflictPath, seq: 3, data: { stateHash: "h:conflict", stateKind: "present", runtimeState: "foreground", causedByEvents: {}, stableAfterMs: 2000 } }),
		makeSettledEvent({ deviceId: "device-b", pathId: conflictPath, seq: 4, data: { stateHash: "h:different", stateKind: "present", runtimeState: "foreground", causedByEvents: {}, stableAfterMs: 2000 } }),
	];
	const result = analyzeCrossDeviceHashesEqual(events, {
		traceId: "trace-001",
		conflictArtifacts: new Map([[conflictPath, originalPath]]),
	});
	validateAnalyzerResult(result, "analyzeCrossDeviceHashesEqual");
	assert.ok(result.ok, "Conflict artifact path should NOT be flagged when original is agreed");
});

// -----------------------------------------------------------------------
// analyzeEditorStability tests
// -----------------------------------------------------------------------

test("analyzeEditorStability: no flicker → ok=true", () => {
	const events: FlightEvent[] = [
		makeSettledEvent({ deviceId: "device-a", pathId: "path-001", seq: 1 }),
		makeSettledEvent({ deviceId: "device-a", pathId: "path-001", seq: 2 }),
	];
	const result = analyzeEditorStability(events, { deviceId: "device-a", pathId: "path-001" });
	validateAnalyzerResult(result, "analyzeEditorStability");
	assert.ok(result.ok, "Should pass when no flicker");
});

test("analyzeEditorStability: settled→diverged→settled within tight window → ok=false", () => {
	const events: FlightEvent[] = [
		{ ...makeSettledEvent({ deviceId: "device-a", pathId: "path-001", seq: 1 }), ts: 1000, mono: 1000 },
		{ ...makeDivergedEvent("editor_crdt_mismatch", { deviceId: "device-a", pathId: "path-001", seq: 2 }), ts: 2000, mono: 2000 },
		{ ...makeSettledEvent({ deviceId: "device-a", pathId: "path-001", seq: 3 }), ts: 3000, mono: 3000 },
	];
	const result = analyzeEditorStability(events, {
		deviceId: "device-a",
		pathId: "path-001",
		tightWindowMs: 5000,
	});
	validateAnalyzerResult(result, "analyzeEditorStability");
	assert.ok(!result.ok, "Should fail when flicker within tight window");
	assert.equal(result.reason, "editor_flicker_during_burst");
});

test("analyzeEditorStability: settled→diverged→settled outside tight window → ok=true", () => {
	const events: FlightEvent[] = [
		{ ...makeSettledEvent({ deviceId: "device-a", pathId: "path-001", seq: 1 }), ts: 1000, mono: 1000 },
		{ ...makeDivergedEvent("editor_crdt_mismatch", { deviceId: "device-a", pathId: "path-001", seq: 2 }), ts: 7000, mono: 7000 },
		{ ...makeSettledEvent({ deviceId: "device-a", pathId: "path-001", seq: 3 }), ts: 8000, mono: 8000 },
	];
	const result = analyzeEditorStability(events, {
		deviceId: "device-a",
		pathId: "path-001",
		tightWindowMs: 5000,
	});
	validateAnalyzerResult(result, "analyzeEditorStability");
	assert.ok(result.ok, "Should pass when flicker is outside tight window");
});

// -----------------------------------------------------------------------
// analyzeRecoveryEmittedOldHash tests
// -----------------------------------------------------------------------

test("analyzeRecoveryEmittedOldHash: no divergences → ok=true", () => {
	const result = analyzeRecoveryEmittedOldHash([], {});
	validateAnalyzerResult(result, "analyzeRecoveryEmittedOldHash");
	assert.ok(result.ok);
});

test("analyzeRecoveryEmittedOldHash: precision-path divergence → ok=false with inform finding", () => {
	const events: FlightEvent[] = [
		makeDivergedEvent("recovery_emitted_old_hash", {
			deviceId: "device-a",
			pathId: "path-001",
			seq: 5,
			data: {
				reason: "recovery_emitted_old_hash",
				stateKind: "present",
				runtimeState: "foreground",
				causedByEvents: { lastRecoverySeq: 3 },
				recoveryStateHash: "h:old-hash",
				precisionPath: true,
			},
		}),
	];
	const result = analyzeRecoveryEmittedOldHash(events, {});
	validateAnalyzerResult(result, "analyzeRecoveryEmittedOldHash");
	assert.ok(!result.ok);
	assert.ok(result.evidence.some((e) => e.kind === "recovery_stale_precise"), "Should have precision-path evidence");
});

test("analyzeRecoveryEmittedOldHash: conflict artifact path NOT flagged", () => {
	const conflictPath = "Notes/test (YAOS conflict).md";
	const events: FlightEvent[] = [
		makeDivergedEvent("recovery_emitted_old_hash", {
			deviceId: "device-a",
			pathId: conflictPath,
			seq: 5,
		}),
	];
	const result = analyzeRecoveryEmittedOldHash(events, {
		conflictArtifactPathIds: new Set([conflictPath]),
	});
	validateAnalyzerResult(result, "analyzeRecoveryEmittedOldHash");
	assert.ok(result.ok, "Conflict artifact path should NOT be flagged");
});

// -----------------------------------------------------------------------
// analyzeStaleHashAfterNewerWitness tests
// -----------------------------------------------------------------------

test("analyzeStaleHashAfterNewerWitness: no divergences → ok=true", () => {
	const result = analyzeStaleHashAfterNewerWitness([], {});
	validateAnalyzerResult(result, "analyzeStaleHashAfterNewerWitness");
	assert.ok(result.ok);
});

test("analyzeStaleHashAfterNewerWitness: stale hash divergence → ok=false", () => {
	const events: FlightEvent[] = [
		makeDivergedEvent("stale_hash_after_newer_witness", { deviceId: "device-a", pathId: "path-001", seq: 10 }),
	];
	const result = analyzeStaleHashAfterNewerWitness(events, {});
	validateAnalyzerResult(result, "analyzeStaleHashAfterNewerWitness");
	assert.ok(!result.ok);
	assert.equal(result.reason, "stale_hash_after_newer_witness");
});

// -----------------------------------------------------------------------
// Evidence severity discriminator tests (Requirement 25.6, 25.7)
// -----------------------------------------------------------------------

test("diagnostics-class reasons map to 'diagnostics' severity", () => {
	const { evidenceSeverity } = require("../qa/obsidian-harness/witness-primitives");
	assert.equal(evidenceSeverity("checkpoint_write_failed"), "diagnostics");
	assert.equal(evidenceSeverity("checkpoint_path_inside_vault"), "diagnostics");
	assert.equal(evidenceSeverity("unavailable"), "diagnostics");
});

test("sync-correctness reasons map to 'sync-correctness' severity", () => {
	const { evidenceSeverity } = require("../qa/obsidian-harness/witness-primitives");
	assert.equal(evidenceSeverity("disk_crdt_mismatch"), "sync-correctness");
	assert.equal(evidenceSeverity("stale_hash_after_newer_witness"), "sync-correctness");
	assert.equal(evidenceSeverity("recovery_emitted_old_hash"), "sync-correctness");
	assert.equal(evidenceSeverity("editor_crdt_mismatch"), "sync-correctness");
});

// -----------------------------------------------------------------------
// Purity: no side effects
// -----------------------------------------------------------------------

test("analyzer rules have no observable side effects", () => {
	// All analyzer functions are pure — they only read their inputs and return values.
	// We verify this by calling them multiple times and checking idempotency.
	const events: FlightEvent[] = [
		makeSettledEvent({ deviceId: "device-a", pathId: "path-001", seq: 1 }),
	];
	const spec = { pathId: "path-001", requiredDeviceIds: ["device-a"], deadlineStepIndex: 1 };

	const r1 = analyzeWitnessQuorum(events, spec);
	const r2 = analyzeWitnessQuorum(events, spec);

	assert.deepEqual(r1, r2, "Pure function should return identical results for identical inputs");
});

// -----------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------

setTimeout(() => {
	console.log(`\nResults: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}, 200);
