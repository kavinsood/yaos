/**
 * NsFoldIndex maintenance (DESIGN §c.1). The index is derived from entries
 * and never encoded. folderRefs values are replaced, never mutated, so a
 * shallow Map copy is a valid copy-on-write snapshot (overlay).
 */

import type { DocId, NsEntry, NsFoldIndex, NsFoldState, PathKey, VaultPath } from "../types";
import { FOLD_RULES_VERSION } from "../limits";

export function newNsFoldState(): NsFoldState {
	return { formatVersion: 1, foldRulesVersion: FOLD_RULES_VERSION, coversSeq: 0, entries: new Map(), recentFrames: new Map() };
}

export function newNsFoldIndex(): NsFoldIndex {
	return { byPathKey: new Map(), folderRefs: new Map(), tombstones: 0 };
}

/**
 * Folder prefixes of a live entry: [pathKey prefix, display prefix] for every
 * proper prefix. pathKey is segment-wise (src/core/paths/pathKey.ts), so the
 * key prefixes come from splitting the stored pathKey.
 */
export function folderPrefixes(path: VaultPath, key: PathKey): Array<[PathKey, VaultPath]> {
	const out: Array<[PathKey, VaultPath]> = [];
	let pi = path.indexOf("/");
	let ki = key.indexOf("/");
	while (pi >= 0 && ki >= 0) {
		out.push([key.slice(0, ki) as PathKey, path.slice(0, pi)]);
		pi = path.indexOf("/", pi + 1);
		ki = key.indexOf("/", ki + 1);
	}
	return out;
}

/** Adds a LIVE entry. */
export function indexAddLive(index: NsFoldIndex, e: NsEntry): void {
	index.byPathKey.set(e.pathKey, e.docId);
	for (const [k, display] of folderPrefixes(e.path, e.pathKey)) {
		const cur = index.folderRefs.get(k);
		index.folderRefs.set(k, cur ? { path: cur.path, count: cur.count + 1 } : { path: display, count: 1 });
	}
}

/** Removes a LIVE entry. */
export function indexRemoveLive(index: NsFoldIndex, e: NsEntry): void {
	if (index.byPathKey.get(e.pathKey) === e.docId) index.byPathKey.delete(e.pathKey);
	for (const [k] of folderPrefixes(e.path, e.pathKey)) {
		const cur = index.folderRefs.get(k);
		if (!cur) continue;
		if (cur.count <= 1) index.folderRefs.delete(k);
		else index.folderRefs.set(k, { path: cur.path, count: cur.count - 1 });
	}
}

export function buildIndex(state: NsFoldState): NsFoldIndex {
	const index = newNsFoldIndex();
	const ids = [...state.entries.keys()].sort();
	for (const id of ids) {
		const e = state.entries.get(id)!;
		if (e.state === "live") indexAddLive(index, e);
		else index.tombstones++;
	}
	return index;
}

/** Copy-on-write snapshot (entries are immutable objects; maps are copied shallowly). */
export function cloneNsFold(state: NsFoldState, index: NsFoldIndex): { state: NsFoldState; index: NsFoldIndex } {
	return {
		state: {
			formatVersion: 1,
			foldRulesVersion: state.foldRulesVersion,
			coversSeq: state.coversSeq,
			entries: new Map(state.entries),
			recentFrames: new Map(state.recentFrames),
		},
		index: { byPathKey: new Map(index.byPathKey), folderRefs: new Map(index.folderRefs), tombstones: index.tombstones },
	};
}

/** Structural equality of two indexes (tests, V2 derived-index check). */
export function indexesEqual(a: NsFoldIndex, b: NsFoldIndex): string | null {
	if (a.tombstones !== b.tombstones) return `tombstones ${a.tombstones} != ${b.tombstones}`;
	if (a.byPathKey.size !== b.byPathKey.size) return `byPathKey size ${a.byPathKey.size} != ${b.byPathKey.size}`;
	for (const [k, v] of a.byPathKey) if (b.byPathKey.get(k) !== v) return `byPathKey[${k}]`;
	if (a.folderRefs.size !== b.folderRefs.size) return `folderRefs size ${a.folderRefs.size} != ${b.folderRefs.size}`;
	for (const [k, v] of a.folderRefs) {
		const w = b.folderRefs.get(k);
		if (!w || w.path !== v.path || w.count !== v.count) return `folderRefs[${k}] ${JSON.stringify(v)} != ${JSON.stringify(w)}`;
	}
	return null;
}

export function sortedDocIds(ids: Iterable<DocId>): DocId[] {
	return [...ids].sort();
}
