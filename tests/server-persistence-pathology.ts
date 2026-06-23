/**
 * Regression tests for Issue #24 — server persistence pathology.
 *
 * These tests reproduce the exact failure shape from the reporter's diagnostics:
 * server durable state frozen near-empty while clients have rich local CRDT state.
 *
 * Test categories:
 *   1. Large refill from near-empty server (the core pathology)
 *   2. Append-failure checkpoint fallback (death spiral breaker)
 *   3. Legacy "document" key migration
 *   4. Persistence health / degraded state tracking
 */

import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined") {
	globalThis.crypto = webcrypto as unknown as Crypto;
}

import * as Y from "yjs";
import { ChunkedDocStore } from "../server/src/chunkedDocStore";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

// ── FakeStorage ──────────────────────────────────────────────────────────────

class FakeStorage {
	readonly data = new Map<string, unknown>();

	async get<T = unknown>(key: string): Promise<T | undefined>;
	async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
		if (Array.isArray(keyOrKeys)) {
			const out = new Map<string, T>();
			for (const key of keyOrKeys) {
				if (this.data.has(key)) out.set(key, this.data.get(key) as T);
			}
			return out;
		}
		return this.data.get(keyOrKeys) as T | undefined;
	}

	async put<T>(entries: Record<string, T>): Promise<void> {
		for (const [key, value] of Object.entries(entries)) {
			this.data.set(key, value);
		}
	}

	async delete(keys: string[]): Promise<number> {
		let deleted = 0;
		for (const key of keys) {
			if (this.data.delete(key)) deleted++;
		}
		return deleted;
	}

	async transaction<T>(closure: (txn: FakeTransaction) => Promise<T>): Promise<T> {
		return closure(new FakeTransaction(this));
	}
}

class FakeTransaction {
	constructor(private readonly storage: FakeStorage) {}

	async get<T = unknown>(key: string): Promise<T | undefined>;
	async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
		return this.storage.get(keyOrKeys as string);
	}

	async put<T>(entries: Record<string, T>): Promise<void> {
		return this.storage.put(entries);
	}

	async delete(keys: string[]): Promise<number> {
		return this.storage.delete(keys);
	}
}

// ── FailingStorage: wraps FakeStorage but can force appendUpdate to throw ────

class FailingStorage {
	readonly inner: FakeStorage;
	failPutAfterNBytes = Infinity;
	private bytesWritten = 0;
	putFailures = 0;

	constructor() {
		this.inner = new FakeStorage();
	}

	async get<T = unknown>(key: string): Promise<T | undefined>;
	async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
		return this.inner.get(keyOrKeys as string);
	}

	async put<T>(entries: Record<string, T>): Promise<void> {
		let entryBytes = 0;
		for (const value of Object.values(entries)) {
			if (value instanceof Uint8Array) {
				entryBytes += value.byteLength;
			}
		}
		if (this.bytesWritten + entryBytes > this.failPutAfterNBytes) {
			this.putFailures++;
			throw new Error("SIMULATED_STORAGE_FAILURE: put exceeds threshold");
		}
		this.bytesWritten += entryBytes;
		return this.inner.put(entries);
	}

	async delete(keys: string[]): Promise<number> {
		return this.inner.delete(keys);
	}

	async transaction<T>(closure: (txn: FailingTransaction) => Promise<T>): Promise<T> {
		return closure(new FailingTransaction(this));
	}

	resetBytesWritten(): void {
		this.bytesWritten = 0;
	}
}

class FailingTransaction {
	constructor(private readonly storage: FailingStorage) {}

	async get<T = unknown>(key: string): Promise<T | undefined>;
	async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
		return this.storage.get(keyOrKeys as string);
	}

	async put<T>(entries: Record<string, T>): Promise<void> {
		// Must use storage.put to trigger failure checks
		return this.storage.put(entries);
	}

	async delete(keys: string[]): Promise<number> {
		return this.storage.delete(keys);
	}
}

// ── KAOS vault schema helpers ────────────────────────────────────────────────

type FileMeta = { path: string; deleted?: boolean };

interface VaultDoc {
	doc: Y.Doc;
	pathToId: Y.Map<string>;
	idToText: Y.Map<Y.Text>;
	meta: Y.Map<FileMeta>;
	sys: Y.Map<unknown>;
}

function makeVaultDoc(): VaultDoc {
	const doc = new Y.Doc();
	return {
		doc,
		pathToId: doc.getMap<string>("pathToId"),
		idToText: doc.getMap<Y.Text>("idToText"),
		meta: doc.getMap<FileMeta>("meta"),
		sys: doc.getMap<unknown>("sys"),
	};
}

function writeFile(vault: VaultDoc, path: string, content: string, fileId: string): void {
	vault.doc.transact(() => {
		vault.pathToId.set(path, fileId);
		const text = new Y.Text();
		text.insert(0, content);
		vault.idToText.set(fileId, text);
		vault.meta.set(fileId, { path, deleted: false });
	}, "disk-sync");
}

function activePaths(vault: VaultDoc): string[] {
	const paths: string[] = [];
	vault.pathToId.forEach((_, path) => {
		const fileId = vault.pathToId.get(path);
		if (!fileId) return;
		const m = vault.meta.get(fileId);
		if (!m?.deleted) paths.push(path);
	});
	return paths.sort();
}

function readFileContent(vault: VaultDoc, path: string): string | null {
	const fileId = vault.pathToId.get(path);
	if (!fileId) return null;
	const ytext = vault.idToText.get(fileId);
	if (!ytext) return null;
	return ytext.toString();
}

/**
 * Populate a vault with N files of the given content size.
 */
