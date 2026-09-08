import * as Y from "yjs";
import { CANVAS_LIMITS } from "./canvasLimits";
import { canonicalCanvasBytes, canonicalCanvasItemBytes, parseCanvasBytes } from "./canvasCodec";
import { initialCanvasRanks, orderedCanvasIds, reconcileCanvasRanks } from "./canvasOrdering";
import {
	CANVAS_REPRESENTATION_VERSION, JSON_CANVAS_VERSION, type CanvasEdge, type CanvasItemTombstone,
	type CanvasNode, type CanvasResolvedConflict, type CanvasSemanticData, type JsonValue,
} from "./canvasTypes";

const ABSENT = { yaosCanvasAbsent: true };

type ItemKind = "node" | "edge";
type ItemMap = Y.Map<unknown>;

function isAbsent(value: unknown): boolean {
	return value !== null && typeof value === "object"
		&& (value as { yaosCanvasAbsent?: unknown }).yaosCanvasAbsent === true;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return Object.create(null) as Record<string, JsonValue>;
	return value as Record<string, JsonValue>;
}

function yJson(value: JsonValue): JsonValue {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(yJson);
	const result: Record<string, JsonValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		Object.defineProperty(result, key, { value: yJson(entry), enumerable: true, configurable: true, writable: true });
	}
	return result;
}

function equalJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && left.length === right.length
			&& left.every((entry, index) => equalJson(entry, right[index]));
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
	return [...keys].every((key) => equalJson(leftRecord[key], rightRecord[key]));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const owned = new Uint8Array(bytes.byteLength);
	owned.set(bytes);
	const digest = await crypto.subtle.digest("SHA-256", owned.buffer);
	return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function setOptional(map: ItemMap, key: string, value: string | undefined): void {
	const target = value === undefined ? ABSENT : value;
	if (!equalJson(map.get(key), target)) map.set(key, target);
}

function replaceExtensions(map: ItemMap, extensions: Record<string, JsonValue>): void {
	let target = map.get("extensions");
	if (!(target instanceof Y.Map)) {
		target = new Y.Map<JsonValue>();
		map.set("extensions", target);
	}
	const extensionMap = target as Y.Map<JsonValue>;
	for (const key of [...extensionMap.keys()]) if (!(key in extensions)) extensionMap.delete(key);
	for (const [key, value] of Object.entries(extensions)) {
		if (!equalJson(extensionMap.get(key), value)) extensionMap.set(key, yJson(value));
	}
}

function setText(map: ItemMap, value: string): void {
	let target = map.get("text");
	if (!(target instanceof Y.Text)) {
		target = new Y.Text();
		map.set("text", target);
	}
	const text = target as Y.Text;
	if (text.toString() === value) return;
	text.delete(0, text.length);
	if (value.length > 0) text.insert(0, value);
}

function writeNode(map: ItemMap, node: CanvasNode): void {
	if (!equalJson(map.get("payload"), node.payload)) map.set("payload", yJson(node.payload as unknown as JsonValue));
	if (!equalJson(map.get("position"), node.position)) map.set("position", yJson(node.position as unknown as JsonValue));
	if (!equalJson(map.get("size"), node.size)) map.set("size", yJson(node.size as unknown as JsonValue));
	setOptional(map, "color", node.color);
	if (node.payload.type === "text") setText(map, node.text ?? "");
	else if (map.has("text")) map.delete("text");
	replaceExtensions(map, node.extensions);
}

function writeEdge(map: ItemMap, edge: CanvasEdge): void {
	if (!equalJson(map.get("endpoints"), edge.endpoints)) map.set("endpoints", yJson(edge.endpoints as unknown as JsonValue));
	if (!equalJson(map.get("decorations"), edge.decorations)) map.set("decorations", yJson(edge.decorations as unknown as JsonValue));
	setOptional(map, "color", edge.color);
	setOptional(map, "label", edge.label);
	replaceExtensions(map, edge.extensions);
}

function readExtensions(map: ItemMap): Record<string, JsonValue> {
	const source = map.get("extensions");
	const result = Object.create(null) as Record<string, JsonValue>;
	if (!(source instanceof Y.Map)) return result;
	for (const [key, value] of source.entries()) result[key] = value as JsonValue;
	return result;
}

function readNode(id: string, map: ItemMap): CanvasNode | null {
	const payload = jsonRecord(map.get("payload")) as unknown as CanvasNode["payload"];
	const position = jsonRecord(map.get("position"));
	const size = jsonRecord(map.get("size"));
	if (typeof payload.type !== "string" || typeof position.x !== "number" || typeof position.y !== "number"
		|| typeof size.width !== "number" || typeof size.height !== "number") return null;
	const text = map.get("text");
	const color = map.get("color");
	return { id, payload, position: { x: position.x, y: position.y }, size: { width: size.width, height: size.height },
		...(payload.type === "text" ? { text: text instanceof Y.Text ? text.toString() : "" } : {}),
		...(!isAbsent(color) && typeof color === "string" ? { color } : {}), extensions: readExtensions(map) };
}

