/**
 * Fake Durable Object SQLite storage for SqlDocStore-backed tests.
 *
 * No cast is needed to construct a `SqlDocStore` over this: SqlDocStore's
 * parameter type `DurableObjectStorageWithSql` (sqlDocStore.ts:81) is private,
 * so a test cannot *name* it, but `FakeDurableObjectStorage` satisfies it
 * structurally, and structural satisfaction is all `new SqlDocStore(...)`
 * asks for.  Note that sqlDocStore.ts:72-79 declares its own local `SqlStorage`
 * and `SqlStorageCursor` interfaces that shadow the identically named
 * @cloudflare/workers-types globals and are strictly weaker than them — an
 * unconstrained row type and a two-member cursor.  The shapes below mirror that
 * local surface deliberately; matching the real worker-types `SqlStorage`
 * instead would make this fake *unassignable* to the product parameter, because
 * the real `exec` constrains its row type to `Record<string, SqlStorageValue>`
 * and the product's does not.
 *
 * Two behaviours matter beyond the query table:
 *   - `transactionSync` rolls back on throw, as real DO storage does.  The
 *     checkpoint path deletes the old snapshot and journal before inserting the
 *     new ones, so a fake that leaked partial state would show data loss the
 *     real store cannot suffer.
 *   - `failWritesAfterBytes` makes writes fail the way a storage limit does.
 *     That is the only way to reach the store's and the coordinator's failure
 *     branches, and it fails *before* mutating a table, so a rolled-back
 *     transaction leaves exactly the pre-transaction rows.
 */

class FakeSqlCursor<T> {
	constructor(private readonly rows: T[]) {}
	toArray(): T[] { return this.rows; }
	[Symbol.iterator](): Iterator<T> { return this.rows[Symbol.iterator](); }
}

/** Opaque pre-transaction state, restored if the transaction throws. */
interface TableSnapshot {
	tables: Array<[string, Array<Record<string, unknown>>]>;
	journalAutoInc: number;
	bytesWritten: number;
}

export class FakeSqlStorage {
	private tables = new Map<string, Array<Record<string, unknown>>>();
	private journalAutoInc = 1;

	/**
	 * Cumulative payload bytes past which every write throws.  `Infinity`
	 * (the default) never fails.  Counts only BLOB payload bytes, which is what
	 * a size-driven storage failure would key on.
	 */
	failWritesAfterBytes = Infinity;

	/** Writes rejected by the threshold above. */
	writeFailures = 0;

	snapshotTotalBias = 0;
	rowsRead = 0;
	journalRowsScanned = 0;
	private bytesWritten = 0;

	/** Re-arm the threshold from zero, e.g. after re-enabling writes. */
	resetBytesWritten(): void {
		this.bytesWritten = 0;
	}

	/** Ground truth from the tables, bypassing exec() and its counters. */
	journalTruth(): { entryCount: number; totalBytes: number } {
		const rows = this.tables.get("journal") ?? [];
		return {
			entryCount: rows.length,
			totalBytes: rows.reduce((sum, row) => sum + (row.byte_length as number), 0),
		};
	}
	seedJournalRows(byteLengths: readonly number[]): void {
		for (const byteLength of byteLengths) {
			this.rowsOf("journal").push({
				id: this.journalAutoInc++,
				data: new Uint8Array(byteLength).buffer,
				byte_length: byteLength,
			});
		}
	}

	getJournalRows(): Array<Record<string, unknown>> {
		return this.tables.get("journal") ?? [];
	}

	getSnapshotRows(): Array<Record<string, unknown>> {
		return this.tables.get("snapshot_chunks") ?? [];
	}

	snapshotTables(): TableSnapshot {
		return {
			tables: [...this.tables].map(([name, rows]) => [name, [...rows]]),
			journalAutoInc: this.journalAutoInc,
			bytesWritten: this.bytesWritten,
		};
	}

	restoreTables(snapshot: TableSnapshot): void {
		this.tables = new Map(snapshot.tables.map(([name, rows]) => [name, [...rows]]));
		this.journalAutoInc = snapshot.journalAutoInc;
		this.bytesWritten = snapshot.bytesWritten;
	}

