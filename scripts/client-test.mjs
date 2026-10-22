#!/usr/bin/env node
// Runs the new client's tests: every src/**/*.test.ts under node:test, loaded through jiti, except the slow
// *.sim.test.ts sweeps and measured runs (`npm run test:sim`, scripts/sim-test.mjs).
// Dots on stdout; every failing test is named on stderr as it fails and again at the end.
// Usage: node scripts/client-test.mjs [substring-filter ...]
// YAOS_TEST_JOBS=N caps the test files run at once (node --test-concurrency); unset keeps node's default (CI).
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
		else if (name.endsWith(".test.ts") && !name.endsWith(".sim.test.ts")) files.push(relative(ROOT, p));
	}
})(join(ROOT, "src"));
const selected = files.filter((f) => filters.length === 0 || filters.some((s) => f.includes(s))).sort();
if (selected.length === 0) {
	console.log("client-test: no test files matched");
	process.exit(0);
}
const jobs = process.env.YAOS_TEST_JOBS;
if (jobs !== undefined && !/^[1-9][0-9]*$/.test(jobs)) {
	console.error(`client-test: YAOS_TEST_JOBS must be a positive integer, got ${JSON.stringify(jobs)}`);
	process.exit(2);
}
const t0 = Date.now();
const r = spawnSync(process.execPath, [
	"--import", "jiti/register", "--test",
	// A test that leaves an engine running (e.g. it threw after starting one) must not hang the run: exit once a
	// file's tests are done, and fail any single test still running after 5 minutes.
	"--test-force-exit", "--test-timeout=300000",
	...(jobs === undefined ? [] : [`--test-concurrency=${jobs}`]),
	"--test-reporter=dot", "--test-reporter-destination=stdout",
	"--test-reporter=./scripts/test-failures-reporter.mjs", "--test-reporter-destination=stderr",
	...selected,
], {
	cwd: ROOT,
	stdio: "inherit",
	env: { ...process.env, YAOS_CLIENT_TEST: "1" },
});
const how = r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
console.log(`client-test: ${selected.length} files, ${how}, wall ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(r.status ?? 1);
