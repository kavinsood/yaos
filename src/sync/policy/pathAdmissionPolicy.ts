/**
 * Path admission policy — decides whether a vault-relative path is
 * eligible for sync, and why if not.
 *
 * Uses canonical path identity for normalization. Two paths that differ
 * only in NFC/NFD or separator style will produce the same admission result.
 *
 * For new code, prefer classifySyncPath (src/paths/pathCategory.ts) which
 * returns a typed PathSyncCategory including the canonical path. These
 * legacy functions remain for callers that haven't migrated yet.
 */

import { isExcluded } from "../exclude";
import { canonicalizeVaultPath } from "../../paths/canonicalPath";

export type PathAdmission =
	| { kind: "syncable"; path: string }
	| { kind: "excluded"; path: string; reason: string };

/**
 * Decide if a markdown path is admissible for sync.
 * Normalizes the path before checking (NFC + separators).
 */
export function admitMarkdownPath(
	path: string,
	excludePatterns: string[],
	configDir: string,
): PathAdmission {
	const canonical = canonicalizeVaultPath(path);
	if (!canonical.normalizedPath.endsWith(".md")) {
		return { kind: "excluded", path, reason: "not-markdown" };
	}
	if (isExcluded(canonical.normalizedPath, excludePatterns, configDir)) {
		return { kind: "excluded", path, reason: "excluded-by-pattern" };
	}
	return { kind: "syncable", path };
}
