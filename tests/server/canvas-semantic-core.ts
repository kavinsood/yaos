import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { parseCanvasBytes, canonicalCanvasBytes, canvasToJson } from "../../server/src/shared/canvasCodec";
import { mergeCanvasThreeWay } from "../../server/src/shared/canvasMerge";
import { reconcileCanvasRanks, orderedCanvasIds } from "../../server/src/shared/canvasOrdering";
import {
	applyCanvasSnapshot, createCanvasDocument, materializeCanvasDocument, validateCanvasDocument,
} from "../../server/src/shared/canvasSemanticDocument";
import type { CanvasSemanticData } from "../../server/src/shared/canvasTypes";
import { suite } from "../harness.ts";

const s = suite("canvas-semantic-core");
const encoder = new TextEncoder();

function parsed(json: unknown): CanvasSemanticData {
	const result = parseCanvasBytes(encoder.encode(JSON.stringify(json)));
	assert.equal(result.kind, "valid");
	if (result.kind !== "valid") throw new Error("Canvas fixture did not parse");
	return result.data;
}

function sample(): CanvasSemanticData {
	return parsed({
		version: 1,
		nodes: [
			{ id: "text", type: "text", text: "hello", x: 0, y: 0, width: 200, height: 80, future: { kept: true } },
			{ id: "file", type: "file", file: "Note.md", subpath: "#Part", x: 300, y: 0, width: 240, height: 160 },
		],
		edges: [{ id: "edge", fromNode: "text", toNode: "file", fromSide: "right", toSide: "left", futureEdge: 4 }],
	});
}

s.test("parses every semantic group and preserves unknown fields", () => {
	const data = sample();
	assert.equal(data.rootFields.version, 1);
	assert.equal((data.nodes.get("text")?.extensions.future as { kept?: boolean }).kept, true);
	assert.equal(data.edges.get("edge")?.extensions.futureEdge, 4);
	assert.deepEqual(data.nodeOrder, ["text", "file"]);
	const reparsed = parseCanvasBytes(canonicalCanvasBytes(data));
	assert.equal(reparsed.kind, "valid");
	if (reparsed.kind === "valid") assert.deepEqual(canvasToJson(reparsed.data), canvasToJson(data));
});

s.test("rejects malformed, duplicate, and dangling serialized data", () => {
	assert.equal(parseCanvasBytes(encoder.encode("{" )).kind, "invalid");
	assert.equal(parseCanvasBytes(encoder.encode(JSON.stringify({ nodes: [
		{ id: "same", type: "text", text: "a", x: 0, y: 0, width: 1, height: 1 },
		{ id: "same", type: "text", text: "b", x: 0, y: 0, width: 1, height: 1 },
	] }))).kind, "invalid");
	const dangling = parseCanvasBytes(encoder.encode(JSON.stringify({ nodes: [], edges: [
		{ id: "e", fromNode: "missing", toNode: "other" },
	] })));
	assert.deepEqual(dangling.kind === "invalid" && dangling.reason, "dangling_edge");
});

s.test("retains existing ranks across field-only edits and preserves explicit order", () => {
	const original = reconcileCanvasRanks(["a", "b", "c"], new Map()).ranks;
	const unchanged = reconcileCanvasRanks(["a", "b", "c"], original);
	assert.deepEqual(unchanged.ranks, original);
	const moved = reconcileCanvasRanks(["c", "a", "b", "d"], original);
	assert.deepEqual(orderedCanvasIds(moved.ranks, ["a", "b", "c", "d"]), ["c", "a", "b", "d"]);
});

s.test("Yjs merges move and resize without tearing either atomic group", async () => {
	const base = sample();
	const first = createCanvasDocument(base);
	const second = new Y.Doc();
	Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
	const moved = sample();
	moved.nodes.get("text")!.position = { x: 10, y: 20 };
	const resized = sample();
	resized.nodes.get("text")!.size = { width: 500, height: 300 };
	await applyCanvasSnapshot(first, moved, "move");
	await applyCanvasSnapshot(second, resized, "resize");
	const firstUpdate = Y.encodeStateAsUpdate(first);
	const secondUpdate = Y.encodeStateAsUpdate(second);
	Y.applyUpdate(first, secondUpdate);
	Y.applyUpdate(second, firstUpdate);
	const materialized = await materializeCanvasDocument(first);
	assert.deepEqual(materialized.nodes.get("text")?.position, { x: 10, y: 20 });
	assert.deepEqual(materialized.nodes.get("text")?.size, { width: 500, height: 300 });
	assert.equal(await validateCanvasDocument(first), null);
	assert.deepEqual(canvasToJson(await materializeCanvasDocument(second)), canvasToJson(materialized));
	first.destroy();
	second.destroy();
});

