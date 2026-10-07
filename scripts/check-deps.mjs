#!/usr/bin/env node
// DESIGN.md §k.2 dependency rules: a regex import scan over src/**/*.ts.
// Usage: node scripts/check-deps.mjs [--quiet]
// Exit 1 on any violation. Warnings (stand-in imports to replace at
// integration) are printed but do not fail.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

const BROWSER_GLOBALS = [
	["indexedDB", /\bindexedDB\b/],
	["WebSocket", /\bWebSocket\b/],
	["fetch", /(?<![.\w])fetch\s*\(/],
	["crypto.subtle", /\bcrypto\.subtle\b/],
	["XMLHttpRequest", /\bXMLHttpRequest\b/],
];

/**
 * The main thread holds CodeMirror state and raw disk I/O only (DESIGN §d.2): no CRDT package anywhere under
 * host/** (tests and type-only imports included), and none reachable from host/** through core/ports/protocol.
 * The engine reaches main only through the two documented entries (integration-notes D2).
 */
export const MAIN_FORBIDDEN = ["yjs", "y-codemirror.next", "y-protocols", "lib0"];
/**
 * The main thread never hashes (§d.2; HostPorts has no HashPort, §h): no product host/** module may import
 * core/hash/** (type-only imports included), directly or through core/ports/protocol. Tests may, to compute
 * expected values.
 */
export const MAIN_FORBIDDEN_DIRS = ["core/hash"];
const isMainForbiddenPath = (p) => MAIN_FORBIDDEN_DIRS.some((d) => p === d || p.startsWith(`${d}/`));
const ENGINE_ENTRIES = new Set(["engine/adapters/webEngine", "engine/workerMain"]);

/** Throwaway day-1 spike plugin (scripts/build-spike.mjs): its own bundle, never imported by the product. */
const isSpike = (f) => f.startsWith("host/spike/");

/**
 * Whole-document reads on main. Every host/** occurrence must be listed in FULL_READ_ALLOW with why it is not
 * on a per-keystroke, per-remote-update or per-workspace-event path; a new one (or one more in a listed file) fails.
 */
export const FULL_READS = [
	["getValue()", /\.getValue\s*\(/g],
	["toString()", /\.toString\s*\(\s*\)/g],
	["sliceDoc()", /\.sliceDoc\s*\(/g],
	["sliceString()", /\.sliceString\s*\(/g],
	["getViewData()", /\.getViewData\s*\(/g],
	["Text.of()", /\bText\.of\s*\(/g],
];
/** file -> pattern -> [count, why]. */
export const FULL_READ_ALLOW = {
	"host/binding.ts": {
		"sliceString()": [1, "bind upload (attach, resync, restart): TEXT_CHUNK_UNITS-unit slices of the editor Text, one chunk per macrotask, transferred"],
	},
	"host/ui/pairing.ts": { "toString()": [1, "URLSearchParams of the pairing link, not a document"] },
	"host/ui/pairFlow.ts": { "toString()": [1, "a number (countdown seconds)"] },
	"host/ui/diagnostics.ts": { "toString()": [1, "a bigint in the diagnostics dump"] },
};

function stripComments(text) {
	// Good enough for import scanning: drop block and line comments, keep strings.
	return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/**
 * Imports of one file: { spec, typeOnly, line }.
 * Handles import/export ... from, side-effect imports, dynamic import(), require().
 */
export function scanImports(text) {
	// Template literals never hold import specifiers; blank them (tests embed code in them).
	const src = stripComments(text).replace(/`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, " "));
	const out = [];
	const lineOf = (idx) => src.slice(0, idx).split("\n").length;
	const fromRe = /\b(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;
	for (const m of src.matchAll(fromRe)) {
		const [, , typeKw, clause, spec] = m;
		let typeOnly = Boolean(typeKw);
		if (!typeOnly) {
			const braces = clause.match(/^\{([\s\S]*)\}$/);
			if (braces) {
				const names = braces[1].split(",").map((s) => s.trim()).filter(Boolean);
				typeOnly = names.length > 0 && names.every((n) => n.startsWith("type "));
			}
		}
		out.push({ spec, typeOnly, line: lineOf(m.index) });
	}
	for (const m of src.matchAll(/(^|[;\s])import\s+["']([^"']+)["']/g)) out.push({ spec: m[2], typeOnly: false, line: lineOf(m.index) });
	for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push({ spec: m[1], typeOnly: false, line: lineOf(m.index) });
	for (const m of src.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push({ spec: m[1], typeOnly: false, line: lineOf(m.index) });
	return out;
}

/** src-relative posix path ("host/plugin.ts") -> area. */
function areaOf(srcRel) {
	return srcRel.split("/")[0];
}

/** Resolve a relative specifier to a src-relative module path without extension, or null if outside src. */
function resolveRel(fromSrcRel, spec) {
	const joined = posix.normalize(posix.join(posix.dirname(fromSrcRel), spec));
	if (joined.startsWith("..")) return { outside: true, path: joined };
	return { outside: false, path: joined.replace(/\.(ts|js|mjs)$/, "") };
}

function pkgName(spec) {
	if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
	return spec.split("/")[0];
}

/** Tests and test-only support code (testkit/ dirs, testkit.ts files, engine/runtime/testHarness.ts) may import sim/** and anything else. */
const isTest = (f) => f.endsWith(".test.ts") || f.split("/").includes("testkit") || f.endsWith("/testkit.ts") || f === "engine/runtime/testHarness.ts";

/**
 * Check one file. Returns { errors: string[], warnings: string[] }.
 * `file` is src-relative posix ("engine/workerMain.ts").
 */
export function checkSource(file, text) {
	const errors = [];
	const warnings = [];
	const area = areaOf(file);
	const test = isTest(file);
	const err = (line, msg) => errors.push(`${file}:${line}: ${msg}`);
	const warn = (line, msg) => warnings.push(`${file}:${line}: ${msg}`);

	if (!test && /\bWebAssembly\b/.test(stripComments(text))) err(1, "WebAssembly is forbidden (pure JS Yjs only)");
	if (area === "host" && !test && !isSpike(file)) checkFullReads(file, text, err);

	for (const { spec, typeOnly, line } of scanImports(text)) {
		if (area === "host" && !spec.startsWith(".") && MAIN_FORBIDDEN.includes(pkgName(spec))) {
			err(line, `no CRDT on the main thread: host/** must not import ${spec} (the worker owns the only Y.Doc)`);
			continue;
		}
		if (/\.wasm($|\?)/.test(spec) || pkgName(spec) === "ywasm" || spec.includes("crdt-engine")) {
			err(line, `WASM import forbidden: ${spec}`);
			continue;
		}
		if (spec.startsWith(".")) {
			const r = resolveRel(file, spec);
			if (r.outside) {
				if (!test) err(line, `imports outside src/: ${spec}`);
				continue;
			}
			const target = r.path;
			const tArea = areaOf(target);
			if (tArea === "sim" && area !== "sim" && !test) {
				err(line, `only tests may import sim/**: ${spec}`);
				continue;
			}
			if (target.split("/").includes("testkit") && area !== "sim" && !test) {
				err(line, `only tests and the sim may import testkit/**: ${spec}`);
				continue;
			}
			if (area === "host" && !test && !isSpike(file) && isMainForbiddenPath(target)) {
				err(line, `no hashing on the main thread: host/** must not import ${spec} (hashing runs in the worker)`);
				continue;
			}
			if (area === "host" && isSpike(target) && !isSpike(file) && !test) {
				err(line, `the spike plugin is not part of the product: ${spec}`);
				continue;
			}
			if (test || area === "sim") continue;
			checkInternal(file, area, target, tArea, typeOnly, spec, line, err, warn);
		} else {
			if (test || area === "sim") continue;
			checkPackage(area, spec, typeOnly, line, err, file);
		}
	}

	if (!test && area === "engine" && !file.startsWith("engine/adapters/")) {
		const body = stripComments(text).replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
		for (const [name, re] of BROWSER_GLOBALS) {
			const m = re.exec(body);
			if (m) err(body.slice(0, m.index).split("\n").length, `browser global ${name} outside engine/adapters/**`);
		}
	}
	return { errors, warnings };
}

function checkFullReads(file, text, err) {
	const body = stripComments(text).replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
	const allow = FULL_READ_ALLOW[file] ?? {};
	for (const [name, re] of FULL_READS) {
		const lines = [...body.matchAll(re)].map((m) => body.slice(0, m.index).split("\n").length);
		const max = allow[name]?.[0] ?? 0;
		if (lines.length > max) err(lines[max], `whole-document read ${name} on main (${lines.length} > ${max} allowed in FULL_READ_ALLOW)`);
	}
}

function checkInternal(file, area, target, tArea, typeOnly, spec, line, err, warn) {
	switch (area) {
		case "core":
			if (tArea === "core") return;
			if (tArea === "ports" && typeOnly) return;
			return err(line, `core/** may import only core/** (and type-only ports/**): ${spec}`);
		case "ports":
			if (tArea === "ports") return;
			if (tArea === "core" && typeOnly) return;
			return err(line, `ports/** may import only core/** types: ${spec}`);
		case "protocol":
			if (tArea === "protocol") return;
			if ((tArea === "core" || tArea === "ports") && typeOnly) return;
			return err(line, `protocol/** may import only core/ports types and protocol/**: ${spec}`);
		case "engine":
			if (["core", "ports", "protocol", "engine"].includes(tArea)) return;
			return err(line, `engine/** must not import ${tArea}/**: ${spec}`);
		case "host":
			if (["core", "ports", "protocol", "host"].includes(tArea)) return;
			if (tArea === "engine") {
				// Deviations from DESIGN §k.2 (integration-notes D2): the inline-fallback entry is the composed web
				// engine, and the bundle entry starts the worker's engine (main.js is also the worker script).
				if (target === "engine/adapters/webEngine") return;
				if (target === "engine/workerMain" && file === "host/entry.ts") return;
				return err(line, `host/** may import from engine/ only engine/adapters/webEngine.ts (and host/entry.ts engine/workerMain.ts): ${spec}`);
			}
			return err(line, `host/** must not import ${tArea}/**: ${spec}`);
		default:
			return err(line, `unknown source area ${area}`);
	}
}

function checkPackage(area, spec, typeOnly, line, err, file) {
	const pkg = pkgName(spec);
	const allowed = {
		core: ["lib0", "fflate"],
		ports: [],
		protocol: [],
		engine: ["yjs", "lib0", "fflate"],
		host: ["obsidian", "@codemirror/state", "@codemirror/view", "@codemirror/commands", "@codemirror/language", "qrcode"],
	}[area];
	if (!allowed) return err(line, `unknown source area ${area}`);
	if (area === "ports" && pkg === "@codemirror/state" && typeOnly && file === "ports/workspace.ts") return;
	if (area === "host" && pkg.startsWith("@codemirror/")) return;
	if (spec.startsWith("node:")) return err(line, `node built-in in shipped code: ${spec}`);
	if (!allowed.includes(pkg)) err(line, `${area}/** must not import package ${spec}`);
}

function walk(dir, out) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
	}
	return out;
}

/**
 * Transitive MAIN_FORBIDDEN check: from every product host/** module, follow relative imports (not into the
 * engine entries) and fail on a CRDT package import, or an import of a MAIN_FORBIDDEN_DIRS module, anywhere along
 * the way. `sources`: src-relative path -> text.
 */
export function mainReach(sources) {
	const errors = [];
	const memo = new Map();
	const resolve = (from, spec) => {
		const r = resolveRel(from, spec);
		if (r.outside || ENGINE_ENTRIES.has(r.path)) return null;
		return [`${r.path}.ts`, `${r.path}/index.ts`].find((c) => sources.has(c)) ?? null;
	};
	const via = (mod, stack) => {
		if (memo.has(mod)) return memo.get(mod);
		if (stack.has(mod)) return null;
		stack.add(mod);
		let found = null;
		for (const { spec } of scanImports(sources.get(mod))) {
			if (!spec.startsWith(".")) {
				if (MAIN_FORBIDDEN.includes(pkgName(spec))) found = [mod, spec];
			} else {
				const r = resolveRel(mod, spec);
				if (!r.outside && isMainForbiddenPath(r.path)) {
					found = [mod, r.path];
				} else {
					const next = resolve(mod, spec);
					const chain = next && via(next, stack);
					if (chain) found = [mod, ...chain];
				}
			}
			if (found) break;
		}
		stack.delete(mod);
		memo.set(mod, found);
		return found;
	};
	for (const mod of sources.keys()) {
		if (areaOf(mod) !== "host" || isTest(mod) || isSpike(mod)) continue;
		const chain = via(mod, new Set());
		if (chain && chain.length > 2) errors.push(`${mod}:1: main thread reaches ${chain[chain.length - 1]} via ${chain.slice(0, -1).join(" -> ")}`);
	}
	return errors;
}

export function checkTree(srcDir = SRC) {
	const errors = [];
	const warnings = [];
	const sources = new Map();
	for (const abs of walk(srcDir, [])) {
		const rel = relative(srcDir, abs).split("\\").join("/");
		const text = readFileSync(abs, "utf8");
		sources.set(rel, text);
		const r = checkSource(rel, text);
		errors.push(...r.errors);
		warnings.push(...r.warnings);
	}
	errors.push(...mainReach(sources));
	return { files: sources.size, errors, warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const quiet = process.argv.includes("--quiet");
	const { files, errors, warnings } = checkTree();
	if (!quiet) for (const w of warnings) console.log(`warn  ${w}`);
	for (const e of errors) console.log(`error ${e}`);
	console.log(`check-deps: ${files} files, ${errors.length} errors, ${warnings.length} warnings`);
	process.exit(errors.length ? 1 : 0);
}
