/**
 * Large updates end to end through SimRelay (DESIGN §b.6, §j.1; §k.3 WP-C #3):
 * > MAX_INLINE_UPDATE_BYTES -> x: chunks + held bodyUpdateRef, resolved by live
 * peers, bound views and fresh catch-up; > MAX_LOG_BLOB_BYTES without a blob
 * store -> oversize-local freeze with the replica reloaded from durable state.
 * Suite 1 (e2ee-design §10.2): the store path sealed at the blob address, and
 * the download taxonomy end to end (tampered -> blob-corrupt freeze only under
 * a verified key; absent -> retried, never quarantined).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOB_CHUNK_BYTES, MAX_INLINE_UPDATE_BYTES, MAX_LOG_BLOB_BYTES } from "../../core/limits";
import { decodeBodyUpdateRef } from "../../core/codec/contents";
import { KEYRING_STREAM, streamClass, type DocId } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { BlobAddress, CryptoPort } from "../../ports/crypto";
import { SeededRandom } from "../../sim/random";
import { SimRelay } from "../../sim/relay";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { rawAppend } from "../keyring/testkit/engines";
import { genesis } from "../keyring/testkit/world";
import { applyChanges, type TextChanges } from "../body/textChanges";
import type { LogEngine } from "./engine";
import { converged, sleep, startTestEngine, testPorts, testStorage, until } from "./testHarness";

const BUDGETS = { maxResidentBytes: 1024 * 1024 * 1024, maxResidentDocs: 64 };

/** A bound view's text as main keeps it: the bind text, then every onBoundText change (none before the bind read). */
function boundView() {
	const v = { text: null as string | null };
	const sink = {
		insert: (i: number, t: string) => void (v.text = v.text!.slice(0, i) + t + v.text!.slice(i)),
		delete: (i: number, n: number) => void (v.text = v.text!.slice(0, i) + v.text!.slice(i + n)),
	};
	return { v, onBoundText: (_id: DocId, changes: TextChanges) => void (v.text !== null && applyChanges(sink, changes)) };
}

async function live(...es: LogEngine[]): Promise<void> {
	await until(() => es.every((e) => e.status().phase === "live"), 3_000, "live");
}

test("large update: x: chunks + bodyUpdateRef reach a live peer, its bound view, and a fresh engine via catch-up", async () => {
	const relay = new SimRelay();
	const host = boundView();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", extra: { budgets: BUDGETS } });
	const { engine: b } = await startTestEngine({
		relay, deviceId: "dev-b",
		extra: { budgets: BUDGETS, onBoundText: host.onBoundText },
	});
	let c: LogEngine | null = null;
	try {
		await live(a, b);
		const id = await a.createDoc("big.md", "seed;");
		await converged([a, b]);
		await b.bind(id);
		host.v.text = b.boundText(id);
		const big = "z".repeat(MAX_INLINE_UPDATE_BYTES + 300_000);
		await a.editDoc(id, (t) => t.insert(t.length, big));
		await converged([a, b], 15_000);
		const want = "seed;" + big;
		assert.equal(await b.docText(id), want);
		assert.equal(host.v.text, want, "bound view got the resolved update");
		const xs = relay.streams().filter((s) => streamClass(s) === "blobchunk");
		assert.equal(xs.length, 1);
		const chunkRows = relay.rows(xs[0]!);
		assert.ok(chunkRows.length >= 2 && chunkRows.length <= Math.ceil((big.length + 64) / BLOB_CHUNK_BYTES));
		const refRow = relay.rows(a.streamOf(id)).at(-1)!;
		assert.ok(refRow.seq > chunkRows.at(-1)!.seq, "ref committed after its last chunk");
		assert.ok(refRow.payload.length < 1024, "the body row carries only the ref");
		assert.equal(a.c.outbox.size, 0);

		c = (await startTestEngine({ relay, deviceId: "dev-c", extra: { budgets: BUDGETS } })).engine;
		await converged([a, b, c], 15_000);
		assert.equal(await c.docText(id), want);
		await c.editDoc(id, (t) => t.insert(0, "C;"));
		await converged([a, b, c], 15_000);
		assert.ok((await a.docText(id)).startsWith("C;seed;zzz"));
	} finally {
		await a.stop();
		await b.stop();
		await c?.stop();
	}
});

