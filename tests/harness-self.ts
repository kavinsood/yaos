// Regression guard for tests/harness.ts.
//
// The harness is the one file in tests/ that every other suite's verdict now
// depends on: if `done()` under-counts, mis-orders, or swallows a rejection,
// ninety suites report green while asserting nothing. That is precisely the
// failure this repo already shipped once — async test bodies that were never
// awaited, printing `0 passed, 0 failed` and exiting 0.
//
// So the harness gets tested the same way the suites it serves are, and it
// lives beside the file it guards (like tests/suite-discovery.ts beside
// tests/run-suites.mjs) rather than in a bucket: it tests test infrastructure,
// not client, server or contract behaviour, and it is registered explicitly in
// the runner's ROOT_SUITES for exactly that reason.
//
// The interesting properties — exit code, output ORDER, and "did the summary
// wait for the slow body" — are only observable from outside the process,
// because done() ends the process. Each case therefore runs as a real child
// through the same programmatic Jiti bootstrap the runner uses, and this file
// asserts against its stdout, stderr and exit status.

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSource, repoRoot, sleep, suite, until, withTempDir } from "./harness.ts";

const s = suite("harness-self");
// Child fixtures are written as .ts and run through the production test
// bootstrap with the same aliases and source-map behavior.
const TYPESCRIPT_RUNNER = join(repoRoot(), "tests/run-typescript.mjs");
const HARNESS = join(repoRoot(), "tests/harness.ts");

interface Ran {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly all: string;
}

/** Write `body` as a child suite, run it the way the runner does, capture all of it. */
function runChildSuite(dir: string, label: string, body: string): Ran {
	const file = join(dir, `${label}.ts`);
	writeFileSync(file, `import { suite, sleep } from ${JSON.stringify(HARNESS)};\n${body}`);
	const result = spawnSync("node", [TYPESCRIPT_RUNNER, "--test-aliases", file], {
		cwd: repoRoot(),
		encoding: "utf8",
		maxBuffer: 1024 * 1024 * 64,
	});
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	return { status: result.status, stdout, stderr, all: stdout + stderr };
}

await withTempDir("yaos-harness-self-", async (dir) => {
	// ── The load-bearing case: a rejected body is a counted failure ──────────
	s.section("a body whose promise rejects is one counted failure, not a lost test");
	{
		const ran = runChildSuite(dir, "rejects", `
const s = suite("child");
s.check(true, "a plain check still counts");
s.test("rejecting body", async () => {
	await sleep(5);
	throw new Error("boom");
});
s.test("test after the rejection still runs", () => {});
await s.done();
`);
		s.check(ran.status === 1, `a rejected body exits non-zero (got ${String(ran.status)})`);
		s.check(
			/Results: 2 passed, 1 failed/.test(ran.all),
			`the rejection is counted exactly once (summary was: ${JSON.stringify(summaryOf(ran))})`,
		);
		s.check(/FAIL rejecting body — boom/.test(ran.all), "the failure carries the error message");
		s.check(
			ran.all.includes("PASS test after the rejection still runs"),
			"a rejection does not abort the remaining queued tests",
		);
		s.check(
			!/SUITE DID NOT FINISH/.test(ran.all),
			"a rejected body does not crash the run before the summary",
		);
	}

	// ── The other load-bearing case: done() waits ───────────────────────────
	s.section("done() cannot print its summary before a slow async body finishes");
	{
		const ran = runChildSuite(dir, "slow-body", `
const s = suite("child");
s.test("slow body", async () => {
	await sleep(200);
	console.log("SLOW BODY FINISHED");
});
await s.done();
`);
		const bodyAt = ran.stdout.indexOf("SLOW BODY FINISHED");
		const summaryAt = ran.stdout.indexOf("Results:");
		s.check(bodyAt >= 0, "the slow body ran at all");
		s.check(
			bodyAt >= 0 && summaryAt > bodyAt,
			`the summary is printed after the slow body finished (body at ${bodyAt}, summary at ${summaryAt})`,
		);
		s.check(/Results: 1 passed, 0 failed/.test(ran.stdout), "the slow body is counted as a pass");
		s.check(ran.status === 0, `an all-passing suite exits 0 (got ${String(ran.status)})`);
	}

	// ── Failure modes that must not read as success ──────────────────────────
	s.section("a synchronous throw and a non-Error throw are both counted");
	{
		const ran = runChildSuite(dir, "throws", `
const s = suite("child");
s.test("sync throw", () => { throw new Error("sync boom"); });
s.test("thrown string", () => { throw "not an error"; });
await s.done();
`);
		s.check(ran.status === 1, `two thrown bodies exit non-zero (got ${String(ran.status)})`);
		s.check(/Results: 0 passed, 2 failed/.test(ran.all), "both throws are counted as failures");
		s.check(/FAIL sync throw — sync boom/.test(ran.all), "a synchronous throw reports its message");
		s.check(/FAIL thrown string — not an error/.test(ran.all), "a non-Error throw is stringified, not dropped");
	}

	s.section("a suite that never calls done() fails instead of exiting 0");
	{
		const ran = runChildSuite(dir, "no-done", `
const s = suite("child");
s.check(true, "asserted something");
s.test("queued but never drained", () => {});
`);
		s.check(ran.status === 1, `a suite that forgets done() exits non-zero (got ${String(ran.status)})`);
		s.check(/SUITE DID NOT FINISH: child/.test(ran.all), "the unfinished suite names itself");
		s.check(/1 test\(s\) still queued/.test(ran.all), "the guard reports the undrained queue");
	}

	s.section("a failing check alone fails the suite");
	{
		const ran = runChildSuite(dir, "failing-check", `
const s = suite("child");
s.check(false, "this must fail");
await s.done();
`);
		s.check(ran.status === 1, `one failed check exits non-zero (got ${String(ran.status)})`);
		s.check(/Results: 0 passed, 1 failed/.test(ran.all), "the failed check is counted");
		s.check(ran.stderr.includes("FAIL this must fail"), "FAIL goes to stderr so it survives log filtering");
	}

	// ── Output integrity through a pipe ─────────────────────────────────────
	s.section("no output is lost to process.exit when stdout is a pipe");
	{
		const ran = runChildSuite(dir, "flush", `
const s = suite("child");
for (let i = 0; i < 4000; i++) s.check(true, "line " + i);
await s.done();
`);
		const passLines = ran.stdout.split("\n").filter((line) => line.startsWith("  PASS ")).length;
		s.check(passLines === 4000, `all 4000 PASS lines survived the exit (saw ${passLines})`);
		s.check(/Results: 4000 passed, 0 failed/.test(ran.stdout), "the summary survived the exit");
		s.check(ran.stdout.trimEnd().endsWith("─".repeat(55)), "the trailing rule was flushed, not truncated");
	}
});

