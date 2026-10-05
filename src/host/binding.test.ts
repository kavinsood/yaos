import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { DocId } from "../core/types";
import type { EngineResultValue, MainToEngine } from "../protocol/messages";
import { BindingManager, conflictCopyPath, type BindingLink } from "./binding";
import { createHasher } from "./hashing";
import { VirtualClock } from "../sim/__standins__/clock";
import { simHashPort } from "../sim/__standins__/sha256";
import { SimVault } from "../sim/vault";
import { SimWorkspace } from "../sim/workspace";

/** Minimal engine side: one worker replica per path, records every post. */
class FakeEngine {
	readonly docs = new Map<string, { docId: DocId; doc: Y.Doc; base: string | null; frozen: boolean }>();
	readonly posts: MainToEngine[] = [];
	notBindable = new Set<string>();
	opens = 0;
	readonly link: BindingLink = {
		post: (m) => {
			this.posts.push(m);
			if (m.t === "localUpdate" || m.t === "bindDelta") {
				const e = [...this.docs.values()].find((d) => d.docId === m.docId);
				if (e) Y.applyUpdate(e.doc, m.update, "main");
			}
		},
		openDoc: async (path) => {
			this.opens++;
			await Promise.resolve();
			if (this.notBindable.has(path)) return { t: "notBindable", reason: "untracked" } satisfies EngineResultValue;
			const e = this.docs.get(path);
			if (!e) return { t: "notBindable", reason: "untracked" };
			return { t: "bind", bind: { docId: e.docId, kind: "markdown", state: Y.encodeStateAsUpdate(e.doc), stateVector: Y.encodeStateVector(e.doc), baseText: e.base, baseHash: null, frozen: e.frozen } };
		},
	};

	add(path: string, text: string, base: string | null = text): { docId: DocId; doc: Y.Doc } {
		const doc = new Y.Doc();
		doc.getText("text").insert(0, text);
		const docId = `d:${path}` as DocId;
		this.docs.set(path, { docId, doc, base, frozen: false });
		return { docId, doc };
	}

	text(path: string): string {
		return this.docs.get(path)?.doc.getText("text").toString() ?? "";
	}

	count(t: MainToEngine["t"], pred: (m: MainToEngine) => boolean = () => true): number {
		return this.posts.filter((m) => m.t === t && pred(m)).length;
	}

	/** Remote edit on the worker replica, delivered to main as docUpdate. */
	remoteEdit(path: string, mutate: (t: Y.Text) => void, bm: BindingManager): void {
		const e = this.docs.get(path);
		if (!e) throw new Error("no doc");
		const sv = Y.encodeStateVector(e.doc);
		e.doc.transact(() => mutate(e.doc.getText("text")), "remote");
		bm.onDocUpdate(e.docId, Y.encodeStateAsUpdate(e.doc, sv));
	}
}

function setup() {
	const clock = new VirtualClock();
	const hasher = createHasher(simHashPort());
	const vault = new SimVault({ clock, hasher, profile: "case-insensitive", watcherDelayMs: () => 200 });
	const ws = new SimWorkspace({ clock, vault });
	const engine = new FakeEngine();
	const notices: string[] = [];
	const bm = new BindingManager({ workspace: ws, vault, clock, hasher, link: engine.link, deviceLabel: () => "Pixel 8", notice: (_l, code) => notices.push(code), timeZone: "utc" });
	vault.onEvent((e) => bm.onVaultEvent(e));
	return { clock, vault, ws, engine, bm, notices };
}

