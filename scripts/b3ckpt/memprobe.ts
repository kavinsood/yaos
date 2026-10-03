// b3-ckpt: peak memory per server CRDT operation on a large byte-merged body state (local, node).
// Wasm linear memory never shrinks, so each op runs in a fresh process:
//   memprobe.ts <op> <saves> [noteBytes=50000]
// op: merge (checkpoint+update byte merge) | sv (state vector from update) | gc (openDocument+encodeStateAsUpdate,
//     the a1fix checkpoint GC) | text (openDocument + read text: the lazy hash materialisation) | rebuild3 (3 x merge
//     in a row, as checkpoint+cache+probe can) | none
// Prints JSON: state bytes, wasm linear memory before/after (high-water), JS heap/arrayBuffers deltas, ms.
import * as Y from "yjs";
import { ywasmCrdtEngine as engine } from "@yaos/crdt-engine";
import { mergeUpdates, stateVectorFromUpdate, ywasmLinearMemoryBytes } from "../../server/src/crdt/ywasmByteOps";

const [op = "none", savesArg = "120", noteArg = "50000"] = process.argv.slice(2);
const saves = Number(savesArg), noteBytes = Number(noteArg);
const doc = new Y.Doc();
const updates: Uint8Array[] = [];
doc.on("update", (u: Uint8Array) => updates.push(u));
const line = (i: number, s: number) => `line ${i} of save ${s} lorem ipsum dolor sit amet consectetur\n`;
const version = (s: number) => { let t = ""; for (let i = 0; t.length < noteBytes; i++) t += line(i, s); return t.slice(0, noteBytes); };
for (let s = 0; s <= saves; s++) doc.transact(() => { const t = doc.getText("body"); t.delete(0, t.length); t.insert(0, version(s)); });
const state = Y.mergeUpdates(updates.slice(0, -1)); // byte-merged checkpoint (keeps deleted content), pre-a1fix shape
const last = updates.at(-1)!;
updates.length = 0;
(globalThis as { gc?: () => void }).gc?.();
const m0 = process.memoryUsage();
const w0 = ywasmLinearMemoryBytes();
let peakHeap = m0.heapUsed, peakAB = m0.arrayBuffers;
const sample = () => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakAB = Math.max(peakAB, m.arrayBuffers); };
const t0 = performance.now();
let out = 0;
const merge = () => { const r = mergeUpdates([state, last]); sample(); return r; };
switch (op) {
	case "merge": out = merge().byteLength; break;
	case "rebuild3": { const a = merge(); const b = mergeUpdates([a, last]); sample(); const c = stateVectorFromUpdate(b); sample(); out = a.byteLength + b.byteLength + c.byteLength; break; }
	case "sv": out = stateVectorFromUpdate(state).byteLength; sample(); break;
	case "gc": { const d = engine.openDocument("probe", state); sample(); const e = engine.encodeStateAsUpdate(d); sample(); engine.destroyDocument(d); out = e.byteLength; break; }
	case "text": { const d = engine.openDocument("probe", state); sample(); out = engine.readText(d, "body").length; sample(); engine.destroyDocument(d); break; }
	case "none": break;
	default: throw new Error(`unknown op ${op}`);
}
const ms = performance.now() - t0;
const w1 = ywasmLinearMemoryBytes();
console.log(JSON.stringify({ op, saves, noteBytes, stateBytes: state.byteLength, updateBytes: last.byteLength, out,
	wasmBefore: w0, wasmAfter: w1, wasmGrowth: w1 - w0, jsHeapPeakDelta: peakHeap - m0.heapUsed,
	arrayBuffersPeakDelta: peakAB - m0.arrayBuffers, rss: process.memoryUsage().rss, ms: Math.round(ms * 10) / 10 }));
