/**
 * textChunk payloads (DESIGN §d.3): a JS string's UTF-16 code units, platform byte order. Exact for every string,
 * lone surrogates included (TextEncoder / TextDecoder would turn those into U+FFFD and change lengths), and
 * linear without a UTF-8 pass. Main encodes slices of an editor document between yields; the worker decodes.
 */

/** Code units per textChunk the host sends (64 KiB-unit slices: 128 KiB per message). */
export const TEXT_CHUNK_UNITS = 65_536;

/** Code units per String.fromCharCode call (argument-count limits). */
const DECODE_STEP = 8_192;

/** One slice of text as a fresh, transferable buffer. */
export function encodeUtf16(text: string): Uint8Array {
	const units = new Uint16Array(text.length);
	for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
	return new Uint8Array(units.buffer);
}

/** Inverse of encodeUtf16 (odd trailing byte ignored). */
export function decodeUtf16(bytes: Uint8Array): string {
	const n = bytes.byteLength >> 1;
	const units = bytes.byteOffset % 2 === 0 ? new Uint16Array(bytes.buffer, bytes.byteOffset, n) : new Uint16Array(bytes.slice(0, n * 2).buffer);
	const parts: string[] = [];
	for (let i = 0; i < n; i += DECODE_STEP) parts.push(String.fromCharCode.apply(null, units.subarray(i, Math.min(n, i + DECODE_STEP)) as unknown as number[]));
	return parts.join("");
}
