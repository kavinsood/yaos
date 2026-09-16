import assert from "node:assert/strict";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import {
	applyCanvasSnapshot, createCanvasDocument, materializeCanvasDocument, validateCanvasDocument,
} from "../../server/src/crdt/canvasSemanticDocument";
import { validateFrontmatterSemanticRoots } from "../../server/src/crdt/frontmatterSemanticValidation";
import { parseCanvasBytes } from "../../server/src/shared/canvasCodec";
import type { CanvasSemanticData } from "../../server/src/shared/canvasTypes";
import { suite } from "../harness.ts";

const s = suite("ywasm-schema-helpers");

function canvas(): CanvasSemanticData {
	const parsed = parseCanvasBytes(new TextEncoder().encode(JSON.stringify({
		version: 1,
		nodes: [
			{ id: "text", type: "text", text: "中文 😀 e\u0301", x: 0, y: 0, width: 200, height: 80,
				future: { nested: ["kept", 1] } },
			{ id: "file", type: "file", file: "笔记.md", x: 300, y: 0, width: 240, height: 160 },
		],
		edges: [{ id: "edge", fromNode: "text", toNode: "file", label: "🌍" }],
	})));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") throw new Error("invalid Canvas fixture");
	return parsed.data;
}

s.test("server Canvas helpers materialize, update, validate, and preserve nested shared types", async () => {
	const doc = createCanvasDocument(canvas());
	try {
		assert.equal(await validateCanvasDocument(doc), null);
		const updated = canvas();
		updated.nodes.get("text")!.text = "עברית 👩🏾‍💻";
		updated.nodes.get("text")!.position = { x: 12, y: 34 };
		updated.nodes.get("text")!.extensions.added = { deep: [true, "值"] };
		await applyCanvasSnapshot(doc, updated, "schema-helper-update", undefined, 123);
		const materialized = await materializeCanvasDocument(doc, false);
		assert.equal(materialized.nodes.get("text")?.text, "עברית 👩🏾‍💻");
		assert.deepEqual(materialized.nodes.get("text")?.position, { x: 12, y: 34 });
		assert.deepEqual(materialized.nodes.get("text")?.extensions.added, { deep: [true, "值"] });
		assert.equal(await validateCanvasDocument(doc), null);
	} finally {
		crdtEngine.destroyDocument(doc);
	}
});

s.test("server Canvas batches preserve independent concurrent move and resize groups", async () => {
	const first = createCanvasDocument(canvas());
	const second = crdtEngine.openDocument("canvas-concurrent", crdtEngine.encodeStateAsUpdate(first));
	try {
		const moved = canvas();
		moved.nodes.get("text")!.position = { x: 90, y: 80 };
		const resized = canvas();
		resized.nodes.get("text")!.size = { width: 640, height: 480 };
		await applyCanvasSnapshot(first, moved, "move");
		await applyCanvasSnapshot(second, resized, "resize");
		const firstUpdate = crdtEngine.encodeStateAsUpdate(first);
		const secondUpdate = crdtEngine.encodeStateAsUpdate(second);
		crdtEngine.applyUpdate(first, secondUpdate, "merge-resize");
		crdtEngine.applyUpdate(second, firstUpdate, "merge-move");
		for (const doc of [first, second]) {
			const materialized = await materializeCanvasDocument(doc, false);
			assert.deepEqual(materialized.nodes.get("text")?.position, { x: 90, y: 80 });
			assert.deepEqual(materialized.nodes.get("text")?.size, { width: 640, height: 480 });
			assert.equal(await validateCanvasDocument(doc), null);
		}
	} finally {
		crdtEngine.destroyDocument(first);
		crdtEngine.destroyDocument(second);
	}
});

s.test("server frontmatter validator accepts canonical roots and rejects an unexpected root", () => {
	const doc = crdtEngine.createDocument("frontmatter-validation");
	try {
		crdtEngine.applyRootOperations(doc, [
			{ kind: "map-set", root: "frontmatter:meta", key: "format", value: { shared: "value", value: 1 } },
			{ kind: "map-set", root: "frontmatter:registers", key: "title", value: { shared: "value", value: {
				kind: "value", key: "Title", value: "你好 😀",
			} } },
			{ kind: "map-set", root: "frontmatter:presence", key: "aliases", value: { shared: "value", value: {
				present: true, key: "Aliases",
			} } },
			{ kind: "array-replace", root: "frontmatter:ordered:aliases", values: [
				{ shared: "value", value: "别名" }, { shared: "value", value: "🌍" },
			] },
		], "frontmatter-fixture");
		assert.equal(validateFrontmatterSemanticRoots(doc), null);
		crdtEngine.applyRootOperations(doc, [{
			kind: "map-set", root: "frontmatter:unknown", key: "bad", value: { shared: "value", value: true },
		}], "invalid-root");
		assert.equal(validateFrontmatterSemanticRoots(doc), "frontmatter_semantic_root_invalid");
	} finally {
		crdtEngine.destroyDocument(doc);
	}
});

await s.done();
