import { test } from "node:test";
import assert from "node:assert/strict";
import { concatBytes } from "../../core/codec/lib0";
import { sha256Hex } from "../../core/hash/sha256";
import { maxSealedBlobPlaintext } from "../../core/codec/sealedBlob";
import type { ContentHash, DocId, VaultPath } from "../../core/types";
import { BlobTooLargeError, type BlobPort } from "../../ports/blob";
import type { BlobAddress, CryptoPort, OpenResult, SealedBlobParts } from "../../ports/crypto";
import { DB_SCHEMA_VERSION, STORE, STORE_SPECS } from "../store/schema";
import type { DiskSchema } from "../reconcile/store";
import { FakeClock } from "../reconcile/testkit/fakes";
import { FakeStorage } from "../reconcile/testkit/fakeStorage";
import { ScriptedRandom } from "../adapters/testkit/scriptedRandom";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { createWebHash } from "../adapters/webHash";
import { BLOB_TRANSFER_MIN_COST } from "../../core/limits";
import type { UploadSource } from "../reconcile/context";
import { BLOB_RETRY_BASE_MS, BLOB_RETRY_MAX_MS, BlobQueue, CONFIRMED_TTL_MS, backoffMs } from "./blobQueue";
import { TransferLink } from "./transferLink";

/** Suite-0-like crypto, but sealing XORs so a missing openBlob would be caught. */
class XorCrypto implements CryptoPort {
	readonly suite = 0 as const;
	sealCalls = 0;
	sealEpoch(): number { return 0; }
	keyState(e: number) { return { held: e === 0, verified: true }; }
	async seal(input: { plaintext: Uint8Array }): Promise<Uint8Array> { return input.plaintext; }
	async open(input: { sealed: Uint8Array }) { return { ok: true as const, plaintext: input.sealed }; }
	async sealBlob(input: { plaintext: Uint8Array }): Promise<SealedBlobParts> { this.sealCalls++; return [input.plaintext.map((b) => b ^ 0x5a)]; }
	async openBlob(input: { sealed: Uint8Array }): Promise<OpenResult> { return { ok: true, plaintext: input.sealed.map((b) => b ^ 0x5a) }; }
	async blobAddress(hash: ContentHash): Promise<BlobAddress> { return `addr-${hash.slice(0, 16)}` as BlobAddress; }
	async diagHash(): Promise<string> { return "0".repeat(16); }
}

class FakeStore implements BlobPort {
	readonly maxBlobBytes = 10 * 1024 * 1024;
	readonly objects = new Map<string, Uint8Array>();
	puts = 0;
	down = false;
	/** Answer every put 413 (an edge limit below maxBlobBytes); `refusals` counts those requests. */
	refuse = false;
	refusals = 0;
	async has(a: readonly BlobAddress[]) { if (this.down) throw new Error("503"); return new Set(a.filter((x) => this.objects.has(x))); }
	async put(a: BlobAddress, parts: SealedBlobParts) {
		if (this.down) throw new Error("503");
		if (this.refuse) { this.refusals++; throw new BlobTooLargeError(concatBytes(parts).length); }
		this.puts++; this.objects.set(a, concatBytes(parts));
	}
	async get(a: BlobAddress) { if (this.down) throw new Error("503"); return this.objects.get(a)?.slice() ?? null; }
	async list(): Promise<never> { throw new Error("unused"); }
	async deleteIfUploadedBefore(): Promise<never> { throw new Error("unused"); }
}

const D = "doc0000000000000000000" as DocId;
const P = "a/pic.png" as VaultPath;
const rnd = (n: number, seed = 1): Uint8Array => { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; b[i] = x >>> 24; } return b; };

const D2 = "doc0000000000000000002" as DocId;
const D3 = "doc0000000000000000003" as DocId;
const P2 = "b/pic.png" as VaultPath;
const MiB = 1024 * 1024;

