/**
 * witnessStateHash — shared hash helper for Layer 4 Phase 2
 *
 * Extracted from deviceWitnessTracker.ts so that recovery.decision emission
 * and the witness tracker call the same function (Requirement 10.3).
 *
 * Hash construction: session-salted SHA-256 pseudonym (not HMAC).
 *   SHA-256(secret || "\0yaos-state-v1\0" || normalizedContent)
 *
 * Normalization (Requirement 4.1):
 *   1. Unicode NFC normalization
 *   2. Line-ending normalization to \n
 *   No trimming of trailing newlines, leading whitespace, or BOM.
 *
 * Output prefix: "h:" so callers can detect witness-domain values (Req 11.4).
 */

export const STATE_DOMAIN_SEP = "\0yaos-state-v1\0";

/**
 * Normalize content for hashing: NFC then \n line endings.
 * Does NOT trim trailing newlines or leading whitespace.
 */
export function normalizeContent(content: string): string {
	// NFC normalization
	const nfc = content.normalize("NFC");
	// Line-ending normalization: \r\n → \n, then lone \r → \n
	return nfc.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Compute a witness-domain stateHash for present-state content.
 * Returns "h:<32-hex-chars>" or null if crypto is unavailable.
 */
export async function computeWitnessStateHash(
	secret: string,
	content: string,
): Promise<string | null> {
	try {
		const normalized = normalizeContent(content);
		const input = `${secret}${STATE_DOMAIN_SEP}${normalized}`;
		const bytes = new TextEncoder().encode(input);
		const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
		const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
		return `h:${hex.slice(0, 32)}`;
	} catch {
		return null;
	}
}

/**
 * Compute a witness-domain stateHash for deleted-state (domain-separated).
 * Input domain: secret || "\0yaos-state-v1\0deleted\0" || fileId
 * This can never collide with a present-state hash (Requirement 4.4).
 */
export async function computeDeletedWitnessStateHash(
	secret: string,
	fileId: string,
): Promise<string | null> {
	try {
		const input = `${secret}${STATE_DOMAIN_SEP}deleted\0${fileId}`;
		const bytes = new TextEncoder().encode(input);
		const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
		const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
		return `h:${hex.slice(0, 32)}`;
	} catch {
		return null;
	}
}
