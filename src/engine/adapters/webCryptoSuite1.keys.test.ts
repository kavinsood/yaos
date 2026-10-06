import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, hkdfSync } from "node:crypto";
import type { BlobAddress } from "../../ports/crypto";
import { hkdfInfo } from "./suite1Primitives";
import { ScriptedRandom } from "./testkit/scriptedRandom";
import { spySubtle } from "./testkit/spySubtle";
import { createWebCryptoSuite1 } from "./webCryptoSuite1";

const VAULT = "AAAAAAAAAAAAAAAAAAAAAA";
const range = (from: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (from + i) & 0xff);
const K1 = range(0, 32);
const K2 = range(0x20, 32);
const K3 = range(0x60, 32);
const RK = range(0x40, 35);
const N = (b: number) => new Uint8Array(12).fill(b);
const AAD = new Uint8Array([9, 9]);
const nonces = (r: ScriptedRandom, n: number) => { for (let i = 0; i < n; i++) r.push(N(i)); };

async function make(keys: { e: number; k: Uint8Array }[], subtle?: SubtleCrypto) {
	const random = new ScriptedRandom();
	const c = await createWebCryptoSuite1({ vaultId: VAULT, random, keys: keys.map(({ e, k }) => ({ e, k: k.slice() })), subtle });
	return { c, random };
}

describe("webCryptoSuite1: only non-extractable keys (§6.3)", () => {
	it("every key the adapter makes or derives is non-extractable, and it never exports or wraps via WebCrypto", async () => {
		const spy = spySubtle();
		const { c, random } = await make([{ e: 1, k: K1 }], spy.subtle);
		c.markVerified(1);
		c.setSealEpoch(1);
		random.push(N(1), N(2), K2.slice(), N(3), N(4)); // seal, sealBlob, generate, two wraps (FIFO)
		const sealed = await c.seal({ purpose: "frame", keyEpoch: 1, aad: AAD, plaintext: K3 });
		assert.equal((await c.open({ purpose: "frame", suite: 1, keyEpoch: 1, aad: AAD, sealed })).ok, true);
		const blob = await c.sealBlob({ address: "ab".repeat(32) as BlobAddress, plaintext: K3 });
		assert.equal((await c.openBlob({ address: "ab".repeat(32) as BlobAddress, sealed: blob })).ok, true);
		await c.blobAddress("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" as never);
		await c.diagHash(K3);
		await c.generate(2);
		await c.kcv(2);
		const next = await c.wrap("next", 2, AAD);
		const rec = await c.wrap("recovery", 2, AAD, RK);
		const { c: d } = await make([{ e: 1, k: K1 }], spy.subtle);
		assert.equal(await d.unwrap("next", 2, AAD, next), true);
		const { c: r } = await make([], spy.subtle);
		assert.equal(await r.unwrap("recovery", 2, AAD, rec, RK), true);

		assert.ok(spy.extractable.length >= 10, `made ${spy.extractable.length} keys`);
		assert.deepEqual(new Set(spy.extractable), new Set([false]));
		assert.ok(spy.keys.length >= 10 && spy.keys.every((k) => k.extractable === false));
		const used = new Set(spy.calls);
		for (const m of used) assert.ok(["importKey", "deriveKey", "encrypt", "decrypt", "sign"].includes(m), `unexpected subtle.${m}`);
		for (const k of spy.keys.slice(0, 3)) await assert.rejects(globalThis.crypto.subtle.exportKey("raw", k));
	});

	it("WebCrypto refuses to wrapKey a non-extractable key, which is why raw bytes are retained (§6.3 step 2)", async () => {
		const subtle = globalThis.crypto.subtle;
		const victim = await subtle.importKey("raw", K2, "AES-GCM", false, ["encrypt"]);
		const kek = await subtle.importKey("raw", K1, "AES-GCM", false, ["wrapKey"]);
		await assert.rejects(subtle.wrapKey("raw", victim, kek, { name: "AES-GCM", iv: N(1) }), { name: "InvalidAccessError" });
	});
});

