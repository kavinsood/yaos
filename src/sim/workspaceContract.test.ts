/**
 * Contract tests: SimWorkspace reproduces what the Android spike measured on
 * Obsidian 1.13.8 (docs/client-remake/spike-reports/android-2026-10-06.md,
 * scenarios A, B, C, C2, D, R), and the editor binding on top of it never
 * loses an external edit or a dirty editor's unsaved typing (A..R again, with
 * the binding attached).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { DocId } from "../core/types";
import type { EngineResultValue, MainToEngine } from "../protocol/messages";
import { BindingManager, type BindingLink } from "../host/binding";
import { createHasher } from "../host/hashing";
import { VirtualClock } from "./clock";
import { simHashPort } from "./hash";
import { OBSIDIAN_RELOAD_DELAY_MS, SimVault } from "./vault";
import { SimWorkspace, type SimEditorView } from "./workspace";

const WATCHER_MS = 200;

function world() {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const hasher = createHasher(simHashPort());
	const vault = new SimVault({ clock, hasher, profile: "case-sensitive", watcherDelayMs: () => WATCHER_MS });
	const ws = new SimWorkspace({ clock, vault });
	return { clock, hasher, vault, ws };
}

function open(ws: SimWorkspace, path: string): SimEditorView {
	const v = ws.openFile(path);
	if (!v) throw new Error(`cannot open ${path}`);
	return v;
}

// --- SimWorkspace alone: the measured Obsidian behaviour ----------------------

test("sim fidelity A: vault.modify reloads through setData; view.data is already the incoming text inside setViewData", async () => {
	const { clock, vault, ws } = world();
	vault.userWrite("a.md", "textA\n");
	const v = open(ws, "a.md");
	await clock.advance(0); // the create event's reload finds nothing new
	const seen: { incoming: string; data: string; editor: string }[] = [];
	v.interceptExternalReload((incoming) => {
		seen.push({ incoming, data: v.getLastSavedText(), editor: v.getText() });
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
	assert.deepEqual(seen, [{ incoming: "textB\n", data: "textB\n", editor: "textA\n" }], "then the reload, with no lag (spike A: 0.3 ms)");
	assert.equal(v.getText(), "textB\n", "default: the editor shows the new text");
});

test("sim fidelity B: an external adapter write reaches the view as modify event + setViewData ~25 ms later", async () => {
	const { clock, vault, ws } = world();
	vault.userWrite("b.md", "one\n");
	const v = open(ws, "b.md");
	await clock.advance(100); // the create event's reload finds nothing new
	const calls = v.counters.setViewDataCalls;
	vault.externalWrite("b.md", "two\n");
	await clock.advance(WATCHER_MS + OBSIDIAN_RELOAD_DELAY_MS - 1);
	assert.equal(v.counters.setViewDataCalls, calls);
	await clock.advance(1);
	assert.equal(v.counters.setViewDataCalls, calls + 1);
	assert.equal(v.getText(), "two\n");
	assert.equal(v.getLastSavedText(), "two\n");
});

test("sim fidelity C: 'handled' without touching the editor loses the external text at the next save", async () => {
	const { clock, vault, ws } = world();
	vault.userWrite("c.md", "textB\n");
	const v = open(ws, "c.md");
	v.interceptExternalReload(() => "handled");
	vault.userWrite("c.md", "textC\n");
	await clock.advance(OBSIDIAN_RELOAD_DELAY_MS);
	assert.equal(v.getText(), "textB\n", "editor unchanged");
	assert.equal(v.getLastSavedText(), "textC\n", "view.data was assigned before setViewData");
	assert.equal(vault.textOf("c.md"), "textC\n");
	await v.save();
	assert.equal(vault.textOf("c.md"), "textB\n", "save() writes the editor over the incoming text (measured data loss)");
});

test("sim fidelity C2: merging into the editor inside the wrapper is kept by autosave and by save()", async () => {
	const { clock, vault, ws } = world();
	vault.userWrite("c2.md", "base\n");
	const v = open(ws, "c2.md");
	v.interceptExternalReload((incoming) => {
		v.applyMinimalReplace(`${incoming}merged\n`);
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
	assert.equal(v.getLastSavedText(), "before\n", "the restore sticks");
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
	assert.equal(v.getLastSavedText(), "y\n");
});

// --- SimWorkspace + the editor binding ----------------------------------------

/** Engine side for the binding: one replica per path; applies localUpdate/bindDelta; records posts. */
class FakeEngine {
	readonly docs = new Map<string, { docId: DocId; doc: Y.Doc; base: string | null }>();
	readonly posts: MainToEngine[] = [];
	readonly link: BindingLink = {
		post: (m) => {
			this.posts.push(m);
			if (m.t === "localUpdate" || m.t === "bindDelta") {
				const e = [...this.docs.values()].find((d) => d.docId === m.docId);
				if (e) Y.applyUpdate(e.doc, m.update, "main");
			}
		},
		openDoc: async (path) => {
			await Promise.resolve();
			const e = this.docs.get(path);
			if (!e) return { t: "notBindable", reason: "untracked" } satisfies EngineResultValue;
			return { t: "bind", bind: { docId: e.docId, kind: "markdown", state: Y.encodeStateAsUpdate(e.doc), stateVector: Y.encodeStateVector(e.doc), baseText: e.base, baseHash: null, frozen: false } };
		},
	};

