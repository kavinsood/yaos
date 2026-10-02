// Write-budget spike (int-bulk): capture every distinct SQL text prepared through node:sqlite
// in a test process, for scripts/relay2/wb/plan-compare.ts.
//   YAOS_SQL_CAPTURE_FILE=<file.jsonl> node --import ./scripts/relay2/wb/sql-capture.mjs tests/run-typescript.mjs --test-aliases <suite>
// Appends one JSON string per distinct statement on exit. Test tooling only; never loaded by the server.
import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const file = process.env.YAOS_SQL_CAPTURE_FILE;
if (file) {
	const seen = new Set();
	const prepare = DatabaseSync.prototype.prepare;
	DatabaseSync.prototype.prepare = function patchedPrepare(sql, ...rest) {
		if (typeof sql === "string") seen.add(sql);
		return prepare.call(this, sql, ...rest);
	};
	const exec = DatabaseSync.prototype.exec;
	DatabaseSync.prototype.exec = function patchedExec(sql, ...rest) {
		if (typeof sql === "string") seen.add(sql);
		return exec.call(this, sql, ...rest);
	};
	process.on("exit", () => {
		if (seen.size) appendFileSync(file, [...seen].map((sql) => JSON.stringify(sql)).join("\n") + "\n");
	});
}
