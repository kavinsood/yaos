import { buildGithubOpsBootstrapWorkflowYaml } from "../src/runtime/capabilityUpdateService";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function assertContains(yaml: string, needle: string, msg: string) {
	assert(yaml.includes(needle), `${msg} (expected to contain: ${needle})`);
}

console.log("\n--- Test 1: custom release repo is embedded in workflow yaml ---");
{
	const yaml = buildGithubOpsBootstrapWorkflowYaml("pixmuffin/yaos");
	assertContains(
		yaml,
		"uses: pixmuffin/yaos/.github/workflows/yaos-ops-reusable.yml@main",
		"uses line references custom fork",
	);
	assertContains(
		yaml,
		"default: pixmuffin/yaos",
		"release_repo default references custom fork",
	);
}

console.log("\n--- Test 2: no args defaults to upstream kavinsood/yaos ---");
{
	const yaml = buildGithubOpsBootstrapWorkflowYaml();
	assertContains(
		yaml,
		"uses: kavinsood/yaos/.github/workflows/yaos-ops-reusable.yml@main",
		"uses line defaults to upstream",
	);
	assertContains(
		yaml,
		"default: kavinsood/yaos",
		"release_repo default defaults to upstream",
	);
}

console.log("\n--- Test 3: GitHub URL inputs are normalized to owner/repo ---");
{
	const yaml = buildGithubOpsBootstrapWorkflowYaml("https://github.com/pixmuffin/yaos.git/");
	assertContains(
		yaml,
		"uses: pixmuffin/yaos/.github/workflows/yaos-ops-reusable.yml@main",
		"normalized URL is used in uses line",
	);
	assertContains(
		yaml,
		"default: pixmuffin/yaos",
		"normalized URL is used in release_repo default",
	);
}

console.log("\n--- Test 4: invalid repos fall back to upstream ---");
{
	for (const invalid of ["", "not-a-repo", "owner/", "/repo", "bad/repo/extra"]) {
		const yaml = buildGithubOpsBootstrapWorkflowYaml(invalid);
		assertContains(
			yaml,
			"uses: kavinsood/yaos/.github/workflows/yaos-ops-reusable.yml@main",
			`invalid "${invalid}" falls back in uses line`,
		);
		assertContains(
			yaml,
			"default: kavinsood/yaos",
			`invalid "${invalid}" falls back in release_repo default`,
		);
	}
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
