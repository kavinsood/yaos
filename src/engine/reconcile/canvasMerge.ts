/**
 * Canvas 3-way merge (DESIGN §f.3, §j.2): the ONE MergeFn (core/merge) over the
 * record-per-line merge text (canvasToMergeText: node lines, edge lines, each
 * in (rank, id) order, then the root-fields line).
 *
 *  - B: the stored base (merge text of the last synced projection, ranks
 *       included); the empty canvas when the CRDT is empty; else null (no base
 *       -> identical or conflict(no-base), as for markdown).
 *  - D: the disk canvas, ranked by reconcileCanvasRanks(disk order, ranks of B,
 *       then of C for ids B lacks). Base ranks win, so a record the disk did
 *       not touch keeps its exact base line even when C re-ranked it.
 *  - C: the visible CRDT canvas (dangling edges dropped).
 *
 * Decisions:
 *  - Extension: a record new on one side only (id in neither B nor the other
 *    side) is added to B and to the other side before the diff3. A fresh-id
 *    insertion commutes, so concurrent adds of different nodes / edges always
 *    merge; without it two appends after the last node are "two insertions at
 *    the same line" = conflict. Same-id records new on both sides go through
 *    the diff3 as usual. No extension without a base.
 *  - Validation (as mergeValidated, §f.3): a merged text that does not parse,
 *    has an unknown node type, or whose projection breaks the limits becomes
 *    conflict(both-edited) keeping the unextended CRDT side.
 *  - Edits to different records merge (touching lines merge cleanly in the
 *    diff3); edits to the same record conflict: the CRDT keeps its side of the
 *    overlapping records plus the clean disk hunks, the job copies the disk file.
 */

import type { ConflictReason, MergeLimits, MergeResult } from "../../core/types";
import {
	canvasFromMergeText, canvasToMergeText, parseCanvasBytes,
	type CanvasEdge, type CanvasNode, type CanvasRanked, type CanvasSemanticData,
} from "../../core/hash/canvasCanonical";
import { reconcileCanvasRanks } from "../../core/hash/canvasOrdering";
import { merge } from "../../core/merge/merge";
import { checkCanvasRecords, makeRanked, projectRanked, type CanvasProjection } from "./canvasDoc";

/** Merge text -> ranked canvas, validated (§j.2). null = malformed / invalid. */
export function parseMergeText(text: string): CanvasRanked | null {
	const r = canvasFromMergeText(text);
	if (!r) return null;
	return checkCanvasRecords(r.data) === null ? r : null;
}

export type DiskCanvas = { readonly ok: true; readonly data: CanvasSemanticData } | { readonly ok: false; readonly reason: string };

/** Parse + validate disk bytes. Decision: a dangling edge on disk makes the file invalid (core parser). */
export function parseDiskCanvas(bytes: Uint8Array): DiskCanvas {
	const parsed = parseCanvasBytes(bytes);
	if (parsed.kind === "oversized") return { ok: false, reason: `oversized ${parsed.limit} ${parsed.measured} > ${parsed.maximum}` };
	if (parsed.kind === "invalid") return { ok: false, reason: parsed.detail !== undefined ? `${parsed.reason} ${parsed.detail}` : parsed.reason };
	const why = checkCanvasRecords(parsed.data);
	return why === null ? { ok: true, data: parsed.data } : { ok: false, reason: why };
}

export function isEmptyCanvas(r: CanvasRanked): boolean {
	return r.data.nodes.size === 0 && r.data.edges.size === 0 && Object.keys(r.data.rootFields).length === 0;
}

function union(primary: ReadonlyMap<string, string> | undefined, secondary: ReadonlyMap<string, string>): Map<string, string> {
	const out = new Map(secondary);
	if (primary) for (const [k, v] of primary) out.set(k, v);
	return out;
}

