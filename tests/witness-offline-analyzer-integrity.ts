/**
 * Verification Gate 8 — Offline analyzer integrity (Phase 3 Requirements 11, 13)
 *
 * Tests bundle integrity check and analyzeConvergenceEvidence correctness.
 * Uses pathId (not raw path) — safe-bundle compatible.
 * Verifies fail-closed on missing scenarioStepIndex.
 */

import assert from "node:assert/strict";
import { analyzeConvergenceEvidence } from "../qa/analyzers/rules/convergence-evidence";

let passed = 0;
let failed = 0;
const tests: Array<[string, () => Promise<void>]> = [];
function test(name: string, fn: () => Promise<void>): void { tests.push([name, fn]); }

// -----------------------------------------------------------------------
// Bundle integrity check (inline — mirrors analyze-bundles.ts logic)
// -----------------------------------------------------------------------

interface BundleHeader {
	bundleSchemaVersion: number;
	qaTraceSecretHash: string;
	scenarioRunId: string | null;
	scenarioId: string | null;
	localTraceId: string;
	deviceId: string;
}

type RejectionReason = "bundle_secret_hash_mismatch" | "bundle_scenario_run_id_mismatch" | "bundle_scenario_id_mismatch" | "bundle_schema_version_unsupported";

function checkIntegrity(headers: BundleHeader[]): { ok: boolean; reason?: RejectionReason } {
	for (const h of headers) {
		if (h.bundleSchemaVersion !== 1) return { ok: false, reason: "bundle_schema_version_unsupported" };
	}
	if (new Set(headers.map((h) => h.qaTraceSecretHash)).size > 1) return { ok: false, reason: "bundle_secret_hash_mismatch" };
	if (new Set(headers.map((h) => h.scenarioRunId ?? "")).size > 1) return { ok: false, reason: "bundle_scenario_run_id_mismatch" };
	if (new Set(headers.map((h) => h.scenarioId ?? "")).size > 1) return { ok: false, reason: "bundle_scenario_id_mismatch" };
	return { ok: true };
}

function makeHeader(overrides: Partial<BundleHeader> = {}): BundleHeader {
	return {
		bundleSchemaVersion: 1,
		qaTraceSecretHash: "sha256:aaaa1234567890abcdef1234567890abcdef1234567890abcdef1234567890aa",
		scenarioRunId: "run-s12a-001",
		scenarioId: "s12a-three-device-passive-quorum",
		localTraceId: "trace-device-a",
		deviceId: "device-a",
		...overrides,
	};
}

// -----------------------------------------------------------------------
// Bundle integrity tests
// -----------------------------------------------------------------------

test("three matching bundles pass integrity check", async () => {
	const result = checkIntegrity([
		makeHeader({ deviceId: "device-a", localTraceId: "trace-a" }),
		makeHeader({ deviceId: "device-b", localTraceId: "trace-b" }),
		makeHeader({ deviceId: "device-c", localTraceId: "trace-c" }),
	]);
	assert.equal(result.ok, true);
});

test("per-device localTraceId mismatch is allowed", async () => {
	const result = checkIntegrity([
		makeHeader({ deviceId: "device-a", localTraceId: "trace-aaa-111" }),
		makeHeader({ deviceId: "device-b", localTraceId: "trace-bbb-222" }),
	]);
	assert.equal(result.ok, true, "localTraceId mismatch must not trigger rejection");
});

test("mismatched qaTraceSecretHash rejects with bundle_secret_hash_mismatch", async () => {
	const result = checkIntegrity([
		makeHeader({ deviceId: "device-a" }),
		makeHeader({ deviceId: "device-b", qaTraceSecretHash: "sha256:bbbb1234567890abcdef1234567890abcdef1234567890abcdef1234567890bb" }),
	]);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "bundle_secret_hash_mismatch");
});

test("mismatched scenarioRunId rejects with bundle_scenario_run_id_mismatch", async () => {
	const result = checkIntegrity([
		makeHeader({ scenarioRunId: "run-001" }),
		makeHeader({ scenarioRunId: "run-002" }),
	]);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "bundle_scenario_run_id_mismatch");
});

test("mismatched scenarioId rejects with bundle_scenario_id_mismatch", async () => {
	const result = checkIntegrity([
		makeHeader({ scenarioId: "s12a" }),
		makeHeader({ scenarioId: "s12b" }),
	]);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "bundle_scenario_id_mismatch");
});

test("unsupported bundleSchemaVersion rejects", async () => {
	const result = checkIntegrity([makeHeader({ bundleSchemaVersion: 2 })]);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "bundle_schema_version_unsupported");
});

// -----------------------------------------------------------------------
// analyzeConvergenceEvidence tests — pathId-based, fail-closed on missing step
// -----------------------------------------------------------------------

