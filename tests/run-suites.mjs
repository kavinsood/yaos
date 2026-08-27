#!/usr/bin/env node
// Regression test runner. Discovers every suite in tests/ by convention,
// executes them in sequence, reports pass/fail per suite, and exits non-zero
// if any suite fails.
//
// DISCOVERY, NOT REGISTRATION. A regression suite is any `*.ts` file inside
// tests/client/, tests/server/ or tests/contracts/ that is not named in
// tests/suites.json. Live-worker suites are owned separately by
// tests/live/run-live.ts because they require a running Worker.
// There is no list to append to: this runner replaced one that had silently
// orphaned two real unit suites (458 + 364 LOC, 146 assertions).
//
// The only hand-maintained data is tests/suites.json, and every entry in it
// carries a reason string. tests/suite-discovery.ts enforces both halves of
// that contract: no file may be silently unaccounted for, and no entry may
// name a path that has since been deleted or renamed.
//
// ONE REGRESSION RUNNER. Every regression suite runs through the programmatic
// Jiti bootstrap in tests/run-typescript.mjs. This preserves Node 20 support,
// source maps, and test-only aliases without the deprecated global loader.
// ONE DIALECT FOR ALL. Suites are TypeScript, full stop. tests/run-suites.mjs
// is the plain-JS discovery/process bootstrap.
//
// ONE HARNESS FOR ALL. A suite reports through tests/harness.ts:
//
//   import { suite } from "../harness.ts";
//   const s = suite("my-suite");
//   s.section("Test 1: …");
//   s.check(cond, "message");                // boolean form, counted
//   s.test("name", async () => { … });       // throw form, awaited by done()
//   await s.done();                          // prints the summary, exits 0/1
//
// Do not hand-roll counters, a local assert(), a summary block or a
// process.exit: `done()` is what makes an unawaited async test body impossible,
// and a suite that never calls it fails loudly instead of exiting 0 empty.
//
// IMPORTANT: Always run regressions via `npm run test:regressions` (or this
// script directly). The child bootstrap owns yjs/y-protocols deduplication and
// the obsidian, partyserver and @shared aliases.
//
// CLI flags:
//   --only <substring>   Run only suites whose path contains <substring>.
//                        Repeatable. May also be passed as --only=<substring>.
//                        With no --only flags, all suites run.
//                        If no suite matches, the runner exits non-zero.
//   --list               Print every suite path the runner knows about (one
//                        per line) and exit 0 without running anything.
//                        Honors --only filters when listing.
//   --help, -h           Print this usage block and exit 0.
//
// Unknown flags or positional args cause the runner to exit non-zero with
// a clear message, so a typo like `--ony` will not silently run the full
// suite.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const REGISTRY_PATH = fileURLToPath(new URL("./suites.json", import.meta.url));

const RUNNER = ["node", "tests/run-typescript.mjs", "--test-aliases"];

// -----------------------------------------------------------------------
// Discovery. Exported so tests/suite-discovery.ts guards the real code path
// rather than a copy of it that could drift.
// -----------------------------------------------------------------------

// The three regression buckets. Live-worker suites have their own accountable
// driver in tests/live/run-live.ts. Everything else under tests/ is
// infrastructure — this runner, suites.json, harness.ts, mocks/, fixtures/ and
// manual/ — and is not a discovery candidate, so it needs no registry excuse.
const BUCKETS = ["client", "server", "contracts"];

// The suites that cannot live in a bucket: they guard this runner's own
// discovery functions and the shared assertion harness every bucket suite
// depends on. Each sits beside the file it verifies and is discovered
// explicitly rather than by directory walk.
const ROOT_SUITES = [
	"tests/harness-self.ts",
	"tests/runner-runtime-self.ts",
	"tests/suite-discovery.ts",
];

/** Every discovery candidate in tests/, repo-root-relative and sorted. */
export function discoverCandidates() {
	const bucketed = BUCKETS.flatMap((bucket) =>
		readdirSync(join(TESTS_DIR, bucket))
			.filter((name) => name.endsWith(".ts"))
			.map((name) => `tests/${bucket}/${name}`),
	);
	return [...ROOT_SUITES, ...bucketed].sort();
}

