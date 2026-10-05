/**
 * Opaque random identifiers drawn from the base64url alphabet.
 *
 * Every client-side ID (vault ID, op ID, trace/boot ID, file ID) is an opaque
 * local handle: nothing — the plugin included, and the Worker verifiably not —
 * ever decodes one back to bytes. So the client needs random URL-safe
 * characters, not a base64 codec. The Worker's real base64url wire codec
 * (encode + decode, for tickets) is server/src/base64url.ts.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Returns `length` cryptographically random base64url characters. */
export function randomId(length: number): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = "";
	for (let i = 0; i < length; i++) {
		// 256 % 64 === 0, so masking to 6 bits is perfectly uniform — no modulo bias.
		out += ALPHABET[bytes[i]! & 63];
	}
	return out;
}
