/**
 * Suite-1 sealed-blob framing (e2ee-design §10.2) and its AAD (§7.2). Pure;
 * the suite-1 CryptoPort does the AEAD and padding.
 *
 *   u8      blobFormat   = BLOB_FORMAT_VERSION
 *   u8      cryptoSuite  = 1
 *   varuint keyEpoch     sealing epoch at upload (≥ 1)
 *   bytes   nonce(12) ‖ AES-GCM(kBlob_e, plaintext ‖ pad, blobAad) ‖ tag(16)
 *
 * Suite 0 has no blob framing: the bytes are raw.
 */

import { AAD_BLOB_PREFIX, BLOB_FORMAT_VERSION, CryptoSuite } from "../envelope";
import type { VaultId } from "../types";
import type { BlobAddress } from "../../ports/crypto";
import { CodecError, Reader, Writer, utf8Encode } from "./lib0";

export function blobAad(suite: CryptoSuite, keyEpoch: number, vaultId: VaultId | string, address: BlobAddress | string): Uint8Array {
	return new Writer(128)
		.raw(utf8Encode(AAD_BLOB_PREFIX))
		.u8(BLOB_FORMAT_VERSION)
		.u8(suite)
		.varuint(keyEpoch)
		.varstring(vaultId)
		.varstring(address)
		.finish();
}

export function encodeBlobHeader(suite: CryptoSuite, keyEpoch: number): Uint8Array {
	return new Writer(12).u8(BLOB_FORMAT_VERSION).u8(suite).varuint(keyEpoch).finish();
}

export type BlobHeaderResult =
	| { readonly ok: true; readonly suite: CryptoSuite; readonly keyEpoch: number; readonly body: Uint8Array }
	| { readonly ok: false; readonly reason: "malformed" | "unsupported-suite" };

/**
 * Unknown blobFormat or suite -> "unsupported-suite" (reader-dependent: a newer
 * writer); truncation, a non-minimal varuint or keyEpoch 0 -> "malformed".
 * `body` is a view (nonce ‖ ct ‖ tag).
 */
export function decodeBlobHeader(sealed: Uint8Array): BlobHeaderResult {
	try {
		const r = new Reader(sealed);
		if (r.u8() !== BLOB_FORMAT_VERSION) return { ok: false, reason: "unsupported-suite" };
		const suite = r.u8();
		if (suite !== CryptoSuite.aes256gcm) return { ok: false, reason: "unsupported-suite" };
		const keyEpoch = r.varuint();
		if (keyEpoch === 0) return { ok: false, reason: "malformed" };
		return { ok: true, suite, keyEpoch, body: r.raw(r.remaining) };
	} catch (e) {
		if (e instanceof CodecError) return { ok: false, reason: "malformed" };
		throw e;
	}
}
