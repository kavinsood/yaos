import { test } from "node:test";
import assert from "node:assert/strict";
import { Text } from "@codemirror/state";
import type { EditorBinding, EditorBindingSpec, ViewEvent } from "../ports/workspace";
import { ObsidianWorkspace, type EditorAdapter, type MarkdownViewLike, type WorkspaceLike } from "./obsidianWorkspace";

/** An Obsidian Editor stand-in: reading its whole value is the O(N) call the adapter must never make. */
class FakeEditor {
	doc = Text.of([""]);
	getValue(): string {
		throw new Error("getValue() called: O(N) read on main");
	}
}

class FakeMarkdownView implements MarkdownViewLike {
	editor = new FakeEditor();
	dirty = false;
	lastSavedData: string | null = null;
	mode = "source";
	log: string[] = [];
	siblings: FakeMarkdownView[] = [];
	constructor(public file: { path: string } | null) {}
	getViewType(): string {
		return "markdown";
	}
	getMode(): string {
		return this.mode;
	}
	getViewData(): string {
		this.log.push("read-editor");
		return this.editor.doc.toString();
	}
	setViewData(data: string, clear: boolean): void {
		this.log.push(`proto:${clear}:${data}`);
		this.editor.doc = Text.of(data.split("\n")); // Obsidian replaces the CM doc
	}
	/** MarkdownView.onInternalDataChange: quick-preview into the other views of the file, synchronously. */
	onInternalDataChange(): void {
		for (const s of this.siblings) s.setViewData(this.editor.doc.toString(), false);
	}
	async save(): Promise<void> {
		this.dirty = false;
		const o = this.getViewData();
		if (this.lastSavedData === o || this.lastSavedData === null) return;
		this.lastSavedData = o;
		this.log.push(`write:${o}`);
	}
}

class FakeWorkspace implements WorkspaceLike {
	leaves: { view: unknown }[] = [];
	private cbs = new Set<() => unknown>();
	getLeavesOfType(type: string) {
		return type === "markdown" ? this.leaves : [];
	}
	on(_name: string, cb: (x?: unknown) => unknown) {
		this.cbs.add(cb as () => unknown);
		return { cb } as never;
	}
	offref(ref: never): void {
		this.cbs.delete((ref as { cb: () => unknown }).cb);
	}
	fire(): void {
		for (const cb of [...this.cbs]) cb();
	}
	get subscriptions(): number {
		return this.cbs.size;
	}
}

/** collab.ts stand-in: the editor's Text, and an attach that records attach/detach. */
function fakeEditors(log: string[]): EditorAdapter {
	return {
		doc: (editor) => (editor as FakeEditor).doc,
		attach(editor, _spec: EditorBindingSpec): EditorBinding {
			const ed = editor as FakeEditor;
			log.push("attach");
			return {
				doc: () => ed.doc,
				applyRemote: (c) => {
					ed.doc = c.apply(ed.doc);
				},
				detach: () => log.push("detach"),
			};
		},
	};
}

const noSpec: EditorBindingSpec = { onLocal: () => undefined, onReset: () => undefined, onSaveRead: () => undefined };

test("leaf diff emits opened / file-changed (incl. mode switch) / closed with stable ids", () => {
	const ws = new FakeWorkspace();
	const a = new FakeMarkdownView({ path: "a.md" });
	ws.leaves = [{ view: a }, { view: { getViewType: () => "canvas" } }];
	const w = new ObsidianWorkspace(ws, fakeEditors([]));
	const events: ViewEvent[] = [];
	const off = w.onViewEvent((e) => events.push(e));
	assert.equal(w.listMarkdownViews().length, 1, "existing views are listed, not re-announced");
	const b = new FakeMarkdownView({ path: "b.md" });
	ws.leaves.push({ view: b });
	ws.fire();
	a.file = { path: "c.md" };
	ws.fire();
	b.mode = "preview";
	ws.fire();
	assert.equal(w.listMarkdownViews().find((v) => v.path === "b.md")?.hasEditor(), false);
	ws.leaves = [{ view: b }];
	ws.fire();
	ws.fire();
	assert.deepEqual(events.map((e) => (e.t === "closed" ? `closed:${e.viewId}` : `${e.t}:${e.view.viewId}:${e.view.path}${e.t === "file-changed" ? `<-${e.previousPath}` : ""}`)), [
		"opened:2:b.md",
		"file-changed:1:c.md<-a.md",
		"file-changed:2:b.md<-b.md",
		"closed:1",
	]);
	off();
	assert.equal(ws.subscriptions, 0);
});

