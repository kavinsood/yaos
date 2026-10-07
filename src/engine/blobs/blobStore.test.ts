/**
 * The blob store path under suite 1 (e2ee-design §10, WP-E6a): addressing and dedupe, the plaintext cap, a
 * full snapshot part sealed within the transport cap, the download taxonomy of getOpened (§10.2: every failure
 * is unavailable; only a failure under a verified key, or an unparseable header, is deterministic) and the
 * quarantine rule (BlobFailureStreaks). The golden bytes are in suite1Golden.test.ts (storeAbc2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { concatBytes } from "../../core/codec/lib0";
import { sha256Hex } from "../../core/hash/sha256";
import { MAX_BLOB_PLAINTEXT_BYTES_SUITE1 } from "../../core/limits";
import { sealedBlobBytes } from "../../core/codec/sealedBlob";
import { snapPartBytes } from "../../core/snap/bundle";
import type { ContentHash } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { BlobAddress, SealedBlobParts } from "../../ports/crypto";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { ScriptedRandom } from "../adapters/testkit/scriptedRandom";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { createWebHash } from "../adapters/webHash";
import { BlobFailureStreaks, getOpened, putSealed, storePlaintextCap, type PutPolicy } from "./blobStore";
/** The pre-GC put policy: a present address is re-used, nothing recorded. */
const REUSE_ALL: PutPolicy = { reuse: async () => true, noted: async () => {} };


const VAULT = "AAAAAAAAAAAAAAAAAAAAAA";
const MIB = 1024 * 1024;
const K1 = Uint8Array.from({ length: 32 }, (_, i) => i);
const K2 = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i);
const nonce = (tag: number, i: number) => Uint8Array.from([tag, i >>> 24, (i >>> 16) & 0xff, (i >>> 8) & 0xff, i & 0xff, 0, 0, 0, 0, 0, 0, 0]);

/** A suite-1 port: every key holds K1 for epoch 1; `e2` = the epoch-2 key (null = not held); verified as listed. */
async function port(o: { tag: number; e2?: Uint8Array | null; verified?: readonly number[]; seal?: number }) {
	const random = new ScriptedRandom();
	for (let i = 0; i < 16; i++) random.push(nonce(o.tag, i));
	const keys = [{ e: 1, k: K1.slice() }, ...(o.e2 === null ? [] : [{ e: 2, k: (o.e2 ?? K2).slice() }])];
	const c = await createWebCryptoSuite1({ vaultId: VAULT, random, keys });
	for (const e of o.verified ?? [1, 2]) c.markVerified(e);
	if (o.seal) c.setSealEpoch(o.seal);
	return c;
}

class MemStore implements BlobPort {
	readonly objects = new Map<string, Uint8Array>();
	puts = 0;
	down = false;
	constructor(readonly maxBlobBytes = 10 * MIB) {}
	async has(a: readonly BlobAddress[]) { if (this.down) throw new Error("503"); return new Set(a.filter((x) => this.objects.has(x))); }
	async put(a: BlobAddress, parts: SealedBlobParts) {
		if (this.down) throw new Error("503");
		const b = concatBytes(parts);
		if (b.length > this.maxBlobBytes) throw new Error(`413: ${b.length} > ${this.maxBlobBytes}`);
		this.puts++;
		this.objects.set(a, b);
	}
	async get(a: BlobAddress) { if (this.down) throw new Error("503"); return this.objects.get(a)?.slice() ?? null; }
	async list(): Promise<never> { throw new Error("unused"); }
	async deleteIfUploadedBefore(): Promise<never> { throw new Error("unused"); }
}

const bytes = (n: number, seed = 1) => { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; b[i] = x >>> 24; } return b; };
const flip = (b: Uint8Array, i: number) => { const o = b.slice(); o[i]! ^= 1; return o; };

