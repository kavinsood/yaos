import { test } from "node:test";
import assert from "node:assert/strict";
import type { BlobChunkContent } from "../../core/envelope";
import { sha256Hex } from "../../core/hash/sha256";
import { BLOB_CHUNK_BYTES, MAX_BLOB_PLAINTEXT_BYTES_SUITE1, MAX_LOG_BLOB_BYTES } from "../../core/limits";
import type { ContentHash, DocId, VaultPath } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { BlobAddress, CryptoPort, OpenResult } from "../../ports/crypto";
import { DB_SCHEMA_VERSION, STORE_SPECS } from "../store/schema";
import type { DiskSchema } from "../reconcile/store";
import { FakeClock } from "../reconcile/testkit/fakes";
import { FakeStorage } from "../reconcile/testkit/fakeStorage";
import { ScriptedRandom } from "../adapters/testkit/scriptedRandom";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { BLOB_RETRY_BASE_MS, BlobQueue, backoffMs } from "./blobQueue";
import { assembleChunks, splitChunks, type BlobChunkLog } from "./chunks";

/** Suite-0-like crypto, but sealing XORs so a missing openBlob would be caught. */
class XorCrypto implements CryptoPort {
	readonly suite = 0 as const;
	sealCalls = 0;
	sealEpoch(): number { return 0; }
	keyState(e: number) { return { held: e === 0, verified: true }; }
	async seal(input: { plaintext: Uint8Array }): Promise<Uint8Array> { return input.plaintext; }
	async open(input: { sealed: Uint8Array }) { return { ok: true as const, plaintext: input.sealed }; }
	async sealBlob(input: { plaintext: Uint8Array }): Promise<Uint8Array> { this.sealCalls++; return input.plaintext.map((b) => b ^ 0x5a); }
	async openBlob(input: { sealed: Uint8Array }): Promise<OpenResult> { return { ok: true, plaintext: input.sealed.map((b) => b ^ 0x5a) }; }
	async blobAddress(hash: ContentHash): Promise<BlobAddress> { return `addr-${hash.slice(0, 16)}` as BlobAddress; }
	async diagHash(): Promise<string> { return "0".repeat(16); }
}

class FakeStore implements BlobPort {
	readonly maxBlobBytes = 10 * 1024 * 1024;
	readonly objects = new Map<string, Uint8Array>();
	puts = 0;
	down = false;
	async has(a: readonly BlobAddress[]) { if (this.down) throw new Error("503"); return new Set(a.filter((x) => this.objects.has(x))); }
	async put(a: BlobAddress, b: Uint8Array) { if (this.down) throw new Error("503"); this.puts++; this.objects.set(a, b.slice()); }
	async get(a: BlobAddress) { if (this.down) throw new Error("503"); return this.objects.get(a)?.slice() ?? null; }
	async list(): Promise<never> { throw new Error("unused"); }
	async deleteIfUploadedBefore(): Promise<never> { throw new Error("unused"); }
}

class FakeChunkLog implements BlobChunkLog {
	readonly streams = new Map<string, BlobChunkContent[]>();
	receipts = true;
	async appendChunks(hash: ContentHash, chunks: readonly BlobChunkContent[]) {
		if (!this.receipts) return false;
		const s = this.streams.get(hash) ?? [];
		s.push(...chunks.map((c) => ({ ...c, chunk: c.chunk.slice() })));
		this.streams.set(hash, s);
		return true;
	}
	async readChunks(hash: ContentHash) { return this.streams.get(hash) ?? null; }
}

const D = "doc0000000000000000000" as DocId;
const P = "a/pic.png" as VaultPath;
const rnd = (n: number, seed = 1): Uint8Array => { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; b[i] = x >>> 24; } return b; };