describe("webCryptoSuite1: raw-key retention", () => {
	it("keeps raw for unexported, pending and >= seal-epoch keys; zero-fills the rest", async () => {
		const { c, random } = await make([{ e: 1, k: K1 }, { e: 2, k: K2 }]);
		c.markVerified(1);
		c.markVerified(2);
		random.push(N(1), N(2), K3.slice(), N(3), N(4), range(0x80, 32), N(5)); // FIFO; a refused wrap takes no nonce
		await c.wrap("prev", 2, AAD); // sealEpoch 0: nothing trimmed yet
		c.setSealEpoch(2);
		await assert.rejects(c.wrap("prev", 2, AAD), /epoch 1 is no longer retained/);
		await c.wrap("next", 2, AAD); // K_2 is the seal epoch
		await c.generate(3); // a roll: both wraps before the switch
		await c.wrap("next", 3, AAD);
		await c.wrap("prev", 3, AAD);
		assert.deepEqual(c.exportForHost().map((x) => x.e), [3]);
		assert.deepEqual(c.exportForHost(), [], "exported once");
		await c.generate(4);
		c.markVerified(4);
		c.setSealEpoch(4);
		await c.wrap("next", 3, AAD); // 3 is exported and < seal epoch, but still pending
		await assert.rejects(c.wrap("prev", 3, AAD), /epoch 2 is no longer retained/);
		assert.deepEqual(c.exportForHost().map((x) => x.e), [4]);
		c.drop(1);
		assert.deepEqual(c.keyState(1), { held: false, verified: false });
		assert.deepEqual(await c.open({ purpose: "frame", suite: 1, keyEpoch: 1, aad: AAD, sealed: new Uint8Array(40) }), { ok: false, reason: "unknown-key" });
	});

	it("install and init zero-fill the caller's buffer; install validates; exportForHost hands back the bytes", async () => {
		const init = K1.slice();
		const random = new ScriptedRandom();
		const c = await createWebCryptoSuite1({ vaultId: VAULT, random, keys: [{ e: 1, k: init }] });
		assert.deepEqual(init, new Uint8Array(32));
		const mine = K2.slice();
		assert.equal(await c.install(2, mine), "installed");
		assert.deepEqual(mine, new Uint8Array(32));
		assert.deepEqual(c.exportForHost(), [], "an unverified installed key is never handed to the host (§12.4)");
		c.markVerified(2);
		assert.deepEqual(c.exportForHost(), [{ e: 2, k: K2 }], "init keys are already the host's");
		await assert.rejects(c.install(0, K3.slice()), /bad key epoch/);
		await assert.rejects(c.install(3, new Uint8Array(31)), /32 bytes/);
		const other = K3.slice();
		assert.equal(await c.install(2, other), "conflict", "a verified epoch is never replaced");
		assert.deepEqual(other, new Uint8Array(32));
		assert.equal(await c.install(2, K2.slice()), "same");
		assert.deepEqual(c.keyState(2), { held: true, verified: true });
		assert.equal(await c.install(1, K3.slice()), "installed", "an unverified epoch is replaced");
		random.push(new Uint8Array(16));
		await assert.rejects(c.generate(5), /32 bytes/);
		await assert.rejects(c.wrap("recovery", 2, AAD), /recovery key required/);
	});
});

describe("webCryptoSuite1: unwrap never throws on bad input", () => {
	it("returns false for wrong length, missing wrapping key, wrong AAD, short RK and a non-32-byte payload", async () => {
		const { c, random } = await make([{ e: 1, k: K1 }, { e: 2, k: K2 }]);
		nonces(random, 3);
		const next = await c.wrap("next", 2, AAD);
		const rec = await c.wrap("recovery", 1, AAD, RK);
		const { c: d } = await make([{ e: 1, k: K1 }]);
		assert.equal(await d.unwrap("next", 2, AAD, next.subarray(1)), false);
		assert.equal(await d.unwrap("next", 3, AAD, next), false, "needs K_2");
		assert.equal(await d.unwrap("prev", 1, AAD, next), false, "no epoch 0");
		assert.equal(await d.unwrap("next", 2, new Uint8Array([9]), next), false);
		assert.equal(await d.unwrap("recovery", 1, AAD, rec), false);
		assert.equal(await d.unwrap("recovery", 1, AAD, rec, RK.subarray(0, 31)), false);
		const kWrap1 = hkdfSync("sha256", K1, Buffer.from("yaos-hkdf-v1"), hkdfInfo("wrap", VAULT, 1), 32);
		const g = createCipheriv("aes-256-gcm", Buffer.from(kWrap1), N(5), { authTagLength: 16 });
		g.setAAD(AAD);
		const short = Buffer.concat([N(5), g.update(new Uint8Array(31)), g.final(), g.getAuthTag(), Buffer.alloc(1)]);
		assert.equal(await d.unwrap("next", 2, AAD, short), false, "tag fails over the extra byte");
		assert.equal(d.keyState(2).held, false);
		assert.equal(await d.unwrap("next", 2, AAD, next), true);
		assert.deepEqual(d.keyState(2), { held: true, verified: false });
		d.markVerified(2);
		assert.equal(await d.unwrap("next", 2, AAD, next), true, "already verified: kept, not replaced");
		assert.deepEqual(await d.kcv(2), await c.kcv(2));
	});

	it("never replaces a held key: true only when the payload is that same key, verified or not (§11.3)", async () => {
		const { c, random } = await make([{ e: 1, k: K1 }, { e: 2, k: K2 }]);
		nonces(random, 1);
		const prevGood = await c.wrap("prev", 2, AAD); // K_1 under kWrap_2
		const { c: o2, random: r2 } = await make([{ e: 1, k: K3 }, { e: 2, k: K2 }]);
		nonces(r2, 1);
		const prevForged = await o2.wrap("prev", 2, AAD); // K3 posing as K_1, same kWrap_2
		for (const verified of [false, true]) {
			const { c: d } = await make([{ e: 1, k: K1 }, { e: 2, k: K2 }]);
			if (verified) d.markVerified(1);
			const kcv1 = await d.kcv(1);
			assert.equal(await d.unwrap("prev", 2, AAD, prevGood), true);
			assert.equal(await d.unwrap("prev", 2, AAD, prevForged), false, `verified=${verified}`);
			assert.deepEqual(await d.kcv(1), kcv1, "held K_1 untouched");
		}
	});
});
