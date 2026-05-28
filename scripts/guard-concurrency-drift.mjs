#!/usr/bin/env node

/**
 * guard-concurrency-drift.mjs
 *
 * Ensures the server build-boundary copy of mapWithConcurrency stays
 * identical to the canonical implementation in src/shared/concurrency.ts.
 *
 * The server build (server/tsconfig.json) cannot import from the client
 * src/ tree, so a copy exists at server/src/concurrency.ts. This guard
 * ensures they don't drift.
 */

import { readFileSync } from "node:fs";

const CANONICAL = "src/shared/concurrency.ts";
const COPY = "server/src/concurrency.ts";

/**
 * Extract the function body (everything from the export line to end of file),
 * stripping the header comment block.
 */
function extractFunctionBody(content) {
	const exportIdx = content.indexOf("export async function mapWithConcurrency");
	if (exportIdx === -1) {
		return null;
	}
	return content.slice(exportIdx).trim();
}

const canonicalContent = readFileSync(CANONICAL, "utf8");
const copyContent = readFileSync(COPY, "utf8");

const canonicalBody = extractFunctionBody(canonicalContent);
const copyBody = extractFunctionBody(copyContent);

if (!canonicalBody) {
	console.error(`FAIL: could not find mapWithConcurrency export in ${CANONICAL}`);
	process.exit(1);
}

if (!copyBody) {
	console.error(`FAIL: could not find mapWithConcurrency export in ${COPY}`);
	process.exit(1);
}

if (canonicalBody !== copyBody) {
	console.error("FAIL: mapWithConcurrency function body has drifted between:");
	console.error(`  canonical: ${CANONICAL}`);
	console.error(`  copy:      ${COPY}`);
	console.error("");
	console.error("The function bodies must be identical. Update both files.");
	process.exit(1);
}

console.log("PASS: mapWithConcurrency implementations are identical.");