test("view queries are O(1): the editor's Text, dirty, lastSavedData; never Editor.getValue()", () => {
	const ws = new FakeWorkspace();
	const v = new FakeMarkdownView({ path: "a.md" });
	v.editor.doc = Text.of(["x".repeat(100_000)]);
	v.lastSavedData = "saved";
	v.dirty = true;
	ws.leaves = [{ view: v }];
	const ref = new ObsidianWorkspace(ws, fakeEditors([])).listMarkdownViews()[0];
	assert.ok(ref);
	assert.equal(ref.editorDoc(), v.editor.doc, "the same immutable Text, not a copy");
	assert.equal(ref.isDirty(), true);
	assert.equal(ref.lastSavedText(), "saved");
	const b = ref.bind(noSpec);
	assert.equal(b.doc(), v.editor.doc);
	assert.deepEqual(v.log, [], "nothing read the editor");
});

test("external reload is intercepted on the instance only; default passes through; unintercept restores", () => {
	const ws = new FakeWorkspace();
	const v = new FakeMarkdownView({ path: "a.md" });
	const other = new FakeMarkdownView({ path: "z.md" });
	ws.leaves = [{ view: v }];
	const w = new ObsidianWorkspace(ws, fakeEditors([]));
	const ref = w.listMarkdownViews()[0];
	assert.ok(ref);
	let answer: "handled" | "default" = "handled";
	const seen: [string, number | null][] = [];
	const off = ref.interceptExternalReload((incoming, from) => {
		seen.push([incoming, from]);
		return answer;
	});
	assert.ok(Object.prototype.hasOwnProperty.call(v, "setViewData"), "instance wrapper");
	v.setViewData("external 1", false);
	assert.deepEqual(v.log, [], "handled: Obsidian never applies it");
	answer = "default";
	v.setViewData("external 2", false);
	assert.deepEqual(v.log, ["proto:false:external 2"]);
	other.setViewData("x", false);
	assert.deepEqual(seen, [["external 1", null], ["external 2", null]], "other views are not intercepted; no quick preview: from = null");
	off();
	for (const k of ["setViewData", "getViewData", "onInternalDataChange"]) assert.equal(Object.prototype.hasOwnProperty.call(v, k), false, `${k} wrapper removed`);
});

test("loading another file into a bound view (clear=true) unbinds before Obsidian replaces the editor text", () => {
	const ws = new FakeWorkspace();
	const v = new FakeMarkdownView({ path: "a.md" });
	ws.leaves = [{ view: v }];
	const log: string[] = [];
	const ref = new ObsidianWorkspace(ws, fakeEditors(log)).listMarkdownViews()[0];
	assert.ok(ref);
	ref.bind(noSpec);
	const seen: string[] = [];
	ref.interceptExternalReload((t) => {
		seen.push(t);
		return "handled";
	});
	v.log = log; // one timeline: the adapter's attach/detach and Obsidian's own setViewData
	v.file = { path: "b.md" };
	v.setViewData("doc B", true);
	assert.deepEqual(log, ["attach", "detach", "proto:true:doc B"], "detached before doc B replaced doc A");
	assert.deepEqual(seen, [], "clear=true never reaches the reload handler");
});

test("getViewData: a save read (dirty cleared) reports onSaveRead; held saves answer lastSavedData, which save() skips", async () => {
	const ws = new FakeWorkspace();
	const v = new FakeMarkdownView({ path: "a.md" });
	v.editor.doc = Text.of(["typed"]);
	v.lastSavedData = "disk";
	ws.leaves = [{ view: v }];
	const ref = new ObsidianWorkspace(ws, fakeEditors([])).listMarkdownViews()[0];
	assert.ok(ref);
	let reads = 0;
	ref.bind({ ...noSpec, onSaveRead: () => reads++ });
	v.dirty = true;
	assert.equal(v.getViewData(), "typed", "loadFileInternal's read of a dirty editor: the editor, no save mark");
	assert.equal(reads, 0);
	ref.holdSaves(true);
	await v.save();
	assert.equal(reads, 1);
	assert.equal(v.log.includes("write:typed"), false, "held: the save wrote nothing");
	assert.equal(ref.holdSaves(false), true, "the release reports the skipped save");
	await v.save();
	assert.equal(reads, 2);
	assert.ok(v.log.includes("write:typed"));
});

test("onInternalDataChange names its view as the source of the quick preview its siblings receive", () => {
	const ws = new FakeWorkspace();
	const v1 = new FakeMarkdownView({ path: "a.md" });
	const v2 = new FakeMarkdownView({ path: "a.md" });
	v1.siblings = [v2];
	ws.leaves = [{ view: v1 }, { view: v2 }];
	const [r1, r2] = new ObsidianWorkspace(ws, fakeEditors([])).listMarkdownViews();
	assert.ok(r1 && r2);
	r1.bind(noSpec);
	const seen: (number | null)[] = [];
	r2.interceptExternalReload((_t, from) => {
		seen.push(from);
		return "handled";
	});
	v1.editor.doc = Text.of(["edited"]);
	v1.onInternalDataChange();
	v2.setViewData("reload", false);
	assert.deepEqual(seen, [r1.viewId, null]);
});