test("binding: bind with equal texts; editor edits coalesce into one localUpdate; no echo of remote updates", async () => {
	const { clock, vault, ws, engine, bm } = setup();
	vault.userWrite("a.md", "hello");
	engine.add("a.md", "hello");
	bm.start();
	const v = ws.openFile("a.md");
	assert.ok(v);
	await clock.advance(1);
	assert.equal(bm.slotState(v.viewId), "bound");
	assert.equal(v.counters.bindMismatch, 0);
	assert.equal(engine.count("bindDelta"), 1);

	v.edit(5, 0, " w");
	v.edit(7, 0, "o");
	v.edit(8, 0, "rld");
	assert.equal(engine.count("localUpdate"), 0, "coalesced, not posted per keystroke");
	await clock.advance(16);
	assert.equal(engine.count("localUpdate"), 1);
	assert.equal(engine.text("a.md"), "hello world");
	assert.equal(v.counters.localTx, 3);

	engine.remoteEdit("a.md", (t) => t.insert(0, ">> "), bm);
	assert.equal(v.getText(), ">> hello world");
	assert.equal(v.counters.remoteApplied, 1);
	await clock.advance(100);
	assert.equal(engine.count("localUpdate"), 1, "remote update is not echoed back");
	assert.deepEqual(engine.posts.filter((m) => m.t === "docCredit").map((m) => m.t === "docCredit" && m.bytes > 0), [true], "one credit per docUpdate");

	// Obsidian's 2 s save writes the bound file and the host reports boundSaved.
	await clock.advance(2_100);
	assert.equal(vault.textOf("a.md"), ">> hello world");
	const saved = engine.posts.filter((m) => m.t === "boundSaved");
	assert.equal(saved.length, 1);
	assert.equal(saved[0]?.t === "boundSaved" && saved[0].text, ">> hello world");
	await clock.advance(5_000);
	assert.equal(engine.count("localUpdate"), 1, "quiescent: no update loop");
	assert.equal(engine.count("boundSaved"), 1);
});

test("binding: bind-time merge disk-only goes through bindDelta; conflict writes a copy and reports", async () => {
	const { clock, vault, ws, engine, bm } = setup();
	// disk-only: crdt === base, editor (disk) changed while unbound.
	vault.userWrite("a.md", "base text\nedited on disk");
	engine.add("a.md", "base text", "base text");
	// conflict: both changed.
	vault.userWrite("b.md", "disk side");
	engine.add("b.md", "crdt side", "base");
	bm.start();
	const va = ws.openFile("a.md");
	const vb = ws.openFile("b.md");
	assert.ok(va && vb);
	await clock.advance(10);
	assert.equal(engine.text("a.md"), "base text\nedited on disk", "bindDelta carries the merge");
	assert.equal(va.getText(), "base text\nedited on disk");
	assert.equal(engine.count("localUpdate"), 0, "bind-time merge is not a localUpdate");
	assert.equal(vb.getText(), "crdt side", "conflict: crdt keeps its side in the editor");
	assert.equal(engine.text("b.md"), "crdt side");
	const copy = conflictCopyPath("b.md", "Pixel 8", clock.now(), 1, "utc");
	assert.match(copy, /^b \(conflict Pixel 8 2026-01-01 0000\)\.md$/);
	assert.equal(vault.textOf(copy), "disk side", "the disk side is preserved in a conflict copy");
	const reports = engine.posts.filter((m) => m.t === "boundExternalMerged").map((m) => m.t === "boundExternalMerged" && [m.docId, m.result, m.conflictReason]);
	assert.deepEqual(reports, [["d:a.md", "disk-only", null], ["d:b.md", "conflict", "both-edited"]]);
	assert.equal(va.counters.bindMismatch + vb.counters.bindMismatch, 0);
	// Second conflict copy in the same minute gets a suffix.
	assert.equal(conflictCopyPath("x/y.md", "a/b:c", 0, 2, "utc"), "x/y (conflict abc 1970-01-01 0000 2).md");
});

