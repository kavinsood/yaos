#!/usr/bin/env node
/**
 * Enforce the schema-10 ownership contract.
 *
 * The plugin owns its pin in src/sync/schema.ts. The server owns its pin in
 * server/src/shared/productVersions.ts and exposes that same symbol through
 * server/src/version.ts. Both canonical sources must exist, the plugin source
 * must remain on schema 10, and the server source must match it exactly.
 */

import { readFileSync, existsSync } from "node:fs";

const EXPECTED_PRODUCT_VERSIONS = Object.freeze({
	SCHEMA_VERSION: 10,
	STORAGE_FORMAT_VERSION: 6,
	PROTOCOL_VERSION: 8,
	SNAPSHOT_FORMAT_VERSION: 4,
});
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
const SERVER_DOCUMENT_STORE = "server/src/vaultDocumentStore.ts";

function readProductVersions(path, owner) {
	if (!existsSync(path)) {
		fail(`${path} is missing — ${owner} product-version pins cannot be validated.`);
		return null;
	}

	const content = readFileSync(path, "utf8");
	const versions = {};
	for (const name of Object.keys(EXPECTED_PRODUCT_VERSIONS)) {
		const match = content.match(new RegExp(
			`^\\s*export\\s+const\\s+${name}(?:\\s*:\\s*number)?\\s*=\\s*(\\d+)(?:\\s+as\\s+const)?\\s*;?\\s*$`,
			"m",
		));
		if (!match) {
			fail(`${path} does not export ${name} as a numeric literal.`);
			continue;
		}
		versions[name] = Number(match[1]);
		pass(`${path}: ${name} = ${versions[name]}`);
	}
	return versions;
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

function validateServerSqlConstraint() {
	if (!existsSync(SERVER_DOCUMENT_STORE)) {
		fail(`${SERVER_DOCUMENT_STORE} is missing — the durable schema constraint cannot be validated.`);
		return;
	}
	const content = readFileSync(SERVER_DOCUMENT_STORE, "utf8");
	const matches = [...content.matchAll(
		/schema_version\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*schema_version\s*=\s*\$\{SCHEMA_VERSION\}\s*\)/g,
	)];
	if (matches.length !== 1) {
		fail(`${SERVER_DOCUMENT_STORE} must contain exactly one vault_meta schema_version CHECK derived from SCHEMA_VERSION.`);
		return;
	}
	if (!/import\s*{[^}]*\bSCHEMA_VERSION\b[^}]*}\s*from\s*["']\.\/shared\/productVersions["']\s*;?/s.test(content)) {
		fail(`${SERVER_DOCUMENT_STORE} must import SCHEMA_VERSION from the canonical product-version source.`);
		return;
	}
	pass(`${SERVER_DOCUMENT_STORE}: schema_version CHECK derives from SCHEMA_VERSION`);
}

const pluginVersions = readProductVersions(PLUGIN_SCHEMA_SOURCE, "plugin");
const serverVersions = readProductVersions(SERVER_SCHEMA_SOURCE, "server");

for (const [name, expected] of Object.entries(EXPECTED_PRODUCT_VERSIONS)) {
	const pluginVersion = pluginVersions?.[name];
	const serverVersion = serverVersions?.[name];
	if (pluginVersion !== undefined && pluginVersion !== expected) {
		fail(`${PLUGIN_SCHEMA_SOURCE} has ${name} = ${pluginVersion}, expected ${expected}.`);
	}
	if (pluginVersion !== undefined && serverVersion !== undefined && serverVersion !== pluginVersion) {
		const component = name === "SCHEMA_VERSION" ? "schema version" : name;
		fail(`${SERVER_SCHEMA_SOURCE} must pin the plugin's ${component} exactly: plugin=${pluginVersion}, server=${serverVersion}.`);
	}
}

validateServerVersionModule();
if (serverVersions !== null) validateServerSqlConstraint();

if (failures > 0) {
	console.error(`\nFAIL: ${failures} schema-version guard violation(s).`);
	console.error(`  ${PLUGIN_SCHEMA_SOURCE} must pin schema/storage/protocol/snapshot 10/6/8/4, and`);
	console.error(`  ${SERVER_SCHEMA_SOURCE} must expose those same exact pins.`);
	process.exit(1);
} else {
	console.log("\nPASS: schema version guard — all checks passed.");
}
