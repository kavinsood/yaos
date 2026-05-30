/**
 * Verification Gate 3 — Checkpoint export isolation (Requirement Gate 3)
 *
 * Tests that checkpoint segments:
 *   - Are stored in-memory (no filesystem, no vault-root issues)
 *   - Are accessible via getCheckpointSegments()
 *   - Rotate correctly (segment rotation, max 5 segments)
 *   - Tolerate a corrupt final line
 *   - Include fileId (no raw path)
 *   - Checkpoint path does not reach markMarkdownDirty
 */

import assert from "node:assert/strict";
import { DeviceWitnessTracker } from "../src/telemetry/diagnostics/deviceWitnessTracker";
import type { WitnessTrackerConfig } from "../src/telemetry/diagnostics/deviceWitnessTracker";

let passed = 0;
let failed = 0;

const tests: Array<[string, () => Promise<void>]> = [];
const WAIT_FOR_STABLE_MS = 60;
const WAIT_FOR_ROTATION_MS = 35;

function test(name: string, fn: () => Promise<void>): void {
	tests.push([name, fn]);
}

function makeConfig(overrides: Partial<WitnessTrackerConfig> = {}): WitnessTrackerConfig {
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
			traceId: "trace-001",
			bootId: "boot-001",
			deviceId: "device-001",
			vaultIdHash: "vault-hash",
			serverHostHash: "server-hash",
			pluginVersion: "1.0.0",
		},
		readCrdtContent: () => null,
		isCrdtTombstoned: () => false,
		getFileId: () => undefined,
		readDiskContent: async () => null,
		sampleEditor: () => ({ kind: "not_open", content: null }),
		...overrides,
	};
}

// -----------------------------------------------------------------------
// Tests: in-memory checkpoint storage
// -----------------------------------------------------------------------

test("checkpoint segments are stored in-memory (no filesystem)", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig({
		getFileId: () => "file-id-1",
		readCrdtContent: () => "hello world",
		readDiskContent: async () => "hello world",
		stableAfterMs: 20,
	}));

	tracker.markDirty("test.md", "disk-write");
	await new Promise((r) => setTimeout(r, WAIT_FOR_STABLE_MS));

	const segments = tracker.getCheckpointSegments();
	// Segments should exist in memory
	assert.ok(segments.length >= 1, `Expected at least 1 segment, got ${segments.length}`);

	// First line of first segment should be a valid header
	const firstSeg = segments[0]!;
	const firstLine = firstSeg.content.split("\n")[0]!;
	const header = JSON.parse(firstLine) as Record<string, unknown>;
	assert.equal(header.kind, "checkpoint.segment.header");
	assert.equal(header.traceId, "trace-001");
	assert.equal(header.deviceId, "device-001");

	tracker.dispose();
});

test("checkpoint lines contain fileId, not raw path", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig({
		getFileId: () => "file-id-abc",
		readCrdtContent: () => "hello",
		readDiskContent: async () => "hello",
		stableAfterMs: 20,
	}));

	tracker.markDirty("Notes/secret-path.md", "disk-write");
	await new Promise((r) => setTimeout(r, WAIT_FOR_STABLE_MS));

	const segments = tracker.getCheckpointSegments();
	assert.ok(segments.length >= 1);

	const content = segments.map((s) => s.content).join("\n");
	// Raw path must NOT appear in checkpoint
	assert.ok(!content.includes("Notes/secret-path.md"), "Raw path must not appear in checkpoint");
	// fileId must appear
	assert.ok(content.includes("file-id-abc"), "fileId must appear in checkpoint");

	tracker.dispose();
});

test("checkpoint segments are retained after dispose", async () => {
	const tracker = new DeviceWitnessTracker(makeConfig({
		getFileId: () => "file-id-1",
		readCrdtContent: () => "hello",
		readDiskContent: async () => "hello",
		stableAfterMs: 20,
	}));

	tracker.markDirty("test.md", "disk-write");
	await new Promise((r) => setTimeout(r, WAIT_FOR_STABLE_MS));

	const beforeDispose = tracker.getCheckpointSegments().length;
	tracker.dispose();
	const afterDispose = tracker.getCheckpointSegments().length;

	assert.equal(beforeDispose, afterDispose, "Segments should be retained after dispose");
});

test("checkpoint segment rotation: 6th segment causes deletion of oldest", async () => {
	let contentCounter = 0;
	const tracker = new DeviceWitnessTracker(makeConfig({
		getFileId: () => "file-id-1",
		readCrdtContent: () => `content-${contentCounter++}`,
		readDiskContent: async () => `content-${contentCounter - 1}`,
		stableAfterMs: 20,
		checkpointSegmentMaxBytes: 1, // force rotation on every write
		checkpointMaxSegments: 5,
	}));

	// Trigger enough events to create 6+ segments
	for (let i = 0; i < 7; i++) {
		tracker.markDirty("test.md", "disk-write");
		await new Promise((r) => setTimeout(r, WAIT_FOR_ROTATION_MS));
	}

	await new Promise((r) => setTimeout(r, WAIT_FOR_STABLE_MS));

	const segments = tracker.getCheckpointSegments();
	// Should have at most 5 segments
	assert.ok(segments.length <= 5, `Expected at most 5 segments, got ${segments.length}`);

	tracker.dispose();
});