async function make(opts: { store?: FakeStore | null; log?: FakeChunkLog | null; ahead?: { count: number; bytes: number }; crypto?: CryptoPort; clock?: FakeClock } = {}) {
	const storage = new FakeStorage();
	const clock = opts.clock ?? new FakeClock();
	const crypto = new XorCrypto();
	const store = opts.store === undefined ? new FakeStore() : opts.store;
	const log = opts.log === undefined ? new FakeChunkLog() : opts.log;
	const notices: string[] = [];
	const open = async () => BlobQueue.open({
		db: await storage.open<DiskSchema>("b", DB_SCHEMA_VERSION, STORE_SPECS), clock, crypto: opts.crypto ?? crypto, store, chunkLog: log,
		notice: (_l, c) => notices.push(c), ahead: opts.ahead,
	});
	return { storage, clock, crypto, store, log, notices, q: await open(), reopen: open };
}

test("store: upload seals and puts once; has() short-circuits; download opens and verifies", async () => {
	const { q, store, crypto } = await make();
	const bytes = rnd(5000);
	const hash = sha256Hex(bytes);
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), true);
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), true);
	assert.equal(store!.puts, 1);
	assert.equal(crypto.sealCalls, 1);
	const stored = [...store!.objects.values()][0]!;
	assert.notDeepEqual(stored, bytes, "stored sealed");
	assert.deepEqual(await q.download({ hash, docId: D, path: P, size: bytes.length }), bytes);
	assert.equal(q.queued().length, 0);
});

test("store: wrong hash refuses to upload; corrupt download is rejected with a notice", async () => {
	const { q, store, notices } = await make();
	const bytes = rnd(100);
	assert.equal(await q.upload({ hash: sha256Hex(rnd(100, 2)), docId: D, path: P, bytes }), false);
	assert.equal(store!.puts, 0);
	const hash = sha256Hex(bytes);
	await q.upload({ hash, docId: D, path: P, bytes });
	for (const [k, v] of store!.objects) store!.objects.set(k, v.map((b, i) => (i === 0 ? b ^ 1 : b)));
	assert.equal(await q.download({ hash, docId: D, path: P, size: 100 }), null);
	assert.ok(notices.includes("blob-corrupt"));
});

test("store: outage -> backoff record persisted; not retried until due; success clears it", async () => {
	const { q, store, clock, storage, reopen } = await make();
	const bytes = rnd(64);
	const hash = sha256Hex(bytes);
	store!.down = true;
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), false);
	assert.equal(q.queued().length, 1);
	assert.equal(q.nextDueInMs(), BLOB_RETRY_BASE_MS);
	assert.equal(storage.dump("b", "blobQueue").length, 1);
	store!.down = false;
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), false, "still backing off");
	assert.equal(store!.puts, 0);
	// A restart keeps the backoff.
	const q2 = await reopen();
	assert.equal(q2.queued()[0]!.attempts, 1);
	clock.advance(BLOB_RETRY_BASE_MS);
	assert.equal(await q2.upload({ hash, docId: D, path: P, bytes }), true);
	assert.equal(q2.queued().length, 0);
	assert.equal(storage.dump("b", "blobQueue").length, 0);
});

test("store: backoff is monotonic: a wall clock jumping back 12 h does not park the retry; reopen clamps to the backoff", async () => {
	const { q, store, clock, reopen } = await make();
	const bytes = rnd(32);
	const hash = sha256Hex(bytes);
	store!.down = true;
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), false);
	store!.down = false;
	clock.wall -= 12 * 3600_000;
	assert.equal(q.nextDueInMs(), BLOB_RETRY_BASE_MS);
	const q2 = await reopen();
	assert.equal(q2.nextDueInMs(), BLOB_RETRY_BASE_MS, "persisted wall-time due 12 h ahead is clamped to the record's backoff");
	clock.advance(BLOB_RETRY_BASE_MS);
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), true);
	assert.equal(await q2.upload({ hash, docId: D, path: P, bytes }), true);
});

