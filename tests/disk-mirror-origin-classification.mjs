// Regression test for INV-SAFETY-02 / Phase 1.1 finding.
//
// The diskMirror text observer treats any Yjs transaction whose origin is not
// classified as local as a remote update, scheduling a writeback. Local
// repair paths (disk-to-CRDT recovery, editor-bound heal) emit string origins
// and must be classified as local — otherwise the recovery transaction
// schedules a redundant disk write, with two real consequences:
//
//   1. Race window between recovery and flush: if disk content changes
//      between the recovery write and the deferred flush, the equality
//      short-circuit in flushWriteUnlocked fails and CRDT content (matching
//      the recovery-time disk state) overwrites the newer external edit.
//   2. Wasted work and misleading "remote change" trace lines for every
//      recovery transaction.
//
// Both safety nets (content-equality check at flush, fingerprint-based
// suppression on the modify event) mask the visible damage in the steady
// state, but the masking is incidental. The contract is that local repair
// origins are classified as local at the predicate level.
//
// This test guards against silent removal of any of the recovery origins
// from LOCAL_STRING_ORIGINS in src/sync/diskMirror.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const diskMirrorPath = resolve(here, "../src/sync/diskMirror.ts");
const reconciliationPath = resolve(here, "../src/runtime/reconciliationController.ts");
const editorBindingPath = resolve(here, "../src/sync/editorBinding.ts");

let passed = 0;
let failed = 0;

function assert(condition, name) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

// In-test reimplementation of isLocalOrigin. Must mirror the production
// predicate in src/sync/diskMirror.ts. If you change the production predicate
// shape (not just the set), update this harness in the same change.
function makeIsLocalOrigin(localStringOrigins) {
	return function isLocalOrigin(origin, provider) {
		if (origin === provider) return false;
		if (typeof origin === "string") return localStringOrigins.has(origin);
		if (origin == null) return true;
		return true;
	};
}

// Extract the LOCAL_STRING_ORIGINS set from the production source. We parse
// the literal rather than importing the module, because diskMirror.ts has
// runtime imports from "obsidian" that are not available in this harness.
function extractLocalStringOrigins(sourcePath) {
	const source = readFileSync(sourcePath, "utf8");
	const match = source.match(/LOCAL_STRING_ORIGINS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/);
	if (!match) return null;
	const body = match[1];
	const entries = new Set();
	const literalRe = /"([^"\\]+)"/g;
	let lit;
	while ((lit = literalRe.exec(body)) !== null) {
		entries.add(lit[1]);
	}
	const identRe = /\b(ORIGIN_[A-Z_]+)\b/g;
	let id;
	while ((id = identRe.exec(body)) !== null) {
		// Resolve a couple of well-known constants to their string values.
		// Keeping this list local avoids importing the type modules under
		// jiti just to read two strings.
		const wellKnown = {
			ORIGIN_SEED: "vault-crdt-seed",
			ORIGIN_RESTORE: "snapshot-restore",
		};
		const value = wellKnown[id[1]];
		if (value) entries.add(value);
	}
	return entries;
}

const productionOrigins = extractLocalStringOrigins(diskMirrorPath);

console.log("\n--- Test 1: diskMirror exposes a recognizable LOCAL_STRING_ORIGINS literal ---");
assert(productionOrigins !== null, "LOCAL_STRING_ORIGINS literal is parseable from src/sync/diskMirror.ts");
assert(productionOrigins.size >= 4, "set has at least four entries");

console.log("\n--- Test 2: every locally-emitted repair origin is classified as local ---");
const requiredLocalOrigins = [
	// disk -> CRDT during normal reconcile
	"disk-sync",
	// disk -> CRDT during bound-file local-only divergence recovery
	"disk-sync-recover-bound",
	// disk -> CRDT during open-idle external-edit recovery
	"disk-sync-open-idle-recover",
	// editor -> CRDT during binding heal
	"editor-health-heal",
	// snapshot restore
	"snapshot-restore",
	// initial seed of CRDT from disk
	"vault-crdt-seed",
];

for (const origin of requiredLocalOrigins) {
	assert(
		productionOrigins?.has(origin),
		`LOCAL_STRING_ORIGINS contains "${origin}"`,
	);
}

console.log("\n--- Test 3: predicate classifies recovery origins as local ---");
const provider = { __sentinel: "provider" };
const isLocalOrigin = makeIsLocalOrigin(productionOrigins ?? new Set());

for (const origin of requiredLocalOrigins) {
	assert(
		isLocalOrigin(origin, provider) === true,
		`isLocalOrigin("${origin}", provider) === true`,
	);
}

console.log("\n--- Test 4: predicate still classifies provider-origin as remote ---");
assert(
	isLocalOrigin(provider, provider) === false,
	"provider-origin transactions are remote",
);
assert(
	isLocalOrigin("not-a-known-origin", provider) === false,
	"unknown string origins are NOT silently classified as local",
);
assert(
	isLocalOrigin(null, provider) === true,
	"null origin (transact() without explicit origin) is local",
);
assert(
	isLocalOrigin({ constructor: { name: "YSyncConfig" } }, provider) === true,
	"non-null object origins (e.g. y-codemirror's YSyncConfig) are local",
);

console.log("\n--- Test 5: every applyDiffToYText call site uses a registered local origin ---");
// Statically scan recovery sites to ensure each origin string passed to
// applyDiffToYText is registered in LOCAL_STRING_ORIGINS. This catches the
// failure mode where a developer adds a new recovery origin string but
// forgets to register it.
function callSiteOriginsIn(sourcePath) {
	const source = readFileSync(sourcePath, "utf8");
	const re = /applyDiffToYText\s*\([^)]*?,\s*"([^"\\]+)"\s*\)/g;
	const found = new Set();
	let m;
	while ((m = re.exec(source)) !== null) {
		found.add(m[1]);
	}
	return found;
}

const reconcileOrigins = callSiteOriginsIn(reconciliationPath);
const editorOrigins = callSiteOriginsIn(editorBindingPath);

assert(reconcileOrigins.size > 0, "reconciliationController has at least one applyDiffToYText call site");
assert(editorOrigins.size > 0, "editorBinding has at least one applyDiffToYText call site");

for (const origin of reconcileOrigins) {
	assert(
		productionOrigins?.has(origin),
		`reconciliationController origin "${origin}" is registered in LOCAL_STRING_ORIGINS`,
	);
}
for (const origin of editorOrigins) {
	assert(
		productionOrigins?.has(origin),
		`editorBinding origin "${origin}" is registered in LOCAL_STRING_ORIGINS`,
	);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
