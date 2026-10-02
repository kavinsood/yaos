/**
 * Write-budget spike (int-bulk): query-plan proof for the WITHOUT ROWID conversion, over every SQL text the
 * server suites prepared.
 *
 *   YAOS_SQL_CAPTURE_FILE=cap.jsonl node --import ./scripts/relay2/wb/sql-capture.mjs tests/run-typescript.mjs --test-aliases <suite>   (per suite)
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/wb/plan-compare.ts cap.jsonl [--out report.json]
 *
 * Two databases are built with the current code: "new" (fresh: the converted tables are WITHOUT ROWID) and
 * "legacy" (the six tables pre-created as rowid tables, i.e. a database from before the change opened by the new
 * code). Rules: tests/server/helpers/planCompare.ts. Exit 1 on any regression.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { NodeSqliteStorage } from "../../../packages/server-node/src/storage";
import { VaultStore } from "../../../server/src/vaultStore";
import { comparePlans, legacyTableDdl, sqlitePort } from "../../../tests/server/helpers/planCompare";

function provision(sqlite: NodeSqliteStorage): void {
	const store = new VaultStore(sqlitePort(sqlite));
	const root = new Y.Doc({ guid: "root" });
	root.getMap("sys").set("schemaVersion", 8);
	root.getMap("sys").set("protocolVersion", 5);
	store.provisionVault("plan-vault", "plan-generation", Y.encodeStateAsUpdate(root), 1);
	root.destroy();
	store.enableLeanRows();
	store.bulkCreateReceipt("plan-probe"); // lazy receipts table
}

async function main() {
	const [capture, ...rest] = process.argv.slice(2);
	if (!capture) throw new Error("usage: plan-compare.ts <capture.jsonl> [--out report.json]");
	const out = rest.includes("--out") ? rest[rest.indexOf("--out") + 1] : undefined;
	const queries = readFileSync(capture, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string);
	const directory = await mkdtemp(join(tmpdir(), "yaos-plan-compare-"));
	const fresh = NodeSqliteStorage.open(join(directory, "new.sqlite"));
	const legacy = NodeSqliteStorage.open(join(directory, "legacy.sqlite"));
	try {
		provision(fresh);
		for (const ddl of await legacyTableDdl()) legacy.sql.exec(ddl);
		provision(legacy);
		const { compared, skipped } = comparePlans(fresh, legacy, queries);
		const regressions = compared.filter((entry) => entry.regression);
		const changed = compared.filter((entry) => entry.legacy.join("|") !== entry.fresh.join("|"));
		console.log(`[plan-compare] ${queries.length} captured, ${compared.length} statements touch converted tables; `
			+ `${changed.length} plans differ, ${regressions.length} regressions, ${skipped.length} unplannable`);
		for (const entry of regressions) console.log(`REGRESSION (${entry.regression}): ${entry.query.replace(/\s+/g, " ").slice(0, 160)}\n  legacy: ${entry.legacy.join(" | ")}\n  new:    ${entry.fresh.join(" | ")}`);
		for (const entry of skipped) console.log(`SKIPPED ${entry.error}: ${entry.query.replace(/\s+/g, " ").slice(0, 120)}`);
		if (out) writeFileSync(out, JSON.stringify({ captured: queries.length, compared, skipped }, null, 2));
		if (regressions.length) process.exitCode = 1;
	} finally {
		fresh.close();
		legacy.close();
		await rm(directory, { recursive: true, force: true });
	}
}

main().catch((error) => { console.error(error); process.exit(1); });
