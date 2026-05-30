/**
 * DeviceWitnessTracker — tracker lifecycle smoke
 *
 * Tests DeviceWitnessTracker lifecycle behavior directly using a fake
 * FlightSink and controlled stubs. This is NOT a main.ts wiring test —
 * it does not prove Y.Text observer attachment, meta observer wiring, or
 * the QA API path. Those require a separate production wiring smoke.
 */

import assert from "node:assert/strict";
import { DeviceWitnessTracker } from "../src/telemetry/diagnostics/deviceWitnessTracker.js";
import type { WitnessTrackerConfig, WitnessBufferEntry } from "../src/telemetry/diagnostics/deviceWitnessTracker.js";
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

function makeSink(): FlightSink & { events: Array<Record<string, unknown>> } {
	const events: Array<Record<string, unknown>> = [];
	return {
		events,
		record(event) { events.push({ ...event }); },
		async recordPath(event) { events.push({ ...event }); },
	};
}

async function waitForBuffer(
	tracker: DeviceWitnessTracker,
	predicate: (e: WitnessBufferEntry) => boolean,
	timeoutMs = 500,
): Promise<WitnessBufferEntry> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = tracker.getWitnessBuffer().find(predicate);
		if (found) return found;
		await sleep(10);
	}
	throw new Error(`waitForBuffer timed out. Buffer: ${JSON.stringify(tracker.getWitnessBuffer())}`);
}

// -----------------------------------------------------------------------
// Fake VaultSync-like state
// -----------------------------------------------------------------------

interface FakeVaultState {
	content: string | null;
	diskContent: string | null;
	tombstoned: boolean;
	fileId: string | undefined;
}

function makeConfig(
	state: FakeVaultState,
	sink: FlightSink,
	traceId: string,
	overrides: Partial<WitnessTrackerConfig> = {},
): WitnessTrackerConfig {
	const ctx: TraceContext = {
		traceId,
		bootId: "boot-1",
		deviceId: "device-1",
		vaultIdHash: "vault-hash",
		serverHostHash: "host-hash",
		pluginVersion: "0.0.0-test",
	};
	return {
		stableAfterMs: 20,
		editorSettleGraceMs: 50,
		stateSecret: "test-secret-32-bytes-long-enough!",
		flightMode: "qa-safe",
		qaTraceSecret: "qa-shared-secret",
		sink,
		traceContext: ctx,
		platform: "desktop",
		pathPendingTimeoutMs: 100,
		readCrdtContent: () => state.content,
		isCrdtTombstoned: () => state.tombstoned,
		getFileId: () => state.fileId,
		readDiskContent: async () => state.diskContent,
		sampleEditor: () => ({ kind: "not_open", content: null }),
		...overrides,
	};
}

// -----------------------------------------------------------------------
// Smoke tests
// -----------------------------------------------------------------------

console.log("\n--- DeviceWitnessTracker lifecycle smoke ---");

// Smoke 1: basic lifecycle — start, dirty, settled, stop
await test("start → markDirty → settled → dispose clears state", async () => {
	const state: FakeVaultState = {
		content: "hello world",
		diskContent: "hello world",
		tombstoned: false,
		fileId: "file-smoke-1",
	};
	const sink = makeSink();
	const tracker = new DeviceWitnessTracker(makeConfig(state, sink, "trace-1"));

	tracker.markDirty("notes/smoke.md", "remote-apply");
	const entry = await waitForBuffer(tracker, (e) => e.kind === "settled" && e.path === "notes/smoke.md");
	assert.equal(entry.kind, "settled");
	assert.ok(entry.seq > 0);

	// Dispose clears buffer and pending.
	tracker.dispose();
	assert.equal(tracker.getWitnessBuffer().length, 0);
	// seq is a monotonic counter — it is not reset on dispose (that would be wrong).
	assert.ok(tracker.currentWitnessSeq() >= 1, "seq advanced at least once");
});

// Smoke 2: dispose is terminal — pending timers cancelled, post-dispose markDirty is a no-op
await test("after dispose, pending timers are cancelled and no new events emit", async () => {
	const state: FakeVaultState = {
		content: "content",
		diskContent: "content",
		tombstoned: false,
		fileId: "file-smoke-2",
	};
	const sink = makeSink();
	// Long stability window so the timer is still pending when we dispose.
	const tracker = new DeviceWitnessTracker(makeConfig(state, sink, "trace-2", { stableAfterMs: 80 }));

	tracker.markDirty("notes/smoke.md", "remote-apply");
	tracker.dispose();
	await sleep(120);
	assert.equal(tracker.getWitnessBuffer().length, 0, "No events after dispose cancels pending timer");
});

await test("dispose then markDirty => no event (disposed guard)", async () => {
	const state: FakeVaultState = {
		content: "content",
		diskContent: "content",
		tombstoned: false,
		fileId: "file-smoke-2b",
	};
	const sink = makeSink();
	const tracker = new DeviceWitnessTracker(makeConfig(state, sink, "trace-2b"));
	tracker.dispose();
	tracker.markDirty("notes/smoke.md", "remote-apply");
	await sleep(60);
	assert.equal(tracker.getWitnessBuffer().length, 0, "markDirty after dispose is a no-op");
});