test("retain drops stale records (memory + store), keeps the rest and a shared row's other direction", async () => {
	const { q, store, storage } = await make();
	const a = rnd(16), b = rnd(17);
	const ha = sha256Hex(a), hb = sha256Hex(b);
	store!.down = true;
	await q.upload({ hash: ha, docId: D, path: P, bytes: a });
	await q.upload({ hash: hb, docId: D, path: P, bytes: b });
	await q.download({ hash: hb, docId: D, path: P, size: b.length });
	assert.equal(q.queued().length, 3);
	assert.equal(await q.retain((r) => r.direction === "down"), 2);
	assert.deepEqual(q.queued().map((r) => [r.direction, r.hash]), [["down", hb]]);
	assert.deepEqual(storage.dump("b", "blobQueue").map((r) => [(r as { direction: string }).direction, (r as { hash: string }).hash]), [["down", hb]]);
	assert.ok(q.nextDueInMs() !== null);
	assert.equal(await q.retain(() => false), 1);
	assert.equal(q.nextDueInMs(), null);
	assert.equal(storage.dump("b", "blobQueue").length, 0);
});

test("store: missing blob on download backs off exponentially", async () => {
	const { q, clock } = await make();
	const hash = sha256Hex(rnd(10));
	assert.equal(await q.download({ hash, docId: D, path: P, size: 10 }), null);
	assert.equal(q.nextDueInMs(), backoffMs(1));
	clock.advance(backoffMs(1));
	assert.equal(await q.download({ hash, docId: D, path: P, size: 10 }), null);
	assert.equal(q.queued()[0]!.attempts, 2);
	assert.equal(q.nextDueInMs(), backoffMs(2));
	assert.equal(backoffMs(2), 2 * backoffMs(1));
	assert.equal(backoffMs(100), 10 * 60_000);
});

test("store: oversize upload is refused with a notice", async () => {
	const { q, notices } = await make();
	const bytes = new Uint8Array(10 * 1024 * 1024 + 1);
	assert.equal(await q.upload({ hash: sha256Hex(bytes), docId: D, path: P, bytes }), false);
	assert.ok(notices.includes("blob-too-large"));
});

test("log carrier: chunks of 768 KiB, assembled by index with duplicates ignored", async () => {
	const { q, log } = await make({ store: null });
	assert.equal(q.maxBlobBytes, MAX_LOG_BLOB_BYTES);
	const bytes = rnd(BLOB_CHUNK_BYTES * 2 + 1234, 3);
	const hash = sha256Hex(bytes);
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), true);
	const chunks = log!.streams.get(hash)!;
	assert.equal(chunks.length, 3);
	assert.ok(chunks.every((c) => c.total === 3 && c.totalSize === bytes.length && c.chunk.length <= BLOB_CHUNK_BYTES));
	// Re-sent duplicates (resend after restart) and shuffled order.
	log!.streams.set(hash, [chunks[2]!, chunks[0]!, chunks[1]!, chunks[0]!]);
	assert.deepEqual(await q.download({ hash, docId: D, path: P, size: bytes.length }), bytes);
});

test("log carrier: not receipted -> false and queued; incomplete stream -> null", async () => {
	const { q, log, clock } = await make({ store: null });
	const bytes = rnd(BLOB_CHUNK_BYTES + 1, 4);
	const hash = sha256Hex(bytes);
	log!.receipts = false;
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), false);
	assert.equal(q.queued()[0]!.via, "log");
	log!.receipts = true;
	clock.advance(BLOB_RETRY_BASE_MS);
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), true);
	log!.streams.set(hash, log!.streams.get(hash)!.slice(0, 1));
	assert.equal(await q.download({ hash, docId: D, path: P, size: bytes.length }), null);
});

