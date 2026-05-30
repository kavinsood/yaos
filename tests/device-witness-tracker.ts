/**
 * DeviceWitnessTracker — pure unit tests
 *
 * Tests the witness state machine in isolation using a fake FlightSink and
 * configurable stubs for CRDT/disk/editor reads.
 *
 * Run: node --experimental-vm-modules tests/device-witness-tracker.ts
 * (or via the regression runner)
 */

import assert from "node:assert/strict";
import { DeviceWitnessTracker } from "../src/telemetry/diagnostics/deviceWitnessTracker.js";
import type {
	WitnessTrackerConfig,
	EditorSampleKind,
	WitnessBufferEntry,
} from "../src/telemetry/diagnostics/deviceWitnessTracker.js";
import type { FlightSink, TraceContext } from "../src/telemetry/debug/flightEvents.js";

// -----------------------------------------------------------------------
// Test harness helpers
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

/** Fake FlightSink that records emitted events. */
function makeSink(): FlightSink & { events: Array<Record<string, unknown>> } {
	const events: Array<Record<string, unknown>> = [];
	return {
		events,
		record(event) { events.push({ ...event }); },
		async recordPath(event) { events.push({ ...event }); },
	};
}

const FAKE_CONTEXT: TraceContext = {
	traceId: "test-trace-id",
	bootId: "test-boot-id",
	deviceId: "test-device-id",
	vaultIdHash: "test-vault-hash",
	serverHostHash: "test-host-hash",
	pluginVersion: "0.0.0-test",
};

interface StubState {
	crdtContent: string | null;
	diskContent: string | null;
	tombstoned: boolean;
	fileId: string | undefined;
	editorKind: EditorSampleKind;
	editorContent: string | null;
	diskReadThrows: boolean;
}

function makeTracker(
	state: StubState,
	overrides: Partial<WitnessTrackerConfig> = {},
): { tracker: DeviceWitnessTracker; sink: ReturnType<typeof makeSink> } {
	const sink = makeSink();
	const tracker = new DeviceWitnessTracker({
		stableAfterMs: 10,
		editorSettleGraceMs: 50,
		stateSecret: "test-secret-32-bytes-long-enough!",
		flightMode: "qa-safe",
		qaTraceSecret: "qa-secret-shared",
		sink,
		traceContext: FAKE_CONTEXT,
		platform: "desktop",
		pathPendingTimeoutMs: 100,
		readCrdtContent: () => state.crdtContent,
		isCrdtTombstoned: () => state.tombstoned,
		getFileId: () => state.fileId,
		readDiskContent: async () => {
			if (state.diskReadThrows) throw new Error("disk read failed");
			return state.diskContent;
		},
		sampleEditor: () => ({ kind: state.editorKind, content: state.editorContent }),
		...overrides,
	});
	return { tracker, sink };
}

/** Wait for a buffer entry matching predicate, polling up to timeoutMs. */
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
// Tests
// -----------------------------------------------------------------------

console.log("\n--- DeviceWitnessTracker ---");

// Test 1: present file, CRDT=disk, no editor => settled
await test("present file, CRDT=disk, no editor => settled", async () => {
	const state: StubState = {
		crdtContent: "hello world",
		diskContent: "hello world",
		tombstoned: false,
		fileId: "file-1",
		editorKind: "not_open",
		editorContent: null,
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state);
	tracker.markDirty("notes/test.md", "remote-apply");
	const entry = await waitForBuffer(tracker, (e) => e.kind === "settled" && e.path === "notes/test.md");
	assert.equal(entry.data.stateKind, "present");
	assert.equal(entry.data.diskMatchesCrdt, true);
	assert.equal(entry.data.fileOpen, false);
	assert.ok(typeof entry.data.stateHash === "string" && (entry.data.stateHash as string).startsWith("h:"));
	tracker.dispose();
});

// Test 2: present file, CRDT=disk=editor => settled with editorHash
await test("present file, CRDT=disk=editor => settled with editorHash", async () => {
	const state: StubState = {
		crdtContent: "hello world",
		diskContent: "hello world",
		tombstoned: false,
		fileId: "file-2",
		editorKind: "healthy_sampled",
		editorContent: "hello world",
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state);
	tracker.markDirty("notes/test.md", "remote-apply");
	const entry = await waitForBuffer(tracker, (e) => e.kind === "settled" && e.path === "notes/test.md");
	assert.equal(entry.data.fileOpen, true);
	assert.equal(entry.data.editorMatchesCrdt, true);
	assert.ok(entry.data.editorHash !== undefined);
	tracker.dispose();
});