/** A source that reads `bytes` (a claim's file); `changed` counts the claims' re-hash requests. */
const src = (bytes: Uint8Array | null, onChanged: () => void = () => undefined): UploadSource => ({ read: async () => bytes, changed: onChanged });

/**
 * Run the event loop until `cond` holds (WebCrypto digests settle on real turns, later under a loaded machine:
 * a bound in turns, not time, timed out in the full parallel suite).
 */
async function until(cond: () => boolean, what = "condition"): Promise<void> {
	const end = Date.now() + 10_000;
	while (!cond() && Date.now() < end) await new Promise((r) => setImmediate(r));
	assert.ok(cond(), `timed out waiting for ${what}`);
}

/**
 * A store whose put / get wait until released, as a slow link holds them; each honours its signal (rejects with
 * the signal's reason, as the HTTP adapter does) and books the bytes it holds (`peak`).
 */
class GatedStore extends FakeStore {
	gated = true;
	held = 0;
	bytesHeld = 0;
	peak = 0;
	/** Address and size of every held call, in arrival order. */
	readonly calls: { readonly kind: "put" | "get"; readonly address: string; readonly size: number; open(): void }[] = [];
	override async put(a: BlobAddress, parts: SealedBlobParts, signal?: AbortSignal): Promise<void> {
		await this.hold("put", a, concatBytes(parts).length, signal);
		return super.put(a, parts);
	}
	override async get(a: BlobAddress, signal?: AbortSignal): Promise<Uint8Array | null> {
		await this.hold("get", a, this.objects.get(a)?.length ?? 0, signal);
		return super.get(a);
	}
	release(i = 0): void {
		this.calls[i]!.open();
	}
	releaseAll(): void {
		for (const c of [...this.calls]) c.open();
	}
	private hold(kind: "put" | "get", address: string, size: number, signal: AbortSignal | undefined): Promise<void> {
		if (!this.gated) return Promise.resolve();
		if (signal?.aborted) return Promise.reject(signal.reason);
		return new Promise((resolve, reject) => {
			const end = (): void => {
				this.calls.splice(this.calls.indexOf(call), 1);
				signal?.removeEventListener("abort", onAbort);
				this.held--;
				this.bytesHeld -= size;
			};
			const onAbort = (): void => (end(), reject(signal!.reason));
			const call = { kind, address, size, open: () => (end(), resolve()) };
			signal?.addEventListener("abort", onAbort, { once: true });
			this.calls.push(call);
			this.held++;
			this.bytesHeld += size;
			this.peak = Math.max(this.peak, this.bytesHeld);
		});
	}
}

async function make(opts: { store?: BlobPort | null; budgetBytes?: number; admit?: () => boolean; crypto?: CryptoPort; clock?: FakeClock } = {}) {
	const storage = new FakeStorage();
	const clock = opts.clock ?? new FakeClock();
	const crypto = new XorCrypto();
	const store = (opts.store === undefined ? new FakeStore() : opts.store) as FakeStore | null;
	const notices: string[] = [];
	/** Every wake, as the docs it names. */
	const woken: DocId[][] = [];
	const open = async () => BlobQueue.open({
		db: await storage.open<DiskSchema>("b", DB_SCHEMA_VERSION, STORE_SPECS), clock, crypto: opts.crypto ?? crypto, hash: createWebHash(), store,
		notice: (_l, c) => notices.push(c), touch: { reuse: async () => true, noted: async () => {} },
		...(opts.budgetBytes !== undefined ? { budgetBytes: opts.budgetBytes } : {}), ...(opts.admit ? { admit: opts.admit } : {}),
		wake: (who) => woken.push(who.map((w) => w.docId)),
	});
	return { storage, clock, crypto, store, notices, woken, q: await open(), reopen: open };
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

test("store: a put refused by size (413) is refused for good: notice, its backoff record dropped, no retry, no second request", async () => {
	const { q, store, clock, storage, notices } = await make();
	const bytes = rnd(64);
	const hash = sha256Hex(bytes);
	store!.down = true;
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), false);
	assert.equal(q.queued().length, 1, "an outage first: a backoff record");
	clock.advance(BLOB_RETRY_BASE_MS);
	store!.down = false;
	store!.refuse = true;
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), false);
	assert.equal(store!.refusals, 1);
	assert.deepEqual(notices, ["blob-too-large"]);
	assert.equal(q.claimUpload({ hash, docId: D, path: P, size: 64 }, src(bytes)), "refused", "a claim holds at once");
	assert.equal(q.queued().length, 0, "no record: nothing to retry");
	assert.equal(q.nextDueInMs(), null, "no blob retry armed");
	assert.equal(storage.dump("b", "blobQueue").length, 0);
	clock.advance(BLOB_RETRY_MAX_MS);
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), false);
	assert.equal(store!.refusals, 1, "no second request for the same bytes");
	assert.equal(notices.length, 1, "one notice");
	// Other bytes are still tried.
	store!.refuse = false;
	const other = rnd(64, 9);
	assert.equal(await q.upload({ hash: sha256Hex(other), docId: D, path: P, bytes: other }), true);
	assert.equal(q.claimUpload({ hash: sha256Hex(other), docId: D, path: P, size: 64 }, src(other)), "stored");
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

