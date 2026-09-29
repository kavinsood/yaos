// Relay v2 spike (D4): the byte-level update ops must agree semantically across
// JS yjs (reference, option b), ywasm transient doc (option a) and ywasm
// stateless patch-0003 exports (option c).
import assert from "node:assert/strict";
import * as Y from "yjs";
import {
	type ByteOps,
	EMPTY_UPDATE_V1,
	decodeStateVector,
	stateVectorCoveredBy,
	stateVectorsEqual,
	ywasmStatelessByteOps,
	ywasmStatelessByteOpsAvailable,
	ywasmTransientDocByteOps,
	defaultYwasmByteOps,
	ywasmLinearMemoryBytes,
} from "../../server/src/crdt/ywasmByteOps";
import { suite } from "../harness.ts";

const s = suite("relay2-byteops");

const jsYjsByteOps: ByteOps = {
	name: "js-yjs",
	mergeUpdates: (updates) => Y.mergeUpdates([...updates]),
	stateVectorFromUpdate: (update) => Y.encodeStateVectorFromUpdate(update),
	diffUpdate: (update, sv) => Y.diffUpdate(update, sv),
};

const backends: ByteOps[] = [jsYjsByteOps, ywasmTransientDocByteOps, ywasmStatelessByteOps];

function rng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13; state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5; state >>>= 0;
		return state / 0x1_0000_0000;
	};
}

interface History {
	/** Locally-originated updates in emission order (every prefix is causally closed). */
	readonly updates: Uint8Array[];
	readonly deleteOnly: Uint8Array[];
}

/** Never split a surrogate pair (real editors don't; see K3.md lone-surrogate note). */
function safeIndex(value: string, index: number): number {
	const code = value.charCodeAt(index - 1);
	return index > 0 && code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

function randomHistory(seed: number, clients: number, steps: number): History {
	const random = rng(seed);
	const docs = Array.from({ length: clients }, (_, index) => {
		const doc = new Y.Doc();
		doc.clientID = 1000 + index * 7919 + seed;
		return doc;
	});
	const updates: Uint8Array[] = [];
	const deleteOnly: Uint8Array[] = [];
	for (const doc of docs) {
		doc.on("update", (update: Uint8Array, _origin: unknown, _doc: Y.Doc, txn: Y.Transaction) => {
			if (!txn.local) return;
			updates.push(update);
			if ([...txn.afterState].every(([client, clock]) => (txn.beforeState.get(client) ?? 0) === clock)) {
				deleteOnly.push(update);
			}
		});
	}
	// code points, not UTF-16 units: editors never emit lone surrogates
	const alphabet = Array.from("abcdefgh ijklmnop\n中文😀é");
	for (let step = 0; step < steps; step++) {
		const doc = docs[Math.floor(random() * clients)]!;
		const text = doc.getText("body");
		const roll = random();
		if (roll < 0.55 || text.length === 0) {
			const at = safeIndex(text.toString(), Math.floor(random() * (text.length + 1)));
			const length = 1 + Math.floor(random() * 6);
			let value = "";
			for (let index = 0; index < length; index++) value += alphabet[Math.floor(random() * alphabet.length)];
			text.insert(at, value);
		} else if (roll < 0.85) {
			const current = text.toString();
			const at = safeIndex(current, Math.floor(random() * text.length));
			const end = safeIndex(current, Math.min(text.length, at + 1 + Math.floor(random() * 4)));
			if (end > at) text.delete(at, end - at);
		} else if (roll < 0.9) {
			doc.getMap("meta").set(`k${Math.floor(random() * 4)}`, step);
		} else {
			// sync a random pair (remote-origin updates are not recorded)
			const other = docs[Math.floor(random() * clients)]!;
			if (other !== doc) {
				Y.applyUpdate(other, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(other)), "sync");
				Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)), "sync");
			}
		}
	}
	return { updates, deleteOnly };
}

function docFrom(updates: readonly Uint8Array[]): Y.Doc {
	const doc = new Y.Doc();
	for (const update of updates) Y.applyUpdate(doc, update);
	return doc;
}

function fingerprint(doc: Y.Doc): string {
	const meta = doc.getMap("meta").toJSON();
	return JSON.stringify({ body: doc.getText("body").toString(), meta: Object.keys(meta).sort().map((key) => [key, meta[key]]) });
}

