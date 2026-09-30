/** Relay v2 server-core probe: does the ywasm byte merge keep an update with a causal gap? */
import * as Y from "yjs";
import { mergeUpdates, stateVectorFromUpdate, decodeStateVector, defaultYwasmByteOps, ywasmStatelessByteOpsAvailable } from "../server/src/crdt/ywasmByteOps";
const doc = new Y.Doc();
const text = doc.getText("body");
const updates: Uint8Array[] = [];
doc.on("update", (u: Uint8Array) => updates.push(u));
text.insert(0, "hello world");
for (let i = 0; i < 6; i++) text.insert(Math.floor(text.length / 2), String.fromCharCode(97 + i));
const [seed, u1, u2, u3] = updates;
const merged = mergeUpdates([seed!, u1!]);
const withGap = mergeUpdates([merged, u3!]);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const replay = (bytes: Uint8Array) => { const d = new Y.Doc(); Y.applyUpdate(d, bytes); return d; };
const late = mergeUpdates([withGap, u2!]);
const d = replay(late);
console.log(JSON.stringify({
	stateless: ywasmStatelessByteOpsAvailable,
	gapMergeIdentical: same(withGap, merged),
	mergedLen: merged.length, withGapLen: withGap.length,
	svMerged: [...decodeStateVector(stateVectorFromUpdate(merged))],
	svWithGap: [...decodeStateVector(stateVectorFromUpdate(withGap))],
	lateFillTextOk: d.getText("body").toString() === (() => { const x = new Y.Doc(); for (const u of updates.slice(0, 4)) Y.applyUpdate(x, u); return x.getText("body").toString(); })(),
	yjsMergeGapIdentical: same(Y.mergeUpdates([merged, u3!]), merged),
}));
void defaultYwasmByteOps;
