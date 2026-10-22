import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocId } from "../core/types";
import { TEXT_CHUNK_UNITS } from "../protocol/utf16";
import { BindingManager } from "./binding";
import { VirtualClock } from "../sim/clock";
import { SimBodyEngine } from "../sim/bodyEngine";
import { simHashOracle } from "../sim/hash";
import { SimVault } from "../sim/vault";
import { SimWorkspace } from "../sim/workspace";

function setup() {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const vault = new SimVault({ clock, hashes: simHashOracle(), profile: "case-insensitive", watcherDelayMs: () => 200 });
	const ws = new SimWorkspace({ clock, vault });
	const engine = new SimBodyEngine(clock);
	const notices: string[] = [];
	const bm = new BindingManager({ workspace: ws, vault, clock, link: engine.link, notice: (_l, code) => notices.push(code) });
	engine.bm = bm;
	vault.onEvent((e) => bm.onVaultEvent(e));
	return { clock, vault, ws, engine, bm, notices };
}

/** Conflict copies in the vault: [path, text]. */
function copies(vault: SimVault): [string, string][] {
	return [...vault.snapshot().entries()].filter(([p]) => p.includes("(conflict")).sort();
}

function file(s: ReturnType<typeof setup>, path: string, text: string): DocId {
	s.vault.userWrite(path, text);
	return s.engine.add(path, text);
}

test("binding: bind uploads the editor once; typing coalesces into one push of the change only; remote entries are not echoed", async () => {
	const s = setup();
	const { clock, ws, engine, bm } = s;
	file(s, "a.md", "hello");
	bm.start();
	const v = ws.openFile("a.md");
	assert.ok(v);
	await clock.advance(1);
	assert.equal(bm.slotState(v.viewId), "bound");
	assert.equal(engine.count("textChunk"), 1);
	assert.equal(engine.count("bodyAttach"), 1);
	v.edit(5, 0, " ");
	v.edit(6, 0, "w");
	v.edit(7, 0, "orld");
	assert.equal(engine.count("bodyPush"), 0, "coalescing");
	await clock.advance(20);
	const pushes = engine.posts.filter((m) => m.t === "bodyPush");
	assert.equal(pushes.length, 1);
	assert.deepEqual(pushes[0]?.t === "bodyPush" ? pushes[0].changes : null, [5, [0, " world"]], "pre-change coordinates, inserted text only");
	assert.equal(engine.text("a.md"), "hello world");
	engine.remote("a.md", 0, 0, ">> ");
	await clock.advance(5);
	assert.equal(v.getText(), ">> hello world");
	assert.equal(v.counters.localTx, 3);
	assert.equal(v.counters.remoteApplied, 1);
	assert.equal(bm.mirrorText("d:a.md" as DocId)?.toString(), ">> hello world");
	await clock.advance(5_000);
	assert.equal(engine.count("bodyPush"), 1, "no echo of the remote entry");
	assert.equal(engine.count("textChunk"), 1, "typing never uploads text");
	assert.equal(s.vault.textOf("a.md"), ">> hello world");
});

test("binding: bind merges in the worker: a replica edit reaches the editor as the bound change; an editor-only edit goes in", async () => {
	const s = setup();
	const { clock, ws, engine, bm } = s;
	file(s, "a.md", "base\n");
	file(s, "b.md", "base\n");
	engine.remote("a.md", 5, 5, "replica\n"); // nobody attached: the replica moved on
	s.vault.userWrite("b.md", "base\ndisk\n");
	bm.start();
	const va = ws.openFile("a.md");
	const vb = ws.openFile("b.md");
	assert.ok(va && vb);
	await clock.advance(5);
	assert.equal(va.getText(), "base\nreplica\n");
	assert.equal(vb.getText(), "base\ndisk\n");
	assert.equal(engine.text("b.md"), "base\ndisk\n");
	assert.equal(va.counters.localTx + vb.counters.localTx, 0, "the bound change is not a local edit");
});

