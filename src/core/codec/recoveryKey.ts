/**
 * Recovery key format (e2ee-design §13.1).
 *
 *   RK = 32 secret bytes ‖ first 3 bytes of SHA-256(those 32)   (35 bytes; KEK_RK uses RK[0..32], §5.1)
 *
 * Shown as Crockford base32 (MSB-first, 280 bits = exactly 56 chars, no padding): "YAOS-RK1-" plus 14
 * groups of 4. Decoding ignores case, dashes and whitespace, maps I/L to 1 and O to 0, takes the prefix as
 * optional, and rejects U, any other char, a wrong length or a bad checksum (the 24-bit checksum catches
 * typos before any crypto).
 */

import { sha256 } from "../hash/sha256";
import { CodecError, bytesEqual } from "./lib0";

export const RK_BYTES = 35;
export const RK_SECRET_BYTES = 32;
export const RK_PREFIX = "YAOS-RK1-";

const CHECK_BYTES = RK_BYTES - RK_SECRET_BYTES;
const CHARS = (RK_BYTES * 8) / 5; // 56
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NORMALIZED_PREFIX = "YAOSRK1";

function checksumOk(rk: Uint8Array): boolean {
	return rk.length === RK_BYTES
		&& bytesEqual(sha256(rk.subarray(0, RK_SECRET_BYTES)).subarray(0, CHECK_BYTES), rk.subarray(RK_SECRET_BYTES));
}

/** secret (32 bytes, from getRandomValues) ‖ its 3-byte checksum. */
export function makeRecoveryKey(secret: Uint8Array): Uint8Array {
	if (secret.length !== RK_SECRET_BYTES) throw new CodecError(`recovery key: secret must be ${RK_SECRET_BYTES} bytes`);
	const rk = new Uint8Array(RK_BYTES);
	rk.set(secret);
	rk.set(sha256(secret).subarray(0, CHECK_BYTES), RK_SECRET_BYTES);
	return rk;
}

/** "YAOS-RK1-XXXX-…-XXXX". Throws CodecError unless rk is 35 bytes with a valid checksum. */
export function encodeRecoveryKey(rk: Uint8Array): string {
	if (!checksumOk(rk)) throw new CodecError("recovery key: need 35 bytes with a valid checksum");
	let s = "";
	let acc = 0;
	let bits = 0;
	for (const b of rk) {
		acc = (acc << 8) | b;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			s += ALPHABET.charAt((acc >>> bits) & 31);
		}
		acc &= (1 << bits) - 1;
	}
	return RK_PREFIX + s.match(/.{4}/g)!.join("-");
}

/** The 35-byte RK, or null for anything that is not a well-formed key with a valid checksum. Never throws. */
export function decodeRecoveryKey(text: string): Uint8Array | null {
	const stripped = text.replace(/[\s-]/g, "");
	// ASCII only before upper-casing: toUpperCase maps some non-ASCII letters to ASCII ("ß" → "SS", "ı" → "I").
	if (!/^[0-9A-Za-z]*$/.test(stripped)) return null;
	let s = stripped.toUpperCase();
	if (s.length === NORMALIZED_PREFIX.length + CHARS && s.startsWith(NORMALIZED_PREFIX)) s = s.slice(NORMALIZED_PREFIX.length);
	if (s.length !== CHARS) return null;
	const out = new Uint8Array(RK_BYTES);
	let acc = 0;
	let bits = 0;
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charAt(i);
		const v = ALPHABET.indexOf(c === "I" || c === "L" ? "1" : c === "O" ? "0" : c);
		if (v < 0) return null;
		acc = (acc << 5) | v;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			out[n++] = (acc >>> bits) & 0xff;
			acc &= (1 << bits) - 1;
		}
	}
	return checksumOk(out) ? out : null;
}
