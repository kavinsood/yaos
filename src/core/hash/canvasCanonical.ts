/**
 * Canvas canonical form (ported from server/src/shared/canvasCodec.ts,
 * canvasTypes.ts, canvasLimits.ts). DESIGN §j.2.
 *
 *  - parseCanvasBytes: strict JSON Canvas parse + validation + limits.
 *  - canonicalCanvasBytes: the logical form hashed as the canvas ContentHash
 *    (sorted keys, -0 -> 0, dangling edges dropped).
 *  - formatCanvasBytes: Obsidian's disk formatting, JSON.stringify(_, null, "\t")
 *    (DESIGN §j.2; legacy used 2 spaces + "\n", see wp-b-notes deviations).
 *  - canvasToMergeText / canvasFromMergeText: the record-per-line text the ONE
 *    MergeFn runs over (first line = root fields, then one line per node and per
 *    edge in (rank, id) order).
 */

import type { ContentHash } from "../types";
import { sha256Hex } from "./sha256";
import { utf8Decode, utf8Encode, utf8Length } from "./utf8";
import { compareRank, initialCanvasRanks } from "./canvasOrdering";

export const CANVAS_CODEC = "json-canvas-canonical-v1" as const;

export const CANVAS_LIMITS = Object.freeze({
	canonicalBytes: 1024 * 1024,
	nodes: 20_000,
	edges: 40_000,
	textBytes: 256 * 1024,
	aggregateTextBytes: 1024 * 1024,
	jsonDepth: 32,
	identifierBytes: 1024,
	rankBytes: 128,
	unknownValueBytes: 256 * 1024,
});
export type CanvasLimitName = keyof typeof CANVAS_LIMITS;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = Record<string, JsonValue>;

export interface CanvasPosition { x: number; y: number }
export interface CanvasSize { width: number; height: number }
export interface CanvasTextPayload { type: "text" }
export interface CanvasFilePayload { type: "file"; file: string; subpath?: string }
export interface CanvasLinkPayload { type: "link"; url: string }
export interface CanvasGroupPayload { type: "group"; label?: string; background?: string; backgroundStyle?: string }
export interface CanvasUnknownPayload { type: string; fields: Record<string, JsonValue> }
export type CanvasNodePayload = CanvasTextPayload | CanvasFilePayload | CanvasLinkPayload | CanvasGroupPayload | CanvasUnknownPayload;

export interface CanvasNode {
	id: string;
	payload: CanvasNodePayload;
	position: CanvasPosition;
	size: CanvasSize;
	text?: string;
	color?: string;
	extensions: Record<string, JsonValue>;
}
export interface CanvasEdge {
	id: string;
	endpoints: { fromNode: string; fromSide?: string; toNode: string; toSide?: string };
	decorations: { fromEnd?: string; toEnd?: string };
	color?: string;
	label?: string;
	extensions: Record<string, JsonValue>;
}
export interface CanvasSemanticData {
	rootFields: Record<string, JsonValue>;
	nodes: Map<string, CanvasNode>;
	nodeOrder: string[];
	edges: Map<string, CanvasEdge>;
	edgeOrder: string[];
}

export type CanvasParseReason =
	| "invalid_json" | "root_not_object" | "nodes_not_array" | "edges_not_array"
	| "duplicate_node_id" | "duplicate_edge_id" | "invalid_node" | "invalid_edge"
	| "dangling_edge" | "invalid_json_value" | "limit_exceeded" | "invalid_line";

export type CanvasParseResult =
	| { kind: "valid"; data: CanvasSemanticData; canonicalBytes: Uint8Array }
	| { kind: "invalid"; reason: CanvasParseReason; detail?: string }
	| { kind: "oversized"; reason: "limit_exceeded"; limit: CanvasLimitName; measured: number; maximum: number };

const NODE_BASE_FIELDS = new Set(["id", "type", "x", "y", "width", "height", "color"]);
const EDGE_FIELDS = new Set(["id", "fromNode", "fromSide", "toNode", "toSide", "fromEnd", "toEnd", "color", "label"]);
const TYPE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
	text: new Set(["text"]),
	file: new Set(["file", "subpath"]),
	link: new Set(["url"]),
	group: new Set(["label", "background", "backgroundStyle"]),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function own(value: Record<string, unknown>, key: string): unknown {
	return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}
function validFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
function validString(value: unknown): value is string {
	return typeof value === "string";
}