test("assembleChunks: inconsistent totals, wrong hash, empty blob", () => {
	const bytes = rnd(3000, 5);
	const hash = sha256Hex(bytes) as ContentHash;
	const chunks = splitChunks(hash, bytes, 1000);
	assert.equal(chunks.length, 3);
	assert.deepEqual(assembleChunks(hash, chunks), { ok: true, bytes });
	assert.deepEqual(assembleChunks(hash, [...chunks, { ...chunks[0]!, total: 4 }]), { ok: false, reason: "inconsistent" });
	const other = sha256Hex(rnd(3000, 6)) as ContentHash;
	assert.deepEqual(assembleChunks(other, chunks.map((c) => ({ ...c, hash: other }))), { ok: false, reason: "hash-mismatch" });
	const empty = new Uint8Array(0);
	const eh = sha256Hex(empty) as ContentHash;
	const ec = splitChunks(eh, empty);
	assert.equal(ec.length, 1);
	assert.deepEqual(assembleChunks(eh, ec), { ok: true, bytes: empty });
	assert.throws(() => splitChunks(hash, new Uint8Array(MAX_LOG_BLOB_BYTES + 1)));
});

test("concurrent uploads of one hash share one transfer", async () => {
	const { q, store } = await make();
	const bytes = rnd(10, 9);
	const hash = sha256Hex(bytes);
	const [a, b] = await Promise.all([q.upload({ hash, docId: D, path: P, bytes }), q.upload({ hash, docId: D, path: P, bytes })]);
	assert.equal(a && b, true);
	assert.equal(store!.puts, 1);
});

test("prefetch: the job's download takes the prefetched fetch; bounded by count and bytes; failures book like a download", async () => {
	const store = new FakeStore();
	let gets = 0;
	const get = store.get.bind(store);
	store.get = async (a) => { gets++; return get(a); };
	const { q } = await make({ store, ahead: { count: 2, bytes: 10_000 } });
	const blobs = [rnd(4000, 1), rnd(4000, 2), rnd(4000, 3), rnd(20_000, 4)].map((bytes) => ({ bytes, hash: sha256Hex(bytes) }));
	for (const b of blobs) assert.equal(await q.upload({ hash: b.hash, docId: D, path: P, bytes: b.bytes }), true);
	const req = (i: number) => ({ hash: blobs[i]!.hash, docId: D, path: P, size: blobs[i]!.bytes.length });
	assert.equal(q.prefetch(req(0)), true);
	assert.equal(q.prefetch(req(0)), true, "already ahead");
	assert.equal(q.prefetch(req(3)), true, "larger than the whole budget: skipped, its job downloads it");
	assert.equal(q.prefetch(req(1)), true);
	assert.equal(q.prefetch(req(2)), false, "count bound");
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(gets, 2);
	assert.deepEqual(await q.download(req(0)), blobs[0]!.bytes);
	assert.equal(gets, 2, "taken, not fetched again");
	assert.equal(q.prefetch(req(2)), true, "a take frees the window");
	q.dropPrefetched();
	assert.deepEqual(await q.download(req(1)), blobs[1]!.bytes);
	assert.equal(gets, 4, "a dropped prefetch is fetched again by its job");
	// A prefetch that fails is the download's attempt: it books the backoff record.
	store.down = true;
	const { q: q2 } = await make({ store, ahead: { count: 1, bytes: 10_000 } });
	assert.equal(q2.prefetch(req(2)), true);
	assert.equal(await q2.download(req(2)), null);
	store.down = false;
	assert.equal(q2.queued().length, 1);
	assert.equal(q2.prefetch(req(2)), true, "backing off: nothing started");
	assert.equal(await q2.download(req(2)), null, "still backing off");
});

test("prefetch: no ahead bound = never prefetches", async () => {
	const { q } = await make();
	const bytes = rnd(100, 5);
	assert.equal(q.prefetch({ hash: sha256Hex(bytes), docId: D, path: P, size: bytes.length }), false);
});

// ---- suite 1 (e2ee-design §10, WP-E6a) -------------------------------------------------------

const VAULT = "AAAAAAAAAAAAAAAAAAAAAA";
const K1 = Uint8Array.from({ length: 32 }, (_, i) => i);
const K2 = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i);
const nonce = (tag: number, i: number) => Uint8Array.from([tag, i >>> 24, (i >>> 16) & 0xff, (i >>> 8) & 0xff, i & 0xff, 0, 0, 0, 0, 0, 0, 0]);
const MIN = 60_000;

