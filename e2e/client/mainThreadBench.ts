/**
 * Main-thread cost per keystroke and per remote update on a ~1 MB note (DESIGN §d.3), before and after the
 * main-thread rework. Offline (no relay, no worker): only main-thread work is timed, the worker side runs untimed.
 * The editor in both is a real @codemirror/state EditorState (Obsidian's editor minus the DOM, whose cost is the
 * same either way); posts are structuredClone'd (postMessage serializes on the sending thread).
 *
 *  - before (6f7129b, where the host/ lines cited here are): a Yjs replica on main bound through y-codemirror.next
 *    0.3.5 with a Y.UndoManager (host/collab.ts:34-35). Keystroke: y-sync update() applies the transaction to the
 *    Y.Text (src/y-sync.js:132-152), the replica update is copied and posted (host/binding.ts:470-498). Remote
 *    update: Y.applyUpdate on main (host/binding.ts:231-239), then y-sync's observer reads event.delta and
 *    dispatches (src/y-sync.js:107-125). Bind: worker state applied on main plus its toString (host/binding.ts:380-382).
 *  - after: the real BindingManager (host/binding.ts, host/bodyClient.ts) over the EditorState, with the sim
 *    worker (sim/bodyEngine.ts) answering. Keystroke: the transaction's ChangeSet to onLocal, the coalesced push
 *    (toJSON + post), and the confirming entry. Remote update: the entry (fromJSON, mirror apply, rebase, dispatch).
 *
 *   node --import jiti/register e2e/client/mainThreadBench.ts [--kb 1024] [--keys 2000] [--remotes 2000] [--fragments 20000]
 */
import { EditorState, Transaction, type ChangeSpec } from "@codemirror/state";
import * as Y from "yjs";
import type { DocId, VaultPath } from "../../src/core/types";
import { MAIN_UPDATE_COALESCE_MS } from "../../src/core/limits";
import { BindingManager } from "../../src/host/binding";
import type { ClockPort } from "../../src/ports/clock";
import type { EditorBinding, EditorBindingSpec, EditorViewRef, WorkspacePort } from "../../src/ports/workspace";
import { TEXT_CHUNK_UNITS, encodeUtf16 } from "../../src/protocol/utf16";
import { SimBodyEngine } from "../../src/sim/bodyEngine";
import { VirtualClock } from "../../src/sim/clock";

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const KB = arg("kb", 1024);
const KEYS = arg("keys", 2000);
const REMOTES = arg("remotes", 2000);
const FRAGMENTS = arg("fragments", 20_000);
const PATH = "bench.md";
const now = () => performance.now();

function rng(seed: number): (n: number) => number {
	let s = seed >>> 0;
	return (n) => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
	};
}

function makeNote(chars: number): string {
	const r = rng(42);
	const words = ["sync", "vault", "note", "merge", "editor", "worker", "replica", "change", "text", "line", "alpha", "beta", "gamma"];
	const out: string[] = [];
	for (let n = 0; n < chars; ) {
		let line = r(20) === 0 ? "## " : r(5) === 0 ? "- " : "";
		for (let i = 4 + r(14); i > 0; i--) line += `${words[r(words.length)]} `;
		line = `${line.trimEnd()}\n`;
		out.push(line);
		n += line.length;
	}
	return out.join("");
}

/** The edit trace both variants replay: typing runs of 20 keys at random places, remote single-char inserts. */
function trace(seed: number) {
	const r = rng(seed);
	let run = 0;
	let at = 0;
	return {
		key(len: number): { at: number; ch: string } {
			if (run === 0) {
				at = r(len + 1);
				run = 20;
			}
			run--;
			return { at: Math.min(at++, len), ch: String.fromCharCode(97 + r(26)) };
		},
		remote(len: number): { at: number; ch: string } {
			return { at: r(len + 1), ch: String.fromCharCode(48 + r(10)) };
		},
	};
}

interface Stats { readonly n: number; readonly meanUs: number; readonly p50Us: number; readonly p99Us: number; readonly maxUs: number }
function stats(ms: number[]): Stats {
	const s = [...ms].sort((a, b) => a - b);
	const q = (p: number) => Math.round((s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0) * 1000);
	return { n: s.length, meanUs: Math.round((s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)) * 1000), p50Us: q(0.5), p99Us: q(0.99), maxUs: q(1) };
}

const REMOTE = { remote: true };
const cmRemote = (s: EditorState, changes: ChangeSpec) =>
	s.update({ changes, annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)], filter: false }).state;

/** Replays the trace: ops alternate key/remote, the first WARM of each are warm-up (not recorded). */
const WARM = 200;
async function replay(key: () => Promise<number> | number, remote: () => Promise<number> | number) {
	const keys: number[] = [];
	const remotes: number[] = [];
	for (let k = 0, r = 0; k < KEYS + WARM || r < REMOTES + WARM; ) {
		if (k < KEYS + WARM && (k <= r || r >= REMOTES + WARM)) {
			const ms = await key();
			if (k++ >= WARM) keys.push(ms);
		} else {
			const ms = await remote();
			if (r++ >= WARM) remotes.push(ms);
		}
	}
	return { keystroke: stats(keys), remoteUpdate: stats(remotes) };
}

