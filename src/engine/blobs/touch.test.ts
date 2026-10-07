/**
 * BlobTouch (e2ee-design §10.4 R2, R3): the re-use rule for a present address and the sender gate for an own
 * frame that references blobs, against a fake store, clock and put-time table.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCfgOps } from "../../core/codec/cfgOps";
import { concatBytes } from "../../core/codec/lib0";
import { encodeNsOps } from "../../core/codec/nsOps";
import { sha256Hex } from "../../core/hash/sha256";
import type { ClientFrameId, ConfigRelPath, ContentHash, DocId, Seq, StreamName, VaultPath } from "../../core/types";
import { CFG_STREAM, NS_STREAM } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { BlobAddress, SealedBlobParts } from "../../ports/crypto";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebHash } from "../adapters/webHash";
import { FakeClock } from "../reconcile/testkit/fakes";
import type { OutboxRecord } from "../store/schema";
import { BlobTouch, frameBlobHashes, type PutTimes } from "./touch";

const GRACE = 7 * 24 * 60 * 60_000;
const hashPort = createWebHash();
const crypto = createNoopCrypto(hashPort);

class Store implements BlobPort {
	readonly maxBlobBytes = 10 * 1024 * 1024;
	readonly objects = new Map<string, Uint8Array>();
	puts: string[] = [];
	gets = 0;
	down = false;
	async has(a: readonly BlobAddress[]) { if (this.down) throw new Error("503"); return new Set(a.filter((x) => this.objects.has(x))); }
	async put(a: BlobAddress, parts: SealedBlobParts) { if (this.down) throw new Error("503"); this.puts.push(a); this.objects.set(a, concatBytes(parts)); }
	async get(a: BlobAddress) { if (this.down) throw new Error("503"); this.gets++; return this.objects.get(a)?.slice() ?? null; }
	async list(): Promise<never> { throw new Error("unused"); }
	async deleteIfUploadedBefore(): Promise<never> { throw new Error("unused"); }
}

class Times implements PutTimes {
	readonly at = new Map<string, number>();
	async blobPutAt(a: string) { return this.at.get(a) ?? null; }
	async noteBlobPut(a: string, ms: number) { this.at.set(a, ms); }
}

function setup(o: { committed?: Set<ContentHash> | null; local?: Map<ContentHash, Uint8Array>; carried?: Set<string>; store?: Store | null } = {}) {
	const clock = new FakeClock();
	const store = o.store === undefined ? new Store() : o.store;
	const times = new Times();
	const ev = { ready: 0, diag: [] as string[] };
	let committed = o.committed === undefined ? new Set<ContentHash>() : o.committed;
	const touch = new BlobTouch({
		store, crypto, hash: hashPort, clock, graceMs: GRACE, times: () => times,
		committed: () => committed,
		blobBytes: async (h) => o.local?.get(h) ?? null,
		logCarried: (a) => o.carried?.has(a) ?? false,
		onReady: () => void ev.ready++,
		diag: (c) => void ev.diag.push(c),
	});
	return { clock, store: store!, times, ev, touch, setCommitted: (s: Set<ContentHash> | null) => { committed = s; } };
}

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const H = (b: Uint8Array) => sha256Hex(b) as ContentHash;
let n = 0;
function rec(stream: StreamName, kind: OutboxRecord["kind"], content: Uint8Array): OutboxRecord {
	const i = n++;
	return {
		clientFrameId: `t${String(i).padStart(21, "0")}` as ClientFrameId, order: i, stream, kind, state: "pending",
		sealed: content, content, authorNsSeq: 0 as Seq, flags: 0, frameNo: null, dependsOn: null, adoptOf: null,
		attempts: 0, createdAtMs: 0, lastSentAtMs: 0, keyEpoch: 0,
	};
}
const nsCreate = (hash: ContentHash) => rec(NS_STREAM, "nsOps", encodeNsOps([
	{ t: "create", docId: `d${String(n).padStart(21, "0")}` as DocId, kind: "blob", path: `a/${n}.png` as VaultPath, contentHash: hash, size: 1 },
]));
/** Waits (real time, bounded) until the async evaluation has finished: the sender poked, or a failure diag. */
async function settle(ev: { ready: number; diag: string[] } | null): Promise<void> {
	const fails = () => ev!.diag.filter((c) => c === "blob-refresh-failed").length;
	const mark = ev ? [ev.ready, fails()] : [];
	for (let i = 0; i < (ev ? 500 : 20); i++) {
		await new Promise((r) => setTimeout(r, 1));
		if (ev && (ev.ready > mark[0]! || fails() > mark[1]!)) return;
	}
	if (ev) throw new Error("evaluation did not finish");
}