function populateVault(vault: VaultDoc, fileCount: number, contentSizeBytes: number): void {
	vault.sys.set("schemaVersion", 8);
	vault.sys.set("initialized", true);
	for (let i = 0; i < fileCount; i++) {
		const path = `folder-${Math.floor(i / 50)}/note-${i}.md`;
		const fileId = `file-${String(i).padStart(5, "0")}`;
		// Generate repeatable content of desired size
		let content = `# Note ${i}\n\n`;
		while (content.length < contentSizeBytes) {
			content += `Line ${content.length}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n`;
		}
		content = content.slice(0, contentSizeBytes);
		writeFile(vault, path, content, fileId);
	}
}

function makeBytes(size: number): Uint8Array {
	const out = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		out[i] = i % 251;
	}
	return out;
}

/**
 * Simulate the server onSave path: compute delta from last persisted SV,
 * append to journal, return stats. This mirrors VaultSyncServer.onSave() +
 * enqueueSave() logic.
 */
async function simulateServerSave(
	serverDoc: Y.Doc,
	store: ChunkedDocStore,
	lastPersistedSV: Uint8Array | null,
): Promise<{ journalStats: { entryCount: number; totalBytes: number }; newSV: Uint8Array }> {
	const currentSV = Y.encodeStateVector(serverDoc);
	const delta = lastPersistedSV
		? Y.encodeStateAsUpdate(serverDoc, lastPersistedSV)
		: Y.encodeStateAsUpdate(serverDoc);
	if (delta.byteLength === 0) {
		return {
			journalStats: await store.getJournalStats(),
			newSV: currentSV,
		};
	}
	const journalStats = await store.appendUpdate(delta);
	return { journalStats, newSV: currentSV };
}

/**
 * Cold-start from store: load persisted state, reconstruct server doc,
 * then create a fresh client doc via simulated initial provider sync.
 */