test("no blob store: maxBlobBytes 0; upload refuses at once and queues nothing (no retry timer); download / claims answer at once", async () => {
	const { q, storage, notices } = await make({ store: null });
	assert.equal(q.maxBlobBytes, 0);
	const bytes = rnd(5000, 3);
	const hash = sha256Hex(bytes);
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), false);
	assert.equal(await q.download({ hash, docId: D, path: P, size: bytes.length }), null);
	assert.equal(q.claimUpload({ hash, docId: D, path: P, size: bytes.length }, src(bytes)), "unavailable");
	assert.deepEqual(q.claimDownload({ hash, docId: D, path: P, size: bytes.length }), { t: "unavailable" });
	assert.deepEqual(q.queued(), []);
	assert.equal(q.nextDueInMs(), null, "nothing to retry: a store that appears later restarts the runtime");
	assert.deepEqual(notices, [], "no notice about the server's blob storage");
	const db = await storage.open<DiskSchema>("b", DB_SCHEMA_VERSION, STORE_SPECS);
	assert.deepEqual(await db.tx([STORE.blobQueue], "readonly", (tx) => tx.getAll(STORE.blobQueue)), []);
});

test("concurrent uploads of one hash share one transfer", async () => {
	const { q, store } = await make();
	const bytes = rnd(10, 9);
	const hash = sha256Hex(bytes);
	const [a, b] = await Promise.all([q.upload({ hash, docId: D, path: P, bytes }), q.upload({ hash, docId: D, path: P, bytes })]);
	assert.equal(a && b, true);
	assert.equal(store!.puts, 1);
});

test("liveHashes: queued records, running transfers and confirmed uploads, both directions (GC live set); a confirmed upload drops out after CONFIRMED_TTL_MS", async () => {
	const { q, store, clock } = await make();
	const queued = rnd(64, 2);
	const running = rnd(64, 3);
	const qh = sha256Hex(queued) as ContentHash;
	const rh = sha256Hex(running) as ContentHash;
	store!.down = true;
	assert.equal(await q.upload({ hash: qh, docId: D, path: P, bytes: queued }), false);
	assert.deepEqual([...q.liveHashes()], [qh]);
	store!.down = false;
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const put = store!.put.bind(store);
	store!.put = async (a, b) => { await gate; return put(a, b); };
	const up = q.upload({ hash: rh, docId: D, path: P, bytes: running });
	for (let i = 0; i < 20 && !q.liveHashes().has(rh); i++) await new Promise((r) => setTimeout(r, 1));
	assert.deepEqual([...q.liveHashes()].sort(), [qh, rh].sort(), "running upload, by hash without its direction prefix");
	release();
	assert.equal(await up, true);
	assert.deepEqual([...q.liveHashes()].sort(), [qh, rh].sort(), "confirmed: live until its ns op can reference it");
	clock.advance(CONFIRMED_TTL_MS);
	assert.deepEqual([...q.liveHashes()], [qh]);
});

