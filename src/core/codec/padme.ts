/**
 * Padmé padding (e2ee-design §7.3, decision D3). Leaks O(log log M) bits of a
 * length M with at most 12 % overhead; lengths below PADME_FLOOR_BYTES pad up
 * to the floor. ISO/IEC 7816-4 style: `data ‖ 0x80 ‖ 0x00*`.
 *
 * Suite 0 never pads. Suite 1: the envelope codec pads frames and checkpoints,
 * and the suite-1 sealBlob pads blobs; both inside the AEAD.
 */

import { PADME_FLOOR_BYTES } from "../limits";

/** Padded length for a payload of n bytes (marker included in n). */
export function padmeLen(n: number): number {
	if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`padmeLen: bad length ${n}`);
	const m = Math.max(n, PADME_FLOOR_BYTES);
	const e = floorLog2(m);
	const s = floorLog2(e) + 1;
	const step = 2 ** (e - s);
	return Math.ceil(m / step) * step;
}

/** floor(log2 x) for a safe integer x ≥ 1, exact (Math.log2 can round up just below a power of two). */
function floorLog2(x: number): number {
	let e = 0;
	while (x >= 2 ** (e + 1)) e++;
	return e;
}

/** `data ‖ 0x80 ‖ 0x00 × (padmeLen(len + 1) − len − 1)`, in a fresh buffer. */
export function pad(data: Uint8Array): Uint8Array {
	const out = new Uint8Array(padmeLen(data.length + 1));
	out.set(data, 0);
	out[data.length] = 0x80;
	return out;
}

/**
 * Strip trailing 0x00, then require one 0x80. Returns a view of `padded`
 * without the padding, or null (bad padding). The length itself is not
 * checked against padmeLen: a key holder chose it, and only the marker
 * matters for decoding.
 */
export function unpad(padded: Uint8Array): Uint8Array | null {
	let i = padded.length - 1;
	while (i >= 0 && padded[i] === 0) i--;
	if (i < 0 || padded[i] !== 0x80) return null;
	return padded.subarray(0, i);
}
