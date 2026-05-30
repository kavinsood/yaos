/**
 * Verification Gate — scenarioStepIndex and scenarioRunId (Phase 3 Requirements 10, 14)
 *
 * Tests that:
 *   - ScenarioStateController.setScenarioRunId stamps scenarioRunId/scenarioId on emitted events
 *   - ScenarioStateController.advanceScenarioStep stamps scenarioStepIndex on emitted events
 *   - Backwards step index is rejected
 *   - advanceScenarioStep without scenarioRunId is rejected
 *   - scenarioStepIndex is strictly increasing per device
 *
 * Architecture note:
 *   Scenario state mutation was moved OUT of DeviceWitnessTracker (Observer)
 *   into ScenarioStateController (Puppeteer). The tracker reads scenario
 *   context passively via getScenarioContext() config callback.
 */

import assert from "node:assert/strict";
import { DeviceWitnessTracker } from "../src/telemetry/diagnostics/deviceWitnessTracker";
import type { WitnessTrackerConfig } from "../src/telemetry/diagnostics/deviceWitnessTracker";
import { ScenarioStateController } from "../qa/harness/scenarioStateController";

let passed = 0;
let failed = 0;
const tests: Array<[string, () => Promise<void>]> = [];

function test(name: string, fn: () => Promise<void>): void {
	tests.push([name, fn]);
}

function makeConfig(
	scenario: ScenarioStateController,
	overrides: Partial<WitnessTrackerConfig> = {},
): WitnessTrackerConfig {
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
		// Inject the Puppeteer-owned scenario controller into the Observer tracker
		getScenarioContext: () => scenario,
		...overrides,
	};
}

const WAIT_FOR_EVENT_MS = 150;

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

test("setScenarioRunId stamps scenarioRunId and scenarioId on emitted events", async () => {
	const emittedData: Record<string, unknown>[] = [];
	const scenario = new ScenarioStateController();
	const tracker = new DeviceWitnessTracker({
		...makeConfig(scenario),
		sink: {
			record: () => {},
			recordPath: async (e) => {
				if (e.data) emittedData.push(e.data as Record<string, unknown>);
			},
		},
	});

	// Puppeteer sets scenario state via controller (not via tracker)
	scenario.setScenarioRunId("run-001", "s12a");
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
	const scenario = new ScenarioStateController();
	const tracker = new DeviceWitnessTracker({
		...makeConfig(scenario),
		sink: {
			record: () => {},
			recordPath: async (e) => {
				if (e.data) emittedData.push(e.data as Record<string, unknown>);
			},
		},
	});

	scenario.setScenarioRunId("run-002", "s12a");
	const ok = scenario.advanceScenarioStep(1, "baseline");
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
	const scenario = new ScenarioStateController();
	// No setScenarioRunId called
	const ok = scenario.advanceScenarioStep(1);
	assert.equal(ok, false, "Should reject when no scenarioRunId set");
});

test("backwards step index is rejected", async () => {
	const scenario = new ScenarioStateController();
	scenario.setScenarioRunId("run-003", "s12a");

	const ok1 = scenario.advanceScenarioStep(5);
	assert.equal(ok1, true);

	const ok2 = scenario.advanceScenarioStep(3); // backwards
	assert.equal(ok2, false, "Backwards step must be rejected");

	const ok3 = scenario.advanceScenarioStep(5); // same value
	assert.equal(ok3, false, "Same step index must be rejected");

	const ok4 = scenario.advanceScenarioStep(6); // forward
	assert.equal(ok4, true, "Forward step must be accepted");
});

test("getScenarioStepState returns current state", async () => {
	const scenario = new ScenarioStateController();
	scenario.setScenarioRunId("run-004", "s12b");
	scenario.advanceScenarioStep(2, "setup");

	const state = scenario.getScenarioStepState();
	assert.equal(state.scenarioRunId, "run-004");
	assert.equal(state.scenarioId, "s12b");
	assert.equal(state.stepIndex, 2);
	assert.equal(state.stepLabel, "setup");
});

test("scenarioStepIndex is strictly increasing per device", async () => {
	const scenario = new ScenarioStateController();
	scenario.setScenarioRunId("run-005", "s12c");

	const steps = [1, 2, 3, 5, 10];
	for (const s of steps) {
		const ok = scenario.advanceScenarioStep(s);
		assert.equal(ok, true, `Step ${s} should be accepted`);
	}

	// Verify final state
	const state = scenario.getScenarioStepState();
	assert.equal(state.stepIndex, 10);
});

test("non-integer step index is rejected", async () => {
	const scenario = new ScenarioStateController();
	scenario.setScenarioRunId("run-006", "s12a");

	assert.equal(scenario.advanceScenarioStep(1.5), false, "Float must be rejected");
	assert.equal(scenario.advanceScenarioStep(-1), false, "Negative must be rejected");
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
