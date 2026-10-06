/**
 * Contract tests: SimWorkspace reproduces Obsidian 1.14.4 (app.js, read-only: TextFileView.save / loadFileInternal /
 * setData, MarkdownView.onInternalDataChange) and what the Android spike measured on 1.13.8
 * (docs/client-remake/spike-reports/android-2026-10-06.md, scenarios A, B, C, C2, D, R); the editor binding on top
 * of it (the full device: host binding + worker engine) never loses an external edit or a dirty editor's unsaved
 * typing (A..R again, bound).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "./clock";
import { SimDevice } from "./device";
import { simHashOracle } from "./hash";
import { SimNet } from "./net";
import { OBSIDIAN_RELOAD_DELAY_MS, SimVault } from "./vault";
import { SimWorkspace, type SimEditorView } from "./workspace";

const WATCHER_MS = 200;

function world() {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const vault = new SimVault({ clock, hashes: simHashOracle(), profile: "case-sensitive", watcherDelayMs: () => WATCHER_MS });
	const ws = new SimWorkspace({ clock, vault });
	return { clock, vault, ws };
}

function open(ws: SimWorkspace, path: string): SimEditorView {
	const v = ws.openFile(path);
	if (!v) throw new Error(`cannot open ${path}`);
	return v;
}

// --- SimWorkspace alone: the Obsidian behaviour --------------------------------

test("sim fidelity A: vault.modify reloads through loadFileInternal/setData; data and lastSavedData are the incoming text inside setViewData", async () => {
	const { clock, vault, ws } = world();
	vault.userWrite("a.md", "textA\n");
	const v = open(ws, "a.md");
	await clock.advance(0);
	const seen: { incoming: string; data: string | null; saved: string | null; editor: string }[] = [];
	v.interceptExternalReload((incoming) => {
		seen.push({ incoming, data: v.data, saved: v.lastSavedText(), editor: v.getText() });
		return "default";
	});
	let atEvent = -1;
	const off = vault.onEvent((e) => {
		if (e.t === "modify") atEvent = seen.length;
	});
	vault.userWrite("a.md", "textB\n");
	assert.equal(seen.length, 0, "events are asynchronous");
	await clock.advance(0);
	off();
	assert.equal(atEvent, 0, "the modify event comes first");
	assert.deepEqual(seen, [{ incoming: "textB\n", data: "textB\n", saved: "textB\n", editor: "textA\n" }], "then the reload, with no lag (spike A: 0.3 ms)");
	assert.equal(v.getText(), "textB\n", "default: the editor shows the new text");
});

test("sim fidelity B: an external adapter write reaches the view as modify event + setViewData ~25 ms later", async () => {
	const { clock, vault, ws } = world();
	vault.userWrite("b.md", "one\n");
	const v = open(ws, "b.md");
	await clock.advance(100);
	const calls = v.counters.setViewDataCalls;
	vault.externalWrite("b.md", "two\n");
	await clock.advance(WATCHER_MS + OBSIDIAN_RELOAD_DELAY_MS - 1);
	assert.equal(v.counters.setViewDataCalls, calls);
	await clock.advance(1);
	assert.equal(v.counters.setViewDataCalls, calls + 1);
	assert.equal(v.getText(), "two\n");
	assert.equal(v.lastSavedText(), "two\n");
});

test("sim fidelity C: 'handled' without touching the editor loses the external text at the next save", async () => {
	const { clock, vault, ws } = world();
	vault.userWrite("c.md", "textB\n");
	const v = open(ws, "c.md");
	v.interceptExternalReload(() => "handled");
	vault.userWrite("c.md", "textC\n");
	await clock.advance(OBSIDIAN_RELOAD_DELAY_MS);
	assert.equal(v.getText(), "textB\n", "editor unchanged");
	assert.equal(v.lastSavedText(), "textC\n", "lastSavedData was assigned before setData");
	assert.equal(vault.textOf("c.md"), "textC\n");
	await v.save();
	assert.equal(vault.textOf("c.md"), "textB\n", "save() writes the editor over the incoming text (measured data loss)");
});

test("sim fidelity C2: an editor transaction inside the wrapper is kept by autosave and by save()", async () => {
	const { clock, vault, ws } = world();
	vault.userWrite("c2.md", "base\n");
	const v = open(ws, "c2.md");
	v.interceptExternalReload((incoming) => {
		v.edit(0, v.doc.length, `${incoming}merged\n`);
		return "handled";
	});
	vault.userWrite("c2.md", "base\nincoming\n");
	await clock.advance(OBSIDIAN_RELOAD_DELAY_MS);
	assert.equal(v.getText(), "base\nincoming\nmerged\n");
	await clock.advance(2_500);
	assert.equal(vault.textOf("c2.md"), "base\nincoming\nmerged\n", "autosave wrote the merged text");
	await v.save();
	assert.equal(vault.textOf("c2.md"), "base\nincoming\nmerged\n");
});

test("sim fidelity D: restoring view.data inside the wrapper does not protect the incoming text (save writes the editor)", async () => {
	const { clock, vault, ws } = world();
	vault.userWrite("d.md", "before\n");
	const v = open(ws, "d.md");
	v.interceptExternalReload(() => {
		v.data = "before\n";
		return "handled";
	});
	vault.userWrite("d.md", "incoming\n");
	await clock.advance(OBSIDIAN_RELOAD_DELAY_MS);
	assert.equal(v.data, "before\n", "the restore sticks");
	await v.save();
	assert.equal(vault.textOf("d.md"), "before\n", "incoming lost: save wrote the editor");
});

test("sim fidelity R: a reading-mode view is reloaded through setViewData(clear=false) too", async () => {
	const { clock, vault, ws } = world();
	vault.userWrite("r.md", "r1\n");
	const v = open(ws, "r.md");
	ws.setMode(v.viewId, "reading");
	let calls = 0;
	v.interceptExternalReload(() => {
		calls++;
		return "default";
	});
	vault.userWrite("r.md", "r2\n");
	await clock.advance(OBSIDIAN_RELOAD_DELAY_MS);
	assert.equal(calls, 1);
	assert.equal(v.getText(), "r2\n");
});

test("sim fidelity: opening a file and switching a leaf load with clear=true (binding and interceptor dropped)", async () => {
	const { vault, ws } = world();
	vault.userWrite("x.md", "x\n");
	vault.userWrite("y.md", "y\n");
	const v = open(ws, "x.md");
	let calls = 0;
	v.interceptExternalReload(() => {
		calls++;
		return "handled";
	});
	assert.equal(await ws.switchFile(v.viewId, "y.md"), true);
	assert.equal(calls, 0, "clear=true never reaches the external-reload interceptor");
	assert.equal(v.getText(), "y\n");
	assert.equal(v.lastSavedText(), "y\n");
});

test("sim fidelity 1.14.4: save skips when getViewData equals lastSavedData; held saves answer lastSavedData and report the skip", async () => {
	const { vault, ws } = world();
	vault.userWrite("h.md", "same\n");
	const v = open(ws, "h.md");
	await v.save();
	assert.equal(v.counters.saves, 0, "nothing changed: no write");
	v.bind({ onLocal: () => undefined, onReset: () => undefined, onSaveRead: () => undefined });
	v.edit(0, 0, "x");
	await v.save();
	assert.equal(vault.textOf("h.md"), "xsame\n");
	v.edit(0, 1, "");
	v.holdSaves(true);
	const before = v.counters.saves;
	await v.save();
	assert.equal(v.counters.saves, before, "held: save() clears dirty, getViewData answers lastSavedData, the save skips");
	assert.equal(vault.textOf("h.md"), "xsame\n");
	assert.equal(v.holdSaves(false), true, "the release reports the skipped save");
});

test("sim fidelity 1.14.4: a dirty editor already equal to the reloaded disk text gets no setData; quick preview reaches siblings with `from`", async () => {
	const { clock, vault, ws } = world();
	vault.userWrite("q.md", "q\n");
	const v1 = open(ws, "q.md");
	const v2 = open(ws, "q.md");
	await clock.advance(0);
	const from: (number | null)[] = [];
	v2.interceptExternalReload((_t, f) => {
		from.push(f);
		return "default";
	});
	v1.edit(2, 0, "typed\n");
	await clock.advance(20); // onInternalDataChange after 10 ms
	assert.deepEqual(from, [v1.viewId], "the quick preview names its source view");
	assert.equal(v2.getText(), "q\ntyped\n");
	const calls = v1.counters.setViewDataCalls;
	vault.userWrite("q.md", "q\ntyped\n"); // equal to v1's unsaved editor
	await clock.advance(0);
	assert.equal(v1.counters.setViewDataCalls, calls, "dirty and equal: loadFileInternal returns early");
});

// --- the bound device: host binding + worker engine -----------------------------

async function bound(files: Record<string, string>, opens: string[]) {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const d = new SimDevice({ name: "A", clock, net });
	for (const [p, t] of Object.entries(files)) d.vault.userWrite(p, t);
	void d.start();
	await clock.advance(2_500);
	const views = opens.map((p) => open(d.workspace, p));
	await clock.advance(500);
	for (const v of views) assert.equal(v.isBound(), true);
	return { clock, d, vault: d.vault, ws: d.workspace, views };
}

function copies(vault: SimVault): string[] {
	return [...vault.snapshot().keys()].filter((p) => p.includes("(conflict"));
}

/** Everything agrees: editor, lastSavedData, disk, the worker replica, and nothing went through the clobber path. */
function assertSettled(v: SimEditorView, d: SimDevice, path: string, expected: string): void {
	assert.equal(v.getText(), expected, "editor");
	assert.equal(v.lastSavedText(), expected, "lastSavedData");
	assert.equal(d.vault.textOf(path), expected, "disk");
	assert.equal(d.engineText(path), expected, "worker replica");
	assert.equal(v.counters.defaultReloadWhileBound, 0, "no default reload while bound");
	assert.equal(v.isDirty(), false);
	assert.equal(d.vault.clobbered.length, 0, "no save over an unseen external write");
}

