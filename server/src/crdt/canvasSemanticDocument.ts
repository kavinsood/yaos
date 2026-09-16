import type { CrdtRootOperation, CrdtValueSnapshot } from "./crdtEngine";
import type { YwasmCrdtDocument } from "./ywasmCrdtEngine";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import {
	mapEntries, mapSnapshot, mapValueSnapshot, rootsByName, scalarSnapshot, snapshotValue, textSnapshot,
	type MapSnapshot,
} from "./schemaSnapshot";
import { CANVAS_LIMITS } from "../shared/canvasLimits";
import { canonicalCanvasBytes, canonicalCanvasItemBytes, parseCanvasBytes } from "../shared/canvasCodec";
import { initialCanvasRanks, orderedCanvasIds, reconcileCanvasRanks } from "../shared/canvasOrdering";
import {
	CANVAS_REPRESENTATION_VERSION, JSON_CANVAS_VERSION, type CanvasEdge, type CanvasItemTombstone,
	type CanvasNode, type CanvasResolvedConflict, type CanvasSemanticData, type JsonValue,
} from "../shared/canvasTypes";

const ABSENT = { yaosCanvasAbsent: true };
type ItemKind = "node" | "edge";

interface CanvasRoots {
	readonly meta: ReadonlyMap<string, CrdtValueSnapshot>;
	readonly rootFields: ReadonlyMap<string, CrdtValueSnapshot>;
	readonly nodes: ReadonlyMap<string, CrdtValueSnapshot>;
	readonly nodeOrder: ReadonlyMap<string, CrdtValueSnapshot>;
	readonly nodeTombstones: ReadonlyMap<string, CrdtValueSnapshot>;
	readonly edges: ReadonlyMap<string, CrdtValueSnapshot>;
	readonly edgeOrder: ReadonlyMap<string, CrdtValueSnapshot>;
	readonly edgeTombstones: ReadonlyMap<string, CrdtValueSnapshot>;
	readonly resolvedConflicts: ReadonlyMap<string, CrdtValueSnapshot>;
}

const CANVAS_ROOT_FILTER = { names: [
	"canvasMeta", "rootFields", "nodes", "nodeOrder", "nodeTombstones", "edges", "edgeOrder", "edgeTombstones",
	"resolvedConflicts",
] } as const;

function canvasRoots(doc: YwasmCrdtDocument): CanvasRoots {
	const roots = rootsByName(crdtEngine.snapshotRoots(doc, CANVAS_ROOT_FILTER));
	const map = (name: string): ReadonlyMap<string, CrdtValueSnapshot> => mapEntries(mapSnapshot(roots.get(name)));
	return {
		meta: map("canvasMeta"), rootFields: map("rootFields"), nodes: map("nodes"),
		nodeOrder: map("nodeOrder"), nodeTombstones: map("nodeTombstones"), edges: map("edges"),
		edgeOrder: map("edgeOrder"), edgeTombstones: map("edgeTombstones"),
		resolvedConflicts: map("resolvedConflicts"),
	};
}

function isAbsent(value: unknown): boolean {
	return value !== null && typeof value === "object"
		&& (value as { yaosCanvasAbsent?: unknown }).yaosCanvasAbsent === true;
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return Object.create(null) as Record<string, JsonValue>;
	}
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

function mapSet(
	operations: CrdtRootOperation[], root: string, key: string, value: CrdtValueSnapshot,
	path?: readonly string[],
): void {
	operations.push({ kind: "map-set", root, ...(path ? { path } : {}), key, value });
}

function mapDelete(operations: CrdtRootOperation[], root: string, key: string, path?: readonly string[]): void {
	operations.push({ kind: "map-delete", root, ...(path ? { path } : {}), key });
}

function setScalarIfChanged(
	operations: CrdtRootOperation[], root: string, current: ReadonlyMap<string, CrdtValueSnapshot>,
	key: string, value: unknown, path?: readonly string[],
): void {
	if (!equalJson(snapshotValue(current.get(key)), value)) mapSet(operations, root, key, scalarSnapshot(value), path);
}