// ---- background transfers (claims) -----------------------------------------------------------

test("claimUpload: starts in the background, a second doc joins; both are woken once stored; claims answer stored from the memo until CONFIRMED_TTL_MS, then the store is asked again (has, no second put)", async () => {
	const store = new GatedStore();
	const { q, woken, clock } = await make({ store });
	const bytes = rnd(5000, 21);
	const hash = sha256Hex(bytes);
	let reads = 0;
	const source: UploadSource = { read: async () => (reads++, bytes), changed: () => assert.fail("the bytes match") };
	const claim = (docId: DocId, path: VaultPath) => q.claimUpload({ hash, docId, path, size: bytes.length }, source);
	assert.equal(claim(D, P), "busy");
	await until(() => store.held === 1, "the put");
	assert.equal(claim(D2, P2), "busy", "joined");
	assert.deepEqual(q.queued().map((t) => t.state), ["running"]);
	assert.equal(reads, 1);
	assert.deepEqual(woken, []);
	store.releaseAll();
	await until(() => woken.length === 1, "the wake");
	assert.deepEqual(woken, [[D, D2]], "one wake naming every claimant");
	assert.equal(claim(D, P), "stored");
	assert.ok(q.liveHashes().has(hash as ContentHash), "a confirmed upload stays live for GC until its ns op is out");
	assert.equal(store.puts, 1);
	clock.advance(CONFIRMED_TTL_MS);
	assert.equal(claim(D, P), "busy", "memo expired: confirm with the store again");
	await until(() => woken.length === 2, "the second wake");
	assert.equal(claim(D, P), "stored");
	assert.equal(store.puts, 1, "has() found it: no second put");
});

test("claimUpload: bytes that no longer hash to the claim ask for a re-hash and leave no record; an unreadable file backs off", async () => {
	const { q, store, woken } = await make();
	const bytes = rnd(100, 22);
	const stale = sha256Hex(rnd(100, 23));
	let changed = 0;
	assert.equal(q.claimUpload({ hash: stale, docId: D, path: P, size: 100 }, src(bytes, () => changed++)), "busy");
	await until(() => woken.length === 1, "the wake");
	assert.equal(changed, 1);
	assert.equal(store!.puts, 0);
	assert.deepEqual(q.queued(), [], "not a failure: the re-plan uploads the new bytes");
	const hash = sha256Hex(bytes);
	assert.equal(q.claimUpload({ hash, docId: D, path: P, size: 100 }, src(null)), "busy");
	await until(() => woken.length === 2, "the second wake");
	assert.deepEqual(q.queued().map((t) => [t.state, t.attempts]), [["backoff", 1]]);
	assert.equal(q.claimUpload({ hash, docId: D, path: P, size: 100 }, src(bytes)), "unavailable", "re-plans cannot spin on it");
});

