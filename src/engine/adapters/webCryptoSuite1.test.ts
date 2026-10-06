import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, hkdfSync } from "node:crypto";
import { padmeLen } from "../../core/codec/padme";
import { hkdfInfo } from "./suite1Primitives";
import { MAX_BLOB_PLAINTEXT_BYTES_SUITE1 } from "../../core/limits";
import type { ContentHash } from "../../core/types";
import type { BlobAddress, SealPurpose } from "../../ports/crypto";
import { ScriptedRandom } from "./testkit/scriptedRandom";
import { spySubtle } from "./testkit/spySubtle";
import { createWebCryptoSuite1 } from "./webCryptoSuite1";

const VAULT = "AAAAAAAAAAAAAAAAAAAAAA";
const range = (from: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (from + i) & 0xff);
const K1 = range(0, 32);
const K2 = range(0x20, 32);
const N = (b: number) => new Uint8Array(12).fill(b);
const AAD = new Uint8Array([1, 2, 3]);
const PT = new TextEncoder().encode("plaintext");
const ADDR = "ab".repeat(32) as BlobAddress;

async function port(opts: { verified?: boolean; seal?: number; keys?: { e: number; k: Uint8Array }[]; subtle?: SubtleCrypto } = {}) {
	const random = new ScriptedRandom();
	const keys = opts.keys ?? [{ e: 1, k: K1.slice() }, { e: 2, k: K2.slice() }];
	const c = await createWebCryptoSuite1({ vaultId: VAULT, random, keys, subtle: opts.subtle });
	if (opts.verified !== false) for (const { e } of keys) c.markVerified(e);
	if (opts.seal) c.setSealEpoch(opts.seal);
	return { c, random };
}

describe("webCryptoSuite1: nonce and length checks (§4.1)", () => {
	it("seal refuses any nonce that is not exactly 12 bytes, before WebCrypto sees it", async () => {
		const spy = spySubtle();
		const { c, random } = await port({ subtle: spy.subtle });
		for (const len of [0, 11, 13, 16]) {
			random.push(new Uint8Array(len));
			await assert.rejects(c.seal({ purpose: "frame", keyEpoch: 1, aad: AAD, plaintext: PT }), /nonce must be 12 bytes/, `len ${len}`);
		}
		assert.equal(spy.calls.filter((m) => m === "encrypt").length, 0);
	});

	it("open of fewer than 28 sealed bytes is malformed and never reaches decrypt", async () => {
		const spy = spySubtle();
		const { c } = await port({ subtle: spy.subtle });
		for (const len of [0, 11, 12, 27]) {
			assert.deepEqual(await c.open({ purpose: "frame", suite: 1, keyEpoch: 1, aad: AAD, sealed: new Uint8Array(len) }), { ok: false, reason: "malformed" });
		}
		assert.equal(spy.calls.filter((m) => m === "decrypt").length, 0);
	});
});

describe("webCryptoSuite1: open classification", () => {
	it("suite, epoch, purpose, AAD and tag failures", async () => {
		const { c, random } = await port();
		random.push(N(1));
		const sealed = await c.seal({ purpose: "frame", keyEpoch: 1, aad: AAD, plaintext: PT });
		assert.equal(sealed.length, PT.length + 28);
		const open = (o: { purpose?: SealPurpose; suite?: number; keyEpoch?: number; aad?: Uint8Array; sealed?: Uint8Array }) =>
			c.open({ purpose: o.purpose ?? "frame", suite: (o.suite ?? 1) as 0 | 1, keyEpoch: o.keyEpoch ?? 1, aad: o.aad ?? AAD, sealed: o.sealed ?? sealed });
		assert.deepEqual(await open({}), { ok: true, plaintext: PT });
		assert.deepEqual(await open({ suite: 0 }), { ok: false, reason: "suite-downgrade" });
		assert.deepEqual(await open({ suite: 2 }), { ok: false, reason: "unsupported-suite" });
		assert.deepEqual(await open({ keyEpoch: 9 }), { ok: false, reason: "unknown-key" });
		assert.deepEqual(await open({ keyEpoch: 2 }), { ok: false, reason: "auth-failed" }, "no trial decryption across epochs");
		assert.deepEqual(await open({ purpose: "checkpoint" }), { ok: false, reason: "auth-failed" }, "frame opened as checkpoint");
		assert.deepEqual(await open({ aad: new Uint8Array([1, 2, 4]) }), { ok: false, reason: "auth-failed" });
		let flips = 0;
		for (let i = 0; i < sealed.length; i++) {
			const bad = sealed.slice();
			bad[i]! ^= 0x01;
			if (!(await open({ sealed: bad })).ok) flips++;
		}
		assert.equal(flips, sealed.length, "every single-byte flip of nonce, ciphertext or tag fails");
	});
});

