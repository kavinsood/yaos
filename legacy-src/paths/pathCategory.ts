/**
 * Path category classification — the single place that determines whether
 * a vault path is markdown, blob, or excluded.
 *
 * Delegates to existing product policy (isExcluded, extension checks) but
 * operates on canonicalized paths to ensure NFC/NFD-equivalent paths get
 * the same category.
 *
 * IMPORTANT: classifySyncPath uses the same logic as the existing
 * isMarkdownSyncable/isBlobSyncable functions. It does not invent new
 * blob eligibility rules.
 */

import { canonicalizeVaultPath, type CanonicalPath } from "./canonicalPath";
import { isExcluded } from "../sync/exclude";

export type PathSyncCategory =
	| { kind: "markdown"; path: CanonicalPath }
	| { kind: "blob"; path: CanonicalPath }
	| { kind: "excluded"; path: CanonicalPath; reason: string };

/**
 * Classify a vault-relative path into its sync category.
 *
 * Uses the same rules as existing isMarkdownSyncable / isBlobSyncable:
 *   1. Excluded paths (config dir, .trash, user patterns) are always excluded.
 *   2. .md files that are not excluded are markdown.
 *   3. Non-.md files that are not excluded are blob.
 *
 * This matches the existing isBlobSyncable contract:
 *   isBlobSyncable = !path.endsWith(".md") && !isExcluded(...)
 */
export function classifySyncPath(input: {
	path: string;
	excludePatterns: readonly string[];
	configDir: string;
}): PathSyncCategory {
	const canonical = canonicalizeVaultPath(input.path);

	// Exclusion check uses normalizedPath (NFC + separator-cleaned).
	// isExcluded already does its own prefix normalization internally,
	// but we pass the cleaned form for consistency.
	if (isExcluded(canonical.normalizedPath, [...input.excludePatterns], input.configDir)) {
		return { kind: "excluded", path: canonical, reason: "excluded-by-pattern" };
	}

	// Extension check on normalized path (same as isMarkdownSyncable).
	if (canonical.normalizedPath.endsWith(".md")) {
		return { kind: "markdown", path: canonical };
	}

	// Non-.md, non-excluded = blob-syncable.
	// This is the same contract as isBlobSyncable in src/types.ts:
	//   if (path.endsWith(".md")) return false;
	//   return !isExcluded(path, excludePatterns, configDir);
	return { kind: "blob", path: canonical };
}
