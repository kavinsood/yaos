#!/usr/bin/env node
/**
 * Regression coverage for scripts/guard-schema-version.mjs.
 *
 * Schema 9 is pinned in the plugin's sync schema and the server's shared
 * product-version source. The public server version module must derive its
 * schema export from that canonical server pin rather than duplicate a number.
 *
 * These fixtures prove that the real guard fails closed when the canonical
 * server source is missing or mismatched, while accepting the exact schema-4
 * schema contract and its durable SQLite constraint.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRoot, suite, withTempDir } from "../harness.ts";

const s = suite("schema-version-guard");

const guardPath = resolve(repoRoot(), "scripts/guard-schema-version.mjs");

function makePluginFixture(dir: string) {
	mkdirSync(join(dir, "src/sync"), { recursive: true });
	writeFileSync(join(dir, "src/sync/schema.ts"),
		"export const SCHEMA_VERSION = 10;\n" +
			"export const STORAGE_FORMAT_VERSION = 6;\n" +
			"export const PROTOCOL_VERSION = 8;\n" +
		"export const SNAPSHOT_FORMAT_VERSION = 4;\n");
}

function writeServerVersionModule(dir: string) {
	mkdirSync(join(dir, "server/src"), { recursive: true });
	writeFileSync(
		join(dir, "server/src/version.ts"),
		'import { SCHEMA_VERSION } from "./shared/productVersions";\n' +
			"export const SERVER_SCHEMA_VERSION = SCHEMA_VERSION;\n",
	);
}

function makeServerFixture(dir: string, schemaVersion: number, protocolVersion = 8) {
	mkdirSync(join(dir, "server/src/shared"), { recursive: true });
	writeFileSync(
		join(dir, "server/src/shared/productVersions.ts"),
		`export const SCHEMA_VERSION = ${schemaVersion};\n` +
			"export const STORAGE_FORMAT_VERSION = 6;\n" +
			`export const PROTOCOL_VERSION = ${protocolVersion};\n` +
			"export const SNAPSHOT_FORMAT_VERSION = 4;\n",
	);
	writeFileSync(
		join(dir, "server/src/vaultDocumentStore.ts"),
		'import { SCHEMA_VERSION } from "./shared/productVersions";\n' +
			'const sql = `schema_version INTEGER NOT NULL CHECK(schema_version = ${SCHEMA_VERSION})`;\n',
	);
	writeServerVersionModule(dir);
}

function runGuard(cwd: string) {
	return spawnSync(process.execPath, [guardPath], { cwd, encoding: "utf8" });
}

s.section("Test 1: missing canonical server schema source fails closed");
await withTempDir("yaos-schema-version-guard-", (fixtureDir) => {
	makePluginFixture(fixtureDir);
	writeServerVersionModule(fixtureDir);
	const result = runGuard(fixtureDir);

	s.check(
		result.status === 1,
		"guard exits non-zero when server/src/shared/productVersions.ts is absent",
	);
	s.check(
		result.stderr.includes("FAIL: server/src/shared/productVersions.ts is missing"),
		"guard reports the missing canonical server schema source",
	);
	s.check(
		result.stderr.includes("FAIL: 1 schema-version guard violation(s)."),
		"guard emits its aggregate failure summary",
	);
	s.check(
		!result.stdout.includes("PASS: schema version guard — all checks passed."),
		"guard never reports a missing server source as a successful validation",
	);
});

s.section("Test 2: a mismatched canonical server pin fails closed");
await withTempDir("yaos-schema-version-guard-", (fixtureDir) => {
	makePluginFixture(fixtureDir);
	makeServerFixture(fixtureDir, 5);

	const result = runGuard(fixtureDir);

	s.check(result.status === 1, "guard exits non-zero when the server pins a different schema version");
	s.check(
		result.stderr.includes("must pin the plugin's schema version exactly"),
		"guard reports the mismatched canonical pin as a violation",
	);
	s.check(
		result.stderr.includes("FAIL: 1 schema-version guard violation(s)."),
		"guard aggregates a mismatched pin into its failure summary",
	);
});

s.section("Test 3: exact schema-10 pins pass");
await withTempDir("yaos-schema-version-guard-", (fixtureDir) => {
	makePluginFixture(fixtureDir);
	makeServerFixture(fixtureDir, 10);

	const result = runGuard(fixtureDir);

	s.check(result.status === 0, "guard accepts matching schema-10 source pins");
	s.check(
		result.stdout.includes("PASS: schema version guard — all checks passed."),
		"guard reports overall success for the exact schema-10 contract",
	);
});

s.section("Test 4: a stale durable SQL schema constraint fails closed");
await withTempDir("yaos-schema-version-guard-", (fixtureDir) => {
	makePluginFixture(fixtureDir);
	makeServerFixture(fixtureDir, 10);
	writeFileSync(
		join(fixtureDir, "server/src/vaultDocumentStore.ts"),
		'import { SCHEMA_VERSION } from "./shared/productVersions";\n' +
			"const sql = `schema_version INTEGER NOT NULL CHECK(schema_version = 7)`;\n",
	);
	const result = runGuard(fixtureDir);

	s.check(result.status === 1, "guard exits non-zero for a stale SQLite schema constraint");
	s.check(
		result.stderr.includes("must contain exactly one vault_meta schema_version CHECK derived from SCHEMA_VERSION"),
		"guard reports the stale durable constraint",
	);
});

s.section("Test 5: a non-schema product pin mismatch fails closed");
await withTempDir("yaos-schema-version-guard-", (fixtureDir) => {
	makePluginFixture(fixtureDir);
	makeServerFixture(fixtureDir, 9, 5);
	const result = runGuard(fixtureDir);

	s.check(result.status === 1, "guard exits non-zero when the server protocol pin drifts");
	s.check(
		result.stderr.includes("must pin the plugin's PROTOCOL_VERSION exactly"),
		"guard reports the protocol mismatch as a product-boundary violation",
	);
});
await s.done();