describe("webCryptoSuite1: sealing rules", () => {
	it("no seal epoch until setSealEpoch; never seals under an unverified or missing key", async () => {
		const { c, random } = await port({ verified: false });
		assert.equal(c.sealEpoch(), 0);
		assert.deepEqual(c.keyState(1), { held: true, verified: false });
		assert.deepEqual(c.keyState(3), { held: false, verified: false });
		random.push(N(1), N(2));
		await assert.rejects(c.seal({ purpose: "frame", keyEpoch: 1, aad: AAD, plaintext: PT }), /unverified/);
		await assert.rejects(c.seal({ purpose: "frame", keyEpoch: 3, aad: AAD, plaintext: PT }), /not held/);
		await assert.rejects(c.sealBlob({ address: ADDR, plaintext: PT }), /not held/);
		assert.throws(() => c.setSealEpoch(1), /not verified/);
		c.markVerified(2);
		c.setSealEpoch(2);
		c.markVerified(1);
		assert.throws(() => c.setSealEpoch(1), /cannot go back/);
		assert.throws(() => c.drop(2), /seal epoch/);
	});
});

describe("webCryptoSuite1: blobs (§10)", () => {
	it("round trips with Padmé-bucketed lengths under the seal epoch", async () => {
		const { c, random } = await port({ seal: 2 });
		for (const n of [0, 1, 254, 255, 256, 1000, 70_000]) {
			random.push(N(n & 0xff));
			const pt = range(n, n);
			const sealed = await c.sealBlob({ address: ADDR, plaintext: pt });
			assert.equal(sealed.length, 3 + 28 + padmeLen(n + 1), `n=${n}`);
			assert.deepEqual([sealed[0], sealed[1], sealed[2]], [1, 1, 2]);
			assert.deepEqual(await c.openBlob({ address: ADDR, sealed }), { ok: true, plaintext: pt });
			assert.deepEqual(await c.openBlob({ address: "cd".repeat(32) as BlobAddress, sealed }), { ok: false, reason: "auth-failed" }, "address-bound");
		}
	});

	it("header, epoch, padding and cap failures", async () => {
		const { c, random } = await port({ seal: 1 });
		random.push(N(7));
		const sealed = await c.sealBlob({ address: ADDR, plaintext: PT });
		const with_ = (i: number, v: number) => { const b = sealed.slice(); b[i] = v; return b; };
		const open = (s: Uint8Array) => c.openBlob({ address: ADDR, sealed: s });
		assert.deepEqual(await open(with_(0, 2)), { ok: false, reason: "unsupported-suite" }, "blobFormat 2");
		assert.deepEqual(await open(with_(1, 0)), { ok: false, reason: "unsupported-suite" }, "suite 0");
		assert.deepEqual(await open(with_(2, 0)), { ok: false, reason: "malformed" }, "keyEpoch 0");
		assert.deepEqual(await open(with_(2, 5)), { ok: false, reason: "unknown-key" });
		assert.deepEqual(await open(with_(2, 2)), { ok: false, reason: "auth-failed" }, "relabelled epoch");
		assert.deepEqual(await open(sealed.subarray(0, 2)), { ok: false, reason: "malformed" });
		assert.deepEqual(await open(sealed.subarray(0, 30)), { ok: false, reason: "malformed" });
		// A key holder sealing a plaintext without the 0x80 marker: valid tag, bad padding -> deterministic malformed.
		const kBlob = hkdfSync("sha256", K1, Buffer.from("yaos-hkdf-v1"), hkdfInfo("blob", VAULT, 1), 32);
		const { blobAad } = await import("../../core/codec/sealedBlob");
		const cipher = createCipheriv("aes-256-gcm", Buffer.from(kBlob), N(9), { authTagLength: 16 });
		cipher.setAAD(blobAad(1, 1, VAULT, ADDR));
		const body = Buffer.concat([N(9), cipher.update(new Uint8Array(256)), cipher.final(), cipher.getAuthTag()]);
		assert.deepEqual(await open(Uint8Array.from([1, 1, 1, ...body])), { ok: false, reason: "malformed" });
		await assert.rejects(c.sealBlob({ address: ADDR, plaintext: new Uint8Array(MAX_BLOB_PLAINTEXT_BYTES_SUITE1 + 1) }), /exceeds the cap/);
	});

	it("addresses: 64 lowercase hex, from K_1 only, bound to the vault", async () => {
		const hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" as ContentHash;
		const { c } = await port();
		const a = await c.blobAddress(hash);
		assert.match(a, /^[0-9a-f]{64}$/);
		assert.notEqual(a, hash);
		const other = await createWebCryptoSuite1({ vaultId: "BBBBBBBBBBBBBBBBBBBBBB", random: new ScriptedRandom(), keys: [{ e: 1, k: K1.slice() }] });
		assert.notEqual(await other.blobAddress(hash), a);
		const only2 = await createWebCryptoSuite1({ vaultId: VAULT, random: new ScriptedRandom(), keys: [{ e: 2, k: K2.slice() }] });
		await assert.rejects(only2.blobAddress(hash), /epoch 1 not held/);
		await assert.rejects(only2.diagHash(new Uint8Array(1)), /epoch 1 not held/);
		await assert.rejects(c.blobAddress("ABC" as ContentHash));
		assert.match(await c.diagHash(new Uint8Array([1])), /^[0-9a-f]{16}$/);
	});
});
