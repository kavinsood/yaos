/**
 * Pruned docs keep their restore duty (DESIGN §c.9 "Pruned docs", §c.7). Pure helpers over the fold's output: which
 * deleted entries a fold step removed (their delete base must outlive them on the device), and the restore duty of a
 * doc the fold no longer holds.
 */

import type { DocId, NsEntry, NsFoldEvent, NsPrunedStub, Seq } from "../types";

/**
 * Deleted entries a fold step removed: the entries of `pruned` events, and on a reload (an ns checkpoint adopted,
 * `before` = the state before it) the deleted entries of `before` that `after` lacks: a checkpoint past the prune
 * skips its event. A doc that was live before the reload and is gone after it was deleted and pruned unseen: its
 * base is in the adopted state's stub (NsFoldState.pruned).
 */
export function removedDeletes(events: readonly NsFoldEvent[], before: ReadonlyMap<DocId, NsEntry> | null, after: ReadonlyMap<DocId, NsEntry>): NsEntry[] {
	const out = new Map<DocId, NsEntry>();
	if (before) for (const e of before.values()) if (e.state === "deleted" && !after.has(e.docId)) out.set(e.docId, e);
	for (const ev of events) {
		if (ev.outcome.kind !== "pruned") continue;
		for (const e of ev.outcome.entries) if (e.state === "deleted") out.set(e.docId, e);
	}
	return [...out.values()];
}

/** This device's knowledge of a doc's body stream (StreamRecord fields). */
export interface PrunedStreamInfo {
	/** Newest own row. */
	readonly lastOwnSeq: Seq;
	/** Newest row known to exist. */
	readonly remoteHeadSeq: Seq;
}

/**
 * Restore duty of a doc this device's view no longer holds: the restore condition of §c.7 against the removed
 * delete's base, as for a deleted entry: rows past the base, own (primary duty) or any (fallback duty; it also covers
 * rows whose author is gone, e.g. own rows of an earlier store of this install after an IndexedDB loss, which are not
 * `lastOwnSeq`). What this device knows of the doc, first match:
 *  - `entry`, the committed entry when only the optimistic view dropped it (an own pending frame's prune): a live one
 *    is no duty (the prune is this device's own pending delete's), a deleted one gives its base, a merged one none;
 *  - `kept`, the delete base kept when this device's fold removed the entry (NsRuntime.removedDeletes,
 *    StreamRecord.prunedDeleteBase);
 *  - `stub`, the committed state's stub of the pruned entry (NsFoldState.pruned): a deleted one gives its base, a
 *    merged one none. It reaches a reader that adopted an ns checkpoint past the delete and its prune;
 *  - nothing (the stub aged out of PRUNED_STUB_CAP): any row is a duty. The file is re-created: a resurrection at
 *    worst, never a loss.
 * Merged (no base): own rows only, all of them; the merge's winner holds the rest.
 */
export function prunedRestoreDuty(rec: PrunedStreamInfo, kept: Seq | undefined, entry: NsEntry | undefined, stub: NsPrunedStub | undefined): boolean {
	if (entry !== undefined && entry.state === "live") return false;
	const known: { readonly merged: boolean; readonly base: Seq } | null = entry !== undefined
		? { merged: entry.state === "merged", base: entry.deleteBaseBodySeq }
		: kept !== undefined ? { merged: false, base: kept }
		: stub !== undefined ? { merged: stub.state === "merged", base: stub.deleteBaseBodySeq }
		: null;
	if (known === null) return rec.lastOwnSeq > 0 || rec.remoteHeadSeq > 0;
	if (known.merged) return rec.lastOwnSeq > 0;
	return rec.lastOwnSeq > known.base || rec.remoteHeadSeq > known.base;
}
