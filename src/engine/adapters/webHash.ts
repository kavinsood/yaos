/** HashPort over WebCrypto (crypto.subtle.digest). */

import type { HashPort } from "../../ports/crypto";

export function createWebHash(subtle: SubtleCrypto = crypto.subtle): HashPort {
	return {
		async sha256(bytes) {
			// Copy into a plain ArrayBuffer: digest() rejects SharedArrayBuffer-backed views.
			return new Uint8Array(await subtle.digest("SHA-256", bytes.slice()));
		},
	};
}