	private chargeWrite(bytes: number): void {
		if (this.bytesWritten + bytes > this.failWritesAfterBytes) {
			this.writeFailures++;
			throw new Error("SIMULATED_STORAGE_FAILURE: write exceeds threshold");
		}
		this.bytesWritten += bytes;
	}

	private rowsOf(name: string): Array<Record<string, unknown>> {
		let rows = this.tables.get(name);
		if (!rows) {
			rows = [];
			this.tables.set(name, rows);
		}
		return rows;
	}

	exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): FakeSqlCursor<T> {
		const trimmed = query.trim().replace(/\s+/g, " ");

		if (trimmed.startsWith("CREATE TABLE IF NOT EXISTS")) {
			const table = trimmed.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
			if (table !== undefined) this.rowsOf(table);
			return new FakeSqlCursor<T>([]);
		}

		if (trimmed.startsWith("INSERT INTO snapshot_chunks")) {
			const [chunkIndex, data] = bindings as [number, ArrayBuffer];
			this.chargeWrite(data.byteLength);
			this.rowsOf("snapshot_chunks").push({ chunk_index: chunkIndex, data });
			return new FakeSqlCursor<T>([]);
		}

		if (trimmed.startsWith("INSERT INTO journal")) {
			const [data, byteLength] = bindings as [ArrayBuffer, number];
			this.chargeWrite(byteLength);
			const id = this.journalAutoInc++;
			this.rowsOf("journal").push({ id, data, byte_length: byteLength });
			return new FakeSqlCursor<T>([]);
		}

		// Pre-sizing aggregate for the contiguous snapshot buffer.
		if (trimmed.includes("COUNT(*)") && trimmed.includes("snapshot_chunks")) {
			const rows = this.tables.get("snapshot_chunks") ?? [];
			const total = rows.reduce(
				(sum, row) => sum + (row.data as ArrayBuffer).byteLength,
				0,
			) + this.snapshotTotalBias;
			this.rowsRead++;
			return new FakeSqlCursor<T>([{ cnt: rows.length, total } as T]);
		}

		if (trimmed.includes("COUNT(*)") && trimmed.includes("journal")) {
			const truth = this.journalTruth();
			this.rowsRead++;
			this.journalRowsScanned += truth.entryCount;
			return new FakeSqlCursor<T>([{ cnt: truth.entryCount, total: truth.totalBytes } as T]);
		}

		if (trimmed.startsWith("SELECT data FROM snapshot_chunks")) {
			const rows = [...(this.tables.get("snapshot_chunks") ?? [])];
			rows.sort((a, b) => (a.chunk_index as number) - (b.chunk_index as number));
			this.rowsRead += rows.length;
			return new FakeSqlCursor<T>(rows as T[]);
		}

		// `SELECT data` is the coalesce read; `SELECT data, byte_length` is loadState.
		if (trimmed.startsWith("SELECT data FROM journal") || trimmed.startsWith("SELECT data, byte_length FROM journal")) {
			const rows = [...(this.tables.get("journal") ?? [])];
			rows.sort((a, b) => (a.id as number) - (b.id as number));
			if (trimmed.startsWith("SELECT data, byte_length")) {
				this.rowsRead += rows.length;
				this.journalRowsScanned += rows.length;
			}
			return new FakeSqlCursor<T>(rows as T[]);
		}

		if (trimmed.startsWith("DELETE FROM snapshot_chunks")) {
			this.tables.set("snapshot_chunks", []);
			return new FakeSqlCursor<T>([]);
		}

		if (trimmed.startsWith("DELETE FROM journal")) {
			this.tables.set("journal", []);
			this.journalAutoInc = 1;
			return new FakeSqlCursor<T>([]);
		}

		throw new Error(`FakeSqlStorage: unhandled query: ${trimmed}`);
	}
}

export class FakeDurableObjectStorage {
	readonly sql = new FakeSqlStorage();

	transactionSync<T>(closure: () => T): T {
		const undo = this.sql.snapshotTables();
		try {
			return closure();
		} catch (err) {
			this.sql.restoreTables(undo);
			throw err;
		}
	}
}
