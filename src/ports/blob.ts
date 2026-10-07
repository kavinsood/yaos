/**
 * BlobPort: the store addressed by CryptoPort.blobAddress (R2 behind the
 * relay, HTTP PUT / GET). DESIGN §j.1, e2ee-design §10. The only carrier of
 * blob bytes: the relay's sequence log carries just the small records that
 * reference them. The engine receives `BlobPort | null`; null = no store:
 * attachments and oversize body updates do not sync (fail closed). Puts and
 * gets go through blobs/blobStore.ts only (putSealed / getOpened).
 *
 * list / deleteIfUploadedBefore are the mark-and-sweep routes (relay-wire §11.3.1,
 * e2ee-design §10.4): only blobs/gc.ts calls them. Upload times are the store's
 * clock (R2's `uploaded`); a PUT overwrite refreshes them.
 *
 * Every call takes an optional AbortSignal and rejects soon after it aborts (the engine aborts in-flight
 * transfers when the session loop declares the link dead, blobs/transferLink.ts, and on stop). No call
 * stays stuck: an adapter ends a transfer that moves no byte for BLOB_TRANSFER_IDLE_MS (core/limits.ts) with a
 * transport error, and never cuts one that is still moving.
 */

import type { BlobAddress, SealedBlobParts } from "./crypto";

/** Addresses per deleteIfUploadedBefore call (relay-wire §11.3.1: 1..100). */
export const BLOB_DELETE_BATCH = 100;

export interface BlobListItem {
	readonly address: BlobAddress;
	/** Store clock, ms. */
	readonly uploadedAt: number;
}

export interface BlobListPage {
	/** Address order, after the cursor. May be short or empty while `next` is non-null. */
	readonly items: readonly BlobListItem[];
	/** Cursor of the next page; null only when the listing is complete. */
	readonly next: BlobAddress | null;
}

export type BlobDeleteResult =
	| { readonly address: BlobAddress; readonly result: "deleted"; readonly uploadedAt: number }
	| { readonly address: BlobAddress; readonly result: "newer"; readonly uploadedAt: number }
	| { readonly address: BlobAddress; readonly result: "absent" };

/**
 * BlobPort.put's rejection when the store will not take a body of that size (HTTP 413: the relay's own, or the
 * edge's HTML page when a plan's request limit is below the advertised cap). The same bytes can never succeed,
 * so the caller does not retry them (blobs/blobQueue.ts).
 */
export class BlobTooLargeError extends Error {
	constructor(readonly bytes: number) {
		super(`blob store refused ${bytes} bytes as too large`);
		this.name = "BlobTooLargeError";
	}
}

export interface BlobPort {
	readonly maxBlobBytes: number;
	/** Subset of addresses already stored. */
	has(addresses: readonly BlobAddress[], signal?: AbortSignal): Promise<ReadonlySet<BlobAddress>>;
	/** Idempotent. Stores the concatenation of `parts`, as CryptoPort.sealBlob returned them. BlobTooLargeError = refused by size. */
	put(address: BlobAddress, parts: SealedBlobParts, signal?: AbortSignal): Promise<void>;
	/** null = not found (yet). */
	get(address: BlobAddress, signal?: AbortSignal): Promise<Uint8Array | null>;
	/** One page of the vault's blobs after `cursor` (null = from the start). Rejects when `signal` aborts. */
	list(cursor: BlobAddress | null, signal?: AbortSignal): Promise<BlobListPage>;
	/**
	 * Deletes each of 1..BLOB_DELETE_BATCH distinct addresses whose object was uploaded strictly before
	 * `cutoffMs` (store clock); results in request order. A PUT that lands between the store's check and its
	 * delete is still deleted and reported "deleted" (relay-wire §11.3.1); the caller repairs (gc.ts R4).
	 */
	deleteIfUploadedBefore(addresses: readonly BlobAddress[], cutoffMs: number, signal?: AbortSignal): Promise<readonly BlobDeleteResult[]>;
}
