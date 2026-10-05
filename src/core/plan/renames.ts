/**
 * Rename inference (DESIGN §f.6). Pure, deterministic and independent of the
 * iteration order of its inputs (everything is sorted on content).
 *
 * - Observed, verified rename events win (they may carry a content change).
 * - Otherwise, only when the listing is complete: pair missing synced docs
 *   with new local entries by (kind, contentHash). A unique pair is a rename;
 *   several equal hashes pair by score (same leaf name = 2, same parent = 1),
 *   ties by path code-unit order. Unpaired ones become delete + create.
 */

import type { ContentHash, DocId, DocKind, LocalEntry, ObservedRename, PathKey, PathKeyFn, SyncedEntry } from "../types";
import { leafOf, parentOf } from "./pathRules";

export interface RenameCandidateMissing {
	readonly docId: DocId;
	readonly kind: DocKind;
	readonly path: string;
	readonly pathKey: PathKey;
	readonly contentHash: ContentHash;
}

export interface InferredRename {
	readonly docId: DocId;
	readonly to: LocalEntry;
	readonly via: "observed" | "hash";
}

function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param missing synced docs whose S.pathKey has no local entry
 * @param fresh   new local entries: no remote or synced match, hashed, not excluded
 */
export function inferRenames(
	missing: readonly SyncedEntry[],
	fresh: readonly LocalEntry[],
	observed: readonly ObservedRename[],
	localComplete: boolean,
	pathKey: PathKeyFn,
): InferredRename[] {
	const result: InferredRename[] = [];
	const missingById = new Map<DocId, SyncedEntry>();
	for (const s of missing) missingById.set(s.docId, s);
	const freshByKey = new Map<PathKey, LocalEntry>();
	for (const l of fresh) freshByKey.set(l.pathKey, l);
	const usedDocs = new Set<DocId>();
	const usedKeys = new Set<PathKey>();

	// 1. Observed renames, in event order (atMs, from, to). Chains a->b->c resolve to c.
	const events = [...observed].sort((x, y) => x.atMs - y.atMs || cmp(x.from, y.from) || cmp(x.to, y.to));
	const at = new Map<PathKey, DocId>(); // current key of a missing doc
	for (const s of [...missing].sort((x, y) => cmp(x.docId, y.docId))) at.set(s.pathKey, s.docId);
	for (const event of events) {
		const fromKey = pathKey(event.from);
		const docId = at.get(fromKey);
		if (docId === undefined) continue;
		at.delete(fromKey);
		at.set(pathKey(event.to), docId);
	}
	const bySorted = [...at.entries()].sort((x, y) => cmp(x[0], y[0]));
	for (const [key, docId] of bySorted) {
		const s = missingById.get(docId)!;
		if (key === s.pathKey) continue;
		const target = freshByKey.get(key);
		if (!target || target.kind !== s.kind || usedKeys.has(key)) continue;
		result.push({ docId, to: target, via: "observed" });
		usedDocs.add(docId);
		usedKeys.add(key);
	}

	if (!localComplete) return result;

	// 2. By (kind, hash).
	const groups = new Map<string, { miss: SyncedEntry[]; news: LocalEntry[] }>();
	for (const s of missing) {
		if (usedDocs.has(s.docId)) continue;
		const g = `${s.kind}\u0000${s.contentHash}`;
		const group = groups.get(g) ?? { miss: [], news: [] };
		group.miss.push(s);
		groups.set(g, group);
	}
	for (const l of fresh) {
		if (usedKeys.has(l.pathKey) || l.hash === null) continue;
		const group = groups.get(`${l.kind}\u0000${l.hash}`);
		if (group) group.news.push(l);
	}
	for (const g of [...groups.keys()].sort(cmp)) {
		const { miss, news } = groups.get(g)!;
		if (miss.length === 0 || news.length === 0) continue;
		const pairs: { s: SyncedEntry; l: LocalEntry; score: number }[] = [];
		for (const s of miss) for (const l of news) {
			const score = (leafOf(s.path) === leafOf(l.path) ? 2 : 0) + (parentOf(s.path) === parentOf(l.path) ? 1 : 0);
			pairs.push({ s, l, score });
		}
		pairs.sort((x, y) => y.score - x.score || cmp(x.s.path, y.s.path) || cmp(x.l.path, y.l.path) || cmp(x.s.docId, y.s.docId) || cmp(x.l.pathKey, y.l.pathKey));
		for (const { s, l } of pairs) {
			if (usedDocs.has(s.docId) || usedKeys.has(l.pathKey)) continue;
			result.push({ docId: s.docId, to: l, via: "hash" });
			usedDocs.add(s.docId);
			usedKeys.add(l.pathKey);
		}
	}
	return result.sort((x, y) => cmp(x.docId, y.docId));
}