test("oversize-local: an update > MAX_LOG_BLOB_BYTES with no blob store freezes the doc, nothing is sent, the replica reloads from durable state", async () => {
	const relay = new SimRelay();
	const frozen: string[] = [];
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", extra: { budgets: BUDGETS, onDocFrozen: (_id: DocId, r: string) => frozen.push(r) } });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", extra: { budgets: BUDGETS } });
	try {
		await live(a, b);
		const id = await a.createDoc("over.md", "keep;");
		await converged([a, b]);
		const head0 = relay.head();
		await a.editDoc(id, (t) => t.insert(t.length, "o".repeat(MAX_LOG_BLOB_BYTES + 1000)));
		await until(() => a.c.repo.stream(a.streamOf(id))?.frozen === 1, 10_000, "frozen");
		const rec = a.c.repo.stream(a.streamOf(id))!;
		assert.equal(rec.frozenReason, "oversize-local");
		assert.deepEqual(frozen, ["oversize-local"]);
		assert.ok(a.status().notices.some((n) => n.code === "frozen:oversize-local"));
		await sleep(100);
		assert.equal(relay.head(), head0, "nothing appended");
		assert.equal(a.c.outbox.size, 0);
		assert.equal(await a.docText(id), "keep;", "replica = durable state (unsent update discarded)");
		await assert.rejects(a.editDoc(id, (t) => t.insert(0, "x")), /frozen/);

		assert.deepEqual(await a.releaseQuarantine(id), { passed: 0, dismissed: 0 });
		assert.equal(a.c.repo.stream(a.streamOf(id))!.frozen, 0);
		await a.editDoc(id, (t) => t.insert(0, "after;"));
		await converged([a, b]);
		assert.equal(await b.docText(id), "after;keep;");
		assert.equal(b.c.repo.stream(b.streamOf(id))!.frozen, 0, "peer never saw a dependency on unsent structs");
	} finally {
		await a.stop();
		await b.stop();
	}
});

// ---- Suite 1 (e2ee-design §10, WP-E6a): oversize updates through a shared blob store ----

const VAULT1 = "AAAAAAAAAAAAAAAAAAAAAA";
const K1 = Uint8Array.from({ length: 32 }, (_, i) => i);

/** One store shared by every device; `mode` simulates bytes tampered at rest (a flipped ciphertext byte) or a missing object. */
class SharedBlobs implements BlobPort {
	readonly maxBlobBytes = 10 * 1024 * 1024;
	readonly objects = new Map<BlobAddress, Uint8Array>();
	mode: "ok" | "tampered" | "absent" = "ok";
	gets = 0;
	async has(a: readonly BlobAddress[]): Promise<ReadonlySet<BlobAddress>> {
		return new Set(a.filter((x) => this.objects.has(x)));
	}
	async put(a: BlobAddress, b: Uint8Array): Promise<void> {
		this.objects.set(a, b.slice());
	}
	async get(a: BlobAddress): Promise<Uint8Array | null> {
		this.gets++;
		const b = this.objects.get(a);
		if (!b || this.mode === "absent") return null;
		const o = b.slice();
		if (this.mode === "tampered") o[40]! ^= 1;
		return o;
	}
}

/** A suite-1 engine on the shared store: K_1, KCV-verified unless `unverified` (then keyState reports it unchecked; sealing is unaffected). */
async function suite1Engine(relay: SimRelay, deviceId: string, store: SharedBlobs, seed: number, unverified = false): Promise<LogEngine> {
	const s1 = await createWebCryptoSuite1({ vaultId: VAULT1, random: new SeededRandom(seed), keys: [{ e: 1, k: K1.slice() }] });
	const g = await genesis(undefined, K1);
	// The vault's `k` holds the genesis, as a created vault does; the device has it stored (§6.1).
	if (relay.rows(KEYRING_STREAM).length === 0) await rawAppend(relay, KEYRING_STREAM, g);
	const e2ee = { suite: 1 as const, records: [g], persist: async () => undefined };
	const crypto: CryptoPort = unverified ? { ...s1, keyState: (e) => ({ held: s1.keyState(e).held, verified: false }) } : s1;
	const storage = testStorage();
	return (await startTestEngine({
		relay, deviceId, vaultId: VAULT1, storage, crypto, e2ee, tuning: { blobQuarantineMinMs: 300 },
		extra: { budgets: BUDGETS, ports: { ...testPorts(relay, storage, crypto), blob: store } },
	})).engine;
}

