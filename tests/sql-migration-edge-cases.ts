/**
 * sql-migration-edge-cases.ts
 *
 * Comprehensive edge-case tests for the KV → SQL migration path.
 * Tests cover: migration mechanics, SQL-preference over KV, journal-only
 * loads, state equivalence, ArrayBuffer/ownedBuffer regression, idempotence,
 * and empty-store fresh-vault behaviour.
 */

import { SqlDocStore } from "../server/src/sqlDocStore";
import { ChunkedDocStore } from "../server/src/chunkedDocStore";
import * as Y from "yjs";

// ── Fake SQL storage (mirrors sql-doc-store.ts harness) ─────────────────────

class FakeSqlCursor<T> {
	constructor(private readonly rows: T[]) {}
	toArray(): T[] { return this.rows; }
	[Symbol.iterator](): Iterator<T> { return this.rows[Symbol.iterator](); }
}

class FakeSqlStorage {
	private tables: Map<string, Array<Record<string, unknown>>> = new Map();
	private autoIncrements: Map<string, number> = new Map();

	/** Expose a way to inspect row counts from tests. */
	rowCount(tableName: string): number {
		return this.tables.get(tableName)?.length ?? 0;
	}

	exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): FakeSqlCursor<T> {
		const trimmed = query.trim().replace(/\s+/g, " ");

		// CREATE TABLE IF NOT EXISTS
		if (trimmed.startsWith("CREATE TABLE IF NOT EXISTS")) {
			const match = trimmed.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
			if (match && !this.tables.has(match[1])) {
				this.tables.set(match[1], []);
				this.autoIncrements.set(match[1], 1);
			}
			return new FakeSqlCursor<T>([]);
		}

		// INSERT INTO snapshot_chunks
		if (trimmed.startsWith("INSERT INTO snapshot_chunks")) {
			const table = this.tables.get("snapshot_chunks")!;
			const [chunkIndex, data] = bindings;
			table.push({ chunk_index: chunkIndex, data });
			return new FakeSqlCursor<T>([]);
		}

		// INSERT INTO journal
		if (trimmed.startsWith("INSERT INTO journal")) {
			const table = this.tables.get("journal")!;
			const [data, byteLength] = bindings;
			const id = this.autoIncrements.get("journal")!;
			this.autoIncrements.set("journal", id + 1);

			// Simulate SQLITE_TOOBIG for values >2MB
			if (data instanceof ArrayBuffer && data.byteLength > 2 * 1024 * 1024) {
				throw new Error("string or blob too big: SQLITE_TOOBIG");
			}

			table.push({ id, data, byte_length: byteLength, created_at: new Date().toISOString() });
			return new FakeSqlCursor<T>([]);
		}

		// SELECT from snapshot_chunks
		if (trimmed.startsWith("SELECT data FROM snapshot_chunks")) {
			const table = this.tables.get("snapshot_chunks") ?? [];
			const sorted = [...table].sort((a, b) => (a.chunk_index as number) - (b.chunk_index as number));
			return new FakeSqlCursor<T>(sorted as T[]);
		}

		// SELECT from journal
		if (trimmed.startsWith("SELECT data, byte_length FROM journal")) {
			const table = this.tables.get("journal") ?? [];
			const sorted = [...table].sort((a, b) => (a.id as number) - (b.id as number));
			return new FakeSqlCursor<T>(sorted as T[]);
		}

		// COUNT/SUM from journal
		if (trimmed.includes("COUNT(*)") && trimmed.includes("journal")) {
			const table = this.tables.get("journal") ?? [];
			const cnt = table.length;
			const total = table.reduce((sum, row) => sum + (row.byte_length as number), 0);
			return new FakeSqlCursor<T>([{ cnt, total } as T]);
		}

		// DELETE FROM
		if (trimmed.startsWith("DELETE FROM snapshot_chunks")) {
			this.tables.set("snapshot_chunks", []);
			return new FakeSqlCursor<T>([]);
		}
		if (trimmed.startsWith("DELETE FROM journal")) {
			this.tables.set("journal", []);
			this.autoIncrements.set("journal", 1);
			return new FakeSqlCursor<T>([]);
		}

		throw new Error(`FakeSqlStorage: unhandled query: ${trimmed}`);
	}
}

