/**
 * Disk index: tracks {mtime, size, contentHash} per file path for efficient
 * reconciliation. Only files whose stat changed since last reconcile
 * need to be read from disk.
 *
 * Persisted as JSON via plugin's loadData/saveData under the key
 * "_diskIndex" in the plugin's data.json.
 */
import { type App, TFile, normalizePath } from "obsidian";
import { mapWithConcurrency } from "../utils/concurrency";

const DEFAULT_STAT_CONCURRENCY = 16;

/**
 * Cheap FNV-1a-ish 32-bit fingerprint for diagnostics and loop detection.
 *
 * Use ONLY for:
 *   - recovery-loop deduplication (recoverySignature)
 *   - conflict-artifact dedupe keys
 *   - diagnostics bucketing
 *
 * Do NOT use for three-way authority decisions (baseline vs disk vs CRDT).
 * For that, use contentBaselineHash() which is collision-resistant.
 *
 * False collisions are tolerable here: the worst case is a missed quarantine
 * entry or a duplicate conflict artifact, not data corruption.
 */
export function contentFingerprint(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h.toString(16).padStart(8, "0") + ":" + text.length;
}

/**
 * SHA-256 content hash for three-way authority decisions.
 *
 * Used as the baseline in startup/re-enable reconciliation:
 *
 *   disk == baseline, crdt != baseline → apply-remote-to-disk (crdt wins cleanly)
 *   crdt == baseline, disk != baseline → import-disk-to-crdt  (disk wins cleanly)
 *   both != baseline                  → preserve-conflict/both-changed
 *   baseline null (first run)         → preserve-conflict/missing-baseline (safe fallback)
 *
 * Collisions must be practically impossible — a false equality could cause
 * YAOS to decide "disk unchanged" and overwrite a local edit without conflict
 * preservation, resulting in silent data loss.
 *
 * Implementation: Web Crypto API (`globalThis.crypto.subtle`).
 * This is the same path used by blobSync, diskMirror.fingerprintContent, and
 * indexedDbCandidateStore.sha256Hex — proven to work on iOS, Android, and desktop.
 * Does NOT use Node's `crypto` module, which is unavailable in mobile WebViews.
 */
