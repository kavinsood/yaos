/**
 * Canonical path identity — the single owner of "what is a path" in this repo.
 *
 * Every subsystem that needs to compare, store, or key by vault path should
 * go through this module. Ad hoc normalization outside this module is tech debt.
 *
 * Current normalization:
 *   - Backslashes → forward slashes
 *   - Collapse multiple slashes
 *   - Strip repeated leading "./"
 *   - Strip leading "/"
 *   - Unicode NFC normalization
 *
 * NOT included in this phase:
 *   - Case folding (platform-dependent product decision, deferred)
 *   - Trailing slash behavior (vault paths are files, not dirs)
 */

export interface CanonicalPath {
	/** The original input path, preserved exactly as received. */
	readonly displayPath: string;
	/** Separator-normalized + NFC-normalized path. For identity comparison. */
	readonly normalizedPath: string;
	/** The identity key. Two paths with the same canonicalKey are the same file. */
	readonly canonicalKey: string;
}

/**
 * Canonicalize a vault-relative path.
 *
 * The canonicalKey is the NFC-normalized, separator-cleaned path.
 * Two paths that differ only in Unicode normalization form (NFC vs NFD)
 * or separator style will produce the same canonicalKey.
 *
 * IMPORTANT: displayPath is preserved for execution APIs. Until the full
 * storage/mutation layer is migrated, existing APIs (queueRename, handleDelete,
 * etc.) expect the original runtime path, not the normalized form.
 */
export function canonicalizeVaultPath(input: string): CanonicalPath {
	const cleaned = input
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\/+/, "")
		.replace(/^(\.\/)+/, "");

	const normalizedPath = cleaned.normalize("NFC");

	return {
		displayPath: input,
		normalizedPath,
		canonicalKey: normalizedPath,
	};
}
