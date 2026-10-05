/**
 * CryptoPort and HashPort. DESIGN §b.1, §h.
 * v1 ships the no-op suite (0): seal/open are identity. The hook exists so
 * E2EE is a port swap, not a format change.
 */

import type { Brand, ContentHash } from "../core/types";
import type { CryptoSuite } from "../core/envelope";

/** Blob-store address. Suite 0: the content hash. E2EE: HMAC-SHA256(vaultKey, hash) so the store cannot test content. */
export type BlobAddress = Brand<string, "BlobAddress">;

export type OpenFailure = "unknown-key" | "auth-failed" | "unsupported-suite";

export interface CryptoPort {
	/** Suite used for new seals. */
	readonly suite: CryptoSuite;
	/** Key epoch used for new seals (0 for suite 0). */
	readonly keyEpoch: number;
	seal(input: { readonly aad: Uint8Array; readonly plaintext: Uint8Array }): Promise<Uint8Array>;
	open(input: {
		readonly suite: CryptoSuite;
		readonly keyEpoch: number;
		readonly aad: Uint8Array;
		readonly sealed: Uint8Array;
	}): Promise<{ readonly ok: true; readonly plaintext: Uint8Array } | { readonly ok: false; readonly reason: OpenFailure }>;
	/** Encrypt/decrypt blob bytes for the blob store (identity for suite 0). */
	sealBlob(plaintext: Uint8Array): Promise<Uint8Array>;
	openBlob(sealed: Uint8Array): Promise<Uint8Array | null>;
	blobAddress(hash: ContentHash): Promise<BlobAddress>;
}

export interface HashPort {
	/** SHA-256 digest (32 bytes). WebCrypto in production. */
	sha256(bytes: Uint8Array): Promise<Uint8Array>;
}