function metadataOperations(operations: CrdtRootOperation[], current: CanvasRoots): void {
	setScalarIfChanged(operations, "canvasMeta", current.meta, "format", "yaos-json-canvas");
	setScalarIfChanged(operations, "canvasMeta", current.meta, "representationVersion", CANVAS_REPRESENTATION_VERSION);
	setScalarIfChanged(operations, "canvasMeta", current.meta, "jsonCanvasVersion", JSON_CANVAS_VERSION);
	setScalarIfChanged(operations, "canvasMeta", current.meta, "enrolled", true);
}

function extensionSnapshot(extensions: Record<string, JsonValue>): MapSnapshot {
	return mapValueSnapshot(Object.entries(extensions).map(([key, value]) => [key, scalarSnapshot(yJson(value))] as const));
}

function nodeSnapshot(node: CanvasNode): MapSnapshot {
	const entries: Array<readonly [string, CrdtValueSnapshot]> = [
		["payload", scalarSnapshot(yJson(node.payload as unknown as JsonValue))],
		["position", scalarSnapshot(yJson(node.position as unknown as JsonValue))],
		["size", scalarSnapshot(yJson(node.size as unknown as JsonValue))],
		["color", scalarSnapshot(node.color === undefined ? ABSENT : node.color)],
		["extensions", extensionSnapshot(node.extensions)],
	];
	if (node.payload.type === "text") entries.push(["text", textSnapshot(node.text ?? "")]);
	return mapValueSnapshot(entries);
}

function edgeSnapshot(edge: CanvasEdge): MapSnapshot {
	return mapValueSnapshot([
		["endpoints", scalarSnapshot(yJson(edge.endpoints as unknown as JsonValue))],
		["decorations", scalarSnapshot(yJson(edge.decorations as unknown as JsonValue))],
		["color", scalarSnapshot(edge.color === undefined ? ABSENT : edge.color)],
		["label", scalarSnapshot(edge.label === undefined ? ABSENT : edge.label)],
		["extensions", extensionSnapshot(edge.extensions)],
	]);
}

function replaceExtensions(
	operations: CrdtRootOperation[], root: "nodes" | "edges", id: string,
	current: ReadonlyMap<string, CrdtValueSnapshot>, extensions: Record<string, JsonValue>,
): void {
	const existing = mapSnapshot(current.get("extensions"));
	if (!existing) {
		mapSet(operations, root, "extensions", extensionSnapshot(extensions), [id]);
		return;
	}
	const values = mapEntries(existing);
	for (const key of values.keys()) if (!(key in extensions)) mapDelete(operations, root, key, [id, "extensions"]);
	for (const [key, value] of Object.entries(extensions)) {
		setScalarIfChanged(operations, root, values, key, yJson(value), [id, "extensions"]);
	}
}

function writeNodeOperations(operations: CrdtRootOperation[], id: string, existing: CrdtValueSnapshot | undefined, node: CanvasNode): void {
	const map = mapSnapshot(existing);
	if (!map) { mapSet(operations, "nodes", id, nodeSnapshot(node)); return; }
	const current = mapEntries(map);
	setScalarIfChanged(operations, "nodes", current, "payload", yJson(node.payload as unknown as JsonValue), [id]);
	setScalarIfChanged(operations, "nodes", current, "position", yJson(node.position as unknown as JsonValue), [id]);
	setScalarIfChanged(operations, "nodes", current, "size", yJson(node.size as unknown as JsonValue), [id]);
	setScalarIfChanged(operations, "nodes", current, "color", node.color === undefined ? ABSENT : node.color, [id]);
	if (node.payload.type === "text") {
		const next = node.text ?? "";
		const text = current.get("text");
		if (text?.shared === "text") {
			if (text.value !== next) operations.push({ kind: "text-replace", root: "nodes", path: [id, "text"], value: next });
		} else mapSet(operations, "nodes", "text", textSnapshot(next), [id]);
	} else if (current.has("text")) mapDelete(operations, "nodes", "text", [id]);
	replaceExtensions(operations, "nodes", id, current, node.extensions);
}

