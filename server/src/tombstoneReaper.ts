/**
 * Tombstone body reaper.
 *
 * WHY THIS EXISTS
 *
 * Deleting a file in YAOS writes a tombstone into `meta` and leaves the file's
 * `Y.Text` body in `idToText` untouched.  Nothing ever removes it:
 * `pruneOrphans` explicitly exempts tombstoned ids from cleanup, so the body is
 * unreachable, still "live" as far as Yjs is concerned, and therefore exempt
 * from garbage collection forever.
 *
 * Yjs GC is not at fault and is not disabled — `gc: true` is the default and
 * collapsing works exactly as documented.  Deleting the map entry that holds a
 * Y.Text recursively replaces its content with GC structs, which is why a
 * 200KB body collapses to ~37 encoded bytes.  We simply never asked.
 *
 * The result is a document that grows with the vault's LIFETIME content rather
 * than its CURRENT content: on one real vault, 46 tombstones were retaining
 * 404,641 characters, 11.5% of the document, and that share only ever rises.
 * At the memory ratios measured on the same deployment (~13 bytes of DO heap
 * per character) that is the difference between a vault that fits in 128MB and
 * one that does not.
 *
 * WHY REAPING IS SAFE
 *
 * Deleting a body is an ordinary CRDT delete, so it converges: a peer that
 * edited the file offline and merges afterwards agrees with the reaping peer
 * byte-for-byte, and no content resurrects.  The `meta` tombstone is
 * deliberately NOT removed, so resurrection prevention, the tombstone-conflict
 * reconcile path, and revive-blocking all behave exactly as before.
 *
 * Reviving a file never reads the retained body: `ensureFile` clears the meta
 * tombstone and then mints a fresh fileId and a fresh Y.Text from disk content.
 *
 * WHAT THE GRACE PERIOD PROTECTS
 *
 * One consumer does read the body.  When a remote delete reaches a device,
 * DiskMirror looks up `idToText` to obtain a baseline and compares it against
 * the file on disk, so it can preserve a file the user modified locally instead
 * of deleting it.  With no baseline it fails safe — it PRESERVES the file and
 * marks it unresolved — so a device that has been offline longer than the grace
 * period keeps its local copy rather than losing edits.  That is the worst case,
 * and it lands in the existing tombstone-conflict path.  The grace window
 * therefore only needs to exceed how long a device plausibly stays offline.
 *
 * WHY THIS DEPENDS ON THE DIRTY-FLAG FIX
 *
 * A reap is a deletion-only change, which does not advance the state vector.
 * While saves were gated on state-vector equality the reap was computed, applied
 * in memory, reported as a successful save, and never written — reverting on the
 * next cold load.  See PersistenceCoordinator's `dirty` flag.
 */

import * as Y from "yjs";
import { usesLegacyPathModel } from "./schemaModel";
import { isMetaDeleted, readMetaDeletedAt } from "./documentSummary";

/** Tombstones younger than this keep their bodies.  30 days. */
export const TOMBSTONE_REAP_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Bodies reaped per pass.  A vault with thousands of tombstones would otherwise
 * produce one enormous update and one enormous transaction; the remainder is
 * picked up by the next pass, and reaping is never urgent.
 */
export const TOMBSTONE_REAP_MAX_PER_RUN = 500;

/**
 * Transaction origin for reaper writes, so client-side observers and traces can
 * attribute the deletion to server maintenance rather than a user action.
 */
export const TOMBSTONE_REAP_ORIGIN = "yaos-server-reap";

export interface ReapOptions {
	/** Tombstones younger than this are left alone. */
	graceMs?: number;
	/** Maximum bodies to delete in this pass. */
	maxPerRun?: number;
	/** Injectable clock, for tests. */
	now?: number;
}

export interface ReapResult {
	/** meta entries walked. */
	metaEntries: number;
	/** meta entries that are tombstones. */
	tombstones: number;
	/** Tombstones whose body is already gone — nothing to reclaim. */
	alreadyReaped: number;
	/** Tombstones that still hold a body, i.e. the candidate pool. */
	withBody: number;
	/** Bodies actually deleted. */
	reaped: number;
	/** Characters of live content removed. */
	charsFreed: number;
	/**
	 * Tombstoned, but still inside the grace window.
	 *
	 * NOTE: withinGrace, unknownAge and conflicted OVERLAP.  Each is evaluated
	 * independently, so one tombstone can appear in several, and they do NOT
	 * sum to `withBody`.  They previously partitioned it, which meant the first
	 * matching reason hid every other one and produced a materially wrong read
	 * of a live vault.
	 */
	withinGrace: number;
	/**
	 * Tombstoned with no usable deletion timestamp, so age cannot be
	 * established.  Skipped: never delete data whose age is unknown.
	 */
	unknownAge: number;
	/** Tombstoned in meta but still referenced as active — skipped, inconsistent. */
	conflicted: number;
	/** Tombstoned and eligible, but beyond this pass's budget. */
	remaining: number;
}