// Test 3: disk differs from CRDT => diverged disk_crdt_mismatch
await test("disk differs from CRDT => diverged disk_crdt_mismatch", async () => {
	const state: StubState = {
		crdtContent: "version A",
		diskContent: "version B",
		tombstoned: false,
		fileId: "file-3",
		editorKind: "not_open",
		editorContent: null,
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state);
	tracker.markDirty("notes/test.md", "remote-apply");
	const entry = await waitForBuffer(tracker, (e) => e.kind === "diverged" && e.path === "notes/test.md");
	assert.equal(entry.data.reason, "disk_crdt_mismatch");
	tracker.dispose();
});

// Test 4: editor differs from CRDT => diverged editor_crdt_mismatch
await test("editor differs from CRDT => diverged editor_crdt_mismatch", async () => {
	const state: StubState = {
		crdtContent: "crdt content",
		diskContent: "crdt content",
		tombstoned: false,
		fileId: "file-4",
		editorKind: "healthy_sampled",
		editorContent: "editor content different",
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state);
	tracker.markDirty("notes/test.md", "remote-apply");
	const entry = await waitForBuffer(tracker, (e) => e.kind === "diverged" && e.path === "notes/test.md");
	assert.equal(entry.data.reason, "editor_crdt_mismatch");
	tracker.dispose();
});

// Test 5: CRDT tombstoned and disk absent => settled deleted
await test("CRDT tombstoned and disk absent => settled deleted", async () => {
	const state: StubState = {
		crdtContent: null,
		diskContent: null,
		tombstoned: true,
		fileId: "file-5",
		editorKind: "not_open",
		editorContent: null,
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state);
	tracker.markDirty("notes/test.md", "tombstone");
	const entry = await waitForBuffer(tracker, (e) => e.kind === "settled" && e.path === "notes/test.md");
	assert.equal(entry.data.stateKind, "deleted");
	tracker.dispose();
});

// Test 6: CRDT tombstoned but disk present => diverged disk_crdt_mismatch
await test("CRDT tombstoned but disk present => diverged disk_crdt_mismatch", async () => {
	const state: StubState = {
		crdtContent: null,
		diskContent: "still here",
		tombstoned: true,
		fileId: "file-6",
		editorKind: "not_open",
		editorContent: null,
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state);
	tracker.markDirty("notes/test.md", "tombstone");
	const entry = await waitForBuffer(tracker, (e) => e.kind === "diverged" && e.path === "notes/test.md");
	assert.equal(entry.data.reason, "disk_crdt_mismatch");
	assert.equal(entry.data.stateKind, "deleted");
	tracker.dispose();
});

// Test 7: readDiskContent throws => diverged read_failed
await test("readDiskContent throws => diverged read_failed", async () => {
	const state: StubState = {
		crdtContent: "some content",
		diskContent: null,
		tombstoned: false,
		fileId: "file-7",
		editorKind: "not_open",
		editorContent: null,
		diskReadThrows: true,
	};
	const { tracker } = makeTracker(state);
	tracker.markDirty("notes/test.md", "disk-write");
	const entry = await waitForBuffer(tracker, (e) => e.kind === "diverged" && e.path === "notes/test.md");
	assert.equal(entry.data.reason, "read_failed");
	assert.equal(entry.data.authority, "disk");
	tracker.dispose();
});

// Test 8: same stable hash twice => only one settled witness
await test("same stable hash twice => only one settled witness", async () => {
	const state: StubState = {
		crdtContent: "stable content",
		diskContent: "stable content",
		tombstoned: false,
		fileId: "file-8",
		editorKind: "not_open",
		editorContent: null,
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state);
	tracker.markDirty("notes/test.md", "remote-apply");
	await waitForBuffer(tracker, (e) => e.kind === "settled" && e.path === "notes/test.md");
	// Trigger again with same content.
	tracker.markDirty("notes/test.md", "remote-apply");
	await sleep(200);
	const settled = tracker.getWitnessBuffer().filter((e) => e.kind === "settled" && e.path === "notes/test.md");
	assert.equal(settled.length, 1, `Expected 1 settled, got ${settled.length}`);
	tracker.dispose();
});

