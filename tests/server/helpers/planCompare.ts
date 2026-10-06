// Write-budget spike (int-bulk): query-plan comparison for the WITHOUT ROWID conversion of the
// bulk-create hot tables. Used by tests/server/wb-int-bulk.ts and scripts/relay2/wb/plan-compare.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSqliteStorage } from "./nodeSqliteStorage";
import { VaultStore, type VaultStoragePort } from "../../../server/src/vaultStore";

export const CONVERTED_TABLES = ["vault_document_heads", "vault_checkpoints", "vault_checkpoint_manifests",
	"vault_catalog_events", "vault_mutation_attribution", "vault_attachment_catalog_events"] as const;

export function sqlitePort(sqlite: NodeSqliteStorage): VaultStoragePort {
	return { sql: sqlite.sql, transactionSync: <T>(closure: () => T): T => sqlite.transactionSync(closure) } as unknown as VaultStoragePort;
}

/** The converted tables as created before the change (rowid tables), from the current DDL minus WITHOUT ROWID. */
export async function legacyTableDdl(): Promise<string[]> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-legacy-ddl-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "ddl.sqlite"));
	try {
		new VaultStore(sqlitePort(sqlite)).currentSequence();
		return CONVERTED_TABLES.map((table) => {
			const sql = sqlite.sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table).one().sql;
			if (!/WITHOUT\s+ROWID\s*$/i.test(sql)) throw new Error(`${table} is not WITHOUT ROWID on a new database`);
			return sql.replace(/\s*WITHOUT\s+ROWID\s*$/i, "");
		});
	} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

export function isWithoutRowid(sqlite: NodeSqliteStorage, table: string): boolean {
	const row = sqlite.sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray()[0];
	if (!row) throw new Error(`missing table ${table}`);
	return /WITHOUT\s+ROWID\s*$/i.test(row.sql);
}

export interface PlanComparison { query: string; legacy: string[]; fresh: string[]; regression: string | null }

export function plan(sqlite: NodeSqliteStorage, query: string): string[] {
	return sqlite.sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`).toArray().map((row) => row.detail);
}

const TOUCHES = new RegExp(`\\b(${CONVERTED_TABLES.join("|")})\\b`);
const FULL_SCAN = new RegExp(`^SCAN (${CONVERTED_TABLES.join("|")})( |$)`);

/**
 * Plans every SELECT/INSERT/UPDATE/DELETE/WITH naming a converted table on both databases
 * (unbound parameters plan as NULL). Regression: fewer keyed SEARCH steps, more full SCANs of a
 * converted table (a covering-index SCAN still reads every entry, so it counts as one), or a new
 * temp b-tree sort (an ordered index walk the table no longer offers).
 */
export function comparePlans(fresh: NodeSqliteStorage, legacy: NodeSqliteStorage, queries: Iterable<string>): {
	compared: PlanComparison[]; skipped: Array<{ query: string; error: string }> } {
	const compared: PlanComparison[] = [];
	const skipped: Array<{ query: string; error: string }> = [];
	const searches = (details: string[]) => details.filter((detail) => /^SEARCH /.test(detail)).length;
	const scans = (details: string[]) => details.filter((detail) => FULL_SCAN.test(detail)).length;
	const sorts = (details: string[]) => details.filter((detail) => /USE TEMP B-TREE/.test(detail)).length;
	for (const query of new Set(queries)) {
		if (!TOUCHES.test(query) || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b/i.test(query)) continue;
		if (/;\s*\S/.test(query.replace(/'[^']*'/g, "''"))) continue; // multi-statement DDL batches
		let before: string[];
		let after: string[];
		try {
			before = plan(legacy, query);
			after = plan(fresh, query);
		} catch (error) {
			skipped.push({ query, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		let regression: string | null = null;
		if (searches(after) < searches(before)) regression = "fewer keyed SEARCH steps";
		else if (scans(after) > scans(before)) regression = "more full SCANs of a converted table";
		else if (sorts(after) > sorts(before)) regression = "new temp b-tree sort";
		compared.push({ query, legacy: before, fresh: after, regression });
	}
	return { compared, skipped };
}
