import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { DocId, VaultPath } from "../../core/types";
import { parseCanvasText, rankCanvasInFileOrder } from "../../core/hash/canvasCanonical";
import { canvasHashRef } from "../../core/hash/testkit/hashRef";
import { applyCanvas, readCanvas } from "./canvasDoc";
import { assertConverged, crashPoints, label, runCrashed } from "./testkit/crash";
import { World } from "./testkit/world";

type Obj = Record<string, unknown>;
const P = (s: string): VaultPath => s as VaultPath;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const textNode = (id: string, text: string, x = 0): Obj => ({ id, type: "text", text, x, y: 0, width: 100, height: 50 });
const fileNode = (id: string, file: string, x = 0): Obj => ({ id, type: "file", file, x, y: 0, width: 100, height: 50 });
const edge = (id: string, fromNode: string, toNode: string): Obj => ({ id, fromNode, toNode });
const canvas = (nodes: Obj[], edges: Obj[] = [], indent: string | number = "\t"): string => JSON.stringify({ nodes, edges }, null, indent);
const BOARD = canvas([textNode("a", "Alpha"), textNode("b", "Beta"), fileNode("c", "notes/c.md")], [edge("e1", "a", "b")]);

async function booted(): Promise<World> {
	const w = new World();
	await w.boot();
	return w;
}

/** Parsed disk file (null = missing / invalid JSON). */
function disk(w: World, path: string): { nodes: Obj[]; edges: Obj[] } | null {
	const t = w.vault.text(path);
	if (t === null) return null;
	try {
		return JSON.parse(t) as { nodes: Obj[]; edges: Obj[] };
	} catch {
		return null;
	}
}
const nodeOf = (j: { nodes: Obj[] } | null, id: string): Obj | undefined => j?.nodes.find((n) => n.id === id);
const nodeMap = (doc: Y.Doc, id: string): Y.Map<unknown> => doc.getMap<unknown>("nodes").get(id) as Y.Map<unknown>;
const writes = (w: World): number => w.gateway.executed.filter((o) => o.t === "write").length;
const sameLogical = (w: World, path: string, id: DocId): void =>
	assert.equal(canvasHashRef(w.vault.bytesOf(path)!), canvasHashRef(enc(w.log.canvasText(id)!)), `${path}: disk != CRDT`);

/** Remote device: set a node's text (minimal Y.Text edit at the end). */
function remoteText(w: World, id: DocId, node: string, append: string): void {
	w.log.remoteEditCanvas(id, (d) => (nodeMap(d, node).get("text") as Y.Text).insert((nodeMap(d, node).get("text") as Y.Text).length, append));
}

async function withBoard(): Promise<{ w: World; id: DocId }> {
	const w = await booted();
	const id = w.log.remoteCreate(P("board.canvas"), BOARD);
	await w.sync();
	return { w, id };
}

test("canvas: local create uploads records (Y.Text for text nodes, ranks), the file is never rewritten, steady state", async () => {
	const w = new World();
	const local = canvas([textNode("a", "Alpha"), fileNode("c", "c.md")], [edge("e1", "a", "c")], 2);
	w.vault.userWrite("board.canvas", local);
	await w.boot();
	await w.sync();
	const id = w.log.liveByPath(P("board.canvas"));
	assert.ok(id);
	assert.equal(w.log.entry(id)!.kind, "canvas");
	const doc = w.log.canvasDoc(id);
	assert.ok(nodeMap(doc, "a").get("text") instanceof Y.Text);
	assert.equal(typeof nodeMap(doc, "a").get("rank"), "string");
	assert.equal(typeof (doc.getMap<unknown>("edges").get("e1") as Y.Map<unknown>).get("rank"), "string");
	assert.ok(w.log.frames.some((f) => f.docId === id), "body frames committed");
	assert.equal(w.vault.text("board.canvas"), local, "2-space file not rewritten (same logical content)");
	assert.equal(w.synced(id)?.contentHash, canvasHashRef(enc(local)));
	assert.equal(w.synced(id)?.hasBase, true);
	const m = w.gateway.mutations;
	const f = w.log.frames.length;
	await w.sync();
	assert.equal(w.gateway.mutations, m);
	assert.equal(w.log.frames.length, f);
	assert.equal(w.log.submitted.length, 1);
});

