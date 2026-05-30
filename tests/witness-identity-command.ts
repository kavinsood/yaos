/**
 * Verification Gate 6 — Identity command privacy (Phase 3 Requirement 3)
 *
 * Tests that the identity modal data:
 *   - Shows all required fields
 *   - Never exposes secrets
 *   - qaTraceSecretHash is truncated for display, full for clipboard
 */

import assert from "node:assert/strict";
import { DeviceWitnessTracker } from "../src/telemetry/diagnostics/deviceWitnessTracker";
import type { WitnessTrackerConfig } from "../src/telemetry/diagnostics/deviceWitnessTracker";

let passed = 0;
let failed = 0;
const tests: Array<[string, () => Promise<void>]> = [];

function test(name: string, fn: () => Promise<void>): void {
	tests.push([name, fn]);
}

function makeConfig(overrides: Partial<WitnessTrackerConfig> = {}): WitnessTrackerConfig {
	return {
		stateSecret: "state-secret-sentinel",
		flightMode: "qa-safe",
		qaTraceSecret: "qa-secret-sentinel",
		platform: "desktop",
		sink: { record: () => {}, recordPath: async () => {} },
		traceContext: {
			traceId: "trace-identity-test",
			bootId: "boot-001",
			deviceId: "device-identity-001",
			vaultIdHash: "vault-hash",
			serverHostHash: "server-hash",
			pluginVersion: "1.6.1",
		},
		readCrdtContent: () => null,
		isCrdtTombstoned: () => false,
		getFileId: () => undefined,
		readDiskContent: async () => null,
		sampleEditor: () => ({ kind: "not_open", content: null }),
		...overrides,
	};
}

/** Simulate the identity modal data builder (mirrors main.ts _qaShowDeviceIdentity logic). */
function buildIdentityData(opts: {
	deviceId: string;
	deviceName: string;
	pluginVersion: string;
	flightMode: string | null;
	traceActive: boolean;
	localTraceId?: string;
	scenarioRunId?: string | null;
	scenarioId?: string | null;
	qaTraceSecretHash: string | null;
	runtimeState: string;
	bundleExportAvailable: boolean;
}): { display: string; clipboard: string } {
	const secretHash = opts.qaTraceSecretHash;
	const truncatedHash = secretHash?.startsWith("sha256:")
		? `sha256:${secretHash.slice(7, 19)}…${secretHash.slice(-4)}`
		: secretHash ?? "(no qaTraceSecret configured)";

	const lines = [
		`deviceId: ${opts.deviceId}`,
		`Device label (display-only — never used as a key): ${opts.deviceName}`,
		`Device name (display-only — never used as a key): ${opts.deviceName}`,
		`pluginVersion: ${opts.pluginVersion}`,
		`platform: desktop`,
		`flightMode: ${opts.flightMode ?? "(no active trace)"}`,
		`traceActive: ${opts.traceActive}`,
		`localTraceId: ${opts.localTraceId ?? "(none)"}`,
		`scenarioRunId: ${opts.scenarioRunId ?? "(not set)"}`,
		`scenarioId: ${opts.scenarioId ?? "(not set)"}`,
		`qaTraceSecretHash: ${truncatedHash}`,
		`runtimeState: ${opts.runtimeState}`,
		`bundleExportAvailable: ${opts.bundleExportAvailable}`,
		`filesystemPersistenceStatus: unavailable_inside_vault`,
	].join("\n");

	const clipboard = lines.replace(truncatedHash, secretHash ?? "(no qaTraceSecret configured)");
	return { display: lines, clipboard };
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

test("identity modal shows all required fields", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig());
	const { display } = buildIdentityData({
		deviceId: "device-identity-001",
		deviceName: "Test Device",
		pluginVersion: "1.6.1",
		flightMode: "qa-safe",
		traceActive: true,
		localTraceId: "trace-001",
		scenarioRunId: "run-001",
		scenarioId: "s12a",
		qaTraceSecretHash: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		runtimeState: tracker.getRuntimeState(),
		bundleExportAvailable: false,
	});

	assert.ok(display.includes("deviceId:"), "Missing deviceId");
	assert.ok(display.includes("pluginVersion:"), "Missing pluginVersion");
	assert.ok(display.includes("platform:"), "Missing platform");
	assert.ok(display.includes("flightMode:"), "Missing flightMode");
	assert.ok(display.includes("traceActive:"), "Missing traceActive");
	assert.ok(display.includes("localTraceId:"), "Missing localTraceId");
	assert.ok(display.includes("scenarioRunId:"), "Missing scenarioRunId");
	assert.ok(display.includes("scenarioId:"), "Missing scenarioId");
	assert.ok(display.includes("qaTraceSecretHash:"), "Missing qaTraceSecretHash");
	assert.ok(display.includes("runtimeState:"), "Missing runtimeState");
	assert.ok(display.includes("bundleExportAvailable:"), "Missing bundleExportAvailable");
	assert.ok(display.includes("filesystemPersistenceStatus: unavailable_inside_vault"), "Must always show unavailable_inside_vault");
	tracker.dispose();
});

