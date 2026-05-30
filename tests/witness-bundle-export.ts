/**
 * Verification Gate 5 — Bundle export (Phase 3 Requirement 2)
 *
 * Tests that:
 *   - bundle.header first line has all required fields
 *   - safe/qa-safe bundles contain no secrets or raw paths
 *   - bundle parses as valid NDJSON with header on line 1
 *   - bundle includes all retained segment lines
 *   - round-trip: events parse back to FlightEvent-compatible shape
 *
 * Architecture note:
 *   Scenario state mutation was moved OUT of DeviceWitnessTracker (Observer)
 *   into ScenarioStateController (Puppeteer). The buildBundleString helper
 *   now reads scenario state from the controller, not the tracker.
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
	scenario?: ScenarioStateController,
	overrides: Partial<WitnessTrackerConfig> = {},
): WitnessTrackerConfig {
	return {
		stateSecret: "test-state-secret",
		flightMode: "qa-safe",
		qaTraceSecret: "qa-trace-secret-sentinel",
		platform: "desktop",
		sink: { record: () => {}, recordPath: async () => {} },
		traceContext: {
			traceId: "trace-bundle-test",
			bootId: "boot-001",
			deviceId: "device-bundle-001",
			vaultIdHash: "vault-hash",
			serverHostHash: "server-hash",
			pluginVersion: "1.6.1",
		},
		readCrdtContent: () => "bundle test content",
		isCrdtTombstoned: () => false,
		getFileId: () => "file-bundle-001",
		readDiskContent: async () => "bundle test content",
		sampleEditor: () => ({ kind: "not_open", content: null }),
		stableAfterMs: 50,
		getScenarioContext: scenario ? () => scenario : undefined,
		...overrides,
	};
}

const WAIT_FOR_SEGMENT_MS = 150;

function buildBundleString(
	tracker: DeviceWitnessTracker,
	scenario: ScenarioStateController | null,
	opts: {
		traceId: string;
		deviceId: string;
		pluginVersion: string;
		deviceLabel: string;
		qaTraceSecretHash: string;
		scenarioRunId?: string | null;
		scenarioId?: string | null;
		privacyMode: "safe" | "unsafe-local";
		flightMode: string;
	},
): string {
	const segments = tracker.getCheckpointSegments();
	const eventCount = segments.reduce((n, s) => {
		return n + s.content.split("\n").filter((l) => {
			if (!l.trim()) return false;
			try {
				const o = JSON.parse(l) as Record<string, unknown>;
				return o.kind !== "checkpoint.segment.header";
			} catch { return false; }
		}).length;
	}, 0);
	// Read scenario state from the Puppeteer controller, not the Observer tracker
	const scenarioState = scenario?.getScenarioStepState() ?? null;
	const header = {
		kind: "bundle.header",
		bundleSchemaVersion: 1,
		createdAt: new Date().toISOString(),
		pluginVersion: opts.pluginVersion,
		deviceId: opts.deviceId,
		deviceLabel: opts.deviceLabel,
		platform: "desktop",
		runtimeState: tracker.getRuntimeState(),
		localTraceId: opts.traceId,
		scenarioRunId: opts.scenarioRunId ?? scenarioState?.scenarioRunId ?? null,
		scenarioId: opts.scenarioId ?? scenarioState?.scenarioId ?? null,
		qaTraceSecretHash: opts.qaTraceSecretHash,
		flightMode: opts.flightMode,
		eventCount,
		containsRawPaths: opts.privacyMode === "unsafe-local",
		hashDomain: "witness-state-v1",
		privacyMode: opts.privacyMode,
	};
	const lines = [JSON.stringify(header)];
	for (const seg of segments) {
		lines.push(seg.content.trimEnd());
	}
	return lines.join("\n") + "\n";
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

test("bundle.header first line has all required fields", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig());
	tracker.markDirty("Notes/test.md", "local-edit");
	await new Promise((r) => setTimeout(r, WAIT_FOR_SEGMENT_MS));

	const bundle = buildBundleString(tracker, null, {
		traceId: "trace-bundle-test",
		deviceId: "device-bundle-001",
		pluginVersion: "1.6.1",
		deviceLabel: "Test Device",
		qaTraceSecretHash: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		privacyMode: "safe",
		flightMode: "qa-safe",
	});

	const firstLine = bundle.split("\n")[0]!;
	const header = JSON.parse(firstLine) as Record<string, unknown>;

	const requiredFields = [
		"kind", "bundleSchemaVersion", "createdAt", "pluginVersion", "deviceId",
		"deviceLabel", "platform", "runtimeState", "localTraceId", "scenarioRunId",
		"scenarioId", "qaTraceSecretHash", "flightMode", "eventCount",
		"containsRawPaths", "hashDomain", "privacyMode",
	];
	for (const field of requiredFields) {
		assert.ok(field in header, `Missing required field: ${field}`);
	}
	assert.equal(header.kind, "bundle.header");
	assert.equal(header.bundleSchemaVersion, 1);
	assert.equal(header.hashDomain, "witness-state-v1");
	assert.equal(header.privacyMode, "safe");
	assert.equal(header.containsRawPaths, false);
	tracker.dispose();
});

test("safe bundle contains no sentinel secret values", async () => {
	const SENTINEL_SECRET = "qa-trace-secret-sentinel";
	const SENTINEL_STATE = "test-state-secret";
	const SENTINEL_TOKEN = "sync-token-sentinel";

	const tracker = new DeviceWitnessTracker(makeConfig());
	tracker.markDirty("Notes/test.md", "local-edit");
	await new Promise((r) => setTimeout(r, WAIT_FOR_SEGMENT_MS));

	const bundle = buildBundleString(tracker, null, {
		traceId: "trace-bundle-test",
		deviceId: "device-bundle-001",
		pluginVersion: "1.6.1",
		deviceLabel: "Test Device",
		qaTraceSecretHash: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		privacyMode: "safe",
		flightMode: "qa-safe",
	});

	assert.ok(!bundle.includes(SENTINEL_SECRET), "Bundle must not contain qaTraceSecret");
	assert.ok(!bundle.includes(SENTINEL_STATE), "Bundle must not contain stateSecret");
	assert.ok(!bundle.includes(SENTINEL_TOKEN), "Bundle must not contain sync token");
	tracker.dispose();
});

test("bundle parses as valid NDJSON with header on line 1", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig());
	tracker.markDirty("Notes/test.md", "local-edit");
	await new Promise((r) => setTimeout(r, WAIT_FOR_SEGMENT_MS));

	const bundle = buildBundleString(tracker, null, {
		traceId: "trace-bundle-test",
		deviceId: "device-bundle-001",
		pluginVersion: "1.6.1",
		deviceLabel: "Test Device",
		qaTraceSecretHash: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		privacyMode: "safe",
		flightMode: "qa-safe",
	});

	const lines = bundle.split("\n").filter((l) => l.trim());
	assert.ok(lines.length >= 1, "Bundle must have at least one line");

	// Every line must be valid JSON
	for (const line of lines) {
		assert.doesNotThrow(() => JSON.parse(line), `Invalid JSON line: ${line.slice(0, 80)}`);
	}

	// First line must be bundle.header
	const first = JSON.parse(lines[0]!) as Record<string, unknown>;
	assert.equal(first.kind, "bundle.header");
	tracker.dispose();
});

test("bundle includes all retained segment lines", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig());
	tracker.markDirty("Notes/test.md", "local-edit");
	await new Promise((r) => setTimeout(r, WAIT_FOR_SEGMENT_MS));

	const segments = tracker.getCheckpointSegments();
	const bundle = buildBundleString(tracker, null, {
		traceId: "trace-bundle-test",
		deviceId: "device-bundle-001",
		pluginVersion: "1.6.1",
		deviceLabel: "Test Device",
		qaTraceSecretHash: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		privacyMode: "safe",
		flightMode: "qa-safe",
	});

	// All segment content should appear in the bundle
	for (const seg of segments) {
		const segLines = seg.content.split("\n").filter((l) => l.trim());
		for (const line of segLines) {
			assert.ok(bundle.includes(line), `Segment line missing from bundle: ${line.slice(0, 80)}`);
		}
	}
	tracker.dispose();
});

test("bundle eventCount matches actual event lines", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig());
	tracker.markDirty("Notes/test.md", "local-edit");
	await new Promise((r) => setTimeout(r, WAIT_FOR_SEGMENT_MS));

	const bundle = buildBundleString(tracker, null, {
		traceId: "trace-bundle-test",
		deviceId: "device-bundle-001",
		pluginVersion: "1.6.1",
		deviceLabel: "Test Device",
		qaTraceSecretHash: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		privacyMode: "safe",
		flightMode: "qa-safe",
	});

	const lines = bundle.split("\n").filter((l) => l.trim());
	const header = JSON.parse(lines[0]!) as Record<string, unknown>;
	const eventLines = lines.slice(1).filter((l) => {
		try {
			const o = JSON.parse(l) as Record<string, unknown>;
			return o.kind !== "checkpoint.segment.header";
		} catch { return false; }
	});
	assert.equal(header.eventCount, eventLines.length);
	tracker.dispose();
});

test("round-trip: event lines parse to FlightEvent-compatible shape", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig());
	tracker.markDirty("Notes/test.md", "local-edit");
	await new Promise((r) => setTimeout(r, WAIT_FOR_SEGMENT_MS));

	const bundle = buildBundleString(tracker, null, {
		traceId: "trace-bundle-test",
		deviceId: "device-bundle-001",
		pluginVersion: "1.6.1",
		deviceLabel: "Test Device",
		qaTraceSecretHash: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		privacyMode: "safe",
		flightMode: "qa-safe",
	});

	const lines = bundle.split("\n").filter((l) => l.trim()).slice(1);
	for (const line of lines) {
		const obj = JSON.parse(line) as Record<string, unknown>;
		if (obj.kind === "checkpoint.segment.header") continue;
		// Must have kind field (FlightEvent-compatible)
		assert.ok(typeof obj.kind === "string", `Event line missing kind: ${line.slice(0, 80)}`);
	}
	tracker.dispose();
});

test("unsafe-local bundle sets containsRawPaths: true and privacyMode: unsafe-local", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig());

	const bundle = buildBundleString(tracker, null, {
		traceId: "trace-bundle-test",
		deviceId: "device-bundle-001",
		pluginVersion: "1.6.1",
		deviceLabel: "Test Device",
		qaTraceSecretHash: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		privacyMode: "unsafe-local",
		flightMode: "full",
	});

	const header = JSON.parse(bundle.split("\n")[0]!) as Record<string, unknown>;
	assert.equal(header.privacyMode, "unsafe-local");
	assert.equal(header.containsRawPaths, true);
	tracker.dispose();
});

test("empty bundle (no segments) still has valid header with eventCount: 0", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig());
	// No markDirty — no segments

	const bundle = buildBundleString(tracker, null, {
		traceId: "trace-bundle-test",
		deviceId: "device-bundle-001",
		pluginVersion: "1.6.1",
		deviceLabel: "Test Device",
		qaTraceSecretHash: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		privacyMode: "safe",
		flightMode: "qa-safe",
	});

	const lines = bundle.split("\n").filter((l) => l.trim());
	assert.equal(lines.length, 1, "Empty bundle should have exactly 1 line (header)");
	const header = JSON.parse(lines[0]!) as Record<string, unknown>;
	assert.equal(header.eventCount, 0);
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

console.log(`\nGate 5 (bundle export): ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
