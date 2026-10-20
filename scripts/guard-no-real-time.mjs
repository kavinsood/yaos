#!/usr/bin/env node

/**
 * guard-no-real-time.mjs
 *
 * Bans the real clock, real timers and real randomness from src/core, src/engine and src/protocol.
 *
 * WHY: the engine reads time, schedules work and draws entropy only through its ports (ClockPort, RandomPort),
 * so the deterministic sim (src/sim) can drive it with a VirtualClock and a seeded random and replay any seed
 * exactly. One stray Date.now / setTimeout / Math.random makes a seed's run depend on the host, and a sim
 * failure stops replaying. tsc cannot see this; check-deps only sees imports, not globals.
 *
 * BANNED (in code, not comments or strings): Date.now, zero-argument new Date(), performance.now, setTimeout,
 * setInterval, setImmediate, queueMicrotask, Math.random, getRandomValues, randomUUID.
 *
 * EXEMPT:
 *   src/engine/adapters/**   the production implementations of the ports (webClock, webRandom, wsRelay ...).
 *   test-only code           *.test.ts, testkit/ dirs, testkit.ts files, engine/runtime/testHarness.ts (the same
 *                            rule as scripts/check-deps.mjs, which keeps production code from importing them).
 *   ALLOW below              single files, each with its reason. An entry that no longer matches fails the guard.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TREES = ["src/core", "src/engine", "src/protocol"];

const RULES = [
	{ label: "Date.now", re: /\bDate\s*\.\s*now\b/ },
	{ label: "new Date()", re: /\bnew\s+Date\s*\(\s*\)/ },
	{ label: "performance.now", re: /\bperformance\s*\.\s*now\b/ },
	{ label: "setTimeout", re: /\bsetTimeout\b/ },
	{ label: "setInterval", re: /\bsetInterval\b/ },
	{ label: "setImmediate", re: /\bsetImmediate\b/ },
	{ label: "queueMicrotask", re: /\bqueueMicrotask\b/ },
	{ label: "Math.random", re: /\bMath\s*\.\s*random\b/ },
	{ label: "getRandomValues", re: /\bgetRandomValues\b/ },
	{ label: "randomUUID", re: /\brandomUUID\b/ },
];

/** Files outside the exempt trees that may use a banned API, with why. */
const ALLOW = {
	"src/protocol/workerTransport.ts":
		"macrotaskSchedule(), the real transports' default Schedule (MessageChannel, else setTimeout 0); the sim always injects VirtualClock.schedule (src/sim/device.ts createInlinePair)",
};

const isExempt = (f) =>
	f.startsWith("src/engine/adapters/") ||
	f.endsWith(".test.ts") ||
	f.split("/").includes("testkit") ||
	f.endsWith("/testkit.ts") ||
	f === "src/engine/runtime/testHarness.ts";

/** Blank comments and string literals, keeping newlines (as guard-no-any.mjs). Template text is blanked too. */
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
		if (ch === "\\") { out += "  "; i++; continue; }
		if (ch === state) { state = "code"; out += ch; continue; }
		out += keep;
	}
	return out;
}

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (full.endsWith(".ts")) out.push(full.split("\\").join("/"));
	}
	return out;
}

const violations = [];
const allowed = [];
let exempt = 0;
const used = new Set();
for (const tree of TREES) {
	for (const file of walk(tree)) {
		const raws = readFileSync(file, "utf8").split("\n");
		const codes = blankNonCode(raws.join("\n")).split("\n");
		codes.forEach((code, idx) => {
			for (const { label, re } of RULES) {
				if (!re.test(code)) continue;
				const hit = `${file}:${idx + 1}  ${label}  ${raws[idx].trim().slice(0, 100)}`;
				if (isExempt(file)) exempt++;
				else if (ALLOW[file]) { allowed.push(hit); used.add(file); }
				else violations.push(hit);
			}
		});
	}
}
const stale = Object.keys(ALLOW).filter((f) => !used.has(f));

if (violations.length > 0) {
	console.error(`FAIL [no-real-time]: ${violations.length} real clock / timer / randomness use(s):\n`);
	for (const v of violations) console.error(`  ${v}`);
	console.error("\nTake a ClockPort (now, monotonic, setTimer) or a RandomPort from the engine's ports instead; real"
		+ "\nimplementations belong in src/engine/adapters/. A justified exception goes in ALLOW, with its reason.");
}
if (stale.length > 0) console.error(`\nFAIL [no-real-time]: ALLOW entries with no banned use left (remove them): ${stale.join(", ")}`);
if (violations.length > 0 || stale.length > 0) process.exit(1);
for (const a of allowed) console.log(`  allowed: ${a}`);
console.log(`PASS [no-real-time]: ${TREES.join(", ")} use no real clock, timers or randomness (${exempt} hit(s) in adapters/test-only code, ${allowed.length} allowlisted).`);
