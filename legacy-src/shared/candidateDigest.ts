const MULTI_FRAME_MAGIC = Uint8Array.of(0x59, 0x41, 0x4f, 0x53, 0x43, 0x46, 0x31, 0x00); // YAOSCF1\0

/**
 * Exact, engine-independent digest material for one logical candidate.
 *
 * A single frame retains the original SHA-256(frame) contract. Multiple
 * frames are length-delimited because Yjs and yrs may emit different merged
 * wire encodings for the same state. The lifecycle fence must bind the bytes
 * that YAOS actually persists, not an engine-specific re-encoding of them.
 */
export function candidateDigestMaterial(frames: readonly Uint8Array[]): Uint8Array {
	if (frames.length === 0) throw new Error("candidate digest requires at least one frame");
	if (frames.length === 1) return frames[0]!;
	let byteLength = MULTI_FRAME_MAGIC.byteLength + 4;
	for (const frame of frames) {
		if (frame.byteLength === 0) throw new Error("candidate digest frame is empty");
		byteLength += 4 + frame.byteLength;
		if (!Number.isSafeInteger(byteLength)) throw new Error("candidate digest material is too large");
	}
	const material = new Uint8Array(byteLength);
	material.set(MULTI_FRAME_MAGIC, 0);
	const view = new DataView(material.buffer);
	let offset = MULTI_FRAME_MAGIC.byteLength;
	view.setUint32(offset, frames.length, true);
	offset += 4;
	for (const frame of frames) {
		view.setUint32(offset, frame.byteLength, true);
		offset += 4;
		material.set(frame, offset);
		offset += frame.byteLength;
	}
	return material;
}
