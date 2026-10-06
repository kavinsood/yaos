/**
 * Canvas Y.Doc <-> JSON Canvas (DESIGN §j.2). Pure-ish: works on one Y.Doc,
 * no I/O. Used by the canvas merge job, materialize, intent resume, and by the
 * log side (streams.textHash of a canvas doc = canvasDocHash).
 *
 * Layout of a canvas doc ("c:<docId>"):
 *   Y.Map "nodes": id -> Y.Map of fields. Values are JSON (ContentAny) except a
 *                  text node's "text", which is a Y.Text. "rank" holds the
 *                  fractional order key (canvasOrdering). "id" is never stored
 *                  (the key is the id; a stray "id" field is ignored).
 *   Y.Map "edges": same shape.
 *   Y.Map "doc":   the other top-level keys (JSON values).
 *
 * Projection: nodes and edges sorted by (rank, id), dangling edges dropped
 * (they stay in the CRDT), bytes = JSON.stringify(_, null, "\t").
 *
 * Validation (§j.2): unique string ids (map keys / parse), node type in
 * {text, file, link, group}, numeric x / y / width / height (parseCanvasNode),
 * no record field named "rank" (it is the order key), CANVAS_LIMITS on the
 * projection. Decision: an unknown node type is invalid (parseCanvasNode alone
 * would accept it).
 *
 * applyCanvas is record-level: changed fields are set, a text node's Y.Text
 * gets a minimal diff, records are never replaced wholesale, removed records
 * are deleted, except edges that were already dangling before the apply (the
 * merge never saw them).
 */

import * as Y from "yjs";
import type { ContentHash } from "../../core/types";
import {
	CANVAS_LIMITS, canonicalJson, canvasEdgeJson, canvasJsonValue, canvasLogicalHash, canvasNodeJson, formatCanvasText,
	parseCanvasEdge, parseCanvasNode, parseCanvasText,
	type CanvasEdge, type CanvasNode, type CanvasRanked, type CanvasSemanticData, type JsonValue,
} from "../../core/hash/canvasCanonical";
import { orderedCanvasIds } from "../../core/hash/canvasOrdering";
import { applyEditsTo, minimalDiff } from "../../core/merge/minimalDiff";
import { utf8Encode } from "../../core/hash/utf8";

export const CANVAS_NODE_TYPES: ReadonlySet<string> = new Set(["text", "file", "link", "group"]);
export const CANVAS_RANK_FIELD = "rank";

export type CanvasRead = { readonly ok: true; readonly ranked: CanvasRanked } | { readonly ok: false; readonly reason: string };

export interface CanvasProjection {
	readonly ok: true;
	/** Visible canvas (dangling edges dropped), ordered by (rank, id). */
	readonly ranked: CanvasRanked;
	/** Disk text (tab indent) and its UTF-8 bytes. */
	readonly text: string;
	readonly bytes: Uint8Array;
	/** Logical ContentHash (== canvasContentHash(bytes)). */
	readonly hash: ContentHash;
}
export type CanvasProjectionResult = CanvasProjection | { readonly ok: false; readonly reason: string };

/** CanvasRanked with nodeOrder / edgeOrder in (rank, id) order. */
export function makeRanked(
	rootFields: Record<string, JsonValue>, nodes: Map<string, CanvasNode>, nodeRanks: Map<string, string>,
	edges: Map<string, CanvasEdge>, edgeRanks: Map<string, string>,
): CanvasRanked {
	return {
		data: { rootFields, nodes, nodeOrder: orderedCanvasIds(nodeRanks, nodes.keys()), edges, edgeOrder: orderedCanvasIds(edgeRanks, edges.keys()) },
		nodeRanks, edgeRanks,
	};
}

export function emptyCanvas(): CanvasRanked {
	return makeRanked(Object.create(null) as Record<string, JsonValue>, new Map(), new Map(), new Map(), new Map());
}

/** §j.2 checks parseCanvasNode / parseCanvasEdge do not make. null = ok, else the reason. */
export function checkCanvasRecords(data: CanvasSemanticData): string | null {
	for (const n of data.nodes.values()) {
		if (!CANVAS_NODE_TYPES.has(n.payload.type)) return `node ${n.id}: unknown type ${n.payload.type}`;
		if (Object.prototype.hasOwnProperty.call(n.extensions, CANVAS_RANK_FIELD)) return `node ${n.id}: field "rank"`;
	}
	for (const e of data.edges.values()) {
		if (Object.prototype.hasOwnProperty.call(e.extensions, CANVAS_RANK_FIELD)) return `edge ${e.id}: field "rank"`;
	}
	return null;
}

