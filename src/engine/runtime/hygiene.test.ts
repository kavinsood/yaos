/**
 * Static engine rules (task brief + DESIGN §d.4/§d.8): only yjsCounters.ts calls
 * Y.encodeStateAsUpdate / Y.mergeUpdates; src/engine imports only core, ports,
 * protocol, yjs, lib0, fflate; browser globals and real timers only in adapters.
 * Test files and test kits
 * (any testkit/ directory, testHarness.ts, relayTestFakes.ts) are exempt.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ENGINE, "..");

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (p.endsWith(".ts")) out.push(p);
	}
	return out;
}

const files = walk(ENGINE)
	.map((p) => ({ path: p, rel: relative(ENGINE, p) }))
	.filter((f) => !f.rel.endsWith(".test.ts") && !f.rel.split("/").includes("testkit") && f.rel !== "runtime/testHarness.ts" && f.rel !== "adapters/relayTestFakes.ts");

/** Source without comments or string bodies (keeps quotes so import specifiers survive separately). */
function code(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``");
}

test("hygiene: the walk sees the engine", () => {
	assert.ok(files.length > 30, `${files.length} files`);
	assert.ok(files.some((f) => f.rel === "body/yjsCounters.ts"));
});

test("hygiene: only yjsCounters.ts calls Y.encodeStateAsUpdate / Y.mergeUpdates (counted)", () => {
	const bad = /\bY\.(encodeStateAsUpdate|encodeStateAsUpdateV2|mergeUpdates|mergeUpdatesV2)\s*\(|import\s*\{[^}]*\b(encodeStateAsUpdate|mergeUpdates)\b[^}]*\}\s*from\s*"yjs"/;
	const hits = files.filter((f) => f.rel !== "body/yjsCounters.ts" && bad.test(code(readFileSync(f.path, "utf8")))).map((f) => f.rel);
	assert.deepEqual(hits, []);
});

test("hygiene: imports stay within core / ports / protocol / engine and yjs, lib0, fflate", () => {
	const allowedDirs = ["core", "ports", "protocol", "engine"].map((d) => join(SRC, d));
	const problems: string[] = [];
	let scanned = 0;
	for (const f of files) {
		const src = code(readFileSync(f.path, "utf8"));
		for (const m of src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"|^\s*import\s*"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/gm)) {
			const spec = (m[1] ?? m[2] ?? m[3])!;
			scanned++;
			if (spec.startsWith(".")) {
				const target = resolve(dirname(f.path), spec);
				if (!allowedDirs.some((d) => target === d || target.startsWith(d + "/"))) problems.push(`${f.rel}: ${spec}`);
				if (/\/host\//.test(target)) problems.push(`${f.rel}: ${spec}`);
				if (!f.rel.startsWith("adapters/") && target.startsWith(join(ENGINE, "adapters") + "/") && !/adapters\/(noopCrypto|webHash|webClock|webRandom|webEngine)$/.test(target)) {
					problems.push(`${f.rel}: engine core imports adapter ${spec}`);
				}
			} else if (!/^(yjs|lib0|fflate)(\/|$)/.test(spec)) problems.push(`${f.rel}: package ${spec}`);
		}
	}
	assert.deepEqual(problems, []);
	assert.ok(scanned > 150, `scanned ${scanned} imports`);
});

test("hygiene: browser globals and real timers only in engine/adapters", () => {
	const globals = /\b(window\.|document\.|indexedDB\b|IDBKeyRange\b|new WebSocket\b|fetch\s*\(|localStorage\b|sessionStorage\b|navigator\.|setTimeout\s*\(|setInterval\s*\(|clearTimeout\s*\(|clearInterval\s*\(|queueMicrotask\s*\(|requestAnimationFrame\b|requestIdleCallback\b|performance\.now|Date\.now\s*\(|Math\.random\s*\(|globalThis\.|crypto\.subtle|crypto\.getRandomValues|process\.)/;
	const hits: string[] = [];
	for (const f of files) {
		if (f.rel.startsWith("adapters/")) continue;
		const lines = code(readFileSync(f.path, "utf8")).split("\n");
		lines.forEach((l, i) => {
			if (globals.test(l)) hits.push(`${f.rel}:${i + 1}: ${l.trim()}`);
		});
	}
	assert.deepEqual(hits, []);
});