async function before(note: string) {
	// Worker side (untimed): the replica with an edit history (scattered inserts = many Yjs items, a note edited over time).
	const W = new Y.Doc();
	const wt = W.getText("text");
	wt.insert(0, note);
	const r = rng(7);
	for (let i = 0; i < FRAGMENTS; i++) wt.insert(r(wt.length + 1), "~");
	let fromWorker: Uint8Array | null = null;
	W.on("update", (u: Uint8Array, origin: unknown) => void (origin !== REMOTE && (fromWorker = u)));
	const bindState = Y.encodeStateAsUpdate(W);
	const M = new Y.Doc();
	const mt = M.getText("text");
	const b0 = now();
	Y.applyUpdate(M, structuredClone(bindState), REMOTE);
	let state = EditorState.create({ doc: mt.toString() });
	const bindMs = now() - b0;
	const conf = {}; // y-sync's YSyncConfig: the origin of the editor's own Y transactions
	const um = new Y.UndoManager(mt, { trackedOrigins: new Set([conf]) });
	mt.observe((event, tr) => {
		if (tr.origin === conf) return;
		const delta = event.delta;
		const changes: ChangeSpec[] = [];
		let pos = 0;
		for (const d of delta) {
			if (d.insert != null) changes.push({ from: pos, to: pos, insert: d.insert as string });
			else if (d.delete != null) {
				changes.push({ from: pos, to: pos + d.delete, insert: "" });
				pos += d.delete;
			} else pos += d.retain ?? 0;
		}
		state = state.update({ changes }).state;
	});
	const pending: Uint8Array[] = [];
	M.on("update", (u: Uint8Array, origin: unknown) => void (origin !== REMOTE && pending.push(u.slice())));
	const t = trace(1);
	const res = await replay(() => {
		const { at, ch } = t.key(state.doc.length);
		const k0 = now();
		const tr = state.update({ changes: { from: at, insert: ch }, userEvent: "input.type" });
		state = tr.state;
		M.transact(() => {
			let adj = 0;
			tr.changes.iterChanges((fromA, toA, _fromB, _toB, ins) => {
				const s = ins.sliceString(0, ins.length, "\n");
				if (fromA !== toA) mt.delete(fromA + adj, toA - fromA);
				if (s.length > 0) mt.insert(fromA + adj, s);
				adj += s.length - (toA - fromA);
			});
		}, conf);
		// The coalesce timer (MAIN_UPDATE_COALESCE_MS): paced typing posts one update per keystroke.
		const parts = pending.splice(0);
		const update = parts.length === 1 ? (parts[0] as Uint8Array) : Y.mergeUpdates(parts);
		structuredClone({ t: "localUpdate", docId: "d", update, origin: "editor" });
		const ms = now() - k0;
		Y.applyUpdate(W, update, REMOTE); // the worker (untimed)
		return ms;
	}, () => {
		const { at, ch } = t.remote(wt.length);
		wt.insert(at, ch); // another device's edit, applied by the worker (untimed)
		const u = fromWorker as unknown as Uint8Array;
		const r0 = now();
		const msg = structuredClone({ t: "docUpdate", docId: "d", update: u });
		Y.applyUpdate(M, msg.update, REMOTE);
		structuredClone({ t: "docCredit", bytes: u.byteLength });
		return now() - r0;
	});
	const ok = state.doc.length === mt.length && state.doc.toString() === mt.toString() && mt.toString() === wt.toString();
	um.destroy();
	return { ...res, bind: { mainMs: Math.round(bindMs), tasks: 1 }, items: countItems(mt), converged: ok };
}

function countItems(t: Y.Text): number {
	let n = 0;
	for (let it = t._start; it !== null; it = it.right) n++;
	return n;
}

/** An EditorViewRef over an EditorState: what host/collab.ts does on a real EditorView, minus the DOM. */
class BenchView implements EditorViewRef {
	readonly viewId = 1;
	readonly path = PATH as VaultPath;
	private spec: EditorBindingSpec | null = null;
	constructor(public state: EditorState) {}
	hasEditor(): boolean {
		return true;
	}
	editorDoc() {
		return this.state.doc;
	}
	isDirty(): boolean {
		return false;
	}
	lastSavedText(): string | null {
		return null;
	}
	bind(spec: EditorBindingSpec): EditorBinding {
		this.spec = spec;
		return { doc: () => this.state.doc, applyRemote: (c) => void (this.state = cmRemote(this.state, c)), detach: () => void (this.spec = null) };
	}
	interceptExternalReload() {
		return () => undefined;
	}
	holdSaves(): boolean {
		return false;
	}
	async save(): Promise<void> {}
	/** A keystroke: the transaction, then its ChangeSet to the binding (collab.ts ViewPlugin.update). */
	type(at: number, ch: string): void {
		const tr = this.state.update({ changes: { from: at, insert: ch }, userEvent: "input.type" });
		this.state = tr.state;
		this.spec?.onLocal(tr.changes);
	}
}