function readEdge(id: string, map: ItemMap): CanvasEdge | null {
	const endpoints = jsonRecord(map.get("endpoints"));
	const decorations = jsonRecord(map.get("decorations"));
	if (typeof endpoints.fromNode !== "string" || typeof endpoints.toNode !== "string") return null;
	const color = map.get("color");
	const label = map.get("label");
	return { id, endpoints: {
		fromNode: endpoints.fromNode, toNode: endpoints.toNode,
		...(typeof endpoints.fromSide === "string" ? { fromSide: endpoints.fromSide } : {}),
		...(typeof endpoints.toSide === "string" ? { toSide: endpoints.toSide } : {}),
	}, decorations: {
		...(typeof decorations.fromEnd === "string" ? { fromEnd: decorations.fromEnd } : {}),
		...(typeof decorations.toEnd === "string" ? { toEnd: decorations.toEnd } : {}),
	}, ...(!isAbsent(color) && typeof color === "string" ? { color } : {}),
		...(!isAbsent(label) && typeof label === "string" ? { label } : {}), extensions: readExtensions(map) };
}

function roots(doc: Y.Doc): {
	meta: Y.Map<unknown>; rootFields: Y.Map<JsonValue>; nodes: Y.Map<ItemMap>; nodeOrder: Y.Map<string>;
	nodeTombstones: Y.Map<CanvasItemTombstone>; edges: Y.Map<ItemMap>; edgeOrder: Y.Map<string>;
	edgeTombstones: Y.Map<CanvasItemTombstone>; resolvedConflicts: Y.Map<CanvasResolvedConflict>;
} {
	return {
		meta: doc.getMap("canvasMeta"), rootFields: doc.getMap("rootFields"), nodes: doc.getMap("nodes"),
		nodeOrder: doc.getMap("nodeOrder"), nodeTombstones: doc.getMap("nodeTombstones"),
		edges: doc.getMap("edges"), edgeOrder: doc.getMap("edgeOrder"), edgeTombstones: doc.getMap("edgeTombstones"),
		resolvedConflicts: doc.getMap("resolvedConflicts"),
	};
}

export function initializeCanvasDocument(doc: Y.Doc): void {
	const value = roots(doc);
	doc.transact(() => {
		value.meta.set("format", "yaos-json-canvas");
		value.meta.set("representationVersion", CANVAS_REPRESENTATION_VERSION);
		value.meta.set("jsonCanvasVersion", JSON_CANVAS_VERSION);
		value.meta.set("enrolled", true);
	}, "canvas-initialize");
}

export function createCanvasDocument(data?: CanvasSemanticData): Y.Doc {
	const doc = new Y.Doc();
	initializeCanvasDocument(doc);
	if (data) importCanvasData(doc, data);
	return doc;
}

export function importCanvasData(doc: Y.Doc, data: CanvasSemanticData, origin: unknown = "canvas-import"): void {
	const value = roots(doc);
	const nodeRanks = initialCanvasRanks(data.nodeOrder);
	const edgeRanks = initialCanvasRanks(data.edgeOrder);
	doc.transact(() => {
		initializeCanvasDocument(doc);
		for (const key of [...value.rootFields.keys()]) if (!(key in data.rootFields)) value.rootFields.delete(key);
		for (const [key, field] of Object.entries(data.rootFields)) {
			if (!equalJson(value.rootFields.get(key), field)) value.rootFields.set(key, yJson(field));
		}
		for (const key of [...value.nodes.keys()]) if (!data.nodes.has(key)) value.nodes.delete(key);
		for (const [id, node] of data.nodes) {
			let map = value.nodes.get(id);
			if (!(map instanceof Y.Map)) { map = new Y.Map(); value.nodes.set(id, map); }
			writeNode(map, node);
		}
		for (const key of [...value.edges.keys()]) if (!data.edges.has(key)) value.edges.delete(key);
		for (const [id, edge] of data.edges) {
			let map = value.edges.get(id);
			if (!(map instanceof Y.Map)) { map = new Y.Map(); value.edges.set(id, map); }
			writeEdge(map, edge);
		}
		for (const key of [...value.nodeOrder.keys()]) if (!nodeRanks.has(key)) value.nodeOrder.delete(key);
		for (const [id, rank] of nodeRanks) if (value.nodeOrder.get(id) !== rank) value.nodeOrder.set(id, rank);
		for (const key of [...value.edgeOrder.keys()]) if (!edgeRanks.has(key)) value.edgeOrder.delete(key);
		for (const [id, rank] of edgeRanks) if (value.edgeOrder.get(id) !== rank) value.edgeOrder.set(id, rank);
		value.nodeTombstones.clear();
		value.edgeTombstones.clear();
	}, origin);
}

