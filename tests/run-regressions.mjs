#!/usr/bin/env node
// Regression test runner. Executes each test suite in sequence, reports
// pass/fail per suite, and exits non-zero if any suite fails.
//
// IMPORTANT: Always run regressions via `npm run test:regressions` (or this
// script directly). Do NOT run individual suites with bare
// `node --import jiti/register tests/foo.ts` — the JITI_ALIAS env injected
// below (yjs deduplication, obsidian mock, partyserver mock) will be absent
// and you may see the "Yjs was already imported" warning or import failures.

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
	[NODE, "tests/disk-mirror-regressions.mjs"],
	[JITI, "tests/disk-mirror-origin-classification.ts"],
	[NODE, "tests/server-pre-auth-trace.mjs"],
	[JITI, "tests/diagnostics-redaction.mjs"],
	[JITI, "tests/persistent-trace-logger.ts"],
	[JITI, "tests/typed-trace-schema.ts"],
	[JITI, "tests/trace-event-behavior.ts"],
	[JITI, "tests/reconciliation-safety-brake.ts"],
	[JITI, "tests/blob-download-conflicts.ts"],
	[JITI, "tests/closed-file-conflict.ts"],
	[JITI, "tests/preserved-unresolved-registry.ts"],
	[NODE, "tests/markdown-ingest-regressions.mjs"],
	[JITI, "tests/closed-file-mirror.ts"],
	[JITI, "tests/folder-rename.ts"],
	[JITI, "tests/chunked-doc-store.ts"],
	[JITI, "tests/trace-store.ts"],
	[JITI, "tests/server-hardening.ts"],
	[JITI, "tests/settings-hardening.ts"],
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
];

let totalPassed = 0;
let totalFailed = 0;

for (const [runner, suitePath] of suites) {
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