test("binding contract A: vault.modify of a clean bound view is merged in the worker; editor/lastSavedData/disk/replica agree", async () => {
	const { clock, d, vault, views } = await bound({ "a.md": "line1\n" }, ["a.md"]);
	const v = views[0] as SimEditorView;
	vault.userWrite("a.md", "line1\nfrom vault.modify\n");
	await clock.advance(OBSIDIAN_RELOAD_DELAY_MS);
	assert.equal(v.counters.intercepted, 1);
	await clock.advance(3_000);
	assertSettled(v, d, "a.md", "line1\nfrom vault.modify\n");
});

test("binding contract B: an external adapter write (watcher + 25 ms) is merged, never lost", async () => {
	const { clock, d, vault, views } = await bound({ "b.md": "one\n" }, ["b.md"]);
	const v = views[0] as SimEditorView;
	vault.externalWrite("b.md", "one\ntwo\n");
	await clock.advance(5_000);
	assertSettled(v, d, "b.md", "one\ntwo\n");
});

test("binding contract C (data-loss repro): an explicit save right after the reload keeps the external text", async () => {
	const { clock, d, vault, views } = await bound({ "c.md": "line1\n" }, ["c.md"]);
	const v = views[0] as SimEditorView;
	vault.externalWrite("c.md", "line1\nfrom another app\n");
	await clock.runUntil(() => v.counters.intercepted > 0, 5_000);
	await v.save(); // e.g. the user switches leaves or the 2 s autosave fires now
	assert.equal(vault.textOf("c.md"), "line1\nfrom another app\n", "the external edit survives the save");
	await clock.advance(3_000);
	assertSettled(v, d, "c.md", "line1\nfrom another app\n");
	assert.equal(copies(vault).length, 0);
});