/** A device's suite-1 port: K1 at epoch 1 (the address key), `e2` at epoch 2 (null = not held); verified as listed. */
async function suite1(tag: number, o: { e2?: Uint8Array | null; verified?: readonly number[]; seal?: number } = {}) {
	const random = new ScriptedRandom();
	for (let i = 0; i < 64; i++) random.push(nonce(tag, i));
	const keys = [{ e: 1, k: K1.slice() }, ...(o.e2 === null ? [] : [{ e: 2, k: (o.e2 ?? K2).slice() }])];
	const c = await createWebCryptoSuite1({ vaultId: VAULT, random, keys });
	for (const e of o.verified ?? [1, 2]) c.markVerified(e);
	c.setSealEpoch(o.seal ?? 2);
	return c;
}

test("suite 1: two devices upload the same file: different ciphertexts at one address, either opens; a shared store dedupes", async () => {
	const a = await make({ crypto: await suite1(0xa1) });
	const b = await make({ crypto: await suite1(0xb1) });
	const bytes = rnd(40_000, 11);
	const hash = sha256Hex(bytes);
	assert.equal(await a.q.upload({ hash, docId: D, path: P, bytes }), true);
	assert.equal(await b.q.upload({ hash, docId: D, path: P, bytes }), true);
	const [ka, ca] = [...a.store!.objects][0]!;
	const [kb, cb] = [...b.store!.objects][0]!;
	assert.equal(ka, kb, "one address: HMAC of the sha256 under K_1");
	assert.ok(!ka.includes(hash), "the store key is not the plaintext hash");
	assert.notDeepEqual(ca, cb, "fresh nonce per seal");
	// Last writer wins at the address; whichever ciphertext is stored, every device opens it.
	b.store!.objects.set(kb, ca);
	a.store!.objects.set(ka, cb);
	assert.deepEqual(await a.q.download({ hash, docId: D, path: P, size: bytes.length }), bytes);
	assert.deepEqual(await b.q.download({ hash, docId: D, path: P, size: bytes.length }), bytes);
	// A third device on A's store finds the address present (has) and stores nothing.
	const c = await make({ store: a.store, crypto: await suite1(0xc1) });
	assert.equal(await c.q.upload({ hash, docId: D, path: P, bytes }), true);
	assert.equal(a.store!.puts, 1);
	assert.equal(c.q.maxBlobBytes, MAX_BLOB_PLAINTEXT_BYTES_SUITE1, "plaintext cap under suite 1");
});

test("suite 1: a file above the sealed cap is not synced: upload refuses with a notice, nothing stored", async () => {
	const { q, store, notices } = await make({ crypto: await suite1(0xa2) });
	const bytes = new Uint8Array(MAX_BLOB_PLAINTEXT_BYTES_SUITE1 + 1);
	assert.ok(bytes.length < store!.maxBlobBytes, "fits the transport cap as plaintext, not once sealed");
	assert.equal(await q.upload({ hash: sha256Hex(bytes), docId: D, path: P, bytes }), false);
	assert.equal(store!.puts, 0);
	assert.ok(notices.includes("blob-too-large"));
	assert.equal(await q.download({ hash: sha256Hex(bytes), docId: D, path: P, size: bytes.length }), null);
});

