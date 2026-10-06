import { test } from "node:test";
import assert from "node:assert/strict";
import type { BlobChunkContent } from "../../core/envelope";
import { sha256Hex } from "../../core/hash/sha256";
import { BLOB_CHUNK_BYTES, MAX_LOG_BLOB_BYTES } from "../../core/limits";
import type { ContentHash, DocId, VaultPath } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { BlobAddress, CryptoPort } from "../../ports/crypto";
import { DB_SCHEMA_VERSION, STORE_SPECS } from "../store/schema";
import type { DiskSchema } from "../reconcile/store";
import { FakeClock } from "../reconcile/testkit/fakes";
import { FakeStorage } from "../reconcile/testkit/fakeStorage";
import { BLOB_RETRY_BASE_MS, BlobQueue, backoffMs } from "./blobQueue";
import { assembleChunks, splitChunks, type BlobChunkLog } from "./chunks";

/** Suite-0-like crypto, but sealing XORs so a missing openBlob would be caught. */
class XorCrypto implements CryptoPort {
	readonly suite = 0 as const;
	readonly keyEpoch = 0;
	sealCalls = 0;
	async seal(input: { aad: Uint8Array; plaintext: Uint8Array }): Promise<Uint8Array> { return input.plaintext; }
	async open(input: { sealed: Uint8Array }) { return { ok: true as const, plaintext: input.sealed }; }
	async sealBlob(p: Uint8Array): Promise<Uint8Array> { this.sealCalls++; return p.map((b) => b ^ 0x5a); }
	async openBlob(s: Uint8Array): Promise<Uint8Array | null> { return s.map((b) => b ^ 0x5a); }
	async blobAddress(hash: ContentHash): Promise<BlobAddress> { return `addr-${hash.slice(0, 16)}` as BlobAddress; }
}

class FakeStore implements BlobPort {
	readonly maxBlobBytes = 10 * 1024 * 1024;
	readonly objects = new Map<string, Uint8Array>();
	puts = 0;
	down = false;
	async has(a: readonly BlobAddress[]) { if (this.down) throw new Error("503"); return new Set(a.filter((x) => this.objects.has(x))); }
	async put(a: BlobAddress, b: Uint8Array) { if (this.down) throw new Error("503"); this.puts++; this.objects.set(a, b.slice()); }
	async get(a: BlobAddress) { if (this.down) throw new Error("503"); return this.objects.get(a)?.slice() ?? null; }
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
const rnd = (n: number, seed = 1): Uint8Array => { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };

async function make(opts: { store?: FakeStore | null; log?: FakeChunkLog | null } = {}) {
	const storage = new FakeStorage();
	const clock = new FakeClock();
	const crypto = new XorCrypto();
	const store = opts.store === undefined ? new FakeStore() : opts.store;
	const log = opts.log === undefined ? new FakeChunkLog() : opts.log;
	const notices: string[] = [];
	const open = async () => BlobQueue.open({ db: await storage.open<DiskSchema>("b", DB_SCHEMA_VERSION, STORE_SPECS), clock, crypto, store, chunkLog: log, notice: (_l, c) => notices.push(c) });
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
