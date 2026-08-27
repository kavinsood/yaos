#!/usr/bin/env node
/**
 * Enforce the schema-4 ownership contract.
 *
 * The plugin owns its pin in src/sync/schema.ts. The server owns its pin in
 * server/src/shared/productVersions.ts and exposes that same symbol through
 * server/src/version.ts. Both canonical sources must exist, the plugin source
 * must remain on schema 4, and the server source must match it exactly.
 */

import { readFileSync, existsSync } from "node:fs";

const EXPECTED_PLUGIN_SCHEMA_VERSION = 4;
let failures = 0;

function fail(msg) {
	console.error("FAIL:", msg);
	failures++;
}

function pass(msg) {
	console.log("PASS:", msg);
}

const PLUGIN_SCHEMA_SOURCE = "src/sync/schema.ts";
const SERVER_SCHEMA_SOURCE = "server/src/shared/productVersions.ts";
const SERVER_VERSION_MODULE = "server/src/version.ts";

function readSchemaVersion(path, owner) {
	if (!existsSync(path)) {
		fail(`${path} is missing — ${owner} schema pin cannot be validated.`);
		return null;
	}

	const content = readFileSync(path, "utf8");
	const match = content.match(
		/^\s*export\s+const\s+SCHEMA_VERSION(?:\s*:\s*number)?\s*=\s*(\d+)(?:\s+as\s+const)?\s*;?\s*$/m,
	);
	if (!match) {
		fail(`${path} does not export SCHEMA_VERSION as a numeric literal.`);
		return null;
	}

	const version = Number(match[1]);
	pass(`${path}: SCHEMA_VERSION = ${version}`);
	return version;
}

function validateServerVersionModule() {
	if (!existsSync(SERVER_VERSION_MODULE)) {
		fail(`${SERVER_VERSION_MODULE} is missing — the server schema pin is not publicly exposed.`);
		return;
	}

	const content = readFileSync(SERVER_VERSION_MODULE, "utf8");
	const importsCanonicalPin =
		/import\s*{[^}]*\bSCHEMA_VERSION\b[^}]*}\s*from\s*["']\.\/shared\/productVersions["']\s*;?/s.test(
			content,
		);
	const exportsImportedPin =
		/export\s+const\s+SERVER_SCHEMA_VERSION(?:\s*:\s*number)?\s*=\s*SCHEMA_VERSION\s*;?/.test(
			content,
		);
	const directlyReexportsCanonicalPin =
		/export\s*{[^}]*\bSCHEMA_VERSION\s+as\s+SERVER_SCHEMA_VERSION\b[^}]*}\s*from\s*["']\.\/shared\/productVersions["']\s*;?/s.test(
			content,
		);

	if (!(directlyReexportsCanonicalPin || (importsCanonicalPin && exportsImportedPin))) {
		fail(
			`${SERVER_VERSION_MODULE} must expose SERVER_SCHEMA_VERSION from ${SERVER_SCHEMA_SOURCE}, not duplicate a numeric pin.`,
		);
		return;
	}

	pass(`${SERVER_VERSION_MODULE} exposes the canonical server schema pin`);
}

const pluginSchemaVersion = readSchemaVersion(PLUGIN_SCHEMA_SOURCE, "plugin");
const serverSchemaVersion = readSchemaVersion(SERVER_SCHEMA_SOURCE, "server");

if (
	pluginSchemaVersion !== null &&
	pluginSchemaVersion !== EXPECTED_PLUGIN_SCHEMA_VERSION
) {
	fail(
		`${PLUGIN_SCHEMA_SOURCE} has SCHEMA_VERSION = ${pluginSchemaVersion}, expected ${EXPECTED_PLUGIN_SCHEMA_VERSION}.`,
	);
}

if (
	pluginSchemaVersion !== null &&
	serverSchemaVersion !== null &&
	serverSchemaVersion !== pluginSchemaVersion
) {
	fail(
		`${SERVER_SCHEMA_SOURCE} must pin the plugin's schema version exactly: plugin=${pluginSchemaVersion}, server=${serverSchemaVersion}.`,
	);
}

validateServerVersionModule();

if (failures > 0) {
	console.error(`\nFAIL: ${failures} schema-version guard violation(s).`);
	console.error(`  ${PLUGIN_SCHEMA_SOURCE} must pin schema ${EXPECTED_PLUGIN_SCHEMA_VERSION}, and`);
	console.error(`  ${SERVER_SCHEMA_SOURCE} and ${SERVER_VERSION_MODULE} must expose that same exact pin.`);
	process.exit(1);
} else {
	console.log("\nPASS: schema version guard — all checks passed.");
}