test("canvas: remote create materializes (also the empty canvas)", async () => {
	const w = await booted();
	const id = w.log.remoteCreate(P("b/board.canvas"), BOARD);
	const empty = w.log.remoteCreate(P("empty.canvas"), canvas([]));
	await w.sync();
	assert.deepEqual(disk(w, "b/board.canvas"), JSON.parse(BOARD));
	assert.equal(w.vault.text("b/board.canvas"), w.log.canvasText(id));
	assert.deepEqual(disk(w, "empty.canvas"), { nodes: [], edges: [] });
	assert.equal(w.synced(id)?.kind, "canvas");
	assert.equal(w.synced(empty)?.contentHash, canvasHashRef(new Uint8Array(0)), "empty canvas = empty content hash");
	assert.equal(w.r.scan.dirty.size, 0, "own writes are echoes");
	assert.equal(w.log.submitted.length, 0);
	await assertConverged(w, "remote create");
});

test("canvas: remote edit is projected to disk (record-level)", async () => {
	const { w, id } = await withBoard();
	remoteText(w, id, "a", " v2");
	w.log.remoteEditCanvas(id, (d) => nodeMap(d, "c").set("x", 300));
	await w.sync();
	const j = disk(w, "board.canvas");
	assert.equal(nodeOf(j, "a")?.text, "Alpha v2");
	assert.equal(nodeOf(j, "c")?.x, 300);
	assert.deepEqual(w.conflictCopies(), []);
	await assertConverged(w, "remote edit");
});

test("canvas: concurrent edits to different nodes merge", async () => {
	const { w, id } = await withBoard();
	remoteText(w, id, "a", " remote");
	w.vault.userWrite("board.canvas", canvas([textNode("a", "Alpha"), textNode("b", "Beta", 77), fileNode("c", "notes/c.md")], [edge("e1", "a", "b")]));
	await w.sync();
	const j = disk(w, "board.canvas");
	assert.equal(nodeOf(j, "a")?.text, "Alpha remote");
	assert.equal(nodeOf(j, "b")?.x, 77);
	assert.deepEqual(w.conflictCopies(), []);
	sameLogical(w, "board.canvas", id);
	await assertConverged(w, "different nodes");
});

test("canvas: concurrent adds of different nodes merge", async () => {
	const { w, id } = await withBoard();
	w.log.remoteEditCanvas(id, (d) => {
		const r = readCanvas(d);
		assert.ok(r.ok);
		const m = new Y.Map<unknown>();
		d.getMap<unknown>("nodes").set("r", m);
		for (const [k, v] of Object.entries({ type: "file", file: "r.md", x: 5, y: 5, width: 10, height: 10, rank: "zz" })) m.set(k, v);
	});
	w.vault.userWrite("board.canvas", canvas([textNode("a", "Alpha"), textNode("b", "Beta"), fileNode("c", "notes/c.md"), textNode("l", "Local")], [edge("e1", "a", "b"), edge("e2", "a", "l")]));
	await w.sync();
	const j = disk(w, "board.canvas")!;
	assert.deepEqual(j.nodes.map((n) => n.id).sort(), ["a", "b", "c", "l", "r"]);
	assert.deepEqual(j.edges.map((e) => e.id).sort(), ["e1", "e2"]);
	assert.deepEqual(w.conflictCopies(), []);
	sameLogical(w, "board.canvas", id);
	await assertConverged(w, "adds");
});

test("canvas: same-node conflict keeps the CRDT side, copies the exact disk bytes, the copy syncs as a new canvas", async () => {
	const { w, id } = await withBoard();
	remoteText(w, id, "a", " remote");
	const local = canvas([textNode("a", "Alpha local"), textNode("b", "Beta"), fileNode("c", "notes/c.md")], [edge("e1", "a", "b")], 1);
	w.vault.userWrite("board.canvas", local);
	await w.sync();
	const copies = w.conflictCopies();
	assert.equal(copies.length, 1);
	assert.match(copies[0]!, /^board \(conflict laptop \d{4}-\d{2}-\d{2} \d{4}\)\.canvas$/);
	assert.equal(w.vault.text(copies[0]!), local, "exact original bytes");
	assert.equal(nodeOf(disk(w, "board.canvas"), "a")?.text, "Alpha remote");
	sameLogical(w, "board.canvas", id);
	const copyId = w.log.liveByPath(P(copies[0]!));
	assert.ok(copyId);
	assert.equal(w.log.entry(copyId)!.kind, "canvas");
	assert.equal(nodeOf(JSON.parse(w.log.canvasText(copyId)!), "a")?.text, "Alpha local");
	assert.equal(w.intents(), 0);
	assert.ok(w.r.ctx.window().conflict >= 1);
	await assertConverged(w, "conflict");
	assert.equal(w.conflictCopies().length, 1);
});

