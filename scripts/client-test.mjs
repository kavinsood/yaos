#!/usr/bin/env node
// Runs the new client's tests: every src/**/*.test.ts under node:test, loaded through jiti.
// Usage: node scripts/client-test.mjs [substring-filter ...]
//
// A run that fails always says what failed. The dot reporter lists failing tests at the end, but only if the runner
// gets there. On SIGTERM / SIGINT node:test exits 1 with no summary; on SIGKILL it prints nothing and spawnSync reports
// status null (this script used to turn both into a bare exit 1). So a TAP side log is kept and, on any non-zero
// ending, its failures are named here, with how the runner ended and the last test it reported.
//
// The full run passes node:test a glob, not the file list: a `pkill -f <some test file>` from another shell then
// matches only that file's child process (named as failed by the runner) instead of the whole runner.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALL = "src/**/*.test.ts";
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
const sideDir = mkdtempSync(join(tmpdir(), "yaos-client-test-"));
const tap = join(sideDir, "run.tap");
const r = spawnSync(
	process.execPath,
	[
		"--import", "jiti/register", "--test",
		"--test-reporter=dot", "--test-reporter-destination=stdout",
		"--test-reporter=tap", `--test-reporter-destination=${tap}`,
		...(filters.length === 0 ? [ALL] : selected),
	],
	{ cwd: ROOT, stdio: "inherit", env: { ...process.env, YAOS_CLIENT_TEST: "1" } },
);
const code = r.error ? 1 : r.signal ? 128 + (constants.signals[r.signal] ?? 0) : r.status ?? 1;
if (code !== 0) report();
rmSync(sideDir, { recursive: true, force: true });
process.exit(code);

function report() {
	let text = "";
	try {
		text = readFileSync(tap, "utf8");
	} catch {
		// No side log: the runner did not start.
	}
	const { failed, last, finished } = parseTap(text);
	if (!finished) process.stderr.write("\n"); // the dots end mid-line
	if (r.error) console.error(`client-test: could not run the test runner: ${r.error.message}`);
	else if (r.signal) console.error(`client-test: the test runner was killed by ${r.signal} before it finished (another process's kill?)`);
	// node:test exits 1 on SIGTERM / SIGINT without its summary: e.g. a `pkill -f` whose pattern is in its arguments.
	else if (!finished) console.error(`client-test: the test runner exited ${r.status} before it finished (node:test does so on SIGTERM / SIGINT)`);
	if (failed.length > 0) {
		console.error(`client-test: ${failed.length} failing:`);
		for (const f of failed) console.error(`  ✖ ${f}`);
	} else {
		console.error("client-test: no test reported a failure");
	}
	if (!finished && last) console.error(`client-test: last test reported: ${last}`);
	if (!r.error && !r.signal && finished && failed.length === 0) console.error(`client-test: exit ${r.status} (see the runner output above)`);
}

/** Failing tests as "parent > child" paths (leaves only), the last test reported, and whether the summary was written. */
function parseTap(text) {
	const failed = [];
	const stack = [];
	let last = null;
	for (const line of text.split("\n")) {
		const sub = /^( *)# Subtest: (.*)$/.exec(line);
		if (sub) {
			const depth = sub[1].length / 4;
			stack.length = depth;
			stack[depth] = sub[2];
			continue;
		}
		const m = /^( *)(ok|not ok) \d+ - /.exec(line);
		if (!m) continue;
		const path = stack.slice(0, m[1].length / 4 + 1).join(" > ");
		last = path;
		// A failing suite or file follows its failing children: keep the deepest entries only.
		if (m[2] === "not ok" && !failed.some((f) => f.startsWith(`${path} > `))) failed.push(path);
	}
	return { failed, last, finished: /^# tests \d+$/m.test(text) };
}
