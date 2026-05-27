/**
 * Verification Gate — scenarioStepIndex and scenarioRunId (Phase 3 Requirements 10, 14)
 *
 * Tests that:
 *   - setScenarioRunId stamps scenarioRunId/scenarioId on emitted events
 *   - advanceScenarioStep stamps scenarioStepIndex on emitted events
 *   - Backwards step index is rejected
 *   - advanceScenarioStep without scenarioRunId is rejected
 *   - scenarioStepIndex is strictly increasing per device
 */

import assert from "node:assert/strict";
import { DeviceWitnessTracker } from "../src/diagnostics/deviceWitnessTracker";
import type { WitnessTrackerConfig } from "../src/diagnostics/deviceWitnessTracker";

let passed = 0;
let failed = 0;
const tests: Array<[string, () => Promise<void>]> = [];

function test(name: string, fn: () => Promise<void>): void {
	tests.push([name, fn]);
}

function makeConfig(overrides: Partial<WitnessTrackerConfig> = {}): WitnessTrackerConfig {
	return {
		stateSecret: "test-secret",
		flightMode: "qa-safe",
		qaTraceSecret: "qa-secret",
		platform: "desktop",
		sink: { record: () => {}, recordPath: async () => {} },
		traceContext: {
			traceId: "trace-step-test",
			bootId: "boot-001",
			deviceId: "device-step-001",
			vaultIdHash: "vault-hash",
			serverHostHash: "server-hash",
			pluginVersion: "1.6.1",
		},
		readCrdtContent: () => "step test content",
		isCrdtTombstoned: () => false,
		getFileId: () => "file-step-001",
		readDiskContent: async () => "step test content",
		sampleEditor: () => ({ kind: "not_open", content: null }),
		stableAfterMs: 50,
		...overrides,
	};
}

const WAIT_FOR_EVENT_MS = 150;

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

test("setScenarioRunId stamps scenarioRunId and scenarioId on emitted events", async () => {
	const emittedData: Record<string, unknown>[] = [];
	const tracker = new DeviceWitnessTracker(makeConfig({
		sink: {
			record: () => {},
			recordPath: async (e) => {
				if (e.data) emittedData.push(e.data as Record<string, unknown>);
			},
		},
	}));

	tracker.setScenarioRunId("run-001", "s12a");
	tracker.markDirty("Notes/test.md", "local-edit");
	await new Promise((r) => setTimeout(r, WAIT_FOR_EVENT_MS));

	assert.ok(emittedData.length > 0, "Should have emitted events");
	const settled = emittedData.find((d) => d.stateHash !== undefined);
	assert.ok(settled, "Should have a settled event");
	assert.equal(settled!.scenarioRunId, "run-001");
	assert.equal(settled!.scenarioId, "s12a");
	tracker.dispose();
});

test("advanceScenarioStep stamps scenarioStepIndex on emitted events", async () => {
	const emittedData: Record<string, unknown>[] = [];
	const tracker = new DeviceWitnessTracker(makeConfig({
		sink: {
			record: () => {},
			recordPath: async (e) => {
				if (e.data) emittedData.push(e.data as Record<string, unknown>);
			},
		},
	}));

	tracker.setScenarioRunId("run-002", "s12a");
	const ok = tracker.advanceScenarioStep(1, "baseline");
	assert.equal(ok, true, "advanceScenarioStep should succeed");

	tracker.markDirty("Notes/test.md", "local-edit");
	await new Promise((r) => setTimeout(r, WAIT_FOR_EVENT_MS));

	const settled = emittedData.find((d) => d.stateHash !== undefined);
	assert.ok(settled, "Should have a settled event");
	assert.equal(settled!.scenarioStepIndex, 1);
	assert.equal(settled!.scenarioStepLabel, "baseline");
	tracker.dispose();
});

test("advanceScenarioStep without scenarioRunId returns false", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig());
	// No setScenarioRunId called
	const ok = tracker.advanceScenarioStep(1);
	assert.equal(ok, false, "Should reject when no scenarioRunId set");
	tracker.dispose();
});

test("backwards step index is rejected", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig());
	tracker.setScenarioRunId("run-003", "s12a");

	const ok1 = tracker.advanceScenarioStep(5);
	assert.equal(ok1, true);

	const ok2 = tracker.advanceScenarioStep(3); // backwards
	assert.equal(ok2, false, "Backwards step must be rejected");

	const ok3 = tracker.advanceScenarioStep(5); // same value
	assert.equal(ok3, false, "Same step index must be rejected");

	const ok4 = tracker.advanceScenarioStep(6); // forward
	assert.equal(ok4, true, "Forward step must be accepted");
	tracker.dispose();
});

test("getScenarioStepState returns current state", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig());
	tracker.setScenarioRunId("run-004", "s12b");
	tracker.advanceScenarioStep(2, "setup");

	const state = tracker.getScenarioStepState();
	assert.equal(state.scenarioRunId, "run-004");
	assert.equal(state.scenarioId, "s12b");
	assert.equal(state.stepIndex, 2);
	assert.equal(state.stepLabel, "setup");
	tracker.dispose();
});

test("scenarioStepIndex is strictly increasing per device", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig());
	tracker.setScenarioRunId("run-005", "s12c");

	const steps = [1, 2, 3, 5, 10];
	for (const s of steps) {
		const ok = tracker.advanceScenarioStep(s);
		assert.equal(ok, true, `Step ${s} should be accepted`);
	}

	// Verify final state
	const state = tracker.getScenarioStepState();
	assert.equal(state.stepIndex, 10);
	tracker.dispose();
});

test("non-integer step index is rejected", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig());
	tracker.setScenarioRunId("run-006", "s12a");

	assert.equal(tracker.advanceScenarioStep(1.5), false, "Float must be rejected");
	assert.equal(tracker.advanceScenarioStep(-1), false, "Negative must be rejected");
	tracker.dispose();
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

console.log(`\nScenario step index: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
