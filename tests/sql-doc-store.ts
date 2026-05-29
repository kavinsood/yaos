/**
 * Tests for SqlDocStore — validates CRUD, compaction, size limits, and
 * the KV-to-SQL migration path.
 */

import { SqlDocStore } from "../server/src/sqlDocStore";
import * as Y from "yjs";

// ── Fake SQLite storage ─────────────────────────────────────────────────────

class FakeSqlCursor<T> {
	constructor(private readonly rows: T[]) {}
	toArray(): T[] { return this.rows; }
	[Symbol.iterator](): Iterator<T> { return this.rows[Symbol.iterator](); }
}

class FakeSqlStorage {
	private tables: Map<string, Array<Record<string, unknown>>> = new Map();
	private autoIncrements: Map<string, number> = new Map();

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
		// Simple: just execute.  A real impl would rollback on throw.
		return closure();
	}
}

// ── Test helpers ────────────────────────────────────────────────────────────

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

function makeDoc(fileCount: number): Y.Doc {
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");
	for (let i = 0; i < fileCount; i++) {
		meta.set(`file-${i}`, { path: `notes/file-${i}.md`, mtime: Date.now() });
	}
	return doc;
}

// ── Tests ───────────────────────────────────────────────────────────────────

console.log("\n--- Test 1: empty state ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);
	const state = store.loadState();
	assert(state.snapshot === null, "no snapshot");
	assert(state.journalUpdates.length === 0, "no journal entries");
	assert(state.journalStats.entryCount === 0, "entry count is 0");
	assert(state.journalStats.totalBytes === 0, "total bytes is 0");
}

console.log("\n--- Test 2: append and load ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	const doc = makeDoc(10);
	const update = Y.encodeStateAsUpdate(doc);
	const stats = store.appendUpdate(update);
	assert(stats !== null, "append succeeds");
	assert(stats!.entryCount === 1, `entry count is 1 (got ${stats!.entryCount})`);
	assert(stats!.totalBytes === update.byteLength, "total bytes matches");

	// Load and verify
	const state = store.loadState();
	assert(state.snapshot === null, "no snapshot yet");
	assert(state.journalUpdates.length === 1, "one journal entry");

	// Apply to a new doc and check content
	const doc2 = new Y.Doc();
	Y.applyUpdate(doc2, state.journalUpdates[0]);
	const meta2 = doc2.getMap("meta");
	assert(meta2.size === 10, `loaded doc has 10 entries (got ${meta2.size})`);
	doc.destroy();
	doc2.destroy();
}

console.log("\n--- Test 3: rewriteCheckpoint clears journal ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	const doc = makeDoc(50);
	// Append some entries
	for (let i = 0; i < 5; i++) {
		doc.getMap("meta").set(`extra-${i}`, { path: `extra-${i}.md`, mtime: Date.now() });
		store.appendUpdate(Y.encodeStateAsUpdate(doc));
	}
	const beforeStats = store.getJournalStats();
	assert(beforeStats.entryCount === 5, `5 journal entries before compact (got ${beforeStats.entryCount})`);

	// Compact
	const fullUpdate = Y.encodeStateAsUpdate(doc);
	store.rewriteCheckpoint(fullUpdate);

	const afterStats = store.getJournalStats();
	assert(afterStats.entryCount === 0, "journal cleared after checkpoint");
	assert(afterStats.totalBytes === 0, "journal bytes cleared");

	// Load and verify snapshot exists
	const state = store.loadState();
	assert(state.snapshot !== null, "snapshot exists after checkpoint");
	assert(state.journalUpdates.length === 0, "no journal after checkpoint");

	// Verify content round-trips
	const doc2 = new Y.Doc();
	Y.applyUpdate(doc2, state.snapshot!);
	const meta2 = doc2.getMap("meta");
	assert(meta2.size === 55, `checkpoint has all 55 entries (got ${meta2.size})`);
	doc.destroy();
	doc2.destroy();
}

console.log("\n--- Test 4: snapshot chunking for large docs ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	// Create a doc large enough to need multiple chunks (>1MB)
	const doc = new Y.Doc();
	const text = doc.getText("bigfile");
	// ~1.5MB of text content
	const bigContent = "x".repeat(1_500_000);
	text.insert(0, bigContent);

	const fullUpdate = Y.encodeStateAsUpdate(doc);
	assert(fullUpdate.byteLength > 1_000_000, `encoded doc is >1MB (got ${fullUpdate.byteLength})`);

	store.rewriteCheckpoint(fullUpdate);
	const state = store.loadState();
	assert(state.snapshot !== null, "snapshot loaded");
	assert(state.snapshot!.byteLength === fullUpdate.byteLength, "snapshot round-trips exactly");

	// Verify content
	const doc2 = new Y.Doc();
	Y.applyUpdate(doc2, state.snapshot!);
	assert(doc2.getText("bigfile").toString().length === 1_500_000, "content preserved");
	doc.destroy();
	doc2.destroy();
}

console.log("\n--- Test 5: oversized delta returns null (not exception) ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	// Create a delta larger than 1.5MB
	const bigDelta = new Uint8Array(2 * 1024 * 1024); // 2MB
	bigDelta.fill(42);

	const result = store.appendUpdate(bigDelta);
	assert(result === null, "oversized append returns null");

	// Verify nothing was written
	const stats = store.getJournalStats();
	assert(stats.entryCount === 0, "no journal entry written for oversized delta");
}

console.log("\n--- Test 6: snapshot + journal replay produces correct state ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	// Write initial checkpoint
	const doc = makeDoc(100);
	store.rewriteCheckpoint(Y.encodeStateAsUpdate(doc));

	// Append additional changes as journal entries
	doc.getMap("meta").set("new-file", { path: "new.md", mtime: Date.now() });
	const delta = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc));
	// Use full update relative to checkpoint for the delta
	const fullAfter = Y.encodeStateAsUpdate(doc);
	store.appendUpdate(fullAfter);

	// Load and replay
	const state = store.loadState();
	const doc2 = new Y.Doc();
	if (state.snapshot) Y.applyUpdate(doc2, state.snapshot);
	for (const u of state.journalUpdates) Y.applyUpdate(doc2, u);

	const meta2 = doc2.getMap("meta");
	assert(meta2.has("new-file"), "journal delta applied correctly");
	assert(meta2.size === 101, `final state has 101 entries (got ${meta2.size})`);
	doc.destroy();
	doc2.destroy();
}

console.log("\n--- Test 7: KV-to-SQL migration simulation ---");
{
	// Simulate: SQL store is empty, ChunkedDocStore has data
	// The migration logic lives in server.ts, but we can verify the
	// SqlDocStore correctly handles "load empty → write checkpoint" flow

	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	// Verify empty
	const emptyState = store.loadState();
	assert(emptyState.snapshot === null, "SQL is empty before migration");

	// Simulate migration: create a doc as if loaded from KV, write to SQL
	const kvDoc = makeDoc(200);
	const kvState = Y.encodeStateAsUpdate(kvDoc);
	store.rewriteCheckpoint(kvState);

	// Verify migration succeeded
	const migratedState = store.loadState();
	assert(migratedState.snapshot !== null, "snapshot exists after migration");
	assert(migratedState.journalUpdates.length === 0, "no journal after migration");

	const doc2 = new Y.Doc();
	Y.applyUpdate(doc2, migratedState.snapshot!);
	const meta2 = doc2.getMap("meta");
	assert(meta2.size === 200, `migrated doc has 200 entries (got ${meta2.size})`);
	kvDoc.destroy();
	doc2.destroy();
}

// ── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

if (failed > 0) process.exit(1);
