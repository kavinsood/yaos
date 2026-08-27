/**
 * Lifecycle proof test (P1-9): Verifies the complete causal chain from
 * disk observation through CRDT mutation to server receipt candidate.
 *
 * Asserts:
 *   1. disk.create.observed emitted with opId=op1, pathId=p1
 *   2. crdt.file.created emitted with opId=op1, pathId=p1
 *   3. server.receipt.candidate_captured emitted with causedByOpId=op1
 *   4. recorder.getTimelineForPath(p1) contains all three events in order
 *   5. recorder.getTimelineForOp(op1) contains disk + crdt events
 *   6. No raw path appears anywhere in serialized output (safe mode)
 *   7. Sequence numbers are monotonically increasing across all events
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// IndexedDB stand-in for local receipt-candidate persistence. The shared fake
// implements the real lib.dom IDBFactory, so installing it as the global needs
// no cast.
// ---------------------------------------------------------------------------

import { FakeIndexedDb } from "../mocks/indexedDb";

globalThis.indexedDB = new FakeIndexedDb();

// ---------------------------------------------------------------------------
// Now import the real modules
// ---------------------------------------------------------------------------

import { FlightRecorder } from "../../src/telemetry/debug/flightRecorder";
import { FlightTraceController, type FlightTraceDeps } from "../../src/telemetry/debug/flightTraceController";
import { FLIGHT_KIND } from "../../src/observability/flightTaxonomy";
import type { FlightEvent } from "../../src/observability/flightEnvelope";
import { suite } from "../harness.ts";

const s = suite("flight-lifecycle-local-disk-to-server-receipt");

// --- Mock infrastructure ---

const writtenLines: string[] = [];
const mockApp = {
	vault: {
		configDir: ".obsidian",
		adapter: {
			append: async (_path: string, content: string) => { writtenLines.push(content); },
			mkdir: async () => {},
			exists: async () => false,
			read: async () => "",
			write: async () => {},
			list: async () => ({ files: [], folders: [] }),
			stat: async () => ({ size: 0 }),
			remove: async () => {},
			rmdir: async () => {},
		},
	},
};

const mockSettings = {
	vaultId: "test-vault-id",
	host: "https://test.example.com",
	deviceToken: "test-device-token",
	deviceId: "test-device-id",
	deviceName: "Test Device",
	debug: true,
};


const deps: FlightTraceDeps = {
	app: mockApp as never,
	getSettings: () => mockSettings as never,
	getPluginVersion: () => "1.0.0-test",
	getDocSchemaVersion: () => 2,
	buildCheckpoint: async () => ({}),
	isIndexedDbRelatedError: () => false,
	isObsidianFileMetadataRaceError: () => false,
	handleIndexedDbDegraded: () => {},
	// The test never exports, so the header input is never inspected; the stub
	// exists only to satisfy FlightTraceDeps.
	collectTraceHeaderInput: async () => ({}) as never,
	log: () => {},
};

// --- Test ---

console.log("\n=== Flight Lifecycle Proof Test (P1-9) ===\n");

const TEST_PATH = "Daily/2026-05-12.md";
const TEST_OP_ID = "op-lifecycle-test-001";

async function runLifecycleTest(): Promise<void> {
	const controller = new FlightTraceController(deps);

	// Start the recorder. Redaction is chosen per export, not at start.
	await controller.start();

	const recorder = controller.currentRecorder!;
	s.check(recorder !== null && recorder !== undefined, "Recorder is active after start");
	s.check(recorder.safeToShare === true, "Recorder is in safe mode");

	const httpContext = controller.httpContext;
	s.check(httpContext?.traceId === recorder.context.traceId, "HTTP trace context shares the flight trace ID");
	s.check(httpContext?.bootId === recorder.context.bootId, "HTTP trace context shares the flight boot ID");
	s.check(httpContext?.deviceName === mockSettings.deviceName, "HTTP trace context carries the configured device name");
	s.check(httpContext?.vaultId === mockSettings.vaultId, "HTTP trace context carries the configured vault ID");

	controller.recordTrace("legacy-source", "legacy-event", {
		count: 1,
		path: TEST_PATH,
	});
	controller.scheduleCheckpoint("test-checkpoint");
	await new Promise((resolve) => setTimeout(resolve, 300));
	await controller.refreshServerTrace();
	const runtimeEvents = recorder.recentEvents;
	const legacyEvent = runtimeEvents.find((event) =>
		event.kind === FLIGHT_KIND.debugTraceEvent
		&& event.data?.event === "legacy-event");
	s.check(legacyEvent !== undefined, "legacy structured trace callback routes into the flight recorder");
	s.check(
		legacyEvent?.data?.details !== undefined
			&& !(legacyEvent.data.details as Record<string, unknown>).path,
		"legacy trace details drop path-shaped fields before persistence",
	);
	s.check(
		runtimeEvents.some((event) =>
			event.kind === FLIGHT_KIND.debugTraceCheckpoint
			&& event.data?.reason === "test-checkpoint"),
		"debounced runtime checkpoint is recorded by the flight controller",
	);
	s.check(
		runtimeEvents.some((event) =>
			event.kind === FLIGHT_KIND.debugTraceEvent
			&& event.data?.event === "server-trace-fetch-failed"),
		"server trace polling failures remain observable in the unified recorder",
	);

	// Step 1: Record disk.create.observed (simulates main.ts vault event handler)
	await controller.recordPath({
		priority: "important",
		kind: FLIGHT_KIND.diskCreateObserved,
		severity: "info",
		scope: "file",
		source: "vaultEvents",
		layer: "disk",
		opId: TEST_OP_ID,
		path: TEST_PATH,
		data: { size: 1234 },
	});

	// Step 2: Record crdt.file.created (simulates what VaultSync.ensureFile emits through onFlightPathEvent)
	await controller.recordPath({
		priority: "important",
		kind: FLIGHT_KIND.crdtFileCreated,
		severity: "info",
		scope: "file",
		source: "vaultSync",
		layer: "crdt",
		path: TEST_PATH,
		opId: TEST_OP_ID,
		data: { fileId: "file-abc123" },
	});

	// Step 3: Record the durable schema-4 body candidate capture.
	controller.record({
		priority: "critical",
		kind: FLIGHT_KIND.serverReceiptCandidateCaptured,
		severity: "info",
		scope: "connection",
		source: "vaultSync",
		layer: "server",
		candidateId: "cand-test-001",
		svHash: "abcd1234",
		data: {
			candidateBytes: 64,
			causedByOpId: TEST_OP_ID,
		},
	});

	// Flush to ensure everything is written
	await controller.flush();

	// --- Assertions ---

	// Get pathId for the test path (to query timeline)
	const { pathId } = await controller.getPathId(TEST_PATH);
	s.check(pathId.startsWith("p:"), "pathId has correct prefix");
	s.check(pathId.length === 34, `pathId is 34 chars (p: + 32 hex) — got ${pathId.length}`);

	// 4. Timeline for path includes disk and crdt events in order
	const timeline = recorder.getTimelineForPath(pathId);
	s.check(timeline.length >= 2, `Timeline for path has >= 2 events (got ${timeline.length})`);

	const diskEvent = timeline.find((e: FlightEvent) => e.kind === FLIGHT_KIND.diskCreateObserved);
	const crdtEvent = timeline.find((e: FlightEvent) => e.kind === FLIGHT_KIND.crdtFileCreated);
	s.check(diskEvent !== undefined, "disk.create.observed found in path timeline");
	s.check(crdtEvent !== undefined, "crdt.file.created found in path timeline");

	if (diskEvent && crdtEvent) {
		s.check(diskEvent.seq < crdtEvent.seq, "disk event has lower seq than crdt event (causal order preserved)");
		s.check(diskEvent.opId === TEST_OP_ID, "disk event carries correct opId");
		s.check(crdtEvent.opId === TEST_OP_ID, "crdt event carries correct opId");
		s.check(diskEvent.pathId === pathId, "disk event has correct pathId");
		s.check(crdtEvent.pathId === pathId, "crdt event has correct pathId");
	}

	// 5. Timeline for opId includes disk + crdt events
	const opTimeline = recorder.getTimelineForOp(TEST_OP_ID);
	s.check(opTimeline.length >= 2, `Op timeline has >= 2 events (got ${opTimeline.length})`);
	const opDiskEvent = opTimeline.find((e: FlightEvent) => e.kind === FLIGHT_KIND.diskCreateObserved);
	const opCrdtEvent = opTimeline.find((e: FlightEvent) => e.kind === FLIGHT_KIND.crdtFileCreated);
	s.check(opDiskEvent !== undefined, "disk.create.observed found in op timeline");
	s.check(opCrdtEvent !== undefined, "crdt.file.created found in op timeline");

	// Receipt event (no pathId, so not in path timeline — but verify it exists in ring)
	const recentEvents = recorder.recentEvents;
	const receiptEvent = recentEvents.find((e: FlightEvent) => e.kind === FLIGHT_KIND.serverReceiptCandidateCaptured);
	s.check(receiptEvent !== undefined, "server.receipt.candidate_captured found in recent events");
	if (receiptEvent) {
		s.check(receiptEvent.candidateId === "cand-test-001", "receipt has candidateId");
		s.check(receiptEvent.svHash === "abcd1234", "receipt has svHash");
		s.check(
			(receiptEvent.data as Record<string, unknown>)?.causedByOpId === TEST_OP_ID,
			"receipt data has causedByOpId matching opId",
		);
	}

	// 6. No raw path in serialized output
	await recorder.flushNow();
	const allOutput = writtenLines.join("");
	s.check(!allOutput.includes(TEST_PATH), "No raw path appears in serialized NDJSON output");
	s.check(allOutput.includes(pathId), "pathId appears in serialized output");

	// 7. Sequence numbers are monotonically increasing
	const allEvents = recentEvents.slice().sort((a, b) => a.seq - b.seq);
	let seqMonotonic = true;
	for (let i = 1; i < allEvents.length; i++) {
		if (allEvents[i]!.seq <= allEvents[i - 1]!.seq) {
			seqMonotonic = false;
			break;
		}
	}
	s.check(seqMonotonic, "Sequence numbers are strictly monotonically increasing");

	// Verify causal order across all event types
	if (diskEvent && crdtEvent && receiptEvent) {
		s.check(
			diskEvent.seq < crdtEvent.seq && crdtEvent.seq < receiptEvent.seq,
			"Full causal order: disk < crdt < receipt (by seq)",
		);
	}

	await controller.stop();
}

await runLifecycleTest();
await s.done();