test("R2 reuse: committed, or own PUT less than grace/2 ago (persisted); older, future or unknown PUT times re-upload", async () => {
	const pic = bytes(100, 1);
	const h = H(pic);
	const a = await crypto.blobAddress(h);
	const { touch, clock, times, setCommitted } = setup();
	assert.equal(await touch.reuse(h, a), false, "unreferenced and never PUT here");
	setCommitted(new Set([h]));
	assert.equal(await touch.reuse(h, a), true, "a committed reference re-uses");
	setCommitted(null);
	assert.equal(await touch.reuse(h, a), false, "folds not current: the committed set is unknown");
	times.at.set(a, clock.now() - GRACE / 2 + 1);
	assert.equal(await touch.reuse(h, a), true, "own PUT just under grace/2 ago (another process wrote it)");
	clock.advance(1);
	const t2 = setup();
	t2.times.at.set(a, t2.clock.now() - GRACE / 2);
	assert.equal(await t2.touch.reuse(h, a), false, "exactly grace/2 is stale");
	t2.times.at.set(a, t2.clock.now() + 1);
	assert.equal(await t2.touch.reuse(h, a), false, "a put time in the future (clock moved back) is stale");
	await t2.touch.noted(h, a);
	assert.equal(t2.times.at.get(a), t2.clock.now(), "noted persists the device time");
	assert.equal(await t2.touch.reuse(h, a), true);
	t2.clock.advance(GRACE / 2);
	assert.equal(await t2.touch.reuse(h, a), false, "the in-memory record ages out too");
});

test("frameBlobHashes: ns create/setBlob of a blob, cfg filePut of a blob, bodyUpdateRef; others none", () => {
	const h = "ab".repeat(32) as ContentHash;
	const h2 = "cd".repeat(32) as ContentHash;
	const d = "d000000000000000000000" as DocId;
	assert.deepEqual(frameBlobHashes(rec(NS_STREAM, "nsOps", encodeNsOps([
		{ t: "create", docId: d, kind: "markdown", path: "n.md" as VaultPath, contentHash: h2, size: 1 },
		{ t: "create", docId: d, kind: "blob", path: "p.png" as VaultPath, contentHash: h, size: 1 },
		{ t: "setBlob", docId: d, hash: h2, size: 2, baseRev: 1 as Seq },
	]))), [h, h2], "a markdown create's content hash is not a blob");
	assert.deepEqual(frameBlobHashes(rec(CFG_STREAM, "cfgOps", encodeCfgOps([
		{ t: "filePut", file: "app.json" as ConfigRelPath, content: { t: "blob", hash: h, size: 1 }, pluginVersion: null },
	]))), [h]);
	assert.equal(frameBlobHashes(rec("b:x" as StreamName, "bodyUpdateRef", new Uint8Array(3))), "bodyRef");
	assert.deepEqual(frameBlobHashes(rec("b:x" as StreamName, "bodyUpdate", new Uint8Array(3))), []);
});

test("R3 gate: committed or fresh hashes send at once; a stale one is held, re-PUT from local bytes, then released", async () => {
	const pic = bytes(500, 2);
	const h = H(pic);
	const a = await crypto.blobAddress(h);
	const { touch, store, times, ev, clock, setCommitted } = setup({ local: new Map([[h, pic]]) });
	store.objects.set(a, pic);
	assert.equal(touch.ready(rec(NS_STREAM, "nsOps", encodeNsOps([{ t: "upgradeRules", version: 1 }]))), true, "no blob reference");
	setCommitted(new Set([h]));
	assert.equal(touch.ready(nsCreate(h)), true, "committed reference");
	setCommitted(new Set());
	const r = nsCreate(h);
	assert.equal(touch.ready(r), false, "uploaded long ago by someone: refresh first");
	assert.equal(touch.ready(r), false, "still evaluating");
	await settle(ev);
	assert.deepEqual(store.puts, [a], "PUT again from the local file");
	assert.equal(times.at.get(a), clock.now());
	assert.equal(ev.ready, 1, "the sender is poked");
	assert.ok(ev.diag.includes("blob-refreshed"));
	assert.equal(touch.ready(r), true);
	assert.equal(touch.ready(nsCreate(h)), true, "a fresh own PUT clears later frames without a store call");
	assert.equal(store.puts.length, 1);
});

