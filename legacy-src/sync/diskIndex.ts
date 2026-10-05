/**
 * Disk index: tracks {mtime, size, contentHash} per file path for efficient
 * reconciliation. Only files whose stat changed since last reconcile
 * need to be read from disk.
 *
 * Persisted as JSON via plugin's loadData/saveData under the key
 * "_diskIndex" in the plugin's data.json.
 */
import { type App, TFile, normalizePath } from "obsidian";
import { mapWithConcurrency } from "@shared/concurrency";
import {
	MARKDOWN_CANONICAL_VERSION,
	canonicalMarkdownHash,
	canonicalizeMarkdown,
	type MarkdownCanonicalVersion,
} from "@shared/markdownCodec";
import { fnv1a32, toHex8 } from "../utils/fnv1a";

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
	const canonical = canonicalizeMarkdown(text);
	return `${toHex8(fnv1a32(canonical))}:${canonical.length}`;
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
 * Implementation: shared Web Crypto utility, which works on iOS, Android, and
 * desktop without Node's unavailable `crypto` module.
 */
export function contentBaselineHash(content: string): Promise<string> {
	return canonicalMarkdownHash(content);
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
	/** Representation contract under which contentHash was computed. */
	contentHashVersion?: MarkdownCanonicalVersion;
	/** Whole-file authority is absent while only the Markdown body is settled. */
	settlementKind?: "whole" | "body-only";
	bodyContentHash?: string;
	propertiesContentHash?: string;
	/**
	 * Identity of the local state (IndexedDB incarnation, which is itself
	 * scoped to vault ID + vault generation + folder) under which this
	 * baseline was established. The disk index lives in data.json and
	 * survives IndexedDB loss, reset, or re-enrollment into another vault; a
	 * baseline from another incarnation may describe content that was never
	 * durably committed there and must not prove "disk carries no local edit".
	 * Absent on legacy entries: such a baseline is untrusted for that proof.
	 */
	baselineScope?: string;
}

export type DiskIndex = Record<string, DiskIndexEntry>;

export function currentContentHash(entry: DiskIndexEntry | undefined): string | undefined {
	return entry?.settlementKind !== "body-only"
		&& entry?.contentHashVersion === MARKDOWN_CANONICAL_VERSION
		? entry.contentHash
		: undefined;
}

export function setCurrentContentHash(entry: DiskIndexEntry, contentHash: string, baselineScope?: string): void {
	entry.contentHash = contentHash;
	entry.contentHashVersion = MARKDOWN_CANONICAL_VERSION;
	entry.settlementKind = "whole";
	delete entry.bodyContentHash;
	delete entry.propertiesContentHash;
	if (baselineScope) entry.baselineScope = baselineScope;
	else delete entry.baselineScope;
}

export function setPartialContentHashes(
	entry: DiskIndexEntry,
	bodyContentHash: string,
	propertiesContentHash: string,
	baselineScope?: string,
): void {
	delete entry.contentHash;
	delete entry.contentHashVersion;
	entry.settlementKind = "body-only";
	entry.bodyContentHash = bodyContentHash;
	entry.propertiesContentHash = propertiesContentHash;
	if (baselineScope) entry.baselineScope = baselineScope;
	else delete entry.baselineScope;
}

/**
 * Whether a baseline may prove anything about the current local state.
 * `scope === undefined` means the host does not scope baselines (the CLI
 * persists its index inside its own database, gated on no pending work);
 * `null` means the local identity is not known yet, so nothing is trusted.
 */
export function isBaselineTrusted(entry: DiskIndexEntry | undefined, scope: string | null | undefined): boolean {
	if (!entry) return false;
	if (scope === undefined) return true;
	return scope !== null && entry.baselineScope === scope;
}

/** `currentContentHash`, restricted to baselines established under `scope`. */
export function trustedContentHash(
	entry: DiskIndexEntry | undefined,
	scope: string | null | undefined,
): string | undefined {
	return isBaselineTrusted(entry, scope) ? currentContentHash(entry) : undefined;
}

/**
 * Drop every content baseline (keeping stats, which only admit scans). Used
 * when the persisted index is known to belong to another local incarnation:
 * its hashes may name content that was never committed here.
 */
export function discardContentBaselines(index: DiskIndex): number {
	let discarded = 0;
	for (const entry of Object.values(index)) {
		if (entry.contentHash === undefined && entry.bodyContentHash === undefined) continue;
		delete entry.contentHash;
		delete entry.contentHashVersion;
		delete entry.settlementKind;
		delete entry.bodyContentHash;
		delete entry.propertiesContentHash;
		delete entry.baselineScope;
		discarded++;
	}
	return discarded;
}

