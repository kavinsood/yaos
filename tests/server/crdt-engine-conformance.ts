import assert from "node:assert/strict";
import * as Y from "yjs";
import type { CrdtEngine, CrdtRootOperation, CrdtValueSnapshot } from "../../server/src/crdt/crdtEngine";
import { yjsCrdtEngine } from "../../server/src/crdt/yjsCrdtEngine";
import {
	createYwasmCrdtEngine,
	type YwasmBindings,
	type YwasmCrdtDocument,
} from "../../server/src/crdt/ywasmCrdtEngine";
import {
	createCanvasDocument,
	materializeCanvasDocument,
	validateCanvasDocument,
} from "../../server/src/shared/canvasSemanticDocument";
import {
	canonicalCrdtRootDigestBytes,
	type DetachedCrdtRoot,
} from "../../server/src/shared/crdtRootDigest";
import { suite } from "../harness.ts";

const s = suite("crdt-engine-conformance");
const ywasmPackage = process.env.YAOS_YWASM_MODULE ?? "ywasm";
const bindings = await import(ywasmPackage) as unknown as YwasmBindings;
const ywasm = createYwasmCrdtEngine(bindings);

function withDocument<Doc extends { readonly engine: "yjs" | "ywasm"; readonly guid: string }, T>(
	engine: CrdtEngine<Doc>,
	guid: string,
	body: (doc: Doc) => T,
): T {
	const doc = engine.createDocument(guid);
	try {
		return body(doc);
	} finally {
		engine.destroyDocument(doc);
	}
}

s.test("Yjs updates open in ywasm and ywasm deltas apply back to Yjs", () => {
	const initial = withDocument(yjsCrdtEngine, "wire-cross-engine", (source) => {
		yjsCrdtEngine.insertText(source, "body", 0, "中文 👨‍👩‍👧‍👦 e\u0301 العربية");
		return yjsCrdtEngine.encodeStateAsUpdate(source);
	});
	const wasm = ywasm.openDocument("wire-cross-engine", initial);
	const oracle = yjsCrdtEngine.openDocument("wire-cross-engine", initial);
	try {
		assert.equal(ywasm.readText(wasm, "body"), yjsCrdtEngine.readText(oracle, "body"));
		const before = ywasm.encodeStateVector(wasm);
		ywasm.insertText(wasm, "body", 3, "🌍");
		ywasm.deleteText(wasm, "body", 0, 2);
		yjsCrdtEngine.applyUpdate(oracle, ywasm.encodeStateAsUpdate(wasm, before));
		assert.equal(ywasm.readText(wasm, "body"), yjsCrdtEngine.readText(oracle, "body"));
	} finally {
		ywasm.destroyDocument(wasm);
		yjsCrdtEngine.destroyDocument(oracle);
	}
});

s.test("UTF-16 indexes preserve emoji, ZWJ, CJK, combining marks, and RTL text", () => {
	for (const engine of [yjsCrdtEngine, ywasm] as const) {
		const doc = engine.createDocument(`utf16-${engine.name}`);
		try {
			engine.insertText(doc as never, "body", 0, "A😀中文e\u0301👩🏾‍💻עברית");
			engine.insertText(doc as never, "body", 3, "🌍");
			engine.deleteText(doc as never, "body", 1, 2);
			assert.equal(engine.readText(doc as never, "body"), "A🌍中文e\u0301👩🏾‍💻עברית");
		} finally {
			engine.destroyDocument(doc as never);
		}
	}
});