/** tests/suites.json, shape-checked so a malformed edit fails loudly. */
export function loadRegistry() {
	const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
	for (const field of ["notSuites", "skip"]) {
		if (registry[field] === null || typeof registry[field] !== "object" || Array.isArray(registry[field])) {
			throw new Error(`tests/suites.json: "${field}" must be an object of {path: reason}`);
		}
	}
	if (!Array.isArray(registry.serial)) {
		throw new Error(`tests/suites.json: "serial" must be an array of paths`);
	}
	return registry;
}

/** Candidates minus non-suites minus deliberate skips. */
export function discoverSuites(registry = loadRegistry()) {
	return discoverCandidates().filter(
		(path) => !(path in registry.notSuites) && !(path in registry.skip),
	);
}

// Only act as a CLI when invoked directly, so the guard suite can import the
// functions above without spawning 90 child processes.
const invokedDirectly = process.argv[1]
	&& resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

function main() {
	const registry = loadRegistry();
	const suites = discoverSuites(registry);

	let totalPassed = 0;
	let totalFailed = 0;

	// -----------------------------------------------------------------------
	// CLI argument parsing — fail fast on unknown args, support --only filter.
	// -----------------------------------------------------------------------

	function printUsage() {
		console.log("Usage: node tests/run-suites.mjs [--only <substring>]... [--list] [--help]");
		console.log("");
		console.log("  --only <substring>   Run only suites whose path contains <substring>.");
		console.log("                       Repeatable. May also be passed as --only=<substring>.");
		console.log("  --list               Print every suite path (filtered by --only if given)");
		console.log("                       and exit without running anything.");
		console.log("  --help, -h           Print this usage block and exit.");
	}

	const argv = process.argv.slice(2);
	const onlyFilters = [];
	let listOnly = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--list") {
			listOnly = true;
			continue;
		}
		if (arg === "--only") {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) {
				console.error(`Error: --only requires a value (e.g. --only frontmatter-guard)`);
				process.exit(2);
			}
			onlyFilters.push(next);
			i += 1;
			continue;
		}
		if (arg.startsWith("--only=")) {
			const value = arg.slice("--only=".length);
			if (value.length === 0) {
				console.error(`Error: --only requires a non-empty value`);
				process.exit(2);
			}
			onlyFilters.push(value);
			continue;
		}
		console.error(`Error: unknown argument "${arg}"`);
		console.error("");
		printUsage();
		process.exit(2);
	}

	const selectedSuites = onlyFilters.length === 0
		? suites
		: suites.filter((path) => onlyFilters.some((needle) => path.includes(needle)));

	if (onlyFilters.length > 0 && selectedSuites.length === 0) {
		console.error(`Error: no suite path matched --only filter(s): ${onlyFilters.map((f) => `"${f}"`).join(", ")}`);
		console.error(`Hint: run with --list to see every known suite path.`);
		process.exit(2);
	}

	if (listOnly) {
		for (const path of selectedSuites) {
			console.log(path);
		}
		process.exit(0);
	}

	if (onlyFilters.length > 0) {
		console.log(`Running ${selectedSuites.length} of ${suites.length} suite(s) matching --only filter(s): ${onlyFilters.map((f) => `"${f}"`).join(", ")}`);
	} else {
		const skipped = Object.keys(registry.skip).length;
		const notSuites = Object.keys(registry.notSuites).length;
		console.log(`Discovered ${suites.length} suite(s) in tests/ (${skipped} skipped, ${notSuites} non-suite file(s); see tests/suites.json).`);
	}

	for (const suitePath of selectedSuites) {
		const [cmd, ...cmdArgs] = RUNNER;
		const result = spawnSync(cmd, [...cmdArgs, suitePath], {
			cwd: ROOT,
			stdio: "inherit",
			env: process.env,
		});

		if (result.status === 0) {
			totalPassed++;
		} else {
			totalFailed++;
			console.error(`\nSUITE FAILED: ${suitePath}\n`);
		}
	}

	console.log(`\n${"═".repeat(55)}`);
	console.log(`Regression suites: ${totalPassed} passed, ${totalFailed} failed`);
	console.log(`${"═".repeat(55)}\n`);

	process.exit(totalFailed > 0 ? 1 : 0);
}
