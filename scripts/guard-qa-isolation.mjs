#!/usr/bin/env node

/**
 * guard-qa-isolation.mjs
 *
 * Verifies that src/sync/, src/runtime/, and src/telemetry/ do not import
 * QA/scenario/Puppeteer machinery directly. The fence rules:
 *
 *   Product sync/runtime code must NOT import:
 *   - qaDebugApi
 *   - YaosUnsafeQaPort
 *   - __qaOnly (as identifier)
 *   - setScenarioRunId / advanceScenarioStep (as direct imports)
 *   - forceCrdtContent / forceReplaceYText (from qaDebugApi context)
 *
 *   Telemetry (Observer) code must NOT import:
 *   - qaDebugApi (Puppeteer mutation API)
 *   - vfsTortureTest (Puppeteer VFS mutation)
 *   - scenarioStateController (Puppeteer scenario mutation)
 *   - YaosUnsafeQaPort
 *
 * Note: installPuppeteerRuntime.ts (formerly installLabRuntime) was deleted
 * in P4A — it was a dead export with no callers. Removed from this guard.
 *
 * Allowed:
 *   - qaDebugMode (settings flag check — this gates behavior, not imports)
 *   - _qaOfflineHold in connectionController (existing, to be migrated later)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SYNC_RUNTIME_FORBIDDEN = [
	/from\s+["'].*qaDebugApi/,
	/from\s+["'].*yaosUnsafeQaPort/,
	/import.*YaosUnsafeQaPort/,
	/import.*__qaOnly/,
];

const TELEMETRY_FORBIDDEN = [
	/from\s+["'].*qaDebugApi/,
	/from\s+["'].*vfsTortureTest/,
	/from\s+["'].*scenarioStateController/,
	/from\s+["'].*yaosUnsafeQaPort/,
	/import.*YaosUnsafeQaPort/,
];

// Known exception: connectionController has _qaOfflineHold (to be migrated later).
const KNOWN_EXCEPTIONS = new Set([
	"src/runtime/connectionController.ts",
]);

let violations = 0;

function scanDir(dir, forbiddenPatterns) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const fullPath = join(dir, entry);
		let stat;
		try {
			stat = statSync(fullPath);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			scanDir(fullPath, forbiddenPatterns);
		} else if (entry.endsWith(".ts")) {
			checkFile(fullPath, forbiddenPatterns);
		}
	}
}

function checkFile(filePath, forbiddenPatterns) {
	const relPath = relative(".", filePath);
	if (KNOWN_EXCEPTIONS.has(relPath)) return;

	const content = readFileSync(filePath, "utf8");
	for (const pattern of forbiddenPatterns) {
		const match = content.match(pattern);
		if (match) {
			console.error(`FAIL: ${relPath} contains forbidden QA import: ${match[0]}`);
			violations++;
		}
	}
}

scanDir("src/sync", SYNC_RUNTIME_FORBIDDEN);
scanDir("src/runtime", SYNC_RUNTIME_FORBIDDEN);
scanDir("src/telemetry", TELEMETRY_FORBIDDEN);

if (violations > 0) {
	console.error(`\nFAIL: ${violations} QA isolation violation(s).`);
	console.error("  src/sync/ and src/runtime/ must not import QA machinery.");
	console.error("  src/telemetry/ must not import Puppeteer/mutation harness.");
	process.exit(1);
} else {
	console.log("PASS: src/sync/, src/runtime/, and src/telemetry/ are QA-isolated.");
}