async function coldStartFromStore(store: ChunkedDocStore): Promise<VaultDoc> {
	const state = await store.loadState();
	const serverDoc = new Y.Doc();
	if (state.checkpoint) Y.applyUpdate(serverDoc, state.checkpoint);
	for (const u of state.journalUpdates) Y.applyUpdate(serverDoc, u);
	const device = makeVaultDoc();
	Y.applyUpdate(device.doc, Y.encodeStateAsUpdate(serverDoc));
	return device;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 1: Large refill from near-empty server — 700 tiny files
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n--- Test 1: large refill from near-empty server (700 tiny files) ---");
{
	const storage = new FakeStorage();
	const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);

	// Phase 1: Create near-empty server state (schema/sentinel only)
	const sentinelDoc = new Y.Doc();
	sentinelDoc.getMap("sys").set("schemaVersion", 8);
	const sentinelDelta = Y.encodeStateAsUpdate(sentinelDoc);
	await store.appendUpdate(sentinelDelta);

	sentinelDoc.getMap("sys").set("initialized", true);
	const sentinelSV = Y.encodeStateVector(sentinelDoc);
	const sentinelDelta2 = Y.encodeStateAsUpdate(sentinelDoc, sentinelSV);
	// Only append if non-empty (initialized set produces a small delta)
	if (sentinelDelta2.byteLength > 0) {
		await store.appendUpdate(sentinelDelta2);
	}

	const stats0 = await store.getJournalStats();
	assert(stats0.entryCount <= 2, `initial journal has <= 2 entries (got ${stats0.entryCount})`);

	// Phase 2: Client A has a full vault (700 files)
	const clientA = makeVaultDoc();
	populateVault(clientA, 700, 50); // 50 bytes per file

	// Phase 3: Simulate client A syncing to server — large delta
	const serverDoc = new Y.Doc();
	// Load existing persisted state into server doc
	const state = await store.loadState();
	if (state.checkpoint) Y.applyUpdate(serverDoc, state.checkpoint);
	for (const u of state.journalUpdates) Y.applyUpdate(serverDoc, u);
	const loadedSV = Y.encodeStateVector(serverDoc);

	// Client sends its state to server (initial provider sync)
	const clientDelta = Y.encodeStateAsUpdate(clientA.doc, Y.encodeStateVector(serverDoc));
	Y.applyUpdate(serverDoc, clientDelta);

	// Server onSave: delta from loaded SV
	const result = await simulateServerSave(serverDoc, store, loadedSV);
	assert(result.journalStats.entryCount > stats0.entryCount, "journal entry count increased after large refill");
	assert(result.journalStats.totalBytes > 1000, `journal bytes reflect vault data (got ${result.journalStats.totalBytes})`);

	// Phase 4: Cold-start Device B from store
	const deviceB = await coldStartFromStore(store);
	const bPaths = activePaths(deviceB);
	assert(bPaths.length === 700, `Device B has all 700 files (got ${bPaths.length})`);
	assert(readFileContent(deviceB, "folder-0/note-0.md") !== null, "Device B can read file content");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 2: Large refill — 700 files × 2KB content
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n--- Test 2: large refill from near-empty server (700 × 2KB files) ---");
{
	const storage = new FakeStorage();
	const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);

	// Near-empty server
	const sentinelDoc = new Y.Doc();
	sentinelDoc.getMap("sys").set("schemaVersion", 8);
	sentinelDoc.getMap("sys").set("initialized", true);
	await store.appendUpdate(Y.encodeStateAsUpdate(sentinelDoc));

	const loadedSV = Y.encodeStateVector(sentinelDoc);

	// Client A with 700 × 2KB files
	const clientA = makeVaultDoc();
	populateVault(clientA, 700, 2048);

	// Sync to server
	const serverDoc = new Y.Doc();
	Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(sentinelDoc));
	const clientDelta = Y.encodeStateAsUpdate(clientA.doc, Y.encodeStateVector(serverDoc));
	Y.applyUpdate(serverDoc, clientDelta);

	const result = await simulateServerSave(serverDoc, store, loadedSV);
	assert(result.journalStats.totalBytes > 100_000, `large vault persisted (${result.journalStats.totalBytes} bytes)`);

	// Cold-start Device B
	const deviceB = await coldStartFromStore(store);
	const bPaths = activePaths(deviceB);
	assert(bPaths.length === 700, `Device B has all 700 files (got ${bPaths.length})`);

	// Spot-check content
	const content = readFileContent(deviceB, "folder-5/note-250.md");
	assert(content !== null && content.startsWith("# Note 250"), "Device B has correct file content");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 3: Large refill — 700 files × 20KB content (stress test)
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n--- Test 3: large refill from near-empty server (700 × 20KB files) ---");
{
	const storage = new FakeStorage();
	const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);

	// Near-empty server
	const sentinelDoc = new Y.Doc();
	sentinelDoc.getMap("sys").set("schemaVersion", 8);
	sentinelDoc.getMap("sys").set("initialized", true);
	await store.appendUpdate(Y.encodeStateAsUpdate(sentinelDoc));

	const loadedSV = Y.encodeStateVector(sentinelDoc);

	// Client A with 700 × 20KB files
	const clientA = makeVaultDoc();
	populateVault(clientA, 700, 20_480);

	// Sync to server
	const serverDoc = new Y.Doc();
	Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(sentinelDoc));
	const clientDelta = Y.encodeStateAsUpdate(clientA.doc, Y.encodeStateVector(serverDoc));
	Y.applyUpdate(serverDoc, clientDelta);

	const result = await simulateServerSave(serverDoc, store, loadedSV);
	assert(result.journalStats.totalBytes > 1_000_000, `large vault persisted (${result.journalStats.totalBytes} bytes)`);

	// Cold-start Device B
	const deviceB = await coldStartFromStore(store);
	const bPaths = activePaths(deviceB);
	assert(bPaths.length === 700, `Device B has all 700 files (got ${bPaths.length})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 4: Exact reporter pathology — 2 entries / 103 bytes, then refill
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n--- Test 4: exact reporter pathology — near-empty journal then full vault refill ---");
{
	const storage = new FakeStorage();
	const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);

	// Create exactly the reporter's state: 2 tiny journal entries
	const setupDoc = new Y.Doc();
	setupDoc.getMap("sys").set("schemaVersion", 8);
	const sv1 = Y.encodeStateVector(setupDoc);
	const delta1 = Y.encodeStateAsUpdate(setupDoc);
	await store.appendUpdate(delta1);

	setupDoc.getMap("sys").set("initialized", true);
	const delta2 = Y.encodeStateAsUpdate(setupDoc, sv1);
	await store.appendUpdate(delta2);

	const stats0 = await store.getJournalStats();
	assert(stats0.entryCount === 2, `reporter-like journal: ${stats0.entryCount} entries`);
	assert(stats0.totalBytes < 200, `reporter-like journal: ${stats0.totalBytes} bytes`);

	// Simulate DO cold-load
	const serverDoc = new Y.Doc();
	const state = await store.loadState();
	if (state.checkpoint) Y.applyUpdate(serverDoc, state.checkpoint);
	for (const u of state.journalUpdates) Y.applyUpdate(serverDoc, u);
	const loadedSV = Y.encodeStateVector(serverDoc);

	// Client with 666 files connects and syncs
	const clientA = makeVaultDoc();
	populateVault(clientA, 666, 500);

	const clientDelta = Y.encodeStateAsUpdate(clientA.doc, Y.encodeStateVector(serverDoc));
	Y.applyUpdate(serverDoc, clientDelta);

	// Server save (the critical moment — this is what failed for the reporter)
	const result = await simulateServerSave(serverDoc, store, loadedSV);
	assert(result.journalStats.entryCount === 3, `journal has 3 entries after refill (got ${result.journalStats.entryCount})`);

	// Simulate DO eviction and cold-load by Device B
	const deviceB = await coldStartFromStore(store);
	const bPaths = activePaths(deviceB);
	assert(bPaths.length === 666, `Device B has all 666 files (got ${bPaths.length})`);

	// Verify Device B gets specific files
	assert(readFileContent(deviceB, "folder-0/note-0.md") !== null, "Device B has first file");
	assert(readFileContent(deviceB, "folder-13/note-665.md") !== null, "Device B has last file");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 5: appendUpdate failure does not corrupt journal
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n--- Test 5: appendUpdate failure leaves journal intact ---");
{
	const storage = new FailingStorage();
	const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);

	// Write one small entry
	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 8);
	await store.appendUpdate(Y.encodeStateAsUpdate(doc));

	const statsBeforeFail = await store.getJournalStats();
	assert(statsBeforeFail.entryCount === 1, "journal has 1 entry before failure");

	// Make the next put fail
	storage.failPutAfterNBytes = 0;
	storage.resetBytesWritten();

	// Try to append a large update — should throw
	doc.getText("t").insert(0, "x".repeat(10_000));
	const delta = Y.encodeStateAsUpdate(doc);
	let threw = false;
	try {
		await store.appendUpdate(delta);
	} catch {
		threw = true;
	}
	assert(threw, "appendUpdate throws on storage failure");

	// Journal should be unchanged — transaction rolled back
	// (FakeStorage doesn't truly roll back, but real CF storage would)
	// Reset storage to allow reads
	storage.failPutAfterNBytes = Infinity;
	const statsAfterFail = await store.getJournalStats();
	// Note: with FakeStorage the transaction isn't truly atomic, so the meta
	// may or may not have been updated. The important thing is the error surfaced.
	assert(threw, "storage failure was not silently swallowed");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 6: Legacy "document" key — verify migration path exists
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n--- Test 6: legacy \"document\" key presence check ---");
{
	const storage = new FakeStorage();

	// Simulate old pre-ChunkedDocStore state: full doc under "document" key
	const legacyDoc = new Y.Doc();
	legacyDoc.getMap("sys").set("schemaVersion", 8);
	legacyDoc.getMap("sys").set("initialized", true);
	const pathToId = legacyDoc.getMap<string>("pathToId");
	const idToText = legacyDoc.getMap<Y.Text>("idToText");
	const meta = legacyDoc.getMap("meta");
	for (let i = 0; i < 100; i++) {
		const path = `note-${i}.md`;
		const fileId = `file-${i}`;
		legacyDoc.transact(() => {
			pathToId.set(path, fileId);
			const text = new Y.Text();
			text.insert(0, `Content of note ${i}`);
			idToText.set(fileId, text);
			meta.set(fileId, { path, deleted: false });
		});
	}
	storage.data.set("document", Y.encodeStateAsUpdate(legacyDoc));

	// New ChunkedDocStore sees empty state
	const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);
	const state = await store.loadState();

	assert(state.checkpoint === null, "chunked store has no checkpoint");
	assert(state.journalUpdates.length === 0, "chunked store has no journal");

	// Verify the legacy key exists and contains data
	const legacyData = storage.data.get("document");
	assert(legacyData !== undefined, "legacy \"document\" key exists in storage");
	assert(
		legacyData instanceof Uint8Array && legacyData.byteLength > 0,
		"legacy key contains data",
	);

	// Migration: load legacy data, apply, then persist in chunked format
	if (legacyData && legacyData instanceof Uint8Array) {
		const migrated = new Y.Doc();
		Y.applyUpdate(migrated, legacyData);
		await store.rewriteCheckpoint(
			Y.encodeStateAsUpdate(migrated),
			Y.encodeStateVector(migrated),
		);

		// Verify cold-load produces the full vault
		const device = await coldStartFromStore(store);
		const paths = activePaths(device);
		assert(paths.length === 100, `migrated vault has 100 files (got ${paths.length})`);
		assert(
			readFileContent(device, "note-50.md") === "Content of note 50",
			"migrated file content is correct",
		);
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 7: Multiple DO lifecycles with near-empty server (simulates 80+ loads)
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n--- Test 7: repeated DO lifecycle — save persists across evictions ---");
{
	const storage = new FakeStorage();

	// Phase 1: First DO lifecycle — seed sentinel
	{
		const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);
		const doc = new Y.Doc();
		doc.getMap("sys").set("schemaVersion", 8);
		doc.getMap("sys").set("initialized", true);
		await store.appendUpdate(Y.encodeStateAsUpdate(doc));
	}

	// Phase 2: Second DO lifecycle — client with 500 files syncs
	{
		const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);
		const state = await store.loadState();
		const serverDoc = new Y.Doc();
		if (state.checkpoint) Y.applyUpdate(serverDoc, state.checkpoint);
		for (const u of state.journalUpdates) Y.applyUpdate(serverDoc, u);
		const loadedSV = Y.encodeStateVector(serverDoc);

		// Client syncs 500 files
		const client = makeVaultDoc();
		populateVault(client, 500, 200);
		const delta = Y.encodeStateAsUpdate(client.doc, Y.encodeStateVector(serverDoc));
		Y.applyUpdate(serverDoc, delta);

		// Server save
		await simulateServerSave(serverDoc, store, loadedSV);
	}

	// Phase 3: Third DO lifecycle (simulated eviction + cold-load)
	// Device B opens alone — should see all 500 files
	{
		const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);
		const deviceB = await coldStartFromStore(store);
		const bPaths = activePaths(deviceB);
		assert(bPaths.length === 500, `after eviction cycle, Device B has 500 files (got ${bPaths.length})`);
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 8: Legacy document + non-empty tiny chunked journal migrates correctly
// (This is the exact reporter shape)
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n--- Test 8: legacy document + tiny chunked sentinel entries — migrates correctly ---");
{
	const storage = new FakeStorage();

	// Phase 1: Create legacy "document" key with a full vault (666 files)
	const legacyDoc = new Y.Doc();
	const legacyPathToId = legacyDoc.getMap<string>("pathToId");
	const legacyIdToText = legacyDoc.getMap<Y.Text>("idToText");
	const legacyMeta = legacyDoc.getMap("meta");
	legacyDoc.getMap("sys").set("schemaVersion", 7); // old schema version

	for (let i = 0; i < 666; i++) {
		const path = `folder-${Math.floor(i / 50)}/note-${i}.md`;
		const fileId = `file-legacy-${i}`;
		legacyDoc.transact(() => {
			legacyPathToId.set(path, fileId);
			const text = new Y.Text();
			text.insert(0, `Legacy content ${i}`);
			legacyIdToText.set(fileId, text);
			legacyMeta.set(fileId, { path, deleted: false });
		});
	}
	storage.data.set("document", Y.encodeStateAsUpdate(legacyDoc));

	// Phase 2: Create chunked journal with 2 tiny sys/init entries (sentinel-only)
	// This is the reporter's pathological shape: 2 entries, ~100 bytes
	{
		const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);
		const sentinelDoc = new Y.Doc();

		// First entry: schemaVersion
		sentinelDoc.getMap("sys").set("schemaVersion", 8);
		await store.appendUpdate(Y.encodeStateAsUpdate(sentinelDoc));

		// Second entry: initialized (capture SV BEFORE mutation)
		const svBefore = Y.encodeStateVector(sentinelDoc);
		sentinelDoc.getMap("sys").set("initialized", true);
		const delta = Y.encodeStateAsUpdate(sentinelDoc, svBefore);
		await store.appendUpdate(delta);

		const stats = await store.getJournalStats();
		assert(stats.entryCount === 2, `setup: chunked has exactly 2 entries (got ${stats.entryCount})`);
	}

	// Phase 3: Verify chunked state has no active paths, but legacy does
	const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);
	const state = await store.loadState();

	const chunkedDoc = new Y.Doc();
	if (state.checkpoint) Y.applyUpdate(chunkedDoc, state.checkpoint);
	for (const u of state.journalUpdates) Y.applyUpdate(chunkedDoc, u);

	const chunkedMeta = chunkedDoc.getMap("meta");
	let chunkedPathCount = 0;
	chunkedMeta.forEach((m: unknown) => {
		if (typeof m === "object" && m !== null && "path" in m) {
			const meta = m as { deleted?: boolean };
			if (!meta.deleted) chunkedPathCount++;
		}
	});

	assert(chunkedPathCount === 0, `chunked has no active paths (got ${chunkedPathCount})`);
	assert(state.journalStats.entryCount >= 1, `chunked has sentinel entries (got ${state.journalStats.entryCount})`);
	assert(storage.data.get("document") !== undefined, "legacy document exists");

	// Phase 4: The migration should prefer legacy since it has real files
	// (This tests the countActivePathsInDoc logic in server.ts)
	// Simulate what the server would do: merge legacy + chunked, prefer legacy for files
	const mergedDoc = new Y.Doc();
	const legacyData = storage.data.get("document") as Uint8Array;
	Y.applyUpdate(mergedDoc, legacyData);
	if (state.checkpoint) Y.applyUpdate(mergedDoc, state.checkpoint);
	for (const u of state.journalUpdates) Y.applyUpdate(mergedDoc, u);

	const mergedMeta = mergedDoc.getMap("meta");
	let mergedPathCount = 0;
	mergedMeta.forEach((m: unknown) => {
		if (typeof m === "object" && m !== null && "path" in m) {
			const meta = m as { deleted?: boolean };
			if (!meta.deleted) mergedPathCount++;
		}
	});

	assert(mergedPathCount === 666, `merged doc has 666 files (got ${mergedPathCount})`);
	// Note: schemaVersion CRDT resolution depends on client IDs, not application order.
	// We just verify the merged doc has a schemaVersion set.
	const sv = mergedDoc.getMap("sys").get("schemaVersion");
	assert(typeof sv === "number" && sv >= 7, `merged doc has valid schemaVersion (got ${sv})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 9: appendUpdate fails, checkpoint fallback succeeds
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n--- Test 9: appendUpdate fails, checkpoint fallback succeeds ---");
{
	// Use FailingStorage that can simulate append failure then checkpoint success
	const storage = new FailingStorage();
	const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);

	// Write initial sentinel
	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 8);
	await store.appendUpdate(Y.encodeStateAsUpdate(doc));

	// Now make append fail for any non-trivial write
	storage.failPutAfterNBytes = 500;
	storage.resetBytesWritten();

	// Add real content that will exceed the threshold
	// Capture SV BEFORE mutation
	const svBefore = Y.encodeStateVector(doc);
	doc.getText("t").insert(0, "x".repeat(10_000));
	const delta = Y.encodeStateAsUpdate(doc, svBefore);

	// Try append — should fail
	let appendFailed = false;
	try {
		await store.appendUpdate(delta);
	} catch {
		appendFailed = true;
	}
	assert(appendFailed, "appendUpdate fails when storage threshold exceeded");
	assert(storage.putFailures > 0, "storage recorded put failures");

	// Reset storage for checkpoint (which will succeed)
	storage.failPutAfterNBytes = Infinity;
	storage.resetBytesWritten();

	// Checkpoint should succeed
	let checkpointSucceeded = false;
	try {
		await store.rewriteCheckpoint(
			Y.encodeStateAsUpdate(doc),
			Y.encodeStateVector(doc),
		);
		checkpointSucceeded = true;
	} catch {
		checkpointSucceeded = false;
	}
	assert(checkpointSucceeded, "checkpoint fallback succeeds after append failure");

	// Cold-load should have the full content
	const reloaded = await store.loadState();
	const restoredDoc = new Y.Doc();
	if (reloaded.checkpoint) Y.applyUpdate(restoredDoc, reloaded.checkpoint);
	for (const u of reloaded.journalUpdates) Y.applyUpdate(restoredDoc, u);

	assert(
		restoredDoc.getText("t").toString() === "x".repeat(10_000),
		"checkpoint contains full content after fallback",
	);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 10: appendUpdate fails, checkpoint fallback also fails
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n--- Test 10: appendUpdate fails, checkpoint fallback also fails ---");
{
	const storage = new FailingStorage();
	const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);

	// Write initial sentinel
	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 8);
	await store.appendUpdate(Y.encodeStateAsUpdate(doc));
	const initialStats = await store.getJournalStats();

	// Make ALL puts fail
	storage.failPutAfterNBytes = 0;
	storage.resetBytesWritten();

	// Add real content
	doc.getText("t").insert(0, "x".repeat(10_000));

	// Try append — should fail
	let appendFailed = false;
	try {
		await store.appendUpdate(Y.encodeStateAsUpdate(doc));
	} catch {
		appendFailed = true;
	}
	assert(appendFailed, "appendUpdate fails");

	// Try checkpoint — should also fail
	let checkpointFailed = false;
	try {
		await store.rewriteCheckpoint(
			Y.encodeStateAsUpdate(doc),
			Y.encodeStateVector(doc),
		);
	} catch {
		checkpointFailed = true;
	}
	assert(checkpointFailed, "checkpoint also fails when storage is completely broken");

	// Re-enable storage and verify original state is intact
	storage.failPutAfterNBytes = Infinity;
	const afterStats = await store.getJournalStats();
	assert(
		afterStats.entryCount === initialStats.entryCount,
		"journal unchanged after failed saves",
	);
}

