import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PADME_FLOOR_BYTES } from "../limits";
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
		// [2^26, 2^27): E=26, S=5, step 2^21 = 2 MiB. 47 x 2 MiB plus header (≤ 10 B) and AEAD (28 B) fits the 100 MB
		// upload cap (D9), 48 x 2 MiB does not: the largest suite-1 blob plaintext there is 47 x 2 MiB - 1 (marker).
		assert.equal(padmeLen(47 * 2_097_152), 47 * 2_097_152);
		assert.equal(padmeLen(47 * 2_097_152 + 1), 48 * 2_097_152);
		assert.ok(47 * 2_097_152 + 10 + 28 <= 100_000_000 && 48 * 2_097_152 > 100_000_000);
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

	it("pad is data ‖ 0x80 ‖ 0x00* byte for byte in one exact-size buffer; unpad returns a view of it (§10.3)", () => {
		const backing = new Uint8Array(70_010).map((_, i) => (i * 7 + 3) & 0xff);
		const data = backing.subarray(5, 70_005); // an offset view: pad reads only the view
		const p = pad(data);
		const want = new Uint8Array(padmeLen(data.length + 1));
		for (let i = 0; i < data.length; i++) want[i] = backing[5 + i]!;
		want[data.length] = 0x80;
		assert.deepEqual(p, want);
		assert.equal(p.byteOffset, 0);
		assert.equal(p.buffer.byteLength, p.length, "no spare capacity");
		const u = unpad(p)!;
		assert.equal(u.buffer, p.buffer, "a view, not a copy");
		assert.equal(u.byteOffset, 0);
		assert.equal(u.length, data.length);
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
