#!/usr/bin/env node
// Regression test runner. Executes each test suite in sequence, reports
// pass/fail per suite, and exits non-zero if any suite fails.
//
// IMPORTANT: Always run regressions via `npm run test:regressions` (or this
// script directly). Do NOT run individual suites with bare
// `node --import jiti/register tests/foo.ts` — the JITI_ALIAS env injected
// below (yjs deduplication, obsidian mock, partyserver mock) will be absent
// and you may see the "Yjs was already imported" warning or import failures.
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
import { fileURLToPath } from "node:url";

// Force all "yjs" imports to resolve to the single root copy, preventing the
// "Yjs was already imported" constructor-check warning that fires when
// server/node_modules/yjs and node_modules/yjs are both loaded in the same
// process (triggered by tests that import from server/src/).
const ROOT_YJS = fileURLToPath(new URL("../node_modules/yjs/dist/yjs.mjs", import.meta.url));

// Redirect "obsidian" to a minimal runtime mock. The real obsidian package
// ships only TypeScript declarations (no JS), so any test that imports code
// depending on obsidian needs this alias to resolve at runtime.
const OBSIDIAN_MOCK = fileURLToPath(new URL("./mocks/obsidian.ts", import.meta.url));

// Redirect "partyserver" to a minimal runtime mock. The real partyserver
// imports from "cloudflare:workers" which is unavailable in Node.js.
// The mock's getServerByName() intentionally throws — any pre-auth code
// that calls it causes the test to fail loudly (FU-4 invariant).
const PARTYSERVER_MOCK = fileURLToPath(new URL("./mocks/partyserver.ts", import.meta.url));

const JITI_ENV = {
	...process.env,
	JITI_ALIAS: JSON.stringify({ yjs: ROOT_YJS, obsidian: OBSIDIAN_MOCK, partyserver: PARTYSERVER_MOCK }),
};

const JITI = "node --import jiti/register";
const NODE = "node";