/** Ranks for the disk canvas (file order), reusing base ranks first, then CRDT ranks. */
export function rankDisk(disk: CanvasSemanticData, base: CanvasRanked | null, crdt: CanvasRanked): CanvasRanked {
	const nodeRanks = reconcileCanvasRanks(disk.nodeOrder, union(base?.nodeRanks, crdt.nodeRanks)).ranks;
	const edgeRanks = reconcileCanvasRanks(disk.edgeOrder, union(base?.edgeRanks, crdt.edgeRanks)).ranks;
	return makeRanked(disk.rootFields, new Map(disk.nodes), nodeRanks, new Map(disk.edges), edgeRanks);
}

interface Work {
	readonly r: CanvasRanked;
	readonly nodes: Map<string, CanvasNode>;
	readonly nodeRanks: Map<string, string>;
	readonly edges: Map<string, CanvasEdge>;
	readonly edgeRanks: Map<string, string>;
}

function work(r: CanvasRanked): Work {
	return { r, nodes: new Map(r.data.nodes), nodeRanks: new Map(r.nodeRanks), edges: new Map(r.data.edges), edgeRanks: new Map(r.edgeRanks) };
}

function done(w: Work): CanvasRanked {
	return makeRanked(w.r.data.rootFields, w.nodes, w.nodeRanks, w.edges, w.edgeRanks);
}

/** Copy records of `src` that are in neither `base` nor `other` into every `into`. */
function oneSided(src: CanvasRanked, other: CanvasRanked, base: CanvasRanked, into: readonly Work[]): void {
	for (const [id, node] of src.data.nodes) {
		if (base.data.nodes.has(id) || other.data.nodes.has(id)) continue;
		const rank = src.nodeRanks.get(id);
		for (const w of into) {
			w.nodes.set(id, node);
			if (rank !== undefined) w.nodeRanks.set(id, rank);
		}
	}
	for (const [id, edge] of src.data.edges) {
		if (base.data.edges.has(id) || other.data.edges.has(id)) continue;
		const rank = src.edgeRanks.get(id);
		for (const w of into) {
			w.edges.set(id, edge);
			if (rank !== undefined) w.edgeRanks.set(id, rank);
		}
	}
}

/** The extension pre-step (header). */
export function extendOneSided(base: CanvasRanked, disk: CanvasRanked, crdt: CanvasRanked): { b: CanvasRanked; d: CanvasRanked; c: CanvasRanked } {
	const b = work(base);
	const d = work(disk);
	const c = work(crdt);
	oneSided(disk, crdt, base, [b, c]);
	oneSided(crdt, disk, base, [b, d]);
	return { b: done(b), d: done(d), c: done(c) };
}

export interface CanvasMergeInput {
	readonly base: CanvasRanked | null;
	readonly disk: CanvasSemanticData;
	/** Projection of the CRDT (visible canvas, known valid). */
	readonly crdt: CanvasProjection;
	readonly limits: MergeLimits;
}

export interface CanvasMergeOutput {
	readonly kind: MergeResult["kind"];
	readonly reason: ConflictReason | null;
	/** The disk side, ranked (S rebases on it when the final write fails). */
	readonly diskRanked: CanvasRanked;
	/** What the CRDT becomes (applyCanvas). */
	readonly target: CanvasRanked;
	/** Disk projection of the target (written unless its hash equals the disk's). */
	readonly projection: CanvasProjection;
}

export function mergeCanvasSides(input: CanvasMergeInput): CanvasMergeOutput {
	const { base, crdt, limits } = input;
	const diskRanked = rankDisk(input.disk, base, crdt.ranked);
	let b: CanvasRanked | null = null;
	let d = diskRanked;
	let c = crdt.ranked;
	if (base) ({ b, d, c } = extendOneSided(base, diskRanked, crdt.ranked));
	const dText = canvasToMergeText(d);
	const res = merge({ base: b ? canvasToMergeText(b) : null, disk: dText, crdt: canvasToMergeText(c), limits });
	const merged = res.kind === "identical" ? dText : res.text;
	const target = parseMergeText(merged);
	const projection = target ? projectRanked(target) : null;
	const reason = res.kind === "conflict" ? res.reason : null;
	if (target && projection?.ok) return { kind: res.kind, reason, diskRanked, target, projection };
	return { kind: "conflict", reason: reason ?? "both-edited", diskRanked, target: crdt.ranked, projection: crdt };
}