// ── In-process API surface ──────────────────────────────────────────────────

s.section("check() returns its condition and counts truthfully");
{
	const before = s.counts.passed;
	s.check(s.check(true, "check(true) returns true") === true, "check returns the condition it was given");
	s.check(s.counts.passed === before + 2, "counts.passed advances one per check");
}

s.section("shared utilities");
{
	const start = Date.now();
	await sleep(20);
	s.check(Date.now() - start >= 18, "sleep waits at least the requested time");

	let flipped = false;
	setTimeout(() => { flipped = true; }, 15);
	await until(() => flipped, { timeoutMs: 500, message: "the flag to flip" });
	s.check(flipped, "until resolves once the predicate holds");

	let timedOut: string | null = null;
	try {
		await until(() => false, { timeoutMs: 20, intervalMs: 5, message: "something that never happens" });
	} catch (error) {
		timedOut = error instanceof Error ? error.message : String(error);
	}
	s.check(
		timedOut !== null && timedOut.includes("something that never happens"),
		"until rejects on timeout instead of hanging the suite",
	);

	let observed = "";
	const returned = await withTempDir("yaos-harness-self-tmp-", (dir) => {
		observed = dir;
		writeFileSync(join(dir, "probe.txt"), "x");
		return "body result";
	});
	s.check(returned === "body result", "withTempDir returns the body's value");
	s.check(!existsSync(observed), "withTempDir removes the directory afterwards");

	let leaked = "";
	try {
		await withTempDir("yaos-harness-self-throw-", (dir) => {
			leaked = dir;
			throw new Error("body failed");
		});
	} catch {
		// expected
	}
	s.check(!existsSync(leaked), "withTempDir cleans up even when the body throws");

	s.check(!repoRoot().endsWith("/"), "repoRoot has no trailing separator");
	s.check(existsSync(join(repoRoot(), "package.json")), "repoRoot points at the repository root");
	s.check(
		readSource("package.json").includes('"name": "yaos"'),
		"readSource reads a repo-root-relative file",
	);
}

/** The child's summary line, for a failure message that explains itself. */
function summaryOf(ran: Ran): string {
	return ran.all.split("\n").find((line) => line.includes("Results:")) ?? "(no summary line)";
}

await s.done();
