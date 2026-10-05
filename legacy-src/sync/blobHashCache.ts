/**
 * Blob hash cache: tracks {mtime, size, hash} per blob file path.
 *
 * Avoids rehashing unchanged blob files during reconciliation and
 * upload/download processing. The cache is checked before reading
 * file bytes — if mtime+size match the cached entry, the stored
 * hash is reused.
 *
 * Persisted as JSON via plugin's loadData/saveData under the key
 * "_blobHashCache" in the plugin's data.json.
 */

export interface BlobHashEntry {
	/** Last known mtime in ms. */
	mtime: number;
	/** Last known file size in bytes. */
	size: number;
	/** SHA-256 hex hash of file contents at the recorded mtime+size. */
	hash: string;
}

export type BlobHashCache = Record<string, BlobHashEntry>;

/**
 * Look up a cached hash for a file. Returns the hash if the file's
 * current stat matches the cached entry, otherwise null.
 */
export function getCachedHash(
	cache: BlobHashCache,
	path: string,
	stat: { mtime: number; size: number },
): string | null {
	const entry = cache[path];
	if (!entry) return null;
	if (entry.mtime === stat.mtime && entry.size === stat.size) {
		return entry.hash;
	}
	return null;
}

/**
 * Store a hash in the cache after computing it.
 */
export function setCachedHash(
	cache: BlobHashCache,
	path: string,
	stat: { mtime: number; size: number },
	hash: string,
): void {
	cache[path] = { mtime: stat.mtime, size: stat.size, hash };
}

/**
 * Remove an entry from the cache (e.g. on file delete).
 */
export function removeCachedHash(cache: BlobHashCache, path: string): void {
	delete cache[path];
}

/**
 * Move cache entries during a rename batch.
 */
export function moveCachedHashes(
	cache: BlobHashCache,
	renames: Map<string, string>,
): void {
	for (const [oldPath, newPath] of renames) {
		const entry = cache[oldPath];
		if (entry) {
			cache[newPath] = entry;
			delete cache[oldPath];
		}
	}
}
