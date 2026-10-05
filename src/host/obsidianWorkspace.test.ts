import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { ViewEvent } from "../ports/workspace";
import { ObsidianWorkspace, type AttachFn, type EditorLike, type MarkdownViewLike, type WorkspaceLike } from "./obsidianWorkspace";

class FakeEditor implements EditorLike {
	text = "";
	replaces: { text: string; from: number; to: number }[] = [];
	onChange: ((from: number, to: number, insert: string) => void) | null = null;
	getValue(): string {
		return this.text;
	}
	offsetToPos(offset: number) {
		return { line: 0, ch: offset };
	}
	replaceRange(text: string, from: { ch: number }, to?: { ch: number }): void {
		const end = to?.ch ?? from.ch;
		this.replaces.push({ text, from: from.ch, to: end });
		this.text = this.text.slice(0, from.ch) + text + this.text.slice(end);
		this.onChange?.(from.ch, end, text);
	}
}

class FakeMarkdownView implements MarkdownViewLike {
	editor = new FakeEditor();
	data = "";
	mode = "source";
	log: string[] = [];
	constructor(public file: { path: string } | null) {}
	getViewType(): string {
		return "markdown";
	}
	getMode(): string {
		return this.mode;
	}
	setViewData(data: string, clear: boolean): void {
		this.log.push(`proto:${clear}:${data}`);
		this.data = data;
		this.editor.text = data; // Obsidian replaces the CM doc
		this.editor.onChange?.(0, 0, ""); // a bound binding would see this as a local edit
	}
	async save(): Promise<void> {
		this.data = this.editor.text;
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

/** y-sync stand-in: editor edits -> ytext while attached. */
function fakeAttach(log: string[]): AttachFn {
	return (editor, spec) => {
		const ed = editor as FakeEditor;
		log.push("attach");
		ed.onChange = () => {
			log.push(`editor->ytext:${ed.text}`);
			spec.ytext.doc?.transact(() => {
				spec.ytext.delete(0, spec.ytext.length);
				spec.ytext.insert(0, ed.text);
			}, spec.localOrigin);
		};
		return () => {
			log.push("detach");
			ed.onChange = null;
		};
	};
}

test("leaf diff emits opened / file-changed (incl. mode switch) / closed with stable ids", () => {
	const ws = new FakeWorkspace();
	const a = new FakeMarkdownView({ path: "a.md" });
	ws.leaves = [{ view: a }, { view: { getViewType: () => "canvas" } }];
	const w = new ObsidianWorkspace(ws, fakeAttach([]));
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

test("external reload is intercepted on the instance only; default passes through; unintercept restores", () => {
	const ws = new FakeWorkspace();
	const v = new FakeMarkdownView({ path: "a.md" });
	const other = new FakeMarkdownView({ path: "z.md" });
	ws.leaves = [{ view: v }];
	const w = new ObsidianWorkspace(ws, fakeAttach([]));
	const ref = w.listMarkdownViews()[0];
	assert.ok(ref);
	let answer: "handled" | "default" = "handled";
	const seen: string[] = [];
	const off = ref.interceptExternalReload((incoming) => {
		seen.push(incoming);
		return answer;
	});
	assert.ok(Object.prototype.hasOwnProperty.call(v, "setViewData"), "instance wrapper");
	assert.equal(FakeMarkdownView.prototype.setViewData.length, 2);
	v.setViewData("external 1", false);
	assert.deepEqual(v.log, [], "handled: Obsidian never applies it");
	answer = "default";
	v.setViewData("external 2", false);
	assert.deepEqual(v.log, ["proto:false:external 2"]);
	other.setViewData("x", false);
	assert.deepEqual(seen, ["external 1", "external 2"], "other views are not intercepted");
	off();
	assert.equal(Object.prototype.hasOwnProperty.call(v, "setViewData"), false, "wrapper removed");
});

test("loading another file into a bound view unbinds before Obsidian replaces the editor text", () => {
	const ws = new FakeWorkspace();
	const v = new FakeMarkdownView({ path: "a.md" });
	v.editor.text = "doc A";
	ws.leaves = [{ view: v }];
	const log: string[] = [];
	const w = new ObsidianWorkspace(ws, fakeAttach(log));
	const ref = w.listMarkdownViews()[0];
	assert.ok(ref);
	const doc = new Y.Doc();
	const ytext = doc.getText("t");
	ytext.insert(0, "doc A");
	ref.bind({ ytext, localOrigin: "ed", awareness: null });
	ref.interceptExternalReload(() => "handled");
	v.editor.replaceRange("!", { ch: 5 } as never);
	assert.equal(ytext.toString(), "doc A!");
	v.file = { path: "b.md" };
	v.setViewData("doc B", true);
	assert.equal(ytext.toString(), "doc A!", "doc B never reaches doc A's ytext");
	assert.deepEqual(log, ["attach", "editor->ytext:doc A!", "detach"]);
	assert.deepEqual(v.log, ["proto:true:doc B"]);
});

test("applyMinimalReplace touches only the differing middle", () => {
	const ws = new FakeWorkspace();
	const v = new FakeMarkdownView({ path: "a.md" });
	v.editor.text = "hello brave world";
	ws.leaves = [{ view: v }];
	const ref = new ObsidianWorkspace(ws, fakeAttach([])).listMarkdownViews()[0];
	ref?.applyMinimalReplace("hello new world");
	assert.equal(v.editor.text, "hello new world");
	assert.deepEqual(v.editor.replaces, [{ text: "new", from: 6, to: 11 }]);
	ref?.applyMinimalReplace("hello new world");
	assert.equal(v.editor.replaces.length, 1);
});
