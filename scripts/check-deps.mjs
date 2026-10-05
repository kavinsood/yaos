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

/** Virtual module the esbuild config resolves to the bundled engine worker source. */
export const WORKER_SOURCE_MODULE = "virtual:yaos-engine-worker";

const BROWSER_GLOBALS = [
	["indexedDB", /\bindexedDB\b/],
	["WebSocket", /\bWebSocket\b/],
	["fetch", /(?<![.\w])fetch\s*\(/],
	["crypto.subtle", /\bcrypto\.subtle\b/],
];

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

const isTest = (f) => f.endsWith(".test.ts");

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

	for (const { spec, typeOnly, line } of scanImports(text)) {
		if (/\.wasm($|\?)/.test(spec) || pkgName(spec) === "ywasm" || spec.includes("crdt-engine")) {
			err(line, `WASM import forbidden: ${spec}`);
			continue;
		}
		if (spec.startsWith(".")) {
			const r = resolveRel(file, spec);
			if (r.outside) {
				if (r.path.includes("legacy-src")) err(line, `imports legacy-src (copy what you port): ${spec}`);
				else if (!test) err(line, `imports outside src/: ${spec}`);
				continue;
			}
			const target = r.path;
			const tArea = areaOf(target);
			if (tArea === "sim" && area !== "sim" && !test) {
				err(line, `only tests may import sim/**: ${spec}`);
				continue;
			}
			if (test || area === "sim") continue;
			checkInternal(file, area, target, tArea, typeOnly, spec, line, err, warn);
		} else {
			if (test || area === "sim") continue;
			checkPackage(area, spec, typeOnly, line, err, file);
		}
	}

	if (!test && area === "engine" && !file.startsWith("engine/adapters/") && !file.startsWith("engine/__standins__/")) {
		const body = stripComments(text).replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
		for (const [name, re] of BROWSER_GLOBALS) {
			const m = re.exec(body);
			if (m) err(body.slice(0, m.index).split("\n").length, `browser global ${name} outside engine/adapters/**`);
		}
	}
	return { errors, warnings };
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
				if (target === "engine/runtime/engine") return;
				if (target.startsWith("engine/__standins__/")) {
					return warn(line, `stand-in import (INTEGRATION: replace with engine/runtime/engine): ${spec}`);
				}
				return err(line, `host/** may import from engine/ only engine/runtime/engine.ts: ${spec}`);
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
		host: ["obsidian", "yjs", "y-codemirror.next", "@codemirror/state", "@codemirror/view", "@codemirror/commands", "@codemirror/language"],
	}[area];
	if (!allowed) return err(line, `unknown source area ${area}`);
	if (area === "ports" && pkg === "yjs" && typeOnly && file === "ports/workspace.ts") return;
	if (area === "host" && (spec === WORKER_SOURCE_MODULE || pkg.startsWith("@codemirror/"))) return;
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

export function checkTree(srcDir = SRC) {
	const errors = [];
	const warnings = [];
	let files = 0;
	for (const abs of walk(srcDir, [])) {
		files++;
		const rel = relative(srcDir, abs).split("\\").join("/");
		const r = checkSource(rel, readFileSync(abs, "utf8"));
		errors.push(...r.errors);
		warnings.push(...r.warnings);
	}
	return { files, errors, warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const quiet = process.argv.includes("--quiet");
	const { files, errors, warnings } = checkTree();
	if (!quiet) for (const w of warnings) console.log(`warn  ${w}`);
	for (const e of errors) console.log(`error ${e}`);
	console.log(`check-deps: ${files} files, ${errors.length} errors, ${warnings.length} warnings`);
	process.exit(errors.length ? 1 : 0);
}