	add(path: string, text: string): void {
		const doc = new Y.Doc();
		doc.getText("text").insert(0, text);
		this.docs.set(path, { docId: `d:${path}` as DocId, doc, base: text });
	}

	text(path: string): string {
		return this.docs.get(path)?.doc.getText("text").toString() ?? "";
	}

	merges(): string[] {
		return this.posts.flatMap((m) => (m.t === "boundExternalMerged" ? [m.result] : []));
	}
}

async function bound(files: Record<string, string>, opens: string[]) {
	const w = world();
	const engine = new FakeEngine();
	for (const [p, t] of Object.entries(files)) {
		w.vault.userWrite(p, t);
		engine.add(p, t);
	}
	const bm = new BindingManager({ workspace: w.ws, vault: w.vault, clock: w.clock, hasher: w.hasher, link: engine.link, deviceLabel: () => "Sim", notice: () => undefined, timeZone: "utc" });
	w.vault.onEvent((e) => bm.onVaultEvent(e));
	bm.start();
	const views = opens.map((p) => open(w.ws, p));
	await w.clock.advance(10);
	for (const v of views) assert.equal(v.isBound(), true);
	return { ...w, engine, bm, views };
}

function copies(vault: SimVault): string[] {
	return [...vault.snapshot().keys()].filter((p) => p.includes("(conflict"));
}

/** Everything agrees: editor, view.data, disk, main replica (via the engine), and nothing went through the clobber path. */
function assertSettled(v: SimEditorView, vault: SimVault, engine: FakeEngine, path: string, expected: string): void {
	assert.equal(v.getText(), expected, "editor");
	assert.equal(v.getLastSavedText(), expected, "view.data");
	assert.equal(vault.textOf(path), expected, "disk");
	assert.equal(engine.text(path), expected, "engine replica");
	assert.equal(v.counters.defaultReloadWhileBound, 0, "no default reload while bound");
	assert.equal(v.isDirty(), false);
}

test("binding contract A: vault.modify of a clean bound view is merged into the editor; data/editor/disk/CRDT agree", async () => {
	const { clock, vault, engine, views } = await bound({ "a.md": "line1\n" }, ["a.md"]);
	const v = views[0]!;
	vault.userWrite("a.md", "line1\nfrom vault.modify\n");
	await clock.advance(OBSIDIAN_RELOAD_DELAY_MS);
	assert.equal(v.counters.intercepted, 1);
	assert.equal(v.getText(), "line1\nfrom vault.modify\n", "merged synchronously inside the wrapper");
	await clock.advance(3_000);
	assertSettled(v, vault, engine, "a.md", "line1\nfrom vault.modify\n");
	assert.deepEqual(engine.merges(), ["disk-only"]);
	const saved = engine.posts.flatMap((m) => (m.t === "boundSaved" ? [m.text] : []));
	assert.equal(saved.at(-1), "line1\nfrom vault.modify\n", "the engine's synced base follows the disk");
});

test("binding contract B: an external adapter write (watcher + 25 ms) is merged, never lost", async () => {
	const { clock, vault, engine, views } = await bound({ "b.md": "one\n" }, ["b.md"]);
	const v = views[0]!;
	vault.externalWrite("b.md", "one\ntwo\n");
	await clock.advance(WATCHER_MS + OBSIDIAN_RELOAD_DELAY_MS);
	assert.equal(v.getText(), "one\ntwo\n");
	await clock.advance(3_000);
	assertSettled(v, vault, engine, "b.md", "one\ntwo\n");
	assert.equal(vault.clobbered.length, 0);
});

test("binding contract C (data-loss repro): an explicit save right after the reload keeps the external text", async () => {
	const { clock, vault, engine, views } = await bound({ "c.md": "line1\n" }, ["c.md"]);
	const v = views[0]!;
	vault.externalWrite("c.md", "line1\nfrom another app\n");
	await clock.advance(WATCHER_MS + OBSIDIAN_RELOAD_DELAY_MS);
	await v.save(); // e.g. the user switches leaves or the 2 s autosave fires now
	assert.equal(vault.textOf("c.md"), "line1\nfrom another app\n", "the external edit survives the save");
	await clock.advance(3_000);
	assertSettled(v, vault, engine, "c.md", "line1\nfrom another app\n");
	assert.equal(copies(vault).length, 0);
});

