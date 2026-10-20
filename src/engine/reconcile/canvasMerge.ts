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
 *  - Edits to different records merge; edits to the same record (or an edit
 *    against a delete) conflict: the CRDT keeps its side of those records plus
 *    every disk change to the others, the job copies the disk file. When all
 *    three texts differ, the both-edited step of the merge resolves record by
 *    record (mergeRecordLines): a line diff3 joins adjacent changed lines into
 *    one hunk, so a conflict on one record would swallow the disk's edit of its
 *    neighbour (suite-1 seed 217).
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

/**
 * §c.12 deletes carried across an epoch change: `deleted` holds the record keys ("n:<id>" / "e:<id>") deleted in
 * the old epoch's doc at this path. A record the new epoch's CRDT has under such a key, and that neither the base
 * nor the disk has, is the old epoch's deleted record come back (a restore from before the delete, or a peer that
 * re-created the doc without having seen it). It is added to the base with the CRDT's line, so the merge reads the
 * disk side as having deleted it and the CRDT side as unchanged: the delete is applied again.
 */
export function withEpochDeletes(base: CanvasRanked, crdt: CanvasRanked, disk: CanvasSemanticData, deleted: ReadonlySet<string>): CanvasRanked {
	if (deleted.size === 0) return base;
	const nodes = new Map(base.data.nodes);
	const nodeRanks = new Map(base.nodeRanks);
	const edges = new Map(base.data.edges);
	const edgeRanks = new Map(base.edgeRanks);
	let added = 0;
	for (const [id, n] of crdt.data.nodes) {
		if (!deleted.has(`n:${id}`) || nodes.has(id) || disk.nodes.has(id)) continue;
		nodes.set(id, n);
		const r = crdt.nodeRanks.get(id);
		if (r !== undefined) nodeRanks.set(id, r);
		added++;
	}
	for (const [id, e] of crdt.data.edges) {
		if (!deleted.has(`e:${id}`) || edges.has(id) || disk.edges.has(id)) continue;
		edges.set(id, e);
		const r = crdt.edgeRanks.get(id);
		if (r !== undefined) edgeRanks.set(id, r);
		added++;
	}
	return added === 0 ? base : makeRanked(base.data.rootFields, nodes, nodeRanks, edges, edgeRanks);
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

/**
 * Process-wide counters of mergeCanvasSides (diagnostics only; the simulator reads them around a run). `divergent`:
 * base, disk and CRDT all differ after the extension pre-step (a real 3-way merge); `rejected`: a merged text that
 * did not validate became a conflict.
 */
export const canvasMergeStats = { merges: 0, divergent: 0, clean: 0, oneSided: 0, conflict: 0, identical: 0, rejected: 0 };

export function mergeCanvasSides(input: CanvasMergeInput): CanvasMergeOutput {
	const { base, crdt, limits } = input;
	const diskRanked = rankDisk(input.disk, base, crdt.ranked);
	let b: CanvasRanked | null = null;
	let d = diskRanked;
	let c = crdt.ranked;
	if (base) ({ b, d, c } = extendOneSided(base, diskRanked, crdt.ranked));
	const dText = canvasToMergeText(d);
	const bText = b ? canvasToMergeText(b) : null;
	const cText = canvasToMergeText(c);
	let res = merge({ base: bText, disk: dText, crdt: cText, limits });
	if (bText !== null && (res.kind === "clean" || (res.kind === "conflict" && res.reason === "both-edited"))) res = mergeRecordLines(bText, dText, cText);
	const stats = canvasMergeStats;
	stats.merges++;
	if (bText !== null && dText !== bText && cText !== bText && dText !== cText) stats.divergent++;
	const merged = res.kind === "identical" ? dText : res.text;
	const target = parseMergeText(merged);
	const projection = target ? projectRanked(target) : null;
	const reason = res.kind === "conflict" ? res.reason : null;
	if (target && projection?.ok) {
		if (res.kind === "identical") stats.identical++;
		else if (res.kind === "conflict") stats.conflict++;
		else if (res.kind === "clean") stats.clean++;
		else stats.oneSided++;
		return { kind: res.kind, reason, diskRanked, target, projection };
	}
	stats.rejected++;
	stats.conflict++;
	return { kind: "conflict", reason: reason ?? "both-edited", diskRanked, target: crdt.ranked, projection: crdt };
}

/** Merge-text line -> its record key ("n:" / "e:" + id, or "doc"); null when malformed. */
function lineKey(line: string): string | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as { node?: { id?: unknown }; edge?: { id?: unknown }; doc?: unknown };
	if (o.node && typeof o.node.id === "string") return `n:${o.node.id}`;
	if (o.edge && typeof o.edge.id === "string") return `e:${o.edge.id}`;
	return o.doc !== undefined ? "doc" : null;
}

function recordLines(text: string): Map<string, string> | null {
	const out = new Map<string, string>();
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const k = lineKey(line);
		if (k === null || out.has(k)) return null;
		out.set(k, line);
	}
	return out;
}

/**
 * The both-edited step for canvases (header): a 3-way merge per record line, keyed by record id (a line holds the
 * record and its rank). A record one side changed (or deleted, or added) and the other kept takes that side; one
 * both sides changed differently conflicts and keeps the CRDT's line. Lines come out nodes, edges, root (the parse
 * orders by rank). Unparseable text keeps the CRDT, as a conflict.
 */
export function mergeRecordLines(base: string, disk: string, crdt: string): MergeResult {
	const b = recordLines(base);
	const d = recordLines(disk);
	const c = recordLines(crdt);
	if (!b || !d || !c) return { kind: "conflict", text: crdt, conflictCopy: disk, reason: "both-edited" };
	let conflict = false;
	const out: string[] = [];
	for (const k of new Set([...b.keys(), ...d.keys(), ...c.keys()])) {
		const lb = b.get(k);
		const ld = d.get(k);
		const lc = c.get(k);
		let line: string | undefined;
		if (ld === lc || ld === lb) line = lc;
		else if (lc === lb) line = ld;
		else {
			conflict = true;
			line = lc;
		}
		if (line !== undefined) out.push(line);
	}
	const order = (l: string): number => (l.startsWith('{"node"') ? 0 : l.startsWith('{"edge"') ? 1 : 2);
	const text = out.sort((x, y) => order(x) - order(y)).map((l) => `${l}\n`).join("");
	return conflict ? { kind: "conflict", text, conflictCopy: disk, reason: "both-edited" } : { kind: "clean", text };
}