test("binding: a large editor text is uploaded in UTF-16 chunks with a yield between them", async () => {
	const s = setup();
	const { clock, ws, engine, bm } = s;
	const big = "x".repeat(TEXT_CHUNK_UNITS * 2 + 10) + "é\r\n😀";
	file(s, "big.md", big);
	bm.start();
	const v = ws.openFile("big.md");
	assert.ok(v);
	await clock.runUntil(() => engine.count("textChunk") >= 1, 10);
	await clock.settleMicrotasks();
	assert.equal(engine.count("textChunk"), 1, "one chunk, then a yield to the event loop (a timer, not a microtask)");
	await clock.advance(5);
	assert.equal(engine.count("textChunk"), 3);
	assert.equal(bm.slotState(v.viewId), "bound");
	assert.equal(bm.stats.uploadUnits, big.length);
	v.edit(big.length, 0, "!");
	await clock.advance(20);
	assert.equal(engine.text("big.md"), `${big}!`);
});

test("binding: concurrent pushes and remote edits are rebased (reject, re-push) and converge", async () => {
	const s = setup();
	const { clock, ws, engine, bm } = s;
	file(s, "a.md", "0123456789");
	bm.start();
	const v = ws.openFile("a.md");
	assert.ok(v);
	await clock.advance(5);
	engine.delay = () => 3;
	v.edit(10, 0, "L");
	await clock.advance(17); // pushed: on its way to the engine
	engine.remote("a.md", 0, 0, "R"); // reaches the replica first
	v.edit(0, 1, ""); // and another local edit meanwhile
	await clock.advance(200);
	assert.ok(bm.stats.rejects >= 1, "the stale push was rejected");
	assert.equal(engine.text("a.md"), "R123456789L");
	assert.equal(v.getText(), "R123456789L");
});

test("binding: pushes chain behind unconfirmed ones (no wait per confirmation)", async () => {
	const s = setup();
	const { clock, ws, engine, bm } = s;
	file(s, "a.md", "");
	bm.start();
	const v = ws.openFile("a.md");
	assert.ok(v);
	await clock.advance(5);
	engine.delay = () => 50;
	for (let i = 0; i < 5; i++) {
		v.edit(v.doc.length, 0, `${i}`);
		bm.flushAll();
	}
	const pushes = engine.posts.flatMap((m) => (m.t === "bodyPush" ? [m] : []));
	assert.equal(pushes.length, 5);
	assert.equal(pushes[0]?.after, null);
	for (let i = 1; i < 5; i++) assert.equal(pushes[i]?.after, pushes[i - 1]?.seq);
	await clock.advance(1_000);
	assert.equal(engine.text("a.md"), "01234");
	assert.equal(bm.stats.rejects, 0);
});

test("binding: an external reload into a dirty bound view is intercepted, merged in the worker, and saved; saves are held meanwhile", async () => {
	const s = setup();
	const { clock, ws, engine, bm, vault } = s;
	file(s, "a.md", "one\ntwo\n");
	bm.start();
	const v = ws.openFile("a.md");
	assert.ok(v);
	await clock.advance(5);
	v.edit(8, 0, "three\n");
	await clock.advance(20);
	engine.delay = () => 30; // the reload round trip is slow: a save in between must not write the stale editor
	vault.userWrite("a.md", "ONE\ntwo\n");
	await clock.advance(250); // watcher -> loadFileInternal -> setViewData -> interceptor
	assert.equal(v.counters.intercepted, 1);
	assert.equal(v.counters.defaultReloadWhileBound, 0);
	assert.equal(bm.stats.reloads, 1);
	await clock.advance(5_000);
	assert.equal(engine.count("bodyReload"), 1);
	assert.equal(v.getText(), "ONE\ntwo\nthree\n");
	assert.equal(vault.textOf("a.md"), "ONE\ntwo\nthree\n");
	assert.equal(engine.text("a.md"), "ONE\ntwo\nthree\n");
});

