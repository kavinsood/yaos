#!/usr/bin/env node

/**
 * Guard: generated artifacts must never be tracked by Git.
 *
 * Builds may create these files locally, but releases build and
 * publish them from source. Keeping them out of the index prevents generated
 * output from becoming a second source of truth.
 */

import { execFileSync } from "node:child_process";

const BLOCKED_PATHS = [
	"main.js",
	"dist",
	"*.map",
];

let tracked;
try {
	tracked = execFileSync("git", ["ls-files", "-z", "--", ...BLOCKED_PATHS], {
		encoding: "utf8",
	}).split("\0").filter(Boolean);
} catch (error) {
	console.error("FAIL: could not inspect Git's tracked generated artifacts.");
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}

if (tracked.length > 0) {
	console.error("FAIL: generated artifacts are tracked by Git:");
	for (const path of tracked) console.error(`  ${path}`);
	console.error("");
	console.error("Generated bundles must remain untracked.");
	console.error("Remove them from the index with: git rm -r --cached -- <path>");
	process.exit(1);
}

console.log("PASS: no generated bundles are tracked.");
