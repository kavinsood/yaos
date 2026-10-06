// Write-budget spike: Cloudflare "rows written" model for Node SQLite tests.
//
// Node's `cursor.rowsWritten` is SQLite `total_changes()`: table rows only. Cloudflare
// (workerd's DO SQLite counter) also bills index b-tree entries. The rules below were
// measured on workerd itself (miniflare 4.20260305, `cursor.rowsWritten` per statement;
// probe in experiments/logs/wb/int-bulk/probe/) and cross-checked end to end against the
// W1 exact counter (`debug/sql-rows`) on a local `wrangler dev`:
//
//   INSERT  1 per row + 1 per index entry (every secondary index, the autoindex of a
//           non-INTEGER PRIMARY KEY and of every UNIQUE constraint on a rowid table;
//           a WITHOUT ROWID table's PRIMARY KEY *is* the table, so it adds nothing)
//   UPDATE  1 per row + 1 per index whose columns include a SET column (even when the
//           value is unchanged)
//   DELETE  1 per row (index entries removed by a DELETE are not billed by workerd)
//   UPSERT  INSERT ... ON CONFLICT DO UPDATE that takes the UPDATE branch bills as an UPDATE
//           (probed: rowid text-PK table 1 row, not 2); `exec` tells the branches apart by
//           counting the table before and after.
//
// Docs: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
// ("every row update of an index counts as an additional row"; deletes count).
import type { NodeSqliteStorage } from "./nodeSqliteStorage";

interface IndexInfo { name: string; columns: string[] }

export interface CfRowTotals {
	/** Node total_changes (table rows). */
	node: number;
	/** Cloudflare-billed rows under the model above. */
	cf: number;
	/** CF rows per `table` (table b-tree) and per `table:index` (index entries). */
	byObject: Map<string, number>;
	/** Node rows per table. */
	byTable: Map<string, number>;
}

const UPSERT = /\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i;
const DML = /^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([A-Za-z_][A-Za-z0-9_]*)/i;

export class CfRowModel {
	readonly totals: CfRowTotals = { node: 0, cf: 0, byObject: new Map(), byTable: new Map() };
	private readonly indexes = new Map<string, IndexInfo[]>();

	constructor(private readonly sqlite: NodeSqliteStorage) {}

	reset(): void {
		this.totals.node = 0;
		this.totals.cf = 0;
		this.totals.byObject.clear();
		this.totals.byTable.clear();
	}

	/** Schema may change between statements (lazy tables, WITHOUT ROWID variants): call after DDL. */
	forgetSchema(): void { this.indexes.clear(); }

	/** Billable index b-trees of `table` (excludes a WITHOUT ROWID table's own PK). */
	indexesOf(table: string): IndexInfo[] {
		const cached = this.indexes.get(table);
		if (cached) return cached;
		const master = this.sqlite.sql.exec<{ sql: string | null }>(
			"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray()[0];
		const withoutRowid = /WITHOUT\s+ROWID/i.test(master?.sql ?? "");
		const list = this.sqlite.sql.exec<{ name: string; origin: string }>(
			"SELECT name, origin FROM pragma_index_list(?)", table).toArray();
		const result = list.filter((index) => !(withoutRowid && index.origin === "pk")).map((index) => ({
			name: index.name,
			columns: this.sqlite.sql.exec<{ name: string | null }>("SELECT name FROM pragma_index_info(?)", index.name)
				.toArray().map((column) => (column.name ?? "").toLowerCase()),
		}));
		this.indexes.set(table, result);
		return result;
	}

	/** Executes on the wrapped database and accounts the statement (DDL resets the schema cache). */
	exec(query: string, ...bindings: unknown[]): ReturnType<NodeSqliteStorage["sql"]["exec"]> {
		const upsertTable = UPSERT.test(query) ? DML.exec(query)?.[2] : undefined;
		const count = (table: string) => this.sqlite.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count;
		const before = upsertTable ? count(upsertTable) : 0;
		const cursor = this.sqlite.sql.exec(query, ...(bindings as never[]));
		if (/^\s*(CREATE|DROP|ALTER)\b/i.test(query)) this.forgetSchema();
		else this.record(query, cursor.rowsWritten, upsertTable ? count(upsertTable) - before : undefined);
		return cursor;
	}

	/**
	 * Account one executed statement given its node rowsWritten. For an upsert, `inserted` is the
	 * number of rows that took the INSERT branch (the rest updated); absent, all are inserts.
	 */
	record(query: string, written: number, inserted = written): void {
		if (written <= 0) return;
		const match = DML.exec(query);
		if (!match) return;
		const verb = match[1]!.toUpperCase();
		const table = match[2]!;
		const add = (key: string, rows: number) => {
			this.totals.byObject.set(key, (this.totals.byObject.get(key) ?? 0) + rows);
			this.totals.cf += rows;
		};
		this.totals.node += written;
		this.totals.byTable.set(table, (this.totals.byTable.get(table) ?? 0) + written);
		add(table, written);
		if (verb.startsWith("DELETE")) return;
		const indexes = this.indexesOf(table);
		if (verb.startsWith("UPDATE")) {
			const set = /\bSET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/i.exec(query)?.[1] ?? "";
			const columns = new Set([...set.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]!.toLowerCase()));
			for (const index of indexes) if (index.columns.some((column) => columns.has(column))) add(`${table}:${index.name}`, written);
			return;
		}
		const updated = written - inserted;
		const set = updated > 0 ? /\bDO\s+UPDATE\s+SET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/i.exec(query)?.[1] ?? "" : "";
		const columns = new Set([...set.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((m) => m[1]!.toLowerCase()));
		for (const index of indexes) {
			const rows = inserted + (index.columns.some((column) => columns.has(column)) ? updated : 0);
			if (rows > 0) add(`${table}:${index.name}`, rows);
		}
	}
}