function checkedJsonValue(value: unknown, depth = 0): JsonValue | undefined {
	if (depth > CANVAS_LIMITS.jsonDepth) return undefined;
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) {
		const result: JsonValue[] = [];
		for (const entry of value) {
			const checked = checkedJsonValue(entry, depth + 1);
			if (checked === undefined) return undefined;
			result.push(checked);
		}
		return result;
	}
	if (!isRecord(value)) return undefined;
	const result = Object.create(null) as JsonObject;
	for (const key of Object.keys(value)) {
		const checked = checkedJsonValue(value[key], depth + 1);
		if (checked === undefined) return undefined;
		result[key] = checked;
	}
	return result;
}

function oversized(limit: CanvasLimitName, measured: number): CanvasParseResult {
	return { kind: "oversized", reason: "limit_exceeded", limit, measured, maximum: CANVAS_LIMITS[limit] };
}
function invalid(reason: CanvasParseReason, detail?: string): CanvasParseResult {
	return detail !== undefined ? { kind: "invalid", reason, detail } : { kind: "invalid", reason };
}
function validateId(value: unknown): value is string {
	return validString(value) && value.length > 0 && utf8Length(value) <= CANVAS_LIMITS.identifierBytes;
}

export function parseCanvasNode(raw: Record<string, unknown>): CanvasNode | null {
	const id = own(raw, "id");
	const type = own(raw, "type");
	const x = own(raw, "x");
	const y = own(raw, "y");
	const width = own(raw, "width");
	const height = own(raw, "height");
	if (!validateId(id) || !validString(type) || type.length === 0
		|| !validFinite(x) || !validFinite(y) || !validFinite(width) || !validFinite(height)
		|| width < 0 || height < 0) return null;
	let payload: CanvasNodePayload;
	if (type === "text") {
		if (!validString(own(raw, "text"))) return null;
		payload = { type };
	} else if (type === "file") {
		const file = own(raw, "file");
		const subpath = own(raw, "subpath");
		if (!validString(file) || (subpath !== undefined && !validString(subpath))) return null;
		payload = { type, file, ...(subpath !== undefined ? { subpath } : {}) };
	} else if (type === "link") {
		const url = own(raw, "url");
		if (!validString(url)) return null;
		payload = { type, url };
	} else if (type === "group") {
		const label = own(raw, "label");
		const background = own(raw, "background");
		const backgroundStyle = own(raw, "backgroundStyle");
		if ((label !== undefined && !validString(label)) || (background !== undefined && !validString(background))
			|| (backgroundStyle !== undefined && !validString(backgroundStyle))) return null;
		payload = {
			type,
			...(label !== undefined ? { label } : {}),
			...(background !== undefined ? { background } : {}),
			...(backgroundStyle !== undefined ? { backgroundStyle } : {}),
		};
	} else {
		const fields = Object.create(null) as Record<string, JsonValue>;
		for (const key of Object.keys(raw)) {
			if (NODE_BASE_FIELDS.has(key)) continue;
			const value = checkedJsonValue(raw[key]);
			if (value === undefined) return null;
			fields[key] = value;
		}
		payload = { type, fields };
	}
	const typeFields = TYPE_FIELDS[type];
	const known = typeFields !== undefined ? new Set([...NODE_BASE_FIELDS, ...typeFields]) : new Set(Object.keys(raw));
	const extensions = Object.create(null) as Record<string, JsonValue>;
	for (const key of Object.keys(raw)) {
		if (known.has(key)) continue;
		const value = checkedJsonValue(raw[key]);
		if (value === undefined) return null;
		extensions[key] = value;
	}
	const color = own(raw, "color");
	if (color !== undefined && !validString(color)) return null;
	return {
		id, payload, position: { x, y }, size: { width, height },
		...(type === "text" ? { text: own(raw, "text") as string } : {}),
		...(color !== undefined ? { color } : {}),
		extensions,
	};
}

