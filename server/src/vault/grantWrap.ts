// Identity-per-store §3.4 grant rotation: the secret a rotation mints is kept wrapped, so a live device of the grant can
// fetch it with its own token (`GET /vault/:id/auth/grant`) and the install rewrites data.json without a re-pair.
//
// The wrapping key is HKDF-SHA-256 of the vault's ticket key (vault_meta, never leaves the DO and never rotates, D4)
// with a purpose label of its own, so it never doubles as the ticket HMAC key. AES-GCM, a random 12-byte IV, the AAD
// binds the vaultId and the grantId: a wrap copied onto another grant or vault does not open. Stored as IV || ciphertext.
// What it protects: the grant rows also travel in the D8b restore journal (config DO, which has no ticket key); a
// dump of the vault DO's own storage holds both, as it holds every other credential hash.
import { GRANT_SECRET_PATTERN } from "./pairing";

const WRAP_INFO = new TextEncoder().encode("yaos grant secret wrap v1");
const IV_BYTES = 12;

async function wrapKey(ticketKey: Uint8Array): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", ticketKey, "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: WRAP_INFO }, base,
		{ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function aad(vaultId: string, grantId: string): Uint8Array {
	return new TextEncoder().encode(`${vaultId}\u0000${grantId}`);
}

/** IV || AES-GCM(secret) under the ticket key's wrap key. */
export async function wrapGrantSecret(ticketKey: Uint8Array, vaultId: string, grantId: string, secret: string):
	Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(vaultId, grantId) },
		await wrapKey(ticketKey), new TextEncoder().encode(secret)));
	const out = new Uint8Array(IV_BYTES + sealed.length);
	out.set(iv);
	out.set(sealed, IV_BYTES);
	return out;
}

/** The wrapped secret, or null when it does not open (another vault, another grant, damaged). */
export async function unwrapGrantSecret(ticketKey: Uint8Array, vaultId: string, grantId: string, wrapped: Uint8Array):
	Promise<string | null> {
	if (wrapped.length <= IV_BYTES) return null;
	try {
		const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrapped.slice(0, IV_BYTES),
			additionalData: aad(vaultId, grantId) }, await wrapKey(ticketKey), wrapped.slice(IV_BYTES));
		const secret = new TextDecoder().decode(plain);
		return GRANT_SECRET_PATTERN.test(secret) ? secret : null;
	} catch {
		return null;
	}
}