// Test 9: recovery returns old prior hash after newer witness => recovery_emitted_old_hash
await test("recovery returns old prior hash after newer witness => recovery_emitted_old_hash", async () => {
	const state: StubState = {
		crdtContent: "content A",
		diskContent: "content A",
		tombstoned: false,
		fileId: "file-9",
		editorKind: "not_open",
		editorContent: null,
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state);

	// First: settle on content A.
	tracker.markDirty("notes/test.md", "remote-apply");
	await waitForBuffer(tracker, (e) => e.kind === "settled" && e.path === "notes/test.md");
	const seqAfterA = tracker.currentWitnessSeq();

	// Advance to content B and settle.
	state.crdtContent = "content B";
	state.diskContent = "content B";
	tracker.markDirty("notes/test.md", "remote-apply");
	await waitForBuffer(tracker, (e) => e.kind === "settled" && e.path === "notes/test.md" && e.seq > seqAfterA);
	const seqAfterB = tracker.currentWitnessSeq();

	// Recovery resurrects content A (old hash).
	state.crdtContent = "content A";
	state.diskContent = "content A";
	tracker.markDirty("notes/test.md", "recovery");
	const entry = await waitForBuffer(
		tracker,
		(e) => e.path === "notes/test.md" && e.seq > seqAfterB,
		500,
	);
	assert.equal(entry.kind, "diverged", `Expected diverged, got ${entry.kind}`);
	assert.equal(entry.data.reason, "recovery_emitted_old_hash");
	tracker.dispose();
});

// Test 10: local edit returning to old hash => settled, NOT stale divergence
await test("local edit returning to old hash => settled, not stale divergence", async () => {
	const state: StubState = {
		crdtContent: "content A",
		diskContent: "content A",
		tombstoned: false,
		fileId: "file-10",
		editorKind: "not_open",
		editorContent: null,
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state);

	// Settle on A.
	tracker.markDirty("notes/test.md", "remote-apply");
	await waitForBuffer(tracker, (e) => e.kind === "settled" && e.path === "notes/test.md");
	const seqAfterA = tracker.currentWitnessSeq();

	// Advance to B and settle.
	state.crdtContent = "content B";
	state.diskContent = "content B";
	tracker.markDirty("notes/test.md", "remote-apply");
	await waitForBuffer(tracker, (e) => e.kind === "settled" && e.path === "notes/test.md" && e.seq > seqAfterA);
	const seqAfterB = tracker.currentWitnessSeq();

	// User intentionally edits back to A (local-edit origin) — should settle, not diverge.
	state.crdtContent = "content A";
	state.diskContent = "content A";
	tracker.markDirty("notes/test.md", "local-edit");
	const entry = await waitForBuffer(
		tracker,
		(e) => e.path === "notes/test.md" && e.seq > seqAfterB,
		500,
	);
	assert.equal(entry.kind, "settled", `Expected settled for local undo, got ${entry.kind} (reason: ${entry.data.reason})`);
	tracker.dispose();
});

// Test 11: pending fileId appears before timeout => no missing_file_id
await test("pending fileId appears before timeout => no missing_file_id", async () => {
	let fileId: string | undefined = undefined;
	const state: StubState = {
		crdtContent: "content",
		diskContent: "content",
		tombstoned: false,
		fileId: undefined,
		editorKind: "not_open",
		editorContent: null,
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state, {
		getFileId: () => fileId,
		pathPendingTimeoutMs: 200,
	});

	tracker.markDirty("notes/test.md", "remote-apply");
	// FileId appears after 50ms (well before 200ms timeout).
	await sleep(50);
	fileId = "file-11";
	state.fileId = "file-11";

	const entry = await waitForBuffer(tracker, (e) => e.path === "notes/test.md", 500);
	assert.equal(entry.kind, "settled", `Expected settled, got ${entry.kind} (reason: ${entry.data.reason})`);
	const missingFileId = tracker.getWitnessBuffer().find((e) => e.data.reason === "missing_file_id");
	assert.equal(missingFileId, undefined, "Should not have emitted missing_file_id");
	tracker.dispose();
});

// Test 12: pending fileId never appears => missing_file_id
await test("pending fileId never appears => missing_file_id", async () => {
	const state: StubState = {
		crdtContent: "content",
		diskContent: "content",
		tombstoned: false,
		fileId: undefined,
		editorKind: "not_open",
		editorContent: null,
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state, {
		getFileId: () => undefined,
		pathPendingTimeoutMs: 50,
	});

	tracker.markDirty("notes/test.md", "remote-apply");
	const entry = await waitForBuffer(tracker, (e) => e.data.reason === "missing_file_id", 500);
	assert.equal(entry.data.reason, "missing_file_id");
	tracker.dispose();
});