export function parseCanvasEdge(raw: Record<string, unknown>): CanvasEdge | null {
	const id = own(raw, "id");
	const fromNode = own(raw, "fromNode");
	const toNode = own(raw, "toNode");
	const fromSide = own(raw, "fromSide");
	const toSide = own(raw, "toSide");
	const fromEnd = own(raw, "fromEnd");
	const toEnd = own(raw, "toEnd");
	const color = own(raw, "color");
	const label = own(raw, "label");
	if (!validateId(id) || !validateId(fromNode) || !validateId(toNode)
		|| (fromSide !== undefined && !validString(fromSide)) || (toSide !== undefined && !validString(toSide))
		|| (fromEnd !== undefined && !validString(fromEnd)) || (toEnd !== undefined && !validString(toEnd))
		|| (color !== undefined && !validString(color)) || (label !== undefined && !validString(label))) return null;
	const extensions = Object.create(null) as Record<string, JsonValue>;
	for (const key of Object.keys(raw)) {
		if (EDGE_FIELDS.has(key)) continue;
		const value = checkedJsonValue(raw[key]);
		if (value === undefined) return null;
		extensions[key] = value;
	}
	return {
		id,
		endpoints: {
			fromNode, toNode,
			...(fromSide !== undefined ? { fromSide } : {}),
			...(toSide !== undefined ? { toSide } : {}),
		},
		decorations: {
			...(fromEnd !== undefined ? { fromEnd } : {}),
			...(toEnd !== undefined ? { toEnd } : {}),
		},
		...(color !== undefined ? { color } : {}),
		...(label !== undefined ? { label } : {}),
		extensions,
	};
}

export function canvasNodeJson(node: CanvasNode): JsonObject {
	const result = Object.create(null) as JsonObject;
	result.id = node.id;
	result.type = node.payload.type;
	result.x = node.position.x;
	result.y = node.position.y;
	result.width = node.size.width;
	result.height = node.size.height;
	if (node.color !== undefined) result.color = node.color;
	const payload = node.payload;
	if ("fields" in payload) Object.assign(result, payload.fields);
	else if (payload.type === "text") result.text = node.text ?? "";
	else if (payload.type === "file" && "file" in payload) {
		result.file = payload.file;
		if (payload.subpath !== undefined) result.subpath = payload.subpath;
	} else if (payload.type === "link" && "url" in payload) result.url = payload.url;
	else if (payload.type === "group") {
		const group = payload as CanvasGroupPayload;
		if (group.label !== undefined) result.label = group.label;
		if (group.background !== undefined) result.background = group.background;
		if (group.backgroundStyle !== undefined) result.backgroundStyle = group.backgroundStyle;
	}
	Object.assign(result, node.extensions);
	return result;
}

export function canvasEdgeJson(edge: CanvasEdge): JsonObject {
	const result = Object.create(null) as JsonObject;
	result.id = edge.id;
	result.fromNode = edge.endpoints.fromNode;
	result.toNode = edge.endpoints.toNode;
	if (edge.endpoints.fromSide !== undefined) result.fromSide = edge.endpoints.fromSide;
	if (edge.endpoints.toSide !== undefined) result.toSide = edge.endpoints.toSide;
	if (edge.decorations.fromEnd !== undefined) result.fromEnd = edge.decorations.fromEnd;
	if (edge.decorations.toEnd !== undefined) result.toEnd = edge.decorations.toEnd;
	if (edge.color !== undefined) result.color = edge.color;
	if (edge.label !== undefined) result.label = edge.label;
	Object.assign(result, edge.extensions);
	return result;
}

export function canvasToJson(data: CanvasSemanticData, includeDanglingEdges = false): JsonObject {
	const result = Object.assign(Object.create(null), data.rootFields) as JsonObject;
	result.nodes = data.nodeOrder.flatMap((id) => {
		const node = data.nodes.get(id);
		return node ? [canvasNodeJson(node)] : [];
	});
	result.edges = data.edgeOrder.flatMap((id) => {
		const edge = data.edges.get(id);
		if (!edge || (!includeDanglingEdges && (!data.nodes.has(edge.endpoints.fromNode) || !data.nodes.has(edge.endpoints.toNode)))) return [];
		return [canvasEdgeJson(edge)];
	});
	return result;
}

