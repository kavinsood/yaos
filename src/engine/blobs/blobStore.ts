/**
 * The one blob-store path (DESIGN §j.1): address = CryptoPort.blobAddress(sha256 of the plaintext), bytes sealed
 * with CryptoPort.sealBlob. Attachments (BlobQueue) and uploaded snapshot parts (SnapshotJob) both go through
 * here, so a crypto suite change (E2EE sealed blobs, HMAC addresses) applies to both unchanged.
 */
import type { ContentHash } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { CryptoPort } from "../../ports/crypto";

/** Stores `bytes` (whose sha256 is `hash`) unless the address is already present. Idempotent. */
export async function putSealed(store: BlobPort, crypto: CryptoPort, hash: ContentHash, bytes: Uint8Array): Promise<void> {
	const addr = await crypto.blobAddress(hash);
	const have = await store.has([addr]);
	if (have.has(addr)) return;
	await store.put(addr, await crypto.sealBlob(bytes));
}

/** Opened plaintext stored for `hash`, or null when absent or it does not open. The caller verifies the hash. */
export async function getOpened(store: BlobPort, crypto: CryptoPort, hash: ContentHash): Promise<Uint8Array | null> {
	const sealed = await store.get(await crypto.blobAddress(hash));
	return sealed ? crypto.openBlob(sealed) : null;
}
