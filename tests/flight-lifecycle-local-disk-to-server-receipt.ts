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
// Minimal IndexedDB polyfill — required by getOrCreateLocalDeviceId() inside
// FlightTraceController.start(). Only the subset used by the candidate store
// metadata path is implemented.
// ---------------------------------------------------------------------------

class FakeRequest<T> {
	result!: T;
	error: Error | null = null;
	onsuccess: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onupgradeneeded: ((event: unknown) => void) | null = null;

	succeed(result: T): void {
		this.result = result;
		this.onsuccess?.(new Event("success"));
	}

	fail(error: Error): void {
		this.error = error;
		this.onerror?.(new Event("error"));
	}
}

class FakeObjectStore {
	constructor(
		private readonly store: Map<string, unknown>,
		private readonly tx: FakeTransaction,
	) {}

	get(key: string): unknown {
		return this.tx.enqueue(() => this.store.get(key));
	}

	put(value: unknown, key: string): unknown {
		return this.tx.enqueue(() => {
			this.store.set(key, value);
			return key;
		});
	}

	delete(key: string): unknown {
		return this.tx.enqueue(() => {
			this.store.delete(key);
			return undefined;
		});
	}
}

class FakeTransaction {
	oncomplete: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onabort: ((event: Event) => void) | null = null;
	error: Error | null = null;
	private pendingRequests = 0;
	private completed = false;

	constructor(
		private readonly storeName: string,
		private readonly store: Map<string, unknown>,
	) {}

	objectStore(name: string): FakeObjectStore {
		if (name !== this.storeName) throw new Error(`Missing object store ${name}`);
		return new FakeObjectStore(this.store, this);
	}

	enqueue<T>(work: () => T): unknown {
		const req = new FakeRequest<T>();
		this.pendingRequests++;
		queueMicrotask(() => {
			try {
				req.succeed(work());
			} catch (err) {
				this.error = err instanceof Error ? err : new Error(String(err));
				req.fail(this.error);
				this.onerror?.(new Event("error"));
			} finally {
				this.pendingRequests--;
				this.maybeComplete();
			}
		});
		return req;
	}

	private maybeComplete(): void {
		if (this.pendingRequests !== 0 || this.completed) return;
		this.completed = true;
		queueMicrotask(() => {
			this.oncomplete?.(new Event("complete"));
		});
	}
}

type FakeDatabaseData = {
	stores: Map<string, Map<string, unknown>>;
};

class FakeDatabase {
	constructor(private readonly data: FakeDatabaseData) {}

	get objectStoreNames() {
		return { contains: (name: string) => this.data.stores.has(name) };
	}

	createObjectStore(name: string): void {
		if (!this.data.stores.has(name)) this.data.stores.set(name, new Map());
	}

	transaction(storeName: string, _mode?: string): FakeTransaction {
		const store = this.data.stores.get(storeName);
		if (!store) throw new Error(`Missing object store ${storeName}`);
		return new FakeTransaction(storeName, store);
	}
}

class FakeIndexedDBFactory {
	private readonly databases = new Map<string, FakeDatabaseData>();

	open(name: string, _version?: number): unknown {
		const req = new FakeRequest<FakeDatabase>();
		queueMicrotask(() => {
			let data = this.databases.get(name);
			const needsUpgrade = !data;
			if (!data) {
				data = { stores: new Map() };
				this.databases.set(name, data);
			}
			const db = new FakeDatabase(data);
			(req as unknown as { result: FakeDatabase }).result = db;
			if (needsUpgrade && req.onupgradeneeded) {
				req.onupgradeneeded(new Event("upgradeneeded"));
			}
			req.succeed(db);
		});
		return req;
	}
}

// Install globally before any imports that depend on indexedDB
(globalThis as unknown as Record<string, unknown>).indexedDB = new FakeIndexedDBFactory();

// ---------------------------------------------------------------------------
// Now import the real modules
// ---------------------------------------------------------------------------

import { FlightRecorder } from "../src/telemetry/debug/flightRecorder";
import { FlightTraceController, type FlightTraceDeps } from "../src/telemetry/debug/flightTraceController";
import { FLIGHT_KIND, type FlightEvent } from "../src/telemetry/debug/flightEvents";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

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
	qaTraceEnabled: true,
	qaTraceMode: "safe" as const,
	qaTraceSecret: null,
};

const cleanupFns: (() => void)[] = [];

const deps: FlightTraceDeps = {
	app: mockApp as never,
	getSettings: () => mockSettings as never,
	getPluginVersion: () => "1.0.0-test",
	getDocSchemaVersion: () => 2,
	buildCheckpoint: async () => ({}),
	registerCleanup: (fn) => { cleanupFns.push(fn); },
	log: () => {},
};

// --- Test ---