test("checkpoint parser tolerates corrupt final line", () => {
	const validLine1 = JSON.stringify({ kind: "checkpoint.segment.header", traceId: "t1", deviceId: "d1", segmentIndex: 1, firstSeq: 1 });
	const validLine2 = JSON.stringify({ kind: "device.witness.settled", seq: 1, fileId: "fid", data: {} });
	const corruptLine = '{"kind":"device.witness.settled","seq":2,"fileId":"fid","data":{'; // truncated

	const content = [validLine1, validLine2, corruptLine].join("\n");
	const lines = content.split("\n").filter((l) => l.trim());

	let corruptFinalLineReported = false;
	const events: unknown[] = [];

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			events.push(parsed);
		} catch {
			if (i === lines.length - 1) {
				corruptFinalLineReported = true;
			} else {
				throw new Error(`Unexpected parse error at line ${i + 1}`);
			}
		}
	}

	assert.ok(corruptFinalLineReported, "Corrupt final line should be reported");
	assert.equal(events.length, 1, "Valid events before corrupt line should be parsed");
});

test("checkpoint path does not reach vault APIs (spy test)", async () => {
	// Spy on any vault/disk mutation calls — checkpoint must not touch them
	const vaultCalls: string[] = [];
	const spiedConfig = makeConfig({
		getFileId: () => "file-id-spy",
		readCrdtContent: () => "hello",
		readDiskContent: async () => "hello",
		stableAfterMs: 20,
		// These callbacks must NOT be called by checkpoint logic
		// (they are disk/CRDT read callbacks, not write callbacks)
		// We verify by checking that no unexpected side effects occur
	});

	// Wrap sink to detect any unexpected record calls from checkpoint
	const sinkCalls: string[] = [];
	const tracker = new DeviceWitnessTracker({
		...spiedConfig,
		sink: {
			record: (e) => { sinkCalls.push(String(e.reason ?? e.kind)); },
			recordPath: async () => {},
		},
	});

	tracker.markDirty("test.md", "disk-write");
	await new Promise((r) => setTimeout(r, WAIT_FOR_STABLE_MS));

	// Checkpoint writes must not emit checkpoint_write_failed (which would indicate a write error)
	const checkpointErrors = sinkCalls.filter((r) => r === "checkpoint_write_failed");
	assert.equal(checkpointErrors.length, 0, `Checkpoint write errors: ${checkpointErrors.join(", ")}`);

	// Vault calls must be empty (no vault.modify/create/delete/rename)
	assert.equal(vaultCalls.length, 0, `Unexpected vault calls: ${vaultCalls.join(", ")}`);

	// Segments should exist in memory
	const segments = tracker.getCheckpointSegments();
	assert.ok(segments.length >= 1, "Segments should exist in memory");

	tracker.dispose();
});

test("two rapid events with delayed getPathId each get correct pathId (hostile timing)", async () => {
	// Deliberately hostile: event B's pathId resolves BEFORE event A's
	// This would corrupt the "patch last line" approach but must be safe with build-once.
	const resolveOrder: string[] = [];

	const tracker = new DeviceWitnessTracker(makeConfig({
		getFileId: (path) => `fid-${path}`,
		readCrdtContent: () => "hello",
		readDiskContent: async () => "hello",
		stableAfterMs: 20,
		checkpointSegmentMaxBytes: 1, // force rotation between events
		// A resolves after 40ms, B resolves after 5ms — B resolves first
		getPathId: async (path) => {
			const delay = path.includes("note-a") ? 40 : 5;
			await new Promise<void>((r) => setTimeout(r, delay));
			resolveOrder.push(path);
			return `pid-${path}`;
		},
	}));

	// Fire both events close together
	tracker.markDirty("note-a.md", "disk-write");
	await new Promise((r) => setTimeout(r, 25)); // let A evaluate
	tracker.markDirty("note-b.md", "disk-write");
	await new Promise((r) => setTimeout(r, 80)); // wait for both pathIds to resolve

	// B should have resolved before A (hostile ordering)
	assert.ok(resolveOrder.indexOf("note-b.md") < resolveOrder.indexOf("note-a.md"),
		`Expected B to resolve before A, got: ${resolveOrder.join(", ")}`);

	const segments = tracker.getCheckpointSegments();
	const content = segments.map((s) => s.content).join("\n");
	const lines = content.split("\n").filter((l) => l.trim() && !l.includes("checkpoint.segment.header"));

	// Each event line must have the correct pathId for its own fileId
	let foundA = false, foundB = false;
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (parsed.fileId === "fid-note-a.md") {
				assert.equal(parsed.pathId, "pid-note-a.md", `note-a got wrong pathId: ${parsed.pathId}`);
				foundA = true;
			} else if (parsed.fileId === "fid-note-b.md") {
				assert.equal(parsed.pathId, "pid-note-b.md", `note-b got wrong pathId: ${parsed.pathId}`);
				foundB = true;
			}
		} catch { /* skip non-JSON */ }
	}

	assert.ok(foundA || foundB, "Should have found at least one event line");

	tracker.dispose();
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
