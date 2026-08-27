import { canonicalizeVaultPath } from "../paths/canonicalPath";

function alwaysExcludedPrefixes(configDir: string): string[] {
	const normalizedConfigDir = canonicalizeVaultPath(configDir).normalizedPath.replace(/\/$/, "");
	return [
		`${normalizedConfigDir}/`,
		".trash/",
	];
}

/**
 * Check if a vault-relative path should be excluded from sync.
 * Always excludes the current config directory and .trash/, plus any
 * user-configured prefixes.
 *
 * @param path - Vault-relative path (e.g. "templates/daily.md")
 * @param patterns - Parsed exclude prefixes (e.g. ["templates/", ".trash/"])
 * @param configDir - Obsidian config directory name
 * @returns true if the path matches any exclude pattern
 */
export function isExcluded(path: string, patterns: string[], configDir: string): boolean {
	const normalizedPath = canonicalizeVaultPath(path).normalizedPath;
	for (const prefix of alwaysExcludedPrefixes(configDir)) {
		if (normalizedPath.startsWith(prefix)) return true;
	}
	for (const prefix of patterns) {
		if (normalizedPath.startsWith(canonicalizeVaultPath(prefix).normalizedPath)) return true;
	}
	return false;
}

/**
 * Parse the comma-separated excludePatterns setting into a list of
 * trimmed, non-empty prefixes.
 */
export function parseExcludePatterns(raw: string): string[] {
	return raw
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}
