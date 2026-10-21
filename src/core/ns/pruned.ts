/**
 * Pruned docs keep their restore duty (DESIGN §c.9 "Pruned docs", §c.7). Pure helpers over the fold's output: which
 * deleted entries a fold step removed (their delete base must outlive them on the device), and the restore duty of a
 * doc the fold no longer holds.
 */

import type { DocId, NsEntry, NsFoldEvent, Seq } from "../types";

/**
 * Deleted entries a fold step removed: the entries of `pruned` events, and on a reload (an ns checkpoint adopted,
 * `before` = the state before it) the deleted entries of `before` that `after` lacks: a checkpoint past the prune
 * skips its event. A doc that was live before the reload and is gone after it was deleted and pruned unseen: its
 * base is unknown (prunedRestoreDuty).
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
 * own rows of an earlier store of this install after an IndexedDB loss, which are not `lastOwnSeq`). `entry` is the
 * committed entry when only the optimistic view dropped it (an own pending frame's prune): a deleted one gives its
 * base, a merged one none, a live one no duty (the prune is this device's own pending delete's). Otherwise `base` is
 * the kept delete base. With no base (a merged alias, or a doc deleted and pruned inside an adopted ns checkpoint)
 * only own rows count, all of them (base 0): anyone's rows exceed 0, and every device would re-create.
 */
export function prunedRestoreDuty(rec: PrunedStreamInfo, base: Seq | undefined, entry: NsEntry | undefined): boolean {
	if (entry !== undefined && entry.state === "live") return false;
	const b = entry === undefined ? base : entry.state === "deleted" ? entry.deleteBaseBodySeq : undefined;
	if (b === undefined) return rec.lastOwnSeq > 0;
	return rec.lastOwnSeq > b || rec.remoteHeadSeq > b;
}
