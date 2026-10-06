/**
 * bodyUpdateRef resolution (DESIGN §d.6 stage 2, §b.6, §j.1): BlobPort first,
 * then the x:<address> log stream (address = CryptoPort.blobAddress of the
 * ref's sha256, e2ee-design §10.1); sha256 checked, then gate stage 2 on the
 * bytes. null = not available yet (the doc shows wait/blob-unavailable).
 */

import { MAX_DOC_TEXT_CHARS, MAX_LOG_BLOB_BYTES } from "../../core/limits";
import { blobChunkStream, streamClass, type ContentHash, type StreamName } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { CryptoPort, HashPort } from "../../ports/crypto";
import { checkYjsUpdate } from "../ingest/yjsCheck";
import type { Repo } from "../store/repo";
import type { TailRecord } from "../store/schema";
import { decodeBlobChunk, decodeBodyUpdateRef } from "../../core/codec/contents";
import { bytesToHex, concatBytes } from "../../core/codec/lib0";

export interface RefDeps {
	readonly repo: Repo;
	readonly crypto: CryptoPort;
	readonly hash: HashPort;
	readonly blob: BlobPort | null;
}

/** Assemble x: chunk contents (any order, duplicates ok). null if incomplete or inconsistent. */
export function assembleChunks(contents: readonly Uint8Array[], hash: ContentHash): Uint8Array | null {
	const parts = new Map<number, Uint8Array>();
	let total = -1;
	let totalSize = -1;
	for (const c of contents) {
		const d = decodeBlobChunk(c);
		if (!d || d.hash !== hash) continue;
		if (total === -1) {
			total = d.total;
			totalSize = d.totalSize;
		} else if (d.total !== total || d.totalSize !== totalSize) continue;
		if (!parts.has(d.index)) parts.set(d.index, d.chunk);
	}
	if (total <= 0 || parts.size !== total || totalSize > MAX_LOG_BLOB_BYTES) return null;
	const ordered: Uint8Array[] = [];
	for (let i = 0; i < total; i++) ordered.push(parts.get(i)!);
	const out = concatBytes(ordered);
	return out.length === totalSize ? out : null;
}

export async function resolveRefContent(deps: RefDeps, stream: StreamName, refContent: Uint8Array): Promise<Uint8Array | null> {
	const ref = decodeBodyUpdateRef(refContent);
	if (!ref) return null;
	const cls = streamClass(stream);
	if (cls !== "body" && cls !== "canvas") return null;
	const verify = async (bytes: Uint8Array | null): Promise<Uint8Array | null> => {
		if (!bytes || bytes.length !== ref.size) return null;
		if (bytesToHex(await deps.hash.sha256(bytes)) !== ref.hash) return null;
		const r = checkYjsUpdate(bytes, cls, { maxBytes: MAX_LOG_BLOB_BYTES * 8, maxChars: MAX_DOC_TEXT_CHARS });
		return r.ok ? bytes : null;
	};
	const address = await deps.crypto.blobAddress(ref.hash);
	if (deps.blob) {
		try {
			const sealed = await deps.blob.get(address);
			const opened = sealed ? await deps.crypto.openBlob({ address, sealed }) : null;
			const ok = await verify(opened?.ok ? opened.plaintext : null);
			if (ok) return ok;
		} catch {
			// fall through to the log
		}
	}
	const rows = await deps.repo.getTail(blobChunkStream(address));
	return verify(assembleChunks(rows.map((r) => r.content), ref.hash));
}

export function resolveRefRow(deps: RefDeps, row: TailRecord): Promise<Uint8Array | null> {
	return resolveRefContent(deps, row.stream, row.content);
}