test("putSealed: one object at blobAddress(sha256) (never the hash), deduped by has(); the plaintext cap is the suite's", async () => {
	const w = await port({ tag: 0xa0, seal: 2 });
	const store = new MemStore();
	const pt = bytes(5000);
	const hash = sha256Hex(pt) as ContentHash;
	await putSealed(store, w, hash, pt, REUSE_ALL);
	await putSealed(store, w, hash, pt, REUSE_ALL);
	assert.equal(store.puts, 1);
	const [key] = [...store.objects.keys()];
	assert.equal(key, await w.blobAddress(hash));
	assert.ok(!key!.includes(hash), "the plaintext hash never appears in the key");
	assert.equal(storePlaintextCap(w, store), MAX_BLOB_PLAINTEXT_BYTES_SUITE1);
	assert.equal(storePlaintextCap(createNoopCrypto(createWebHash()), store), 10 * MIB, "suite 0: the transport cap");
	const small = storePlaintextCap(w, new MemStore(4 * MIB));
	assert.ok(sealedBlobBytes(small, Number.MAX_SAFE_INTEGER) <= 4 * MIB && sealedBlobBytes(small + 1, 1) > 4 * MIB, "a smaller store: what still fits once sealed");
});

test("a full snapshot part (8 MiB at a 10 MiB store) sealed under suite 1 is 8 650 783 B: within maxBlobBytes", async () => {
	const w = await port({ tag: 0xa1, seal: 1 });
	const store = new MemStore(10 * MIB);
	const part = bytes(snapPartBytes(store.maxBlobBytes), 3);
	assert.equal(part.length, 8 * MIB);
	const hash = sha256Hex(part) as ContentHash;
	await putSealed(store, w, hash, part, REUSE_ALL);
	const sealed = store.objects.get(await w.blobAddress(hash))!;
	assert.equal(sealed.length, 8_650_783);
	assert.equal(sealed.length, sealedBlobBytes(part.length, 1));
	assert.ok(sealed.length <= store.maxBlobBytes);
	const at = await port({ tag: 0xa2 });
	const got = await getOpened(store, at, hash, sha256Hex);
	assert.ok(got.ok && got.bytes.length === part.length);
	// The largest plaintext the suite takes also fits; MemStore refuses anything above maxBlobBytes (413).
	const max = bytes(MAX_BLOB_PLAINTEXT_BYTES_SUITE1, 4);
	await putSealed(store, w, sha256Hex(max) as ContentHash, max, REUSE_ALL);
	assert.equal(store.puts, 2);
});

