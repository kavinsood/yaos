import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
	canvasToMergeText, formatCanvasText, parseCanvasText, rankCanvasInFileOrder, type CanvasRanked,
} from "../../core/hash/canvasCanonical";
import { canvasHashRef, refHashPort as H } from "../../core/hash/testkit/hashRef";
import { utf8Encode } from "../../core/hash/utf8";
import { DEFAULT_MERGE_LIMITS } from "../../core/merge/merge";
import { applyCanvas, canvasDocHashInput, emptyCanvas, projectCanvasBytes, projectionHash, projectRanked, readCanvas, type CanvasProjection } from "./canvasDoc";
import { mergeCanvasSides, parseDiskCanvas, parseMergeText } from "./canvasMerge";

type Obj = Record<string, unknown>;
const textNode = (id: string, text: string, x = 0): Obj => ({ id, type: "text", text, x, y: 0, width: 100, height: 50 });
const fileNode = (id: string, file: string, x = 0): Obj => ({ id, type: "file", file, x, y: 0, width: 100, height: 50 });
const edge = (id: string, fromNode: string, toNode: string): Obj => ({ id, fromNode, toNode });
const canvasJson = (nodes: Obj[], edges: Obj[] = [], extra: Obj = {}): string => JSON.stringify({ nodes, edges, ...extra }, null, "\t");

function ranked(json: string): CanvasRanked {
	const p = parseCanvasText(json);
	assert.equal(p.kind, "valid", json);
	if (p.kind !== "valid") throw new Error("unreachable");
	return rankCanvasInFileOrder(p.data);
}

function docOf(json: string): Y.Doc {
	const d = new Y.Doc();
	applyCanvas(d, null, ranked(json));
	return d;
}

function project(d: Y.Doc): CanvasProjection {
	const p = projectCanvasBytes(d);
	assert.ok(p.ok, JSON.stringify(p));
	return p;
}

const nodeMap = (d: Y.Doc, id: string): Y.Map<unknown> => d.getMap<unknown>("nodes").get(id) as Y.Map<unknown>;

test("canvasDoc: apply onto an empty doc, read back, project = formatted file in rank order", async () => {
	const json = canvasJson([textNode("a", "hello"), fileNode("b", "x.md")], [edge("e1", "a", "b")], { meta: { v: 1 } });
	const d = docOf(json);
	const a = nodeMap(d, "a");
	assert.ok(a.get("text") instanceof Y.Text, "a text node's text is a Y.Text");
	assert.equal(typeof a.get("rank"), "string");
	assert.equal(a.has("id"), false, "the id is the key, never a field");
	assert.equal(nodeMap(d, "b").get("file"), "x.md");
	assert.equal(typeof (d.getMap<unknown>("edges").get("e1") as Y.Map<unknown>).get("rank"), "string");
	assert.equal(JSON.stringify(d.getMap("doc").toJSON()), '{"meta":{"v":1}}');
	const p = project(d);
	assert.equal(p.text, formatCanvasText(ranked(json).data), "formatted (tab indent), file order preserved through the ranks");
	assert.deepEqual(JSON.parse(p.text), JSON.parse(json));
	assert.equal(await projectionHash(H, p), canvasHashRef(utf8Encode(json)));
	assert.deepEqual(canvasDocHashInput(d), p.hashInput);
	// Re-applying the same target changes nothing.
	assert.equal(applyCanvas(d, null, readCanvas(d).ok ? (readCanvas(d) as { ranked: CanvasRanked }).ranked : emptyCanvas()), 0);
});

test("canvasDoc: empty doc projects the empty canvas with the empty-content hash", async () => {
	const p = project(new Y.Doc());
	assert.equal(await projectionHash(H, p), canvasHashRef(new Uint8Array(0)));
	assert.equal(JSON.parse(p.text).nodes.length, 0);
});