test("canvas: a disk edit of a text node is a minimal (token) diff on the same Y.Text", async () => {
	const { w, id } = await withBoard();
	const doc = w.log.canvasDoc(id); // the resident replica
	const t = nodeMap(doc, "a").get("text") as Y.Text;
	const deltas: unknown[] = [];
	t.observe((ev) => deltas.push(ev.delta));
	w.vault.userWrite("board.canvas", canvas([textNode("a", "Alpha and omega"), textNode("b", "Beta"), fileNode("c", "notes/c.md")], [edge("e1", "a", "b")]));
	await w.sync();
	assert.equal(nodeMap(w.log.canvasDoc(id), "a").get("text"), t, "same Y.Text instance");
	assert.equal(t.toString(), "Alpha and omega");
	assert.equal(JSON.stringify(deltas), JSON.stringify([[{ retain: 5 }, { insert: " and omega" }]]));
	assert.equal(nodeOf(JSON.parse(w.log.canvasText(id)!), "a")?.text, "Alpha and omega");
});

test("canvas: node deletes in both directions", async () => {
	const { w, id } = await withBoard();
	w.vault.userWrite("board.canvas", canvas([textNode("a", "Alpha"), textNode("b", "Beta")], [edge("e1", "a", "b")]));
	await w.sync();
	assert.equal(w.log.canvasDoc(id).getMap("nodes").has("c"), false, "disk delete removes the record");
	w.log.remoteEditCanvas(id, (d) => d.getMap("nodes").delete("a"));
	await w.sync();
	const j = disk(w, "board.canvas")!;
	assert.deepEqual(j.nodes.map((n) => n.id), ["b"]);
	assert.deepEqual(j.edges, [], "the edge to the deleted node is not projected");
	assert.equal(w.log.canvasDoc(id).getMap("edges").has("e1"), true, "the dangling edge stays in the CRDT");
	await assertConverged(w, "deletes");
});

test("canvas: invalid disk canvas -> canvas-invalid notice, no write, CRDT unchanged; fixing the file resumes sync", async () => {
	const { w, id } = await withBoard();
	const before = w.log.canvasText(id);
	for (const bad of ['{"nodes": [', canvas([{ ...textNode("a", "A"), type: "widget" }]), canvas([{ ...textNode("a", "A"), x: "1" }])]) {
		w.vault.userWrite("board.canvas", bad);
		const n = writes(w);
		await w.sync();
		assert.equal(w.vault.text("board.canvas"), bad, "file left alone");
		assert.equal(writes(w), n);
		assert.equal(w.log.canvasText(id), before, "CRDT unchanged");
	}
	assert.ok(w.notices.some((x) => x.code === "canvas-invalid"), JSON.stringify(w.notices));
	assert.deepEqual(w.conflictCopies(), []);
	w.vault.userWrite("board.canvas", canvas([textNode("a", "Alpha fixed"), textNode("b", "Beta"), fileNode("c", "notes/c.md")], [edge("e1", "a", "b")]));
	await w.sync();
	assert.equal(nodeOf(JSON.parse(w.log.canvasText(id)!), "a")?.text, "Alpha fixed");
	await assertConverged(w, "fixed");
});

test("canvas: invalid CRDT content from a remote device is not projected", async () => {
	const { w, id } = await withBoard();
	const before = w.vault.text("board.canvas");
	w.log.remoteEditCanvas(id, (d) => nodeMap(d, "b").set("type", "widget"));
	await w.sync();
	assert.equal(w.vault.text("board.canvas"), before);
	assert.ok(w.notices.some((x) => x.code === "canvas-invalid"));
});

test("canvas: dangling edge from a remote node delete is dropped on disk, kept in the CRDT through a later merge", async () => {
	const { w, id } = await withBoard();
	w.log.remoteEditCanvas(id, (d) => d.getMap("nodes").delete("b"));
	await w.sync();
	assert.deepEqual(disk(w, "board.canvas")!.edges, []);
	w.vault.userWrite("board.canvas", canvas([textNode("a", "Alpha local"), fileNode("c", "notes/c.md")]));
	await w.sync();
	const r = readCanvas(w.log.canvasDoc(id));
	assert.ok(r.ok);
	assert.equal(r.ranked.data.edges.has("e1"), true, "CRDT keeps the dangling edge");
	assert.equal(nodeOf(disk(w, "board.canvas"), "a")?.text, "Alpha local");
	// The node comes back remotely: the edge is visible again.
	w.log.remoteEditCanvas(id, (d) => {
		const m = new Y.Map<unknown>();
		d.getMap<unknown>("nodes").set("b", m);
		for (const [k, v] of Object.entries({ type: "text", x: 0, y: 0, width: 1, height: 1, rank: "zz" })) m.set(k, v);
		m.set("text", new Y.Text("Beta back"));
	});
	await w.sync();
	assert.deepEqual(disk(w, "board.canvas")!.edges.map((e) => e.id), ["e1"]);
	await assertConverged(w, "dangling");
});