async function after(note: string) {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const engine = new SimBodyEngine(clock);
	engine.add(PATH, note);
	let main = 0; // main-thread ms spent in the binding's timers and body events
	const timed = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
		const t0 = now();
		try {
			fn(...a);
		} finally {
			main += now() - t0;
		}
	};
	const clockT: ClockPort = { now: () => clock.now(), monotonic: () => clock.monotonic(), setTimer: (ms, fn) => clock.setTimer(ms, timed(fn)),
		clearTimer: (h) => clock.clearTimer(h), yieldNow: () => clock.yieldNow() };
	const link = { ...engine.link, post: (m: Parameters<typeof engine.link.post>[0]) => {
		structuredClone(m);
		engine.link.post(m);
	} };
	const view = new BenchView(EditorState.create({ doc: note }));
	const ws: WorkspacePort = { listMarkdownViews: () => [view], onViewEvent: () => () => undefined };
	const bm = new BindingManager({ workspace: ws, vault: { caseInsensitive: false }, clock: clockT, link, notice: () => undefined });
	const onBody = bm.onBody.bind(bm);
	bm.onBody = timed((...a: Parameters<BindingManager["onBody"]>) => onBody(a[0], structuredClone(a[1]), a[2]));
	engine.bm = bm;
	bm.start();
	await clock.advance(1_000);
	if (bm.slotState(view.viewId) !== "bound") throw new Error("bench view did not bind");
	// Bind on main: the editor text goes up in TEXT_CHUNK_UNITS slices, one task each (binding.ts upload); the merge is the worker's.
	let chunkMax = 0;
	let chunks = 0;
	const doc = view.state.doc;
	for (let at = 0; at < doc.length; at += TEXT_CHUNK_UNITS, chunks++) {
		const c0 = now();
		structuredClone({ t: "textChunk", bytes: encodeUtf16(doc.sliceString(at, Math.min(doc.length, at + TEXT_CHUNK_UNITS))) });
		chunkMax = Math.max(chunkMax, now() - c0);
	}
	const replica = () => (engine.docs.get(PATH) as { text: { length: number } }).text.length;
	const t = trace(1);
	const res = await replay(async () => {
		const { at, ch } = t.key(view.state.doc.length);
		const m0 = main;
		const k0 = now();
		view.type(at, ch);
		const sync = now() - k0;
		await clock.advance(MAIN_UPDATE_COALESCE_MS + 1); // the push timer, the worker, the confirming entry
		return sync + main - m0;
	}, async () => {
		const { at, ch } = t.remote(replica());
		const m0 = main;
		engine.remote(PATH, at, at, ch); // another device's edit, applied by the worker (untimed)
		await clock.advance(1);
		return main - m0;
	});
	const ok = view.state.doc.toString() === engine.text(PATH) && bm.stats.resyncs === 0;
	return { ...res, bind: { maxTaskMs: Math.round(chunkMax * 100) / 100, tasks: chunks }, converged: ok };
}

/** The editor's own transaction cost (common to both variants). */
function editorOnly(note: string) {
	let state = EditorState.create({ doc: note });
	const t = trace(1);
	return replaySync(() => {
		const { at, ch } = t.key(state.doc.length);
		const k0 = now();
		state = state.update({ changes: { from: at, insert: ch } }).state;
		return now() - k0;
	}, () => {
		const { at, ch } = t.remote(state.doc.length);
		const r0 = now();
		state = cmRemote(state, { from: at, insert: ch });
		return now() - r0;
	});
}
const replaySync = (k: () => number, r: () => number) => replay(k, r);

const note = makeNote(KB * 1024);
const result = { kb: KB, chars: note.length, fragments: FRAGMENTS, before: await before(note), after: await after(note), editorOnly: await editorOnly(note) };
const row = (name: string, s: Stats) => `${name.padEnd(28)} mean ${String(s.meanUs).padStart(6)}us  p50 ${String(s.p50Us).padStart(6)}us  p99 ${String(s.p99Us).padStart(6)}us  max ${String(s.maxUs).padStart(7)}us`;
console.log([
	`main-thread bench: ${result.chars} chars, ${result.before.items} Yjs items in the before replica, ${KEYS} keys, ${REMOTES} remote updates`,
	row("before keystroke", result.before.keystroke), row("after keystroke", result.after.keystroke), row("editor-only keystroke", result.editorOnly.keystroke),
	row("before remote update", result.before.remoteUpdate), row("after remote update", result.after.remoteUpdate), row("editor-only remote update", result.editorOnly.remoteUpdate),
	`bind: before one ${result.before.bind.mainMs} ms task; after ${result.after.bind.tasks} upload tasks, max ${result.after.bind.maxTaskMs} ms`,
	`converged: before ${result.before.converged}, after ${result.after.converged}`,
].join("\n"));
if (process.argv.includes("--json")) console.log(JSON.stringify(result));
if (!result.before.converged || !result.after.converged) process.exit(1);
