import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_BLOB_PLAINTEXT_BYTES_SUITE1, PADME_FLOOR_BYTES } from "../limits";
import { pad, padmeLen, unpad } from "./padme";
import { blobAad, decodeBlobHeader, encodeBlobHeader } from "./sealedBlob";
import { CryptoSuite } from "../envelope";

/** Padmé from the paper's definition with BigInt bit lengths: no floating point anywhere. */
function padmeRef(n: number): number {
	const m = BigInt(Math.max(n, 256));
	const E = BigInt(m.toString(2).length - 1);
	const S = BigInt(E.toString(2).length);
	const step = 1n << (E - S);
	return Number(((m + step - 1n) / step) * step);
}

describe("Padmé (§7.3)", () => {
	it("matches an exact BigInt reference, including around every power of two", () => {
		const probes = new Set<number>();
		for (let n = 0; n <= 5000; n++) probes.add(n);
		for (let k = 8; k <= 52; k++) for (const d of [-2, -1, 0, 1, 2]) probes.add(2 ** k + d);
		for (const n of probes) assert.equal(padmeLen(n), padmeRef(n), `n=${n}`);
	});

	it("floor, monotone, never shrinks, overhead at most 12 % above the floor", () => {
		let prev = 0;
		for (let n = 0; n < 300_000; n += n < 4096 ? 1 : 97) {
			const p = padmeLen(n);
			assert.ok(p >= n && p >= PADME_FLOOR_BYTES && p >= prev, `n=${n}`);
			if (n >= PADME_FLOOR_BYTES) assert.ok((p - n) / n <= 0.12, `n=${n} overhead ${(p - n) / n}`);
			prev = p;
		}
	});

	it("bucket points the limits rely on", () => {
		assert.equal(padmeLen(0), 256);
		assert.equal(padmeLen(256), 256);
		assert.equal(padmeLen(257), 272); // E=8, S=4, step 16
		// [2^19, 2^20): E=19, S=5, step 2^14 = 16 KiB.
		for (const n of [2 ** 19, 2 ** 19 + 1, 777_777, 2 ** 20 - 1]) assert.equal(padmeLen(n) % 16384, 0, `n=${n}`);
		// MAX_FRAME_CONTENT_BYTES + 1 marker byte is a bucket point (§8.2, WP-E2), the next byte jumps.
		assert.equal(padmeLen(1_032_192), 1_032_192);
		assert.equal(padmeLen(1_032_193), 1_048_576);
		// The suite-1 blob cap: cap + marker is a bucket point; with header (≤ 10 B) and AEAD (28 B) it fits the 10 MiB upload cap (D9).
		assert.equal(MAX_BLOB_PLAINTEXT_BYTES_SUITE1 + 1, 39 * 262_144);
		assert.equal(padmeLen(MAX_BLOB_PLAINTEXT_BYTES_SUITE1 + 1), MAX_BLOB_PLAINTEXT_BYTES_SUITE1 + 1);
		assert.equal(padmeLen(MAX_BLOB_PLAINTEXT_BYTES_SUITE1 + 2), 40 * 262_144);
		assert.ok(MAX_BLOB_PLAINTEXT_BYTES_SUITE1 + 1 + 10 + 28 <= 10 * 1024 * 1024);
	});

	it("rejects bad lengths", () => {
		for (const n of [-1, 1.5, Number.NaN, 2 ** 53]) assert.throws(() => padmeLen(n), RangeError);
	});

	it("pad/unpad round trip, including trailing zeros and 0x80 in the data", () => {
		for (const data of [new Uint8Array(0), Uint8Array.of(0), Uint8Array.of(0x80), Uint8Array.of(1, 0, 0), new Uint8Array(255).fill(0x80), new Uint8Array(4000)]) {
			const p = pad(data);
			assert.equal(p.length, padmeLen(data.length + 1));
			assert.deepEqual(unpad(p), data);
		}
	});

	it("unpad rejects a missing or wrong marker", () => {
		assert.equal(unpad(new Uint8Array(0)), null);
		assert.equal(unpad(new Uint8Array(256)), null, "all zeros");
		assert.equal(unpad(Uint8Array.of(1, 2, 3, 0, 0)), null);
		assert.equal(unpad(Uint8Array.of(1, 0x81, 0)), null);
		assert.deepEqual(unpad(Uint8Array.of(0x80)), new Uint8Array(0));
	});
});

describe("sealed blob header (§10.2)", () => {
	it("round trips multi-byte epochs and returns the body as a view", () => {
		for (const e of [1, 127, 128, 300, 2 ** 31]) {
			const h = encodeBlobHeader(CryptoSuite.aes256gcm, e);
			const sealed = new Uint8Array([...h, 7, 7, 7]);
			const r = decodeBlobHeader(sealed);
			assert.ok(r.ok);
			assert.equal(r.keyEpoch, e);
			assert.deepEqual(r.body, Uint8Array.of(7, 7, 7));
		}
	});

	it("classifies unknown format or suite as unsupported, truncation and epoch 0 as malformed", () => {
		assert.deepEqual(decodeBlobHeader(Uint8Array.of(2, 1, 1)), { ok: false, reason: "unsupported-suite" });
		assert.deepEqual(decodeBlobHeader(Uint8Array.of(1, 0, 1)), { ok: false, reason: "unsupported-suite" });
		assert.deepEqual(decodeBlobHeader(Uint8Array.of(1, 2, 1)), { ok: false, reason: "unsupported-suite" });
		assert.deepEqual(decodeBlobHeader(Uint8Array.of(1, 1, 0)), { ok: false, reason: "malformed" });
		assert.deepEqual(decodeBlobHeader(Uint8Array.of(1, 1, 0x81, 0)), { ok: false, reason: "malformed" }, "non-minimal varuint");
		assert.deepEqual(decodeBlobHeader(Uint8Array.of(1, 1)), { ok: false, reason: "malformed" });
		assert.deepEqual(decodeBlobHeader(new Uint8Array(0)), { ok: false, reason: "malformed" });
	});

	it("blobAad binds format, suite, epoch, vault and address", () => {
		const a = blobAad(CryptoSuite.aes256gcm, 1, "V", "ab");
		assert.deepEqual(a, Uint8Array.of(...new TextEncoder().encode("yaos/b2"), 1, 1, 1, 1, 0x56, 2, 0x61, 0x62));
		assert.notDeepEqual(blobAad(CryptoSuite.aes256gcm, 2, "V", "ab"), a);
		assert.notDeepEqual(blobAad(CryptoSuite.aes256gcm, 1, "W", "ab"), a);
		assert.notDeepEqual(blobAad(CryptoSuite.aes256gcm, 1, "V", "ac"), a);
	});
});
