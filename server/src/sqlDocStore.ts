/**
 * SqlDocStore: Native SQLite storage for Y.Doc persistence.
 *
 * Replaces ChunkedDocStore's hand-rolled MVCC-over-KV approach with
 * direct SQLite tables.  The DO SQLite API provides:
 * - ACID transactions via ctx.storage.transactionSync()
 * - No per-key batching gymnastics
 * - WAL-based write-ahead logging (CF handles this internally)
 *
 * Schema:
 *   snapshot_chunks — the compacted Y.Doc state, split into ≤1MB rows
 *   journal         — append-only delta log between compactions
 *
 * IMPORTANT — Memory contract for BLOB bindings:
 * Cloudflare's sql.exec() accepts ArrayBuffer for BLOB columns.  When
 * passing binary data, we MUST use .slice() (not .subarray()) to produce
 * an independent ArrayBuffer.  Using .subarray() shares the parent buffer
 * and .buffer would point to the ENTIRE underlying allocation, causing
 * silent data corruption or SQLITE_TOOBIG errors.
 *
 * The helper `ownedBuffer()` below enforces this contract.
 */

/** Max bytes per snapshot chunk row.  Well under the 2MB SQLite value limit. */
const SNAPSHOT_CHUNK_SIZE = 1 * 1024 * 1024; // 1MB

/**
 * Max bytes for a single journal row.  Must be under the 2MB SQLite BLOB limit.
 * We use 1.5MB to leave margin for encoding overhead.
 */
const MAX_JOURNAL_ENTRY_BYTES = 1.5 * 1024 * 1024;

/**
 * Create an owned ArrayBuffer from a Uint8Array slice.
 *
 * This is the ONLY correct way to produce an ArrayBuffer for sql.exec() BLOB
 * bindings.  It guarantees the buffer contains exactly the intended bytes and
 * nothing else.
 *
 * DO NOT replace this with .subarray().buffer — that returns the full parent
 * buffer and will silently write wrong data to the database.
 */
function ownedBuffer(bytes: Uint8Array, start: number, end: number): ArrayBuffer {
	return bytes.slice(start, end).buffer;
}

export interface JournalStats {
	entryCount: number;
	totalBytes: number;
}

export interface LoadedDocState {
	snapshot: Uint8Array | null;
	journalUpdates: Uint8Array[];
	journalStats: JournalStats;
}

interface SqlStorage {
	exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
}

interface SqlStorageCursor<T> {
	toArray(): T[];
	[Symbol.iterator](): Iterator<T>;
}

interface DurableObjectStorageWithSql {
	sql: SqlStorage;
	transactionSync<T>(closure: () => T): T;
}

/**
 * SqlDocStore provides Y.Doc persistence using native DO SQLite.
 */
export class SqlDocStore {
	private initialized = false;

	constructor(private readonly storage: DurableObjectStorageWithSql) {}

