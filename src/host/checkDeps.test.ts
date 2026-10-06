import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error untyped .mjs script
import { checkSource, scanImports, checkTree } from "../../scripts/check-deps.mjs";

type Result = { errors: string[]; warnings: string[] };
const check = (file: string, text: string): Result => checkSource(file, text) as Result;

test("scanImports: type-only detection and import forms", () => {
	const r = scanImports(`
		import type { A } from "../core/types";
		import { type B, type C } from "../core/types";
		import { D, type E } from "./x";
		export type { F } from "./y";
		export { G } from "./z";
		import "./side";
		const m = await import("./dyn");
		// import { H } from "./commented";
	`) as { spec: string; typeOnly: boolean }[];
	assert.deepEqual(
		r.map((x) => [x.spec, x.typeOnly]),
		[["../core/types", true], ["../core/types", true], ["./x", false], ["./y", true], ["./z", false], ["./side", false], ["./dyn", false]],
	);
});

test("§k.2 rules", () => {
	assert.equal(check("core/a.ts", `import type { X } from "../ports/vault";`).errors.length, 0);
	assert.equal(check("core/a.ts", `import { X } from "../ports/vault";`).errors.length, 1, "core: runtime ports import");
	assert.equal(check("core/a.ts", `import * as Y from "yjs";`).errors.length, 1, "core: yjs");
	assert.equal(check("core/a.ts", `import { x } from "lib0/encoding";`).errors.length, 0);
	assert.equal(check("ports/workspace.ts", `import type * as Y from "yjs";`).errors.length, 0);
	assert.equal(check("ports/vault.ts", `import type * as Y from "yjs";`).errors.length, 1);
	assert.equal(check("protocol/workerTransport.ts", `import { Inbox } from "./inlineTransport";`).errors.length, 0);
	assert.equal(check("protocol/x.ts", `import { BUDGETS } from "../core/limits";`).errors.length, 1, "protocol: runtime core");
	assert.equal(check("engine/body/a.ts", `import { App } from "obsidian";`).errors.length, 1);
	assert.equal(check("engine/body/a.ts", `import { h } from "../../host/plugin";`).errors.length, 1);
	assert.equal(check("engine/body/a.ts", `const db = indexedDB.open("x");`).errors.length, 1, "browser global outside adapters");
	assert.equal(check("engine/adapters/idb.ts", `const db = indexedDB.open("x");`).errors.length, 0);
	assert.equal(check("engine/body/a.ts", `const s = "fetch(";`).errors.length, 0, "strings are ignored");
	assert.equal(check("host/plugin.ts", `import { createWebEngine } from "../engine/adapters/webEngine";`).errors.length, 0);
	assert.equal(check("host/engineHost.ts", `import { LogEngine } from "../engine/runtime/engine";`).errors.length, 1);
	assert.equal(check("host/engineHost.ts", `import { x } from "../engine/body/handles";`).errors.length, 1);
	assert.equal(check("host/plugin.ts", `import { createEngine } from "../engine/__standins__/engine";`).errors.length, 1, "stand-ins are gone");
	assert.equal(check("host/plugin.ts", `import src from "virtual:yaos-engine-worker";`).errors.length, 0);
	assert.equal(check("host/plugin.ts", `import { EditorView } from "@codemirror/view";`).errors.length, 0);
	assert.equal(check("host/plugin.ts", `import { readFile } from "node:fs";`).errors.length, 1);
	assert.equal(check("host/ui/pairModal.ts", `import { toCanvas } from "qrcode";`).errors.length, 0, "host: pairing QR");
	assert.equal(check("engine/a.ts", `import { toCanvas } from "qrcode";`).errors.length, 1, "engine: no qrcode");
	assert.equal(check("core/a.ts", `import { toCanvas } from "qrcode";`).errors.length, 1, "core: no qrcode");
	assert.equal(check("host/binding.ts", `import { SimVault } from "../sim/vault";`).errors.length, 1, "only tests import sim");
	assert.equal(check("host/binding.test.ts", `import { SimVault } from "../sim/vault";`).errors.length, 0);
	assert.equal(check("sim/run.ts", `import { createEngine } from "../engine/runtime/engine";`).errors.length, 0);
	assert.equal(check("host/a.ts", `import { x } from "../../server/src/version";`).errors.length, 1, "product code stays inside src/");
	assert.equal(check("engine/a.ts", `import init from "ywasm";`).errors.length, 1);
	assert.equal(check("engine/a.ts", `WebAssembly.instantiate(b)`).errors.length, 1);
});

test("the tree passes", () => {
	const r = checkTree() as { files: number; errors: string[]; warnings: string[] };
	assert.deepEqual(r.errors, []);
	assert.deepEqual(r.warnings, []);
	assert.ok(r.files > 10);
});
