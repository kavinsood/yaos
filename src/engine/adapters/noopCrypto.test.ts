import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ContentHash } from "../../core/types";
import { CryptoSuite } from "../../core/envelope";
import type { BlobAddress } from "../../ports/crypto";
import { createNoopCrypto } from "./noopCrypto";
import { createWebHash } from "./webHash";

describe("noopCrypto", () => {
	const crypto = createNoopCrypto(createWebHash());
	const aad = new Uint8Array([1]);
	const bytes = new Uint8Array([4, 5, 6]);

	it("is suite 0, seal epoch 0, and only epoch 0 is held (verified)", () => {
		assert.equal(crypto.suite, CryptoSuite.none);
		assert.equal(crypto.sealEpoch(), 0);
		assert.deepEqual(crypto.keyState(0), { held: true, verified: true });
		assert.deepEqual(crypto.keyState(1), { held: false, verified: true });
	});

	it("seal/open are identity for both purposes", async () => {
		for (const purpose of ["frame", "checkpoint"] as const) {
			const sealed = await crypto.seal({ purpose, keyEpoch: 0, aad, plaintext: bytes });
			assert.deepEqual(sealed, bytes);
			assert.deepEqual(await crypto.open({ purpose, suite: CryptoSuite.none, keyEpoch: 0, aad, sealed }), { ok: true, plaintext: bytes });
		}
	});

	it("open refuses other suites and key epochs", async () => {
		assert.deepEqual(await crypto.open({ purpose: "frame", suite: CryptoSuite.aes256gcm, keyEpoch: 1, aad, sealed: bytes }), { ok: false, reason: "unsupported-suite" });
		assert.deepEqual(await crypto.open({ purpose: "frame", suite: CryptoSuite.none, keyEpoch: 1, aad, sealed: bytes }), { ok: false, reason: "unknown-key" });
	});

	it("blob seal/open are identity and the address is the hash", async () => {
		const hash = "a".repeat(64) as ContentHash;
		const address = await crypto.blobAddress(hash);
		assert.equal(address, hash as string as BlobAddress);
		const parts = await crypto.sealBlob({ address, plaintext: bytes });
		assert.equal(parts.length, 1);
		assert.equal(parts[0], bytes, "the plaintext itself, not a copy");
		assert.deepEqual(await crypto.openBlob({ address, sealed: bytes }), { ok: true, plaintext: bytes });
	});

	it("diagHash is the 16-hex-char sha256 prefix", async () => {
		// sha256("abc") = ba7816bf8f01cfea414140de5dae2223...
		assert.equal(await crypto.diagHash(new TextEncoder().encode("abc")), "ba7816bf8f01cfea");
	});
});
