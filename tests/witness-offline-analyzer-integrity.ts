/**
 * Verification Gate 8 — Offline analyzer integrity (Phase 3 Requirements 11, 13)
 *
 * Tests that:
 *   - Three matching bundles pass integrity check
 *   - Mismatched qaTraceSecretHash rejects with bundle_secret_hash_mismatch
 *   - Mismatched scenarioRunId rejects with bundle_scenario_run_id_mismatch
 *   - Mismatched scenarioId rejects with bundle_scenario_id_mismatch
 *   - Per-device localTraceId mismatch is allowed
 *   - analyzeConvergenceEvidence produces positive proof artifact
 */

import assert from "node:assert/strict";
import { analyzeConvergenceEvidence } from "../qa/analyzers/rules/convergence-evidence";

let passed = 0;
let failed = 0;
const tests: Array<[string, () => Promise<void>]> = [];

function test(name: string, fn: () => Promise<void>): void {
	tests.push([name, fn]);
}

// -----------------------------------------------------------------------
// Inline bundle integrity check (mirrors analyze-bundles.ts logic)
// -----------------------------------------------------------------------

interface BundleHeader {
	bundleSchemaVersion: number;
	qaTraceSecretHash: string;
	scenarioRunId: string | null;
	scenarioId: string | null;
	localTraceId: string;
	deviceId: string;
}

type RejectionReason =
	| "bundle_secret_hash_mismatch"
	| "bundle_scenario_run_id_mismatch"
	| "bundle_scenario_id_mismatch"
	| "bundle_schema_version_unsupported";

function checkIntegrity(headers: BundleHeader[]): { ok: boolean; reason?: RejectionReason } {
	for (const h of headers) {
		if (h.bundleSchemaVersion !== 1) return { ok: false, reason: "bundle_schema_version_unsupported" };
	}
	const secretHashes = new Set(headers.map((h) => h.qaTraceSecretHash));
	if (secretHashes.size > 1) return { ok: false, reason: "bundle_secret_hash_mismatch" };
	const runIds = new Set(headers.map((h) => h.scenarioRunId ?? ""));
	if (runIds.size > 1) return { ok: false, reason: "bundle_scenario_run_id_mismatch" };
	const scenarioIds = new Set(headers.map((h) => h.scenarioId ?? ""));
	if (scenarioIds.size > 1) return { ok: false, reason: "bundle_scenario_id_mismatch" };
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
// Tests
// -----------------------------------------------------------------------

test("three matching bundles pass integrity check", async () => {
	const headers = [
		makeHeader({ deviceId: "device-a", localTraceId: "trace-a" }),
		makeHeader({ deviceId: "device-b", localTraceId: "trace-b" }),
		makeHeader({ deviceId: "device-c", localTraceId: "trace-c" }),
	];
	const result = checkIntegrity(headers);
	assert.equal(result.ok, true);
	assert.equal(result.reason, undefined);
});

test("per-device localTraceId mismatch is allowed", async () => {
	const headers = [
		makeHeader({ deviceId: "device-a", localTraceId: "trace-aaa-111" }),
		makeHeader({ deviceId: "device-b", localTraceId: "trace-bbb-222" }),
		makeHeader({ deviceId: "device-c", localTraceId: "trace-ccc-333" }),
	];
	const result = checkIntegrity(headers);
	assert.equal(result.ok, true, "localTraceId mismatch must not trigger rejection");
});

test("mismatched qaTraceSecretHash rejects with bundle_secret_hash_mismatch", async () => {
	const headers = [
		makeHeader({ deviceId: "device-a" }),
		makeHeader({ deviceId: "device-b", qaTraceSecretHash: "sha256:bbbb1234567890abcdef1234567890abcdef1234567890abcdef1234567890bb" }),
	];
	const result = checkIntegrity(headers);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "bundle_secret_hash_mismatch");
});

test("mismatched scenarioRunId rejects with bundle_scenario_run_id_mismatch", async () => {
	const headers = [
		makeHeader({ deviceId: "device-a", scenarioRunId: "run-001" }),
		makeHeader({ deviceId: "device-b", scenarioRunId: "run-002" }),
	];
	const result = checkIntegrity(headers);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "bundle_scenario_run_id_mismatch");
});

test("mismatched scenarioId rejects with bundle_scenario_id_mismatch", async () => {
	const headers = [
		makeHeader({ deviceId: "device-a", scenarioId: "s12a" }),
		makeHeader({ deviceId: "device-b", scenarioId: "s12b" }),
	];
	const result = checkIntegrity(headers);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "bundle_scenario_id_mismatch");
});

