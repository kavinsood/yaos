/**
 * Path redaction for safe-mode diagnostics export (INV-SEC-02).
 *
 * Default diagnostics must not include vault filenames. The redactor walks
 * a JSON-able object tree and replaces path-shaped strings with stable,
 * per-bundle salted hashes. Within a single bundle, identical paths
 * produce identical hashes so that events, hashDiff entries, and
 * structural snapshots can still be correlated. Across bundles, the salt
 * is fresh — hashes do not match, so an attacker collecting multiple
 * bundles cannot enumerate paths by intersection.
 *
 * The salt itself is never written to the output bundle.
 *
 * This module is intentionally pure and Obsidian-free so it can be tested
 * directly under Node.
 */

/**
 * Extensions that the redactor recognises as path-shaped string suffixes.
 * Order does not matter; the regex below is built from this list. New
 * blob/text formats added to YAOS routing should be added here so they
 * are caught by the in-text scanner.
 */
const PATH_EXTENSIONS = [
	"md",
	"canvas",
	"excalidraw",
	"base",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"pdf",
	"mp3",
	"mp4",
	"mov",
	"webm",
	"wav",
	"ogg",
	"zip",
	"json",
	"txt",
	"csv",
	"bmp",
	"ico",
] as const;

/**
 * Regex matching a vault-relative path. Matches:
 *   - foo.md
 *   - Folder/Subfolder/note.canvas
 *   - leading/path with hyphens, dots, spaces, parentheses, unicode word chars
 *
 * Designed to be greedy enough to catch real vault paths embedded in free
 * form log messages, but conservative enough to avoid eating ordinary
 * prose. Boundaries: not preceded by `://` (URLs) and not preceded by a
 * word char beyond a separator.
 */
/**
 * Path detection regex for free-form text.
 *
 * The codebase formats paths in log/trace messages as `"${path}"` — every
 * path-emitting site in `src/sync/*` and `src/runtime/*` follows this
 * convention. Anchoring the regex to the surrounding quotes eliminates the
 * false-positive class where greedy regex matching absorbs ordinary prose
 * (e.g. "for Inbox/note.md" matching as a whole). The match captures the
 * inner path only; the outer quotes are matched but not captured as part
 * of group 1.
 *
 * Paths that surface in free-form text WITHOUT surrounding quotes are not
 * caught here. Those paths must reach the redactor through structural
 * fields (handled by KNOWN_PATH_KEYS / KNOWN_PATH_LIST_KEYS) or by being
 * seeded via createPathRedactor's `knownPaths` option (which puts them in
 * the cache for direct redactPath calls).
 */
const PATH_REGEX = new RegExp(
	String.raw`"([^"\n]+\.(?:` +
	PATH_EXTENSIONS.join("|") +
	String.raw`))"`,
	"g",
);

export type Sha256Hex = (text: string) => Promise<string>;

export interface PathRedactor {
	readonly salt: string;
	readonly active: boolean;
	redactPath(path: string): string;
	redactInText(text: string): string;
	redactDeep<T>(value: T): T;
}

const REDACTION_PREFIX = "path:";
const HASH_PREFIX_LENGTH = 16;
const HASH_SEPARATOR = "\u0000";

interface CreateOptions {
	/** Pre-known paths to seed the cache with (e.g. active CRDT/disk paths). */
	knownPaths?: Iterable<string>;
}

/**
 * Build a fresh redactor for a single bundle. The caller is responsible
 * for keeping the salt local — it must NOT appear in the bundle output.
 *
 * `redactPath` is async-prepared: the redactor caches a lazily-computed
 * hash for each path. To make `redactDeep` synchronous (which keeps the
 * bundle assembly simple), the caller must call `prime(paths)` first to
 * populate the cache for any path that is known up-front. Paths
 * encountered later via `redactInText` that are not yet cached fall back
 * to a synchronous-but-non-cryptographic hash that is stable in-bundle —
 * see `fallbackHash` below.
 */
