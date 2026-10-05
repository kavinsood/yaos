#!/usr/bin/env node
// Runs the new client's tests: every src/**/*.test.ts under node:test, loaded through jiti.
// Usage: node scripts/client-test.mjs [substring-filter ...]
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const filters = process.argv.slice(2);
const files = [];
(function walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p);
		else if (name.endsWith(".test.ts")) files.push(relative(ROOT, p));
	}
})(join(ROOT, "src"));
const selected = files.filter((f) => filters.length === 0 || filters.some((s) => f.includes(s))).sort();
if (selected.length === 0) {
	console.log("client-test: no test files matched");
	process.exit(0);
}
const r = spawnSync(process.execPath, ["--import", "jiti/register", "--test", "--test-reporter=dot", ...selected], {
	cwd: ROOT,
	stdio: "inherit",
	env: { ...process.env, YAOS_CLIENT_TEST: "1" },
});
process.exit(r.status ?? 1);
