export const MIN_VAULT_ID_LENGTH = 8;
export const MAX_VAULT_ID_LENGTH = 256;

export function isCanonicalVaultId(value: unknown): value is string {
	if (
		typeof value !== "string"
		|| value.length < MIN_VAULT_ID_LENGTH
		|| value.length > MAX_VAULT_ID_LENGTH
		|| value !== value.trim()
	) return false;
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x20 || code === 0x7f || "\\/?#".includes(character)) return false;
	}
	return true;
}

/** Decode one URL path segment and reject alternate encodings of the same ID. */
export function decodeCanonicalVaultIdSegment(segment: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		return null;
	}
	if (!isCanonicalVaultId(decoded) || encodeURIComponent(decoded) !== segment) return null;
	return decoded;
}

/** DECISIONS §2.1: a vaultId is base64url(16 random bytes), exactly 22 characters. */
export const VAULT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function isVaultId(value: unknown): value is string {
	return typeof value === "string" && VAULT_ID_PATTERN.test(value);
}