test("canvasDoc: field edit sets one key on the same record map; text edit is a minimal Y.Text diff on the same instance", () => {
	const d = docOf(canvasJson([textNode("a", "hello world"), fileNode("b", "x.md")]));
	const a = nodeMap(d, "a");
	const t = a.get("text") as Y.Text;
	const deltas: unknown[] = [];
	t.observe((ev) => deltas.push(ev.delta));
	const target = ranked(canvasJson([textNode("a", "hello brave world"), fileNode("b", "x.md", 40)]));
	const r0 = readCanvas(d);
	assert.ok(r0.ok);
	// Keep the existing ranks (the merge always passes ranked targets).
	const keepRanks: CanvasRanked = { ...target, nodeRanks: r0.ranked.nodeRanks, edgeRanks: r0.ranked.edgeRanks };
	assert.equal(applyCanvas(d, null, keepRanks), 2, "one text diff + one field set");
	assert.equal(nodeMap(d, "a"), a, "record map not replaced");
	assert.equal(a.get("text"), t, "Y.Text not replaced");
	assert.equal(t.toString(), "hello brave world");
	assert.equal(JSON.stringify(deltas), JSON.stringify([[{ retain: 6 }, { insert: "brave " }]]));
	assert.equal(nodeMap(d, "b").get("x"), 40);
});

test("canvasDoc: removed records are deleted, new records get ranks, a type change drops the Y.Text", () => {
	const d = docOf(canvasJson([textNode("a", "A"), textNode("b", "B")], [edge("e", "a", "b")]));
	applyCanvas(d, null, ranked(canvasJson([fileNode("a", "f.md"), textNode("c", "C")])));
	const nodes = d.getMap<unknown>("nodes");
	assert.deepEqual([...nodes.keys()].sort(), ["a", "c"]);
	assert.equal(d.getMap("edges").size, 0);
	assert.equal(nodeMap(d, "a").has("text"), false);
	assert.equal(nodeMap(d, "a").get("type"), "file");
	assert.ok(nodeMap(d, "c").get("text") instanceof Y.Text);
	assert.equal(typeof nodeMap(d, "c").get("rank"), "string");
});

test("canvasDoc: dangling edges stay in the CRDT, are dropped from the projection, and survive an apply", () => {
	const d = docOf(canvasJson([textNode("a", "A"), textNode("b", "B")], [edge("e", "a", "b")]));
	d.getMap<unknown>("nodes").delete("b"); // a remote device deletes b, not its edge
	const r = readCanvas(d);
	assert.ok(r.ok);
	assert.equal(r.ranked.data.edges.size, 1, "the CRDT keeps the edge");
	const p = project(d);
	assert.equal(p.ranked.data.edges.size, 0);
	assert.equal(JSON.parse(p.text).edges.length, 0);
	applyCanvas(d, null, p.ranked);
	assert.equal(d.getMap("edges").has("e"), true, "an apply of the visible canvas keeps the dangling edge");
	// The node comes back: the edge is visible again.
	applyCanvas(d, null, ranked(canvasJson([textNode("a", "A"), textNode("b", "B")])));
	assert.equal(project(d).ranked.data.edges.size, 1);
});

test("canvasDoc: invalid CRDT content is reported, not projected", () => {
	const bad1 = docOf(canvasJson([textNode("a", "A")]));
	nodeMap(bad1, "a").set("type", "widget");
	assert.equal(projectCanvasBytes(bad1).ok, false);
	assert.equal(canvasDocHashInput(bad1), null);
	const bad2 = docOf(canvasJson([textNode("a", "A")]));
	nodeMap(bad2, "a").set("x", "12");
	assert.equal(projectCanvasBytes(bad2).ok, false);
	const bad3 = new Y.Doc();
	bad3.getMap("doc").set("nodes", []);
	assert.equal(projectCanvasBytes(bad3).ok, false);
});

test("canvasMerge: disk validation (unknown type, rank field, dangling edge, bad JSON)", () => {
	const ok = parseDiskCanvas(utf8Encode(canvasJson([textNode("a", "A")])));
	assert.equal(ok.ok, true);
	assert.equal(parseDiskCanvas(utf8Encode(canvasJson([{ ...textNode("a", "A"), type: "widget" }]))).ok, false);
	assert.equal(parseDiskCanvas(utf8Encode(canvasJson([{ ...textNode("a", "A"), rank: "m" }]))).ok, false);
	assert.equal(parseDiskCanvas(utf8Encode(canvasJson([textNode("a", "A")], [edge("e", "a", "zz")]))).ok, false);
	assert.equal(parseDiskCanvas(utf8Encode("{ nodes: ")).ok, false);
	assert.equal(parseDiskCanvas(utf8Encode(canvasJson([textNode("a", "A"), textNode("a", "B")]))).ok, false, "duplicate ids");
	assert.equal(parseMergeText('{"node":{"id":"a","type":"text","text":"","x":0,"y":0,"width":1,"height":1},"rank":"m"}\n{"doc":{}}\n') !== null, true);
});

