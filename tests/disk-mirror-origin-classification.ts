// Regression test for INV-SAFETY-02 / Phase 1.1 finding (+ FU-3 raw-origin guard).
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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	isLocalOrigin,
	isLocalStringOrigin,
	LOCAL_REPAIR_ORIGINS,
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
	ORIGIN_EDITOR_HEALTH_HEAL,
	ORIGIN_SEED,
	ORIGIN_RESTORE,
} from "../src/sync/origins";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

const REQUIRED_LOCAL_ORIGINS = [
	ORIGIN_SEED,
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
	ORIGIN_EDITOR_HEALTH_HEAL,
	ORIGIN_RESTORE,
] as const;

console.log("\n--- Test 1: LOCAL_REPAIR_ORIGINS contains every required repair origin ---");
for (const origin of REQUIRED_LOCAL_ORIGINS) {
	assert(
		isLocalStringOrigin(origin),
		`isLocalStringOrigin("${origin}") is true`,
	);
}
assert(LOCAL_REPAIR_ORIGINS.length >= REQUIRED_LOCAL_ORIGINS.length, "at least the required count of repair origins");

console.log("\n--- Test 2: exported origin constants have the expected string values ---");
assert(ORIGIN_DISK_SYNC === "disk-sync", "ORIGIN_DISK_SYNC === 'disk-sync'");
assert(ORIGIN_DISK_SYNC_RECOVER_BOUND === "disk-sync-recover-bound", "ORIGIN_DISK_SYNC_RECOVER_BOUND");
assert(ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER === "disk-sync-open-idle-recover", "ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER");
assert(ORIGIN_EDITOR_HEALTH_HEAL === "editor-health-heal", "ORIGIN_EDITOR_HEALTH_HEAL");
assert(ORIGIN_SEED === "vault-crdt-seed", "ORIGIN_SEED === 'vault-crdt-seed'");
assert(ORIGIN_RESTORE === "snapshot-restore", "ORIGIN_RESTORE === 'snapshot-restore'");

console.log("\n--- Test 3: behavioral dispatch — local repair origins do NOT schedule a disk write ---");
// The diskMirror text observer calls isLocalOrigin() as a gate. If it returns
// true, the observer returns early and no write is scheduled. This test
// exercises isLocalOrigin() directly from the authoritative module to prove
// the correct dispatch decision for every registered repair origin.
const provider = { __sentinel: "provider" };

for (const origin of REQUIRED_LOCAL_ORIGINS) {
	assert(
		isLocalOrigin(origin, provider) === true,
		`isLocalOrigin("${origin}") → local (no write scheduled)`,
	);
}

console.log("\n--- Test 4: behavioral dispatch — remote and unknown origins DO schedule a write ---");
assert(
	isLocalOrigin(provider, provider) === false,
	"provider-origin transaction is remote (write allowed)",
);
assert(
	isLocalOrigin("not-a-known-origin", provider) === false,
	"unknown string origins are NOT silently classified as local (write allowed)",
);
assert(
	isLocalOrigin(null, provider) === true,
	"null origin (transact() without explicit origin) is local",
);
assert(
	isLocalOrigin({ constructor: { name: "YSyncConfig" } }, provider) === true,
	"non-null object origins (e.g. y-codemirror's YSyncConfig) are local",
);

console.log("\n--- Test 5: call-site constants match registry (no raw string divergence) ---");
// Verify that the named export constants are the same values as what the
// internal set was built from. If someone changes a constant value without
// updating the set, this catches it.
const callSiteOrigins: ReadonlyArray<string> = [
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
	ORIGIN_EDITOR_HEALTH_HEAL,
	ORIGIN_SEED,
	ORIGIN_RESTORE,
];
for (const origin of callSiteOrigins) {
	assert(
		isLocalStringOrigin(origin),
		`constant "${origin}" is registered in LOCAL_REPAIR_ORIGINS`,
	);
}

console.log("\n--- Test 6: no raw string literals as applyDiffToYText origin in src/ (FU-3) ---");
// Every applyDiffToYText call site in production code must use a named constant
// from src/sync/origins.ts, never a raw string literal. A raw string would
// bypass the registration requirement and silently create an unregistered
// local-repair origin that the diskMirror observer might classify incorrectly.
//
// Pattern matched: applyDiffToYText(<any>, <any>, <any>, "some-string")
// Constants are identifiers, not string literals — this regex only fires on raw strings.
{
	function collectTsFiles(dir: string): string[] {
		const result: string[] = [];
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				if (entry === "node_modules") continue;
				result.push(...collectTsFiles(full));
			} else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
				result.push(full);
			}
		}
		return result;
	}

	// This regex catches direct string literals as the final argument before ')'.
	// It will NOT catch: const origin = "raw"; applyDiffToYText(..., origin)
	// or aliased function calls. It is a belt, not suspenders. Type-level
	// enforcement (YaosLocalOrigin union type on the origin parameter) would be
	// the suspenders — tracked separately.
	const RAW_ORIGIN_RE = /applyDiffToYText\s*\([^)]*?,\s*"([^"\\]+)"\s*\)/g;
	const srcDir = resolve(ROOT, "src");
	const violations: Array<{ file: string; origin: string }> = [];

	for (const file of collectTsFiles(srcDir)) {
		const source = readFileSync(file, "utf8");
		let m: RegExpExecArray | null;
		while ((m = RAW_ORIGIN_RE.exec(source)) !== null) {
			violations.push({ file: file.replace(ROOT + "/", ""), origin: m[1] });
		}
	}

	assert(
		violations.length === 0,
		`no raw string literals as applyDiffToYText origin in src/ (${violations.length === 0 ? "clean" : violations.map((v) => `"${v.origin}" in ${v.file}`).join(", ")})`,
	);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
