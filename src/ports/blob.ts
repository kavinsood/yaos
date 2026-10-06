/**
 * BlobPort: optional store addressed by CryptoPort.blobAddress (R2 behind the
 * relay). DESIGN §j.1, e2ee-design §10. The engine receives `BlobPort | null`;
 * null = log-carried fallback for blobs <= MAX_LOG_BLOB_BYTES via x:<address>
 * streams. Puts and gets go through blobs/blobStore.ts only (putSealed / getOpened).
 */

import type { BlobAddress } from "./crypto";

export interface BlobPort {
	readonly maxBlobBytes: number;
	/** Subset of addresses already stored. */
	has(addresses: readonly BlobAddress[]): Promise<ReadonlySet<BlobAddress>>;
	/** Idempotent. Bytes are already sealed by CryptoPort.sealBlob. */
	put(address: BlobAddress, bytes: Uint8Array): Promise<void>;
	/** null = not found (yet). */
	get(address: BlobAddress): Promise<Uint8Array | null>;
}
