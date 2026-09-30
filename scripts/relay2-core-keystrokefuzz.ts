/** Relay v2 server-core probe: exact-path byte merge over a long mid-insert keystroke run (MB burst/l2 shape). */
import * as Y from "yjs";
import { mergeUpdates, stateVectorFromUpdate, stateVectorsEqual } from "../server/src/crdt/ywasmByteOps";
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const results: unknown[] = [];
for (const n of [61, 241, 2000]) {
	const doc = new Y.Doc();
	const text = doc.getText("body");
	const updates: Uint8Array[] = [];
	doc.on("update", (u: Uint8Array) => updates.push(u));
	text.insert(0, "# note\n\n" + "lorem ipsum dolor sit amet ".repeat(9));
	let merged = mergeUpdates([updates[0]!]);
	let noops = 0, errors = 0, svDrift = 0, t = 0;
	for (let i = 0; i < n; i++) {
		text.insert(Math.floor(text.length / 2), String.fromCharCode(97 + (i % 26)));
		const u = updates.at(-1)!;
		const t0 = performance.now();
		try {
			const next = mergeUpdates([merged, u]);
			if (same(next, merged)) noops++;
			if (!stateVectorsEqual(stateVectorFromUpdate(next), Y.encodeStateVector(doc))) svDrift++;
			merged = next;
		} catch { errors++; }
		t += performance.now() - t0;
	}
	const replay = new Y.Doc(); Y.applyUpdate(replay, merged);
	results.push({ n, noops, errors, svDrift, textOk: replay.getText("body").toString() === text.toString(), bytes: merged.length, msPerFrame: +(t / n).toFixed(3) });
}
console.log(JSON.stringify(results));
