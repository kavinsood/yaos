// b3-ckpt: wasm linear-memory high-water over a steady A1 whole-rewrite sequence in ONE process (local, node).
//   memloop.ts <mode> [saves=120] [noteBytes=50000]
// mode: pre   = pre-a1fix server shape: byte-merged state grows by every save; per save one merge (rebuild),
//               one SV, and the lazy-hash materialisation (openDocument + readText) while state <= 3 MiB;
//       a1fix = same, but the state is GC re-encoded every 2 saves (the checkpoint cadence measured at 51876ee);
//       ckpt  = this branch: GC re-encode only when the merged bytes pass 256 KiB (exact-merge window kept).
import * as Y from "yjs";
import { ywasmCrdtEngine as engine } from "@yaos/crdt-engine";
import { mergeUpdates, stateVectorFromUpdate, ywasmLinearMemoryBytes } from "../../server/src/crdt/ywasmByteOps";

const [mode = "pre", savesArg = "120", noteArg = "50000"] = process.argv.slice(2);
const saves = Number(savesArg), noteBytes = Number(noteArg);
const doc = new Y.Doc();
let pending: Uint8Array | null = null;
doc.on("update", (u: Uint8Array) => { pending = u; });
const line = (i: number, s: number) => `line ${i} of save ${s} lorem ipsum dolor sit amet consectetur\n`;
const version = (s: number) => { let t = ""; for (let i = 0; t.length < noteBytes; i++) t += line(i, s); return t.slice(0, noteBytes); };
const rewrite = (s: number) => { doc.transact(() => { const t = doc.getText("body"); t.delete(0, t.length); t.insert(0, version(s)); }); return pending!; };
const gc = (bytes: Uint8Array) => { const d = engine.openDocument("gc", bytes); try { return engine.encodeStateAsUpdate(d); } finally { engine.destroyDocument(d); } };
let state = rewrite(0);
const marks: Array<{ save: number; stateKB: number; wasmMB: number; rssMB: number }> = [];
let maxMs = 0;
for (let s = 1; s <= saves; s++) {
	const u = rewrite(s);
	const t0 = performance.now();
	state = mergeUpdates([state, u]);
	stateVectorFromUpdate(state);
	if (mode === "a1fix" && s % 2 === 0) state = gc(state);
	if (mode === "ckpt" && state.byteLength > 256 * 1024) state = gc(state);
	if (state.byteLength <= 3 * 1024 * 1024) { const d = engine.openDocument("hash", state); engine.readText(d, "body"); engine.destroyDocument(d); }
	maxMs = Math.max(maxMs, performance.now() - t0);
	if (s % 20 === 0 || s === saves) marks.push({ save: s, stateKB: Math.round(state.byteLength / 1024),
		wasmMB: Math.round(ywasmLinearMemoryBytes() / 1048576 * 10) / 10, rssMB: Math.round(process.memoryUsage().rss / 1e6) });
}
console.log(JSON.stringify({ mode, saves, noteBytes, maxMsPerSave: Math.round(maxMs * 10) / 10, marks }));