test("suite 1: an oversize update goes to the store sealed at blobAddress(sha256); a peer opens it; a re-upload is deduped", async () => {
	const relay = new SimRelay();
	const store = new SharedBlobs();
	const a = await suite1Engine(relay, "dev-a", store, 11);
	const b = await suite1Engine(relay, "dev-b", store, 12);
	try {
		await live(a, b);
		const id = await a.createDoc("big.md", "seed;");
		await converged([a, b]);
		await b.bind(id);
		const big = "z".repeat(MAX_INLINE_UPDATE_BYTES + 300_000);
		await a.editDoc(id, (t) => t.insert(t.length, big));
		await converged([a, b], 15_000);
		assert.equal(await b.docText(id), "seed;" + big);
		assert.equal(store.objects.size, 1);
		assert.equal(relay.streams().filter((s) => streamClass(s) === "blobchunk").length, 0, "store path: no x: stream");
		const [addr, sealed] = [...store.objects][0]!;
		assert.match(addr, /^[0-9a-f]{64}$/);
		assert.equal(sealed[0], 1, "blobFormat 1");
		assert.equal(sealed[1], 1, "suite 1");
		// The ref (sealed in the body row) names the plaintext sha256; the store only ever sees its HMAC address.
		const refRow = relay.rows(a.streamOf(id)).at(-1)!;
		const tail = await b.c.repo.getTail(b.streamOf(id), 0);
		const ref = tail.find((r) => r.kind === "bodyUpdateRef")!;
		const hash = decodeBodyUpdateRef(ref.content)!.hash;
		assert.equal(await b.c.deps.crypto.blobAddress(hash), addr);
		assert.notEqual(addr, hash);
		const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
		assert.ok(!hex(refRow.payload).includes(hash) && !hex(sealed).includes(hash), "no plaintext hash on the wire or at rest");
		assert.equal(await store.has([addr]).then((s) => s.size), 1);
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("suite 1: tampered at rest -> retried with backoff, then the doc freezes blob-corrupt (verified key only); repaired + release -> resolved", async () => {
	const relay = new SimRelay();
	const store = new SharedBlobs();
	const a = await suite1Engine(relay, "dev-a", store, 21);
	const b = await suite1Engine(relay, "dev-b", store, 22);
	const c = await suite1Engine(relay, "dev-c", store, 23, true);
	try {
		await live(a, b, c);
		const id = await a.createDoc("big.md", "seed;");
		await converged([a, b, c]);
		await b.bind(id);
		await c.bind(id);
		store.mode = "tampered";
		const t0 = Date.now();
		const big = "q".repeat(MAX_INLINE_UPDATE_BYTES + 200_000);
		await a.editDoc(id, (t) => t.insert(t.length, big));
		const sb = b.streamOf(id);
		await until(() => b.c.repo.stream(sb)?.frozen === 1, 10_000, "b frozen");
		assert.ok(Date.now() - t0 >= 300, "not before blobQuarantineMinMs");
		assert.equal(b.c.repo.stream(sb)!.frozenReason, "blob-corrupt");
		assert.ok(b.status().notices.some((n) => n.code === "frozen:blob-corrupt"));
		assert.equal(await b.docText(id), "seed;", "nothing applied");
		// The same bytes under a key that is not KCV-checked: never deterministic, so c keeps retrying unfrozen.
		const gets = store.gets;
		await sleep(600);
		assert.equal(c.c.repo.stream(c.streamOf(id))!.frozen, 0);
		assert.ok(store.gets > gets, "still retried");
		assert.equal(await c.docText(id), "seed;");
		// Repaired at rest: c resolves on its own timer; b only after the user releases the doc.
		store.mode = "ok";
		await until(async () => (await c.docText(id)) === "seed;" + big, 5_000, "c resolved");
		await sleep(500);
		assert.equal(b.c.repo.stream(sb)!.frozen, 1, "frozen stays frozen until released");
		assert.deepEqual(await b.releaseQuarantine(id), { passed: 0, dismissed: 0 });
		await until(async () => (await b.docText(id)) === "seed;" + big, 5_000, "b resolved after release");
		assert.equal(b.c.repo.stream(sb)!.frozen, 0);
		assert.ok(!b.status().notices.some((n) => n.code === "frozen:blob-corrupt"));
	} finally {
		await a.stop();
		await b.stop();
		await c.stop();
	}
});

test("suite 1: an absent blob is retried with backoff and never quarantined; it resolves once present", async () => {
	const relay = new SimRelay();
	const store = new SharedBlobs();
	const a = await suite1Engine(relay, "dev-a", store, 31);
	const b = await suite1Engine(relay, "dev-b", store, 32);
	try {
		await live(a, b);
		const id = await a.createDoc("big.md", "seed;");
		await converged([a, b]);
		await b.bind(id);
		store.mode = "absent";
		const big = "w".repeat(MAX_INLINE_UPDATE_BYTES + 100_000);
		await a.editDoc(id, (t) => t.insert(t.length, big));
		await until(() => store.gets >= 6, 10_000, "several attempts");
		await sleep(400);
		assert.equal(b.c.repo.stream(b.streamOf(id))!.frozen, 0, "absent: not deterministic");
		assert.equal(await b.docText(id), "seed;");
		store.mode = "ok";
		await until(async () => (await b.docText(id)) === "seed;" + big, 5_000, "resolved on the retry timer");
	} finally {
		await a.stop();
		await b.stop();
	}
});
