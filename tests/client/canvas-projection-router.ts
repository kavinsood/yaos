import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import type { CanvasMergeConflict } from "../../server/src/shared/canvasTypes";
import type { CanvasProjectionPort } from "../../src/sync/canvas/canvasManager";
import { CanvasProjectionRouter } from "../../src/sync/canvas/canvasProjectionRouter";
import { suite } from "../harness.ts";

const s = suite("canvas-projection-router");
const encoder = new TextEncoder();

if (!("window" in globalThis)) Object.assign(globalThis, { window: globalThis });

function canvasBytes(text: string): Uint8Array {
	return encoder.encode(JSON.stringify({ nodes: [
		{ id: "n", type: "text", text, x: 0, y: 0, width: 100, height: 40 },
	], edges: [] }));
}

class Disk implements CanvasProjectionPort {
	files = new Map<string, Uint8Array>();
	writes: string[] = [];
	async read(path: string) { return this.files.get(path) ?? null; }
	async write(path: string, bytes: Uint8Array) { this.files.set(path, bytes); this.writes.push(path); }
	async fingerprint(path: string) { return this.read(path); }
	async preserveConflict(_input: { path: string; documentId: string; bytes: Uint8Array;
		conflicts: readonly CanvasMergeConflict[] }) { return true; }
}

function leaf(path: string, text: string) {
	const calls: string[] = [];
	const file = { path };
	const canvas = {
		data: JSON.parse(new TextDecoder().decode(canvasBytes(text))) as unknown,
		getData() { return this.data; },
		async importData(data: unknown) { this.data = data; calls.push("import"); },
		async requestSave() { calls.push("save"); },
		markDirty() {}, markMoved() {}, applyHistory() {},
	};
	const view = { file, canvas, getViewType: () => "canvas", setViewData() {} };
	return { leaf: { view }, view, canvas, calls };
}

s.test("establishes equal initial ownership and applies one remote batch to every split view", async () => {
	const disk = new Disk();
	disk.files.set("Board.canvas", canvasBytes("base"));
	const first = leaf("Board.canvas", "base");
	const second = leaf("Board.canvas", "base");
	const router = new CanvasProjectionRouter(disk);
	router.syncLeaves([first.leaf as never, second.leaf as never]);
	await delay(20);
	assert.ok(await router.read("Board.canvas"));
	await router.write("Board.canvas", canvasBytes("remote"));
	assert.deepEqual(first.calls, ["import", "save"]);
	assert.deepEqual(second.calls, ["import", "save"]);
	assert.equal((first.canvas.data as { nodes: Array<{ text: string }> }).nodes[0]?.text, "remote");
	assert.equal((second.canvas.data as { nodes: Array<{ text: string }> }).nodes[0]?.text, "remote");
	assert.deepEqual(disk.writes, [], "owned views remain the only projection writers");
	router.destroy();
});

s.test("blocks disk writes behind an open view whose initial content is unproven", async () => {
	const disk = new Disk();
	disk.files.set("Board.canvas", canvasBytes("disk"));
	const open = leaf("Board.canvas", "unsaved-view");
	const router = new CanvasProjectionRouter(disk);
	router.syncLeaves([open.leaf as never]);
	await delay(20);
	assert.equal(await router.read("Board.canvas"), null);
	await assert.rejects(router.write("Board.canvas", canvasBytes("remote")), /ownership is not proven/);
	assert.deepEqual(disk.writes, []);
	router.destroy();
});

s.test("blocks a remote batch while owned split views disagree", async () => {
	const disk = new Disk();
	disk.files.set("Board.canvas", canvasBytes("base"));
	const first = leaf("Board.canvas", "base");
	const second = leaf("Board.canvas", "base");
	const router = new CanvasProjectionRouter(disk);
	router.syncLeaves([first.leaf as never, second.leaf as never]);
	await delay(20);
	second.canvas.data = JSON.parse(new TextDecoder().decode(canvasBytes("unsaved"))) as unknown;
	assert.equal(await router.read("Board.canvas"), null);
	await assert.rejects(router.write("Board.canvas", canvasBytes("remote")), /split Canvas views disagree/);
	assert.deepEqual(first.calls, []);
	assert.deepEqual(second.calls, []);
	router.destroy();
});

s.test("a reused view cannot apply work captured for its previous Canvas", async () => {
	const disk = new Disk();
	disk.files.set("Board.canvas", canvasBytes("base"));
	const open = leaf("Board.canvas", "base");
	const router = new CanvasProjectionRouter(disk);
	router.syncLeaves([open.leaf as never]);
	await delay(20);
	open.view.file = { path: "Other.canvas" };
	open.view.setViewData();
	await router.write("Board.canvas", canvasBytes("remote"));
	assert.deepEqual(open.calls, []);
	assert.deepEqual(disk.writes, ["Board.canvas"]);
	router.destroy();
});

await s.done();
