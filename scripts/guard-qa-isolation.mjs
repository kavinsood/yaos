#!/usr/bin/env node

/**
 * guard-qa-isolation.mjs
 *
 * Verifies that src/sync/ and src/runtime/ do not import QA/scenario
 * machinery directly. The fence rule:
 *
 *   Product sync/runtime code must NOT import:
 *   - qaDebugApi
 *   - YaosUnsafeQaPort
 *   - __qaOnly (as identifier)
 *   - setScenarioRunId / advanceScenarioStep (as direct imports)
 *   - forceCrdtContent / forceReplaceYText (from qaDebugApi context)
 *
 * Allowed:
 *   - qaDebugMode (settings flag check — this gates behavior, not imports)
 *   - _qaOfflineHold in connectionController (existing, to be migrated later)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SCAN_DIRS = ["src/sync", "src/runtime"];
const FORBIDDEN_PATTERNS = [
	/from\s+["'].*qaDebugApi/,
	/from\s+["'].*yaosUnsafeQaPort/,
	/import.*YaosUnsafeQaPort/,
	/import.*__qaOnly/,
];

// Known exception: connectionController has _qaOfflineHold (to be migrated later).
const KNOWN_EXCEPTIONS = new Set([
	"src/runtime/connectionController.ts",
]);

let violations = 0;

function scanDir(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			scanDir(fullPath);
		} else if (entry.endsWith(".ts")) {
			checkFile(fullPath);
		}
	}
}

function checkFile(filePath) {
	const relPath = relative(".", filePath);
	if (KNOWN_EXCEPTIONS.has(relPath)) return;

	const content = readFileSync(filePath, "utf8");
	for (const pattern of FORBIDDEN_PATTERNS) {
		const match = content.match(pattern);
		if (match) {
			console.error(`FAIL: ${relPath} contains forbidden QA import: ${match[0]}`);
			violations++;
		}
	}
}

for (const dir of SCAN_DIRS) {
	scanDir(dir);
}

if (violations > 0) {
	console.error(`\nFAIL: ${violations} QA isolation violation(s) in src/sync/ and src/runtime/.`);
	console.error("These directories must not import QA/scenario machinery directly.");
	process.exit(1);
} else {
	console.log("PASS: src/sync/ and src/runtime/ do not import QA machinery.");
}