	private ensureSchema(): void {
		if (this.initialized) return;
		this.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS snapshot_chunks (
				chunk_index INTEGER PRIMARY KEY,
				data BLOB NOT NULL
			)
		`);
		this.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS journal (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				data BLOB NOT NULL,
				byte_length INTEGER NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
		this.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS _migration_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);
		this.initialized = true;
	}

	/**
	 * Record that a KV→SQL migration completed successfully.
	 * This marker distinguishes "fresh room with no data" from
	 * "successfully migrated room" from "interrupted migration."
	 */
	recordMigration(meta: {
		sourceFormat: string;
		sourceEntries: number;
		sourceBytes: number;
		snapshotBytes: number;
		activePathCount: number;
		migratedAt: string;
	}): void {
		this.ensureSchema();
		this.storage.sql.exec(
			"INSERT OR REPLACE INTO _migration_meta (key, value) VALUES (?, ?)",
			"migration_completed", "true",
		);
		this.storage.sql.exec(
			"INSERT OR REPLACE INTO _migration_meta (key, value) VALUES (?, ?)",
			"migrated_at", meta.migratedAt,
		);
		this.storage.sql.exec(
			"INSERT OR REPLACE INTO _migration_meta (key, value) VALUES (?, ?)",
			"source_format", meta.sourceFormat,
		);
		this.storage.sql.exec(
			"INSERT OR REPLACE INTO _migration_meta (key, value) VALUES (?, ?)",
			"source_entries", String(meta.sourceEntries),
		);
		this.storage.sql.exec(
			"INSERT OR REPLACE INTO _migration_meta (key, value) VALUES (?, ?)",
			"source_bytes", String(meta.sourceBytes),
		);
		this.storage.sql.exec(
			"INSERT OR REPLACE INTO _migration_meta (key, value) VALUES (?, ?)",
			"snapshot_bytes", String(meta.snapshotBytes),
		);
		this.storage.sql.exec(
			"INSERT OR REPLACE INTO _migration_meta (key, value) VALUES (?, ?)",
			"active_path_count", String(meta.activePathCount),
		);
	}

	/**
	 * Check if this SQL store has been marked as successfully migrated.
	 */
	isMigrated(): boolean {
		this.ensureSchema();
		const rows = this.storage.sql.exec<{ value: string }>(
			"SELECT value FROM _migration_meta WHERE key = ?",
			"migration_completed",
		).toArray();
		return rows.length > 0 && rows[0].value === "true";
	}

	/**
	 * Get migration metadata (returns null if not migrated).
	 */
	getMigrationMeta(): Record<string, string> | null {
		this.ensureSchema();
		const rows = this.storage.sql.exec<{ key: string; value: string }>(
			"SELECT key, value FROM _migration_meta",
		).toArray();
		if (rows.length === 0) return null;
		const meta: Record<string, string> = {};
		for (const row of rows) {
			meta[row.key] = row.value;
		}
		return meta;
	}

	/**
	 * Load the full document state: snapshot + journal replay.
	 */
	loadState(): LoadedDocState {
		this.ensureSchema();

		// Read snapshot
		const snapshotRows = this.storage.sql.exec<{ data: ArrayBuffer }>(
			"SELECT data FROM snapshot_chunks ORDER BY chunk_index",
		).toArray();

		let snapshot: Uint8Array | null = null;
		if (snapshotRows.length > 0) {
			let totalSize = 0;
			const chunks: Uint8Array[] = [];
			for (const row of snapshotRows) {
				const chunk = new Uint8Array(row.data);
				chunks.push(chunk);
				totalSize += chunk.byteLength;
			}
			snapshot = new Uint8Array(totalSize);
			let offset = 0;
			for (const chunk of chunks) {
				snapshot.set(chunk, offset);
				offset += chunk.byteLength;
			}
		}

		// Read journal
		const journalRows = this.storage.sql.exec<{ data: ArrayBuffer; byte_length: number }>(
			"SELECT data, byte_length FROM journal ORDER BY id",
		).toArray();

		const journalUpdates: Uint8Array[] = [];
		let totalBytes = 0;
		for (const row of journalRows) {
			journalUpdates.push(new Uint8Array(row.data));
			totalBytes += row.byte_length;
		}

		return {
			snapshot,
			journalUpdates,
			journalStats: {
				entryCount: journalUpdates.length,
				totalBytes,
			},
		};
	}

	/**
	 * Append a Y.Doc update to the journal.
	 *
	 * If the update exceeds MAX_JOURNAL_ENTRY_BYTES, returns `null` to signal
	 * that the caller should use rewriteCheckpoint instead.  This avoids
	 * hitting SQLITE_TOOBIG on large deltas (e.g., pasting a multi-MB document).
	 */
	appendUpdate(update: Uint8Array): JournalStats | null {
		this.ensureSchema();

		if (update.byteLength === 0) {
			return this.getJournalStats();
		}

		// Explicit size guard: do not attempt INSERT for payloads that would
		// exceed the SQLite per-value BLOB limit.  The caller (PersistenceCoordinator)
		// must fall back to rewriteCheckpoint for oversized deltas.
		if (update.byteLength > MAX_JOURNAL_ENTRY_BYTES) {
			return null;
		}

		this.storage.sql.exec(
			"INSERT INTO journal (data, byte_length) VALUES (?, ?)",
			ownedBuffer(update, 0, update.byteLength),
			update.byteLength,
		);

		return this.getJournalStats();
	}

	/**
	 * Rewrite the checkpoint: atomically replace the snapshot and clear the journal.
	 * The stateVector parameter is accepted for interface compatibility but not stored
	 * separately (it's embedded in the Y.Doc update).
	 */
	rewriteCheckpoint(update: Uint8Array, _stateVector?: Uint8Array): void {
		this.ensureSchema();

		const bytes = update;
		const chunkCount = bytes.byteLength === 0
			? 0
			: Math.ceil(bytes.byteLength / SNAPSHOT_CHUNK_SIZE);

		this.storage.transactionSync(() => {
			// Clear old snapshot and journal
			this.storage.sql.exec("DELETE FROM snapshot_chunks");
			this.storage.sql.exec("DELETE FROM journal");

			// Write new snapshot chunks using ownedBuffer for safe BLOB binding
			for (let i = 0; i < chunkCount; i++) {
				const start = i * SNAPSHOT_CHUNK_SIZE;
				const end = Math.min(start + SNAPSHOT_CHUNK_SIZE, bytes.byteLength);
				this.storage.sql.exec(
					"INSERT INTO snapshot_chunks (chunk_index, data) VALUES (?, ?)",
					i,
					ownedBuffer(bytes, start, end),
				);
			}
		});
	}

	/**
	 * Get current journal statistics.
	 */
	getJournalStats(): JournalStats {
		this.ensureSchema();

		const rows = this.storage.sql.exec<{ cnt: number; total: number }>(
			"SELECT COUNT(*) as cnt, COALESCE(SUM(byte_length), 0) as total FROM journal",
		).toArray();

		const row = rows[0];
		return {
			entryCount: row?.cnt ?? 0,
			totalBytes: row?.total ?? 0,
		};
	}
}