test("claimDownload: one download for every claimant; the bytes are single use and count against the budget until taken; endPass drops them only for a covering pass begun after they arrived", async () => {
	const store = new GatedStore();
	const { q, woken } = await make({ store });
	const bytes = rnd(3000, 24);
	const hash = sha256Hex(bytes);
	store.gated = false;
	assert.equal(await q.upload({ hash, docId: D, path: P, bytes }), true);
	store.gated = true;
	const req = { hash, docId: D, path: P, size: bytes.length };
	const running = q.beginPass();
	assert.deepEqual(q.claimDownload(req), { t: "busy" });
	assert.deepEqual(q.claimDownload({ ...req, docId: D2, path: P2 }), { t: "busy" });
	await until(() => store.held === 1, "the get");
	assert.equal(store.calls.length, 1, "one get");
	store.releaseAll();
	await until(() => woken.length === 1, "the wake");
	assert.deepEqual(woken[0], [D, D2]);
	assert.equal(q.bytesInFlight, BLOB_TRANSFER_MIN_COST, "ready bytes hold their share of the budget");
	q.endPass(running, () => true);
	assert.deepEqual(q.queued().map((t) => t.state), ["ready"], "the pass running when they arrived planned without them: kept");
	const got = q.claimDownload(req);
	assert.equal(got.t, "bytes");
	assert.deepEqual(got.t === "bytes" ? got.bytes : null, bytes);
	assert.equal(q.bytesInFlight, 0);
	assert.deepEqual(q.claimDownload(req), { t: "busy" }, "taken: the next claim downloads again");
	await until(() => store.held === 1, "the second get");
	store.releaseAll();
	await until(() => woken.length === 2, "the second wake");
	const later = q.beginPass();
	q.endPass(later, (d) => d === D2);
	assert.equal(q.queued().length, 1, "a pass over other docs keeps them");
	q.endPass(later, (d) => d === D);
	assert.deepEqual(q.queued(), [], "a pass over their doc that took none drops them");
	assert.equal(q.bytesInFlight, 0);
});

test("byte budget: transfers start in claim order while running and ready bytes fit; one larger than the budget runs alone once nothing else is in flight and is not starved by smaller ones behind it", async () => {
	const store = new GatedStore();
	const budget = 2 * BLOB_TRANSFER_MIN_COST;
	const { q } = await make({ store, budgetBytes: budget });
	const blobs = [rnd(1000, 31), rnd(1000, 32), rnd(budget + MiB, 33), rnd(1000, 34), rnd(1000, 35)].map((bytes) => ({ bytes, hash: sha256Hex(bytes) }));
	const [s1, s2, big, s3, s4] = blobs.map((b) => b.hash) as [string, string, string, string, string];
	// One doc per blob: a doc's new claim would drop its claim on bytes not started yet (forget).
	const claim = (i: number) => q.claimUpload({ hash: blobs[i]!.hash, docId: `doc${i}` as DocId, path: P, size: blobs[i]!.bytes.length }, src(blobs[i]!.bytes));
	const state = () => new Map(q.queued().map((t) => [t.hash, t.state]));
	let peak = 0;
	const watch = () => (peak = Math.max(peak, q.bytesInFlight));
	for (let i = 0; i < 4; i++) assert.equal(claim(i), "busy", `claim ${i}`), watch();
	await until(() => store.held === 2, "two puts");
	assert.deepEqual([state().get(s1), state().get(s2), state().get(big), state().get(s3)], ["running", "running", "pending", "pending"]);
	store.release(0);
	await until(() => state().get(s1) === undefined, "s1 stored");
	watch();
	assert.equal(state().get(big), "pending", "the large one waits for an idle queue");
	assert.equal(state().get(s3), "pending", "and the small one behind it does not jump it (FIFO)");
	store.release(0);
	await until(() => store.held === 1 && store.calls[0]!.size > budget, "the large put, alone");
	watch();
	assert.equal(q.bytesInFlight, budget + MiB);
	assert.equal(claim(4), "busy");
	assert.equal(state().get(s4), "pending");
	store.release(0);
	await until(() => store.held === 2, "s3 and s4");
	watch();
	store.releaseAll();
	await until(() => q.queued().length === 0, "all stored");
	assert.equal(peak, budget + MiB, "never more than max(budget, one blob) in flight");
	assert.equal(store.peak, budget + MiB);
	assert.equal(q.bytesInFlight, 0);
});