test("R3 gate: without local bytes the stored object is re-PUT verbatim; neither bytes nor object passes (unresolvable already)", async () => {
	const pic = bytes(300, 3);
	const h = H(pic);
	const a = await crypto.blobAddress(h);
	const { touch, store, times, ev } = setup();
	store.objects.set(a, Uint8Array.of(9, 9, 9));
	const r = nsCreate(h);
	assert.equal(touch.ready(r), false);
	await settle(ev);
	assert.deepEqual(store.puts, [a]);
	assert.deepEqual([...store.objects.get(a)!], [9, 9, 9], "verbatim (still sealed)");
	assert.ok(times.at.has(a));
	assert.equal(touch.ready(r), true);
	const gone = H(bytes(10, 4));
	const r2 = nsCreate(gone);
	assert.equal(touch.ready(r2), false);
	await settle(ev);
	assert.ok(ev.diag.includes("blob-refresh-missing"));
	assert.equal(touch.ready(r2), true);
});

test("R3 gate: a bodyUpdateRef re-PUTs its own content unless it went to x: chunks", async () => {
	const update = bytes(2000, 5);
	const h = H(update);
	const a = await crypto.blobAddress(h);
	const { touch, store, ev } = setup();
	const r = rec("b:doc" as StreamName, "bodyUpdateRef", update);
	assert.equal(touch.ready(r), false);
	await settle(ev);
	assert.deepEqual(store.puts, [a], "from the frame's own bytes");
	assert.equal(touch.ready(r), true);
	const u2 = bytes(2000, 6);
	const carried = setup({ carried: new Set([await crypto.blobAddress(H(u2))]) });
	const r2 = rec("b:doc" as StreamName, "bodyUpdateRef", u2);
	assert.equal(carried.touch.ready(r2), false);
	await settle(carried.ev);
	assert.equal(carried.store.puts.length, 0, "x: carries it: nothing to refresh");
	assert.equal(carried.touch.ready(r2), true);
});

test("R3 gate: a store error holds the frame with backoff; the timer pokes; forget drops it; reset re-checks; inert without a store", async () => {
	const pic = bytes(64, 7);
	const h = H(pic);
	const { touch, store, ev, clock } = setup({ local: new Map([[h, pic]]) });
	store.down = true;
	const r = nsCreate(h);
	assert.equal(touch.ready(r), false);
	await settle(ev);
	assert.ok(ev.diag.includes("blob-refresh-failed"));
	assert.equal(touch.ready(r), false, "backing off");
	clock.advance(999);
	assert.equal(ev.ready, 0);
	clock.advance(1);
	assert.equal(ev.ready, 1, "the retry timer pokes the sender");
	assert.equal(touch.ready(r), false, "a second attempt, still down");
	await settle(ev);
	clock.advance(1_999);
	assert.equal(touch.ready(r), false, "doubled backoff");
	clock.advance(1);
	store.down = false;
	assert.equal(touch.ready(r), false);
	await settle(ev);
	assert.equal(touch.ready(r), true);
	touch.reset();
	clock.advance(GRACE / 2);
	assert.equal(touch.ready(r), false, "after reset and grace/2, the frame is checked (and PUT) again");
	await settle(ev);
	assert.equal(store.puts.length, 2);
	const r2 = nsCreate(H(bytes(65, 8)));
	store.down = true;
	assert.equal(touch.ready(r2), false);
	touch.forget(r2.clientFrameId);
	await settle(null);
	clock.advance(60_000);
	assert.equal(ev.ready, 4, "a forgotten frame schedules no retry");
	assert.equal(setup({ store: null }).touch.ready(nsCreate(h)), true, "no store: nothing to keep alive");
});
