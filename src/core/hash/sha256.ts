/**
 * Pure-JS SHA-256 (FIPS 180-4) for small fixed-size inputs only: core is pure (no crypto.subtle), and a few
 * digests are needed synchronously (the empty-content hash constants, the recovery key's 32-byte check). It
 * refuses any input over SYNC_HASH_MAX_BYTES (fail closed, in production too): it would block the engine thread
 * for the whole digest. Content of any size is hashed through HashPort (WebCrypto; core/hash/digest.ts), and
 * tests take reference digests from core/hash/testkit/hashRef.ts.
 */

import { SYNC_HASH_MAX_BYTES } from "../limits";

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(bytes: Uint8Array): Uint8Array {
	if (bytes.length > SYNC_HASH_MAX_BYTES) throw new RangeError(`synchronous sha256 of ${bytes.length} bytes (> ${SYNC_HASH_MAX_BYTES}): hash through HashPort`);
	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const length = bytes.length;
	const totalBlocks = Math.ceil((length + 9) / 64);
	const w = new Uint32Array(64);
	const tail = new Uint8Array(128);
	const tailStart = Math.floor(length / 64) * 64;
	tail.set(bytes.subarray(tailStart));
	tail[length - tailStart] = 0x80;
	const tailLen = (totalBlocks * 64) - tailStart;
	const bitLenHi = Math.floor(length / 0x20000000);
	const bitLenLo = (length << 3) >>> 0;
	tail[tailLen - 8] = (bitLenHi >>> 24) & 0xff;
	tail[tailLen - 7] = (bitLenHi >>> 16) & 0xff;
	tail[tailLen - 6] = (bitLenHi >>> 8) & 0xff;
	tail[tailLen - 5] = bitLenHi & 0xff;
	tail[tailLen - 4] = (bitLenLo >>> 24) & 0xff;
	tail[tailLen - 3] = (bitLenLo >>> 16) & 0xff;
	tail[tailLen - 2] = (bitLenLo >>> 8) & 0xff;
	tail[tailLen - 1] = bitLenLo & 0xff;

	for (let block = 0; block < totalBlocks; block++) {
		const offset = block * 64;
		const src = offset < tailStart ? bytes : tail;
		const base = offset < tailStart ? offset : offset - tailStart;
		for (let i = 0; i < 16; i++) {
			const j = base + i * 4;
			w[i] = ((src[j]! << 24) | (src[j + 1]! << 16) | (src[j + 2]! << 8) | src[j + 3]!) >>> 0;
		}
		for (let i = 16; i < 64; i++) {
			const w15 = w[i - 15]!;
			const w2 = w[i - 2]!;
			const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
			const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
		}
		let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
		for (let i = 0; i < 64; i++) {
			const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			const ch = (e & f) ^ (~e & g);
			const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
			const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) >>> 0;
			hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
		}
		h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
		h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
	}
	const out = new Uint8Array(32);
	for (let i = 0; i < 8; i++) {
		out[i * 4] = h[i]! >>> 24;
		out[i * 4 + 1] = (h[i]! >>> 16) & 0xff;
		out[i * 4 + 2] = (h[i]! >>> 8) & 0xff;
		out[i * 4 + 3] = h[i]! & 0xff;
	}
	return out;
}

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]! >>> 4]! + HEX[bytes[i]! & 15]!;
	return out;
}

export function sha256Hex(bytes: Uint8Array): string {
	return toHex(sha256(bytes));
}
