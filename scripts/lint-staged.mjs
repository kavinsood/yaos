#!/usr/bin/env node

/**
 * lint-staged.mjs — Lint staged (index) files before commit.
 *
 * Unlike lint-changed.mjs which compares HEAD vs origin/main (committed files
 * only), this script lints files staged in the git index. Use this as a
 * pre-commit check to catch lint errors before they reach committed history.
 *
 * Policy:
 *   - Staged files with changes must have zero lint errors to pass.
 *   - Uses the working-tree version of staged files (so edits you've staged
 *     but also modified further are linted in their current state).
 *
 * IMPORTANT LIMITATION:
 *   This is FILE-LEVEL linting, not CHANGED-LINE linting. If you touch a file
 *   with pre-existing baseline lint debt (e.g., reconciliationController.ts),
 *   this script will fail on those old errors even if your changes are clean.
 *
 *   For files with baseline debt, use lint:changed which only gates NEW files.
 *   This script is most useful for:
 *     - Newly created files (no baseline debt)
 *     - Clean legacy files (no pre-existing errors)
 *     - Verifying a file is fully clean before committing
 *
 * Usage:
 *   node scripts/lint-staged.mjs              # lint staged files
 *   node scripts/lint-staged.mjs --worktree   # lint all modified files (staged + unstaged)
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const includeWorktree = args.includes("--worktree");

// Get staged files (or all modified files if --worktree).
let diffOutput = "";
{
	const diffArgs = includeWorktree
		? ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]  // all modified vs HEAD
		: ["diff", "--name-only", "--diff-filter=ACMR", "--cached"]; // staged only

	const result = spawnSync("git", diffArgs, { encoding: "utf8" });
	if (result.status !== 0) {
		console.error("lint:staged — could not determine changed files");
		console.error(result.stderr);
		process.exit(2);
	}
	diffOutput = (result.stdout || "").trim();
}

const modeLabel = includeWorktree ? "worktree" : "staged";

if (!diffOutput) {
	console.log(`lint:staged — no ${modeLabel} files, nothing to lint.`);
	process.exit(0);
}

// Filter to .ts and .mts files that still exist on disk.
const files = diffOutput
	.split("\n")
	.filter((f) => /\.(ts|mts)$/.test(f))
	.filter((f) => existsSync(f));

if (files.length === 0) {
	console.log(`lint:staged — no lintable TypeScript files in ${modeLabel} changes.`);
	process.exit(0);
}

console.log(`lint:staged — ${files.length} ${modeLabel} file(s):`);
for (const f of files) console.log(`  ${f}`);

const eslintBin = resolve("node_modules/.bin/eslint");

// Run ESLint.
const result = spawnSync(eslintBin, ["--no-warn-ignored", ...files.map((f) => resolve(f))], {
	stdio: "inherit",
	encoding: "utf8",
});

if (result.status !== 0) {
	console.error(`\nlint:staged — FAIL: lint errors in ${modeLabel} files.`);
	process.exit(1);
}

console.log(`\nlint:staged — passed. (${files.length} file(s) clean)`);