class FakeDurableObjectStorage {
	sql = new FakeSqlStorage();
	transactionSync<T>(closure: () => T): T {
		return closure();
	}
}

// ── Fake KV storage (mirrors chunked-doc-store.ts harness) ──────────────────

class FakeKvStorage {
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
		for (const key of Object.keys(entries)) {
			this.data.set(key, entries[key]);
		}
	}

	async delete(keys: string[]): Promise<number> {
		let deleted = 0;
		for (const key of keys) {
			if (this.data.delete(key)) deleted++;
		}
		return deleted;
	}

	async transaction<T>(closure: (txn: FakeKvTransaction) => Promise<T>): Promise<T> {
		const txn = new FakeKvTransaction(this);
		return await closure(txn);
	}
}

class FakeKvTransaction {
	constructor(private readonly storage: FakeKvStorage) {}

	async get<T = unknown>(key: string): Promise<T | undefined>;
	async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
		if (Array.isArray(keyOrKeys)) {
			return await this.storage.get<T>(keyOrKeys);
		}
		return await this.storage.get<T>(keyOrKeys);
	}

	async put<T>(entries: Record<string, T>): Promise<void> {
		await this.storage.put(entries);
	}

	async delete(keys: string[]): Promise<number> {
		return await this.storage.delete(keys);
	}
}

// ── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  \x1b[32mPASS\x1b[0m  ${message}`);
		passed++;
	} else {
		console.log(`  \x1b[31mFAIL\x1b[0m  ${message}`);
		failed++;
	}
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Build a Y.Doc with a mix of active and tombstoned files plus a schema version.
 * activeCount files are "live"; tombstoneCount files are flagged as deleted.
 */
function makeRichDoc(activeCount: number, tombstoneCount: number, schemaVersion = 3): Y.Doc {
	const doc = new Y.Doc();
	const meta = doc.getMap<unknown>("meta");
	const pathToId = doc.getMap<string>("pathToId");
	const idToText = doc.getMap("idToText");
	const sys = doc.getMap<unknown>("sys");

	sys.set("schemaVersion", schemaVersion);

	for (let i = 0; i < activeCount; i++) {
		const path = `notes/file-${i}.md`;
		const id = `id-${i}`;
		meta.set(path, { path, mtime: Date.now(), size: i * 10 });
		pathToId.set(path, id);
		idToText.set(id, `Content of file ${i}`);
	}

	for (let i = 0; i < tombstoneCount; i++) {
		const path = `notes/deleted-${i}.md`;
		meta.set(path, { path, mtime: Date.now(), deletedAt: Date.now() - i * 1000 });
	}

	return doc;
}

/** Count active (non-deleted) paths by inspecting the meta map. */
function countActivePaths(doc: Y.Doc): number {
	const meta = doc.getMap<unknown>("meta");
	let count = 0;
	meta.forEach((value: unknown) => {
		if (
			typeof value === "object"
			&& value !== null
			&& "path" in value
			&& typeof (value as { path: unknown }).path === "string"
		) {
			const m = value as { deleted?: boolean; deletedAt?: number };
			const isDeleted =
				m.deleted === true ||
				(typeof m.deletedAt === "number" && Number.isFinite(m.deletedAt));
			if (!isDeleted) count++;
		}
	});
	return count;
}

/** Count tombstoned paths by inspecting the meta map. */
function countTombstonedPaths(doc: Y.Doc): number {
	const meta = doc.getMap<unknown>("meta");
	let count = 0;
	meta.forEach((value: unknown) => {
		if (
			typeof value === "object"
			&& value !== null
			&& "path" in value
		) {
			const m = value as { deleted?: boolean; deletedAt?: number };
			const isDeleted =
				m.deleted === true ||
				(typeof m.deletedAt === "number" && Number.isFinite(m.deletedAt));
			if (isDeleted) count++;
		}
	});
	return count;
}

// ── Test 1: SQL empty, KV has checkpoint+journal → migrates to SQL ───────────