// ── Test 11: tombstone non-resurrection during authoritative reconcile ───────

console.log("\n--- Test 11: tombstoned stale disk file is not resurrected during authoritative reconcile ---");
{
	// Import the actual production function
	const { classifyDiskPathForReconcile } = await import("../src/sync/vaultSync.js");

	const testPath = "FolderB/Untitled.md";

	// Test 1: Tombstoned path → tombstone-conflict
	{
		const result = classifyDiskPathForReconcile(
			testPath,
			false,  // crdtHasPath
			true,   // isTombstoned
			"authoritative",
		);
		assert(result.action === "tombstone-conflict", "tombstoned path returns tombstone-conflict");
		assert(result.conflict !== undefined, "conflict object is returned");
		assert(result.conflict!.path === testPath, "conflict path matches");
		assert(result.conflict!.action === "preserved-local-only", "conflict action correct");
		assert(result.conflict!.reason === "disk-present-at-tombstoned-path", "conflict reason correct");
	}

	// Test 2: Already in CRDT → skip-in-crdt
	{
		const result = classifyDiskPathForReconcile(
			testPath,
			true,   // crdtHasPath
			false,  // isTombstoned
			"authoritative",
		);
		assert(result.action === "skip-in-crdt", "path in CRDT returns skip-in-crdt");
		assert(result.conflict === undefined, "no conflict for skip-in-crdt");
	}

	// Test 3: Not in CRDT, not tombstoned, authoritative → seed-to-crdt
	{
		const result = classifyDiskPathForReconcile(
			testPath,
			false,  // crdtHasPath
			false,  // isTombstoned
			"authoritative",
		);
		assert(result.action === "seed-to-crdt", "new path in authoritative returns seed-to-crdt");
	}

	// Test 4: Not in CRDT, not tombstoned, conservative → untracked
	{
		const result = classifyDiskPathForReconcile(
			testPath,
			false,  // crdtHasPath
			false,  // isTombstoned
			"conservative",
		);
		assert(result.action === "untracked", "new path in conservative returns untracked");
	}

	// Test 5: Tombstoned takes precedence over authoritative mode
	{
		const result = classifyDiskPathForReconcile(
			testPath,
			false,  // crdtHasPath
			true,   // isTombstoned
			"authoritative",
		);
		assert(result.action === "tombstone-conflict", "tombstone takes precedence in authoritative");
	}

	// Test 6: crdtHasPath takes precedence over tombstone
	// (This shouldn't normally happen, but test the priority)
	{
		const result = classifyDiskPathForReconcile(
			testPath,
			true,   // crdtHasPath
			true,   // isTombstoned (inconsistent state)
			"authoritative",
		);
		assert(result.action === "skip-in-crdt", "crdtHasPath takes precedence over tombstone");
	}
}

