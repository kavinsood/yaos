/**
 * ns fold -> disk side (DESIGN §c.13, §d.2).
 *
 *  - Own frames that folded become OwnFoldEvents (S1: Reconciler.applyOwnFold
 *    moves the synced tree forward only for committed own ops).
 *  - Every doc an event touched is put in the next pass scope (with its old
 *    and new path keys) so the planner projects remote changes quickly.
 *  - Bound docs whose identity changed get `docRetarget`: `merged` when the
 *    entry became an alias; re-open by path when the fold pruned the entry
 *    (into: null; the doc is dead, maintenance retires and drops its stream,
 *    retire.ts, and its views re-bind to whatever doc owns the path). A reload (an ns checkpoint adopted, a refold)
 *    carries no events: every bound doc is checked against the new state, as a doc deleted and pruned (or merged)
 *    inside the adopted checkpoint is gone the same way (sim smallPrune storm seed 61: the view stayed bound to the
 *    dead doc, pinning its replica and stream records). Renames and deletes are not retargeted at fold
 *    time: the editor view follows the vault.rename / trash the projection
 *    does (and a bound doc with pending edits keeps its restore duty).
 */

import type { DeviceId, DocId, NsEntry, NsOp, PathKey, RemoteEntry } from "../../core/types";
import type { OwnFoldEvent } from "../reconcile/deps";
import type { FoldedNsFrame } from "../sync/nsRuntime";

export interface FoldEffects {
	readonly own: OwnFoldEvent[];
	readonly docIds: Set<DocId>;
	readonly pathKeys: Set<PathKey>;
	readonly retarget: { readonly docId: DocId; readonly into: DocId | null }[];
}

export function committedRemoteEntry(e: NsEntry | undefined): RemoteEntry | null {
	if (!e) return null;
	return {
		docId: e.docId, kind: e.kind, path: e.path, pathKey: e.pathKey, state: e.state, lastTouchSeq: e.lastTouchSeq,
		deletedSeq: e.deletedSeq, deleteBaseBodySeq: e.deleteBaseBodySeq, createHash: e.createHash, blob: e.blob,
		aliasOf: e.aliasOf, pendingLocal: false, body: null,
	};
}

function opDocId(op: NsOp): DocId | null {
	return op.t === "upgradeRules" ? null : op.docId;
}

export function foldEffects(o: {
	readonly frames: readonly FoldedNsFrame[];
	readonly self: DeviceId;
	/** Committed entry (no alias redirect). */
	readonly committed: (docId: DocId) => NsEntry | undefined;
	readonly isBound: (docId: DocId) => boolean;
	readonly pathKey: (path: NsEntry["path"]) => PathKey;
	/**
	 * On a reload (the committed state was replaced, not stepped by `frames`): the bound docs that are not own creates
	 * still to fold. Each with no committed entry is retargeted as pruned.
	 */
	readonly reloadedBound?: Iterable<DocId>;
}): FoldEffects {
	const own: OwnFoldEvent[] = [];
	const docIds = new Set<DocId>();
	const pathKeys = new Set<PathKey>();
	const retarget: { docId: DocId; into: DocId | null }[] = [];
	const pruned = new Set<DocId>();
	const seen = new Set<DocId>();
	for (const f of o.frames) {
		const mine = f.deviceId === o.self;
		for (const ev of f.events) {
			if (ev.docId) docIds.add(ev.docId);
			if (ev.outcome.kind === "pruned") for (const d of ev.outcome.docIds) {
				docIds.add(d);
				pruned.add(d);
			}
			if (ev.outcome.kind === "merged") docIds.add(ev.outcome.into);
			if (ev.index < 0) continue;
			const op = f.ops[ev.index];
			if (!op) continue;
			const target = opDocId(op);
			if (target) docIds.add(target);
			if (op.t === "create" || op.t === "rename" || op.t === "restore") pathKeys.add(o.pathKey(op.path));
			if (ev.outcome.kind === "suffixed" || ev.outcome.kind === "revived") pathKeys.add(o.pathKey(ev.outcome.finalPath));
			if (mine) own.push({ op, seq: f.seq, outcome: ev.outcome, entry: committedRemoteEntry(o.committed(ev.docId ?? target ?? ("" as DocId))) });
		}
	}
	for (const d of o.reloadedBound ?? []) {
		docIds.add(d);
		pruned.add(d);
	}
	for (const d of docIds) {
		const e = o.committed(d);
		if (e) pathKeys.add(e.pathKey);
		if (seen.has(d) || !o.isBound(d)) continue;
		seen.add(d);
		if (e && e.state === "merged" && e.aliasOf) retarget.push({ docId: d, into: e.aliasOf });
		else if (!e && pruned.has(d)) retarget.push({ docId: d, into: null });
	}
	return { own, docIds, pathKeys, retarget };
}
