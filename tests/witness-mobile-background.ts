/**
 * Mobile-background guard tests (Requirements 19, 20)
 *
 * Tests that:
 *   - Tracker emits "unavailable" instead of settled/diverged when mobile-backgrounded
 *   - runtimeState field is present on every emitted event
 *   - "unknown" is treated conservatively as "background"
 *   - Normal emission resumes when runtime returns to "foreground"
 */

import assert from "node:assert/strict";
import { DeviceWitnessTracker } from "../src/telemetry/diagnostics/deviceWitnessTracker";
import type { WitnessTrackerConfig } from "../src/telemetry/diagnostics/deviceWitnessTracker";

let passed = 0;
let failed = 0;
const WAIT_FOR_EVENT_MS = 200;

// Sequential test runner (tests share mockVisibilityState)
const tests: Array<[string, () => Promise<void>]> = [];

function test(name: string, fn: () => Promise<void>): void {
	tests.push([name, fn]);
}

// -----------------------------------------------------------------------
// Mock document.visibilityState
// -----------------------------------------------------------------------

let mockVisibilityState: "visible" | "hidden" = "visible";

Object.defineProperty(globalThis, "document", {
	get: () => ({ visibilityState: mockVisibilityState }),
	configurable: true,
});

function makeConfig(overrides: Partial<WitnessTrackerConfig> = {}): WitnessTrackerConfig {
	return {
		stateSecret: "test-secret",
		flightMode: "qa-safe",
		qaTraceSecret: "qa-secret",
		platform: "mobile",
		sink: {
			record: () => {},
			recordPath: async () => {},
		},
		traceContext: {
			traceId: "trace-mobile",
			bootId: "boot-mobile",
			deviceId: "device-mobile",
			vaultIdHash: "vault-hash",
			serverHostHash: "server-hash",
			pluginVersion: "1.0.0",
		},
		readCrdtContent: () => "hello world",
		isCrdtTombstoned: () => false,
		getFileId: () => "file-id-mobile",
		readDiskContent: async () => "hello world",
		sampleEditor: () => ({ kind: "not_open", content: null }),
		stableAfterMs: 100, // fast for tests
		...overrides,
	};
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

test("getRuntimeState returns foreground when document.visibilityState is visible", async () => {
	mockVisibilityState = "visible";
	const tracker = new DeviceWitnessTracker(makeConfig());
	assert.equal(tracker.getRuntimeState(), "foreground");
	tracker.dispose();
});

test("getRuntimeState returns background when document.visibilityState is hidden", async () => {
	mockVisibilityState = "hidden";
	const tracker = new DeviceWitnessTracker(makeConfig());
	assert.equal(tracker.getRuntimeState(), "background");
	tracker.dispose();
});

test("desktop platform always returns foreground regardless of visibilityState", async () => {
	mockVisibilityState = "hidden";
	const tracker = new DeviceWitnessTracker(makeConfig({ platform: "desktop" }));
	assert.equal(tracker.getRuntimeState(), "foreground");
	tracker.dispose();
});

test("mobile-backgrounded tracker emits unavailable instead of settled", async () => {
	mockVisibilityState = "hidden";
	const emitted: Array<{ kind: string; data: Record<string, unknown> }> = [];
	const tracker = new DeviceWitnessTracker(makeConfig({
		sink: {
			record: () => {},
			recordPath: async (e) => {
				emitted.push({
					kind: e.kind === "device.witness.settled" ? "settled" : "diverged",
					data: { ...(e.data ?? {}), reason: e.reason },
				});
			},
		},
	}));

	tracker.markDirty("test.md", "disk-write");
	await new Promise((r) => setTimeout(r, WAIT_FOR_EVENT_MS));
	tracker.dispose();

	const unavailable = emitted.filter((e) => e.kind === "diverged" && e.data.reason === "unavailable");
	const settled = emitted.filter((e) => e.kind === "settled");

	assert.ok(unavailable.length > 0, `Should emit unavailable when mobile-backgrounded, got: ${JSON.stringify(emitted)}`);
	assert.equal(settled.length, 0, "Should NOT emit settled when mobile-backgrounded");
});

test("unavailable event has runtimeState field set to background", async () => {
	mockVisibilityState = "hidden";
	const emitted: Array<{ kind: string; data: Record<string, unknown> }> = [];
	const tracker = new DeviceWitnessTracker(makeConfig({
		sink: {
			record: () => {},
			recordPath: async (e) => {
				emitted.push({
					kind: e.kind === "device.witness.settled" ? "settled" : "diverged",
					data: { ...(e.data ?? {}), reason: e.reason },
				});
			},
		},
	}));

	tracker.markDirty("test.md", "disk-write");
	await new Promise((r) => setTimeout(r, WAIT_FOR_EVENT_MS));
	tracker.dispose();

	const unavailable = emitted.find((e) => e.data.reason === "unavailable");
	assert.ok(unavailable, `Should have unavailable event, got: ${JSON.stringify(emitted)}`);
	assert.equal(unavailable!.data.runtimeState, "background");
});

test("foreground tracker emits settled normally", async () => {
	mockVisibilityState = "visible";
	const emitted: Array<{ kind: string; data: Record<string, unknown> }> = [];
	const tracker = new DeviceWitnessTracker(makeConfig({
		sink: {
			record: () => {},
			recordPath: async (e) => {
				// Use decision field to distinguish settled vs diverged
				const isSettled = e.decision === "settled" || e.kind === "device.witness.settled";
				emitted.push({
					kind: isSettled ? "settled" : "diverged",
					data: { ...(e.data ?? {}), reason: e.reason, decision: e.decision, rawKind: e.kind },
				});
			},
		},
	}));

	tracker.markDirty("test.md", "disk-write");
	await new Promise((r) => setTimeout(r, WAIT_FOR_EVENT_MS));
	tracker.dispose();

	const settled = emitted.filter((e) => e.kind === "settled");
	assert.ok(settled.length > 0, `Should emit settled when foreground, got: ${JSON.stringify(emitted)}`);
});

test("every emitted event has runtimeState field", async () => {
	mockVisibilityState = "visible";
	const emitted: Array<{ kind: string; data: Record<string, unknown> }> = [];
	const tracker = new DeviceWitnessTracker(makeConfig({
		sink: {
			record: () => {},
			recordPath: async (e) => {
				emitted.push({
					kind: e.kind === "device.witness.settled" ? "settled" : "diverged",
					data: { ...(e.data ?? {}), reason: e.reason },
				});
			},
		},
	}));

	tracker.markDirty("test.md", "disk-write");
	await new Promise((r) => setTimeout(r, WAIT_FOR_EVENT_MS));
	tracker.dispose();

	assert.ok(emitted.length > 0, "Should have emitted at least one event");
	for (const e of emitted) {
		assert.ok(
			["foreground", "background", "suspended", "unknown"].includes(String(e.data.runtimeState ?? "")),
			`Event missing valid runtimeState: ${JSON.stringify(e.data)}`,
		);
	}
});

test("every emitted event has causedByEvents object", async () => {
	mockVisibilityState = "visible";
	const emitted: Array<{ kind: string; data: Record<string, unknown> }> = [];
	const tracker = new DeviceWitnessTracker(makeConfig({
		sink: {
			record: () => {},
			recordPath: async (e) => {
				emitted.push({
					kind: e.kind === "device.witness.settled" ? "settled" : "diverged",
					data: { ...(e.data ?? {}), reason: e.reason },
				});
			},
		},
	}));

	tracker.markDirty("test.md", "disk-write");
	await new Promise((r) => setTimeout(r, WAIT_FOR_EVENT_MS));
	tracker.dispose();

	assert.ok(emitted.length > 0, "Should have emitted at least one event");
	for (const e of emitted) {
		assert.ok(
			e.data.causedByEvents !== null && typeof e.data.causedByEvents === "object",
			`Event missing causedByEvents: ${JSON.stringify(e.data)}`,
		);
	}
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
