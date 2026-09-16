#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const mode = process.argv[2] ?? "quick";
if (mode !== "quick" && mode !== "release") throw new Error("usage: run.mjs <quick|release>");
const root = resolve(import.meta.dirname, "../..");
const node = process.execPath;

function run(label, args, options = {}) {
	console.log(`\n=== ${label} ===`);
	const result = spawnSync(node, args, {
		cwd: root,
		stdio: "inherit",
		env: process.env,
		...options,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${label} failed with status ${result.status}`);
}

const script = (name) => resolve(import.meta.dirname, name);
run("wire and API compatibility", [script("wire-compat.mjs")]);
run("trap and corrupt-input recovery", [script("corrupt-input.mjs")]);
run("Unicode UTF-16 differential fuzz", [
	script("unicode-offset-fuzz.mjs"),
	mode === "release" ? "100" : "5",
	mode === "release" ? "500" : "100",
]);

if (process.env.YAOS_YWASM_CANDIDATE_MODULE) {
	const candidateEnvironment = {
		...process.env,
		YAOS_YWASM_MODULE: process.env.YAOS_YWASM_CANDIDATE_MODULE,
	};
	run("candidate artifact wire compatibility", [script("wire-compat.mjs")], { env: candidateEnvironment });
	run("candidate artifact Unicode UTF-16 differential fuzz", [
		script("unicode-offset-fuzz.mjs"),
		mode === "release" ? "100" : "5",
		mode === "release" ? "500" : "100",
	], { env: candidateEnvironment });
}

const updates = process.env.YAOS_YWASM_LIFECYCLE_UPDATES ?? (mode === "release" ? "5000" : "500");
const repetitions = mode === "release" ? "3" : "1";
run("Yjs lifecycle baseline", [script("lifecycle-benchmark.mjs"), "yjs", updates, repetitions]);
run("ywasm lifecycle", [script("lifecycle-benchmark.mjs"), "ywasm", updates, repetitions]);

const cycles = mode === "release" ? "10000" : "250";
const fixtureKib = process.env.YAOS_YWASM_SOAK_FIXTURE_KIB ?? (mode === "release" ? "1024" : "64");
run("Yjs multi-shard memory baseline", ["--expose-gc", script("memory-soak.mjs"), "yjs", cycles, "8", fixtureKib]);
run("ywasm disposal and multi-shard memory", ["--expose-gc", script("memory-soak.mjs"), "ywasm", cycles, "8", fixtureKib]);

const wasmPath = resolve(process.env.YAOS_YWASM_ARTIFACT
	?? "server/src/crdt/vendor/ywasm/ywasm_bg.wasm");
const wrapperPath = resolve(process.env.YAOS_YWASM_WRAPPER
	?? "server/src/crdt/vendor/ywasm/ywasm.mjs");
if (existsSync(wasmPath)) {
	const args = [script("inspect-artifact.mjs"), wasmPath];
	if (existsSync(wrapperPath)) args.push(wrapperPath);
	run("Wasm import/export, memory-limit, and bundle gate", args);
} else if (mode === "release") {
	throw new Error(`release artifact is missing: ${wasmPath}`);
} else {
	console.log(`\nSKIP artifact inspection (not built yet): ${wasmPath}`);
}

console.log(`\nywasm ${mode} QA passed.`);