function checkHistory(label: string, history: History, random: () => number): void {
	const reference = docFrom(history.updates);
	const expected = fingerprint(reference);
	const expectedSv = Y.encodeStateVector(reference);
	for (const ops of backends) {
		const merged = ops.mergeUpdates(history.updates);
		const fresh = docFrom([merged]);
		assert.equal(fingerprint(fresh), expected, `${label}/${ops.name}: merged text`);
		assert.ok(stateVectorsEqual(ops.stateVectorFromUpdate(merged), expectedSv), `${label}/${ops.name}: SV from merged`);
		for (let trial = 0; trial < 3; trial++) {
			const cut = Math.floor(random() * (history.updates.length + 1));
			const prefix = history.updates.slice(0, cut);
			const partial = docFrom(prefix);
			// SV from the peer's doc, and SV computed byte-level from the peer's merged prefix
			const peerSv = Y.encodeStateVector(partial);
			const bytePrefixSv = ops.stateVectorFromUpdate(ops.mergeUpdates(prefix));
			assert.ok(stateVectorsEqual(peerSv, bytePrefixSv), `${label}/${ops.name}: prefix SV @${cut}`);
			const diff = ops.diffUpdate(merged, bytePrefixSv);
			Y.applyUpdate(partial, diff);
			assert.equal(fingerprint(partial), expected, `${label}/${ops.name}: diff @${cut} converges`);
			assert.ok(stateVectorsEqual(Y.encodeStateVector(partial), expectedSv), `${label}/${ops.name}: SV after diff @${cut}`);
			// checkpoint + tail re-merge (relay compaction shape)
			const checkpoint = ops.mergeUpdates(prefix);
			const remerged = ops.mergeUpdates([checkpoint, ...history.updates.slice(cut)]);
			assert.equal(fingerprint(docFrom([remerged])), expected, `${label}/${ops.name}: checkpoint+tail @${cut}`);
		}
		// full diff against empty SV == full state
		assert.equal(fingerprint(docFrom([ops.diffUpdate(merged, Uint8Array.of(0))])), expected, `${label}/${ops.name}: diff vs empty SV`);
		// diff against own SV carries no structs (may still carry the delete set)
		const selfDiff = ops.diffUpdate(merged, expectedSv);
		assert.equal(decodeStateVector(Y.encodeStateVectorFromUpdate(selfDiff)).size, 0, `${label}/${ops.name}: self diff has no structs`);
	}
}

s.check(ywasmStatelessByteOpsAvailable, "loaded ywasm artifact carries patch 0003 (option c)");
s.check(defaultYwasmByteOps === ywasmStatelessByteOps, "default backend is stateless (c)");

s.test("random multi-client histories agree across js-yjs, ywasm transient doc, ywasm stateless", () => {
	const random = rng(0xbeef);
	for (let seed = 1; seed <= 24; seed++) {
		const clients = 1 + (seed % 4);
		const history = randomHistory(seed, clients, 40 + seed * 12);
		checkHistory(`seed${seed}`, history, random);
	}
});

s.test("delete-set-only updates", () => {
	const doc = new Y.Doc();
	doc.clientID = 42;
	const text = doc.getText("body");
	text.insert(0, "hello world");
	const base = Y.encodeStateAsUpdate(doc);
	const before = Y.encodeStateVector(doc);
	text.delete(0, 6);
	const deleteOnly = Y.encodeStateAsUpdate(doc, before);
	assert.equal(decodeStateVector(Y.encodeStateVectorFromUpdate(deleteOnly)).size, 0, "fixture is delete-set-only");
	for (const ops of backends) {
		assert.equal(decodeStateVector(ops.stateVectorFromUpdate(deleteOnly)).size, 0, `${ops.name}: SV of delete-only is empty`);
		const merged = ops.mergeUpdates([base, deleteOnly]);
		assert.equal(docFrom([merged]).getText("body").toString(), "world", `${ops.name}: merge base+delete`);
		const mergedDeletes = ops.mergeUpdates([deleteOnly, deleteOnly]);
		const target = docFrom([base]);
		Y.applyUpdate(target, mergedDeletes);
		assert.equal(target.getText("body").toString(), "world", `${ops.name}: merged delete-only applies`);
		// A peer already at the struct SV must still receive the delete set via diff.
		const peer = docFrom([base]);
		Y.applyUpdate(peer, ops.diffUpdate(merged, Y.encodeStateVector(peer)));
		assert.equal(peer.getText("body").toString(), "world", `${ops.name}: diff carries delete set`);
		assert.ok(stateVectorsEqual(ops.stateVectorFromUpdate(merged), before), `${ops.name}: SV unchanged by delete`);
	}
	// histories: every recorded delete-only update behaves the same
	const history = randomHistory(7, 3, 400);
	s.check(history.deleteOnly.length > 0, "random history produced delete-only updates");
	for (const update of history.deleteOnly) {
		for (const ops of backends) {
			assert.equal(decodeStateVector(ops.stateVectorFromUpdate(update)).size, 0, `${ops.name}: random delete-only SV empty`);
		}
	}
});