test("suite 1: tampered at rest: unavailable + blob-corrupt each attempt; quarantined after the initial attempt and 3 retries over >= 3 min", async () => {
	const w = await make({ crypto: await suite1(0xa3) });
	const bytes = rnd(3_000, 12);
	const hash = sha256Hex(bytes);
	await w.q.upload({ hash, docId: D, path: P, bytes });
	const r = await make({ store: w.store, crypto: await suite1(0xb3) });
	for (const [k, v] of w.store!.objects) w.store!.objects.set(k, v.map((x, i) => (i === 40 ? x ^ 1 : x)));
	let gets = 0;
	const get = w.store!.get.bind(w.store!);
	w.store!.get = async (a) => (gets++, get(a));
	const down = () => r.q.download({ hash, docId: D, path: P, size: bytes.length });
	// Retries at the backoff (2 s, 4 s, 8 s): four deterministic failures in 14 s are not enough.
	assert.equal(await down(), null);
	for (const ms of [2_000, 4_000, 8_000]) {
		r.clock.advance(ms);
		assert.equal(await down(), null);
	}
	assert.equal(gets, 4);
	assert.equal(r.notices.filter((n) => n === "blob-corrupt").length, 4);
	assert.ok(!r.notices.includes("blob-quarantined"));
	r.clock.advance(3 * MIN);
	assert.equal(await down(), null);
	assert.ok(r.notices.includes("blob-quarantined"));
	assert.deepEqual(r.q.quarantined(), [hash]);
	r.clock.advance(60 * MIN);
	assert.equal(await down(), null);
	assert.equal(r.q.prefetch({ hash, docId: D, path: P, size: bytes.length }), true, "prefetch skips it too");
	assert.equal(gets, 5, "quarantined: not fetched again");
	assert.equal(r.notices.filter((n) => n === "blob-quarantined").length, 1);
});

test("suite 1: an open failure under an unverified key, or an unknown key, is never quarantined (and never blob-corrupt)", async () => {
	const w = await make({ crypto: await suite1(0xa4) });
	const bytes = rnd(3_000, 13);
	const hash = sha256Hex(bytes);
	await w.q.upload({ hash, docId: D, path: P, bytes });
	const readers = [
		await make({ store: w.store, crypto: await suite1(0xb4, { e2: new Uint8Array(32).fill(9), verified: [1], seal: 1 }) }), // wrong K_2, unverified
		await make({ store: w.store, crypto: await suite1(0xc4, { verified: [1], seal: 1 }) }), // right K_2, unverified: tampered bytes
		await make({ store: w.store, crypto: await suite1(0xd4, { e2: null, verified: [1], seal: 1 }) }), // no K_2: unknown-key
	];
	for (const [i, r] of readers.entries()) {
		if (i === 1) for (const [k, v] of w.store!.objects) w.store!.objects.set(k, v.map((x, j) => (j === 40 ? x ^ 1 : x)));
		for (let n = 0; n < 12; n++) {
			assert.equal(await r.q.download({ hash, docId: D, path: P, size: bytes.length }), null, `reader ${i} attempt ${n}`);
			r.clock.advance(10 * MIN);
		}
		assert.deepEqual(r.notices, [], `reader ${i}: no blob-corrupt, no blob-quarantined`);
		assert.deepEqual(r.q.quarantined(), []);
		assert.equal(r.q.queued()[0]!.attempts, 12, "still retried with backoff");
	}
});

test("suite 1, log path: assembled chunks that do not verify are deterministic (quarantined); missing ones never are", async () => {
	const log = new FakeChunkLog();
	const { q, notices, clock } = await make({ store: null, log, crypto: await suite1(0xa5) });
	const bytes = rnd(BLOB_CHUNK_BYTES + 10, 14);
	const hash = sha256Hex(bytes);
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), true);
	assert.deepEqual(await q.download({ hash, docId: D, path: P, size: bytes.length }), bytes);
	log.streams.get(hash)![1] = { ...log.streams.get(hash)![1]!, chunk: new Uint8Array(10) };
	for (let n = 0; n < 4; n++) {
		assert.equal(await q.download({ hash, docId: D, path: P, size: bytes.length }), null);
		clock.advance(MIN + 1);
	}
	assert.ok(notices.includes("blob-corrupt"));
	assert.ok(notices.includes("blob-quarantined"), "4 deterministic failures over > 3 min");
	log.streams.get(hash)!.splice(1, 1);
	const fresh = await make({ store: null, log, crypto: await suite1(0xb5) });
	for (let n = 0; n < 6; n++) {
		assert.equal(await fresh.q.download({ hash, docId: D, path: P, size: bytes.length }), null);
		fresh.clock.advance(10 * MIN);
	}
	assert.deepEqual(fresh.notices, [], "incomplete: absent, never deterministic");
});