function readRecord(id: string, v: unknown): { raw: Record<string, unknown>; rank: string | null } | string {
	if (!(v instanceof Y.Map)) return `${id}: not a map`;
	const raw = Object.create(null) as Record<string, unknown>;
	let rank: string | null = null;
	for (const [k, x] of (v as Y.Map<unknown>).entries()) {
		if (k === "id") continue;
		if (k === CANVAS_RANK_FIELD) {
			if (typeof x !== "string" || x.length > CANVAS_LIMITS.rankBytes) return `${id}: bad rank`;
			rank = x;
			continue;
		}
		raw[k] = x instanceof Y.Text ? x.toString() : x instanceof Y.AbstractType ? x.toJSON() : x;
	}
	raw.id = id;
	return { raw, rank };
}

/** The whole canvas in the CRDT (dangling edges included), validated. */
export function readCanvas(doc: Y.Doc): CanvasRead {
	const nodes = new Map<string, CanvasNode>();
	const nodeRanks = new Map<string, string>();
	for (const [id, v] of doc.getMap<unknown>("nodes").entries()) {
		const rec = readRecord(id, v);
		if (typeof rec === "string") return { ok: false, reason: `node ${rec}` };
		const node = parseCanvasNode(rec.raw);
		if (!node) return { ok: false, reason: `node ${id}: invalid` };
		nodes.set(id, node);
		if (rec.rank !== null) nodeRanks.set(id, rec.rank);
	}
	const edges = new Map<string, CanvasEdge>();
	const edgeRanks = new Map<string, string>();
	for (const [id, v] of doc.getMap<unknown>("edges").entries()) {
		const rec = readRecord(id, v);
		if (typeof rec === "string") return { ok: false, reason: `edge ${rec}` };
		const edge = parseCanvasEdge(rec.raw);
		if (!edge) return { ok: false, reason: `edge ${id}: invalid` };
		edges.set(id, edge);
		if (rec.rank !== null) edgeRanks.set(id, rec.rank);
	}
	const rootFields = Object.create(null) as Record<string, JsonValue>;
	for (const [k, v] of doc.getMap<unknown>("doc").entries()) {
		if (k === "nodes" || k === "edges") return { ok: false, reason: `doc field ${k}` };
		const j = canvasJsonValue(v instanceof Y.AbstractType ? v.toJSON() : v);
		if (j === undefined) return { ok: false, reason: `doc field ${k}: not JSON` };
		rootFields[k] = j;
	}
	const ranked = makeRanked(rootFields, nodes, nodeRanks, edges, edgeRanks);
	const why = checkCanvasRecords(ranked.data);
	return why === null ? { ok: true, ranked } : { ok: false, reason: why };
}

/** Drop edges whose endpoints are not nodes (projection; the CRDT keeps them). */
export function visibleCanvas(r: CanvasRanked): CanvasRanked {
	const { data } = r;
	const edges = new Map<string, CanvasEdge>();
	const edgeRanks = new Map<string, string>();
	for (const [id, e] of data.edges) {
		if (!data.nodes.has(e.endpoints.fromNode) || !data.nodes.has(e.endpoints.toNode)) continue;
		edges.set(id, e);
		const rank = r.edgeRanks.get(id);
		if (rank !== undefined) edgeRanks.set(id, rank);
	}
	if (edges.size === data.edges.size) return r;
	return { data: { ...data, edges, edgeOrder: data.edgeOrder.filter((id) => edges.has(id)) }, nodeRanks: r.nodeRanks, edgeRanks };
}

/** Disk projection of a ranked canvas: visible part, formatted, limit-checked, hashed. */
export function projectRanked(r: CanvasRanked): CanvasProjectionResult {
	const visible = visibleCanvas(r);
	const why = checkCanvasRecords(visible.data);
	if (why !== null) return { ok: false, reason: why };
	const text = formatCanvasText(visible.data);
	const parsed = parseCanvasText(text);
	if (parsed.kind === "oversized") return { ok: false, reason: `oversized ${parsed.limit} ${parsed.measured} > ${parsed.maximum}` };
	if (parsed.kind === "invalid") return { ok: false, reason: parsed.reason };
	return { ok: true, ranked: visible, text, bytes: utf8Encode(text), hash: canvasLogicalHash(visible.data) };
}

/** Disk projection of the canvas doc. */
export function projectCanvasBytes(doc: Y.Doc): CanvasProjectionResult {
	const read = readCanvas(doc);
	return read.ok ? projectRanked(read.ranked) : read;
}