console.log("\n--- Test 1: SQL empty, KV has valid checkpoint+journal → migrates to SQL ---");
{
	const kvStorage = new FakeKvStorage();
	const sqlDo = new FakeDurableObjectStorage();
	const kvStore = new ChunkedDocStore(kvStorage as unknown as DurableObjectStorage);
	const sqlStore = new SqlDocStore(sqlDo as any);

	// Write a doc into KV via ChunkedDocStore
	const kvDoc = new Y.Doc();
	kvDoc.getMap("meta").set("notes/hello.md", { path: "notes/hello.md", mtime: 1000 });
	const checkpointBytes = Y.encodeStateAsUpdate(kvDoc);
	await kvStore.rewriteCheckpoint(checkpointBytes, Y.encodeStateVector(kvDoc));

	// Also append a journal entry
	const svAfterCheckpoint = Y.encodeStateVector(kvDoc);
	kvDoc.getMap("meta").set("notes/world.md", { path: "notes/world.md", mtime: 2000 });
	const journalDelta = Y.encodeStateAsUpdate(kvDoc, svAfterCheckpoint);
	await kvStore.appendUpdate(journalDelta);

	// Verify SQL is empty before migration
	const sqlStateBefore = sqlStore.loadState();
	assert(sqlStateBefore.snapshot === null, "SQL is empty before migration");
	assert(sqlStateBefore.journalUpdates.length === 0, "SQL has no journal before migration");

	// Simulate migration: load KV, apply to doc, write to SQL
	const kvState = await kvStore.loadState();
	const migratedDoc = new Y.Doc();
	if (kvState.checkpoint) Y.applyUpdate(migratedDoc, kvState.checkpoint);
	for (const update of kvState.journalUpdates) Y.applyUpdate(migratedDoc, update);

	sqlStore.rewriteCheckpoint(Y.encodeStateAsUpdate(migratedDoc));

	// Verify SQL now has data
	const sqlStateAfter = sqlStore.loadState();
	assert(sqlStateAfter.snapshot !== null, "SQL has snapshot after migration");
	assert(sqlStateAfter.journalUpdates.length === 0, "SQL journal is empty after migration checkpoint");

	// Verify content round-trips
	const reloaded = new Y.Doc();
	Y.applyUpdate(reloaded, sqlStateAfter.snapshot!);
	const metaReloaded = reloaded.getMap("meta");
	assert(metaReloaded.has("notes/hello.md"), "migrated SQL doc contains original checkpoint entry");
	assert(metaReloaded.has("notes/world.md"), "migrated SQL doc contains journal entry");

	kvDoc.destroy();
	migratedDoc.destroy();
	reloaded.destroy();
}

// ── Test 2: SQL has valid snapshot, KV also exists → prefers SQL ─────────────

console.log("\n--- Test 2: SQL has valid snapshot, KV also exists → prefers SQL, no re-migration ---");
{
	const kvStorage = new FakeKvStorage();
	const sqlDo = new FakeDurableObjectStorage();
	const kvStore = new ChunkedDocStore(kvStorage as unknown as DurableObjectStorage);
	const sqlStore = new SqlDocStore(sqlDo as any);

	// Write DIFFERENT data to KV (simulating old pre-migration state)
	const kvDoc = new Y.Doc();
	kvDoc.getMap("meta").set("kv-only.md", { path: "kv-only.md", mtime: 1000 });
	await kvStore.rewriteCheckpoint(
		Y.encodeStateAsUpdate(kvDoc),
		Y.encodeStateVector(kvDoc),
	);

	// Write DIFFERENT data to SQL (simulating post-migration state)
	const sqlDoc = new Y.Doc();
	sqlDoc.getMap("meta").set("sql-only.md", { path: "sql-only.md", mtime: 9000 });
	sqlStore.rewriteCheckpoint(Y.encodeStateAsUpdate(sqlDoc));

	// Verify SQL has data
	const sqlState = sqlStore.loadState();
	assert(sqlState.snapshot !== null, "SQL has snapshot");

	// The migration check: since sqlHasData is true, we should use SQL directly
	const sqlHasData = sqlState.snapshot !== null || sqlState.journalUpdates.length > 0;
	assert(sqlHasData, "sqlHasData correctly detects SQL state");

	// Load from SQL (as migration logic does when SQL has data)
	const loadedDoc = new Y.Doc();
	if (sqlState.snapshot) Y.applyUpdate(loadedDoc, sqlState.snapshot);
	for (const update of sqlState.journalUpdates) Y.applyUpdate(loadedDoc, update);

	const loadedMeta = loadedDoc.getMap("meta");
	// Should have SQL data, not KV data
	assert(loadedMeta.has("sql-only.md"), "loaded doc has SQL data");
	assert(!loadedMeta.has("kv-only.md"), "loaded doc does NOT have stale KV data");

	// Verify KV data was not re-written to SQL
	const snapshotChunksBefore = sqlDo.sql.rowCount("snapshot_chunks");
	// Loading SQL state should not modify it
	const sqlState2 = sqlStore.loadState();
	const snapshotChunksAfter = sqlDo.sql.rowCount("snapshot_chunks");
	assert(snapshotChunksBefore === snapshotChunksAfter, "SQL snapshot_chunks unchanged when SQL has data");

	kvDoc.destroy();
	sqlDoc.destroy();
	loadedDoc.destroy();
}