test("binding: a save while an external reload is merging writes nothing; the reloaded result is saved after", async () => {
	const s = setup();
	const { clock, ws, engine, bm, vault } = s;
	file(s, "a.md", "one\n");
	bm.start();
	const v = ws.openFile("a.md");
	assert.ok(v);
	await clock.advance(5);
	engine.delay = () => 400;
	vault.userWrite("a.md", "one\ndisk\n");
	await clock.advance(250);
	assert.equal(v.counters.intercepted, 1);
	const saves = v.counters.saves;
	await v.save(); // not dirty: getViewData answers lastSavedData while held -> skipped
	assert.equal(v.counters.saves, saves);
	assert.equal(vault.textOf("a.md"), "one\ndisk\n");
	await clock.advance(5_000);
	assert.equal(v.getText(), "one\ndisk\n");
	assert.equal(vault.textOf("a.md"), "one\ndisk\n");
});

test("binding: a sibling view's quick preview of the same doc is dropped; its edits arrive as entries", async () => {
	const s = setup();
	const { clock, ws, engine, bm } = s;
	file(s, "a.md", "abc");
	bm.start();
	const v1 = ws.openFile("a.md");
	const v2 = ws.openFile("a.md");
	assert.ok(v1 && v2);
	await clock.advance(5);
	assert.equal(bm.slotState(v1.viewId), "bound");
	assert.equal(bm.slotState(v2.viewId), "bound");
	v1.edit(3, 0, "d");
	await clock.advance(50); // onInternalDataChange (10 ms) previews into v2
	assert.ok(bm.stats.siblingCopies >= 1);
	assert.equal(v2.counters.defaultReloadWhileBound, 0);
	assert.equal(v2.getText(), "abcd");
	assert.equal(v2.counters.localTx, 0, "the copy never became a local edit of v2");
	assert.equal(engine.text("a.md"), "abcd");
	v2.edit(0, 0, ">");
	await clock.advance(50);
	assert.equal(v1.getText(), ">abcd");
	assert.equal(engine.count("bodyReload"), 0);
});

test("binding: a view still opening drops a bound sibling's preview (no double merge); an unbindable view gets Obsidian's copy", async () => {
	const s = setup();
	const { clock, ws, engine, bm } = s;
	file(s, "a.md", "abc\n");
	bm.start();
	const v1 = ws.openFile("a.md");
	assert.ok(v1);
	await clock.advance(5);
	assert.equal(bm.slotState(v1.viewId), "bound");
	engine.delay = () => 40; // v2's openDoc takes a while
	const v2 = ws.openFile("a.md");
	assert.ok(v2);
	v1.edit(3, 0, "d");
	await clock.advance(20); // v1's quick preview reaches v2 while it is opening
	assert.equal(bm.slotState(v2.viewId), "opening");
	assert.equal(bm.stats.siblingCopies, 1);
	assert.equal(v2.getText(), "abc\n", "dropped: v1's push delivers the edit");
	await clock.advance(500);
	assert.equal(bm.slotState(v2.viewId), "bound");
	assert.equal(engine.text("a.md"), "abcd\n", "merged once (v2's upload did not carry v1's edit)");
	assert.equal(v2.getText(), "abcd\n");
	assert.equal(engine.count("bodyReload"), 0);

	engine.delay = () => 0;
	file(s, "n.md", "new\n");
	engine.notBindable.add("n.md");
	const n1 = ws.openFile("n.md");
	const n2 = ws.openFile("n.md");
	assert.ok(n1 && n2);
	await clock.advance(5);
	assert.equal(bm.slotState(n1.viewId), "waiting");
	n1.edit(0, 0, "x");
	await clock.advance(20);
	assert.equal(n2.getText(), "xnew\n", "not bound: Obsidian's own quick preview applies");
});

