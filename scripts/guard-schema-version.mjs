#!/usr/bin/env node
/**
 * guard-schema-version.mjs
 *
 * Prevents the SCHEMA_VERSION regression where the P1 refactor reverted
 * the schema v3 implementation: src/sync/schema.ts was deleted, and
 * vaultSync.ts re-inlined SCHEMA_VERSION = 2 directly.
 *
 * Checks:
 *   1. src/sync/schema.ts exists (not deleted by a future refactor)
 *   2. src/sync/vaultSync.ts imports SCHEMA_VERSION from "./schema"
 *      (not re-inlined as a literal)
 *   3. No "export const SCHEMA_VERSION = " literal in vaultSync.ts
 *   4. SCHEMA_VERSION in schema.ts is the expected value
 *   5. server/src/version.ts SERVER_MAX_SCHEMA_VERSION matches plugin
 *   6. server/src/version.ts SERVER_MIN_SCHEMA_VERSION is <= plugin schema
 *   7. server/src/version.ts SERVER_MIN_SCHEMA_VERSION <= SERVER_MAX_SCHEMA_VERSION
 */

import { readFileSync, existsSync } from "node:fs";

const EXPECTED_SCHEMA_VERSION = 3;
let failures = 0;

function fail(msg) {
	console.error("FAIL:", msg);
	failures++;
}

function pass(msg) {
	console.log("PASS:", msg);
}

// 1. schema.ts must exist
if (!existsSync("src/sync/schema.ts")) {
	fail("src/sync/schema.ts is missing — SCHEMA_VERSION constant was deleted. Restore from git.");
} else {
	pass("src/sync/schema.ts exists");

	// 4. SCHEMA_VERSION value must be correct
	const schemaContent = readFileSync("src/sync/schema.ts", "utf8");
	const match = schemaContent.match(/export const SCHEMA_VERSION\s*=\s*(\d+)/);
	if (!match) {
		fail("src/sync/schema.ts does not export SCHEMA_VERSION");
	} else {
		const actual = Number(match[1]);
		if (actual !== EXPECTED_SCHEMA_VERSION) {
			fail(`src/sync/schema.ts has SCHEMA_VERSION = ${actual}, expected ${EXPECTED_SCHEMA_VERSION}`);
		} else {
			pass(`src/sync/schema.ts: SCHEMA_VERSION = ${actual}`);
		}
	}
}

// 2 & 3. vaultSync.ts must import from "./schema", not inline the constant
if (!existsSync("src/sync/vaultSync.ts")) {
	fail("src/sync/vaultSync.ts is missing");
} else {
	const vaultContent = readFileSync("src/sync/vaultSync.ts", "utf8");

	// Must have the import from schema
	if (!vaultContent.includes('from "./schema"') && !vaultContent.includes("from './schema'")) {
		fail('src/sync/vaultSync.ts does not import from "./schema" — SCHEMA_VERSION may be inlined');
	} else {
		pass('src/sync/vaultSync.ts imports from "./schema"');
	}

	// Must NOT have an inline literal
	if (/export const SCHEMA_VERSION\s*=\s*\d/.test(vaultContent)) {
		fail("src/sync/vaultSync.ts contains an inlined 'export const SCHEMA_VERSION = N' — remove it and import from ./schema instead");
	} else {
		pass("src/sync/vaultSync.ts has no inlined SCHEMA_VERSION literal");
	}
}

// 5-7. Server schema version range must include plugin schema
if (!existsSync("server/src/version.ts")) {
	console.warn("WARN: server/src/version.ts not found — skipping server schema check");
} else {
	const serverContent = readFileSync("server/src/version.ts", "utf8");
	const minMatch = serverContent.match(/SERVER_MIN_SCHEMA_VERSION\s*=\s*(\d+)/);
	const maxMatch = serverContent.match(/SERVER_MAX_SCHEMA_VERSION\s*=\s*(\d+)/);

	if (!minMatch || !maxMatch) {
		fail("server/src/version.ts is missing SERVER_MIN_SCHEMA_VERSION or SERVER_MAX_SCHEMA_VERSION");
	} else {
		const min = Number(minMatch[1]);
		const max = Number(maxMatch[1]);
		if (min > EXPECTED_SCHEMA_VERSION) {
			fail(`server/src/version.ts SERVER_MIN_SCHEMA_VERSION = ${min}, expected <= ${EXPECTED_SCHEMA_VERSION}`);
		} else {
			pass(`server/src/version.ts: SERVER_MIN_SCHEMA_VERSION = ${min}`);
		}
		if (max !== EXPECTED_SCHEMA_VERSION) {
			fail(`server/src/version.ts SERVER_MAX_SCHEMA_VERSION = ${max}, expected ${EXPECTED_SCHEMA_VERSION}`);
		} else {
			pass(`server/src/version.ts: SERVER_MAX_SCHEMA_VERSION = ${max}`);
		}
		if (min > max) {
			fail(`server/src/version.ts has invalid schema range: min ${min} > max ${max}`);
		} else {
			pass(`server supports schema range v${min}..v${max}`);
		}
		if (min <= EXPECTED_SCHEMA_VERSION && max === EXPECTED_SCHEMA_VERSION) {
			pass(`server and plugin schema versions agree on max: v${EXPECTED_SCHEMA_VERSION}`);
		}
	}
}

if (failures > 0) {
	console.error(`\nFAIL: ${failures} schema-version guard violation(s).`);
	console.error("  SCHEMA_VERSION must be in src/sync/schema.ts, imported into vaultSync.ts,");
	console.error("  and server/src/version.ts schema range must include the plugin schema.");
	process.exit(1);
} else {
	console.log("\nPASS: schema version guard — all checks passed.");
}