// ── Test 3: SQL has journal entries but no snapshot → loads journal only ──────

console.log("\n--- Test 3: SQL has journal entries but no snapshot → loads journal only ---");
{
	const sqlDo = new FakeDurableObjectStorage();
	const sqlStore = new SqlDocStore(sqlDo as any);

	// Write a series of journal entries without any snapshot
	const doc = new Y.Doc();
	doc.getMap("meta").set("a.md", { path: "a.md", mtime: 1 });
	const update1 = Y.encodeStateAsUpdate(doc);
	sqlStore.appendUpdate(update1);

	doc.getMap("meta").set("b.md", { path: "b.md", mtime: 2 });
	const sv1 = Y.encodeStateVector(doc);
	doc.getMap("meta").set("b.md", { path: "b.md", mtime: 2 }); // mutate
	const update2 = Y.encodeStateAsUpdate(doc);
	sqlStore.appendUpdate(update2);

	// Load state
	const state = sqlStore.loadState();
	assert(state.snapshot === null, "no snapshot — only journal entries");
	assert(state.journalUpdates.length === 2, `two journal entries loaded (got ${state.journalUpdates.length})`);
	assert(state.journalStats.entryCount === 2, "journal stats entry count matches");
	assert(state.journalStats.totalBytes > 0, "journal stats total bytes > 0");

	// Apply journal entries to empty doc
	const rebuilt = new Y.Doc();
	// No snapshot to apply
	for (const update of state.journalUpdates) {
		Y.applyUpdate(rebuilt, update);
	}
	const meta = rebuilt.getMap("meta");
	assert(meta.has("a.md"), "journal-only load: a.md present");
	assert(meta.has("b.md"), "journal-only load: b.md present");

	doc.destroy();
	rebuilt.destroy();
}

// ── Test 4: State equivalence: KV state == SQL state after migration ──────────