test("binding: onSaveRead posts a save mark naming the mirror version and the newest push", async () => {
	const s = setup();
	const { clock, ws, engine, bm } = s;
	file(s, "a.md", "x");
	bm.start();
	const v = ws.openFile("a.md");
	assert.ok(v);
	await clock.advance(5);
	engine.delay = () => 100;
	v.edit(1, 0, "y");
	await v.save(); // flushes the buffer, then marks
	const marks = engine.posts.flatMap((m) => (m.t === "bodySaveMark" ? [m] : []));
	const pushes = engine.posts.flatMap((m) => (m.t === "bodyPush" ? [m] : []));
	assert.equal(marks.length, 1);
	assert.equal(pushes.length, 1);
	assert.equal(marks[0]?.seq, pushes[0]?.seq);
	assert.equal(marks[0]?.version, pushes[0]?.base);
	assert.equal(bm.stats.saveMarks, 1);
});

test("binding: docRetarget resync re-attaches with the mirror as base; frozen waits for bindable; renamed re-opens", async () => {
	const s = setup();
	const { clock, ws, engine, bm, notices } = s;
	const docId = file(s, "a.md", "abc\n");
	bm.start();
	const v = ws.openFile("a.md");
	assert.ok(v);
	await clock.advance(5);
	bm.onDocRetarget(docId, { t: "resync" });
	v.edit(4, 0, "d\n");
	await clock.advance(50);
	assert.equal(bm.slotState(v.viewId), "bound");
	assert.equal(bm.stats.resyncs, 1);
	assert.equal(engine.text("a.md"), "abc\nd\n");
	engine.frozen.add("a.md");
	bm.onDocRetarget(docId, { t: "frozen", reason: "test" });
	await clock.advance(5);
	assert.equal(bm.slotState(v.viewId), "waiting");
	assert.deepEqual(notices, ["doc-frozen"]);
	assert.equal(bm.isBoundPath("a.md"), false);
	v.edit(0, 0, "x\n"); // unbound: goes in by the line merge at re-attach
	engine.frozen.delete("a.md");
	bm.onBindable("A.md" as never); // case-insensitive vault
	await clock.advance(50);
	assert.equal(bm.slotState(v.viewId), "bound");
	assert.equal(engine.text("a.md"), "x\nabc\nd\n");
	assert.equal(v.getText(), "x\nabc\nd\n");
	bm.onDocRetarget(docId, { t: "renamed", path: "a.md" as never });
	await clock.advance(50);
	assert.equal(bm.slotState(v.viewId), "bound");
	assert.equal(engine.count("bodyAttach"), 4);
});

test("binding: a frozen doc stays unbound with a notice; notBindable waits until bindable", async () => {
	const s = setup();
	const { clock, ws, engine, bm, notices } = s;
	file(s, "f.md", "frozen");
	file(s, "n.md", "later");
	engine.frozen.add("f.md");
	engine.notBindable.add("n.md");
	bm.start();
	const vf = ws.openFile("f.md");
	const vn = ws.openFile("n.md");
	assert.ok(vf && vn);
	await clock.advance(5);
	assert.equal(bm.slotState(vf.viewId), "waiting");
	assert.deepEqual(notices, ["doc-frozen"]);
	assert.ok(engine.posts.some((m) => m.t === "closeDoc"));
	assert.equal(bm.slotState(vn.viewId), "waiting");
	engine.notBindable.delete("n.md");
	bm.onBindable("n.md" as never);
	await clock.advance(5);
	assert.equal(bm.slotState(vn.viewId), "bound");
});

test("binding: flushPath (case-insensitive), flushAll and saveViews push and save the bound views", async () => {
	const s = setup();
	const { clock, ws, engine, bm, vault } = s;
	const docId = file(s, "R.md", "r");
	bm.start();
	const v = ws.openFile("R.md");
	assert.ok(v);
	await clock.advance(5);
	v.edit(1, 0, "1");
	assert.equal(bm.flushPath("r.md"), true, "pending push for the same file under another case");
	assert.equal(engine.count("bodyPush"), 1);
	assert.equal(bm.flushPath("other.md"), false);
	v.edit(2, 0, "2");
	bm.flushAll();
	assert.equal(engine.count("bodyPush"), 2);
	const saved = await bm.saveViews([docId, "d:none" as DocId]);
	assert.deepEqual(saved, [docId]);
	assert.equal(vault.textOf("R.md"), "r12");
});