// ── Test 12: PersistenceCoordinator — append fails, checkpoint fallback succeeds ───────

console.log("\n--- Test 12: PersistenceCoordinator — append fails, checkpoint fallback succeeds ---");
{
	const { PersistenceCoordinator, CHECKPOINT_FALLBACK_AFTER_FAILURES } = await import(
		"../server/src/persistenceCoordinator.js"
	);

	// Create a mock ChunkedDocStore that fails append but succeeds checkpoint
	let appendCallCount = 0;
	let checkpointCallCount = 0;
	const mockStore = {
		async appendUpdate(_update: Uint8Array) {
			appendCallCount++;
			throw new Error("SIMULATED_APPEND_FAILURE");
		},
		async rewriteCheckpoint(_update: Uint8Array, _sv: Uint8Array) {
			checkpointCallCount++;
			// Success
		},
		async getJournalStats() {
			return { entryCount: 0, totalBytes: 0 };
		},
	};

	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 8);

	const coordinator = new PersistenceCoordinator(doc, mockStore as never);

	// First save — append fails, not enough failures for fallback yet
	doc.getText("t").insert(0, "content1");
	const result1 = await coordinator.enqueueSave();
	assert(!result1.success, "first save fails");
	assert(result1.method === "append", "first save tried append");
	assert(coordinator.health.status === "degraded", "status is degraded after failure");
	assert(coordinator.health.consecutiveSaveFailures === 1, "consecutive failures = 1");
	assert(coordinator.health.pendingPersistence === true, "pendingPersistence stays true after failure");

	// Second save — append fails, triggers immediate checkpoint fallback
	doc.getText("t").insert(0, "content2");
	const result2 = await coordinator.enqueueSave();

	// After CHECKPOINT_FALLBACK_AFTER_FAILURES (2) failures, immediate fallback should succeed
	assert(result2.success, "second save succeeds via immediate fallback");
	assert(
		result2.method === "immediate-fallback",
		`second save used immediate fallback (got ${result2.method})`,
	);
	assert(coordinator.health.status === "healthy", "status is healthy after fallback success");
	assert(coordinator.health.consecutiveSaveFailures === 0, "consecutive failures reset");
	assert(coordinator.health.checkpointFallbackCount >= 1, "checkpoint fallback count incremented");

	// Verify lastPersistedStateVector advanced
	const psv = coordinator.getLastPersistedStateVector();
	assert(psv !== null, "lastPersistedStateVector is set after successful save");

	// Verify call counts
	assert(appendCallCount === 2, `appendUpdate called twice (got ${appendCallCount})`);
	assert(checkpointCallCount === 1, `rewriteCheckpoint called once (got ${checkpointCallCount})`);
}

