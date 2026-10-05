/**
 * FNV-1a, 32 bit.
 *
 * NOT cryptographic. Use only for fingerprints, correlation tags, dedupe keys
 * and diagnostics bucketing — never for three-way authority decisions or as a
 * security boundary.
 *
 * The exported hashes return the raw 32-bit value and callers own the
 * formatting, because each caller's identifier string is observable (persisted
 * recovery signatures, receipt correlation tags, trace pseudonyms) and must
 * keep its exact existing shape.
 */
const OFFSET_BASIS = 0x811c9dc5;

/** One round: xor the octet, then multiply by 16777619 via shift-adds. */
function round(hash: number, value: number): number {
	const h = hash ^ value;
	return (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
}

/** Hashes UTF-16 code units, matching String.prototype.charCodeAt. */
export function fnv1a32(input: string): number {
	let hash = OFFSET_BASIS;
	for (let i = 0; i < input.length; i++) {
		hash = round(hash, input.charCodeAt(i));
	}
	return hash;
}

export function fnv1a32Bytes(bytes: Uint8Array): number {
	let hash = OFFSET_BASIS;
	for (let i = 0; i < bytes.length; i++) {
		hash = round(hash, bytes[i]!);
	}
	return hash;
}

/** Zero-padded 8-char lowercase hex — the encoding every caller emits. */
export function toHex8(hash: number): string {
	return hash.toString(16).padStart(8, "0");
}
