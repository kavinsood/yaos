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