const HASH = "h:abcdef1234567890abcdef1234567890";
const SPEC_BASE = {
	producingDeviceId: "device-a",
	pathId: "pid-test-001",
	expectedStateHash: HASH,
	producingStepIndex: 2,
	allDeviceIds: ["device-a", "device-b", "device-c"],
};

test("analyzeConvergenceEvidence produces positive proof on three matched bundles", async () => {
	const events = [
		{ kind: "device.witness.settled", pathId: "pid-test-001", seq: 1, deviceId: "device-a", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 2 } },
		{ kind: "device.witness.settled", pathId: "pid-test-001", seq: 2, deviceId: "device-b", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 3 } },
		{ kind: "device.witness.settled", pathId: "pid-test-001", seq: 3, deviceId: "device-c", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 4 } },
	];
	const result = analyzeConvergenceEvidence(events, SPEC_BASE);
	assert.equal(result.ok, true, result.summary);
	assert.ok(result.summary.includes("device-a"));
	assert.ok(result.summary.includes("device-b"));
	assert.ok(result.summary.includes("device-c"));
	assert.ok(result.summary.includes("No stale rewinds"));
});

test("analyzeConvergenceEvidence fails when a device did not settle", async () => {
	const events = [
		{ kind: "device.witness.settled", pathId: "pid-test-001", seq: 1, deviceId: "device-a", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 2 } },
		{ kind: "device.witness.settled", pathId: "pid-test-001", seq: 2, deviceId: "device-b", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 3 } },
	];
	const result = analyzeConvergenceEvidence(events, SPEC_BASE);
	assert.equal(result.ok, false);
	assert.ok(result.summary.includes("device-c"));
});

test("analyzeConvergenceEvidence fails on sync-correctness divergence", async () => {
	const events = [
		{ kind: "device.witness.settled", pathId: "pid-test-001", seq: 1, deviceId: "device-a", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 2 } },
		{ kind: "device.witness.diverged", pathId: "pid-test-001", seq: 2, deviceId: "device-b", data: { reason: "stale_hash_after_newer_witness", scenarioStepIndex: 3 } },
	];
	const result = analyzeConvergenceEvidence(events, { ...SPEC_BASE, allDeviceIds: ["device-a", "device-b"] });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "stale_hash_after_newer_witness");
});

test("analyzeConvergenceEvidence ignores diagnostics-class divergences", async () => {
	const events = [
		{ kind: "device.witness.settled", pathId: "pid-test-001", seq: 1, deviceId: "device-a", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 2 } },
		{ kind: "device.witness.diverged", pathId: "pid-test-001", seq: 2, deviceId: "device-b", data: { reason: "unavailable", scenarioStepIndex: 2 } },
		{ kind: "device.witness.settled", pathId: "pid-test-001", seq: 3, deviceId: "device-b", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 3 } },
	];
	const result = analyzeConvergenceEvidence(events, { ...SPEC_BASE, allDeviceIds: ["device-a", "device-b"] });
	assert.equal(result.ok, true, result.summary);
});

test("analyzeConvergenceEvidence fails closed on missing scenarioStepIndex", async () => {
	const events = [
		{ kind: "device.witness.settled", pathId: "pid-test-001", seq: 1, deviceId: "device-a", data: { stateHash: HASH, stateKind: "present" } },
		{ kind: "device.witness.settled", pathId: "pid-test-001", seq: 2, deviceId: "device-b", data: { stateHash: HASH, stateKind: "present" } },
	];
	const result = analyzeConvergenceEvidence(events, { ...SPEC_BASE, allDeviceIds: ["device-a", "device-b"] });
	// Unstepped events are skipped → no convergence found
	assert.equal(result.ok, false);
	assert.ok(
		result.reason === "missing_scenario_step_index" || result.reason === "convergence_incomplete",
		`Expected missing_scenario_step_index or convergence_incomplete, got: ${result.reason}`,
	);
});

test("analyzeConvergenceEvidence matches by pathId not raw path", async () => {
	const events = [
		// Wrong pathId — should not match
		{ kind: "device.witness.settled", pathId: "pid-wrong", seq: 1, deviceId: "device-a", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 2 } },
		// Correct pathId
		{ kind: "device.witness.settled", pathId: "pid-test-001", seq: 2, deviceId: "device-a", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 2 } },
	];
	const result = analyzeConvergenceEvidence(events, { ...SPEC_BASE, allDeviceIds: ["device-a"] });
	assert.equal(result.ok, true, result.summary);
});

// -----------------------------------------------------------------------
// Runner
// -----------------------------------------------------------------------

for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
		passed++;
	} catch (e) {
		console.error(`  ✗ ${name}`);
		console.error(`    ${e instanceof Error ? e.message : String(e)}`);
		failed++;
	}
}

console.log(`\nGate 8 (offline analyzer integrity): ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
