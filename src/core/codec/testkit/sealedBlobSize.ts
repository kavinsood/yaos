/** The sealed-blob size oracle of the size tests (e2ee-design §7.3). Never shipped. */

import { CryptoSuite } from "../../envelope";
import { padmeLen } from "../padme";
import { BLOB_AEAD_BYTES, encodeBlobHeader } from "../sealedBlob";

/** Sealed suite-1 size of an n-byte plaintext at keyEpoch: header ‖ nonce ‖ padmeLen(n + 1) ‖ tag. */
export function sealedBlobBytes(n: number, keyEpoch: number): number {
	return encodeBlobHeader(CryptoSuite.aes256gcm, keyEpoch).length + BLOB_AEAD_BYTES + padmeLen(n + 1);
}