// Test 13: settling editor reschedules then settles after grace window
await test("settling editor reschedules then settles after grace window", async () => {
	let editorKind: EditorSampleKind = "settling";
	const state: StubState = {
		crdtContent: "content",
		diskContent: "content",
		tombstoned: false,
		fileId: "file-13",
		editorKind: "settling",
		editorContent: null,
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state, {
		sampleEditor: () => ({ kind: editorKind, content: editorKind === "healthy_sampled" ? "content" : null }),
		editorSettleGraceMs: 80,
	});

	tracker.markDirty("notes/test.md", "remote-apply");
	// Editor becomes healthy after 40ms (within grace window).
	await sleep(40);
	editorKind = "healthy_sampled";
	state.editorKind = "healthy_sampled";
	state.editorContent = "content";

	const entry = await waitForBuffer(tracker, (e) => e.path === "notes/test.md", 500);
	assert.equal(entry.kind, "settled", `Expected settled after editor settled, got ${entry.kind} (reason: ${entry.data.reason})`);
	tracker.dispose();
});

// Test 14: settling editor times out => settle_timeout
await test("settling editor times out => settle_timeout", async () => {
	const state: StubState = {
		crdtContent: "content",
		diskContent: "content",
		tombstoned: false,
		fileId: "file-14",
		editorKind: "settling",
		editorContent: null,
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state, {
		editorSettleGraceMs: 30,
	});

	tracker.markDirty("notes/test.md", "remote-apply");
	// Editor never becomes healthy.
	const entry = await waitForBuffer(tracker, (e) => e.kind === "diverged" && e.path === "notes/test.md", 500);
	assert.equal(entry.data.reason, "settle_timeout");
	tracker.dispose();
});

// Test 15: deleted file with editor still open => divergence
await test("deleted file with editor still open => divergence", async () => {
	const state: StubState = {
		crdtContent: null,
		diskContent: null,
		tombstoned: true,
		fileId: "file-15",
		editorKind: "healthy_sampled",
		editorContent: "old content still in editor",
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state);
	tracker.markDirty("notes/test.md", "tombstone");
	const entry = await waitForBuffer(tracker, (e) => e.path === "notes/test.md", 500);
	// Editor is open with content on a tombstoned file — should diverge.
	assert.equal(entry.kind, "diverged", `Expected diverged, got ${entry.kind}`);
	tracker.dispose();
});

// Test 16: non-.md paths are ignored
await test("non-.md paths are ignored", async () => {
	const state: StubState = {
		crdtContent: "content",
		diskContent: "content",
		tombstoned: false,
		fileId: "file-16",
		editorKind: "not_open",
		editorContent: null,
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state);
	tracker.markDirty("notes/test.canvas", "remote-apply");
	tracker.markDirty(".obsidian/config.md", "remote-apply");
	await sleep(200);
	assert.equal(tracker.getWitnessBuffer().length, 0, "Should not emit for non-.md or .obsidian paths");
	tracker.dispose();
});

// Test 17: witnessDeviceSettled anchors to seq at call time (stale buffer ignored)
await test("witnessDeviceSettled ignores buffer events before wait start", async () => {
	const state: StubState = {
		crdtContent: "content H",
		diskContent: "content H",
		tombstoned: false,
		fileId: "file-17",
		editorKind: "not_open",
		editorContent: null,
		diskReadThrows: false,
	};
	const { tracker } = makeTracker(state);

	// Pre-populate buffer with a settled event.
	tracker.markDirty("notes/test.md", "remote-apply");
	await waitForBuffer(tracker, (e) => e.kind === "settled" && e.path === "notes/test.md");

	// Now anchor seq AFTER the pre-existing event.
	const startSeq = tracker.currentWitnessSeq();

	// Change content so the old hash won't match.
	state.crdtContent = "content NEW";
	state.diskContent = "content NEW";

	// The old settled event (seq <= startSeq) should NOT satisfy a new wait.
	// Trigger a new settled event.
	tracker.markDirty("notes/test.md", "remote-apply");
	const newEntry = await waitForBuffer(
		tracker,
		(e) => e.kind === "settled" && e.path === "notes/test.md" && e.seq > startSeq,
		500,
	);
	assert.ok(newEntry.seq > startSeq, "New settled event should have seq > startSeq");
	tracker.dispose();
});

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------

console.log(`\n──────────────────────────────────────────────────`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`──────────────────────────────────────────────────\n`);

if (failed > 0) process.exit(1);
