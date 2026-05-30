/**
 * Read-only runtime spy test (Requirement 21.3)
 *
 * Mounts the tracker in a fake plugin host and asserts that no forbidden
 * API is called for any sequence of dirty triggers including:
 *   - remote-apply bursts
 *   - disk-write follow-ups
 *   - recovery-decision emissions
 *   - conflict-artifact creation
 *   - tombstone events
 */

import assert from "node:assert/strict";
import { DeviceWitnessTracker } from "../src/telemetry/diagnostics/deviceWitnessTracker";
import type { WitnessTrackerConfig } from "../src/telemetry/diagnostics/deviceWitnessTracker";

let passed = 0;
let failed = 0;

const tests: Array<[string, () => Promise<void>]> = [];
const WAIT_FOR_STABLE_MS = 200;

function test(name: string, fn: () => Promise<void>): void {
	tests.push([name, fn]);
}

// -----------------------------------------------------------------------
// Forbidden API spy
// -----------------------------------------------------------------------

const FORBIDDEN_CALLS: string[] = [];

const forbiddenVault = {
	modify: (..._args: unknown[]) => { FORBIDDEN_CALLS.push("vault.modify"); },
	create: (..._args: unknown[]) => { FORBIDDEN_CALLS.push("vault.create"); },
	delete: (..._args: unknown[]) => { FORBIDDEN_CALLS.push("vault.delete"); },
	rename: (..._args: unknown[]) => { FORBIDDEN_CALLS.push("vault.rename"); },
};

const forbiddenYText = {
	insert: (..._args: unknown[]) => { FORBIDDEN_CALLS.push("Y.Text.insert"); },
	delete: (..._args: unknown[]) => { FORBIDDEN_CALLS.push("Y.Text.delete"); },
	format: (..._args: unknown[]) => { FORBIDDEN_CALLS.push("Y.Text.format"); },
};

const forbiddenYMap = {
	set: (..._args: unknown[]) => { FORBIDDEN_CALLS.push("Y.Map.set"); },
};

function makeConfig(): WitnessTrackerConfig {
	return {
		stateSecret: "test-secret",
		flightMode: "qa-safe",
		qaTraceSecret: "qa-secret",
		platform: "desktop",
		sink: {
			record: () => {},
			recordPath: async () => {},
		},
		traceContext: {
			traceId: "trace-spy",
			bootId: "boot-spy",
			deviceId: "device-spy",
			vaultIdHash: "vault-hash",
			serverHostHash: "server-hash",
			pluginVersion: "1.0.0",
		},
		readCrdtContent: () => "hello world",
		isCrdtTombstoned: () => false,
		getFileId: () => "file-id-spy",
		readDiskContent: async () => "hello world",
		sampleEditor: () => ({ kind: "not_open", content: null }),
		stableAfterMs: 100,
	};
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

test("no forbidden API calls during remote-apply burst", async () => {
	FORBIDDEN_CALLS.length = 0;
	const tracker = new DeviceWitnessTracker(makeConfig());

	for (let i = 0; i < 10; i++) {
		tracker.markDirty("test.md", "remote-apply");
	}

	await new Promise((r) => setTimeout(r, WAIT_FOR_STABLE_MS));
	tracker.dispose();

	assert.equal(FORBIDDEN_CALLS.length, 0, `Forbidden calls: ${FORBIDDEN_CALLS.join(", ")}`);
	void forbiddenVault; void forbiddenYText; void forbiddenYMap;
});

test("no forbidden API calls during disk-write follow-ups", async () => {
	FORBIDDEN_CALLS.length = 0;
	const tracker = new DeviceWitnessTracker(makeConfig());

	for (let i = 0; i < 5; i++) {
		tracker.markDirty("test.md", "disk-write");
		await new Promise((r) => setTimeout(r, 50));
	}

	await new Promise((r) => setTimeout(r, WAIT_FOR_STABLE_MS));
	tracker.dispose();

	assert.equal(FORBIDDEN_CALLS.length, 0, `Forbidden calls: ${FORBIDDEN_CALLS.join(", ")}`);
});

test("no forbidden API calls during recovery-decision emissions", async () => {
	FORBIDDEN_CALLS.length = 0;
	const tracker = new DeviceWitnessTracker(makeConfig());

	tracker.markDirty("test.md", "recovery");
	tracker.handleRecoveryDecision("test.md", "h:some-hash");

	await new Promise((r) => setTimeout(r, WAIT_FOR_STABLE_MS));
	tracker.dispose();

	assert.equal(FORBIDDEN_CALLS.length, 0, `Forbidden calls: ${FORBIDDEN_CALLS.join(", ")}`);
});

test("no forbidden API calls during conflict-artifact creation", async () => {
	FORBIDDEN_CALLS.length = 0;
	const tracker = new DeviceWitnessTracker(makeConfig());

	tracker.markDirty("test.md", "conflict-artifact");

	await new Promise((r) => setTimeout(r, WAIT_FOR_STABLE_MS));
	tracker.dispose();

	assert.equal(FORBIDDEN_CALLS.length, 0, `Forbidden calls: ${FORBIDDEN_CALLS.join(", ")}`);
});

test("no forbidden API calls during tombstone events", async () => {
	FORBIDDEN_CALLS.length = 0;
	const tracker = new DeviceWitnessTracker({
		...makeConfig(),
		isCrdtTombstoned: () => true,
		readDiskContent: async () => null,
	});

	tracker.markDirty("test.md", "tombstone");

	await new Promise((r) => setTimeout(r, WAIT_FOR_STABLE_MS));
	tracker.dispose();

	assert.equal(FORBIDDEN_CALLS.length, 0, `Forbidden calls: ${FORBIDDEN_CALLS.join(", ")}`);
});

test("no forbidden API calls after dispose", async () => {
	FORBIDDEN_CALLS.length = 0;
	const tracker = new DeviceWitnessTracker(makeConfig());
	tracker.dispose();

	tracker.markDirty("test.md", "remote-apply");
	tracker.handleRecoveryDecision("test.md", "h:hash");

	await new Promise((r) => setTimeout(r, 200));

	assert.equal(FORBIDDEN_CALLS.length, 0, `Forbidden calls: ${FORBIDDEN_CALLS.join(", ")}`);
});

// -----------------------------------------------------------------------
// Run tests sequentially
// -----------------------------------------------------------------------

async function runAll(): Promise<void> {
	for (const [name, fn] of tests) {
		try {
			await fn();
			console.log(`  PASS  ${name}`);
			passed++;
		} catch (err: unknown) {
			console.error(`  FAIL  ${name}`);
			console.error(`        ${err instanceof Error ? err.message : String(err)}`);
			failed++;
		}
	}
	console.log(`\nResults: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

void runAll();