/** Logical hash of the doc's projection (streams.textHash of a canvas), null if invalid. */
export function canvasDocHash(doc: Y.Doc): ContentHash | null {
	const p = projectCanvasBytes(doc);
	return p.ok ? p.hash : null;
}

function sameJson(a: unknown, b: JsonValue): boolean {
	try {
		return canonicalJson(a as JsonValue) === canonicalJson(b);
	} catch {
		return false;
	}
}

/** Deep copy with plain prototypes: Yjs rejects null-prototype objects (the parser's) as map values. */
function plainJson(v: JsonValue): JsonValue {
	if (Array.isArray(v)) return v.map(plainJson);
	if (v !== null && typeof v === "object") {
		const out: { [key: string]: JsonValue } = {};
		for (const k of Object.keys(v)) out[k] = plainJson(v[k]!);
		return out;
	}
	return v;
}

/** Stored fields of a record: its JSON without "id", plus the rank. */
function storedFields(json: Record<string, JsonValue>, rank: string | undefined): Record<string, JsonValue> {
	delete json.id;
	if (rank !== undefined) json[CANVAS_RANK_FIELD] = rank;
	return json;
}

function syncFields(m: Y.Map<unknown>, want: Record<string, JsonValue>, textIsYText: boolean): number {
	let n = 0;
	for (const key of Object.keys(want)) {
		const value = want[key]!;
		const cur = m.get(key);
		if (textIsYText && key === "text" && typeof value === "string") {
			if (cur instanceof Y.Text) {
				const from = cur.toString();
				const edits = minimalDiff(from, value);
				if (edits.length > 0) {
					applyEditsTo(cur, from, edits);
					n++;
				}
			} else {
				const t = new Y.Text();
				m.set(key, t);
				t.insert(0, value);
				n++;
			}
			continue;
		}
		if (m.has(key) && !(cur instanceof Y.AbstractType) && sameJson(cur, value)) continue;
		m.set(key, plainJson(value));
		n++;
	}
	for (const key of [...m.keys()]) {
		if (Object.prototype.hasOwnProperty.call(want, key)) continue;
		m.delete(key);
		n++;
	}
	return n;
}

function syncRecords<T>(
	map: Y.Map<unknown>, want: ReadonlyMap<string, T>, order: readonly string[],
	fields: (rec: T) => Record<string, JsonValue>, textIsYText: (rec: T) => boolean, keep: ReadonlySet<string>,
): number {
	let n = 0;
	for (const id of order) {
		const rec = want.get(id);
		if (rec === undefined) continue;
		let m = map.get(id);
		if (!(m instanceof Y.Map)) {
			m = new Y.Map<unknown>();
			map.set(id, m); // integrate first, then fill (a Y.Text needs an integrated parent)
			n++;
		}
		n += syncFields(m as Y.Map<unknown>, fields(rec), textIsYText(rec));
	}
	for (const id of [...map.keys()]) {
		if (want.has(id) || keep.has(id)) continue;
		map.delete(id);
		n++;
	}
	return n;
}

function danglingEdgeIds(nodes: Y.Map<unknown>, edges: Y.Map<unknown>): Set<string> {
	const out = new Set<string>();
	for (const [id, v] of edges.entries()) {
		if (!(v instanceof Y.Map)) continue;
		const from = (v as Y.Map<unknown>).get("fromNode");
		const to = (v as Y.Map<unknown>).get("toNode");
		if (typeof from !== "string" || typeof to !== "string" || !nodes.has(from) || !nodes.has(to)) out.add(id);
	}
	return out;
}

/**
 * Bring the doc to `target` record by record in ONE transaction with `origin`.
 * Returns the number of map / text operations (0 = nothing changed).
 */
export function applyCanvas(doc: Y.Doc, origin: unknown, target: CanvasRanked): number {
	const nodes = doc.getMap<unknown>("nodes");
	const edges = doc.getMap<unknown>("edges");
	const root = doc.getMap<unknown>("doc");
	const { data } = target;
	let n = 0;
	doc.transact(() => {
		const keep = danglingEdgeIds(nodes, edges);
		n += syncRecords(nodes, data.nodes, data.nodeOrder, (node) => storedFields(canvasNodeJson(node), target.nodeRanks.get(node.id)),
			(node) => node.payload.type === "text", new Set());
		n += syncRecords(edges, data.edges, data.edgeOrder, (edge) => storedFields(canvasEdgeJson(edge), target.edgeRanks.get(edge.id)),
			() => false, keep);
		n += syncFields(root, data.rootFields, false);
	}, origin);
	return n;
}