/** Sorted keys, -0 -> 0, no whitespace. */
export function canonicalJson(value: JsonValue): string {
	if (value === null || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("non-finite JSON number");
		return Object.is(value, -0) ? "0" : JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

export function canonicalCanvasBytes(data: CanvasSemanticData): Uint8Array {
	return utf8Encode(canonicalJson(canvasToJson(data)));
}

/** Ported as-is: `{"item":<node|edge json>,"orderRank":rank}`. */
export function canonicalCanvasItemBytes(item: CanvasNode | CanvasEdge, orderRank: string | null): Uint8Array {
	const value: JsonObject = "position" in item
		? { item: canvasNodeJson(item), orderRank }
		: { item: canvasEdgeJson(item), orderRank };
	return utf8Encode(canonicalJson(value));
}

/** Obsidian's on-disk formatting (tab indent, no trailing newline). */
export function formatCanvasText(data: CanvasSemanticData): string {
	return JSON.stringify(canvasToJson(data), null, "\t");
}
export function formatCanvasBytes(data: CanvasSemanticData): Uint8Array {
	return utf8Encode(formatCanvasText(data));
}

export function parseCanvasText(text: string): CanvasParseResult {
	let raw: unknown;
	try {
		const trimmed = (text.startsWith("\uFEFF") ? text.slice(1) : text).trim();
		raw = trimmed === "" ? {} : JSON.parse(trimmed);
	} catch {
		return invalid("invalid_json");
	}
	return parseCanvasValue(raw);
}

export function parseCanvasBytes(bytes: Uint8Array): CanvasParseResult {
	if (bytes.byteLength > CANVAS_LIMITS.canonicalBytes * 2) return oversized("canonicalBytes", bytes.byteLength);
	const text = utf8Decode(bytes, true);
	if (text === null) return invalid("invalid_json");
	return parseCanvasText(text);
}

function parseCanvasValue(raw: unknown): CanvasParseResult {
	if (!isRecord(raw)) return invalid("root_not_object");
	const rawNodes = own(raw, "nodes") ?? [];
	const rawEdges = own(raw, "edges") ?? [];
	if (!Array.isArray(rawNodes)) return invalid("nodes_not_array");
	if (!Array.isArray(rawEdges)) return invalid("edges_not_array");
	if (rawNodes.length > CANVAS_LIMITS.nodes) return oversized("nodes", rawNodes.length);
	if (rawEdges.length > CANVAS_LIMITS.edges) return oversized("edges", rawEdges.length);
	const rootFields = Object.create(null) as Record<string, JsonValue>;
	for (const key of Object.keys(raw)) {
		if (key === "nodes" || key === "edges") continue;
		const value = checkedJsonValue(raw[key]);
		if (value === undefined) return invalid("invalid_json_value", key);
		const size = utf8Length(canonicalJson(value));
		if (size > CANVAS_LIMITS.unknownValueBytes) return oversized("unknownValueBytes", size);
		rootFields[key] = value;
	}
	const nodes = new Map<string, CanvasNode>();
	const nodeOrder: string[] = [];
	let aggregateTextBytes = 0;
	for (const entry of rawNodes) {
		if (!isRecord(entry)) return invalid("invalid_node");
		const node = parseCanvasNode(entry);
		if (!node) return invalid("invalid_node", validString(entry.id) ? entry.id : undefined);
		if (nodes.has(node.id)) return invalid("duplicate_node_id", node.id);
		if (node.text !== undefined) {
			const measured = utf8Length(node.text);
			if (measured > CANVAS_LIMITS.textBytes) return oversized("textBytes", measured);
			aggregateTextBytes += measured;
		}
		nodes.set(node.id, node);
		nodeOrder.push(node.id);
	}
	if (aggregateTextBytes > CANVAS_LIMITS.aggregateTextBytes) return oversized("aggregateTextBytes", aggregateTextBytes);
	const edges = new Map<string, CanvasEdge>();
	const edgeOrder: string[] = [];
	for (const entry of rawEdges) {
		if (!isRecord(entry)) return invalid("invalid_edge");
		const edge = parseCanvasEdge(entry);
		if (!edge) return invalid("invalid_edge", validString(entry.id) ? entry.id : undefined);
		if (edges.has(edge.id)) return invalid("duplicate_edge_id", edge.id);
		if (!nodes.has(edge.endpoints.fromNode) || !nodes.has(edge.endpoints.toNode)) return invalid("dangling_edge", edge.id);
		edges.set(edge.id, edge);
		edgeOrder.push(edge.id);
	}
	const data: CanvasSemanticData = { rootFields, nodes, nodeOrder, edges, edgeOrder };
	const canonicalBytes = canonicalCanvasBytes(data);
	if (canonicalBytes.byteLength > CANVAS_LIMITS.canonicalBytes) return oversized("canonicalBytes", canonicalBytes.byteLength);
	return { kind: "valid", data, canonicalBytes };
}

/**
 * Logical hash of canvas file bytes. Invalid or oversized canvases fall back to
 * the hash of the exact bytes (they are frozen/not merged anyway; the hash only
 * has to be stable).
 */
export function canvasContentHash(bytes: Uint8Array): ContentHash {
	const parsed = parseCanvasBytes(bytes);
	return sha256Hex(parsed.kind === "valid" ? parsed.canonicalBytes : bytes) as ContentHash;
}

// ---------------------------------------------------------------------------
// Merge text: one record per line (DESIGN §j.2)
// ---------------------------------------------------------------------------

export interface CanvasRanked {
	readonly data: CanvasSemanticData;
	/** id -> fractional rank (canvasOrdering). Missing ids sort first by id. */
	readonly nodeRanks: ReadonlyMap<string, string>;
	readonly edgeRanks: ReadonlyMap<string, string>;
}

/** Assign initial ranks in file order (used for disk canvases that carry no ranks). */
export function rankCanvasInFileOrder(data: CanvasSemanticData): CanvasRanked {
	return { data, nodeRanks: initialCanvasRanks(data.nodeOrder), edgeRanks: initialCanvasRanks(data.edgeOrder) };
}

function rankedIds(ids: Iterable<string>, ranks: ReadonlyMap<string, string>): string[] {
	return [...ids].sort((a, b) => compareRank(ranks.get(a) ?? "", ranks.get(b) ?? "") || compareRank(a, b));
}

/**
 * Line 1: {"doc":{...root fields}}. Then {"node":{...},"rank":r} per node and
 * {"edge":{...},"rank":r} per edge, each sorted by (rank, id). Every line ends
 * with "\n". JSON escapes newlines, so a record is always exactly one line.
 */
export function canvasToMergeText(ranked: CanvasRanked): string {
	const { data } = ranked;
	const lines: string[] = [canonicalJson({ doc: Object.assign(Object.create(null), data.rootFields) as JsonObject })];
	for (const id of rankedIds(data.nodes.keys(), ranked.nodeRanks)) {
		lines.push(canonicalJson({ node: canvasNodeJson(data.nodes.get(id)!), rank: ranked.nodeRanks.get(id) ?? null }));
	}
	for (const id of rankedIds(data.edges.keys(), ranked.edgeRanks)) {
		lines.push(canonicalJson({ edge: canvasEdgeJson(data.edges.get(id)!), rank: ranked.edgeRanks.get(id) ?? null }));
	}
	return lines.map((line) => `${line}\n`).join("");
}

/**
 * Parse + validate merge text. Returns null if any line is malformed, ids
 * repeat, a node/edge is invalid, or the doc line is missing/duplicated.
 * Dangling edges are accepted (the CRDT keeps them; projection drops them).
 */
export function canvasFromMergeText(text: string): CanvasRanked | null {
	const rootFields = Object.create(null) as Record<string, JsonValue>;
	const nodes = new Map<string, CanvasNode>();
	const edges = new Map<string, CanvasEdge>();
	const nodeRanks = new Map<string, string>();
	const edgeRanks = new Map<string, string>();
	let sawDoc = false;
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	for (const line of lines) {
		let raw: unknown;
		try { raw = JSON.parse(line); } catch { return null; }
		if (!isRecord(raw)) return null;
		const keys = Object.keys(raw);
		if (keys.length === 1 && keys[0] === "doc") {
			if (sawDoc) return null;
			sawDoc = true;
			const doc = checkedJsonValue(raw.doc);
			if (doc === undefined || !isRecord(doc)) return null;
			for (const key of Object.keys(doc)) {
				if (key === "nodes" || key === "edges") return null;
				rootFields[key] = (doc as JsonObject)[key]!;
			}
			continue;
		}
		const rank = own(raw, "rank");
		if (rank !== null && (typeof rank !== "string" || rank.length > CANVAS_LIMITS.rankBytes)) return null;
		const nodeRaw = own(raw, "node");
		const edgeRaw = own(raw, "edge");
		if (keys.length !== 2) return null;
		if (isRecord(nodeRaw)) {
			const node = parseCanvasNode(nodeRaw);
			if (!node || nodes.has(node.id)) return null;
			nodes.set(node.id, node);
			if (typeof rank === "string") nodeRanks.set(node.id, rank);
		} else if (isRecord(edgeRaw)) {
			const edge = parseCanvasEdge(edgeRaw);
			if (!edge || edges.has(edge.id)) return null;
			edges.set(edge.id, edge);
			if (typeof rank === "string") edgeRanks.set(edge.id, rank);
		} else return null;
	}
	if (!sawDoc) return null;
	const data: CanvasSemanticData = {
		rootFields,
		nodes,
		nodeOrder: rankedIds(nodes.keys(), nodeRanks),
		edges,
		edgeOrder: rankedIds(edges.keys(), edgeRanks),
	};
	return { data, nodeRanks, edgeRanks };
}