test("binding: saveViews saves only the view with the newest edit: a stale dirty view of the file cannot overwrite it", async () => {
	const s = setup();
	const { clock, ws, bm, vault } = s;
	const docId = file(s, "m.md", "base");
	bm.start();
	const v1 = ws.openFile("m.md");
	const v2 = ws.openFile("m.md");
	assert.ok(v1 && v2 && v1 !== v2);
	await clock.advance(5);
	v2.edit(4, 0, " old");
	await clock.advance(50); // reaches v1 (Obsidian's 10 ms cross-view debounce); v2 stays dirty, its save is 2 s off
	v1.edit(0, 0, "new ");
	// Hidden right after the keystroke: v2 has not received it yet.
	assert.equal(v2.getText(), "base old");
	assert.deepEqual(await bm.saveViews([docId]), [docId]);
	assert.equal(vault.textOf("m.md"), "new base old", "the newest view's text, not v2's older one");
});

test("binding: a view waiting on a path re-opens at the new path when the file is renamed", async () => {
	const s = setup();
	const { clock, ws, engine, bm, vault } = s;
	vault.userWrite("old.md", "text");
	bm.start();
	const v = ws.openFile("old.md");
	assert.ok(v);
	await clock.advance(5);
	assert.equal(bm.slotState(v.viewId), "waiting", "untracked yet");
	engine.add("new.md", "text");
	vault.userRename("old.md", "new.md");
	await clock.advance(300);
	assert.equal(v.path, "new.md");
	assert.equal(bm.slotState(v.viewId), "bound");
});

test("binding: a stray retarget holds the view's saves until it binds the file's doc, merging against the old doc's text", async () => {
	// The engine found the views of x.md's doc showing z.md, another doc's file (vaultRuntime retargetStrayViews).
	const s = setup();
	const { clock, ws, engine, bm, vault } = s;
	const x = file(s, "x.md", "one\ntwo\nx\n");
	file(s, "z.md", "one\ntwo\nz\n");
	bm.start();
	const v = ws.openFile("x.md");
	assert.ok(v);
	await clock.advance(5);
	assert.equal(bm.slotState(v.viewId), "bound");
	v.path = "z.md";
	engine.delay = () => 400; // the re-open is slow: a save meanwhile must not write x's text over z.md
	bm.onDocRetarget(x, { t: "renamed", path: "z.md" as never, stray: true });
	v.edit(0, 3, "ONE"); // typed since the retarget, on a line both docs share
	await v.save();
	assert.equal(vault.textOf("z.md"), "one\ntwo\nz\n", "held");
	await clock.advance(5_000);
	assert.equal(bm.slotState(v.viewId), "bound");
	assert.equal(engine.text("z.md"), "ONE\ntwo\nz\n", "z's text, plus the edit typed since");
	assert.equal(v.getText(), "ONE\ntwo\nz\n");
	assert.equal(vault.textOf("z.md"), "ONE\ntwo\nz\n", "the held save ran once bound");
	assert.equal(engine.text("x.md"), "one\ntwo\nx\n");
});

test("binding: a view closed while a merged or pruned re-open is in flight saves its edits to its file", async () => {
	for (const change of [{ t: "merged", into: "d-other" }, { t: "renamed", path: "a.md" }] as const) {
		const s = setup();
		const { clock, ws, engine, bm, vault } = s;
		const docId = file(s, "a.md", "one\ntwo\n");
		bm.start();
		const v = ws.openFile("a.md");
		assert.ok(v);
		await clock.advance(5);
		engine.delay = () => 400;
		bm.onDocRetarget(docId, change as never);
		v.edit(0, 3, "ONE"); // typed while the view re-opens
		await ws.closeView(v.viewId);
		await clock.advance(5_000);
		assert.equal(vault.textOf("a.md"), "ONE\ntwo\n", change.t);
	}
});