s.test("merge and state-vector catch-up are wire-compatible", () => {
	const source = ywasm.createDocument("merge-source");
	const target = yjsCrdtEngine.createDocument("merge-source");
	try {
		const emptyVector = ywasm.encodeStateVector(source);
		ywasm.insertText(source, "body", 0, "one");
		const first = ywasm.encodeStateAsUpdate(source, emptyVector);
		const firstVector = ywasm.encodeStateVector(source);
		ywasm.insertText(source, "body", 3, "-two-中文");
		const second = ywasm.encodeStateAsUpdate(source, firstVector);
		yjsCrdtEngine.applyUpdate(target, ywasm.mergeUpdates([first, second]));
		assert.equal(yjsCrdtEngine.readText(target, "body"), "one-two-中文");

		const peer = ywasm.openDocument("merge-source", first);
		try {
			const catchup = yjsCrdtEngine.encodeStateAsUpdate(target, ywasm.encodeStateVector(peer));
			ywasm.applyUpdate(peer, catchup);
			assert.equal(ywasm.readText(peer, "body"), yjsCrdtEngine.readText(target, "body"));
		} finally {
			ywasm.destroyDocument(peer);
		}
	} finally {
		ywasm.destroyDocument(source);
		yjsCrdtEngine.destroyDocument(target);
	}
});

s.test("Canvas and root schemas survive a ywasm checkpoint round trip", async () => {
	const canvas = createCanvasDocument({
		rootFields: { theme: "dark", viewport: { x: 12, y: 34 } },
		nodes: new Map([[
			"node-1",
			{
				id: "node-1",
				payload: { type: "text" },
				position: { x: 10, y: 20 },
				size: { width: 300, height: 160 },
				text: "中文 canvas 🌍",
				extensions: {},
			},
		]]),
		nodeOrder: ["node-1"],
		edges: new Map(),
		edgeOrder: [],
	});
	const root = new Y.Doc({ guid: "root-schema" });
	root.getMap("sys").set("schemaVersion", 10);
	root.getMap("catalog").set("body-1", { path: "中文/🌍.md", lifecycle: "active" });
	root.getMap("__yaosLifecycle").set("operation-1", { kind: "rename", resultPath: "中文.md" });
	try {
		for (const [name, source] of [["canvas", canvas], ["root", root]] as const) {
			const wasm = ywasm.openDocument(name, Y.encodeStateAsUpdate(source));
			const roundTrip = new Y.Doc({ guid: name });
			try {
				Y.applyUpdate(roundTrip, ywasm.encodeStateAsUpdate(wasm));
				if (name === "canvas") {
					assert.equal(await validateCanvasDocument(roundTrip), null);
					assert.deepEqual(await materializeCanvasDocument(roundTrip, false),
						await materializeCanvasDocument(canvas, false));
				} else {
					assert.deepEqual(roundTrip.getMap("sys").toJSON(), root.getMap("sys").toJSON());
					assert.deepEqual(roundTrip.getMap("catalog").toJSON(), root.getMap("catalog").toJSON());
					assert.deepEqual(roundTrip.getMap("__yaosLifecycle").toJSON(),
						root.getMap("__yaosLifecycle").toJSON());
				}
			} finally {
				roundTrip.destroy();
				ywasm.destroyDocument(wasm);
			}
		}
	} finally {
		canvas.destroy();
		root.destroy();
	}
});

s.test("document ownership rejects cross-engine handles and use after destroy", () => {
	const ydoc = yjsCrdtEngine.createDocument("ownership-yjs");
	const wdoc = ywasm.createDocument("ownership-ywasm");
	assert.throws(() => yjsCrdtEngine.readText(wdoc as never, "body"), /another CRDT engine/);
	assert.throws(() => ywasm.readText(ydoc as never, "body"), /another CRDT engine/);
	yjsCrdtEngine.destroyDocument(ydoc);
	ywasm.destroyDocument(wdoc);
	assert.throws(() => yjsCrdtEngine.readText(ydoc, "body"), /destroyed/);
	assert.throws(() => ywasm.readText(wdoc, "body"), /destroyed/);
	// Destroy is deliberately idempotent at the adapter boundary.
	yjsCrdtEngine.destroyDocument(ydoc);
	ywasm.destroyDocument(wdoc);
});

s.test("invalid indexes fail before crossing the FFI boundary", () => {
	for (const engine of [yjsCrdtEngine, ywasm] as const) {
		const doc = engine.createDocument(`range-${engine.name}`);
		try {
			for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
				assert.throws(() => engine.insertText(doc as never, "body", invalid, "x"), RangeError);
				assert.throws(() => engine.deleteText(doc as never, "body", 0, invalid), RangeError);
			}
		} finally {
			engine.destroyDocument(doc as never);
		}
	}
});

