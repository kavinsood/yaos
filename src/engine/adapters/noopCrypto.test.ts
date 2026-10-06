import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ContentHash } from "../../core/types";
import { CryptoSuite } from "../../core/envelope";
import { createNoopCrypto } from "./noopCrypto";
import { createWebHash } from "./webHash";

describe("noopCrypto", () => {
	const crypto = createNoopCrypto(createWebHash());
	const aad = new Uint8Array([1]);
	const bytes = new Uint8Array([4, 5, 6]);

	it("is suite 0, key epoch 0", () => {
		assert.equal(crypto.suite, CryptoSuite.none);
		assert.equal(crypto.keyEpoch, 0);
	});

	it("seal/open are identity", async () => {
		const sealed = await crypto.seal({ aad, plaintext: bytes });
		assert.deepEqual(sealed, bytes);
		assert.deepEqual(await crypto.open({ suite: CryptoSuite.none, keyEpoch: 0, aad, sealed }), { ok: true, plaintext: bytes });
	});

	it("open refuses other suites and key epochs", async () => {
		assert.deepEqual(await crypto.open({ suite: CryptoSuite.xchacha20poly1305, keyEpoch: 0, aad, sealed: bytes }), { ok: false, reason: "unsupported-suite" });
		assert.deepEqual(await crypto.open({ suite: CryptoSuite.none, keyEpoch: 1, aad, sealed: bytes }), { ok: false, reason: "unknown-key" });
	});

	it("blob seal/open are identity and the address is the hash", async () => {
		assert.deepEqual(await crypto.sealBlob(bytes), bytes);
		assert.deepEqual(await crypto.openBlob(bytes), bytes);
		const hash = "a".repeat(64) as ContentHash;
		assert.equal(await crypto.blobAddress(hash), hash);
	});
});
