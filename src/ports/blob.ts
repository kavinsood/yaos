/**
 * BlobPort: optional content-addressed store (R2 behind the relay). DESIGN §j.1.
 * The engine receives `BlobPort | null`; null = log-carried fallback for
 * attachments <= MAX_LOG_BLOB_BYTES via x:<hash> streams.
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
