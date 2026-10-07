/** HashPort over WebCrypto (crypto.subtle.digest). */

import type { HashPort } from "../../ports/crypto";
import { ab } from "./suite1Primitives";

export function createWebHash(subtle: SubtleCrypto = crypto.subtle): HashPort {
	return {
		async sha256(bytes) {
			// The view itself: digest() takes views. Only a SharedArrayBuffer-backed one is copied (digest rejects those).
			return new Uint8Array(await subtle.digest("SHA-256", ab(bytes)));
		},
	};
}