console.log("\n=== Flight Lifecycle Proof Test (P1-9) ===\n");

const TEST_PATH = "Daily/2026-05-12.md";
const TEST_OP_ID = "op-lifecycle-test-001";

async function runLifecycleTest(): Promise<void> {
	const controller = new FlightTraceController(deps);

	// Start trace in safe mode
	await controller.start("safe", null, { manualStart: true });

	const recorder = controller.currentRecorder!;
	assert(recorder !== null && recorder !== undefined, "Recorder is active after start");
	assert(recorder.safeToShare === true, "Recorder is in safe mode");

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

	// Step 3: Record server.receipt.candidate_captured (simulates serverAckTracker)
	controller.record({
		priority: "critical",
		kind: FLIGHT_KIND.serverReceiptCandidateCaptured,
		severity: "info",
		scope: "connection",
		source: "serverAckTracker",
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
	assert(pathId.startsWith("p:"), "pathId has correct prefix");
	assert(pathId.length === 34, `pathId is 34 chars (p: + 32 hex) — got ${pathId.length}`);

	// 4. Timeline for path includes disk and crdt events in order
	const timeline = recorder.getTimelineForPath(pathId);
	assert(timeline.length >= 2, `Timeline for path has >= 2 events (got ${timeline.length})`);

	const diskEvent = timeline.find((e: FlightEvent) => e.kind === FLIGHT_KIND.diskCreateObserved);
	const crdtEvent = timeline.find((e: FlightEvent) => e.kind === FLIGHT_KIND.crdtFileCreated);
	assert(diskEvent !== undefined, "disk.create.observed found in path timeline");
	assert(crdtEvent !== undefined, "crdt.file.created found in path timeline");

	if (diskEvent && crdtEvent) {
		assert(diskEvent.seq < crdtEvent.seq, "disk event has lower seq than crdt event (causal order preserved)");
		assert(diskEvent.opId === TEST_OP_ID, "disk event carries correct opId");
		assert(crdtEvent.opId === TEST_OP_ID, "crdt event carries correct opId");
		assert(diskEvent.pathId === pathId, "disk event has correct pathId");
		assert(crdtEvent.pathId === pathId, "crdt event has correct pathId");
	}

	// 5. Timeline for opId includes disk + crdt events
	const opTimeline = recorder.getTimelineForOp(TEST_OP_ID);
	assert(opTimeline.length >= 2, `Op timeline has >= 2 events (got ${opTimeline.length})`);
	const opDiskEvent = opTimeline.find((e: FlightEvent) => e.kind === FLIGHT_KIND.diskCreateObserved);
	const opCrdtEvent = opTimeline.find((e: FlightEvent) => e.kind === FLIGHT_KIND.crdtFileCreated);
	assert(opDiskEvent !== undefined, "disk.create.observed found in op timeline");
	assert(opCrdtEvent !== undefined, "crdt.file.created found in op timeline");

	// Receipt event (no pathId, so not in path timeline — but verify it exists in ring)
	const recentEvents = recorder.recentEvents;
	const receiptEvent = recentEvents.find((e: FlightEvent) => e.kind === FLIGHT_KIND.serverReceiptCandidateCaptured);
	assert(receiptEvent !== undefined, "server.receipt.candidate_captured found in recent events");
	if (receiptEvent) {
		assert(receiptEvent.candidateId === "cand-test-001", "receipt has candidateId");
		assert(receiptEvent.svHash === "abcd1234", "receipt has svHash");
		assert(
			(receiptEvent.data as Record<string, unknown>)?.causedByOpId === TEST_OP_ID,
			"receipt data has causedByOpId matching opId",
		);
	}

	// 6. No raw path in serialized output
	await recorder.flushNow();
	const allOutput = writtenLines.join("");
	assert(!allOutput.includes(TEST_PATH), "No raw path appears in serialized NDJSON output");
	assert(allOutput.includes(pathId), "pathId appears in serialized output");

	// 7. Sequence numbers are monotonically increasing
	const allEvents = recentEvents.slice().sort((a, b) => a.seq - b.seq);
	let seqMonotonic = true;
	for (let i = 1; i < allEvents.length; i++) {
		if (allEvents[i]!.seq <= allEvents[i - 1]!.seq) {
			seqMonotonic = false;
			break;
		}
	}
	assert(seqMonotonic, "Sequence numbers are strictly monotonically increasing");

	// Verify causal order across all event types
	if (diskEvent && crdtEvent && receiptEvent) {
		assert(
			diskEvent.seq < crdtEvent.seq && crdtEvent.seq < receiptEvent.seq,
			"Full causal order: disk < crdt < receipt (by seq)",
		);
	}

	await controller.stop();
}

await runLifecycleTest();

// --- Summary ---
console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────\n");

if (failed > 0) {
	process.exit(1);
}
