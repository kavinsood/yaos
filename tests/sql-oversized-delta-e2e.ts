/**
 * End-to-end tests for the >2MB delta handling path.
 *
 * Tests the full chain from SqlDocStore's size guard through
 * PersistenceCoordinator's checkpoint-fallback routing.
 */

import { SqlDocStore } from "../server/src/sqlDocStore";
import { PersistenceCoordinator } from "../server/src/persistenceCoordinator";
import * as Y from "yjs";

// ── Fake SQLite storage (copied from tests/sql-doc-store.ts pattern) ─────────

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

	/** Expose raw journal table for assertions. */
	getJournalRows(): Array<Record<string, unknown>> {
		return this.tables.get("journal") ?? [];
	}

	/** Expose raw snapshot_chunks table for assertions. */
	getSnapshotRows(): Array<Record<string, unknown>> {
		return this.tables.get("snapshot_chunks") ?? [];
	}
}

class FakeDurableObjectStorage {
	sql = new FakeSqlStorage();
	transactionSync<T>(closure: () => T): T {
		return closure();
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

/**
 * Build a Y.Doc whose full encoded state is approximately `targetBytes` large.
 * Inserts a large string into a Y.Text so the encoded update approaches the target.
 */
function makeDocWithSize(targetBytes: number): Y.Doc {
	const doc = new Y.Doc();
	const text = doc.getText("content");
	// Y.Text string content encodes at roughly 1 byte/char overhead is low,
	// so inserting targetBytes characters should produce an update close to targetBytes.
	text.insert(0, "x".repeat(targetBytes));
	return doc;
}

// ── Test 1: Delta just below threshold (1.4MB) → appends to journal normally ─

console.log("\n--- Test 1: delta just below threshold (1.4MB) → journal append ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	const doc = new Y.Doc();
	const text = doc.getText("content");
	// Insert ~1.4MB of content
	text.insert(0, "A".repeat(1_400_000));

	const update = Y.encodeStateAsUpdate(doc);
	assert(
		update.byteLength > 1_000_000 && update.byteLength < 1.5 * 1024 * 1024,
		`update is between 1MB and 1.5MB (got ${update.byteLength} bytes)`,
	);

	let result: ReturnType<typeof store.appendUpdate> | undefined;
	let threw = false;
	try {
		result = store.appendUpdate(update);
	} catch {
		threw = true;
	}

	assert(!threw, "no exception thrown for 1.4MB delta");
	assert(result !== null && result !== undefined, "returns JournalStats (not null)");
	assert(result !== null && result!.entryCount === 1, `entryCount === 1 (got ${result?.entryCount})`);

	doc.destroy();
}

// ── Test 2: Delta above threshold (2MB) → returns null, no SQL exception ─────

console.log("\n--- Test 2: delta above threshold (2MB) → returns null, no exception ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	// Create a raw 2MB Uint8Array as the oversized update
	const bigDelta = new Uint8Array(2 * 1024 * 1024); // exactly 2MB
	bigDelta.fill(0xab);

	let result: ReturnType<typeof store.appendUpdate> | undefined;
	let threw = false;
	try {
		result = store.appendUpdate(bigDelta);
	} catch {
		threw = true;
	}

	assert(!threw, "no exception thrown for 2MB delta");
	assert(result === null, "appendUpdate returns null for oversized delta");

	const stats = store.getJournalStats();
	assert(stats.entryCount === 0, `journal has 0 entries after rejected oversized write (got ${stats.entryCount})`);
}

// ── Test 3: Full coordinator path: oversized delta → checkpoint fallback ──────

console.log("\n--- Test 3: coordinator oversized delta → checkpoint-fallback succeeds ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	const doc = new Y.Doc();
	const text = doc.getText("content");
	// ~2MB of text — large enough to produce a >1.5MB encoded delta
	text.insert(0, "Z".repeat(2_000_000));

	const coordinator = new PersistenceCoordinator(doc, store as any);
	coordinator.setInitialStateVector(Y.encodeStateVector(new Y.Doc())); // empty base

	const result = await coordinator.enqueueSave();

	assert(result.success === true, `save succeeds (got success=${result.success}, error=${result.error})`);
	assert(
		result.method === "checkpoint-fallback",
		`method is "checkpoint-fallback" (got "${result.method}")`,
	);

	const journalStats = store.getJournalStats();
	assert(
		journalStats.entryCount === 0,
		`journal has 0 entries (all went to checkpoint, got ${journalStats.entryCount})`,
	);

	const snapshotRows = storage.sql.getSnapshotRows();
	assert(snapshotRows.length >= 1, `SQL snapshot exists (got ${snapshotRows.length} chunk rows)`);

	assert(coordinator.health.status === "healthy", `health.status is "healthy" (got "${coordinator.health.status}")`);
	assert(
		coordinator.health.checkpointFallbackCount >= 1,
		`checkpointFallbackCount >= 1 (got ${coordinator.health.checkpointFallbackCount})`,
	);

	doc.destroy();
}

// ── Test 4: Repeated oversized updates → no infinite loop ─────────────────────

console.log("\n--- Test 4: repeated oversized updates → no infinite loop, all succeed ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	// Start with a moderately large doc
	const doc = new Y.Doc();
	const text = doc.getText("content");
	text.insert(0, "B".repeat(2_000_000));

	const coordinator = new PersistenceCoordinator(doc, store as any);
	coordinator.setInitialStateVector(Y.encodeStateVector(new Y.Doc())); // empty base

	const results = [];
	for (let i = 0; i < 5; i++) {
		// Each iteration: add more content so there is always a new delta
		// The coordinator tracks lastPersistedStateVector, so after the first
		// checkpoint the delta is from the checkpoint forward — we add content each time.
		text.insert(text.length, "C".repeat(2_000_000));
		results.push(await coordinator.enqueueSave());
	}

	for (let i = 0; i < 5; i++) {
		const r = results[i]!;
		assert(r.success === true, `save ${i + 1} succeeded (method=${r.method}, error=${r.error})`);
	}

	assert(
		coordinator.health.status !== "degraded",
		`no degraded state after 5 oversized saves (status="${coordinator.health.status}")`,
	);

	assert(
		coordinator.health.checkpointFallbackCount === 5,
		`checkpointFallbackCount === 5 (got ${coordinator.health.checkpointFallbackCount})`,
	);

	const journalStats = store.getJournalStats();
	assert(
		journalStats.entryCount === 0,
		`journal stays at 0 — all went to checkpoint (got ${journalStats.entryCount})`,
	);

	doc.destroy();
}

// ── Test 5: Normal small delta after oversized → appends to journal normally ──

console.log("\n--- Test 5: small delta after oversized checkpoint → journal append ---");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage as any);

	const doc = new Y.Doc();
	const text = doc.getText("content");

	// First save: oversized — goes to checkpoint
	text.insert(0, "D".repeat(2_000_000));
	const coordinator = new PersistenceCoordinator(doc, store as any);
	coordinator.setInitialStateVector(Y.encodeStateVector(new Y.Doc()));

	const oversizedResult = await coordinator.enqueueSave();
	assert(
		oversizedResult.method === "checkpoint-fallback",
		`first save is checkpoint-fallback (got "${oversizedResult.method}")`,
	);

	// Now make a small edit
	text.insert(text.length, "small edit");
	const smallResult = await coordinator.enqueueSave();

	assert(
		smallResult.success === true,
		`small delta save succeeds (error=${smallResult.error})`,
	);
	assert(
		smallResult.method === "append",
		`small delta uses "append" path (got "${smallResult.method}")`,
	);

	const journalStats = store.getJournalStats();
	assert(
		journalStats.entryCount === 1,
		`journal has 1 entry after small delta (got ${journalStats.entryCount})`,
	);

	doc.destroy();
}

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

if (failed > 0) process.exit(1);