// Smoke 3: restart — new tracker after dispose does not inherit old suppression
await test("new tracker after dispose emits fresh settled (no suppression leak)", async () => {
	const state: FakeVaultState = {
		content: "stable content",
		diskContent: "stable content",
		tombstoned: false,
		fileId: "file-smoke-3",
	};
	const sink1 = makeSink();
	const tracker1 = new DeviceWitnessTracker(makeConfig(state, sink1, "trace-3a"));

	// First trace: settle.
	tracker1.markDirty("notes/smoke.md", "remote-apply");
	await waitForBuffer(tracker1, (e) => e.kind === "settled");
	tracker1.dispose();

	// Second trace (new traceId): same content should settle again.
	const sink2 = makeSink();
	const tracker2 = new DeviceWitnessTracker(makeConfig(state, sink2, "trace-3b"));
	tracker2.markDirty("notes/smoke.md", "remote-apply");
	const entry = await waitForBuffer(tracker2, (e) => e.kind === "settled");
	assert.equal(entry.kind, "settled", "New trace should emit settled even for same content");
	tracker2.dispose();
});

// Smoke 4: seq anchoring — witnessDeviceSettled ignores pre-existing buffer events
await test("seq anchoring: pre-existing settled event does not satisfy new wait", async () => {
	const state: FakeVaultState = {
		content: "content A",
		diskContent: "content A",
		tombstoned: false,
		fileId: "file-smoke-4",
	};
	const sink = makeSink();
	const tracker = new DeviceWitnessTracker(makeConfig(state, sink, "trace-4"));

	// Pre-populate buffer.
	tracker.markDirty("notes/smoke.md", "remote-apply");
	await waitForBuffer(tracker, (e) => e.kind === "settled");
	const seqBefore = tracker.currentWitnessSeq();

	// Change content.
	state.content = "content B";
	state.diskContent = "content B";

	// Trigger new settled.
	tracker.markDirty("notes/smoke.md", "remote-apply");
	const newEntry = await waitForBuffer(
		tracker,
		(e) => e.kind === "settled" && e.seq > seqBefore,
	);
	assert.ok(newEntry.seq > seqBefore, "New settled has higher seq than pre-existing");
	tracker.dispose();
});

// Smoke 5: multiple paths — each path is independent
await test("multiple paths are tracked independently", async () => {
	const stateA: FakeVaultState = { content: "content A", diskContent: "content A", tombstoned: false, fileId: "file-A" };
	const stateB: FakeVaultState = { content: "content B", diskContent: "content B", tombstoned: false, fileId: "file-B" };

	const sink = makeSink();
	const tracker = new DeviceWitnessTracker({
		...makeConfig(stateA, sink, "trace-5"),
		readCrdtContent: (path) => path.includes("a.md") ? stateA.content : stateB.content,
		readDiskContent: async (path) => path.includes("a.md") ? stateA.diskContent : stateB.diskContent,
		getFileId: (path) => path.includes("a.md") ? stateA.fileId : stateB.fileId,
	});

	tracker.markDirty("notes/a.md", "remote-apply");
	tracker.markDirty("notes/b.md", "remote-apply");

	await waitForBuffer(tracker, (e) => e.kind === "settled" && e.path === "notes/a.md");
	await waitForBuffer(tracker, (e) => e.kind === "settled" && e.path === "notes/b.md");

	const settledA = tracker.getWitnessBuffer().filter((e) => e.kind === "settled" && e.path === "notes/a.md");
	const settledB = tracker.getWitnessBuffer().filter((e) => e.kind === "settled" && e.path === "notes/b.md");
	assert.equal(settledA.length, 1);
	assert.equal(settledB.length, 1);
	assert.notEqual(settledA[0].data.stateHash, settledB[0].data.stateHash, "Different content → different hashes");
	tracker.dispose();
});

// Smoke 6: dirty trigger during stability window resets timer
await test("dirty trigger during stability window resets timer (no premature settled)", async () => {
	let callCount = 0;
	const state: FakeVaultState = {
		content: "content",
		diskContent: "content",
		tombstoned: false,
		fileId: "file-smoke-6",
	};
	const sink = makeSink();
	const tracker = new DeviceWitnessTracker({
		...makeConfig(state, sink, "trace-6"),
		stableAfterMs: 60,
		readDiskContent: async () => { callCount++; return state.diskContent; },
	});

	// Fire two dirty triggers 30ms apart — second should reset the timer.
	tracker.markDirty("notes/smoke.md", "remote-apply");
	await sleep(30);
	tracker.markDirty("notes/smoke.md", "remote-apply");

	// Should not have settled yet (timer was reset).
	assert.equal(tracker.getWitnessBuffer().length, 0, "Should not settle before stability window");

	// Wait for full window after second trigger.
	await waitForBuffer(tracker, (e) => e.kind === "settled");
	assert.equal(tracker.getWitnessBuffer().length, 1, "Exactly one settled after stability window");
	tracker.dispose();
});

// Smoke 7: tombstone → settled deleted → revive → fresh settled present
await test("tombstone → settled deleted → revive → settled present", async () => {
	const state: FakeVaultState = {
		content: null,
		diskContent: null,
		tombstoned: true,
		fileId: "file-smoke-7",
	};
	const sink = makeSink();
	const tracker = new DeviceWitnessTracker(makeConfig(state, sink, "trace-7"));

	// Tombstone: settled deleted.
	tracker.markDirty("notes/smoke.md", "tombstone");
	await waitForBuffer(tracker, (e) => e.kind === "settled" && e.data.stateKind === "deleted");
	const seqDeleted = tracker.currentWitnessSeq();

	// Revive: file comes back.
	state.tombstoned = false;
	state.content = "revived content";
	state.diskContent = "revived content";
	tracker.markDirty("notes/smoke.md", "remote-apply");
	const revived = await waitForBuffer(
		tracker,
		(e) => e.kind === "settled" && e.data.stateKind === "present" && e.seq > seqDeleted,
	);
	assert.equal(revived.data.stateKind, "present");
	tracker.dispose();
});

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------

console.log(`\n──────────────────────────────────────────────────`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`──────────────────────────────────────────────────\n`);

if (failed > 0) process.exit(1);