test("binding: external reload of a bound view is intercepted and merged (no clobber, merge update, boundSaved)", async () => {
	const { clock, vault, ws, engine, bm } = setup();
	vault.userWrite("n.md", "line1\n");
	engine.add("n.md", "line1\n");
	bm.start();
	const v = ws.openFile("n.md");
	assert.ok(v);
	await clock.advance(10);
	vault.externalWrite("n.md", "line1\nfrom another app\n");
	await clock.advance(300);
	assert.equal(v.counters.intercepted, 1);
	assert.equal(v.counters.defaultReloadWhileBound, 0, "setViewData never reached the editor");
	assert.equal(v.getText(), "line1\nfrom another app\n");
	assert.equal(engine.text("n.md"), "line1\nfrom another app\n");
	assert.equal(engine.count("localUpdate", (m) => m.t === "localUpdate" && m.origin === "merge"), 1);
	assert.equal(engine.count("localUpdate", (m) => m.t === "localUpdate" && m.origin === "editor"), 0, "merge is not echoed as an editor edit");
	assert.deepEqual(engine.posts.filter((m) => m.t === "boundExternalMerged").map((m) => m.t === "boundExternalMerged" && m.result), ["disk-only"]);
	await clock.advance(100);
	const saved = engine.posts.filter((m) => m.t === "boundSaved");
	assert.equal(saved.length, 1);
	assert.equal(saved[0]?.t === "boundSaved" && saved[0].text, "line1\nfrom another app\n");

	// Concurrent: user typed (unsaved) while another app edited: both edits kept or a copy is written.
	v.edit(0, 0, "# ");
	vault.externalWrite("n.md", "line1\nfrom another app\nmore\n");
	await clock.advance(300);
	assert.equal(v.counters.defaultReloadWhileBound, 0);
	assert.ok(v.getText().startsWith("# line1"), "unsaved typing survives the reload");
	const copies = [...vault.snapshot().entries()].filter(([p]) => p.includes("(conflict"));
	assert.ok(v.getText().includes("more") || copies.some(([, t]) => t.includes("more")), "external edit is kept in the doc or in a conflict copy");
});

test("binding: a conflict copy that hits disk errors is retried until written (the external side is never dropped)", async () => {
	const { clock, vault, ws, engine, bm, notices } = setup();
	vault.userWrite("n.md", "seed line\n");
	engine.add("n.md", "seed line\n");
	bm.start();
	const v = ws.openFile("n.md");
	assert.ok(v);
	await clock.advance(10);
	v.edit(1, 0, "[mine]"); // unsaved typing on the same line the other app edits
	vault.externalWrite("n.md", "s[theirs]eed line\n");
	vault.failNextOps = 2;
	await clock.advance(300);
	assert.ok(notices.includes("conflict-copy-retrying"));
	await clock.advance(10_000);
	const copies = [...vault.snapshot().entries()].filter(([p]) => p.includes("(conflict"));
	assert.ok(copies.some(([, t]) => t.includes("[theirs]")), `external side kept in a conflict copy: ${JSON.stringify(copies)}`);
	assert.ok(v.getText().includes("[mine]"));
	assert.ok(!notices.includes("conflict-copy-failed"), JSON.stringify(notices));
});

test("binding: worker killed mid-typing loses nothing (suspend, keep typing, rebind with bindDelta)", async () => {
	const { clock, vault, ws, engine, bm } = setup();
	vault.userWrite("k.md", "start");
	const { doc: oldWorker } = engine.add("k.md", "start");
	const persisted = Y.encodeStateAsUpdate(oldWorker); // what the new worker will restore from IDB
	bm.start();
	const v = ws.openFile("k.md");
	assert.ok(v);
	await clock.advance(10);
	v.edit(5, 0, " one");
	await clock.advance(16); // posted to the old worker, never persisted
	assert.equal(engine.text("k.md"), "start one");
	v.edit(9, 0, " two"); // still in the coalesce buffer when the worker dies
	bm.suspend();
	v.edit(13, 0, " three"); // typed while the engine restarts
	await clock.advance(100);
	assert.equal(engine.count("localUpdate"), 1, "nothing posted while suspended");
	const entry = engine.docs.get("k.md");
	assert.ok(entry);
	entry.doc = new Y.Doc();
	Y.applyUpdate(entry.doc, persisted);
	assert.equal(engine.text("k.md"), "start");
	bm.start();
	await clock.advance(10);
	assert.equal(v.isBound(), true, "editor never detached");
	assert.equal(v.counters.bindMismatch, 0);
	assert.equal(engine.text("k.md"), "start one two three", "bindDelta carried lost + pending + typed-while-down edits");
	assert.equal(v.getText(), "start one two three");
	v.edit(0, 0, "> ");
	await clock.advance(16);
	assert.equal(engine.text("k.md"), "> start one two three", "posting resumes after rebind");
});