function writeEdgeOperations(operations: CrdtRootOperation[], id: string, existing: CrdtValueSnapshot | undefined, edge: CanvasEdge): void {
	const map = mapSnapshot(existing);
	if (!map) { mapSet(operations, "edges", id, edgeSnapshot(edge)); return; }
	const current = mapEntries(map);
	setScalarIfChanged(operations, "edges", current, "endpoints", yJson(edge.endpoints as unknown as JsonValue), [id]);
	setScalarIfChanged(operations, "edges", current, "decorations", yJson(edge.decorations as unknown as JsonValue), [id]);
	setScalarIfChanged(operations, "edges", current, "color", edge.color === undefined ? ABSENT : edge.color, [id]);
	setScalarIfChanged(operations, "edges", current, "label", edge.label === undefined ? ABSENT : edge.label, [id]);
	replaceExtensions(operations, "edges", id, current, edge.extensions);
}

function readExtensions(map: ReadonlyMap<string, CrdtValueSnapshot>): Record<string, JsonValue> {
	const source = mapEntries(mapSnapshot(map.get("extensions")));
	const result = Object.create(null) as Record<string, JsonValue>;
	for (const [key, value] of source) result[key] = snapshotValue(value) as JsonValue;
	return result;
}

function readNode(id: string, source: MapSnapshot): CanvasNode | null {
	const map = mapEntries(source);
	const payload = jsonRecord(snapshotValue(map.get("payload"))) as unknown as CanvasNode["payload"];
	const position = jsonRecord(snapshotValue(map.get("position")));
	const size = jsonRecord(snapshotValue(map.get("size")));
	if (typeof payload.type !== "string" || typeof position.x !== "number" || typeof position.y !== "number"
		|| typeof size.width !== "number" || typeof size.height !== "number") return null;
	const text = map.get("text");
	const color = snapshotValue(map.get("color"));
	return { id, payload, position: { x: position.x, y: position.y }, size: { width: size.width, height: size.height },
		...(payload.type === "text" ? { text: text?.shared === "text" ? text.value : "" } : {}),
		...(!isAbsent(color) && typeof color === "string" ? { color } : {}), extensions: readExtensions(map) };
}