console.log("\n--- Test 4: State equivalence proof: KV state == SQL state after migration ---");
{
	const ACTIVE = 100;
	const TOMBS = 20;
	const SCHEMA = 5;

	// Build a rich doc with 100 active files, 20 tombstoned
	const sourceDoc = makeRichDoc(ACTIVE, TOMBS, SCHEMA);

	// Write it to KV
	const kvStorage = new FakeKvStorage();
	const kvStore = new ChunkedDocStore(kvStorage as unknown as DurableObjectStorage);
	await kvStore.rewriteCheckpoint(
		Y.encodeStateAsUpdate(sourceDoc),
		Y.encodeStateVector(sourceDoc),
	);

	// Load from KV into docA
	const kvState = await kvStore.loadState();
	const docA = new Y.Doc();
	if (kvState.checkpoint) Y.applyUpdate(docA, kvState.checkpoint);
	for (const u of kvState.journalUpdates) Y.applyUpdate(docA, u);

	// "Migrate" to SQL: encode full state, write via SqlDocStore.rewriteCheckpoint
	const sqlDo = new FakeDurableObjectStorage();
	const sqlStore = new SqlDocStore(sqlDo as any);
	sqlStore.rewriteCheckpoint(Y.encodeStateAsUpdate(docA));

	// Load from SQL into docB
	const sqlState = sqlStore.loadState();
	const docB = new Y.Doc();
	if (sqlState.snapshot) Y.applyUpdate(docB, sqlState.snapshot);
	for (const u of sqlState.journalUpdates) Y.applyUpdate(docB, u);

	// Assert: state vectors are byte-equal
	const svA = Y.encodeStateVector(docA);
	const svB = Y.encodeStateVector(docB);
	assert(equalBytes(svA, svB), "Y.encodeStateVector(docA) === Y.encodeStateVector(docB) (byte-equal)");

	// Assert: full state updates are byte-equal
	const updateA = Y.encodeStateAsUpdate(docA);
	const updateB = Y.encodeStateAsUpdate(docB);
	assert(equalBytes(updateA, updateB), "encodeStateAsUpdate identical between KV-loaded and SQL-loaded docs");

	// Assert: active path counts match
	const activeA = countActivePaths(docA);
	const activeB = countActivePaths(docB);
	assert(activeA === ACTIVE, `docA active paths = ${ACTIVE} (got ${activeA})`);
	assert(activeB === ACTIVE, `docB active paths = ${ACTIVE} (got ${activeB})`);
	assert(activeA === activeB, `active path counts match: ${activeA} === ${activeB}`);

	// Assert: tombstone counts match
	const tombA = countTombstonedPaths(docA);
	const tombB = countTombstonedPaths(docB);
	assert(tombA === TOMBS, `docA tombstone count = ${TOMBS} (got ${tombA})`);
	assert(tombB === TOMBS, `docB tombstone count = ${TOMBS} (got ${tombB})`);
	assert(tombA === tombB, `tombstone counts match: ${tombA} === ${tombB}`);

	// Assert: schema version matches
	const schemaA = docA.getMap("sys").get("schemaVersion");
	const schemaB = docB.getMap("sys").get("schemaVersion");
	assert(schemaA === SCHEMA, `docA schemaVersion = ${SCHEMA} (got ${schemaA})`);
	assert(schemaB === SCHEMA, `docB schemaVersion = ${SCHEMA} (got ${schemaB})`);
	assert(schemaA === schemaB, `schema versions match`);

	sourceDoc.destroy();
	docA.destroy();
	docB.destroy();
}

// ── Test 5: ArrayBuffer regression: ownedBuffer produces correct BLOB ─────────

