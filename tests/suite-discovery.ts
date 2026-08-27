// Guard for the test-discovery contract.
//
// The regression runner discovers suites by convention — every `*.ts` file in
// tests/client/, tests/server/ or tests/contracts/ — instead of reading a
// hand-maintained array. Live-worker discovery belongs to tests/live/run-live.ts.
// That only stays trustworthy if two invariants hold, and both are checked here:
//
//   1. ACCOUNTABILITY — every discovery candidate is either a real suite (one
//      that can actually fail) or named in tests/suites.json with a non-empty
//      reason. This is the invariant the old array was supposed to hold and
//      didn't: 17 of the 107 files on disk were unregistered, and two of them
//      (file-meta-decode.ts, file-meta-lazy-write.ts — 146 assertions against
//      src/sync/fileMeta.ts) had never executed a single time.
//
//   2. NO ROT — every path named in tests/suites.json still exists and is
//      still a discovery candidate. Without this, a deny-list entry outlives
//      the file it excused, and the next file to take that name inherits the
//      exemption silently.
//
// The runner's own discovery functions are imported rather than reimplemented,
// so this suite cannot pass against a copy that has drifted from production.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { discoverCandidates, discoverSuites, loadRegistry } from "./run-suites.mjs";
import { suite } from "./harness.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const s = suite("suite-discovery");

const registry = loadRegistry();
const candidates = discoverCandidates();
const suites = discoverSuites(registry);
const suiteSet = new Set(suites);
const candidateSet = new Set(candidates);

s.section("Test 1: discovery finds a plausible number of suites");
// A floor, not an exact count: new suites land constantly and this guard must
// not become the next thing developers have to remember to update. The point
// is to catch a discovery function that has broken outright and returns [] or
// a handful, which would turn the whole regression gate green-and-empty.
s.check(candidates.length > 50, `tests/ has ${candidates.length} discovery candidates (> 50)`);
s.check(suites.length > 50, `discovery selected ${suites.length} suites (> 50)`);
s.check(
	suiteSet.has("tests/suite-discovery.ts"),
	"this suite is itself discovered (discovery is not filtering out .ts files)",
);

s.section("Test 2: every candidate is accounted for");
// Under convention discovery, "unlisted" is not the same as "invisible" — an
// unlisted file gets RUN. So the accountability question is not "is it in a
// list" (that would be vacuously true); it is "is it actually a suite".
//
// A suite is a file that can fail: it asserts, it throws, or it propagates a
// non-zero exit status from something it delegates to. A file in tests/ with
// no failure path is either a helper that should be named in suites.json, or a
// suite that asserts nothing and reports green forever — both are the same
// coverage hole the hand-maintained array used to produce, just louder.
//
// All idioms in this repo are covered: the shared harness (`s.check(…)`,
// `s.test(…)` from tests/harness.ts), raw `node:assert` calls, and `throw new
// Error`. `process.exit(0)` and bare `process.exit()` deliberately do NOT count
// — they cannot express failure.
// A file that only calls `s.done()` does not count either: draining an empty
// queue is exactly the green-and-empty suite this guard exists to catch.
const CAN_FAIL = /\bs\.(?:check|test)\s*\(|\bassert\b[\w.]*\s*\(|\bthrow\s+new\s+\w*Error\b|process\.exit\(\s*(?!0\s*\)|\))/;

const inertSuites = suites.filter((path) => !CAN_FAIL.test(readFileSync(ROOT + path, "utf8")));
s.check(
	inertSuites.length === 0,
	inertSuites.length === 0
		? `all ${suites.length} discovered suites have a failure path (assert / throw / non-zero exit)`
		: `discovered file(s) with no way to fail: ${inertSuites.join(", ")} — give each real assertions, or name it in tests/suites.json with a reason`,
);

s.section("Test 3: no file is both a suite and excused");
const doubleClaimed = Object.keys(registry.notSuites).filter((path) => path in registry.skip);
s.check(
	doubleClaimed.length === 0,
	doubleClaimed.length === 0
		? "notSuites and skip are disjoint"
		: `listed in both notSuites and skip: ${doubleClaimed.join(", ")}`,
);

s.section("Test 4: every excuse carries a non-empty reason");
for (const field of ["notSuites", "skip"] as const) {
	const entries = Object.entries(registry[field] as Record<string, unknown>);
	for (const [path, reason] of entries) {
		s.check(
			typeof reason === "string" && reason.trim().length > 0,
			`${field}["${path}"] has a non-empty reason`,
		);
	}
}
s.check(
	typeof registry.serialReason === "string" && registry.serialReason.trim().length > 0,
	"serialReason explains why the serial list exists",
);

s.section("Test 5: no registry entry has rotted");
// Every path the registry names must still be a discovery candidate. This
// covers deletion, renaming, and moving a file out of tests/ — all of which
// would otherwise leave a dangling exemption behind.
const registryPaths = [
	...Object.keys(registry.notSuites).map((path) => ["notSuites", path] as const),
	...Object.keys(registry.skip).map((path) => ["skip", path] as const),
	...(registry.serial as string[]).map((path) => ["serial", path] as const),
];
for (const [field, path] of registryPaths) {
	s.check(
		candidateSet.has(path),
		`${field}: "${path}" still exists in tests/ as a *.ts file`,
	);
}

s.section("Test 6: serial suites are real, runnable suites or excused");
// A serial entry naming a file that nothing ever runs is a stale constraint.
for (const path of registry.serial as string[]) {
	s.check(
		suiteSet.has(path) || path in registry.skip,
		`serial: "${path}" is either discovered as a suite or skipped with a reason`,
	);
}
await s.done();
