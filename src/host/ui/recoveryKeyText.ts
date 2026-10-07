/**
 * The recovery key's text form on main (e2ee-design §13.1), without hashing: main never hashes
 * (scripts/check-deps.mjs keeps core/hash off main), so the 3-byte checksum comes from the engine
 * (YaosUiHost.rkChecksum). The bit loops are core/codec/recoveryKey.ts's; recoveryKeyText.test.ts checks both
 * agree on every key it tries.
 *
 *   RK = 32 secret bytes ‖ first 3 bytes of SHA-256(those 32)   (35 bytes)
 *   text = "YAOS-RK1-" + 14 groups of 4 Crockford base32 characters (MSB first, 56 characters)
 *
 * Parsing ignores case, dashes and whitespace, maps I/L to 1 and O to 0, takes the prefix as optional and rejects
 * anything else. SECRETS: every Uint8Array and string here is the key; nothing is logged, and the callers zero-fill
 * the bytes once they are handed on.
 */

import type { RandomBytesFn } from "./pairing";

export const RK_BYTES = 35;
export const RK_SECRET_BYTES = 32;
export const RK_TEXT_PREFIX = "YAOS-RK1-";
export const RK_GROUPS = 14;

const CHECK_BYTES = RK_BYTES - RK_SECRET_BYTES;
const CHARS = (RK_BYTES * 8) / 5; // 56
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NORMALIZED_PREFIX = "YAOSRK1";

/** The engine's checksum: first 3 bytes of SHA-256 of a 32-byte secret (YaosUiHost.rkChecksum). */
export type RkChecksumFn = (secret: Uint8Array) => Promise<Uint8Array>;

/** "YAOS-RK1-XXXX-…-XXXX" for a 35-byte RK. Throws (no key in the message) on another length. */
export function formatRecoveryKey(rk: Uint8Array): string {
	if (rk.length !== RK_BYTES) throw new Error("recovery key: need 35 bytes");
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
	return RK_TEXT_PREFIX + s.match(/.{4}/g)!.join("-");
}

/** The 56 normalized characters of a typed key (prefix dropped), or null when it is not a well-formed key text. */
function normalized(text: string): string | null {
	const stripped = text.replace(/[\s-]/g, "");
	// ASCII only before upper-casing: toUpperCase maps some non-ASCII letters to ASCII ("ß" -> "SS", "ı" -> "I").
	if (!/^[0-9A-Za-z]*$/.test(stripped)) return null;
	let s = stripped.toUpperCase();
	if (s.length === NORMALIZED_PREFIX.length + CHARS && s.startsWith(NORMALIZED_PREFIX)) s = s.slice(NORMALIZED_PREFIX.length);
	if (s.length !== CHARS) return null;
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const c = s.charAt(i);
		const mapped = c === "I" || c === "L" ? "1" : c === "O" ? "0" : c;
		if (!ALPHABET.includes(mapped)) return null;
		out += mapped;
	}
	return out;
}

/** The 35 bytes of a typed key, checksum NOT checked (readRecoveryKey does), or null when the text is malformed. */
export function parseRecoveryKey(text: string): Uint8Array | null {
	const s = normalized(text);
	if (s === null) return null;
	const out = new Uint8Array(RK_BYTES);
	let acc = 0;
	let bits = 0;
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		acc = (acc << 5) | ALPHABET.indexOf(s.charAt(i));
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			out[n++] = (acc >>> bits) & 0xff;
			acc &= (1 << bits) - 1;
		}
	}
	return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

export type RecoveryKeyRead =
	| { readonly ok: true; readonly rk: Uint8Array }
	| { readonly ok: false; readonly reason: "malformed" | "checksum" };

/**
 * A typed key, checked before any crypto (§13.1: the 24-bit checksum catches typos). The checksum is the engine's;
 * on failure the decoded bytes are zero-filled. The caller zero-fills `rk` (the command transfers it).
 */
export async function readRecoveryKey(text: string, checksum: RkChecksumFn): Promise<RecoveryKeyRead> {
	const rk = parseRecoveryKey(text);
	if (!rk) return { ok: false, reason: "malformed" };
	const sum = await checksum(rk.subarray(0, RK_SECRET_BYTES)).catch((e: unknown) => {
		rk.fill(0);
		throw e;
	});
	const ok = sum.length === CHECK_BYTES && sameBytes(sum, rk.subarray(RK_SECRET_BYTES));
	sum.fill(0);
	if (!ok) {
		rk.fill(0);
		return { ok: false, reason: "checksum" };
	}
	return { ok: true, rk };
}

/** A new RK (§13.2: generated on main from getRandomValues; the engine adds the checksum). The caller zero-fills `rk`. */
export async function newRecoveryKey(random: RandomBytesFn, checksum: RkChecksumFn): Promise<{ readonly rk: Uint8Array; readonly text: string }> {
	const secret = random(RK_SECRET_BYTES);
	try {
		if (secret.length !== RK_SECRET_BYTES) throw new Error("recovery key: need 32 random bytes");
		const sum = await checksum(secret);
		if (sum.length !== CHECK_BYTES) throw new Error("recovery key: bad checksum length");
		const rk = new Uint8Array(RK_BYTES);
		rk.set(secret);
		rk.set(sum, RK_SECRET_BYTES);
		sum.fill(0);
		return { rk, text: formatRecoveryKey(rk) };
	} finally {
		secret.fill(0);
	}
}

/** The 14 groups of a formatted key, in order. */
export function recoveryKeyGroups(text: string): string[] {
	return text.slice(RK_TEXT_PREFIX.length).split("-");
}

/** §13.2: two distinct random group indices (0-based, ascending) the user retypes to confirm the key was saved. */
export function pickConfirmGroups(random: RandomBytesFn): readonly [number, number] {
	for (;;) {
		const b = random(2);
		const i = b[0]! % 16;
		const j = b[1]! % 16;
		b.fill(0);
		// Rejection sampling: uniform over 0..13 without modulo bias.
		if (i >= RK_GROUPS || j >= RK_GROUPS || i === j) continue;
		return i < j ? [i, j] : [j, i];
	}
}

/** Whether a retyped group matches (same normalization as parsing: case, I/L, O, spaces and dashes). */
export function groupMatches(typed: string, expected: string): boolean {
	const s = typed.replace(/[\s-]/g, "");
	if (!/^[0-9A-Za-z]{4}$/.test(s)) return false;
	let out = "";
	for (const c of s.toUpperCase()) out += c === "I" || c === "L" ? "1" : c === "O" ? "0" : c;
	return out === expected;
}
