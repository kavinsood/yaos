/**
 * bodyUpdateRef resolution (DESIGN §d.6 stage 2, §b.6, §j.1): the update is
 * fetched from the BlobPort only (address = CryptoPort.blobAddress of the ref's
 * sha256, e2ee-design §10.1); sha256 checked, then gate stage 2 on the bytes.
 * Not resolved = unavailable (the doc shows wait/blob-unavailable and
 * DocRuntime retries with backoff). Without a blob store nothing resolves.
 *
 * `deterministic` (e2ee-design §10.2) marks a failure no retry by this reader
 * can change: the store returned the blob but it does not open or verify under
 * a verified key (blobStore.ts getOpened), or bytes with the ref's sha256 fail
 * the size / Yjs check (the ref itself is bad). A store error, a
 * reader-dependent open failure (unknown key, unsupported suite), an absent
 * blob or no store at all make the attempt non-deterministic, since the store
 * may still deliver.
 */

import { MAX_DOC_TEXT_CHARS } from "../../core/limits";
import { streamClass, type StreamName } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { CryptoPort, HashPort } from "../../ports/crypto";
import { getOpened } from "../blobs/blobStore";
import { checkYjsUpdate } from "../ingest/yjsCheck";
import type { TailRecord } from "../store/schema";
import { decodeBodyUpdateRef } from "../../core/codec/contents";
import { bytesToHex } from "../../core/codec/lib0";

export interface RefDeps {
	readonly crypto: CryptoPort;
	readonly hash: HashPort;
	readonly blob: BlobPort | null;
}

export type RefResolution =
	| { readonly ok: true; readonly bytes: Uint8Array }
	| { readonly ok: false; readonly deterministic: boolean };

export async function resolveRef(deps: RefDeps, stream: StreamName, refContent: Uint8Array): Promise<RefResolution> {
	const ref = decodeBodyUpdateRef(refContent);
	const cls = streamClass(stream);
	// The gate admitted the row, so this cannot happen; if it does, no retry changes it.
	if (!ref || (cls !== "body" && cls !== "canvas")) return { ok: false, deterministic: true };
	const store = deps.blob;
	if (!store) return { ok: false, deterministic: false };
	const sha256 = async (bytes: Uint8Array): Promise<string> => bytesToHex(await deps.hash.sha256(bytes));
	// The store bounds what a GET returns; the length must equal the ref's size anyway.
	const valid = (bytes: Uint8Array): boolean =>
		bytes.length === ref.size && checkYjsUpdate(bytes, cls, { maxBytes: ref.size, maxChars: MAX_DOC_TEXT_CHARS }).ok;
	try {
		const got = await getOpened(store, deps.crypto, ref.hash, sha256);
		if (got.ok) return valid(got.bytes) ? { ok: true, bytes: got.bytes } : { ok: false, deterministic: true };
		return { ok: false, deterministic: got.deterministic };
	} catch {
		return { ok: false, deterministic: false }; // store error
	}
}

/** The resolved update bytes, or null when unavailable (any reason). */
export async function resolveRefContent(deps: RefDeps, stream: StreamName, refContent: Uint8Array): Promise<Uint8Array | null> {
	const r = await resolveRef(deps, stream, refContent);
	return r.ok ? r.bytes : null;
}

export function resolveRefRow(deps: RefDeps, row: TailRecord): Promise<Uint8Array | null> {
	return resolveRefContent(deps, row.stream, row.content);
}
