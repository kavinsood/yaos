/**
 * Suite-1 WebCrypto primitives (e2ee-design §4.1, §5.1). Every CryptoKey made
 * here is non-extractable. NEVER trial-decrypt; NEVER a counter or
 * deterministic nonce: the caller passes 12 bytes from RandomPort
 * (crypto.getRandomValues in production).
 */

import { Writer, utf8Encode } from "../../core/codec/lib0";

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
/** nonce ‖ … ‖ tag. */
export const AEAD_OVERHEAD = NONCE_BYTES + TAG_BYTES;
/** K_e and every derived subkey. */
export const KEY_BYTES = 32;
export const KCV_BYTES = 16;
/** A wrapped key: nonce(12) ‖ ct(32) ‖ tag(16) (e2ee-design §11.1). */
export const WRAP_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES;
export const HKDF_SALT = "yaos-hkdf-v1";

/** AES-256-GCM subkeys. "recovery-kek" is derived from RK[0..32], never from K_e. */
export type AeadPurpose = "frame" | "checkpoint" | "blob" | "wrap" | "recovery-kek";
/** HMAC-SHA-256 subkeys (32-byte keys). */
export type MacPurpose = "kcv" | "addr" | "diag";
export type Purpose = AeadPurpose | MacPurpose;

const MAC_PURPOSES: ReadonlySet<Purpose> = new Set<Purpose>(["kcv", "addr", "diag"]);

/** I(purpose, e) = utf8("yaos/v1/" + purpose) ‖ 0x00 ‖ utf8(vaultId) ‖ 0x00 ‖ varuint e. Also the KCV message (§5.2). */
export function hkdfInfo(purpose: Purpose, vaultId: string, e: number): Uint8Array {
	return new Writer(64).raw(utf8Encode(`yaos/v1/${purpose}`)).u8(0).raw(utf8Encode(vaultId)).u8(0).varuint(e).finish();
}

/** WebCrypto takes plain-ArrayBuffer views (it rejects SharedArrayBuffer ones); copies only when needed. */
export function ab(u: Uint8Array): Uint8Array<ArrayBuffer> {
	return u.buffer instanceof ArrayBuffer ? (u as Uint8Array<ArrayBuffer>) : new Uint8Array(u);
}

/** HKDF base key, non-extractable ([WebCrypto] §33.4.2: HKDF keys cannot be extractable anyway). */
export function importBase(subtle: SubtleCrypto, raw: Uint8Array): Promise<CryptoKey> {
	if (raw.length !== KEY_BYTES) throw new Error(`suite 1: key must be ${KEY_BYTES} bytes`);
	return subtle.importKey("raw", ab(raw), "HKDF", false, ["deriveKey"]);
}

export function deriveSubkey(subtle: SubtleCrypto, base: CryptoKey, purpose: Purpose, vaultId: string, e: number): Promise<CryptoKey> {
	const params: HkdfParams = { name: "HKDF", hash: "SHA-256", salt: ab(utf8Encode(HKDF_SALT)), info: ab(hkdfInfo(purpose, vaultId, e)) };
	return MAC_PURPOSES.has(purpose)
		? subtle.deriveKey(params, base, { name: "HMAC", hash: "SHA-256", length: KEY_BYTES * 8 }, false, ["sign"])
		: subtle.deriveKey(params, base, { name: "AES-GCM", length: KEY_BYTES * 8 }, false, ["encrypt", "decrypt"]);
}

/** nonce ‖ AES-GCM(key, plaintext, aad) ‖ tag. The nonce length is checked before WebCrypto sees it (§4.1). */
export async function gcmSeal(subtle: SubtleCrypto, key: CryptoKey, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
	if (nonce.length !== NONCE_BYTES) throw new Error(`suite 1: nonce must be ${NONCE_BYTES} bytes`);
	const ct = await subtle.encrypt({ name: "AES-GCM", iv: ab(nonce), additionalData: ab(aad), tagLength: TAG_BYTES * 8 }, key, ab(plaintext));
	const out = new Uint8Array(NONCE_BYTES + ct.byteLength);
	out.set(nonce, 0);
	out.set(new Uint8Array(ct), NONCE_BYTES);
	return out;
}

/** Inverse of gcmSeal. "malformed": shorter than nonce plus tag; "auth-failed": the tag did not verify. */
export async function gcmOpen(subtle: SubtleCrypto, key: CryptoKey, aad: Uint8Array, sealed: Uint8Array): Promise<Uint8Array | "malformed" | "auth-failed"> {
	if (sealed.length < AEAD_OVERHEAD) return "malformed";
	const nonce = sealed.subarray(0, NONCE_BYTES);
	if (nonce.length !== NONCE_BYTES) return "malformed";
	try {
		const pt = await subtle.decrypt({ name: "AES-GCM", iv: ab(nonce), additionalData: ab(aad), tagLength: TAG_BYTES * 8 }, key, ab(sealed.subarray(NONCE_BYTES)));
		return new Uint8Array(pt);
	} catch (e) {
		if ((e as { name?: unknown } | null)?.name === "OperationError") return "auth-failed";
		throw e;
	}
}

export async function hmac(subtle: SubtleCrypto, key: CryptoKey, msg: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await subtle.sign("HMAC", key, ab(msg)));
}