test("binding: a view that goes away while a stray retarget holds its saves sends its text to a conflict copy", async () => {
	type Leave = "close" | "switch";
	type Phase = "opening" | "attaching";
	for (const [leave, phase] of [["close", "opening"], ["close", "attaching"], ["switch", "opening"]] as [Leave, Phase][]) {
		const s = setup();
		const { clock, ws, engine, bm, vault } = s;
		const x = file(s, "x.md", "one\ntwo\nx\n");
		file(s, "z.md", "one\ntwo\nz\n");
		file(s, "other.md", "other\n");
		bm.start();
		const v = ws.openFile("x.md");
		assert.ok(v);
		await clock.advance(5);
		v.path = "z.md";
		engine.delay = () => 400;
		bm.onDocRetarget(x, { t: "renamed", path: "z.md" as never, stray: true });
		for (let i = 0; i < 100 && bm.slotState(v.viewId) !== phase; i++) await clock.advance(50);
		assert.equal(bm.slotState(v.viewId), phase, `${leave} ${phase}`);
		v.edit(0, 3, "ONE"); // typed while held: this view's text is its only copy
		if (leave === "close") await ws.closeView(v.viewId);
		else assert.ok(await ws.switchFile(v.viewId, "other.md"));
		await clock.advance(5_000);
		assert.equal(vault.textOf("z.md"), "one\ntwo\nz\n", `${leave} ${phase}: the held save never wrote z.md`);
		assert.deepEqual(copies(vault), [["z (conflict 2026-01-01 0000).md", "ONE\ntwo\nx\n"]], `${leave} ${phase}: main kept the text in a conflict copy`);
	}
});

test("binding: held text needs no engine: a stray view whose re-open never answers keeps each held save in a conflict copy", async () => {
	const s = setup();
	const { clock, ws, engine, bm, vault } = s;
	const x = file(s, "x.md", "one\ntwo\nx\n");
	file(s, "z.md", "one\ntwo\nz\n");
	bm.start();
	const v = ws.openFile("x.md");
	assert.ok(v);
	await clock.advance(5);
	v.path = "z.md";
	engine.delay = () => 1e12; // the engine is gone: openDoc never answers
	bm.onDocRetarget(x, { t: "renamed", path: "z.md" as never, stray: true });
	v.edit(0, 3, "ONE");
	await clock.advance(5_000); // Obsidian's 2 s save, held
	assert.equal(vault.textOf("z.md"), "one\ntwo\nz\n");
	assert.deepEqual(copies(vault).map(([, t]) => t), ["ONE\ntwo\nx\n"], "kept at the held save");
	await v.save(); // saved again without edits: nothing new
	v.edit(0, 0, "zero\n");
	await ws.closeView(v.viewId); // the close save, held
	await clock.advance(5_000);
	assert.equal(vault.textOf("z.md"), "one\ntwo\nz\n");
	assert.deepEqual(copies(vault).map(([, t]) => t).sort(), ["ONE\ntwo\nx\n", "zero\nONE\ntwo\nx\n"], "and at the close");
});

test("binding: the host stopping while a stray view is held keeps its text in a copy and shows the file's text; no save writes over z.md", async () => {
	const s = setup();
	const { clock, ws, engine, bm, vault } = s;
	const x = file(s, "x.md", "one\ntwo\nx\n");
	file(s, "z.md", "one\ntwo\nz\n");
	bm.start();
	const v = ws.openFile("x.md");
	assert.ok(v);
	await clock.advance(5);
	v.path = "z.md";
	engine.delay = () => 400;
	bm.onDocRetarget(x, { t: "renamed", path: "z.md" as never, stray: true });
	v.edit(0, 3, "ONE"); // not saved yet (2 s debounce)
	bm.stop();
	await clock.advance(5_000);
	assert.deepEqual(copies(vault).map(([, t]) => t), ["ONE\ntwo\nx\n"], "kept");
	assert.equal(v.getText(), "one\ntwo\nz\n", "the view shows its file");
	assert.equal(v.isDirty(), false);
	await v.save();
	v.edit(0, 0, "later\n"); // typing after the plugin stopped: an ordinary edit of z.md
	await clock.advance(5_000);
	assert.equal(vault.textOf("z.md"), "later\none\ntwo\nz\n");
});
