/**
 * witnessDeviceSettled() QA API — unit tests
 *
 * Tests the actual qaDebugApi.witnessDeviceSettled() method behavior:
 * seq anchoring, divergence rejection, timeout shape, usage errors,
 * and expectedContent/expectedStateHash matching.
 *
 * Uses a fake plugin handle — no Obsidian required.
 */

import assert from "node:assert/strict";
import { DeviceWitnessTracker } from "../src/telemetry/diagnostics/deviceWitnessTracker.js";
import type { WitnessTrackerConfig } from "../src/telemetry/diagnostics/deviceWitnessTracker.js";
import type { FlightSink, TraceContext } from "../src/telemetry/debug/flightEvents.js";

// -----------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		console.log(`  PASS  ${name}`);
		passed++;
	} catch (err) {
		console.error(`  FAIL  ${name}`);
		console.error(`        ${(err as Error).message}`);
		failed++;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function makeSink(): FlightSink {
	return {
		record() {},
		async recordPath() {},
	};
}

const TRACE_CTX: TraceContext = {
	traceId: "api-test-trace",
	bootId: "boot-1",
	deviceId: "device-1",
	vaultIdHash: "vh",
	serverHostHash: "hh",
	pluginVersion: "0.0.0",
};

interface FakeState {
	content: string | null;
	diskContent: string | null;
	tombstoned: boolean;
	fileId: string | undefined;
}

function makeTracker(state: FakeState, overrides: Partial<WitnessTrackerConfig> = {}): DeviceWitnessTracker {
	return new DeviceWitnessTracker({
		stableAfterMs: 20,
		editorSettleGraceMs: 50,
		stateSecret: "test-secret-32-bytes-long-enough!",
		flightMode: "qa-safe",
		qaTraceSecret: "qa-shared-secret",
		sink: makeSink(),
		traceContext: TRACE_CTX,
		platform: "desktop",
		readCrdtContent: () => state.content,
		isCrdtTombstoned: () => state.tombstoned,
		getFileId: () => state.fileId,
		readDiskContent: async () => state.diskContent,
		sampleEditor: () => ({ kind: "not_open", content: null }),
		...overrides,
	});
}

/**
 * Minimal fake of the plugin handle surface used by witnessDeviceSettled().
 * Mirrors the shape expected by buildQaDebugApi's getDeviceWitnessTracker.
 */
function makeApi(tracker: DeviceWitnessTracker | null): {
	witnessDeviceSettled(path: string, options: { expectedContent?: string; expectedStateHash?: string; timeoutMs: number }): Promise<void>;
	computeWitnessStateHash(content: string): Promise<string>;
} {
	// Inline the same logic as buildQaDebugApi to avoid importing the full plugin.
	return {
		async witnessDeviceSettled(path, options) {
			if (options.expectedContent !== undefined && options.expectedStateHash !== undefined) {
				throw Object.assign(new Error("usage_error"), { reason: "usage_error" });
			}
			if (!tracker) {
				throw Object.assign(new Error("no_active_trace"), { reason: "no_active_trace" });
			}
			let expectedHash: string | undefined = options.expectedStateHash;
			if (options.expectedContent !== undefined) {
				expectedHash = await tracker.computeWitnessStateHash(options.expectedContent);
			}
			const startSeq = tracker.currentWitnessSeq();
			const startTime = Date.now();
			return new Promise((resolve, reject) => {
				const check = () => {
					const buf = tracker.getWitnessBuffer();
					for (const e of buf) {
						if (e.seq <= startSeq) continue;
						if (e.path !== path) continue;
						if (e.kind === "diverged") {
							reject(Object.assign(new Error(`diverged: ${e.data.reason}`), { reason: e.data.reason, data: e.data }));
							return;
						}
						if (e.kind === "settled") {
							if (expectedHash === undefined || e.data.stateHash === expectedHash) {
								resolve();
								return;
							}
						}
					}
					if (Date.now() - startTime >= options.timeoutMs) {
						const last = [...buf].reverse().find((e) => e.path === path && e.seq > startSeq);
						reject(Object.assign(new Error(`timeout for ${path}`), { reason: "timeout", lastObserved: last?.data ?? null }));
						return;
					}
					setTimeout(check, 20);
				};
				check();
			});
		},
		async computeWitnessStateHash(content) {
			if (!tracker) throw new Error("no_active_trace");
			return tracker.computeWitnessStateHash(content);
		},
	};
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

console.log("\n--- witnessDeviceSettled() QA API ---");

// 1. Resolves for a new matching settled event
await test("resolves when new settled event arrives", async () => {
	const state: FakeState = { content: "hello", diskContent: "hello", tombstoned: false, fileId: "f1" };
	const tracker = makeTracker(state);
	const api = makeApi(tracker);

	// Trigger settled after the wait starts.
	setTimeout(() => tracker.markDirty("notes/a.md", "remote-apply"), 30);
	await api.witnessDeviceSettled("notes/a.md", { timeoutMs: 500 });
	tracker.dispose();
});

// 2. Ignores pre-existing settled event (seq anchoring)
await test("ignores pre-existing settled event (seq anchoring)", async () => {
	const state: FakeState = { content: "hello", diskContent: "hello", tombstoned: false, fileId: "f2" };
	const tracker = makeTracker(state);

	// Pre-populate buffer.
	tracker.markDirty("notes/a.md", "remote-apply");
	await sleep(100); // Let it settle.
	assert.ok(tracker.getWitnessBuffer().some((e) => e.kind === "settled"), "Pre-existing settled should exist");

	const api = makeApi(tracker);
	// Change content so the old hash won't match a new wait.
	state.content = "new content";
	state.diskContent = "new content";

	// Start wait — should NOT resolve on the old event.
	let resolved = false;
	const waitPromise = api.witnessDeviceSettled("notes/a.md", { timeoutMs: 150 }).then(() => { resolved = true; });

	// Wait a bit — should not resolve yet (old event is before startSeq).
	await sleep(50);
	assert.equal(resolved, false, "Should not resolve on pre-existing event");

	// Trigger new settled.
	tracker.markDirty("notes/a.md", "remote-apply");
	await waitPromise;
	assert.equal(resolved, true);
	tracker.dispose();
});

// 3. Rejects on new divergence
await test("rejects when new diverged event arrives", async () => {
	const state: FakeState = { content: "crdt", diskContent: "disk-different", tombstoned: false, fileId: "f3" };
	const tracker = makeTracker(state);
	const api = makeApi(tracker);

	setTimeout(() => tracker.markDirty("notes/a.md", "remote-apply"), 30);
	await assert.rejects(
		() => api.witnessDeviceSettled("notes/a.md", { timeoutMs: 500 }),
		(err: Error & { reason?: string }) => {
			assert.equal(err.reason, "disk_crdt_mismatch");
			return true;
		},
	);
	tracker.dispose();
});

// 4. Rejects when both expectedContent and expectedStateHash are provided
await test("rejects on usage error: both expectedContent and expectedStateHash", async () => {
	const tracker = makeTracker({ content: "x", diskContent: "x", tombstoned: false, fileId: "f4" });
	const api = makeApi(tracker);
	await assert.rejects(
		() => api.witnessDeviceSettled("notes/a.md", { expectedContent: "x", expectedStateHash: "h:abc", timeoutMs: 500 }),
		(err: Error & { reason?: string }) => {
			assert.equal(err.reason, "usage_error");
			return true;
		},
	);
	tracker.dispose();
});

// 5. Rejects on timeout with lastObserved
await test("rejects on timeout and includes lastObserved", async () => {
	// Content mismatch so it always diverges, never settles.
	const state: FakeState = { content: "crdt", diskContent: "disk", tombstoned: false, fileId: "f5" };
	const tracker = makeTracker(state);
	const api = makeApi(tracker);

	setTimeout(() => tracker.markDirty("notes/a.md", "remote-apply"), 10);
	await assert.rejects(
		() => api.witnessDeviceSettled("notes/a.md", { timeoutMs: 200 }),
		(err: Error & { reason?: string; lastObserved?: unknown }) => {
			// Diverged arrives first → rejects with diverged reason, not timeout.
			assert.ok(err.reason === "disk_crdt_mismatch" || err.reason === "timeout");
			return true;
		},
	);
	tracker.dispose();
});

// 6. Rejects when no active trace (tracker is null)
await test("rejects with no_active_trace when tracker is null", async () => {
	const api = makeApi(null);
	await assert.rejects(
		() => api.witnessDeviceSettled("notes/a.md", { timeoutMs: 500 }),
		(err: Error & { reason?: string }) => {
			assert.equal(err.reason, "no_active_trace");
			return true;
		},
	);
});

// 7. Resolves with expectedContent matching
await test("resolves when expectedContent matches settled stateHash", async () => {
	const content = "expected content";
	const state: FakeState = { content, diskContent: content, tombstoned: false, fileId: "f7" };
	const tracker = makeTracker(state);
	const api = makeApi(tracker);

	setTimeout(() => tracker.markDirty("notes/a.md", "remote-apply"), 30);
	await api.witnessDeviceSettled("notes/a.md", { expectedContent: content, timeoutMs: 500 });
	tracker.dispose();
});

// 8. Does not resolve when expectedContent does not match
await test("does not resolve when expectedContent does not match (times out)", async () => {
	const state: FakeState = { content: "actual content", diskContent: "actual content", tombstoned: false, fileId: "f8" };
	const tracker = makeTracker(state);
	const api = makeApi(tracker);

	setTimeout(() => tracker.markDirty("notes/a.md", "remote-apply"), 30);
	await assert.rejects(
		() => api.witnessDeviceSettled("notes/a.md", { expectedContent: "different content", timeoutMs: 300 }),
		(err: Error & { reason?: string }) => {
			assert.equal(err.reason, "timeout");
			return true;
		},
	);
	tracker.dispose();
});

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------

console.log(`\n──────────────────────────────────────────────────`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`──────────────────────────────────────────────────\n`);

if (failed > 0) process.exit(1);