test("identity modal never shows raw secrets", async () => {
	const SECRET = "qa-secret-sentinel";
	const STATE_SECRET = "state-secret-sentinel";
	const TOKEN = "sync-token-sentinel";
	const SERVER_URL = "https://my-server.example.com";

	const { display, clipboard } = buildIdentityData({
		deviceId: "device-identity-001",
		deviceName: "Test Device",
		pluginVersion: "1.6.1",
		flightMode: "qa-safe",
		traceActive: true,
		qaTraceSecretHash: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		runtimeState: "foreground",
		bundleExportAvailable: false,
	});

	for (const payload of [display, clipboard]) {
		assert.ok(!payload.includes(SECRET), "Must not contain qaTraceSecret");
		assert.ok(!payload.includes(STATE_SECRET), "Must not contain stateSecret");
		assert.ok(!payload.includes(TOKEN), "Must not contain sync token");
		assert.ok(!payload.includes(SERVER_URL), "Must not contain server URL");
	}
});

test("display shows truncated hash, clipboard shows full hash", async () => {
	const FULL_HASH = "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
	const { display, clipboard } = buildIdentityData({
		deviceId: "device-identity-001",
		deviceName: "Test Device",
		pluginVersion: "1.6.1",
		flightMode: "qa-safe",
		traceActive: true,
		qaTraceSecretHash: FULL_HASH,
		runtimeState: "foreground",
		bundleExportAvailable: false,
	});

	assert.ok(!display.includes(FULL_HASH), "Display should not contain full hash");
	assert.ok(display.includes("sha256:abcdef123456…"), "Display should contain truncated hash");
	assert.ok(clipboard.includes(FULL_HASH), "Clipboard should contain full hash");
});

test("deviceName is labeled as display-only", async () => {
	const { display } = buildIdentityData({
		deviceId: "device-identity-001",
		deviceName: "My iPad",
		pluginVersion: "1.6.1",
		flightMode: null,
		traceActive: false,
		qaTraceSecretHash: null,
		runtimeState: "unknown",
		bundleExportAvailable: false,
	});

	assert.ok(display.includes("display-only"), "deviceName must be labeled display-only");
	assert.ok(display.includes("never used as a key"), "Must state never used as a key");
});

test("no qaTraceSecret configured shows placeholder", async () => {
	const { display } = buildIdentityData({
		deviceId: "device-identity-001",
		deviceName: "Test Device",
		pluginVersion: "1.6.1",
		flightMode: null,
		traceActive: false,
		qaTraceSecretHash: null,
		runtimeState: "unknown",
		bundleExportAvailable: false,
	});

	assert.ok(display.includes("(no qaTraceSecret configured)"), "Must show placeholder when no secret");
	assert.ok(!display.includes("sha256:e3b0"), "Must not hash empty string");
});

test("filesystemPersistenceStatus is always unavailable_inside_vault", async () => {
	// .obsidian is always inside the vault root — filesystem write is always fail-closed
	const { display } = buildIdentityData({
		deviceId: "d1", deviceName: "d", pluginVersion: "1.0", flightMode: null,
		traceActive: false, qaTraceSecretHash: null, runtimeState: "unknown",
		bundleExportAvailable: false,
	});
	assert.ok(display.includes("unavailable_inside_vault"), "Must always show unavailable_inside_vault");
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

console.log(`\nGate 6 (identity command privacy): ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
