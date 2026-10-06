/**
 * Seeded fuzz of the main-thread body client (DESIGN §d.3): two editors of one file (split view) type while the
 * replica takes remote changes, every message is delayed (FIFO per direction, so pushes and entries cross), and
 * pushes get rejected and rebased. Phase 1: inserts and deletes; everything converges. Phase 2: view A undoes all
 * of its edits while B and the replica keep inserting; A's characters (uppercase, only A types them) disappear and
 * every other character stays: undo undoes local edits only (remote changes are dispatched with addToHistory=false,
 * which CodeMirror's history maps instead of recording: obsidian.asar 1.14.4 app.js@1889598).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocId } from "../core/types";
import { BindingManager } from "./binding";
import { VirtualClock } from "../sim/clock";
import { SimBodyEngine } from "../sim/bodyEngine";
import { simHashOracle } from "../sim/hash";
import { SeededRandom } from "../sim/random";
import { SimVault } from "../sim/vault";
import { SimWorkspace, type SimEditorView } from "../sim/workspace";

const PATH = "fuzz.md";
const DOC = `d:${PATH}` as DocId;
const INITIAL = "alpha beta\ngamma delta\nepsilon\n";
const UPPER = /[A-Z]/g;

function world(seed: number) {
	const rng = new SeededRandom(seed);
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const vault = new SimVault({ clock, hashes: simHashOracle(), profile: "case-sensitive", watcherDelayMs: () => 200 });
	const ws = new SimWorkspace({ clock, vault });
	const engine = new SimBodyEngine(clock);
	engine.delay = () => (rng.int(5) === 0 ? rng.int(300) : rng.int(25));
	const bm = new BindingManager({ workspace: ws, vault, clock, link: engine.link, notice: () => undefined });
	engine.bm = bm;
	vault.onEvent((e) => bm.onVaultEvent(e));
	vault.userWrite(PATH, INITIAL);
	engine.add(PATH, INITIAL);
	return { rng, clock, vault, ws, engine, bm };
}

type World = ReturnType<typeof world>;

function token(rng: SeededRandom, alphabet: string, n: number): string {
	let s = "";
	for (let i = 0; i < n; i++) s += alphabet[rng.int(alphabet.length)];
	return s;
}

function converged(w: World, a: SimEditorView, b: SimEditorView, atBound: number | null, label: string): string {
	const text = w.engine.text(PATH);
	assert.equal(a.getText(), text, `${label}: view A = replica`);
	assert.equal(b.getText(), text, `${label}: view B = replica`);
	assert.equal(w.bm.mirrorText(DOC)?.toString(), text, `${label}: main mirror = replica`);
	assert.equal(w.bm.stats.resyncs, 0, `${label}: no resync (the protocol never broke)`);
	// Text crosses only while binding: the attach uploads, plus a quick preview a view got from its sibling before
	// that sibling was attaching (routed as a reload). Once both views are bound, typing never posts text.
	const ids = w.engine.posts.flatMap((m) => (m.t === "bodyAttach" ? [m.editor, m.base, m.saved] : m.t === "bodyReload" ? [m.text] : []));
	assert.equal(w.engine.count("bodyAttach"), 2, `${label}: bound once per view`);
	for (const m of w.engine.posts) if (m.t === "textChunk") assert.ok(ids.includes(m.uploadId), `${label}: upload ${m.uploadId} is a bind-time upload`);
	assert.equal(w.engine.count("textChunk"), atBound, `${label}: no text upload after both views were bound`);
	return text;
}

/** Remove phase-2 tokens <..> (innermost first: a later insert may land inside an earlier one). */
function stripPhase2(s: string): string {
	for (let prev = ""; prev !== s; ) {
		prev = s;
		s = s.replace(/<[a-z0-9]+>/g, "");
	}
	return s;
}