test("binding: split views share one replica; sibling reload is identical; stale/closed opens are released", async () => {
	const { clock, vault, ws, engine, bm } = setup();
	vault.userWrite("s.md", "shared");
	engine.add("s.md", "shared");
	bm.start();
	const v1 = ws.openFile("s.md");
	const v2 = ws.openFile("s.md");
	assert.ok(v1 && v2);
	await clock.advance(10);
	assert.deepEqual(bm.boundDocs(), ["d:s.md"]);
	v1.edit(6, 0, "!");
	assert.equal(v2.getText(), "shared!", "second view follows through the shared replica");
	await clock.advance(2_500);
	assert.equal(vault.textOf("s.md"), "shared!");
	assert.equal(v2.counters.defaultReloadWhileBound, 0);
	assert.equal(engine.count("boundExternalMerged"), 0, "sibling sync is not an external merge");
	await ws.closeView(v1.viewId);
	assert.deepEqual(bm.boundDocs(), ["d:s.md"], "replica kept while a view remains");
	await ws.closeView(v2.viewId);
	assert.deepEqual(bm.boundDocs(), []);
	assert.equal(engine.count("closeDoc"), 2);

	// Close while openDoc is in flight: the late bind is released with closeDoc.
	const v3 = ws.openFile("s.md");
	assert.ok(v3);
	await ws.closeView(v3.viewId);
	await clock.advance(10);
	assert.equal(engine.count("closeDoc"), 3);
	assert.deepEqual(bm.boundDocs(), []);
});

test("binding: retarget deleted waits for bindable; saveViews; flushAll is synchronous; frozen stays unbound", async () => {
	const { clock, vault, ws, engine, bm, notices } = setup();
	vault.userWrite("r.md", "r");
	engine.add("r.md", "r");
	vault.userWrite("f.md", "f");
	engine.add("f.md", "f");
	const fe = engine.docs.get("f.md");
	assert.ok(fe);
	fe.frozen = true;
	bm.start();
	const v = ws.openFile("r.md");
	const vf = ws.openFile("f.md");
	assert.ok(v && vf);
	await clock.advance(10);
	assert.equal(bm.slotState(vf.viewId), "waiting");
	assert.deepEqual(notices, ["doc-frozen"]);

	v.edit(1, 0, "x");
	bm.flushAll();
	assert.equal(engine.count("localUpdate"), 1, "flushAll posts without waiting for the timer");
	assert.deepEqual(await bm.saveViews(["d:r.md" as DocId, "d:nope.md" as DocId]), ["d:r.md"]);
	assert.equal(vault.textOf("r.md"), "rx");

	bm.onDocRetarget("d:r.md" as DocId, { t: "deleted" });
	assert.equal(bm.slotState(v.viewId), "waiting");
	assert.equal(v.isBound(), false);
	const opens = engine.opens;
	bm.onBindable("R.md");
	await clock.advance(10);
	assert.equal(engine.opens, opens + 1, "bindable re-opens (case-insensitive path match)");
	assert.equal(bm.slotState(v.viewId), "bound");
	assert.equal(bm.isBoundPath("R.MD"), true);
	assert.equal(bm.isBoundPath("f.md"), false);
});