export async function contentBaselineHash(content: string): Promise<string> {
	const bytes = new TextEncoder().encode(content);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface DiskIndexEntry {
	/** Last known mtime in ms. */
	mtime: number;
	/** Last known file size in bytes. */
	size: number;
	/**
	 * SHA-256 hash of the file content at last clean settlement.
	 *
	 * Persisted across plugin unload/reload to serve as the three-way baseline
	 * in startup reconciliation. Only set via contentBaselineHash().
	 *
	 * Absence (undefined) means the baseline is unknown for this file —
	 * reconciliation falls back to the safe preserve-conflict/missing-baseline path.
	 */
	contentHash?: string;
}

export type DiskIndex = Record<string, DiskIndexEntry>;

/**
 * Stat a file using Obsidian's adapter.
 * Returns null if stat fails (file doesn't exist, adapter quirk).
 */
async function statFile(
	app: App,
	path: string,
): Promise<{ mtime: number; size: number } | null> {
	try {
		const stat = await app.vault.adapter.stat(normalizePath(path));
		if (!stat) return null;
		return { mtime: stat.mtime, size: stat.size };
	} catch {
		return null;
	}
}

/**
 * Check if a file has changed since the last indexed stat.
 * Uses (mtime OR size) changed as the trigger — either changing
 * means we should read the file.
 */
export function hasChanged(
	entry: DiskIndexEntry | undefined,
	stat: { mtime: number; size: number },
): boolean {
	if (!entry) return true; // never seen before
	return entry.mtime !== stat.mtime || entry.size !== stat.size;
}

/**
 * Build a filtered list of files that need reading during reconciliation.
 *
 * Returns:
 *   - changed: files whose stat differs from index (need vault.read())
 *   - unchanged: files whose stat matches index (skip read)
 *   - allStats: fresh stat map for updating the index after reconcile
 */
export async function filterChangedFiles(
	app: App,
	mdFiles: TFile[],
	index: DiskIndex,
): Promise<{
	changed: TFile[];
	unchanged: TFile[];
	allStats: Map<string, { mtime: number; size: number }>;
}> {
	const changed: TFile[] = [];
	const unchanged: TFile[] = [];
	const allStats = new Map<string, { mtime: number; size: number }>();

	const statResults = await mapWithConcurrency(
		mdFiles,
		DEFAULT_STAT_CONCURRENCY,
		async (file) => ({ file, stat: await statFile(app, file.path) }),
	);

	for (const { file, stat } of statResults) {
		if (!stat) {
			// Can't stat — treat as changed (fall back to read)
			changed.push(file);
			continue;
		}

		allStats.set(file.path, stat);

		if (hasChanged(index[file.path], stat)) {
			changed.push(file);
		} else {
			unchanged.push(file);
		}
	}

	return { changed, unchanged, allStats };
}

/**
 * Collect file stats with bounded concurrency.
 * Files that fail stat are omitted from the returned map.
 */
export async function collectFileStats(
	app: App,
	files: TFile[],
	concurrency = DEFAULT_STAT_CONCURRENCY,
): Promise<Map<string, { mtime: number; size: number }>> {
	const stats = await mapWithConcurrency(
		files,
		concurrency,
		async (file) => ({ file, stat: await statFile(app, file.path) }),
	);

	const out = new Map<string, { mtime: number; size: number }>();
	for (const { file, stat } of stats) {
		if (stat) {
			out.set(file.path, stat);
		}
	}
	return out;
}

/**
 * Update the disk index with fresh stats after a successful reconcile.
 *
 * @param settledHashes - Content fingerprints for files that were cleanly
 *   settled this reconcile (no conflict, authority is certain). These become
 *   the baseline for the next startup reconcile.
 *   - If a path is in settledHashes: store that hash.
 *   - If a path's stat is unchanged from the old index: carry the old hash.
 *   - If a path's stat changed but no settled hash: clear the hash (stale).
 */
export function updateIndex(
	index: DiskIndex,
	allStats: Map<string, { mtime: number; size: number }>,
	options: { excludePaths?: Iterable<string>; settledHashes?: Map<string, string> } = {},
): DiskIndex {
	const excluded = new Set(options.excludePaths ?? []);
	const newIndex: DiskIndex = {};

	for (const [path, stat] of allStats) {
		if (excluded.has(path)) {
			continue;
		}
		const oldEntry = index[path];
		const settledHash = options.settledHashes?.get(path);

		// Determine content hash for this entry:
		// 1. If a settled hash was recorded for this reconcile, use it.
		// 2. Else if the stat is unchanged from before, the old hash is still valid.
		// 3. Else (stat changed, no new settled hash): clear hash — it's stale.
		let contentHash: string | undefined;
		if (settledHash !== undefined) {
			contentHash = settledHash;
		} else if (
			oldEntry !== undefined &&
			oldEntry.mtime === stat.mtime &&
			oldEntry.size === stat.size
		) {
			contentHash = oldEntry.contentHash;
		}
		// else: stat changed without a settled hash → omit contentHash

		newIndex[path] = {
			mtime: stat.mtime,
			size: stat.size,
			...(contentHash !== undefined && { contentHash }),
		};
	}

	return newIndex;
}

/**
 * Move index entries during a rename batch.
 * For each oldPath → newPath, copy the entry and delete the old one.
 */
export function moveIndexEntries(
	index: DiskIndex,
	renames: Map<string, string>,
): void {
	for (const [oldPath, newPath] of renames) {
		const entry = index[oldPath];
		if (entry) {
			index[newPath] = entry;
			delete index[oldPath];
		}
	}
}

/**
 * Give a newly created file a short quiet window before we act on it.
 * Checks stat at intervals and returns early once two consecutive samples match.
 *
 * Returns true if the file went quiet or remained present through the sampling
 * budget. Returns false only if the file disappeared while waiting.
 */
export async function waitForDiskQuiet(
	app: App,
	path: string,
	checks = 3,
	delayMs = 400,
): Promise<boolean> {
	let last: { mtime: number; size: number } | null = null;

	for (let i = 0; i < checks; i++) {
		const stat = await statFile(app, path);
		if (!stat) return false; // file gone

		if (last && last.mtime === stat.mtime && last.size === stat.size) {
			return true; // stable for at least one interval
		}

		last = stat;

		if (i < checks - 1) {
			await new Promise((r) => setTimeout(r, delayMs));
		}
	}

	// If the file never fully quieted during the budget, continue anyway as long
	// as it still exists. This is a bounded delay, not a hard stability proof.
	return last !== null;
}