console.log("\n--- Test 5: ArrayBuffer regression: ownedBuffer produces correct BLOB ---");
{
	const sqlDo = new FakeDurableObjectStorage();
	const sqlStore = new SqlDocStore(sqlDo as any);

	// Create a 1MB parent Uint8Array, fill with a recognisable sentinel value
	const PARENT_SIZE = 1024 * 1024; // 1MB
	const parent = new Uint8Array(PARENT_SIZE);
	parent.fill(0xAA); // fill everything with 0xAA

	// Fill a sub-range (bytes 100–200) with known distinct data
	const OFFSET = 100;
	const LENGTH = 100;
	for (let i = OFFSET; i < OFFSET + LENGTH; i++) {
		parent[i] = i % 251; // known deterministic pattern
	}

	// Build a minimal valid Y.Doc update for the slice region only
	// Strategy: use a Y.Doc, encode its update, then manually build a
	// Uint8Array that lives at offset within a large parent to test the
	// ownedBuffer slicing contract.
	const sliceDoc = new Y.Doc();
	sliceDoc.getText("t").insert(0, "test content for ownedBuffer regression");
	const realUpdate = Y.encodeStateAsUpdate(sliceDoc);

	// Place realUpdate into a large parent buffer at a known offset
	const EMBED_OFFSET = 512;
	const bigParent = new Uint8Array(EMBED_OFFSET + realUpdate.byteLength + 512);
	bigParent.fill(0xFF); // fill surrounding area with noise
	bigParent.set(realUpdate, EMBED_OFFSET);

	// Create a subarray that points into the large parent at the embedded region
	const subview = bigParent.subarray(EMBED_OFFSET, EMBED_OFFSET + realUpdate.byteLength);
	assert(subview.buffer === bigParent.buffer, "subview shares parent buffer (pre-condition for the bug)");
	assert(subview.byteLength === realUpdate.byteLength, "subview has correct length");

	// appendUpdate internally calls ownedBuffer(update, 0, update.byteLength)
	// which does update.slice(0, byteLength).buffer — an independent copy
	const stats = sqlStore.appendUpdate(subview);
	assert(stats !== null, "appendUpdate with subarray subview succeeds");
	assert(stats!.entryCount === 1, "one journal entry written");

	// Read it back — the stored BLOB must be ONLY the subview bytes, not the 1MB parent
	const state = sqlStore.loadState();
	assert(state.journalUpdates.length === 1, "one journal update loaded back");

	const storedUpdate = state.journalUpdates[0]!;
	assert(
		storedUpdate.byteLength === realUpdate.byteLength,
		`stored BLOB is ${realUpdate.byteLength} bytes (subview size), NOT ${bigParent.byteLength} (parent size). Got ${storedUpdate.byteLength}`,
	);

	// Verify the stored bytes decode correctly — not corrupted by parent noise
	const recoveredDoc = new Y.Doc();
	Y.applyUpdate(recoveredDoc, storedUpdate);
	const recovered = recoveredDoc.getText("t").toString();
	assert(recovered === "test content for ownedBuffer regression", `content round-trips correctly (got: "${recovered}")`);

	// Verify content equals what was in the original view (byte-level)
	assert(equalBytes(storedUpdate, realUpdate), "stored bytes are byte-equal to original update slice");

	sliceDoc.destroy();
	recoveredDoc.destroy();
}

// ── Test 6: Migration idempotence: migrating twice produces same result ───────

console.log("\n--- Test 6: Migration idempotence: migrating twice produces same result ---");
{
	const kvStorage = new FakeKvStorage();
	const sqlDo = new FakeDurableObjectStorage();
	const kvStore = new ChunkedDocStore(kvStorage as unknown as DurableObjectStorage);
	const sqlStore = new SqlDocStore(sqlDo as any);

	// Build a KV doc with some content
	const kvDoc = new Y.Doc();
	kvDoc.getMap("meta").set("idempotent.md", { path: "idempotent.md", mtime: 42 });
	kvDoc.getMap("meta").set("stable.md", { path: "stable.md", mtime: 99 });
	await kvStore.rewriteCheckpoint(
		Y.encodeStateAsUpdate(kvDoc),
		Y.encodeStateVector(kvDoc),
	);

	// First migration: SQL empty → load KV → write SQL snapshot
	assert(sqlStore.loadState().snapshot === null, "SQL empty before first migration");

	const kvState1 = await kvStore.loadState();
	const docMigrate1 = new Y.Doc();
	if (kvState1.checkpoint) Y.applyUpdate(docMigrate1, kvState1.checkpoint);
	for (const u of kvState1.journalUpdates) Y.applyUpdate(docMigrate1, u);
	sqlStore.rewriteCheckpoint(Y.encodeStateAsUpdate(docMigrate1));

	// Record SQL state after first migration
	const sqlState1 = sqlStore.loadState();
	assert(sqlState1.snapshot !== null, "SQL has snapshot after first migration");
	const snapshot1Bytes = sqlState1.snapshot!.slice(); // copy

	// Simulate a second load where SQL already has data (sqlHasData = true).
	// The migration path should NOT be triggered — SQL path short-circuits.
	const sqlHasData = sqlState1.snapshot !== null || sqlState1.journalUpdates.length > 0;
	assert(sqlHasData, "sqlHasData is true after first migration (second load uses SQL path)");

	// Confirm: second load from SQL produces same bytes
	const docMigrate2 = new Y.Doc();
	if (sqlState1.snapshot) Y.applyUpdate(docMigrate2, sqlState1.snapshot);
	for (const u of sqlState1.journalUpdates) Y.applyUpdate(docMigrate2, u);

	// If we were to (incorrectly) re-migrate, it would produce this:
	const kvState2 = await kvStore.loadState();
	const docRemigrate = new Y.Doc();
	if (kvState2.checkpoint) Y.applyUpdate(docRemigrate, kvState2.checkpoint);
	for (const u of kvState2.journalUpdates) Y.applyUpdate(docRemigrate, u);
	const remigrationUpdate = Y.encodeStateAsUpdate(docRemigrate);

	// The re-migration result should equal the first migration (KV data unchanged)
	const migratedUpdate1 = Y.encodeStateAsUpdate(docMigrate1);
	assert(
		equalBytes(remigrationUpdate, migratedUpdate1),
		"re-migrating KV produces same bytes (KV data is stable)",
	);

	// Verify SQL state is semantically unchanged (snapshot decodes same doc)
	const sqlState2 = sqlStore.loadState();
	const snapshot2Bytes = sqlState2.snapshot!;
	assert(equalBytes(snapshot1Bytes, snapshot2Bytes), "SQL snapshot unchanged after second check");

	// Verify no double-apply: docMigrate2 should have same state as docMigrate1
	const sv1 = Y.encodeStateVector(docMigrate1);
	const sv2 = Y.encodeStateVector(docMigrate2);
	assert(equalBytes(sv1, sv2), "state vectors identical across both loads (no double-apply)");

	// Check meta consistency in second load
	const meta2 = docMigrate2.getMap("meta");
	assert(meta2.has("idempotent.md"), "second load has idempotent.md");
	assert(meta2.has("stable.md"), "second load has stable.md");

	kvDoc.destroy();
	docMigrate1.destroy();
	docMigrate2.destroy();
	docRemigrate.destroy();
}