s.test("empty updates [0,0] and empty input lists", () => {
	for (const ops of backends) {
		const merged = ops.mergeUpdates([]);
		assert.deepEqual([...merged], [...EMPTY_UPDATE_V1], `${ops.name}: merge([]) = [0,0]`);
		assert.equal(decodeStateVector(ops.stateVectorFromUpdate(EMPTY_UPDATE_V1)).size, 0, `${ops.name}: SV([0,0]) empty`);
		const one = ops.mergeUpdates([EMPTY_UPDATE_V1, EMPTY_UPDATE_V1]);
		assert.equal(docFrom([one]).getText("body").toString(), "", `${ops.name}: merge([0,0],[0,0])`);
		const doc = new Y.Doc();
		doc.getText("body").insert(0, "x");
		const update = Y.encodeStateAsUpdate(doc);
		const withEmpty = ops.mergeUpdates([EMPTY_UPDATE_V1, update, EMPTY_UPDATE_V1]);
		assert.equal(docFrom([withEmpty]).getText("body").toString(), "x", `${ops.name}: empty updates are neutral`);
		assert.equal(docFrom([ops.diffUpdate(EMPTY_UPDATE_V1, Y.encodeStateVector(doc))]).getText("body").toString(), "",
			`${ops.name}: diff of empty update`);
		assert.equal(docFrom([ops.diffUpdate(update, Uint8Array.of(0))]).getText("body").toString(), "x",
			`${ops.name}: diff vs empty SV`);
	}
});

s.test("malformed input throws for every backend", () => {
	const garbage = Uint8Array.of(0xff, 0xff, 0xff);
	for (const ops of backends) {
		assert.throws(() => ops.stateVectorFromUpdate(garbage), `${ops.name}: SV garbage`);
		// JS yjs mergeUpdates of a single update returns it unchanged (no decode), so only ywasm must throw.
		if (ops !== jsYjsByteOps) assert.throws(() => ops.mergeUpdates([garbage]), `${ops.name}: merge garbage`);
		assert.throws(() => ops.mergeUpdates([garbage, garbage]), `${ops.name}: merge 2x garbage`);
		assert.throws(() => ops.diffUpdate(garbage, Uint8Array.of(0)), `${ops.name}: diff garbage`);
	}
});

s.test("stateVectorsEqual is order-insensitive and ignores zero clocks", () => {
	const encode = (pairs: Array<[number, number]>) => {
		const encoder: number[] = [];
		const write = (value: number) => {
			while (value >= 0x80) { encoder.push((value & 0x7f) | 0x80); value = Math.floor(value / 128); }
			encoder.push(value);
		};
		write(pairs.length);
		for (const [client, clock] of pairs) { write(client); write(clock); }
		return Uint8Array.from(encoder);
	};
	assert.ok(stateVectorsEqual(encode([[1, 5], [4_000_000_000, 3]]), encode([[4_000_000_000, 3], [1, 5]])));
	assert.ok(stateVectorsEqual(encode([[1, 5], [2, 0]]), encode([[1, 5]])));
	assert.ok(!stateVectorsEqual(encode([[1, 5]]), encode([[1, 6]])));
	assert.ok(stateVectorsEqual(new Uint8Array(0), Uint8Array.of(0)));
	assert.ok(stateVectorCoveredBy(encode([[1, 5]]), encode([[1, 6], [2, 1]])));
	assert.ok(!stateVectorCoveredBy(encode([[1, 7]]), encode([[1, 6]])));
});

s.test("repeated ywasm byte ops settle linear memory", () => {
	const history = randomHistory(99, 3, 3_000);
	const merged = Y.mergeUpdates(history.updates);
	const sv = Y.encodeStateVectorFromUpdate(Y.mergeUpdates(history.updates.slice(0, 1_000)));
	for (const ops of [ywasmTransientDocByteOps, ywasmStatelessByteOps]) {
		let settled = 0;
		for (let index = 0; index < 600; index++) {
			ops.mergeUpdates(history.updates.slice(-50).concat([merged]));
			ops.stateVectorFromUpdate(merged);
			ops.diffUpdate(merged, sv);
			if (index === 199) settled = ywasmLinearMemoryBytes();
		}
		const final = ywasmLinearMemoryBytes();
		assert.ok(final - settled <= 4 * 65_536, `${ops.name}: linear memory kept growing ${settled} -> ${final}`);
	}
});

await s.done();
