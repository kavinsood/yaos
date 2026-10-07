/**
 * Suite-1 CryptoPort and KeyringCrypto: AES-256-GCM over WebCrypto
 * (e2ee-design §4-§6, §10, §11, §18.1). Lives in the worker (§6.3).
 *
 * - Each K_e is imported as a non-extractable HKDF base key; subkeys are
 *   derived lazily on first use and are non-extractable too (§5.1).
 * - WebCrypto cannot wrap a non-extractable key (wrapKey needs
 *   `extractable`), and k records wrap raw keys (§11.1). So raw bytes are
 *   retained only where a wrap or the host hand-off may still need them: a
 *   key not yet exported to the host, a pending (generated) key, and every
 *   epoch ≥ the seal epoch (the next roll's or revoke's prevWrap). Older raw
 *   bytes are zero-filled (best-effort; JS cannot guarantee erasure).
 * - sealEpoch() is 0 until setSealEpoch: such a port seals nothing.
 */

import { DIAG_HASH_HEX_CHARS } from "../../core/codec/envelope";
import { bytesToHex, hexToBytes } from "../../core/codec/lib0";
import { pad, unpad } from "../../core/codec/padme";
import { blobAad, decodeBlobHeader, encodeBlobHeader } from "../../core/codec/sealedBlob";
import { CryptoSuite } from "../../core/envelope";
import type { VaultId } from "../../core/types";
import type { BlobAddress, CryptoPort, KeyringCrypto, OpenFailure, OpenResult, WrapRole } from "../../ports/crypto";
import type { RandomPort } from "../../ports/random";
import { AEAD_OVERHEAD, KCV_BYTES, KEY_BYTES, NONCE_BYTES, WRAP_BYTES, deriveSubkey, gcmEncrypt, gcmOpen, gcmSeal, hkdfInfo, hmac, importBase, type Purpose } from "./suite1Primitives";

export type Suite1Crypto = CryptoPort & KeyringCrypto;

export interface Suite1Options {
	readonly vaultId: VaultId | string;
	/** Nonces and generated keys. crypto.getRandomValues in production; seeded only in tests. */
	readonly random: RandomPort;
	readonly subtle?: SubtleCrypto;
	/** Keys the host already persisted (init.crypto, §18.4). Zero-filled after import; unverified until markVerified. */
	readonly keys?: readonly { readonly e: number; readonly k: Uint8Array }[];
}

interface Entry {
	readonly base: CryptoKey;
	raw: Uint8Array | null;
	verified: boolean;
	pending: boolean;
	exported: boolean;
	readonly sub: Map<Purpose, Promise<CryptoKey>>;
}

const fail = (reason: OpenFailure): OpenResult => ({ ok: false, reason });

function checkEpoch(e: number): void {
	if (!Number.isSafeInteger(e) || e < 1) throw new Error(`suite 1: bad key epoch ${e}`);
}