async function run(seed: number, steps: number): Promise<{ rejects: number; pushes: number; undos: number }> {
	const w = world(seed);
	const { rng, clock, ws, engine, bm } = w;
	bm.start();
	const a = ws.openFile(PATH);
	const b = ws.openFile(PATH);
	assert.ok(a && b);
	await clock.advance(rng.int(3) * 7); // sometimes type before `bound`: rebased behind the bind merge
	const pos = (v: SimEditorView) => rng.int(v.getText().length + 1);
	let aEdits = 0;
	let atBound: number | null = null;
	const tick = async (ms: number) => {
		await clock.advance(ms);
		if (atBound === null && bm.slotState(a.viewId) === "bound" && bm.slotState(b.viewId) === "bound") atBound = engine.count("textChunk");
	};

	// Phase 1: concurrent inserts and deletes (A only inserts: its characters are uppercase).
	for (let i = 0; i < steps; i++) {
		const r = rng.int(10);
		if (r < 3 && aEdits < 150) {
			a.edit(pos(a), 0, token(rng, "ABCDEFGHIJ", 1 + rng.int(3)));
			aEdits++;
		} else if (r < 6 && atBound !== null) {
			// B types once both views are bound: before that, Obsidian's quick preview would copy B's text into A
			// as a plain (undoable) setViewData, which is Obsidian's history, not this binding's.
			const at = pos(b);
			if (rng.int(3) === 0) b.edit(at, 1 + rng.int(4), "");
			else b.edit(at, 0, `(${token(rng, "bcdfg", 1 + rng.int(2))})`);
		} else if (r < 9 && atBound !== null) {
			// Replica changes before the binds would make the bind merges conflict (the editor side then goes to a
			// conflict copy and may come back through the sibling's upload as merged text): engine-side, tested there.
			const len = engine.text(PATH).length;
			const at = rng.int(len + 1);
			if (rng.int(3) === 0) engine.remote(PATH, at, at + 1 + rng.int(4), "");
			else engine.remote(PATH, at, at, `(${token(rng, "0123456789", 1 + rng.int(2))})`);
		}
		await tick(rng.int(4) === 0 ? rng.int(120) : rng.int(8));
	}
	await tick(10_000);
	const phase1 = converged(w, a, b, atBound, `seed ${seed} phase 1`);

	// Phase 2: A undoes everything it did; B and the replica only insert meanwhile.
	let undos = 0;
	for (let i = 0; undos < aEdits && i < steps * 4; i++) {
		const r = rng.int(10);
		if (r < 4) {
			assert.ok(a.undo(), `seed ${seed}: A has history left (${undos}/${aEdits})`);
			undos++;
		} else if (r < 7) b.edit(pos(b), 0, `<${token(rng, "bcdfg", 1 + rng.int(2))}>`);
		else if (r < 9) {
			const at = rng.int(engine.text(PATH).length + 1);
			engine.remote(PATH, at, at, `<${token(rng, "0123456789", 1 + rng.int(2))}>`);
		}
		await tick(rng.int(4) === 0 ? rng.int(120) : rng.int(8));
	}
	assert.equal(undos, aEdits, `seed ${seed}: every A edit undone`);
	assert.equal(a.undo(), false, `seed ${seed}: A's history is empty`);
	await clock.advance(10_000);
	const phase2 = converged(w, a, b, atBound, `seed ${seed} phase 2`);
	assert.equal(phase2.match(UPPER), null, `seed ${seed}: none of A's characters survive its undo`);
	assert.equal(stripPhase2(phase2), phase1.replace(UPPER, ""), `seed ${seed}: undo removed exactly A's characters`);
	assert.ok(b.counters.undos === 0 && a.counters.undos === undos);
	return { rejects: bm.stats.rejects, pushes: bm.stats.pushes, undos };
}

test("binding fuzz: split views + remote changes + delays converge; undo undoes local edits only", async () => {
	let rejects = 0;
	let pushes = 0;
	let undos = 0;
	const seeds = Number(process.env.YAOS_FUZZ_SEEDS ?? 40); // more: YAOS_FUZZ_SEEDS=1000
	for (let seed = 1; seed <= seeds; seed++) {
		const r = await run(seed, 250);
		rejects += r.rejects;
		pushes += r.pushes;
		undos += r.undos;
	}
	assert.ok(pushes > 1000, `pushes ${pushes}`);
	assert.ok(rejects > 50, `the reject/rebase path ran (${rejects} rejects)`);
	assert.ok(undos > 500, `undos ${undos}`);
	if (process.env.YAOS_FUZZ_SEEDS) console.log(`fuzz: ${seeds} seeds, ${pushes} pushes, ${rejects} rejects, ${undos} undos`);
});