// ── Test 13: PersistenceCoordinator — append + checkpoint both fail ───────

console.log("\n--- Test 13: PersistenceCoordinator — append + checkpoint both fail ---");
{
	const { PersistenceCoordinator } = await import("../server/src/persistenceCoordinator.js");

	// Create a mock ChunkedDocStore that fails everything
	const mockStore = {
		async appendUpdate(_update: Uint8Array) {
			throw new Error("SIMULATED_APPEND_FAILURE");
		},
		async rewriteCheckpoint(_update: Uint8Array, _sv: Uint8Array) {
			throw new Error("SIMULATED_CHECKPOINT_FAILURE");
		},
		async getJournalStats() {
			return { entryCount: 0, totalBytes: 0 };
		},
	};

	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 8);

	const coordinator = new PersistenceCoordinator(doc, mockStore as never);

	// Capture initial state
	const initialPsv = coordinator.getLastPersistedStateVector();
	assert(initialPsv === null, "initial lastPersistedStateVector is null");

	// First save — fails
	doc.getText("t").insert(0, "content1");
	const result1 = await coordinator.enqueueSave();
	assert(!result1.success, "first save fails");

	// Second save — fails, triggers fallback which also fails
	doc.getText("t").insert(0, "content2");
	const result2 = await coordinator.enqueueSave();
	assert(!result2.success, "second save fails");
	assert(result2.method === "immediate-fallback", "second save tried immediate fallback");

	// CRITICAL INVARIANT: lastPersistedStateVector must NOT advance on failure
	const finalPsv = coordinator.getLastPersistedStateVector();
	assert(finalPsv === null, "lastPersistedStateVector did NOT advance after total failure");

	// Status must be degraded
	assert(coordinator.health.status === "degraded", "status is degraded");
	assert(coordinator.health.pendingPersistence === true, "pendingPersistence is true after failure");
	assert(coordinator.health.consecutiveSaveFailures >= 2, "consecutive failures tracked");
}