test("binding contract C2/D: a dirty editor's unsaved typing and the external edit are both kept and saved", async () => {
	const { clock, d, vault, views } = await bound({ "d.md": "alpha\nbeta\n" }, ["d.md"]);
	const v = views[0] as SimEditorView;
	v.edit(0, 0, "local "); // unsaved typing at the top
	vault.userWrite("d.md", "alpha\nbeta\nexternal\n");
	await clock.advance(3_000);
	assertSettled(v, d, "d.md", "local alpha\nbeta\nexternal\n");
	assert.equal(copies(vault).length, 0);
});

test("binding contract E: same line on both sides: the editor keeps the local side, the external side goes to a conflict copy", async () => {
	const { clock, d, vault, views } = await bound({ "e.md": "# title\nbody\nend\n" }, ["e.md"]);
	const v = views[0] as SimEditorView;
	v.edit(7, 0, " more"); // "# title more", unsaved
	await clock.advance(500);
	assert.equal(v.isDirty(), true);
	vault.externalWrite("e.md", "# title\nbody\nend\nfooter from E\n");
	await clock.advance(5_000);
	assertSettled(v, d, "e.md", "# title more\nbody\nend\nfooter from E\n");
	assert.equal(copies(vault).length, 0);
	v.edit(0, 1, "%");
	vault.externalWrite("e.md", "! title more\nbody\nend\nfooter from E\n");
	await clock.advance(5_000);
	assertSettled(v, d, "e.md", "% title more\nbody\nend\nfooter from E\n");
	assert.deepEqual(copies(vault).map((p) => vault.textOf(p)), ["! title more\nbody\nend\nfooter from E\n"]);
});

test("binding contract R: a reading-mode view is unbound and reloaded by default; back in source mode it binds again", async () => {
	const { clock, d, vault, ws, views } = await bound({ "r.md": "r1\n" }, ["r.md"]);
	const v = views[0] as SimEditorView;
	ws.setMode(v.viewId, "reading");
	await clock.advance(10);
	assert.equal(v.isBound(), false);
	vault.externalWrite("r.md", "r1\nr2\n");
	await clock.advance(3_000);
	assert.equal(v.getText(), "r1\nr2\n");
	assert.equal(v.counters.intercepted, 0);
	ws.setMode(v.viewId, "source");
	await clock.advance(3_000);
	assert.equal(v.isBound(), true);
	assertSettled(v, d, "r.md", "r1\nr2\n");
});

test("binding contract split views: one merge reaches both views; a sibling's own save is not an external edit", async () => {
	const { clock, d, vault, views } = await bound({ "s.md": "shared\n" }, ["s.md", "s.md"]);
	const [v1, v2] = views as [SimEditorView, SimEditorView];
	vault.externalWrite("s.md", "shared\next\n");
	await clock.advance(5_000);
	assertSettled(v1, d, "s.md", "shared\next\n");
	assertSettled(v2, d, "s.md", "shared\next\n");
	v1.edit(0, 0, "A");
	await v1.save();
	v1.edit(1, 0, "B");
	await clock.advance(5_000);
	assertSettled(v1, d, "s.md", "ABshared\next\n");
	assertSettled(v2, d, "s.md", "ABshared\next\n");
	assert.equal(copies(vault).length, 0);
	assert.equal(v2.counters.localTx, 0, "v2 never typed: the copies it got were dropped or remote");
});