s.test("corrupt input fails closed and a fresh document reconstructs from valid bytes", () => {
	const valid = withDocument(yjsCrdtEngine, "recovery-source", (source) => {
		yjsCrdtEngine.insertText(source, "body", 0, "durable state 🌍");
		return yjsCrdtEngine.encodeStateAsUpdate(source);
	});
	assert.throws(() => ywasm.openDocument("corrupt", valid.subarray(0, valid.byteLength - 1)));
	const recovered = ywasm.openDocument("recovered", valid);
	try {
		assert.equal(ywasm.readText(recovered, "body"), "durable state 🌍");
	} finally {
		ywasm.destroyDocument(recovered);
	}
});

s.test("census is real when patched and otherwise fails closed", () => {
	const doc = ywasm.createDocument("census");
	try {
		ywasm.insertText(doc, "body", 0, "discard me");
		ywasm.deleteText(doc, "body", 0, "discard me".length);
		if (process.env.YAOS_REQUIRE_PATCHED_YWASM === "1") {
			const stats = ywasm.documentStats(doc);
			assert.ok(stats.encodedStateBytes > 0);
			assert.ok(stats.totalStructs >= 1);
			assert.ok(stats.deletedStructs >= 1);
		} else {
			assert.throws(() => ywasm.documentStats(doc), /missing the required documentStats census patch/);
		}
	} finally {
		ywasm.destroyDocument(doc);
	}
});

s.test("artifact memory telemetry is surfaced without exposing the binding", () => {
	let bytes = 64 * 1_024;
	const instrumented = createYwasmCrdtEngine(bindings, {
		maximumLinearMemoryBytes: 128 * 1_024 * 1_024,
		artifactSha256: "a".repeat(64),
		memoryByteLength: () => bytes,
	});
	assert.deepEqual(instrumented.memoryDiagnostics(), {
		linearMemoryBytes: bytes,
		maximumLinearMemoryBytes: 128 * 1_024 * 1_024,
		artifactSha256: "a".repeat(64),
	});
	bytes *= 2;
	assert.equal(instrumented.memoryDiagnostics()?.linearMemoryBytes, 128 * 1_024);
});

s.test("deep schema snapshots and batched nested operations preserve map, array, and text types", () => {
	const operations: CrdtRootOperation[] = [{
		kind: "map-set", root: "nodes", key: "node-1", value: { shared: "map", entries: [
			["text", { shared: "text", value: "中文 😀" }],
			["tags", { shared: "array", values: [
				{ shared: "value", value: "one" }, { shared: "value", value: { nested: true } },
			] }],
			["extensions", { shared: "map", entries: [["theme", { shared: "value", value: "dark" }]] }],
		] },
	}, {
		kind: "text-replace", root: "nodes", path: ["node-1", "text"], value: "e\u0301 👩🏾‍💻 العربية",
	}, {
		kind: "array-replace", root: "nodes", path: ["node-1", "tags"], values: [
			{ shared: "value", value: "替换" }, { shared: "value", value: 42 },
		],
	}, {
		kind: "map-set", root: "nodes", path: ["node-1", "extensions"], key: "emoji",
		value: { shared: "value", value: "🌍" },
	}];
	const snapshots = [] as unknown[];
	for (const engine of [yjsCrdtEngine, ywasm] as const) {
		const doc = engine.createDocument(`schema-${engine.name}`);
		try {
			engine.applyRootOperations(doc as never, operations, "schema-test");
			snapshots.push(engine.snapshotRoots(doc as never));
		} finally {
			engine.destroyDocument(doc as never);
		}
	}
	assert.deepEqual(snapshots[1], snapshots[0]);
});

