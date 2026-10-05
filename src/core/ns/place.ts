/**
 * Placement (DESIGN §c.4). Pure function of (state, index, requested path,
 * mode). The entry being placed must already be out of the index. Recasing
 * side effects are returned (not applied) so a failed placement changes
 * nothing; the caller applies them with applyRecases on success.
 *
 * Decisions (wp-a-notes.md):
 * - Ancestor " (n)" suffix: smallest n in 2..MAX_SUFFIX_N whose prefix key is
 *   not a live file; the segment is trimmed to the byte limits (drop code
 *   points from the end, strip trailing dots/spaces); empty -> fail.
 * - A path over a byte limit after ancestor adjustment (adopted casing,
 *   ancestor suffix) is handled like a leaf collision: suffix loop with trimming.
 * - A recase that would push any affected entry over MAX_PATH_BYTES is not
 *   performed; the existing casing is adopted instead.
 * - Every candidate must be a valid segment (§c.2), else it is skipped.
 */

import type { ContentHash, DocId, DocKind, NsEntry, NsFoldIndex, NsFoldState, PathKey, VaultPath } from "../types";
import { MAX_PATH_BYTES, MAX_SEGMENT_BYTES, MAX_SUFFIX_N, SUFFIX_DOCID_CHARS } from "../limits";
import { foldKey } from "../paths/pathKey";
import { dropLastCodePoint, splitExt, stripTrailingDotsSpaces, utf8ByteLength } from "../paths/segments";
import { segmentInvalidReason } from "../paths/validate";
import { indexAddLive, indexRemoveLive } from "./index";

export type PlaceMode = "create" | "rename" | "caseOnlyRename" | "revive";

export interface Recase {
	/** Depth of the recased segment (0 = top level). */
	readonly depth: number;
	/** Folder key being recased. */
	readonly key: PathKey;
	/** New display of that segment. */
	readonly segment: string;
}

export type PlaceResult =
	| { readonly t: "path"; readonly path: VaultPath; readonly key: PathKey; readonly recases: readonly Recase[] }
	| { readonly t: "merged"; readonly into: DocId }
	| { readonly t: "fail" };

export interface PlaceSelf {
	readonly docId: DocId;
	readonly kind: DocKind;
	/** create only: the op's contentHash (identical-duplicate merge). */
	readonly contentHash: ContentHash | null;
}