test("byte budget: a download no job took yet keeps its share until taken", async () => {
	const store = new GatedStore();
	const { q, woken } = await make({ store, budgetBytes: BLOB_TRANSFER_MIN_COST });
	const a = rnd(500, 41), b = rnd(500, 42);
	store.gated = false;
	for (const bytes of [a, b]) assert.equal(await q.upload({ hash: sha256Hex(bytes), docId: D, path: P, bytes }), true);
	store.gated = true;
	const reqA = { hash: sha256Hex(a), docId: D, path: P, size: 500 };
	const reqB = { hash: sha256Hex(b), docId: D2, path: P2, size: 500 };
	q.claimDownload(reqA);
	q.claimDownload(reqB);
	await until(() => store.held === 1, "a's get");
	store.releaseAll();
	await until(() => woken.length === 1, "a ready");
	await new Promise((r) => setImmediate(r));
	assert.equal(store.held, 0, "a's bytes fill the budget: b waits");
	assert.equal(q.claimDownload(reqA).t, "bytes");
	await until(() => store.held === 1, "b's get, once a was taken");
});

test("stop(): aborts the transfers in flight (the store sees the signal), answers the awaited calls, wakes nobody, leaves no record; claims answer unavailable", async () => {
	const store = new GatedStore();
	const { q, woken, storage } = await make({ store });
	const a = rnd(700, 51), b = rnd(700, 52);
	assert.equal(q.claimUpload({ hash: sha256Hex(a), docId: D, path: P, size: 700 }, src(a)), "busy");
	const awaited = q.upload({ hash: sha256Hex(b), docId: D2, path: P2, bytes: b });
	await until(() => store.held === 2, "both puts");
	await q.stop();
	assert.equal(store.held, 0, "both aborted");
	assert.equal(await awaited, false);
	assert.deepEqual(woken, [], "a stop is no outcome: the next start's pass plans the upload again (L != S)");
	assert.deepEqual(q.queued(), []);
	assert.equal(storage.dump("b", "blobQueue").length, 0, "and no backoff for it");
	assert.equal(q.claimUpload({ hash: sha256Hex(a), docId: D, path: P, size: 700 }, src(a)), "unavailable");
	assert.equal(store.puts, 0);
});

test("admit: nothing starts while it says no; pump() starts the queue once it says yes", async () => {
	const store = new GatedStore();
	let open = false;
	const { q } = await make({ store, admit: () => open });
	const bytes = rnd(300, 61);
	assert.equal(q.claimUpload({ hash: sha256Hex(bytes), docId: D, path: P, size: 300 }, src(bytes)), "busy");
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
	assert.equal(store.held, 0);
	assert.deepEqual(q.queued().map((t) => t.state), ["pending"]);
	q.pump();
	assert.equal(store.held, 0, "pump re-checks admit");
	open = true;
	q.pump();
	await until(() => store.held === 1, "the put");
});

test("forget: a doc that claims new bytes drops its claim on the old ones not started yet; another doc's claim keeps them", async () => {
	const store = new GatedStore();
	const { q } = await make({ store, budgetBytes: BLOB_TRANSFER_MIN_COST });
	const [first, old, shared, newer, next] = [71, 72, 73, 74, 75].map((seed) => rnd(200, seed)) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
	const claim = (bytes: Uint8Array, docId: DocId) => q.claimUpload({ hash: sha256Hex(bytes), docId, path: P, size: 200 }, src(bytes));
	const hashes = () => q.queued().map((t) => t.hash);
	claim(first, D3); // runs alone (the budget fits one); the rest wait behind it
	claim(old, D);
	claim(shared, D2);
	assert.deepEqual(q.queued().map((t) => t.state), ["running", "pending", "pending"]);
	claim(shared, D);
	assert.deepEqual(hashes(), [first, shared].map(sha256Hex), "D moved on from `old`: nobody wants it");
	claim(newer, D);
	assert.deepEqual(hashes(), [first, shared, newer].map(sha256Hex), "D2 still wants `shared`");
	claim(next, D2);
	assert.deepEqual(hashes(), [first, newer, next].map(sha256Hex));
	claim(newer, D3);
	assert.deepEqual(hashes(), [first, newer, next].map(sha256Hex), "D3 moved on from `first`, but a running transfer is never forgotten");
	await until(() => store.held === 1, "the first put");
	store.gated = false;
	store.releaseAll();
	await until(() => q.queued().length === 0, "the rest stored");
	assert.equal(store.puts, 3);
});