function reverseSnapshotOrder(value: CrdtValueSnapshot): CrdtValueSnapshot {
	if (value.shared === "array") {
		return { shared: "array", values: (value.values ?? []).map(reverseSnapshotOrder) };
	}
	if (value.shared === "map") {
		return {
			shared: "map",
			entries: [...(value.entries ?? [])].reverse()
				.map(([key, nested]) => [key, reverseSnapshotOrder(nested)]),
		};
	}
	return value;
}

s.test("canonical root identity is cross-engine and independent of root and map insertion order", () => {
	const forward: CrdtRootOperation[] = [{
		kind: "map-set", root: "sys", key: "schemaVersion", value: { shared: "value", value: 10 },
	}, {
		kind: "map-set", root: "sys", key: "capabilities", value: { shared: "value", value: {
			unicode: "中文 🌍", checkpoints: true, version: 3,
		} },
	}, {
		kind: "map-set", root: "catalog", key: "note-1", value: { shared: "map", entries: [
			["path", { shared: "value", value: "文档/😀.md" }],
			["lifecycle", { shared: "value", value: "active" }],
			["aliases", { shared: "array", values: [
				{ shared: "value", value: "first" },
				{ shared: "value", value: "第二" },
			] }],
		] },
	}, {
		kind: "map-set", root: "__yaosLifecycle", key: "rename-1", value: { shared: "map", entries: [
			["kind", { shared: "value", value: "rename" }],
			["resultPath", { shared: "value", value: "文档/renamed-🌍.md" }],
		] },
	}];
	const reverse: CrdtRootOperation[] = [...forward].reverse().map((operation) => {
		if (operation.kind !== "map-set") return operation;
		return { ...operation, value: reverseSnapshotOrder(operation.value) };
	});

	const yjs = yjsCrdtEngine.createDocument("canonical-root-yjs");
	const wasm = ywasm.createDocument("canonical-root-ywasm");
	try {
		yjsCrdtEngine.applyRootOperations(yjs, forward, "canonical-forward");
		ywasm.applyRootOperations(wasm, reverse, "canonical-reverse");

		const yjsRoots = yjsCrdtEngine.snapshotRoots(yjs);
		const wasmRoots = ywasm.snapshotRoots(wasm);
		assert.deepEqual(wasmRoots, yjsRoots, "both engines detach the same three semantic root maps");
		assert.equal(yjsRoots.length, 3);

		const yjsDigest = canonicalCrdtRootDigestBytes(yjsRoots);
		const deliberatelyReorderedWasmRoots: DetachedCrdtRoot[] = [...wasmRoots].reverse()
			.map(({ name, value }) => ({ name, value: reverseSnapshotOrder(value) }));
		const wasmDigest = canonicalCrdtRootDigestBytes(deliberatelyReorderedWasmRoots);
		assert.deepEqual(wasmDigest, yjsDigest,
			"canonical identity ignores root order, nested map order, and plain-object key order");

		const changedRoots = deliberatelyReorderedWasmRoots.map((root) => root.name === "sys"
			? { ...root, value: { shared: "map" as const, entries: [
				...(root.value.entries ?? []),
				["semanticChange", { shared: "value" as const, value: true }] as const,
			] } }
			: root);
		assert.notDeepEqual(canonicalCrdtRootDigestBytes(changedRoots), yjsDigest,
			"a semantic root change produces a different canonical identity");
	} finally {
		yjsCrdtEngine.destroyDocument(yjs);
		ywasm.destroyDocument(wasm);
	}
});

s.test("scoped text/transaction wrappers survive repeated allocation and disposal", () => {
	for (let index = 0; index < 250; index++) {
		const doc: YwasmCrdtDocument = ywasm.createDocument(`disposal-${index}`);
		try {
			ywasm.insertText(doc, "body", 0, `cycle-${index}-中文-😀`);
			assert.equal(ywasm.readText(doc, "body"), `cycle-${index}-中文-😀`);
			assert.ok(ywasm.encodeStateAsUpdate(doc).byteLength > 0);
		} finally {
			ywasm.destroyDocument(doc);
		}
	}
});

await s.done();
