/**
 * bodyUpdateRef resolution (DESIGN §d.6 stage 2, §b.6, §j.1): BlobPort first,
 * then the x:<address> log stream (address = CryptoPort.blobAddress of the
 * ref's sha256, e2ee-design §10.1); sha256 checked, then gate stage 2 on the
 * bytes. Not resolved = unavailable (the doc shows wait/blob-unavailable and
 * DocRuntime retries with backoff).
 *
 * `deterministic` (e2ee-design §10.2) marks a failure no retry by this reader
 * can change: the store returned the blob but it does not open or verify under
 * a verified key (blobStore.ts getOpened), bytes with the ref's sha256 fail the
 * size / Yjs check (the ref itself is bad), or the committed x: chunks assemble
 * into bytes that do not verify (they passed the gate, the first chunk per
 * index wins, rows are immutable). A store error or a reader-dependent open
 * failure (unknown key, unsupported suite) makes the attempt non-deterministic,
 * since the store may still deliver; so does nothing found anywhere.
 */

import { MAX_DOC_TEXT_CHARS, MAX_LOG_BLOB_BYTES } from "../../core/limits";
import { blobChunkStream, streamClass, type ContentHash, type StreamName } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { CryptoPort, HashPort } from "../../ports/crypto";
import { getOpened } from "../blobs/blobStore";
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

export type RefResolution =
	| { readonly ok: true; readonly bytes: Uint8Array }
	| { readonly ok: false; readonly deterministic: boolean };

export async function resolveRef(deps: RefDeps, stream: StreamName, refContent: Uint8Array): Promise<RefResolution> {
	const ref = decodeBodyUpdateRef(refContent);
	const cls = streamClass(stream);
	// The gate admitted the row, so this cannot happen; if it does, no retry changes it.
	if (!ref || (cls !== "body" && cls !== "canvas")) return { ok: false, deterministic: true };
	const sha256 = async (bytes: Uint8Array): Promise<string> => bytesToHex(await deps.hash.sha256(bytes));
	const valid = (bytes: Uint8Array): boolean =>
		bytes.length === ref.size && checkYjsUpdate(bytes, cls, { maxBytes: MAX_LOG_BLOB_BYTES * 8, maxChars: MAX_DOC_TEXT_CHARS }).ok;
	let deterministic = false;
	let transient = false;
	if (deps.blob) {
		try {
			const got = await getOpened(deps.blob, deps.crypto, ref.hash, sha256);
			if (got.ok && valid(got.bytes)) return { ok: true, bytes: got.bytes };
			if (got.ok || got.deterministic) deterministic = true;
			else if (got.reason !== "absent") transient = true;
		} catch {
			transient = true; // store error: fall through to the log
		}
	}
	const rows = await deps.repo.getTail(blobChunkStream(await deps.crypto.blobAddress(ref.hash)));
	const assembled = assembleChunks(rows.map((r) => r.content), ref.hash);
	if (assembled) {
		if ((await sha256(assembled)) === ref.hash && valid(assembled)) return { ok: true, bytes: assembled };
		deterministic = true;
	}
	return { ok: false, deterministic: deterministic && !transient };
}

/** The resolved update bytes, or null when unavailable (any reason). */
export async function resolveRefContent(deps: RefDeps, stream: StreamName, refContent: Uint8Array): Promise<Uint8Array | null> {
	const r = await resolveRef(deps, stream, refContent);
	return r.ok ? r.bytes : null;
}

export function resolveRefRow(deps: RefDeps, row: TailRecord): Promise<Uint8Array | null> {
	return resolveRefContent(deps, row.stream, row.content);
}
