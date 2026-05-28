#!/usr/bin/env node

/**
 * lint-changed.mjs — New-file lint gate with baseline-debt reporting.
 *
 * Policy:
 *   - New files (not present at base ref) must have zero lint errors.
 *   - Modified files (present at base ref) are linted and errors reported,
 *     but they do not fail the gate. This is an interim policy while
 *     baseline debt exists in files like src/main.ts.
 *
 * In CI (CI=true), missing base refs and diff failures are hard errors.
 * Locally, they are skipped with a warning.
 *
 * Usage:
 *   node scripts/lint-changed.mjs               # compare against origin/main
 *   node scripts/lint-changed.mjs --base HEAD~1 # compare against specific ref
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
let base = "origin/main";

const baseIdx = args.indexOf("--base");
if (baseIdx !== -1 && args[baseIdx + 1]) {
	base = args[baseIdx + 1];
}

const isCi = process.env.CI === "true";

/**
 * In CI, exit 1. Locally, exit 0 with a warning.
 * @param {string} message
 * @returns {never}
 */
function skipOrFail(message) {
	if (isCi) {
		console.error(`lint:changed — ERROR: ${message}`);
		process.exit(1);
	}
	console.log(`lint:changed — ${message}, skipping outside CI.`);
	process.exit(0);
}

// Verify base ref exists.
{
	const result = spawnSync("git", ["rev-parse", base], { stdio: "ignore" });
	if (result.status !== 0) {
		skipOrFail(`base ref '${base}' not found`);
	}
}

// Get changed/added/modified/renamed files relative to base.
let diffOutput = "";
{
	let result = spawnSync(
		"git", ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) {
		// Three-dot may fail (detached HEAD). Try two-dot.
		result = spawnSync(
			"git", ["diff", "--name-only", "--diff-filter=ACMR", base],
			{ encoding: "utf8" },
		);
	}
	if (result.status !== 0) {
		skipOrFail("could not determine changed files");
	}
	diffOutput = (result.stdout || "").trim();
}

if (!diffOutput) {
	console.log("lint:changed — no changed files, nothing to lint.");
	process.exit(0);
}

// Filter to .ts and .mts files that still exist on disk.
const files = diffOutput
	.split("\n")
	.filter((f) => /\.(ts|mts)$/.test(f))
	.filter((f) => existsSync(f));

if (files.length === 0) {
	console.log("lint:changed — no lintable TypeScript files changed.");
	process.exit(0);
}

// Classify files: new (not in base) vs modified (existed at base).
const newFiles = [];
const modifiedFiles = [];

for (const f of files) {
	const result = spawnSync("git", ["cat-file", "-e", `${base}:${f}`], { stdio: "ignore" });
	if (result.status === 0) {
		modifiedFiles.push(f);
	} else {
		newFiles.push(f);
	}
}

console.log(`lint:changed — ${files.length} file(s): ${newFiles.length} new, ${modifiedFiles.length} modified`);
for (const f of newFiles) console.log(`  [new]      ${f}`);
for (const f of modifiedFiles) console.log(`  [modified] ${f}`);

const eslintBin = resolve("node_modules/.bin/eslint");

/**
 * Run ESLint JSON on files. Returns per-file error counts.
 * @param {string[]} filePaths
 * @returns {Map<string, number>}
 */
function lintErrorCounts(filePaths) {
	const result = spawnSync(eslintBin, ["--no-warn-ignored", "--format", "json", ...filePaths], {
		encoding: "utf8",
		maxBuffer: 50 * 1024 * 1024,
	});
	if (result.status === 2) {
		console.error("lint:changed — ESLint fatal error:");
		console.error(result.stderr || result.stdout);
		process.exit(2);
	}
	const counts = new Map();
	try {
		for (const entry of JSON.parse(result.stdout)) {
			counts.set(entry.filePath, entry.errorCount);
		}
	} catch { /* file may be ignored */ }
	return counts;
}

// Lint all changed files.
const counts = lintErrorCounts(files.map((f) => resolve(f)));

// Gate new files: must have zero errors.
let newFileErrors = 0;
const newFileFailures = [];
for (const f of newFiles) {
	const errorCount = counts.get(resolve(f)) ?? 0;
	if (errorCount > 0) {
		newFileErrors += errorCount;
		newFileFailures.push({ file: f, errors: errorCount });
	}
}

// Report modified files: not gated, just reported.
let baselineErrors = 0;
for (const f of modifiedFiles) {
	const errorCount = counts.get(resolve(f)) ?? 0;
	if (errorCount > 0) {
		baselineErrors += errorCount;
		console.log(`  [baseline] ${f}: ${errorCount} error(s) (pre-existing, not gated)`);
	}
}

if (newFileFailures.length > 0) {
	console.error(`\nlint:changed — FAIL: ${newFileErrors} error(s) in ${newFileFailures.length} new file(s):`);
	for (const { file, errors } of newFileFailures) {
		console.error(`  ${file}: ${errors} error(s)`);
	}
	// Show the actual errors.
	try {
		execFileSync(eslintBin, ["--no-warn-ignored", ...newFileFailures.map((f) => resolve(f.file))], {
			stdio: "inherit",
		});
	} catch { /* already reported */ }
	process.exit(1);
}

if (baselineErrors > 0) {
	console.log(`\nlint:changed — passed. (${baselineErrors} pre-existing error(s) in modified files, not gated.)`);
} else {
	console.log("\nlint:changed — passed.");
}