test("unsupported bundleSchemaVersion rejects", async () => {
	const headers = [
		makeHeader({ deviceId: "device-a", bundleSchemaVersion: 2 }),
	];
	const result = checkIntegrity(headers);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "bundle_schema_version_unsupported");
});

test("analyzeConvergenceEvidence produces positive proof on three matched bundles", async () => {
	const HASH = "h:abcdef1234567890abcdef1234567890";
	const events = [
		{ kind: "device.witness.settled", path: "Notes/test.md", seq: 1, deviceId: "device-a", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 2 } },
		{ kind: "device.witness.settled", path: "Notes/test.md", seq: 2, deviceId: "device-b", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 3 } },
		{ kind: "device.witness.settled", path: "Notes/test.md", seq: 3, deviceId: "device-c", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 4 } },
	];

	const result = analyzeConvergenceEvidence(events, {
		producingDeviceId: "device-a",
		path: "Notes/test.md",
		expectedStateHash: HASH,
		producingStepIndex: 2,
		allDeviceIds: ["device-a", "device-b", "device-c"],
	});

	assert.equal(result.ok, true, `Expected ok: true, got: ${result.summary}`);
	assert.ok(result.summary.includes("device-a"), "Summary must mention producing device");
	assert.ok(result.summary.includes("device-b"), "Summary must mention device-b");
	assert.ok(result.summary.includes("device-c"), "Summary must mention device-c");
	assert.ok(result.summary.includes("No stale rewinds"), "Summary must include no-stale-rewinds statement");
	assert.ok(result.evidence.length >= 3, "Must have evidence for all three devices");
});

test("analyzeConvergenceEvidence fails when a device did not settle", async () => {
	const HASH = "h:abcdef1234567890abcdef1234567890";
	const events = [
		{ kind: "device.witness.settled", path: "Notes/test.md", seq: 1, deviceId: "device-a", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 2 } },
		{ kind: "device.witness.settled", path: "Notes/test.md", seq: 2, deviceId: "device-b", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 3 } },
		// device-c never settled
	];

	const result = analyzeConvergenceEvidence(events, {
		producingDeviceId: "device-a",
		path: "Notes/test.md",
		expectedStateHash: HASH,
		producingStepIndex: 2,
		allDeviceIds: ["device-a", "device-b", "device-c"],
	});

	assert.equal(result.ok, false);
	assert.ok(result.summary.includes("device-c"), "Summary must identify unsettled device");
});

test("analyzeConvergenceEvidence fails on sync-correctness divergence", async () => {
	const HASH = "h:abcdef1234567890abcdef1234567890";
	const events = [
		{ kind: "device.witness.settled", path: "Notes/test.md", seq: 1, deviceId: "device-a", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 2 } },
		{ kind: "device.witness.diverged", path: "Notes/test.md", seq: 2, deviceId: "device-b", data: { reason: "stale_hash_after_newer_witness", scenarioStepIndex: 3 } },
	];

	const result = analyzeConvergenceEvidence(events, {
		producingDeviceId: "device-a",
		path: "Notes/test.md",
		expectedStateHash: HASH,
		producingStepIndex: 2,
		allDeviceIds: ["device-a", "device-b"],
	});

	assert.equal(result.ok, false);
	assert.equal(result.reason, "stale_hash_after_newer_witness");
});

test("analyzeConvergenceEvidence ignores diagnostics-class divergences", async () => {
	const HASH = "h:abcdef1234567890abcdef1234567890";
	const events = [
		{ kind: "device.witness.settled", path: "Notes/test.md", seq: 1, deviceId: "device-a", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 2 } },
		// diagnostics-class divergence — must not block positive result
		{ kind: "device.witness.diverged", path: "Notes/test.md", seq: 2, deviceId: "device-b", data: { reason: "unavailable", scenarioStepIndex: 2 } },
		{ kind: "device.witness.settled", path: "Notes/test.md", seq: 3, deviceId: "device-b", data: { stateHash: HASH, stateKind: "present", scenarioStepIndex: 3 } },
	];

	const result = analyzeConvergenceEvidence(events, {
		producingDeviceId: "device-a",
		path: "Notes/test.md",
		expectedStateHash: HASH,
		producingStepIndex: 2,
		allDeviceIds: ["device-a", "device-b"],
	});

	assert.equal(result.ok, true, `Expected ok: true, got: ${result.summary}`);
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