test("link lost: TransferLink.abort ends the store call in flight; the transfer backs off, wakes its doc, and the retry stores", async () => {
	const store = new GatedStore();
	const link = new TransferLink();
	const { q, woken, clock } = await make({ store: link.wrap(store) });
	const bytes = rnd(900, 81);
	const hash = sha256Hex(bytes);
	const claim = () => q.claimUpload({ hash, docId: D, path: P, size: 900 }, src(bytes));
	assert.equal(claim(), "busy");
	await until(() => store.held === 1, "the put");
	assert.equal(link.abort("close 1006"), 1, "one call in flight");
	await until(() => woken.length === 1, "the wake");
	assert.equal(store.held, 0);
	assert.deepEqual(q.queued().map((t) => [t.state, t.attempts]), [["backoff", 1]]);
	assert.equal(claim(), "unavailable", "backing off");
	clock.advance(BLOB_RETRY_BASE_MS);
	store.gated = false;
	assert.equal(claim(), "busy", "a fresh signal: the link's abort does not stick");
	await until(() => woken.length === 2, "the retry's wake");
	assert.equal(claim(), "stored");
	assert.equal(store.puts, 1);
	assert.deepEqual(q.queued(), []);
});

test("a retry pending or running is not due: nextDueInMs skips it until it ends (else the scheduler arms a 5 ms full pass for the whole transfer); its failure arms the next backoff", async () => {
	const store = new GatedStore();
	const link = new TransferLink();
	const { q, woken, clock } = await make({ store: link.wrap(store), budgetBytes: BLOB_TRANSFER_MIN_COST });
	const bytes = rnd(700, 82), other = rnd(700, 83);
	const hash = sha256Hex(bytes);
	const claim = () => q.claimUpload({ hash, docId: D, path: P, size: 700 }, src(bytes));
	assert.equal(claim(), "busy");
	await until(() => store.held === 1, "the put");
	link.abort("close 1006");
	await until(() => woken.length === 1, "the wake");
	assert.equal(q.nextDueInMs(), BLOB_RETRY_BASE_MS);
	clock.advance(BLOB_RETRY_BASE_MS + 1_000);
	assert.equal(q.nextDueInMs(), 0, "due: the scheduler's pass claims it");
	// Another doc's upload holds the whole budget: the retry is claimed but waits.
	assert.equal(q.claimUpload({ hash: sha256Hex(other), docId: D2, path: P2, size: 700 }, src(other)), "busy");
	await until(() => store.held === 1, "the other put");
	assert.equal(claim(), "busy");
	assert.equal(q.nextDueInMs(), null, "pending behind the budget: not due");
	store.release(0);
	await until(() => woken.length === 2 && store.calls[0]?.address === `addr-${hash.slice(0, 16)}`, "the retry's put");
	assert.equal(q.nextDueInMs(), null, "running: not due; its end wakes the doc");
	link.abort("close 1006");
	await until(() => woken.length === 3, "the retry's wake");
	assert.equal(q.nextDueInMs(), backoffMs(2), "the next backoff, counted from its end");
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
	assert.equal(c.q.maxBlobBytes, maxSealedBlobPlaintext(a.store!.maxBlobBytes), "plaintext cap under suite 1");
});

test("suite 1: a file above the sealed cap is not synced: upload refuses with a notice, nothing stored", async () => {
	const { q, store, notices } = await make({ crypto: await suite1(0xa2) });
	const bytes = new Uint8Array(q.maxBlobBytes + 1);
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
	assert.deepEqual(r.q.claimDownload({ hash, docId: D, path: P, size: bytes.length }), { t: "unavailable" }, "a claim skips it too");
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


