/**
 * Log-carried blobs (DESIGN §j.1, no blob store): an attachment <= 8 MiB rides
 * stream x:<sha256> as blobChunk frames of BLOB_CHUNK_BYTES (<= 11 rows).
 * Readers assemble by index (duplicates ignored) and verify the hash.
 */

import type { BlobChunkContent } from "../../core/envelope";
import { sha256Hex } from "../../core/hash/sha256";
import { BLOB_CHUNK_BYTES, MAX_LOG_BLOB_BYTES } from "../../core/limits";
import type { ContentHash } from "../../core/types";

/** The log runtime's x: stream access (WP-C). */
export interface BlobChunkLog {
	/** Append the chunks as blobChunk frames of x:<hash>; true once every chunk is receipted (committed). */
	appendChunks(hash: ContentHash, chunks: readonly BlobChunkContent[]): Promise<boolean>;
	/** Committed chunk contents of x:<hash>, any order, duplicates possible; null = not readable now. */
	readChunks(hash: ContentHash): Promise<readonly BlobChunkContent[] | null>;
}

export function splitChunks(hash: ContentHash, bytes: Uint8Array, chunkBytes = BLOB_CHUNK_BYTES): BlobChunkContent[] {
	if (bytes.length > MAX_LOG_BLOB_BYTES) throw new Error(`blob too large for the log: ${bytes.length}`);
	const total = Math.max(1, Math.ceil(bytes.length / chunkBytes));
	const out: BlobChunkContent[] = [];
	for (let i = 0; i < total; i++) {
		out.push({ hash, index: i, total, totalSize: bytes.length, chunk: bytes.subarray(i * chunkBytes, Math.min(bytes.length, (i + 1) * chunkBytes)) });
	}
	return out;
}

export type AssembleResult =
	| { readonly ok: true; readonly bytes: Uint8Array }
	| { readonly ok: false; readonly reason: "incomplete" | "inconsistent" | "hash-mismatch" };

/**
 * Assemble chunks of one blob. The first chunk seen for an index wins; chunks
 * disagreeing on total / totalSize / hash are inconsistent (a corrupt or
 * foreign frame); a missing index is incomplete (retry later).
 */
export function assembleChunks(hash: ContentHash, chunks: readonly BlobChunkContent[]): AssembleResult {
	const mine = chunks.filter((c) => c.hash === hash);
	const first = mine[0];
	if (!first) return { ok: false, reason: "incomplete" };
	const { total, totalSize } = first;
	if (total < 1 || totalSize > MAX_LOG_BLOB_BYTES) return { ok: false, reason: "inconsistent" };
	const byIndex = new Map<number, Uint8Array>();
	for (const c of mine) {
		if (c.total !== total || c.totalSize !== totalSize || c.index < 0 || c.index >= total) return { ok: false, reason: "inconsistent" };
		if (!byIndex.has(c.index)) byIndex.set(c.index, c.chunk);
	}
	if (byIndex.size !== total) return { ok: false, reason: "incomplete" };
	let size = 0;
	for (const c of byIndex.values()) size += c.length;
	if (size !== totalSize) return { ok: false, reason: "inconsistent" };
	const bytes = new Uint8Array(totalSize);
	let at = 0;
	for (let i = 0; i < total; i++) {
		const c = byIndex.get(i)!;
		bytes.set(c, at);
		at += c.length;
	}
	return sha256Hex(bytes) === hash ? { ok: true, bytes } : { ok: false, reason: "hash-mismatch" };
}