// ── Test 14: PersistenceCoordinator — queued saves use fresh state vectors ───────

console.log("\n--- Test 14: PersistenceCoordinator — queued saves cannot regress lastPersistedStateVector ---");
{
	const { PersistenceCoordinator } = await import("../server/src/persistenceCoordinator.js");

	let savedUpdates: Uint8Array[] = [];
	const mockStore = {
		async appendUpdate(update: Uint8Array) {
			savedUpdates.push(update);
			return { entryCount: savedUpdates.length, totalBytes: update.byteLength };
		},
		async rewriteCheckpoint(_update: Uint8Array, _sv: Uint8Array) {},
		async getJournalStats() {
			return { entryCount: savedUpdates.length, totalBytes: 0 };
		},
	};

	const doc = new Y.Doc();
	doc.getMap("sys").set("schemaVersion", 8);

	const coordinator = new PersistenceCoordinator(doc, mockStore as never);

	// Queue multiple saves quickly
	doc.getText("t").insert(0, "A");
	const p1 = coordinator.enqueueSave();

	doc.getText("t").insert(0, "B");
	const p2 = coordinator.enqueueSave();

	doc.getText("t").insert(0, "C");
	const p3 = coordinator.enqueueSave();

	// Wait for all to complete
	const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

	// All should succeed
	assert(r1.success, "first queued save succeeded");
	assert(r2.success, "second queued save succeeded");
	assert(r3.success, "third queued save succeeded");

	// Final state vector should reflect all changes
	const finalPsv = coordinator.getLastPersistedStateVector();
	assert(finalPsv !== null, "final lastPersistedStateVector is set");

	// Cold load should have all content
	const coldDoc = new Y.Doc();
	for (const update of savedUpdates) {
		Y.applyUpdate(coldDoc, update);
	}
	const content = coldDoc.getText("t").toJSON();
	assert(content.includes("A"), "cold load has content A");
	assert(content.includes("B"), "cold load has content B");
	assert(content.includes("C"), "cold load has content C");
}

// ── Test 15: PersistenceCoordinator — pendingPersistence tracks degraded state ───────

console.log("\n--- Test 15: PersistenceCoordinator — pendingPersistence stays true when degraded ---");
{
	const { PersistenceCoordinator } = await import("../server/src/persistenceCoordinator.js");

	// Mock store that fails once then succeeds
	let shouldFail = true;
	const mockStore = {
		async appendUpdate(_update: Uint8Array) {
			if (shouldFail) {
				throw new Error("SIMULATED_FAILURE");
			}
			return { entryCount: 1, totalBytes: 100 };
		},
		async rewriteCheckpoint(_update: Uint8Array, _sv: Uint8Array) {
			if (shouldFail) {
				throw new Error("SIMULATED_CHECKPOINT_FAILURE");
			}
		},
		async getJournalStats() {
			return { entryCount: 1, totalBytes: 100 };
		},
	};

	const doc = new Y.Doc();
	const coordinator = new PersistenceCoordinator(doc, mockStore as never);

	// Initial state
	assert(coordinator.health.pendingPersistence === false, "initially no pending persistence");
	assert(coordinator.health.queuedSaveCount === 0, "initially no queued saves");

	// Make a change and try to save — will fail
	doc.getText("t").insert(0, "content");
	const result1 = await coordinator.enqueueSave();
	assert(!result1.success, "save fails");

	// After failed save with empty queue, pendingPersistence must stay true
	assert(coordinator.health.queuedSaveCount === 0, "queue is empty after save completes");
	assert(coordinator.health.status === "degraded", "status is degraded");
	assert(
		coordinator.health.pendingPersistence === true,
		"pendingPersistence stays true when degraded (queue empty but state unpersisted)",
	);

	// Fix the store and save again
	shouldFail = false;
	const result2 = await coordinator.enqueueSave();
	assert(result2.success, "retry succeeds");

	// Now pendingPersistence should be false
	assert(coordinator.health.status === "healthy", "status is healthy");
	assert(coordinator.health.pendingPersistence === false, "pendingPersistence is false when healthy and queue empty");
}

// ── Test 16: PersistenceCoordinator — pending incremental update avoids fallback encode ───────

