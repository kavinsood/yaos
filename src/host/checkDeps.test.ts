import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error untyped .mjs script
import { checkSource, scanImports, checkTree, mainReach } from "../../scripts/check-deps.mjs";

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
	assert.equal(check("ports/workspace.ts", `import type * as Y from "yjs";`).errors.length, 1, "ports: no CRDT types");
	assert.equal(check("ports/workspace.ts", `import type { ChangeSet, Text } from "@codemirror/state";`).errors.length, 0);
	assert.equal(check("ports/vault.ts", `import type { Text } from "@codemirror/state";`).errors.length, 1);
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
	assert.equal(check("host/plugin.ts", `import src from "virtual:yaos-engine-worker";`).errors.length, 1, "the worker string module is gone (D2)");
	assert.equal(check("host/entry.ts", `const w = require("../engine/workerMain");`).errors.length, 0, "the bundle entry starts the worker engine");
	assert.equal(check("host/plugin.ts", `const w = require("../engine/workerMain");`).errors.length, 1, "only the bundle entry");
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

test("no CRDT on the main thread: host/** never imports yjs, y-codemirror.next, y-protocols or lib0", () => {
	for (const spec of ["yjs", "y-codemirror.next", "y-protocols/awareness", "lib0/encoding"]) {
		assert.equal(check("host/binding.ts", `import * as M from "${spec}";`).errors.length, 1, spec);
		assert.equal(check("host/collab.ts", `import type { X } from "${spec}";`).errors.length, 1, `${spec} type-only`);
		assert.equal(check("host/binding.test.ts", `import * as M from "${spec}";`).errors.length, 1, `${spec} in a host test`);
		assert.equal(check("engine/body/a.ts", `import * as M from "${spec}";`).errors.length, spec.startsWith("y-") ? 1 : 0, `engine ${spec}`);
	}
	const reach = (files: Record<string, string>) => mainReach(new Map(Object.entries(files))) as string[];
	const viaCore = reach({
		"host/a.ts": `import { f } from "../core/b";`,
		"core/b.ts": `import { g } from "./c";`,
		"core/c.ts": `import { writeVarUint } from "lib0/encoding";`,
	});
	assert.equal(viaCore.length, 1);
	assert.match(viaCore[0] ?? "", /host\/a\.ts.*lib0\/encoding via host\/a\.ts -> core\/b\.ts -> core\/c\.ts/);
	const viaEntry = reach({
		"host/plugin.ts": `import { createWebEngine } from "../engine/adapters/webEngine";`,
		"engine/adapters/webEngine.ts": `import * as Y from "yjs";`,
	});
	assert.deepEqual(viaEntry, [], "the inline-fallback engine entry is the documented exception (D2)");
	assert.equal(check("host/plugin.ts", `import { probe } from "./spike/viewProbe";`).errors.length, 1, "the spike plugin stays out of the product");
});

test("no hashing on the main thread: product host/** never imports or reaches core/hash/**", () => {
	for (const spec of ["../core/hash/sha256", "../core/hash/utf8", "../core/hash/markdownLf"]) {
		assert.equal(check("host/plugin.ts", `import { f } from "${spec}";`).errors.length, 1, spec);
		assert.equal(check("host/plugin.ts", `import type { T } from "${spec}";`).errors.length, 1, `${spec} type-only`);
		assert.equal(check("host/plugin.test.ts", `import { f } from "${spec}";`).errors.length, 0, `${spec} in a host test (expected values)`);
	}
	assert.equal(check("host/keys/secretStore.ts", `import { sha256Hex } from "../../core/hash/sha256";`).errors.length, 1);
	assert.equal(check("host/keys/secretStore.ts", `import { bytesToHex } from "../../core/codec/lib0";`).errors.length, 0, "hex is not hashing");
	assert.equal(check("engine/body/a.ts", `import { sha256 } from "../../core/hash/sha256";`).errors.length, 0, "the engine hashes");
	const reach = (files: Record<string, string>) => mainReach(new Map(Object.entries(files))) as string[];
	const viaCore = reach({
		"host/a.ts": `import { f } from "../core/b";`,
		"core/b.ts": `import { g } from "./hash/sha256";`,
		"core/hash/sha256.ts": `export const g = 1;`,
	});
	assert.equal(viaCore.length, 1);
	assert.match(viaCore[0] ?? "", /host\/a\.ts.*core\/hash\/sha256 via host\/a\.ts -> core\/b\.ts/);
	assert.deepEqual(reach({ "host/a.test.ts": `import { f } from "../core/b";`, "core/b.ts": `import { g } from "./hash/sha256";`, "core/hash/sha256.ts": "" }), [], "tests are not the main thread");
});

test("whole-document reads on main: only the allowlisted ones", () => {
	const reads = [
		"const s = editor.getValue();",
		"const s = view.state.doc.toString();",
		"const s = view.state.sliceDoc(0);",
		"const s = binding.doc().sliceString(0, 10);",
		"const s = view.getViewData();",
		"const t = Text.of(s.split(\"\\n\"));",
	];
	for (const r of reads) {
		assert.equal(check("host/obsidianWorkspace.ts", r).errors.length, 1, r);
		assert.equal(check("host/obsidianWorkspace.test.ts", r).errors.length, 0, `tests may read: ${r}`);
		assert.equal(check("host/spike/viewProbe.ts", r).errors.length, 0, `spike plugin: ${r}`);
	}
	assert.equal(check("host/binding.ts", "t.sliceString(a, b)").errors.length, 0, "the chunked bind upload");
	assert.equal(check("host/binding.ts", "t.sliceString(a, b); u.sliceString(0)").errors.length, 1, "one more than allowed");
	assert.equal(check("host/binding.ts", "// editor.getValue() in a comment\nconst s = \"x.getValue()\";").errors.length, 0);
});