test("getOpened: every failure is unavailable; deterministic only under a verified key or for an unparseable header", async () => {
	const w = await port({ tag: 0xb0, seal: 2 });
	const store = new MemStore();
	const pt = bytes(700, 5);
	const hash = sha256Hex(pt) as ContentHash;
	await putSealed(store, w, hash, pt, REUSE_ALL);
	const addr = await w.blobAddress(hash);
	const good = store.objects.get(addr)!;
	const reader = await port({ tag: 0xb1 });
	const unverified = await port({ tag: 0xb2, e2: new Uint8Array(32).fill(9), verified: [1] }); // wrong K_2, not KCV-checked
	const unverifiedRight = await port({ tag: 0xb3, verified: [1] }); // right K_2, not KCV-checked yet
	const noK2 = await port({ tag: 0xb4, e2: null, verified: [1] });
	const verdict = async (sealed: Uint8Array | null, c = reader) => {
		if (sealed) store.objects.set(addr, sealed);
		else store.objects.delete(addr);
		const r = await getOpened(store, c, hash, sha256Hex);
		return r.ok ? "ok" : `${r.reason}/${r.deterministic}`;
	};
	assert.equal(await verdict(good), "ok");
	assert.equal(await verdict(good, unverifiedRight), "ok", "an unverified but right key opens");
	assert.equal(await verdict(null), "absent/false");
	assert.equal(await verdict(flip(good, 40)), "auth-failed/true", "tampered at rest, key verified: content_corrupt");
	assert.equal(await verdict(flip(good, good.length - 1)), "auth-failed/true", "tag");
	assert.equal(await verdict(flip(good, 40), unverifiedRight), "auth-failed/false", "same bytes, unverified key: maybe ours");
	assert.equal(await verdict(good, unverified), "auth-failed/false", "wrong unverified K_2: never deterministic");
	assert.equal(await verdict(good, noK2), "unknown-key/false");
	assert.equal(await verdict(Uint8Array.from([2, ...good.subarray(1)])), "unsupported-suite/false", "blobFormat 2: an upgrade may read it");
	assert.equal(await verdict(good.subarray(0, 2)), "malformed/true", "no key epoch: unparseable header, key-independent");
	assert.equal(await verdict(good.subarray(0, 20)), "malformed/true", "too short under a verified key");
	assert.equal(await verdict(good.subarray(0, 20), unverifiedRight), "malformed/false");
	// A key holder sealing other bytes at the address: opens, but not to the reference.
	w.setSealEpoch(2);
	const other = concatBytes(await w.sealBlob({ address: addr, plaintext: bytes(700, 6) }));
	assert.equal(await verdict(other), "hash-mismatch/true");
	assert.equal(await verdict(other, unverifiedRight), "hash-mismatch/false");
	// No digest given (verifyBundle checks the part hash itself): opened bytes are returned as they are.
	store.objects.set(addr, other);
	assert.equal((await getOpened(store, reader, hash, null)).ok, true);
	// Store errors throw; the caller treats them as transport.
	store.down = true;
	await assert.rejects(getOpened(store, reader, hash, sha256Hex), /503/);
});

test("getOpened at suite 0: the stored bytes are the plaintext; a mismatch is deterministic (no key involved)", async () => {
	const c = createNoopCrypto(createWebHash());
	const store = new MemStore();
	const pt = bytes(300, 7);
	const hash = sha256Hex(pt) as ContentHash;
	await putSealed(store, c, hash, pt, REUSE_ALL);
	assert.deepEqual([...store.objects.keys()], [hash], "suite 0: the address is the hash");
	assert.deepEqual(await getOpened(store, c, hash, sha256Hex), { ok: true, bytes: pt });
	store.objects.set(hash, flip(pt, 0));
	assert.deepEqual(await getOpened(store, c, hash, sha256Hex), { ok: false, reason: "hash-mismatch", deterministic: true });
});

test("BlobFailureStreaks: quarantine after the initial attempt + 3 retries, all deterministic, spanning >= 3 min", () => {
	const s = new BlobFailureStreaks();
	const MIN = 60_000;
	assert.equal(s.note("k", true, 0), false);
	assert.equal(s.note("k", true, 2_000), false);
	assert.equal(s.note("k", true, 6_000), false);
	assert.equal(s.note("k", true, 14_000), false, "4 attempts within 14 s: too soon");
	assert.equal(s.note("k", true, 3 * MIN - 1), false);
	assert.equal(s.note("k", true, 3 * MIN), true);
	// A non-deterministic outcome (absent, transport, unknown key, unverified key) restarts the count.
	const r = new BlobFailureStreaks();
	r.note("k", true, 0);
	r.note("k", true, MIN);
	r.note("k", true, 2 * MIN);
	assert.equal(r.note("k", false, 3 * MIN), false);
	assert.equal(r.note("k", true, 4 * MIN), false);
	assert.equal(r.note("k", true, 5 * MIN), false);
	assert.equal(r.note("k", true, 6 * MIN), false);
	assert.equal(r.note("k", true, 7 * MIN), true, "4 deterministic attempts over 3 min since the restart");
	assert.equal(r.note("other", true, 7 * MIN), false, "per key");
	r.clear("k");
	assert.equal(r.note("k", true, 8 * MIN), false, "clear() restarts it");
	// Only ever non-deterministic: never.
	const n = new BlobFailureStreaks();
	for (let i = 0; i < 100; i++) assert.equal(n.note("k", false, i * MIN), false);
});
