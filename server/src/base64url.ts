/**
 * Minimal base64url encode / decode utilities for the Cloudflare Worker runtime.
 *
 * Uses only Uint8Array arithmetic — no Buffer (unavailable in Workers), no
 * btoa/atob (not universally available in all Worker environments).  Safe to
 * import in both CF Workers and the Node.js test harness.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Lookup table: ASCII code → 6-bit value, or 0xff for invalid chars. */
const DECODE = new Uint8Array(256).fill(0xff);
for (let i = 0; i < ALPHABET.length; i++) {
	DECODE[ALPHABET.charCodeAt(i)] = i;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	let out = "";
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
		out += ALPHABET[v >> 18 & 63];
		out += ALPHABET[v >> 12 & 63];
		out += ALPHABET[v >> 6 & 63];
		out += ALPHABET[v & 63];
	}
	const rem = bytes.length - i;
	if (rem === 1) {
		const v = bytes[i]! << 16;
		out += ALPHABET[v >> 18 & 63];
		out += ALPHABET[v >> 12 & 63];
	} else if (rem === 2) {
		const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
		out += ALPHABET[v >> 18 & 63];
		out += ALPHABET[v >> 12 & 63];
		out += ALPHABET[v >> 6 & 63];
	}
	return out;
}

export function base64UrlToBytes(str: string): Uint8Array {
	const len = str.length;
	if (len === 0) return new Uint8Array(0);

	// Validate alphabet before allocating.
	for (let i = 0; i < len; i++) {
		if (DECODE[str.charCodeAt(i)] === 0xff) {
			throw new Error(`invalid base64url char at index ${i}`);
		}
	}

	// Calculate output byte count (no padding chars in base64url).
	const rem = len % 4;
	// rem === 1 is structurally impossible for valid base64url.
	if (rem === 1) throw new Error("invalid base64url length");
	const outLen = Math.floor(len / 4) * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
	const out = new Uint8Array(outLen);

	let outIdx = 0;
	let i = 0;
	for (; i + 3 < len; i += 4) {
		const a = DECODE[str.charCodeAt(i)]!;
		const b = DECODE[str.charCodeAt(i + 1)]!;
		const c = DECODE[str.charCodeAt(i + 2)]!;
		const d = DECODE[str.charCodeAt(i + 3)]!;
		out[outIdx++] = (a << 2) | (b >> 4);
		out[outIdx++] = ((b & 0xf) << 4) | (c >> 2);
		out[outIdx++] = ((c & 0x3) << 6) | d;
	}
	if (rem === 2) {
		const a = DECODE[str.charCodeAt(i)]!;
		const b = DECODE[str.charCodeAt(i + 1)]!;
		out[outIdx++] = (a << 2) | (b >> 4);
	} else if (rem === 3) {
		const a = DECODE[str.charCodeAt(i)]!;
		const b = DECODE[str.charCodeAt(i + 1)]!;
		const c = DECODE[str.charCodeAt(i + 2)]!;
		out[outIdx++] = (a << 2) | (b >> 4);
		out[outIdx++] = ((b & 0xf) << 4) | (c >> 2);
	}
	return out;
}

/** Strict standard-base64 decoder for HTTP JSON fields. */
export function base64ToBytes(value: string): Uint8Array {
	if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
		throw new Error("invalid base64");
	}
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const unpadded = value.slice(0, value.length - padding);
	if (unpadded.includes("=")) throw new Error("invalid base64 padding");
	return base64UrlToBytes(unpadded.replaceAll("+", "-").replaceAll("/", "_"));
}

export function randomBase64Url(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}
