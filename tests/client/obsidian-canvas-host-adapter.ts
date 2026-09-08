import { strict as assert } from "node:assert";
import { ObsidianCanvasHostAdapter } from "../../src/host/obsidianCanvasHostAdapter";
import { suite } from "../harness.ts";

const s = suite("obsidian-canvas-host-adapter");

function fixture() {
	const calls: string[] = [];
	const file = { path: "Board.canvas" };
	const canvas = {
		data: { nodes: [], edges: [] },
		getData() { calls.push("read"); return this.data; },
		async importData(data: unknown) { calls.push("import"); this.data = data as typeof this.data; },
		async requestSave() { calls.push("save"); },
		markDirty() { calls.push("dirty"); },
		markMoved() { calls.push("moved"); },
		applyHistory() { calls.push("history"); },
	};
	const view = {
		file,
		canvas,
		getViewType: () => "canvas",
		setViewData(_data: string, _clear: boolean) { calls.push("load"); },
	};
	const leaf = { view };
	return { calls, file, canvas, view, leaf };
}

s.test("capability checks and observes host methods without changing their result", async () => {
	const value = fixture();
	const captures: string[] = [];
	const ownership: boolean[] = [];
	const binding = new ObsidianCanvasHostAdapter().bind(value.leaf as never, {
		onCaptureRequested: (reason) => captures.push(reason),
		onOwnershipChanged: (owned) => ownership.push(owned),
	});
	assert.deepEqual(binding.capabilities(), { detect: true, read: true, apply: true, save: true,
		observeMutation: true, observeLoad: true, observeHistory: true });
	assert.equal(binding.read(), null);
	assert.deepEqual(binding.readCandidate(), { nodes: [], edges: [] });
	const candidate = binding.candidate();
	assert.ok(candidate && binding.adopt(candidate));
	assert.deepEqual(binding.read(), { nodes: [], edges: [] });
	value.canvas.markDirty();
	await Promise.resolve();
	assert.equal(captures.includes("mutation"), true);
	assert.equal(await binding.apply({ nodes: [{ id: "n" }], edges: [] }, "Board.canvas"), true);
	assert.deepEqual(value.calls.slice(-2), ["import", "save"]);
	assert.equal(ownership[0], true);
	binding.release();
	binding.release();
	assert.equal(ownership.at(-1), false);
});

s.test("file reuse invalidates old proof before remote application", async () => {
	const value = fixture();
	const binding = new ObsidianCanvasHostAdapter().bind(value.leaf as never, {
		onCaptureRequested: () => {}, onOwnershipChanged: () => {},
	});
	const candidate = binding.candidate();
	assert.ok(candidate && binding.adopt(candidate));
	const oldProof = binding.proof();
	value.view.file = { path: "Other.canvas" };
	value.view.setViewData("{}", true);
	assert.notEqual(binding.proof()?.file, oldProof?.file);
	assert.equal(await binding.apply({ nodes: [], edges: [] }, "Board.canvas"), false);
	binding.release();
});

s.test("missing private Canvas methods degrades without guessing", () => {
	const leaf = { view: { file: { path: "Board.canvas" }, getViewType: () => "canvas" } };
	const adapter = new ObsidianCanvasHostAdapter();
	assert.deepEqual(adapter.capabilities(leaf as never), { detect: true, read: false, apply: false, save: false,
		observeMutation: false, observeLoad: false, observeHistory: false });
});

await s.done();