/**
 * Bind legacy (unscoped) baselines to `scope`. Only for the incarnation
 * they were written under: a database that already held this vault's
 * synced state when its identity was first created (the upgrade path).
 * Entries scoped to another incarnation are left untrusted.
 */
export function adoptUnscopedBaselines(index: DiskIndex, scope: string): number {
	let adopted = 0;
	for (const entry of Object.values(index)) {
		if (entry.baselineScope !== undefined) continue;
		if (entry.contentHash === undefined && entry.bodyContentHash === undefined) continue;
		entry.baselineScope = scope;
		adopted++;
	}
	return adopted;
}

/**
 * Parse persisted disk-index state and conservatively invalidate hashes whose
 * representation version is absent or obsolete. Stats remain useful for scan
 * admission, but an old hash can never participate in an authority decision.
 */
export function readDiskIndex(value: unknown): DiskIndex {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const result: DiskIndex = {};
	for (const [path, candidate] of Object.entries(value)) {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
		const entry = candidate as Record<string, unknown>;
		if (
			typeof entry.mtime !== "number" || !Number.isFinite(entry.mtime)
			|| typeof entry.size !== "number" || !Number.isFinite(entry.size) || entry.size < 0
		) continue;
		const parsed: DiskIndexEntry = { mtime: entry.mtime, size: entry.size };
		if (
			entry.contentHashVersion === MARKDOWN_CANONICAL_VERSION
			&& typeof entry.contentHash === "string"
			&& /^[a-f0-9]{64}$/.test(entry.contentHash)
		) {
			setCurrentContentHash(parsed, entry.contentHash);
		}
		if (
			entry.settlementKind === "body-only"
			&& typeof entry.bodyContentHash === "string" && /^[a-f0-9]{64}$/.test(entry.bodyContentHash)
			&& typeof entry.propertiesContentHash === "string" && /^[a-f0-9]{64}$/.test(entry.propertiesContentHash)
		) {
			setPartialContentHashes(parsed, entry.bodyContentHash, entry.propertiesContentHash);
		}
		if (
			typeof entry.baselineScope === "string" && entry.baselineScope.length > 0
			&& (parsed.contentHash !== undefined || parsed.bodyContentHash !== undefined)
		) {
			parsed.baselineScope = entry.baselineScope;
		}
		result[path] = parsed;
	}
	return result;
}

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
 *   - Otherwise: carry forward the old hash (if any).
 *
 * Why always carry forward when no settled hash?
 *   After a sync-driven flushWrite, the callback stores the hash with a dummy
 *   mtime=0 entry (real stat not yet available). The next reconcile sees stat
 *   changed (0 → real) but the file content is unchanged (disk == CRDT → no
 *   action). Without carrying forward, the hash is cleared. With carry-forward,
 *   the baseline survives until a real reconcile action (conflict, import, etc.)
 *   provides a new settledHash.
 *
 *   The worst case of a stale carried-forward hash is that a future authority
 *   decision treats content as "unchanged from baseline" when it actually
 *   changed externally — resulting in a conflict artifact (conservative) rather
 *   than a silent overwrite (destructive). That is the correct failure mode.
 *   Concrete updates happen via settledHashes, updateDiskIndexForPath, or
 *   setDiskWriteCallback — all of which have the actual content in scope.
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

		// Determine content hash:
		// 1. If a settled hash was recorded for this reconcile, use it (authoritative).
		// 2. Otherwise carry forward the old hash (if any).
		//    Stat changes alone don't invalidate the hash — the hash is updated
		//    by settledHashes, updateDiskIndexForPath, or setDiskWriteCallback
		//    whenever content actually changes in a known direction.
		const contentHash: string | undefined = settledHash ?? currentContentHash(oldEntry);

		newIndex[path] = {
			mtime: stat.mtime,
			size: stat.size,
			...(contentHash !== undefined && {
				contentHash,
				contentHashVersion: MARKDOWN_CANONICAL_VERSION,
			}),
			...(settledHash === undefined && contentHash !== undefined && oldEntry?.baselineScope && {
				baselineScope: oldEntry.baselineScope,
			}),
			...(settledHash === undefined && oldEntry?.settlementKind === "body-only" && {
				settlementKind: "body-only" as const,
				bodyContentHash: oldEntry.bodyContentHash,
				propertiesContentHash: oldEntry.propertiesContentHash,
				...(oldEntry.baselineScope && { baselineScope: oldEntry.baselineScope }),
			}),
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
			await new Promise((r) => window.setTimeout(r, delayMs));
		}
	}

	// If the file never fully quieted during the budget, continue anyway as long
	// as it still exists. This is a bounded delay, not a hard stability proof.
	return last !== null;
}