s.test("unchanged delete wins while a concurrent edit survives with resolution evidence", async () => {
	const source = createCanvasDocument(sample());
	const deleting = new Y.Doc();
	const editing = new Y.Doc();
	const seed = Y.encodeStateAsUpdate(source);
	Y.applyUpdate(deleting, seed);
	Y.applyUpdate(editing, seed);
	const deleted = sample();
	deleted.nodes.delete("text");
	deleted.nodeOrder = ["file"];
	deleted.edges.delete("edge");
	deleted.edgeOrder = [];
	await applyCanvasSnapshot(deleting, deleted, "delete-text", undefined, 1);
	assert.equal((await materializeCanvasDocument(deleting)).nodes.has("text"), false);
	const edited = sample();
	edited.nodes.get("text")!.text = "offline edit";
	await applyCanvasSnapshot(editing, edited, "edit-text", undefined, 2);
	Y.applyUpdate(deleting, Y.encodeStateAsUpdate(editing));
	Y.applyUpdate(editing, Y.encodeStateAsUpdate(deleting));
	const merged = await materializeCanvasDocument(deleting);
	assert.equal(merged.nodes.get("text")?.text, "offline edit");
	assert.equal(deleting.getMap("resolvedConflicts").size, 1);
	for (const doc of [source, deleting, editing]) doc.destroy();
});

s.test("internally retains dangling edges while omitting them from active Canvas bytes", async () => {
	const doc = createCanvasDocument(sample());
	const deleted = sample();
	deleted.nodes.delete("file");
	deleted.nodeOrder = ["text"];
	deleted.edges.delete("edge");
	deleted.edgeOrder = [];
	await applyCanvasSnapshot(doc, deleted, "delete-endpoint", undefined, 1);
	doc.getMap("edgeTombstones").delete("edge");
	const materialized = await materializeCanvasDocument(doc, false);
	assert.equal(doc.getMap("edges").has("edge"), true);
	assert.equal(materialized.edges.has("edge"), false);
	assert.equal(parseCanvasBytes(canonicalCanvasBytes(materialized)).kind, "valid");
	doc.destroy();
});

s.test("three-way merge combines groups, text and unknown keys while preserving conflicts", () => {
	const base = sample();
	const shared = sample();
	const local = sample();
	shared.nodes.get("text")!.position = { x: 50, y: 60 };
	shared.nodes.get("text")!.text = "hello shared";
	shared.nodes.get("text")!.extensions.shared = true;
	local.nodes.get("text")!.size = { width: 333, height: 111 };
	local.nodes.get("text")!.text = "local hello";
	local.nodes.get("text")!.extensions.local = true;
	const result = mergeCanvasThreeWay(base, shared, local);
	const node = result.data.nodes.get("text")!;
	assert.deepEqual(node.position, { x: 50, y: 60 });
	assert.deepEqual(node.size, { width: 333, height: 111 });
	assert.equal(node.text, "local hello shared");
	assert.equal(node.extensions.shared, true);
	assert.equal(node.extensions.local, true);
	assert.equal(result.conflicts.length, 0);

	const overlapLocal = sample();
	const overlapShared = sample();
	overlapLocal.nodes.get("text")!.position = { x: 1, y: 2 };
	overlapShared.nodes.get("text")!.position = { x: 3, y: 4 };
	const conflict = mergeCanvasThreeWay(base, overlapShared, overlapLocal);
	assert.deepEqual(conflict.data.nodes.get("text")?.position, { x: 3, y: 4 });
	assert.equal(conflict.conflicts.some((entry) => entry.field === "position"), true);
});

await s.done();
