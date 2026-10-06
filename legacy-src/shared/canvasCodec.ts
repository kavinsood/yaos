import { CANVAS_LIMITS, type CanvasLimitName } from "./canvasLimits";
import type {
	CanvasEdge, CanvasNode, CanvasNodePayload, CanvasParseReason, CanvasParseResult,
	CanvasSemanticData, JsonValue,
} from "./canvasTypes";

const encoder = new TextEncoder();
const NODE_BASE_FIELDS = new Set(["id", "type", "x", "y", "width", "height", "color"]);
const EDGE_FIELDS = new Set(["id", "fromNode", "fromSide", "toNode", "toSide", "fromEnd", "toEnd", "color", "label"]);
const TYPE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
	text: new Set(["text"]),
	file: new Set(["file", "subpath"]),
	link: new Set(["url"]),
	group: new Set(["label", "background", "backgroundStyle"]),
});

type JsonObject = Record<string, JsonValue>;

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
	return { kind: "invalid", reason, ...(detail ? { detail } : {}) };
}

function byteLength(value: string): number { return encoder.encode(value).byteLength; }

function validateId(value: unknown): value is string {
	return validString(value) && value.length > 0 && byteLength(value) <= CANVAS_LIMITS.identifierBytes;
}

function parseNode(raw: Record<string, unknown>): CanvasNode | null {
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
		payload = { type, ...(label !== undefined ? { label } : {}), ...(background !== undefined ? { background } : {}),
			...(backgroundStyle !== undefined ? { backgroundStyle } : {}) };
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
	const known = type in TYPE_FIELDS
		? new Set([...NODE_BASE_FIELDS, ...TYPE_FIELDS[type]!])
		: new Set(Object.keys(raw));
	const extensions = Object.create(null) as Record<string, JsonValue>;
	for (const key of Object.keys(raw)) {
		if (known.has(key)) continue;
		const value = checkedJsonValue(raw[key]);
		if (value === undefined) return null;
		extensions[key] = value;
	}
	const color = own(raw, "color");
	if (color !== undefined && !validString(color)) return null;
	return { id, payload, position: { x, y }, size: { width, height },
		...(type === "text" ? { text: own(raw, "text") as string } : {}),
		...(color !== undefined ? { color } : {}), extensions };
}

function parseEdge(raw: Record<string, unknown>): CanvasEdge | null {
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
	return { id, endpoints: { fromNode, toNode, ...(fromSide !== undefined ? { fromSide } : {}),
		...(toSide !== undefined ? { toSide } : {}) }, decorations: {
			...(fromEnd !== undefined ? { fromEnd } : {}), ...(toEnd !== undefined ? { toEnd } : {}),
		}, ...(color !== undefined ? { color } : {}), ...(label !== undefined ? { label } : {}), extensions };
}

function nodeJson(node: CanvasNode): JsonObject {
	const result = Object.create(null) as JsonObject;
	result.id = node.id;
	result.type = node.payload.type;
	result.x = node.position.x;
	result.y = node.position.y;
	result.width = node.size.width;
	result.height = node.size.height;
	if (node.color !== undefined) result.color = node.color;
	if (node.payload.type === "text" && !("fields" in node.payload)) result.text = node.text ?? "";
	else if (node.payload.type === "file" && "file" in node.payload) {
		result.file = node.payload.file;
		if (node.payload.subpath !== undefined) result.subpath = node.payload.subpath;
	} else if (node.payload.type === "link" && "url" in node.payload) result.url = node.payload.url;
	else if (node.payload.type === "group" && !("fields" in node.payload)) {
		if (node.payload.label !== undefined) result.label = node.payload.label;
		if (node.payload.background !== undefined) result.background = node.payload.background;
		if (node.payload.backgroundStyle !== undefined) result.backgroundStyle = node.payload.backgroundStyle;
	} else if ("fields" in node.payload) Object.assign(result, node.payload.fields);
	Object.assign(result, node.extensions);
	return result;
}

function edgeJson(edge: CanvasEdge): JsonObject {
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
		return node ? [nodeJson(node)] : [];
	});
	result.edges = data.edgeOrder.flatMap((id) => {
		const edge = data.edges.get(id);
		if (!edge || (!includeDanglingEdges && (!data.nodes.has(edge.endpoints.fromNode) || !data.nodes.has(edge.endpoints.toNode)))) return [];
		return [edgeJson(edge)];
	});
	return result;
}

function canonicalJson(value: JsonValue): string {
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
	return encoder.encode(canonicalJson(canvasToJson(data)));
}

export function canonicalCanvasItemBytes(item: CanvasNode | CanvasEdge, orderRank: string | null): Uint8Array {
	const value: JsonObject = "position" in item
		? { item: nodeJson(item), orderRank }
		: { item: edgeJson(item), orderRank };
	return encoder.encode(canonicalJson(value));
}

export function formatCanvasBytes(data: CanvasSemanticData): Uint8Array {
	return encoder.encode(`${JSON.stringify(canvasToJson(data), null, 2)}\n`);
}

export function cloneCanvasData(data: CanvasSemanticData): CanvasSemanticData {
	const parsed = parseCanvasBytes(canonicalCanvasBytes(data));
	if (parsed.kind !== "valid") throw new Error(`cannot clone invalid canvas: ${parsed.reason}`);
	return parsed.data;
}

export function parseCanvasBytes(bytes: Uint8Array): CanvasParseResult {
	if (bytes.byteLength > CANVAS_LIMITS.canonicalBytes * 2) return oversized("canonicalBytes", bytes.byteLength);
	let raw: unknown;
	try {
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes).trim();
		raw = text === "" ? {} : JSON.parse(text);
	} catch { return invalid("invalid_json"); }
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
		if (byteLength(canonicalJson(value)) > CANVAS_LIMITS.unknownValueBytes) return oversized("unknownValueBytes", byteLength(canonicalJson(value)));
		rootFields[key] = value;
	}
	const nodes = new Map<string, CanvasNode>();
	const nodeOrder: string[] = [];
	let aggregateTextBytes = 0;
	for (const entry of rawNodes) {
		if (!isRecord(entry)) return invalid("invalid_node");
		const node = parseNode(entry);
		if (!node) return invalid("invalid_node", validString(entry.id) ? entry.id : undefined);
		if (nodes.has(node.id)) return invalid("duplicate_node_id", node.id);
		if (node.text !== undefined) {
			const measured = byteLength(node.text);
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
		const edge = parseEdge(entry);
		if (!edge) return invalid("invalid_edge", validString(entry.id) ? entry.id : undefined);
		if (edges.has(edge.id)) return invalid("duplicate_edge_id", edge.id);
		if (!nodes.has(edge.endpoints.fromNode) || !nodes.has(edge.endpoints.toNode)) return invalid("dangling_edge", edge.id);
		edges.set(edge.id, edge);
		edgeOrder.push(edge.id);
	}
	const data = { rootFields, nodes, nodeOrder, edges, edgeOrder };
	const canonicalBytes = canonicalCanvasBytes(data);
	if (canonicalBytes.byteLength > CANVAS_LIMITS.canonicalBytes) return oversized("canonicalBytes", canonicalBytes.byteLength);
	return { kind: "valid", data, canonicalBytes };
}

export function canvasSemanticEqual(left: CanvasSemanticData, right: CanvasSemanticData): boolean {
	const leftBytes = canonicalCanvasBytes(left);
	const rightBytes = canonicalCanvasBytes(right);
	if (leftBytes.byteLength !== rightBytes.byteLength) return false;
	return leftBytes.every((value, index) => value === rightBytes[index]);
}