// ---- mergeCanvasSides ------------------------------------------------------------

function sides(baseJson: string, diskJson: string, crdtEdit: (d: Y.Doc) => void) {
	const d = docOf(baseJson);
	const base = project(d).ranked;
	crdtEdit(d);
	const crdt = project(d);
	const disk = parseDiskCanvas(utf8Encode(diskJson));
	assert.ok(disk.ok);
	return { d, out: mergeCanvasSides({ base, disk: disk.data, crdt, limits: DEFAULT_MERGE_LIMITS }) };
}

const BASE = canvasJson([textNode("a", "A"), textNode("b", "B"), textNode("c", "C")], [edge("e", "a", "b")]);

test("canvasMerge: edits to different nodes merge cleanly", () => {
	const disk = canvasJson([textNode("a", "A disk"), textNode("b", "B"), textNode("c", "C")], [edge("e", "a", "b")]);
	const { d, out } = sides(BASE, disk, (doc) => nodeMap(doc, "c").set("x", 99));
	assert.equal(out.kind, "clean");
	applyCanvas(d, null, out.target);
	const j = JSON.parse(project(d).text);
	assert.equal(j.nodes[0].text, "A disk");
	assert.equal(j.nodes[2].x, 99);
});

test("canvasMerge: concurrent adds of different nodes and a disk edge merge", () => {
	const disk = canvasJson([textNode("a", "A"), textNode("b", "B"), textNode("c", "C"), textNode("d", "D")], [edge("e", "a", "b"), edge("e2", "c", "d")]);
	const crdtSide = ranked(canvasJson([textNode("a", "A"), textNode("b", "B"), textNode("c", "C"), textNode("x", "X")], [edge("e", "a", "b")]));
	const { out } = sides(BASE, disk, (doc) => {
		const r = readCanvas(doc);
		assert.ok(r.ok);
		applyCanvas(doc, null, { ...crdtSide, nodeRanks: new Map([...r.ranked.nodeRanks, ["x", "z"]]) });
	});
	assert.notEqual(out.kind, "conflict", JSON.stringify(out.reason));
	assert.deepEqual([...out.target.data.nodes.keys()].sort(), ["a", "b", "c", "d", "x"]);
	assert.deepEqual([...out.target.data.edges.keys()].sort(), ["e", "e2"]);
});

test("canvasMerge: edits to the same node conflict; target = CRDT side of that node + clean disk hunks", () => {
	const disk = canvasJson([textNode("a", "A disk"), textNode("b", "B"), textNode("c", "C disk")], [edge("e", "a", "b")]);
	const { out } = sides(BASE, disk, (doc) => {
		const t = nodeMap(doc, "a").get("text") as Y.Text;
		t.insert(1, " crdt");
	});
	assert.equal(out.kind, "conflict");
	assert.equal(out.reason, "both-edited");
	const nodes = out.target.data.nodes;
	assert.equal(JSON.stringify(nodes.get("a")!.payload), JSON.stringify({ type: "text" }));
	const txt = (id: string): unknown => JSON.parse(out.projection.text).nodes.find((n: Obj) => n.id === id)?.text;
	assert.equal(txt("a"), "A crdt");
	assert.equal(txt("c"), "C disk", "the clean disk hunk is kept");
});

test("canvasMerge: no base -> identical when equal (formatting ignored), else conflict(no-base) keeping the CRDT", () => {
	const d = docOf(BASE);
	const crdt = project(d);
	const same = parseDiskCanvas(utf8Encode(JSON.stringify(JSON.parse(BASE), null, 2)));
	assert.ok(same.ok);
	const r1 = mergeCanvasSides({ base: null, disk: same.data, crdt, limits: DEFAULT_MERGE_LIMITS });
	assert.equal(r1.kind, "identical");
	assert.deepEqual(r1.projection.hashInput, crdt.hashInput);
	const other = parseDiskCanvas(utf8Encode(canvasJson([textNode("q", "Q")])));
	assert.ok(other.ok);
	const r2 = mergeCanvasSides({ base: null, disk: other.data, crdt, limits: DEFAULT_MERGE_LIMITS });
	assert.equal(r2.kind, "conflict");
	assert.equal(r2.reason, "no-base");
	assert.equal(canvasToMergeText(r2.target), canvasToMergeText(crdt.ranked));
	const p = projectRanked(r2.target);
	assert.ok(p.ok);
	assert.deepEqual(p.hashInput, crdt.hashInput);
});