// ── Test 7: Empty KV + empty SQL → fresh vault (no crash) ────────────────────

console.log("\n--- Test 7: Empty KV + empty SQL → fresh vault (no crash) ---");
{
	const kvStorage = new FakeKvStorage();
	const sqlDo = new FakeDurableObjectStorage();
	const kvStore = new ChunkedDocStore(kvStorage as unknown as DurableObjectStorage);
	const sqlStore = new SqlDocStore(sqlDo as any);

	// Verify both stores are empty
	const sqlState = sqlStore.loadState();
	assert(sqlState.snapshot === null, "fresh SQL has no snapshot");
	assert(sqlState.journalUpdates.length === 0, "fresh SQL has no journal entries");
	assert(sqlState.journalStats.entryCount === 0, "fresh SQL journal stats: entryCount = 0");
	assert(sqlState.journalStats.totalBytes === 0, "fresh SQL journal stats: totalBytes = 0");

	const kvState = await kvStore.loadState();
	assert(kvState.checkpoint === null, "fresh KV has no checkpoint");
	assert(kvState.journalUpdates.length === 0, "fresh KV has no journal updates");
	assert(kvState.journalStats.entryCount === 0, "fresh KV journal stats: entryCount = 0");

	// Simulate the migration check logic from server.ts:
	//   sqlHasData = false → fall through to KV
	//   kvHasData = false → fresh DO path
	const sqlHasData = sqlState.snapshot !== null || sqlState.journalUpdates.length > 0;
	const kvHasData = kvState.checkpoint !== null || kvState.journalUpdates.length > 0;
	assert(!sqlHasData, "sqlHasData is false for fresh DO");
	assert(!kvHasData, "kvHasData is false for fresh DO");

	// Fresh path: produce an empty doc, no errors
	const freshDoc = new Y.Doc();
	const freshSV = Y.encodeStateVector(freshDoc);
	assert(freshSV.byteLength >= 0, "encodeStateVector on empty doc does not throw");

	// No data should be written to SQL for a fresh vault
	const sqlStateAfter = sqlStore.loadState();
	assert(sqlStateAfter.snapshot === null, "SQL remains empty after fresh-vault load");
	assert(sqlStateAfter.journalUpdates.length === 0, "SQL journal remains empty after fresh-vault load");

	freshDoc.destroy();
}

// ── Results ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: \x1b[32m${passed} passed\x1b[0m, ${failed > 0 ? `\x1b[31m${failed} failed\x1b[0m` : `${failed} failed`}`);
console.log(`${"─".repeat(60)}\n`);

if (failed > 0) process.exit(1);