export async function createWebCryptoSuite1(o: Suite1Options): Promise<Suite1Crypto> {
	const subtle = o.subtle ?? crypto.subtle;
	const vaultId = o.vaultId as string;
	const keys = new Map<number, Entry>();
	let sealEpoch = 0;

	const entry = (e: number): Entry => {
		const k = keys.get(e);
		if (!k) throw new Error(`suite 1: key epoch ${e} not held`);
		return k;
	};
	const subkey = (e: number, p: Purpose): Promise<CryptoKey> => {
		const k = entry(e);
		let s = k.sub.get(p);
		if (!s) k.sub.set(p, (s = deriveSubkey(subtle, k.base, p, vaultId, e)));
		return s;
	};
	const sealKey = async (e: number, p: Purpose): Promise<CryptoKey> => {
		if (!entry(e).verified) throw new Error(`suite 1: refusing to seal under unverified key epoch ${e}`);
		return subkey(e, p);
	};
	const trim = (): void => {
		for (const [e, k] of keys) {
			if (k.raw && k.exported && !k.pending && e < sealEpoch) {
				k.raw.fill(0);
				k.raw = null;
			}
		}
	};
	const put = async (e: number, raw: Uint8Array, flags: { pending: boolean; exported: boolean }): Promise<void> => {
		checkEpoch(e);
		if (raw.length !== KEY_BYTES) throw new Error(`suite 1: key must be ${KEY_BYTES} bytes`);
		if (keys.get(e)?.verified) throw new Error(`suite 1: key epoch ${e} is already verified`);
		const copy = raw.slice();
		raw.fill(0);
		const base = await importBase(subtle, copy);
		keys.get(e)?.raw?.fill(0);
		keys.set(e, { base, raw: copy, verified: false, sub: new Map(), ...flags });
		trim();
	};
	const kek = async (rk: Uint8Array | undefined): Promise<CryptoKey> => {
		if (!rk || rk.length < KEY_BYTES) throw new Error("suite 1: recovery key required");
		return deriveSubkey(subtle, await importBase(subtle, rk.subarray(0, KEY_BYTES)), "recovery-kek", vaultId, 0);
	};
	/** Whether `raw` is the key held for e (full HMAC kcv of both); zero-fills `raw`. */
	const sameAsHeld = async (e: number, raw: Uint8Array): Promise<boolean> => {
		const tmp = await importBase(subtle, raw);
		raw.fill(0);
		const kcvOf = (base: CryptoKey) => deriveSubkey(subtle, base, "kcv", vaultId, e).then((k) => hmac(subtle, k, hkdfInfo("kcv", vaultId, e)));
		const [a, b] = await Promise.all([kcvOf(tmp), kcvOf(entry(e).base)]);
		return a.every((x, i) => x === b[i]);
	};
	/** For a record introducing e: which epoch's kWrap seals, and which epoch's K is sealed (§11.1). */
	const wrapEpochs = (role: WrapRole, e: number): { by: number | null; of: number } =>
		role === "next" ? { by: e - 1, of: e } : role === "prev" ? { by: e, of: e - 1 } : { by: null, of: e };
	const nonce = (): Uint8Array => o.random.bytes(NONCE_BYTES);

	for (const { e, k } of o.keys ?? []) await put(e, k, { pending: false, exported: true });

	return {
		suite: CryptoSuite.aes256gcm,
		sealEpoch: () => sealEpoch,
		keyState(e) {
			const k = keys.get(e);
			return { held: k !== undefined, verified: k?.verified ?? false };
		},
		async seal({ purpose, keyEpoch, aad, plaintext }) {
			return gcmSeal(subtle, await sealKey(keyEpoch, purpose), nonce(), aad, plaintext);
		},
		async open({ purpose, suite, keyEpoch, aad, sealed }) {
			if (suite === CryptoSuite.none) return fail("suite-downgrade");
			if (suite !== CryptoSuite.aes256gcm) return fail("unsupported-suite");
			if (!keys.has(keyEpoch)) return fail("unknown-key");
			if (sealed.length < AEAD_OVERHEAD) return fail("malformed");
			const r = await gcmOpen(subtle, await subkey(keyEpoch, purpose), aad, sealed);
			return typeof r === "string" ? fail(r) : { ok: true, plaintext: r };
		},
		async sealBlob({ address, plaintext }) {
			const e = sealEpoch;
			const key = await sealKey(e, "blob");
			const header = encodeBlobHeader(CryptoSuite.aes256gcm, e);
			const iv = nonce();
			const head = new Uint8Array(header.length + NONCE_BYTES);
			head.set(header, 0);
			head.set(iv, header.length);
			// Two parts: joining WebCrypto's blob-sized output behind header ‖ nonce would copy it (§10.3).
			// pad() is the one copy of the plaintext: AES-GCM takes one contiguous input.
			return [head, await gcmEncrypt(subtle, key, iv, blobAad(CryptoSuite.aes256gcm, e, vaultId, address), pad(plaintext))];
		},
		async openBlob({ address, sealed }) {
			const h = decodeBlobHeader(sealed);
			if (!h.ok) return fail(h.reason);
			if (!keys.has(h.keyEpoch)) return fail("unknown-key");
			const r = await gcmOpen(subtle, await subkey(h.keyEpoch, "blob"), blobAad(h.suite, h.keyEpoch, vaultId, address), h.body);
			if (typeof r === "string") return fail(r);
			const plaintext = unpad(r);
			return plaintext ? { ok: true, plaintext } : fail("malformed");
		},
		async blobAddress(hash) {
			const digest = hexToBytes(hash);
			if (digest.length !== 32) throw new Error("suite 1: blobAddress needs a sha256 hex digest");
			return bytesToHex(await hmac(subtle, await subkey(1, "addr"), digest)) as BlobAddress;
		},
		async diagHash(bytes) {
			return bytesToHex(await hmac(subtle, await subkey(1, "diag"), bytes)).slice(0, DIAG_HASH_HEX_CHARS);
		},

		async generate(e) {
			await put(e, o.random.bytes(KEY_BYTES), { pending: true, exported: false });
		},
		async install(e, raw) {
			checkEpoch(e);
			if (raw.length !== KEY_BYTES) throw new Error(`suite 1: key must be ${KEY_BYTES} bytes`);
			if (keys.get(e)?.verified) return (await sameAsHeld(e, raw)) ? "same" : "conflict";
			await put(e, raw, { pending: false, exported: false });
			return "installed";
		},
		async kcv(e) {
			return (await hmac(subtle, await subkey(e, "kcv"), hkdfInfo("kcv", vaultId, e))).slice(0, KCV_BYTES);
		},
		async wrap(role, e, aad, rk) {
			checkEpoch(e);
			const { by, of } = wrapEpochs(role, e);
			const raw = entry(of).raw;
			if (!raw) throw new Error(`suite 1: raw key for epoch ${of} is no longer retained`);
			const key = by === null ? await kek(rk) : await subkey(by, "wrap");
			return gcmSeal(subtle, key, nonce(), aad, raw);
		},
		async unwrap(role, e, aad, wrapped, rk) {
			if (!Number.isSafeInteger(e) || e < 1 || (role === "prev" && e < 2) || wrapped.length !== WRAP_BYTES) return false;
			const { by, of } = wrapEpochs(role, e);
			if (by === null ? !rk || rk.length < KEY_BYTES : !keys.has(by)) return false;
			const r = await gcmOpen(subtle, by === null ? await kek(rk) : await subkey(by, "wrap"), aad, wrapped);
			if (typeof r === "string" || r.length !== KEY_BYTES) return false;
			// A held key is never replaced: the payload must be that same key (§11.3 prevWrap rule).
			if (keys.has(of)) return sameAsHeld(of, r);
			await put(of, r, { pending: false, exported: false });
			return true;
		},
		markVerified(e) {
			entry(e).verified = true;
		},
		setSealEpoch(e) {
			const k = entry(e);
			if (!k.verified) throw new Error(`suite 1: seal epoch ${e} is not verified`);
			if (e < sealEpoch) throw new Error(`suite 1: seal epoch cannot go back from ${sealEpoch} to ${e}`);
			sealEpoch = e;
			k.pending = false;
			trim();
		},
		drop(e) {
			if (e === sealEpoch) throw new Error("suite 1: cannot drop the seal epoch");
			keys.get(e)?.raw?.fill(0);
			keys.delete(e);
		},
		exportForHost() {
			const out: { e: number; k: Uint8Array }[] = [];
			for (const e of [...keys.keys()].sort((a, b) => a - b)) {
				const k = keys.get(e)!;
				// Never an unverified key from install/unwrap (§12.4 (i)): only verified keys and this device's pending ones.
				if (k.exported || !k.raw || !(k.verified || k.pending)) continue;
				out.push({ e, k: k.raw.slice() });
				k.exported = true;
			}
			trim();
			return out;
		},
	};
}