const EMPTY_RESULT: ReapResult = {
	metaEntries: 0,
	tombstones: 0,
	alreadyReaped: 0,
	withBody: 0,
	reaped: 0,
	charsFreed: 0,
	withinGrace: 0,
	unknownAge: 0,
	conflicted: 0,
	remaining: 0,
};


/**
 * Delete the Y.Text bodies of tombstones older than the grace period.
 *
 * Tombstones themselves are preserved.  Returns counts describing what was and
 * was not reaped; a pass that finds nothing performs no transaction at all, so
 * repeated calls on a clean document are free.
 */
export function reapTombstonedBodies(doc: Y.Doc, options: ReapOptions = {}): ReapResult {
	const graceMs = options.graceMs ?? TOMBSTONE_REAP_GRACE_MS;
	const maxPerRun = options.maxPerRun ?? TOMBSTONE_REAP_MAX_PER_RUN;
	const now = options.now ?? Date.now();

	const meta = doc.getMap("meta");
	const idToText = doc.getMap<Y.Text>("idToText");
	const pathToId = doc.getMap<string>("pathToId");

	// Only `meta` short-circuits.  An empty idToText also means nothing to
	// reclaim, but returning zeros for it would report a vault with tombstones as
	// having none — the same class of mistake as the counters that used to
	// short-circuit each other.  The per-tombstone check below reports those as
	// alreadyReaped instead.
	if (meta.size === 0) return { ...EMPTY_RESULT };

	// Whether `pathToId` still decides path -> fileId resolution.
	//
	// Under the v2+ path model the client resolves purely from `meta` and stops
	// writing `pathToId` at all (see usesV2PathModel / shouldWriteLegacyPathMap),
	// so leftover entries are dormant legacy data that no longer authorises
	// anything.  Treating them as authoritative would permanently block reaping
	// on every migrated vault: one real vault had 14 of 46 tombstones pinned by
	// exactly this drift.  Under the legacy model `pathToId` IS consulted first,
	// so there it must still veto a reap.
	const legacyPathModel = usesLegacyPathModel(doc);

	// Any id reachable as active content is off limits, even if some other meta
	// entry claims it is deleted.
	const activeIds = new Set<string>();
	if (legacyPathModel) {
		pathToId.forEach((fileId) => {
			if (typeof fileId === "string") activeIds.add(fileId);
		});
	}
	meta.forEach((value, fileId) => {
		if (!isMetaDeleted(value)) activeIds.add(fileId);
	});

	const result: ReapResult = { ...EMPTY_RESULT };
	const candidates: string[] = [];

	meta.forEach((value, fileId) => {
		result.metaEntries++;
		if (!isMetaDeleted(value)) return;
		result.tombstones++;

		// Nothing to reclaim — already reaped, or never had a body.
		if (!idToText.has(fileId)) {
			result.alreadyReaped++;
			return;
		}
		result.withBody++;

		// Every reason is evaluated, not just the first one that matches.
		//
		// These counters used to short-circuit: the conflict check returned
		// before the age checks ran, so a tombstone that was BOTH still
		// referenced and inside the grace window was reported only as
		// `conflicted` and its age was never established.  A real vault
		// reported `conflicted: 14`, which read as "14 bodies are blocked only
		// by a stale reference, so fixing that frees them" — and it was wrong.
		// All 14 were also inside the grace window, which the numbers could not
		// say.  Overlapping counters describe the tombstone; a partition only
		// describes the order the code happened to ask.
		const blockedByReference = activeIds.has(fileId);
		const deletedAt = readMetaDeletedAt(value);
		const ageUnknown = deletedAt === null;
		const insideGrace = !ageUnknown && now - deletedAt < graceMs;

		if (blockedByReference) result.conflicted++;
		if (ageUnknown) result.unknownAge++;
		if (insideGrace) result.withinGrace++;

		if (!blockedByReference && !ageUnknown && !insideGrace) candidates.push(fileId);
	});

	if (candidates.length === 0) return result;

	const batch = candidates.slice(0, maxPerRun);
	result.remaining = candidates.length - batch.length;

	doc.transact(() => {
		for (const fileId of batch) {
			const body = idToText.get(fileId);
			if (!body) continue;
			result.charsFreed += body.length;
			idToText.delete(fileId);
			result.reaped++;
		}
	}, TOMBSTONE_REAP_ORIGIN);

	return result;
}