test("canvas: adopt without I/O when the local file has the CRDT's logical content (fresh state)", async () => {
	const w = new World();
	const id = w.log.remoteCreate(P("board.canvas"), BOARD);
	const local = JSON.stringify(JSON.parse(BOARD), null, 2); // same content, other formatting
	w.vault.userWrite("board.canvas", local);
	await w.boot();
	const n = writes(w);
	const f = w.log.frames.length;
	await w.sync();
	assert.equal(writes(w), n, "no disk write");
	assert.equal(w.log.frames.length, f, "no body frame");
	assert.equal(w.log.submitted.length, 0);
	assert.equal(w.vault.text("board.canvas"), local);
	assert.equal(w.synced(id)?.contentHash, canvasHashRef(enc(local)));
	assert.equal(w.synced(id)?.hasBase, true);
	assert.deepEqual(w.conflictCopies(), []);
	await assertConverged(w, "adopt");
});

test("canvas: a reformatted file is not a change (no write, no frame)", async () => {
	const { w } = await withBoard();
	w.vault.userWrite("board.canvas", JSON.stringify(JSON.parse(BOARD)));
	const n = writes(w);
	const f = w.log.frames.length;
	await w.sync();
	assert.equal(writes(w), n);
	assert.equal(w.log.frames.length, f);
	await assertConverged(w, "reformat");
});

test("canvas: remote-only body waits until caught up, then materializes; local-only edits upload without a disk write", async () => {
	const w = await booted();
	const id = w.log.remoteCreate(P("late.canvas"), BOARD);
	w.log.setCaughtUp(id, false);
	await w.sync();
	assert.equal(w.vault.has("late.canvas"), false, "not projected before the body is caught up");
	w.log.setCaughtUp(id, true);
	await w.sync();
	assert.deepEqual(disk(w, "late.canvas"), JSON.parse(BOARD));
	const edited = canvas([textNode("a", "Alpha"), textNode("b", "Beta 2"), fileNode("c", "notes/c.md")], [edge("e1", "a", "b")]);
	w.vault.userWrite("late.canvas", edited);
	const n = writes(w);
	await w.sync();
	assert.equal(writes(w), n);
	assert.equal(nodeOf(JSON.parse(w.log.canvasText(id)!), "b")?.text, "Beta 2");
	await assertConverged(w, "remote-only");
});

test("canvas: crash at every point of a same-node conflict merge converges with one copy", async () => {
	const local = canvas([textNode("a", "Alpha local"), textNode("b", "Beta"), fileNode("c", "notes/c.md")], [edge("e1", "a", "b")]);
	const make = async (): Promise<World> => {
		const w = new World();
		await w.boot();
		const id = w.log.remoteCreate(P("board.canvas"), BOARD, "doc-cv0000000000000000" as DocId);
		await w.sync();
		remoteText(w, id, "a", " remote");
		w.vault.userWrite("board.canvas", local);
		return w;
	};
	const { points, dry } = await crashPoints(make);
	assert.ok(points.length >= 6, `only ${points.length} crash points`);
	const failures: string[] = [];
	for (const [p, w] of [[null, dry] as const, ...await Promise.all(points.map(async (p) => [p, await runCrashed(make, p)] as const))]) {
		const where = p ? label(p) : "dry";
		try {
			const copies = w.conflictCopies();
			assert.equal(copies.length, 1, `copies ${JSON.stringify(copies)}`);
			assert.equal(w.vault.text(copies[0]!), local);
			assert.equal(nodeOf(disk(w, "board.canvas"), "a")?.text, "Alpha remote");
			await assertConverged(w, where);
		} catch (e) {
			failures.push(`${where}: ${(e as Error).message.split("\n")[0]}`);
		}
	}
	assert.deepEqual(failures, []);
});

test("canvas: remoteCreate seeds ranks in file order (testkit sanity)", () => {
	const p = parseCanvasText(BOARD);
	assert.equal(p.kind, "valid");
	if (p.kind !== "valid") return;
	const d = new Y.Doc();
	applyCanvas(d, null, rankCanvasInFileOrder(p.data));
	const r = readCanvas(d);
	assert.ok(r.ok);
	assert.deepEqual(r.ranked.data.nodeOrder, ["a", "b", "c"]);
});