async function liveItem<T extends CanvasNode | CanvasEdge>(
	kind: ItemKind, id: string, map: ItemMap, rank: string | undefined,
	tombstone: CanvasItemTombstone | undefined,
): Promise<{ item: T | null; conflict: CanvasResolvedConflict | null }> {
	const item = (kind === "node" ? readNode(id, map) : readEdge(id, map)) as T | null;
	if (!item || !tombstone) return { item, conflict: null };
	const hash = await sha256Hex(canonicalCanvasItemBytes(item, rank ?? null));
	if (hash === tombstone.baseSemanticHash) return { item: null, conflict: null };
	return { item, conflict: { id: `${kind}:${id}:${tombstone.operationId}`, kind: "edit_delete", itemKind: kind,
		itemId: id, operationId: tombstone.operationId, recordedAt: Date.now() } };
}

export async function materializeCanvasDocument(doc: Y.Doc, normalize = true): Promise<CanvasSemanticData> {
	const value = roots(doc);
	const nodes = new Map<string, CanvasNode>();
	const edges = new Map<string, CanvasEdge>();
	const conflicts: CanvasResolvedConflict[] = [];
	for (const [id, map] of value.nodes) {
		if (!(map instanceof Y.Map)) continue;
		const live = await liveItem<CanvasNode>("node", id, map, value.nodeOrder.get(id), value.nodeTombstones.get(id));
		if (live.item) nodes.set(id, live.item);
		if (live.conflict) conflicts.push(live.conflict);
	}
	for (const [id, map] of value.edges) {
		if (!(map instanceof Y.Map)) continue;
		const live = await liveItem<CanvasEdge>("edge", id, map, value.edgeOrder.get(id), value.edgeTombstones.get(id));
		if (live.item && nodes.has(live.item.endpoints.fromNode) && nodes.has(live.item.endpoints.toNode)) {
			edges.set(id, live.item);
		}
		if (live.conflict) conflicts.push(live.conflict);
	}
	if (normalize && conflicts.length > 0) {
		doc.transact(() => {
			for (const conflict of conflicts) {
				(conflict.itemKind === "node" ? value.nodeTombstones : value.edgeTombstones).delete(conflict.itemId);
				value.resolvedConflicts.set(conflict.id, conflict);
			}
			const excess = value.resolvedConflicts.size - CANVAS_LIMITS.resolvedConflicts;
			if (excess > 0) {
				const oldest = [...value.resolvedConflicts.values()].sort((left, right) => left.recordedAt - right.recordedAt);
				for (const conflict of oldest.slice(0, excess)) value.resolvedConflicts.delete(conflict.id);
			}
		}, "canvas-normalize-tombstones");
	}
	const rootFields = Object.create(null) as Record<string, JsonValue>;
	for (const [key, field] of value.rootFields) rootFields[key] = field;
	return { rootFields, nodes, nodeOrder: orderedCanvasIds(value.nodeOrder, nodes.keys()),
		edges, edgeOrder: orderedCanvasIds(value.edgeOrder, edges.keys()) };
}

async function tombstoneFor(item: CanvasNode | CanvasEdge, rank: string | undefined, operationId: string, now: number): Promise<CanvasItemTombstone> {
	return { operationId, baseSemanticHash: await sha256Hex(canonicalCanvasItemBytes(item, rank ?? null)),
		deletedAt: now, lastOrderRank: rank ?? null };
}

export async function applyCanvasSnapshot(
	doc: Y.Doc,
	data: CanvasSemanticData,
	operationId: string,
	origin: unknown = "canvas-snapshot",
	now = Date.now(),
): Promise<void> {
	const current = await materializeCanvasDocument(doc);
	const value = roots(doc);
	const nodeTombstones = new Map<string, CanvasItemTombstone>();
	const edgeTombstones = new Map<string, CanvasItemTombstone>();
	for (const [id, node] of current.nodes) if (!data.nodes.has(id)) {
		nodeTombstones.set(id, await tombstoneFor(node, value.nodeOrder.get(id), operationId, now));
	}
	for (const [id, edge] of current.edges) if (!data.edges.has(id)) {
		edgeTombstones.set(id, await tombstoneFor(edge, value.edgeOrder.get(id), operationId, now));
	}
	const nodeRanks = reconcileCanvasRanks(data.nodeOrder, value.nodeOrder).ranks;
	const edgeRanks = reconcileCanvasRanks(data.edgeOrder, value.edgeOrder).ranks;
	doc.transact(() => {
		for (const key of [...value.rootFields.keys()]) if (!(key in data.rootFields)) value.rootFields.delete(key);
		for (const [key, field] of Object.entries(data.rootFields)) {
			if (!equalJson(value.rootFields.get(key), field)) value.rootFields.set(key, yJson(field));
		}
		for (const [id, node] of data.nodes) {
			let map = value.nodes.get(id);
			if (!(map instanceof Y.Map)) { map = new Y.Map(); value.nodes.set(id, map); }
			writeNode(map, node);
		}
		for (const [id, edge] of data.edges) {
			let map = value.edges.get(id);
			if (!(map instanceof Y.Map)) { map = new Y.Map(); value.edges.set(id, map); }
			writeEdge(map, edge);
		}
		for (const [id, tombstone] of nodeTombstones) value.nodeTombstones.set(id, tombstone);
		for (const [id, tombstone] of edgeTombstones) value.edgeTombstones.set(id, tombstone);
		for (const [id, rank] of nodeRanks) if (value.nodeOrder.get(id) !== rank) value.nodeOrder.set(id, rank);
		for (const [id, rank] of edgeRanks) if (value.edgeOrder.get(id) !== rank) value.edgeOrder.set(id, rank);
	}, origin);
}