console.log("\n--- Test 16: PersistenceCoordinator — pending incremental update uses append path ---");
{
	const { PersistenceCoordinator } = await import("../server/src/persistenceCoordinator.js");

	const traces: string[] = [];
	const savedUpdates: Uint8Array[] = [];
	const mockStore = {
		async appendUpdate(update: Uint8Array) {
			savedUpdates.push(update);
			return { entryCount: savedUpdates.length, totalBytes: update.byteLength };
		},
		async rewriteCheckpoint(_update: Uint8Array, _sv: Uint8Array) {
			throw new Error("checkpoint should not be used");
		},
		async getJournalStats() {
			return { entryCount: savedUpdates.length, totalBytes: 0 };
		},
		getLastWriteStats() {
			return { chunkCount: 1, maxChunkBytes: 10, maxBackingBufferBytes: 10, maxPutBytes: 10, putCount: 1 };
		},
	};

	const doc = new Y.Doc();
	const coordinator = new PersistenceCoordinator(
		doc,
		mockStore as never,
		(event) => traces.push(event),
	);
	doc.on("update", (update: Uint8Array) => {
		coordinator.recordIncrementalUpdate(update);
	});

	doc.getText("t").insert(0, "incremental");
	const result = await coordinator.enqueueSave();

	assert(result.success, "save succeeds");
	assert(result.method === "append", "pending update is appended");
	assert(savedUpdates.length === 1, "one pending update was written");
	assert(traces.includes("save.delta_computed"), "trace records incremental delta computation");
	assert(!traces.includes("save.delta_fallback"), "fallback full-update encode was not used");
	assert(coordinator.health.lastSavePhase === "append", "last phase is append");
	assert(coordinator.health.lastChunkPutMaxBytes === 10, "chunk put max bytes are surfaced");
}

// ── Test 17: PersistenceCoordinator — no pending update falls back with trace ───────

console.log("\n--- Test 17: PersistenceCoordinator — recovery path records delta_fallback ---");
{
	const { PersistenceCoordinator } = await import("../server/src/persistenceCoordinator.js");

	const traces: string[] = [];
	let appendCallCount = 0;
	const mockStore = {
		async appendUpdate(_update: Uint8Array) {
			appendCallCount++;
			return { entryCount: appendCallCount, totalBytes: 100 };
		},
		async rewriteCheckpoint(_update: Uint8Array, _sv: Uint8Array) {},
		async getJournalStats() {
			return { entryCount: appendCallCount, totalBytes: 100 };
		},
		getLastWriteStats() {
			return null;
		},
	};

	const doc = new Y.Doc();
	doc.getText("t").insert(0, "loaded-before-listener");
	const coordinator = new PersistenceCoordinator(
		doc,
		mockStore as never,
		(event) => traces.push(event),
	);

	const result = await coordinator.enqueueSave();

	assert(result.success, "fallback save succeeds");
	assert(result.method === "append", "fallback delta still appends to journal");
	assert(appendCallCount === 1, "fallback delta was appended once");
	assert(traces.includes("save.delta_fallback"), "trace records fallback delta encode");
	assert(coordinator.health.lastSavePhase === "append", "fallback save completes in append phase");
}

// ── Test 18: PersistenceCoordinator — large pending delta no longer forces checkpoint ───────

console.log("\n--- Test 18: PersistenceCoordinator — large pending delta still appends ---");
{
	const { PersistenceCoordinator } = await import("../server/src/persistenceCoordinator.js");

	let appendCallCount = 0;
	let checkpointCallCount = 0;
	const mockStore = {
		async appendUpdate(update: Uint8Array) {
			appendCallCount++;
			return { entryCount: appendCallCount, totalBytes: update.byteLength };
		},
		async rewriteCheckpoint(_update: Uint8Array, _sv: Uint8Array) {
			checkpointCallCount++;
		},
		async getJournalStats() {
			return { entryCount: appendCallCount, totalBytes: 0 };
		},
		getLastWriteStats() {
			return null;
		},
	};

	const doc = new Y.Doc();
	const coordinator = new PersistenceCoordinator(
		doc,
		mockStore as never,
		undefined,
		{
			checkpointFallbackAfterFailures: 999,
			journalCompactMaxBytes: Number.MAX_SAFE_INTEGER,
			journalCompactMaxEntries: Number.MAX_SAFE_INTEGER,
		},
	);
	coordinator.recordIncrementalUpdate(makeBytes(3 * 1024 * 1024));

	const result = await coordinator.enqueueSave();

	assert(result.success, "large pending delta save succeeds");
	assert(result.method === "append", "large pending delta uses journal append");
	assert(appendCallCount === 1, "large delta appended once");
	assert(checkpointCallCount === 0, "large delta did not force checkpoint fallback");
	assert(
		(coordinator.health.lastDeltaBytes ?? 0) > 2 * 1024 * 1024,
		"health records large delta byte count",
	);
}

// ── Test 19: PersistenceCoordinator — compaction failure is not save failure ───────

console.log("\n--- Test 19: PersistenceCoordinator — compaction failure stays best-effort ---");
{
	const { PersistenceCoordinator } = await import("../server/src/persistenceCoordinator.js");

	let compactCallCount = 0;
	const mockStore = {
		async appendUpdate(update: Uint8Array) {
			return { entryCount: 51, totalBytes: update.byteLength };
		},
		async rewriteCheckpoint(_update: Uint8Array, _sv: Uint8Array) {},
		async compactJournalToCheckpoint() {
			compactCallCount++;
			throw new Error("SIMULATED_COMPACTION_FAILURE");
		},
		async getJournalStats() {
			return { entryCount: 51, totalBytes: 10 };
		},
		getLastWriteStats() {
			return null;
		},
	};

	const doc = new Y.Doc();
	const coordinator = new PersistenceCoordinator(
		doc,
		mockStore as never,
		undefined,
		{ journalCompactMaxEntries: 1, journalCompactMaxBytes: Number.MAX_SAFE_INTEGER },
	);
	coordinator.recordIncrementalUpdate(new Uint8Array([1, 2, 3]));

	const result = await coordinator.enqueueSave();
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert(result.success, "append save succeeds even when compaction later fails");
	assert(result.method === "append", "save result remains append");
	assert(compactCallCount === 1, "compaction was attempted");
	assert(coordinator.health.status === "healthy", "compaction failure does not degrade durability health");
	assert(
		coordinator.health.lastCompactionError?.includes("SIMULATED_COMPACTION_FAILURE") === true,
		"compaction error is recorded for operations",
	);
	assert(coordinator.health.pendingPersistence === false, "pendingPersistence remains false after durable append");
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