export async function createPathRedactor(
	salt: string,
	sha256: Sha256Hex,
	options: CreateOptions = {},
): Promise<PathRedactor> {
	const cache = new Map<string, string>();

	async function compute(path: string): Promise<string> {
		const digest = await sha256(`${salt}${HASH_SEPARATOR}${path}`);
		return `${REDACTION_PREFIX}${digest.slice(0, HASH_PREFIX_LENGTH)}`;
	}

	if (options.knownPaths) {
		for (const path of options.knownPaths) {
			if (typeof path === "string" && path.length > 0 && !cache.has(path)) {
				cache.set(path, await compute(path));
			}
		}
	}

	function fallbackHash(path: string): string {
		// Deterministic FNV-1a-like 32-bit hash, base16. Used only when a
		// path-shaped string surfaces during deep walk that wasn't seeded
		// by the caller (e.g. inside a free-form log message). It is
		// non-cryptographic by design — the salt-derived hash from
		// compute() is the security boundary; this fallback exists only
		// to keep redactDeep synchronous. Two strings that hash
		// identically here would be very unusual collisions inside one
		// bundle. Cross-bundle linkage via this fallback is prevented by
		// folding the salt into the seed.
		let h = 0x811c9dc5;
		const seed = `${salt}${HASH_SEPARATOR}${path}`;
		for (let i = 0; i < seed.length; i++) {
			h ^= seed.charCodeAt(i);
			h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
		}
		const hex = h.toString(16).padStart(8, "0");
		return `${REDACTION_PREFIX}${hex}`;
	}

	function redactPath(path: string): string {
		if (typeof path !== "string" || path.length === 0) return path;
		const cached = cache.get(path);
		if (cached) return cached;
		const tag = fallbackHash(path);
		cache.set(path, tag);
		return tag;
	}

	function redactInText(text: string): string {
		if (typeof text !== "string" || text.length === 0) return text;
		// Pass 1: exact replacement for all cached (known) paths, sorted
		// longest-first to prevent shorter prefix paths from leaving partial
		// fragments. Catches known paths even when unquoted.
		let result = text;
		const sortedKeys = [...cache.keys()].sort((a, b) => b.length - a.length);
		for (const path of sortedKeys) {
			if (result.includes(path)) {
				result = result.split(path).join(cache.get(path) ?? "");
			}
		}
		// Pass 2: regex scan for quoted path-shaped strings not yet in cache
		// (unseeded paths from free-form log messages).
		return result.replace(PATH_REGEX, (_match, inner: string) => `"${redactPath(inner)}"`);
	}

	function redactDeep<T>(value: T): T {
		return walk(value) as T;
	}

	function walk(value: unknown): unknown {
		if (value === null) return null;
		if (typeof value === "string") return redactInText(value);
		if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
			return value;
		}
		if (Array.isArray(value)) {
			return value.map((item) => walk(item));
		}
		if (typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
				if (KNOWN_PATH_KEYS.has(key) && typeof nested === "string") {
					out[key] = redactPath(nested);
				} else if (KNOWN_PATH_LIST_KEYS.has(key) && Array.isArray(nested)) {
					out[key] = nested.map((item) =>
						typeof item === "string" ? redactPath(item) : walk(item),
					);
				} else {
					out[key] = walk(nested);
				}
			}
			return out;
		}
		return value;
	}

	return { salt, active: true, redactPath, redactInText, redactDeep };
}

/**
 * Object keys whose string value is always a vault path. The deep walker
 * unconditionally redacts these without consulting the regex.
 */
const KNOWN_PATH_KEYS: ReadonlySet<string> = new Set([
	"path",
	"oldPath",
	"newPath",
	"filePath",
	"sourcePath",
	"destPath",
	"targetPath",
	"resolvedPath",
	"pendingOldPath",
	"pendingNewPath",
	"conflictPath",
	"normalizedPath",
]);

/**
 * Object keys whose value is always an array of vault paths. The deep
 * walker maps each entry through redactPath without descending into the
 * string content.
 */
const KNOWN_PATH_LIST_KEYS: ReadonlySet<string> = new Set([
	"missingOnDisk",
	"missingInCrdt",
	"paths",
	"affectedPaths",
	"affectedPathSample",
	"createdPathSample",
	"blockedUpdatePathSample",
	"blockedPathSample",
	"pathSample",
	"openPaths",
]);

/**
 * Identity redactor — safe to use when the caller has explicitly opted
 * into filename inclusion (the with-filenames export action). All
 * methods return inputs unchanged. `active` is false so callers can
 * branch on whether redaction is in effect.
 */
export function createPassthroughRedactor(): PathRedactor {
	return {
		salt: "",
		active: false,
		redactPath: (path) => path,
		redactInText: (text) => text,
		redactDeep: <T>(value: T): T => value,
	};
}

/**
 * Generate a random salt for one diagnostics bundle. The output is a
 * lowercase hex string; the caller controls how it is used (typically
 * passed to `createPathRedactor`). The salt is NOT included in the
 * bundle.
 */
export function generateBundleSalt(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Exposed for tests: the regex used to detect path-shaped substrings.
 */
export const __TEST_PATH_REGEX = PATH_REGEX;
export const __TEST_PATH_EXTENSIONS = PATH_EXTENSIONS;
