/**
 * The one blob-store path (DESIGN §j.1, e2ee-design §10): address = CryptoPort.blobAddress(sha256 of the
 * plaintext), bytes sealed with CryptoPort.sealBlob. Attachments (BlobQueue), oversize body updates (frames /
 * refs) and uploaded snapshot parts (SnapshotJob) all go through here, so the suite decides addressing, sealing
 * and the plaintext cap in one place. No plaintext hash leaves this module: the store only ever sees addresses.
 *
 * Download (e2ee-design §10.2): get -> openBlob -> sha256 must equal the reference. Every failure is
 * "unavailable"; `deterministic` marks the ones a retry by this reader cannot change, and only those count
 * towards quarantine (BlobFailureStreaks):
 *  - absent, a transport error: never (the server may still have, or get, the blob);
 *  - unknown-key, unsupported-suite: never (reader-dependent, §9.2: a re-key or an upgrade fixes them);
 *  - auth-failed, malformed, suite-downgrade, a hash mismatch: only when the sealing epoch's key is verified
 *    (KCV, §5.2), or when the header is unparseable (no key is involved). A suite-1 failure under an
 *    unverified key is never deterministic.
 */
import { CryptoSuite } from "../../core/envelope";
import { BLOB_QUARANTINE_MIN_MS, BLOB_QUARANTINE_RETRIES } from "../../core/limits";
import { decodeBlobHeader, maxSealedBlobPlaintext } from "../../core/codec/sealedBlob";
import type { ContentHash } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { BlobAddress, CryptoPort, OpenFailure } from "../../ports/crypto";

/** Largest plaintext the store path takes under this suite: the transport cap (suite 0), or what still fits it once sealed (suite 1, §7.3). */
export function storePlaintextCap(crypto: CryptoPort, store: BlobPort): number {
	return crypto.suite === CryptoSuite.none ? store.maxBlobBytes : maxSealedBlobPlaintext(store.maxBlobBytes);
}

/**
 * When an upload may re-use a stored blob instead of PUTting it again (e2ee-design §10.4 R2): a GC sweep deletes
 * unreferenced blobs uploaded more than the grace before its cutoff, so "already stored" alone is not enough.
 * blobs/touch.ts (BlobTouch) is the engine's policy.
 */
export interface PutPolicy {
	/** The store has `address`: true = skip the PUT. */
	reuse(hash: ContentHash, address: BlobAddress): Promise<boolean>;
	/** This device just PUT `address` (persists the PUT time). */
	noted(hash: ContentHash, address: BlobAddress): Promise<void>;
}

/** Stores `bytes` (whose sha256 is `hash`) unless the address is present and `policy` re-uses it. Idempotent. */
export async function putSealed(store: BlobPort, crypto: CryptoPort, hash: ContentHash, bytes: Uint8Array, policy: PutPolicy): Promise<void> {
	const address = await crypto.blobAddress(hash);
	const have = await store.has([address]);
	if (have.has(address) && await policy.reuse(hash, address)) return;
	await putAt(store, crypto, policy, hash, address, bytes);
}

/** Seals and PUTs `bytes` at `address` (= blobAddress(hash)) unconditionally; a PUT refreshes the upload time. */
export async function putAt(store: BlobPort, crypto: CryptoPort, policy: PutPolicy, hash: ContentHash, address: BlobAddress, bytes: Uint8Array): Promise<void> {
	await store.put(address, await crypto.sealBlob({ address, plaintext: bytes }));
	await policy.noted(hash, address);
}

/** Why a blob is unavailable to this reader. */
export type BlobUnavailable = "absent" | "transport" | OpenFailure | "hash-mismatch";

export type BlobFetch =
	| { readonly ok: true; readonly bytes: Uint8Array }
	| { readonly ok: false; readonly reason: BlobUnavailable; readonly deterministic: boolean };

/** null = the header names no key (unparseable: key-independent). Suite 0 has no header: epoch 0, always verified. */
function sealingKeyVerified(crypto: CryptoPort, sealed: Uint8Array): boolean | null {
	if (crypto.suite === CryptoSuite.none) return crypto.keyState(0).verified;
	const h = decodeBlobHeader(sealed);
	return h.ok ? crypto.keyState(h.keyEpoch).verified : null;
}

function openDeterministic(reason: OpenFailure, verified: boolean | null): boolean {
	switch (reason) {
		case "unknown-key":
		case "unsupported-suite":
			return false;
		case "auth-failed":
		case "malformed":
		case "suite-downgrade":
			return verified !== false;
	}
}

/**
 * The plaintext stored for `hash`, opened and checked against it. `sha256` is the caller's digest (hex of the
 * SHA-256); null = the caller checks the hash itself right after (verifyBundle's part-hash), so a mismatch is
 * not classified here. Store / transport errors throw (the caller treats them as "transport", not deterministic).
 */
export async function getOpened(
	store: BlobPort, crypto: CryptoPort, hash: ContentHash, sha256: ((bytes: Uint8Array) => string | Promise<string>) | null,
): Promise<BlobFetch> {
	const address = await crypto.blobAddress(hash);
	const sealed = await store.get(address);
	if (!sealed) return { ok: false, reason: "absent", deterministic: false };
	const opened = await crypto.openBlob({ address, sealed });
	if (!opened.ok) return { ok: false, reason: opened.reason, deterministic: openDeterministic(opened.reason, sealingKeyVerified(crypto, sealed)) };
	if (sha256 && (await sha256(opened.plaintext)) !== hash) {
		return { ok: false, reason: "hash-mismatch", deterministic: sealingKeyVerified(crypto, sealed) !== false };
	}
	return { ok: true, bytes: opened.plaintext };
}

/**
 * Quarantine rule of e2ee-design §10.2: a reference is quarantined (as deterministic) once the initial attempt
 * and BLOB_QUARANTINE_RETRIES retries all failed deterministically, spanning at least BLOB_QUARANTINE_MIN_MS of
 * the monotonic clock. Any other outcome (success, absent, transport, reader-dependent) restarts the count.
 * In memory: a restart retries from scratch.
 */
export class BlobFailureStreaks {
	private readonly streaks = new Map<string, { n: number; firstMs: number }>();

	constructor(private readonly retries = BLOB_QUARANTINE_RETRIES, private readonly minMs = BLOB_QUARANTINE_MIN_MS) {}

	/** Record one attempt's outcome for `key`; true = quarantine now. */
	note(key: string, deterministic: boolean, monoMs: number): boolean {
		if (!deterministic) {
			this.streaks.delete(key);
			return false;
		}
		const s = this.streaks.get(key) ?? { n: 0, firstMs: monoMs };
		s.n++;
		this.streaks.set(key, s);
		return s.n > this.retries && monoMs - s.firstMs >= this.minMs;
	}

	clear(key: string): void {
		this.streaks.delete(key);
	}
}