export async function validateCanvasDocument(doc: Y.Doc): Promise<string | null> {
	const value = roots(doc);
	if (value.meta.get("format") !== "yaos-json-canvas"
		|| value.meta.get("representationVersion") !== CANVAS_REPRESENTATION_VERSION
		|| value.meta.get("jsonCanvasVersion") !== JSON_CANVAS_VERSION
		|| value.meta.get("enrolled") !== true) return "canvas_meta_invalid";
	for (const [id, map] of value.nodes) {
		if (!(map instanceof Y.Map) || !readNode(id, map)) return "canvas_node_invalid";
		if (typeof value.nodeOrder.get(id) !== "string") return "canvas_node_order_missing";
	}
	for (const [id, map] of value.edges) {
		const edge = map instanceof Y.Map ? readEdge(id, map) : null;
		if (!edge) return "canvas_edge_invalid";
		if (!value.nodes.has(edge.endpoints.fromNode) || !value.nodes.has(edge.endpoints.toNode)) {
			return "canvas_edge_endpoint_unknown";
		}
		if (typeof value.edgeOrder.get(id) !== "string") return "canvas_edge_order_missing";
	}
	for (const [id, tombstone] of [...value.nodeTombstones, ...value.edgeTombstones]) {
		if (!id || !tombstone || typeof tombstone !== "object"
			|| typeof tombstone.operationId !== "string" || tombstone.operationId.length === 0
			|| !/^[a-f0-9]{64}$/.test(tombstone.baseSemanticHash)
			|| !Number.isSafeInteger(tombstone.deletedAt) || tombstone.deletedAt < 0
			|| (tombstone.lastOrderRank !== null && typeof tombstone.lastOrderRank !== "string")) {
			return "canvas_tombstone_invalid";
		}
	}
	const data = await materializeCanvasDocument(doc, false);
	if (data.nodes.size > CANVAS_LIMITS.nodes || data.edges.size > CANVAS_LIMITS.edges) return "canvas_item_limit_exceeded";
	for (const rank of [...value.nodeOrder.values(), ...value.edgeOrder.values()]) {
		if (new TextEncoder().encode(rank).byteLength > CANVAS_LIMITS.rankBytes) return "canvas_rank_limit_exceeded";
	}
	if (value.resolvedConflicts.size > CANVAS_LIMITS.resolvedConflicts) return "canvas_conflict_limit_exceeded";
	const canonical = canonicalCanvasBytes(data);
	if (canonical.byteLength > CANVAS_LIMITS.canonicalBytes) return "canvas_content_limit_exceeded";
	if (parseCanvasBytes(canonical).kind !== "valid") return "canvas_materialization_invalid";
	return null;
}

export function canvasDocumentStats(doc: Y.Doc): {
	nodes: number; edges: number; danglingEdges: number; tombstones: number; resolvedConflicts: number; encodedBytes: number;
} {
	const value = roots(doc);
	let danglingEdges = 0;
	for (const [id, map] of value.edges) {
		if (!(map instanceof Y.Map) || value.edgeTombstones.has(id)) continue;
		const edge = readEdge(id, map);
		if (edge && (!value.nodes.has(edge.endpoints.fromNode) || !value.nodes.has(edge.endpoints.toNode)
			|| value.nodeTombstones.has(edge.endpoints.fromNode) || value.nodeTombstones.has(edge.endpoints.toNode))) danglingEdges++;
	}
	return { nodes: value.nodes.size, edges: value.edges.size,
		danglingEdges,
		tombstones: value.nodeTombstones.size + value.edgeTombstones.size,
		resolvedConflicts: value.resolvedConflicts.size, encodedBytes: Y.encodeStateAsUpdate(doc).byteLength };
}