function readEdge(id: string, source: MapSnapshot): CanvasEdge | null {
	const map = mapEntries(source);
	const endpoints = jsonRecord(snapshotValue(map.get("endpoints")));
	const decorations = jsonRecord(snapshotValue(map.get("decorations")));
	if (typeof endpoints.fromNode !== "string" || typeof endpoints.toNode !== "string") return null;
	const color = snapshotValue(map.get("color"));
	const label = snapshotValue(map.get("label"));
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

function stringMap(values: ReadonlyMap<string, CrdtValueSnapshot>): ReadonlyMap<string, string> {
	const result = new Map<string, string>();
	for (const [key, entry] of values) {
		const value = snapshotValue(entry);
		if (typeof value === "string") result.set(key, value);
	}
	return result;
}

export function initializeCanvasDocument(doc: YwasmCrdtDocument): void {
	const current = canvasRoots(doc);
	const operations: CrdtRootOperation[] = [];
	metadataOperations(operations, current);
	crdtEngine.applyRootOperations(doc, operations, "canvas-initialize");
}

export function createCanvasDocument(data?: CanvasSemanticData): YwasmCrdtDocument {
	const doc = crdtEngine.createDocument(crypto.randomUUID());
	try {
		initializeCanvasDocument(doc);
		if (data) importCanvasData(doc, data);
		return doc;
	} catch (error) {
		crdtEngine.destroyDocument(doc);
		throw error;
	}
}

export function importCanvasData(doc: YwasmCrdtDocument, data: CanvasSemanticData, origin = "canvas-import"): void {
	const current = canvasRoots(doc);
	const operations: CrdtRootOperation[] = [];
	metadataOperations(operations, current);
	for (const key of current.rootFields.keys()) if (!(key in data.rootFields)) mapDelete(operations, "rootFields", key);
	for (const [key, field] of Object.entries(data.rootFields)) {
		setScalarIfChanged(operations, "rootFields", current.rootFields, key, yJson(field));
	}
	for (const key of current.nodes.keys()) if (!data.nodes.has(key)) mapDelete(operations, "nodes", key);
	for (const [id, node] of data.nodes) writeNodeOperations(operations, id, current.nodes.get(id), node);
	for (const key of current.edges.keys()) if (!data.edges.has(key)) mapDelete(operations, "edges", key);
	for (const [id, edge] of data.edges) writeEdgeOperations(operations, id, current.edges.get(id), edge);
	const nodeRanks = initialCanvasRanks(data.nodeOrder);
	const edgeRanks = initialCanvasRanks(data.edgeOrder);
	for (const key of current.nodeOrder.keys()) if (!nodeRanks.has(key)) mapDelete(operations, "nodeOrder", key);
	for (const [id, rank] of nodeRanks) setScalarIfChanged(operations, "nodeOrder", current.nodeOrder, id, rank);
	for (const key of current.edgeOrder.keys()) if (!edgeRanks.has(key)) mapDelete(operations, "edgeOrder", key);
	for (const [id, rank] of edgeRanks) setScalarIfChanged(operations, "edgeOrder", current.edgeOrder, id, rank);
	for (const key of current.nodeTombstones.keys()) mapDelete(operations, "nodeTombstones", key);
	for (const key of current.edgeTombstones.keys()) mapDelete(operations, "edgeTombstones", key);
	crdtEngine.applyRootOperations(doc, operations, origin);
}

async function liveItem<T extends CanvasNode | CanvasEdge>(
	kind: ItemKind, id: string, map: MapSnapshot, rank: string | undefined, tombstone: CanvasItemTombstone | undefined,
): Promise<{ item: T | null; conflict: CanvasResolvedConflict | null }> {
	const item = (kind === "node" ? readNode(id, map) : readEdge(id, map)) as T | null;
	if (!item || !tombstone) return { item, conflict: null };
	const hash = await sha256Hex(canonicalCanvasItemBytes(item, rank ?? null));
	if (hash === tombstone.baseSemanticHash) return { item: null, conflict: null };
	return { item, conflict: { id: `${kind}:${id}:${tombstone.operationId}`, kind: "edit_delete", itemKind: kind,
		itemId: id, operationId: tombstone.operationId, recordedAt: Date.now() } };
}

export async function materializeCanvasDocument(doc: YwasmCrdtDocument, normalize = true): Promise<CanvasSemanticData> {
	const value = canvasRoots(doc);
	const nodeRanks = stringMap(value.nodeOrder);
	const edgeRanks = stringMap(value.edgeOrder);
	const nodes = new Map<string, CanvasNode>();
	const edges = new Map<string, CanvasEdge>();
	const conflicts: CanvasResolvedConflict[] = [];
	for (const [id, entry] of value.nodes) {
		const map = mapSnapshot(entry);
		if (!map) continue;
		const live = await liveItem<CanvasNode>("node", id, map, nodeRanks.get(id),
			snapshotValue(value.nodeTombstones.get(id)) as CanvasItemTombstone | undefined);
		if (live.item) nodes.set(id, live.item);
		if (live.conflict) conflicts.push(live.conflict);
	}
	for (const [id, entry] of value.edges) {
		const map = mapSnapshot(entry);
		if (!map) continue;
		const live = await liveItem<CanvasEdge>("edge", id, map, edgeRanks.get(id),
			snapshotValue(value.edgeTombstones.get(id)) as CanvasItemTombstone | undefined);
		if (live.item && nodes.has(live.item.endpoints.fromNode) && nodes.has(live.item.endpoints.toNode)) {
			edges.set(id, live.item);
		}
		if (live.conflict) conflicts.push(live.conflict);
	}
	if (normalize && conflicts.length > 0) {
		const operations: CrdtRootOperation[] = [];
		const resolved = new Map(value.resolvedConflicts);
		for (const conflict of conflicts) {
			mapDelete(operations, conflict.itemKind === "node" ? "nodeTombstones" : "edgeTombstones", conflict.itemId);
			mapSet(operations, "resolvedConflicts", conflict.id, scalarSnapshot(conflict));
			resolved.set(conflict.id, scalarSnapshot(conflict));
		}
		const excess = resolved.size - CANVAS_LIMITS.resolvedConflicts;
		if (excess > 0) {
			const oldest = [...resolved.entries()].map(([id, entry]) => ({ id, value: snapshotValue(entry) as CanvasResolvedConflict }))
				.sort((left, right) => left.value.recordedAt - right.value.recordedAt);
			for (const conflict of oldest.slice(0, excess)) mapDelete(operations, "resolvedConflicts", conflict.id);
		}
		crdtEngine.applyRootOperations(doc, operations, "canvas-normalize-tombstones");
	}
	const rootFields = Object.create(null) as Record<string, JsonValue>;
	for (const [key, field] of value.rootFields) rootFields[key] = snapshotValue(field) as JsonValue;
	return { rootFields, nodes, nodeOrder: orderedCanvasIds(nodeRanks, nodes.keys()),
		edges, edgeOrder: orderedCanvasIds(edgeRanks, edges.keys()) };
}

async function tombstoneFor(
	item: CanvasNode | CanvasEdge, rank: string | undefined, operationId: string, now: number,
): Promise<CanvasItemTombstone> {
	return { operationId, baseSemanticHash: await sha256Hex(canonicalCanvasItemBytes(item, rank ?? null)),
		deletedAt: now, lastOrderRank: rank ?? null };
}

export async function applyCanvasSnapshot(
	doc: YwasmCrdtDocument, data: CanvasSemanticData, operationId: string,
	origin = "canvas-snapshot", now = Date.now(),
): Promise<void> {
	const currentData = await materializeCanvasDocument(doc);
	const current = canvasRoots(doc);
	const currentNodeRanks = stringMap(current.nodeOrder);
	const currentEdgeRanks = stringMap(current.edgeOrder);
	const nodeTombstones = new Map<string, CanvasItemTombstone>();
	const edgeTombstones = new Map<string, CanvasItemTombstone>();
	for (const [id, node] of currentData.nodes) if (!data.nodes.has(id)) {
		nodeTombstones.set(id, await tombstoneFor(node, currentNodeRanks.get(id), operationId, now));
	}
	for (const [id, edge] of currentData.edges) if (!data.edges.has(id)) {
		edgeTombstones.set(id, await tombstoneFor(edge, currentEdgeRanks.get(id), operationId, now));
	}
	const nodeRanks = reconcileCanvasRanks(data.nodeOrder, currentNodeRanks).ranks;
	const edgeRanks = reconcileCanvasRanks(data.edgeOrder, currentEdgeRanks).ranks;
	const operations: CrdtRootOperation[] = [];
	for (const key of current.rootFields.keys()) if (!(key in data.rootFields)) mapDelete(operations, "rootFields", key);
	for (const [key, field] of Object.entries(data.rootFields)) {
		setScalarIfChanged(operations, "rootFields", current.rootFields, key, yJson(field));
	}
	for (const [id, node] of data.nodes) writeNodeOperations(operations, id, current.nodes.get(id), node);
	for (const [id, edge] of data.edges) writeEdgeOperations(operations, id, current.edges.get(id), edge);
	for (const [id, tombstone] of nodeTombstones) mapSet(operations, "nodeTombstones", id, scalarSnapshot(tombstone));
	for (const [id, tombstone] of edgeTombstones) mapSet(operations, "edgeTombstones", id, scalarSnapshot(tombstone));
	for (const [id, rank] of nodeRanks) setScalarIfChanged(operations, "nodeOrder", current.nodeOrder, id, rank);
	for (const [id, rank] of edgeRanks) setScalarIfChanged(operations, "edgeOrder", current.edgeOrder, id, rank);
	crdtEngine.applyRootOperations(doc, operations, origin);
}

export type CanvasDocumentValidation =
	| { readonly error: string; readonly canonicalBytes?: never }
	| { readonly error: null; readonly canonicalBytes: Uint8Array };

export async function validateCanvasDocument(doc: YwasmCrdtDocument): Promise<CanvasDocumentValidation> {
	const value = canvasRoots(doc);
	if (snapshotValue(value.meta.get("format")) !== "yaos-json-canvas"
		|| snapshotValue(value.meta.get("representationVersion")) !== CANVAS_REPRESENTATION_VERSION
		|| snapshotValue(value.meta.get("jsonCanvasVersion")) !== JSON_CANVAS_VERSION
		|| snapshotValue(value.meta.get("enrolled")) !== true) return { error: "canvas_meta_invalid" };
	for (const [id, entry] of value.nodes) {
		const map = mapSnapshot(entry);
		if (!map || !readNode(id, map)) return { error: "canvas_node_invalid" };
		if (typeof snapshotValue(value.nodeOrder.get(id)) !== "string") return { error: "canvas_node_order_missing" };
	}
	for (const [id, entry] of value.edges) {
		const map = mapSnapshot(entry);
		const edge = map ? readEdge(id, map) : null;
		if (!edge) return { error: "canvas_edge_invalid" };
		if (!value.nodes.has(edge.endpoints.fromNode) || !value.nodes.has(edge.endpoints.toNode)) {
			return { error: "canvas_edge_endpoint_unknown" };
		}
		if (typeof snapshotValue(value.edgeOrder.get(id)) !== "string") return { error: "canvas_edge_order_missing" };
	}
	for (const [id, entry] of [...value.nodeTombstones, ...value.edgeTombstones]) {
		const tombstone = snapshotValue(entry) as CanvasItemTombstone | undefined;
		if (!id || !tombstone || typeof tombstone !== "object" || typeof tombstone.operationId !== "string"
			|| tombstone.operationId.length === 0 || !/^[a-f0-9]{64}$/.test(tombstone.baseSemanticHash)
			|| !Number.isSafeInteger(tombstone.deletedAt) || tombstone.deletedAt < 0
			|| (tombstone.lastOrderRank !== null && typeof tombstone.lastOrderRank !== "string")) {
			return { error: "canvas_tombstone_invalid" };
		}
	}
	const data = await materializeCanvasDocument(doc, false);
	if (data.nodes.size > CANVAS_LIMITS.nodes || data.edges.size > CANVAS_LIMITS.edges) {
		return { error: "canvas_item_limit_exceeded" };
	}
	for (const rank of [...stringMap(value.nodeOrder).values(), ...stringMap(value.edgeOrder).values()]) {
		if (new TextEncoder().encode(rank).byteLength > CANVAS_LIMITS.rankBytes) return { error: "canvas_rank_limit_exceeded" };
	}
	if (value.resolvedConflicts.size > CANVAS_LIMITS.resolvedConflicts) return { error: "canvas_conflict_limit_exceeded" };
	const canonical = canonicalCanvasBytes(data);
	if (canonical.byteLength > CANVAS_LIMITS.canonicalBytes) return { error: "canvas_content_limit_exceeded" };
	if (parseCanvasBytes(canonical).kind !== "valid") return { error: "canvas_materialization_invalid" };
	return { error: null, canonicalBytes: canonical };
}

export function canvasDocumentStats(doc: YwasmCrdtDocument): {
	nodes: number; edges: number; danglingEdges: number; tombstones: number; resolvedConflicts: number; encodedBytes: number;
} {
	const value = canvasRoots(doc);
	let danglingEdges = 0;
	for (const [id, entry] of value.edges) {
		const map = mapSnapshot(entry);
		if (!map || value.edgeTombstones.has(id)) continue;
		const edge = readEdge(id, map);
		if (edge && (!value.nodes.has(edge.endpoints.fromNode) || !value.nodes.has(edge.endpoints.toNode)
			|| value.nodeTombstones.has(edge.endpoints.fromNode) || value.nodeTombstones.has(edge.endpoints.toNode))) {
			danglingEdges++;
		}
	}
	return { nodes: value.nodes.size, edges: value.edges.size, danglingEdges,
		tombstones: value.nodeTombstones.size + value.edgeTombstones.size,
		resolvedConflicts: value.resolvedConflicts.size, encodedBytes: crdtEngine.documentStats(doc).encodedStateBytes };
}