test("binding contract C2/D: after the reload, view.data, editor and disk equal the merge without touching view.data", async () => {
	const { clock, vault, engine, views } = await bound({ "d.md": "alpha\nbeta\n" }, ["d.md"]);
	const v = views[0]!;
	v.edit(0, 0, "local "); // unsaved typing at the top
	vault.userWrite("d.md", "alpha\nbeta\nexternal\n");
	await clock.advance(OBSIDIAN_RELOAD_DELAY_MS);
	assert.equal(v.getText(), "local alpha\nbeta\nexternal\n", "both sides merged into the editor in the wrapper (C2)");
	await clock.advance(1);
	assert.equal(vault.textOf("d.md"), "local alpha\nbeta\nexternal\n", "saved right after the reload, not 2 s later");
	assertSettled(v, vault, engine, "d.md", "local alpha\nbeta\nexternal\n");
	assert.deepEqual(engine.merges(), ["clean"]);
	assert.equal(copies(vault).length, 0);
});

test("binding contract E: a dirty editor keeps its unsaved edits; the external edit is kept too", async () => {
	const { clock, vault, engine, views } = await bound({ "e.md": "# title\nbody\nend\n" }, ["e.md"]);
	const v = views[0]!;
	v.edit(7, 0, " more"); // "# title more", unsaved
	await clock.advance(500);
	assert.equal(v.isDirty(), true);
	vault.externalWrite("e.md", "# title\nbody\nend\nfooter from E\n");
	await clock.advance(WATCHER_MS + OBSIDIAN_RELOAD_DELAY_MS + 3_000);
	assertSettled(v, vault, engine, "e.md", "# title more\nbody\nend\nfooter from E\n");
	assert.equal(copies(vault).length, 0);
	// Same line on both sides: the editor keeps the local side, the external side goes to a conflict copy.
	v.edit(0, 1, "%");
	vault.externalWrite("e.md", "! title more\nbody\nend\nfooter from E\n");
	await clock.advance(WATCHER_MS + OBSIDIAN_RELOAD_DELAY_MS + 3_000);
	assertSettled(v, vault, engine, "e.md", "% title more\nbody\nend\nfooter from E\n");
	assert.deepEqual(copies(vault).map((p) => vault.textOf(p)), ["! title more\nbody\nend\nfooter from E\n"]);
});

test("binding contract R: a reading-mode view is unbound and reloaded by default; back in source mode the CRDT gets the change", async () => {
	const { clock, vault, ws, engine, views } = await bound({ "r.md": "r1\n" }, ["r.md"]);
	const v = views[0]!;
	ws.setMode(v.viewId, "reading");
	await clock.advance(10);
	assert.equal(v.isBound(), false);
	vault.externalWrite("r.md", "r1\nr2\n");
	await clock.advance(WATCHER_MS + OBSIDIAN_RELOAD_DELAY_MS);
	assert.equal(v.getText(), "r1\nr2\n");
	assert.equal(v.counters.intercepted, 0);
	ws.setMode(v.viewId, "source");
	await clock.advance(3_000);
	assert.equal(v.isBound(), true);
	assertSettled(v, vault, engine, "r.md", "r1\nr2\n");
});

test("binding contract split views: one merge for both views; a sibling's own save is not an external edit", async () => {
	const { clock, vault, engine, views } = await bound({ "s.md": "shared\n" }, ["s.md", "s.md"]);
	const [v1, v2] = views as [SimEditorView, SimEditorView];
	vault.externalWrite("s.md", "shared\next\n");
	await clock.advance(WATCHER_MS + OBSIDIAN_RELOAD_DELAY_MS + 3_000);
	assertSettled(v1, vault, engine, "s.md", "shared\next\n");
	assertSettled(v2, vault, engine, "s.md", "shared\next\n");
	assert.deepEqual(engine.merges(), ["disk-only"]);
	// v1 saves, then more typing lands before Obsidian reloads v2 with v1's save (incoming = v1's view.data).
	v1.edit(0, 0, "A");
	await v1.save();
	v1.edit(1, 0, "B");
	await clock.advance(3_000);
	assertSettled(v1, vault, engine, "s.md", "ABshared\next\n");
	assertSettled(v2, vault, engine, "s.md", "ABshared\next\n");
	assert.deepEqual(engine.merges(), ["disk-only"], "the sibling echo is neither a conflict nor an external merge");
	assert.equal(copies(vault).length, 0);
});
