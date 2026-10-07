/**
 * CryptoPort and HashPort. DESIGN §b.1, §h; e2ee-design.md §18.1.
 * Suite 0 (engine/adapters/noopCrypto.ts) is identity. Suite 1
 * (engine/adapters/webCryptoSuite1.ts) is AES-256-GCM over WebCrypto with
 * non-extractable keys. The envelope codec pads frames and checkpoints when
 * the suite is not 0 (e2ee-design §7.3); sealBlob owns the whole sealed-blob
 * format, padding included (§10.2).
 */

import type { Brand, ContentHash } from "../core/types";
import type { CryptoSuite } from "../core/envelope";

/** Blob-store address. Suite 0: the content hash. Suite 1: hex(HMAC-SHA-256(kAddr, sha256)) (e2ee-design §10.1). */
export type BlobAddress = Brand<string, "BlobAddress">;

/**
 * A sealed blob as parts in order; the stored object is their concatenation (e2ee-design §10.2). Suite 1:
 * [header ‖ nonce, AES-GCM output], so WebCrypto's output buffer is handed on without a copy behind the header;
 * the transport joins the parts once (httpBlob: one Blob body). Suite 0: [plaintext]. Never mutated.
 */
export type SealedBlobParts = readonly Uint8Array[];

/** Which subkey seals an envelope (e2ee-design §5.1): kFrame or kCkpt. */
export type SealPurpose = "frame" | "checkpoint";

export type OpenFailure =
	| "unknown-key"
	| "auth-failed"
	| "unsupported-suite"
	/** A suite-1 port was given suite-0 bytes (e2ee-design §9.2). */
	| "suite-downgrade"
	/** Too short for nonce plus tag, or a bad sealed-blob header (§4.1, §10.2). */
	| "malformed";

export type OpenResult =
	| { readonly ok: true; readonly plaintext: Uint8Array }
	| { readonly ok: false; readonly reason: OpenFailure };

export interface KeyState {
	/** The key for this epoch is present. */
	readonly held: boolean;
	/** Its KCV matched the winning k record (e2ee-design §5.2). Suite 0: always true. */
	readonly verified: boolean;
}

export interface CryptoPort {
	/** Suite for new seals; also this device's pin (e2ee-design §9.1). */
	readonly suite: CryptoSuite;
	/** Epoch for new seals (0 for suite 0). Changes when a roll or revoke is adopted; read it once per seal. */
	sealEpoch(): number;
	/** Suite 0: { held: keyEpoch === 0, verified: true }. */
	keyState(keyEpoch: number): KeyState;
	/** keyEpoch is the one already written into the header (the AAD binds it), so a concurrent roll cannot split them. */
	seal(input: {
		readonly purpose: SealPurpose;
		readonly keyEpoch: number;
		readonly aad: Uint8Array;
		readonly plaintext: Uint8Array;
	}): Promise<Uint8Array>;
	open(input: {
		readonly purpose: SealPurpose;
		readonly suite: CryptoSuite;
		readonly keyEpoch: number;
		readonly aad: Uint8Array;
		readonly sealed: Uint8Array;
	}): Promise<OpenResult>;
	/** The whole sealed-blob format incl. header and padding (e2ee-design §10.2), as parts. Suite 0: identity. */
	sealBlob(input: { readonly address: BlobAddress; readonly plaintext: Uint8Array }): Promise<SealedBlobParts>;
	openBlob(input: { readonly address: BlobAddress; readonly sealed: Uint8Array }): Promise<OpenResult>;
	blobAddress(hash: ContentHash): Promise<BlobAddress>;
	/** Diagnostics digest, 16 hex chars. Suite 0: sha256 prefix; suite 1: HMAC(kDiag, bytes) prefix (§6.4). */
	diagHash(bytes: Uint8Array): Promise<string>;
}

/** Role of a wrap in a k record (e2ee-design §11.1); the code is the AAD role byte (§11.2). */
export type WrapRole = "next" | "prev" | "recovery";

/**
 * Suite-1 adapter only; used by the keyring engine (WP-E3). Raw keys never
 * cross this interface outward except through exportForHost.
 *
 * wrap/unwrap semantics (e2ee-design §11.1), for a record introducing epoch e:
 * - next:     AES-GCM(kWrap_{e-1}, K_e); unwrap installs K_e;
 * - prev:     AES-GCM(kWrap_e, K_{e-1}); unwrap installs K_{e-1};
 * - recovery: AES-GCM(KEK_RK, K_e) with KEK_RK from `rk`; unwrap installs K_e.
 * Installed keys are unverified until markVerified.
 */
export interface KeyringCrypto {
	/** A new random K_e, held as pending (unverified) until setSealEpoch or drop. */
	generate(e: number): Promise<void>;
	/**
	 * QR / RK path. Zero-fills `raw`. An unheld or unverified epoch is (re)placed: "installed". A verified epoch is
	 * never replaced: "same" if `raw` is that key, else "conflict" (§11.3 out-of-band keys; the host re-keys by restart).
	 */
	install(e: number, raw: Uint8Array): Promise<"installed" | "same" | "conflict">;
	/** kcv(e), 16 bytes (e2ee-design §5.2). */
	kcv(e: number): Promise<Uint8Array>;
	/** nonce(12) ‖ ct(32) ‖ tag(16). Throws if a needed key is not held or its raw bytes are no longer retained. */
	wrap(role: WrapRole, e: number, aad: Uint8Array, rk?: Uint8Array): Promise<Uint8Array>;
	/** False on any failure (missing key, bad length, auth failure); never throws on bad bytes. */
	unwrap(role: WrapRole, e: number, aad: Uint8Array, wrapped: Uint8Array, rk?: Uint8Array): Promise<boolean>;
	markVerified(e: number): void;
	/** Throws unless e is held and verified. */
	setSealEpoch(e: number): void;
	/** Discard a key that lost (never the seal epoch). */
	drop(e: number): void;
	/** Copies of keys not yet handed to the host; marks them handed over. Only for keyringChanged (§18.4). */
	exportForHost(): readonly { readonly e: number; readonly k: Uint8Array }[];
}

export interface HashPort {
	/** SHA-256 digest (32 bytes). WebCrypto in production. */
	sha256(bytes: Uint8Array): Promise<Uint8Array>;
}
