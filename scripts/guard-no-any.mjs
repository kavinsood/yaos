#!/usr/bin/env node

/**
 * guard-no-any.mjs
 *
 * Bans `any` and its laundered forms from every TypeScript tree in the repo.
 *
 * WHY A SCRIPT AND NOT THE COMPILER: TypeScript has no flag for this. `any` is
 * a deliberate escape hatch, so tsc accepts it silently — which means
 * tsconfig.tests.json can report zero errors over a file that has told the
 * compiler 77 lies. The gate we added is only as strong as the number of
 * escape hatches beneath it. Normally this rule lives in eslint
 * (@typescript-eslint/no-explicit-any), but lint is deliberately not a CI step
 * in this repo, so it lives here instead, next to the other guards.
 *
 * WHAT COUNTS AS A VIOLATION:
 *   as any / : any / <any> / Array<any> / Promise<any> ...
 *     Direct escape hatches.
 *   as unknown as X
 *     The same lie with extra steps. `unknown` is only useful when you then
 *     NARROW it; a double cast skips the narrowing and is strictly worse than
 *     `as any` because it looks disciplined.
 *   @ts-ignore
 *     Suppresses an error without proving it exists, and never expires.
 *
 * DELIBERATELY ALLOWED:
 *   @ts-expect-error, but only with an explanatory comment on the line above.
 *   Tests that feed intentionally malformed values to prove a validator
 *   rejects them cannot be expressed in the type system by definition. Unlike
 *   @ts-ignore this fails loudly once the error stops happening, so it cannot
 *   rot into a silent no-op.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const TREES = ["src", "server/src", "tests"];

const RULES = [
	{ label: "as any", re: /\bas\s+any\b/ },
	{ label: ": any", re: /:\s*any\b/ },
	{ label: "<any>", re: /<\s*any\s*[,>]/ },
	{ label: "as unknown as", re: /\bas\s+unknown\s+as\b/ },
	{ label: "@ts-ignore", re: /@ts-ignore/ },
];

/**
 * Blank out comments and string literals across the WHOLE file, preserving
 * newlines so line numbers still line up.
 *
 * Per-line stripping is not enough: a block comment's continuation lines carry
 * no marker of their own, so this guard's own doc comment above — which names
 * `as any` in order to ban it — reported itself as two violations.
 */
function blankNonCode(source) {
	let out = "";
	let state = "code";
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];
		const keep = ch === "\n" ? "\n" : " ";
		if (state === "code") {
			if (ch === "/" && next === "/") { state = "line"; out += "  "; i++; continue; }
			if (ch === "/" && next === "*") { state = "block"; out += "  "; i++; continue; }
			if (ch === '"' || ch === "'" || ch === "`") { state = ch; out += ch; continue; }
			out += ch;
			continue;
		}
		if (state === "line") {
			if (ch === "\n") state = "code";
			out += keep;
			continue;
		}
		if (state === "block") {
			if (ch === "*" && next === "/") { state = "code"; out += "  "; i++; continue; }
			out += keep;
			continue;
		}
		// Inside a string literal: honour escapes, end on the matching quote.
		if (ch === "\\") { out += "  "; i++; continue; }
		if (ch === state) { state = "code"; out += ch; continue; }
		out += keep;
	}
	return out;
}

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			walk(full, out);
		} else if (extname(full) === ".ts") {
			out.push(full);
		}
	}
	return out;
}

const violations = [];
const unexplained = [];

for (const tree of TREES) {
	for (const file of walk(tree)) {
		const source = readFileSync(file, "utf8");
		const raws = source.split("\n");
		// Type escape hatches are CODE, so they are matched against the
		// comment- and string-blanked form. Suppression directives live INSIDE
		// comments, so they are matched against the raw line instead.
		const codes = blankNonCode(source).split("\n");
		raws.forEach((raw, idx) => {
			const code = codes[idx] ?? "";
			for (const { label, re } of RULES) {
				if (re.test(code)) {
					violations.push(`${file}:${idx + 1}  ${label}  ${raw.trim().slice(0, 100)}`);
				}
			}
			if (/@ts-ignore/.test(raw)) {
				violations.push(`${file}:${idx + 1}  @ts-ignore  ${raw.trim().slice(0, 100)}`);
			}
			// @ts-expect-error is allowed, but must be justified by a comment above it.
			if (/@ts-expect-error/.test(raw)) {
				const above = (raws[idx - 1] ?? "").trim();
				const sameLine = raw.replace(/.*@ts-expect-error/, "").trim();
				if (!sameLine && !above.startsWith("//") && !above.startsWith("*")) {
					unexplained.push(`${file}:${idx + 1}  @ts-expect-error with no explanation above it`);
				}
			}
		});
	}
}

if (violations.length > 0) {
	console.error(`FAIL [no-any]: ${violations.length} escape hatch(es) found:\n`);
	for (const v of violations) console.error(`  ${v}`);
	console.error(
		"\nUse a real type, or `unknown` followed by a narrowing check. For a value that is"
		+ "\ninvalid on purpose, use @ts-expect-error with a comment saying what and why.",
	);
}
if (unexplained.length > 0) {
	console.error(`\nFAIL [no-any]: ${unexplained.length} unexplained @ts-expect-error:\n`);
	for (const v of unexplained) console.error(`  ${v}`);
}
if (violations.length > 0 || unexplained.length > 0) process.exit(1);

console.log(`PASS [no-any]: ${TREES.join(", ")} are free of any, double casts and @ts-ignore.`);
