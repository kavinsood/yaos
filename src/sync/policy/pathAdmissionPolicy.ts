/**
 * Path admission policy — decides whether a vault-relative path is
 * eligible for sync, and why if not.
 *
 * This is the canonical decision point for path syncability. All code
 * that needs to know "is this path in scope for sync?" should go through
 * this module or its output types.
 */

import { isExcluded } from "../exclude";

export type PathAdmission =
	| { kind: "syncable"; path: string }
	| { kind: "excluded"; path: string; reason: string };

/**
 * Decide if a markdown path is admissible for sync.
 */
export function admitMarkdownPath(
	path: string,
	excludePatterns: string[],
	configDir: string,
): PathAdmission {
	if (!path.endsWith(".md")) {
		return { kind: "excluded", path, reason: "not-markdown" };
	}
	if (isExcluded(path, excludePatterns, configDir)) {
		return { kind: "excluded", path, reason: "excluded-by-pattern" };
	}
	return { kind: "syncable", path };
}

/**
 * Decide if a blob (non-markdown) path is admissible for sync.
 */
export function admitBlobPath(
	path: string,
	excludePatterns: string[],
	configDir: string,
): PathAdmission {
	if (path.endsWith(".md")) {
		return { kind: "excluded", path, reason: "is-markdown" };
	}
	if (isExcluded(path, excludePatterns, configDir)) {
		return { kind: "excluded", path, reason: "excluded-by-pattern" };
	}
	return { kind: "syncable", path };
}
