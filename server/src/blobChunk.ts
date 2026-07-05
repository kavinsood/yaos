export const CHUNK_BYTES = 1024 * 1024; // 1 MiB

export function chunkCountForSize(size: number): number {
	if (size <= 0) return 0;
	return Math.ceil(size / CHUNK_BYTES);
}

export function splitBytes(bytes: Uint8Array): Uint8Array[] {
	if (bytes.byteLength === 0) return [new Uint8Array(0)];
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
		chunks.push(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength)));
	}
	return chunks;
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}