function lastSegment(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** Trim s so that utf8(s) <= budget: drop code points from the end, then strip trailing dots/spaces. */
function trimTo(s: string, budget: number): string {
	if (budget <= 0) return "";
	if (utf8ByteLength(s) <= budget) return s;
	let t = s;
	while (t.length > 0 && utf8ByteLength(t) > budget) t = dropLastCodePoint(t);
	return stripTrailingDotsSpaces(t);
}

function joinKey(parentKey: string, segKey: string): PathKey {
	return (parentKey === "" ? segKey : `${parentKey}/${segKey}`) as PathKey;
}

/** Indexed live entries strictly under folder key k, ascending docId (the entry being placed is not indexed). */
function liveUnder(state: NsFoldState, index: NsFoldIndex, k: PathKey): NsEntry[] {
	const prefix = k + "/";
	const ids: DocId[] = [];
	for (const [key, id] of index.byPathKey) if (key.startsWith(prefix)) ids.push(id);
	ids.sort();
	return ids.map((id) => state.entries.get(id)!);
}

/** Path of e after the given recases (each applies to entries under its key). */
function recasedPath(e: NsEntry, recases: readonly Recase[]): VaultPath {
	const segs = e.path.split("/");
	for (const r of recases) if (e.pathKey.startsWith(r.key + "/")) segs[r.depth] = r.segment;
	return segs.join("/");
}

export function place(
	state: NsFoldState,
	index: NsFoldIndex,
	requested: VaultPath,
	mode: PlaceMode,
	self: PlaceSelf,
): PlaceResult {
	const segs = requested.split("/");
	const out = segs.slice();
	const recases: Recase[] = [];
	let parentKey = "";
	const restBytes = (i: number) => utf8ByteLength(out.join("/")) - utf8ByteLength(out[i]!);

	// 1. Ancestors, left to right.
	for (let i = 0; i < out.length - 1; i++) {
		let k = joinKey(parentKey, foldKey(out[i]!));
		// 1.1 Ancestor is a live file: "seg (n)".
		if (index.byPathKey.has(k)) {
			const seg = out[i]!;
			const rest = restBytes(i);
			let found = false;
			let lastBudget = -1;
			let base = "";
			for (let n = 2; n <= MAX_SUFFIX_N; n++) {
				const suffix = ` (${n})`;
				const budget = Math.min(MAX_SEGMENT_BYTES, MAX_PATH_BYTES - rest) - suffix.length;
				if (budget !== lastBudget) { base = trimTo(seg, budget); lastBudget = budget; }
				if (base === "") return { t: "fail" };
				const cand = base + suffix;
				if (segmentInvalidReason(cand) !== null) continue;
				if (base !== seg && cand.normalize("NFC") !== cand) continue;
				const ck = joinKey(parentKey, foldKey(cand));
				if (!index.byPathKey.has(ck)) { out[i] = cand; k = ck; found = true; break; }
			}
			if (!found) return { t: "fail" };
		}
		// 1.2 Folder exists with a different casing.
		const ref = index.folderRefs.get(k);
		if (ref) {
			const existing = lastSegment(ref.path);
			if (existing !== out[i]) {
				let recase = false;
				if (mode === "caseOnlyRename") {
					const next = [...recases, { depth: i, key: k, segment: out[i]! }];
					recase = liveUnder(state, index, k).every((e) => utf8ByteLength(recasedPath(e, next)) <= MAX_PATH_BYTES);
					if (recase) recases.push({ depth: i, key: k, segment: out[i]! });
				}
				if (!recase) out[i] = existing;
			}
		}
		parentKey = k;
	}

	// 2. Leaf.
	const leaf = out[out.length - 1]!;
	const leafKey = joinKey(parentKey, foldKey(leaf));
	const parentBytes = out.length > 1 ? utf8ByteLength(out.slice(0, -1).join("/")) + 1 : 0;
	const overLimit = parentBytes + utf8ByteLength(leaf) > MAX_PATH_BYTES;
	const holder = index.byPathKey.get(leafKey);
	const fileCollision = holder !== undefined && holder !== self.docId;
	const folderCollision = index.folderRefs.has(leafKey);
	if (!fileCollision && !folderCollision && !overLimit) {
		return { t: "path", path: out.join("/"), key: leafKey, recases };
	}
	if (mode === "create" && fileCollision && self.contentHash !== null) {
		const w = state.entries.get(holder)!;
		if (w.kind === self.kind && (self.contentHash === w.createHash || (w.blob !== null && self.contentHash === w.blob.hash))) {
			return { t: "merged", into: w.docId };
		}
	}

	// Suffix the leaf.
	const { stem, ext } = splitExt(leaf);
	const parentPrefix = out.length > 1 ? out.slice(0, -1).join("/") + "/" : "";
	const segBudget = Math.min(MAX_SEGMENT_BYTES, MAX_PATH_BYTES - parentBytes) - utf8ByteLength(ext);
	let lastBudget = -1;
	let base = "";
	const tryForm = (suffix: string): PlaceResult | null => {
		const budget = segBudget - utf8ByteLength(suffix);
		if (budget !== lastBudget) { base = trimTo(stem, budget); lastBudget = budget; }
		if (base === "") return null;
		const cand = base + suffix + ext;
		if (segmentInvalidReason(cand) !== null) return null;
		if (base !== stem && cand.normalize("NFC") !== cand) return null;
		const ck = joinKey(parentKey, foldKey(cand));
		if (index.byPathKey.has(ck) || index.folderRefs.has(ck)) return null;
		return { t: "path", path: parentPrefix + cand, key: ck, recases };
	};
	for (let n = 2; n <= MAX_SUFFIX_N; n++) {
		const r = tryForm(` (${n})`);
		if (r) return r;
	}
	return tryForm(` (${self.docId.slice(0, SUFFIX_DOCID_CHARS)})`) ?? tryForm(` (${self.docId})`) ?? { t: "fail" };
}

/**
 * Applies recases: rewrites the display prefix of every live entry under each
 * recased key (ascending docId; lastTouchSeq unchanged) and rebuilds their
 * index contributions.
 */
export function applyRecases(state: NsFoldState, index: NsFoldIndex, recases: readonly Recase[]): void {
	if (recases.length === 0) return;
	const shallowest = recases.reduce((a, b) => (a.depth <= b.depth ? a : b));
	const affected = liveUnder(state, index, shallowest.key);
	for (const e of affected) indexRemoveLive(index, e);
	for (const e of affected) {
		const path = recasedPath(e, recases);
		const next: NsEntry = path === e.path ? e : { ...e, path };
		state.entries.set(e.docId, next);
		indexAddLive(index, next);
	}
}
