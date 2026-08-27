import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, suite } from "./harness.ts";

const s = suite("runner-runtime-self");
const root = repoRoot();
const runner = join(root, "tests", "run-typescript.mjs");

function run(fixture: string) {
	return spawnSync(
		process.execPath,
		[runner, "--test-aliases", `tests/fixtures/${fixture}`],
		{
			cwd: root,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		},
	);
}

s.section("Programmatic loader keeps one Yjs runtime");
{
	const result = run("runner-yjs-probe.ts");
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	s.check(result.status === 0, `Yjs probe exits successfully (got ${String(result.status)})`);
	s.check(!output.includes("Yjs was already imported"), "root yjs and y-protocols aliases prevent duplicate runtimes");
	s.check(!output.includes("DEP0205"), "programmatic Jiti does not use deprecated module.register");
}

s.section("Programmatic loader preserves TypeScript source maps");
{
	const fixture = join(root, "tests", "fixtures", "runner-stack-trace.ts");
	const expectedLine = readFileSync(fixture, "utf8")
		.split("\n")
		.findIndex((line) => line.includes("STACK_TRACE_EXPECTED_LINE")) + 1;
	const result = run("runner-stack-trace.ts");
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	s.check(result.status !== 0, "intentional TypeScript failure exits non-zero");
	s.check(output.includes("RUNNER_STACK_TRACE_PROBE"), "stack trace retains the original error");
	s.check(
		output.includes(`runner-stack-trace.ts:${expectedLine}:`),
		`stack trace points to the original TypeScript line ${expectedLine}`,
	);
	s.check(!output.includes("/jiti/runner-stack-trace"), "stack trace does not expose Jiti cache output");
}

await s.done();
