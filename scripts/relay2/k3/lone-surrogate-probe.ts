// K3 side finding: lone surrogates (split UTF-16 pairs) through each byte-op backend.
import * as Y from "yjs";
import { ywasmStatelessByteOps as c, ywasmTransientDocByteOps as a } from "../../../server/src/crdt/ywasmByteOps";
const A = new Y.Doc(); A.clientID = 1; const B = new Y.Doc(); B.clientID = 2;
const ups: Uint8Array[] = [];
for (const d of [A, B]) d.on("update", (u: Uint8Array, _o: unknown, _d: Y.Doc, t: Y.Transaction) => { if (t.local) ups.push(u); });
A.getText("t").insert(0, "x😀y");
Y.applyUpdate(B, Y.encodeStateAsUpdate(A));
A.getText("t").delete(2, 1); // removes the low surrogate only
B.getText("t").insert(2, "Z"); // concurrent insert between the surrogates
const ref = new Y.Doc(); ups.forEach((u) => Y.applyUpdate(ref, u));
const show = (s: string) => JSON.stringify([...s].map((ch) => ch.codePointAt(0)!.toString(16)));
const text = (u: Uint8Array) => { const d = new Y.Doc(); Y.applyUpdate(d, u); return d.getText("t").toString(); };
console.log("yjs reference      ", show(ref.getText("t").toString()));
console.log("js mergeUpdates    ", show(text(Y.mergeUpdates(ups))));
console.log("(a) transient diff ", show(text(a.diffUpdate(Y.mergeUpdates(ups), Uint8Array.of(0)))));
console.log("(a) merge          ", show(text(a.mergeUpdates(ups))));
console.log("(c) merge          ", show(text(c.mergeUpdates(ups))));
console.log("(c) diff           ", show(text(c.diffUpdate(Y.mergeUpdates(ups), Uint8Array.of(0)))));
