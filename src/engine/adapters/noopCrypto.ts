/**
 * Suite 0 (no-op) CryptoPort. DESIGN §b.1: seal/open are identity, the key
 * epoch is 0 and the blob address is the content hash itself. Suite 1 is
 * webCryptoSuite1.ts; the envelope format is the same.
 */

import type { BlobAddress, CryptoPort, HashPort } from "../../ports/crypto";
import { CryptoSuite } from "../../core/envelope";
import { DIAG_HASH_HEX_CHARS } from "../../core/codec/envelope";
import { bytesToHex } from "../../core/codec/lib0";

/** `hash` backs diagHash (a sha256 prefix under suite 0, e2ee-design §6.4). */
export function createNoopCrypto(hash: HashPort): CryptoPort {
	return {
		suite: CryptoSuite.none,
		sealEpoch: () => 0,
		keyState: (keyEpoch) => ({ held: keyEpoch === 0, verified: true }),
		async seal({ plaintext }) {
			return plaintext;
		},
		async open({ suite, keyEpoch, sealed }) {
			if (suite !== CryptoSuite.none) return { ok: false, reason: "unsupported-suite" };
			if (keyEpoch !== 0) return { ok: false, reason: "unknown-key" };
			return { ok: true, plaintext: sealed };
		},
		async sealBlob({ plaintext }) {
			return [plaintext];
		},
		async openBlob({ sealed }) {
			return { ok: true, plaintext: sealed };
		},
		async blobAddress(h) {
			return h as string as BlobAddress;
		},
		async diagHash(bytes) {
			return bytesToHex(await hash.sha256(bytes)).slice(0, DIAG_HASH_HEX_CHARS);
		},
	};
}
