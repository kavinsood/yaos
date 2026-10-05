/**
 * Suite 0 (no-op) CryptoPort. DESIGN §b.1: seal/open are identity, the key
 * epoch is 0 and the blob address is the content hash itself. E2EE replaces
 * this adapter, not the envelope format.
 */

import type { BlobAddress, CryptoPort, HashPort } from "../../ports/crypto";
import { CryptoSuite } from "../../core/envelope";

/** `hash` is unused by suite 0; it is taken so the factory shape matches the E2EE adapter. */
export function createNoopCrypto(_hash: HashPort): CryptoPort {
	return {
		suite: CryptoSuite.none,
		keyEpoch: 0,
		async seal({ plaintext }) {
			return plaintext;
		},
		async open({ suite, keyEpoch, sealed }) {
			if (suite !== CryptoSuite.none) return { ok: false, reason: "unsupported-suite" };
			if (keyEpoch !== 0) return { ok: false, reason: "unknown-key" };
			return { ok: true, plaintext: sealed };
		},
		async sealBlob(plaintext) {
			return plaintext;
		},
		async openBlob(sealed) {
			return sealed;
		},
		async blobAddress(hash) {
			return hash as string as BlobAddress;
		},
	};
}