const suites = [
	[JITI, "tests/diff-regressions.mjs"],
	[JITI, "tests/external-edit-policy-regressions.mjs"],
	[JITI, "tests/bound-recovery-regressions.mjs"],
	[JITI, "tests/editor-binding-health-regressions.mjs"],
	[JITI, "tests/frontmatter-guard-regressions.mjs"],
	[JITI, "tests/frontmatter-quarantine-regressions.mjs"],
	[JITI, "tests/frontmatter-guard-orchestration.ts"],
	[NODE, "tests/disk-mirror-regressions.mjs"],
	[JITI, "tests/disk-mirror-origin-classification.ts"],
	[NODE, "tests/server-pre-auth-trace.mjs"],
	[JITI, "tests/diagnostics-redaction.mjs"],
	[JITI, "tests/persistent-trace-logger.ts"],
	[JITI, "tests/typed-trace-schema.ts"],
	[JITI, "tests/trace-event-behavior.ts"],
	[JITI, "tests/reconciliation-safety-brake.ts"],
	[JITI, "tests/no-event-reconcile-admission.ts"],
	[JITI, "tests/controller-recovery-orchestration.ts"],
	[JITI, "tests/blob-download-conflicts.ts"],
	[JITI, "tests/markdown-remote-delete-trash-preference.ts"],
	[JITI, "tests/closed-file-conflict.ts"],
	[JITI, "tests/preserved-unresolved-registry.ts"],
	[NODE, "tests/markdown-ingest-regressions.mjs"],
	[JITI, "tests/closed-file-mirror.ts"],
	[JITI, "tests/folder-rename.ts"],
	[JITI, "tests/chunked-doc-store.ts"],
	[JITI, "tests/trace-store.ts"],
	[JITI, "tests/server-hardening.ts"],
	[JITI, "tests/settings-hardening.ts"],
	[JITI, "tests/snapshot-lookup.ts"],
	[JITI, "tests/v2-offline-rename-regressions.mjs"],
	[JITI, "tests/sync-facts.ts"],
	[JITI, "tests/offline-handoff.ts"],
	[JITI, "tests/status-label.ts"],
	[JITI, "tests/recovery-amplifier.ts"],
	[JITI, "tests/disk-mirror-observer.ts"],
	[JITI, "tests/server-pre-auth-runtime.ts"],
	[JITI, "tests/server-sync-message-classifier.ts"],
	[JITI, "tests/server-sv-echo.ts"],
	[JITI, "tests/server-post-apply-wiring.ts"],
	[JITI, "tests/diagnostics-bundle.ts"],
	[JITI, "tests/ack-origins.ts"],
	[JITI, "tests/state-vector-ack.ts"],
	[JITI, "tests/sv-echo-message.ts"],
	[JITI, "tests/sv-echo-client-receiver.ts"],
	[JITI, "tests/server-ack-tracker.ts"],
	[JITI, "tests/indexed-db-candidate-store.ts"],
	[JITI, "tests/tombstone-revive.ts"],
	[JITI, "tests/flight-recorder.ts"],
	[JITI, "tests/flight-trace-privacy.ts"],
	[JITI, "tests/flight-lifecycle-local-disk-to-server-receipt.ts"],
	[JITI, "tests/server-persistence-pathology.ts"],
	[JITI, "tests/device-witness-tracker.ts"],
	[JITI, "tests/device-witness-tracker-lifecycle.ts"],
	[JITI, "tests/device-witness-qa-api.ts"],
	// Phase 2 verification gates
	[JITI, "tests/witness-schema.ts"],
	[JITI, "tests/witness-hash-normalization.ts"],
	[JITI, "tests/witness-checkpoint-isolation.ts"],
	[JITI, "tests/witness-checkpoint-rotation.ts"],
	[JITI, "tests/witness-readonly-spy.ts"],
	[JITI, "tests/witness-mobile-background.ts"],
	[JITI, "tests/witness-s11b-semantics.ts"],
	// Phase 3 verification gates
	[JITI, "tests/witness-bundle-export.ts"],
	[JITI, "tests/witness-identity-command.ts"],
	[JITI, "tests/witness-persistence-isolation.ts"],
	[JITI, "tests/witness-scenario-step.ts"],
	// Snapshot safety tests (Phase 0 tourniquet)
	[JITI, "tests/snapshot-retention.ts"],
	[JITI, "tests/snapshots.ts"],
	[JITI, "tests/snapshot-compat.ts"],
	[NODE, "tests/snapshot-r2-runner.mjs"],
];

let totalPassed = 0;
let totalFailed = 0;

// -----------------------------------------------------------------------
// CLI argument parsing — fail fast on unknown args, support --only filter.
// -----------------------------------------------------------------------

function printUsage() {
	console.log("Usage: node tests/run-regressions.mjs [--only <substring>]... [--list] [--help]");
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
	: suites.filter(([, path]) => onlyFilters.some((needle) => path.includes(needle)));

if (onlyFilters.length > 0 && selectedSuites.length === 0) {
	console.error(`Error: no suite path matched --only filter(s): ${onlyFilters.map((f) => `"${f}"`).join(", ")}`);
	console.error(`Hint: run with --list to see every known suite path.`);
	process.exit(2);
}

if (listOnly) {
	for (const [, path] of selectedSuites) {
		console.log(path);
	}
	process.exit(0);
}

if (onlyFilters.length > 0) {
	console.log(`Running ${selectedSuites.length} of ${suites.length} suite(s) matching --only filter(s): ${onlyFilters.map((f) => `"${f}"`).join(", ")}`);
}

for (const [runner, suitePath] of selectedSuites) {
	const [cmd, ...cmdArgs] = runner.split(" ");
	const result = spawnSync(cmd, [...cmdArgs, suitePath], {
		stdio: "inherit",
		env: JITI_ENV,
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
