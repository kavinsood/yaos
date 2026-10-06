export const CANVAS_REPRESENTATION_VERSION = 1 as const;
export const JSON_CANVAS_VERSION = "1.0" as const;
export const CANVAS_CODEC = "json-canvas-canonical-v1" as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CanvasPosition { x: number; y: number }
export interface CanvasSize { width: number; height: number }

export interface CanvasTextPayload { type: "text" }
export interface CanvasFilePayload { type: "file"; file: string; subpath?: string }
export interface CanvasLinkPayload { type: "link"; url: string }
export interface CanvasGroupPayload {
	type: "group";
	label?: string;
	background?: string;
	backgroundStyle?: string;
}
export interface CanvasUnknownPayload { type: string; fields: Record<string, JsonValue> }
export type CanvasNodePayload = CanvasTextPayload | CanvasFilePayload | CanvasLinkPayload
	| CanvasGroupPayload | CanvasUnknownPayload;

export interface CanvasNode {
	id: string;
	payload: CanvasNodePayload;
	position: CanvasPosition;
	size: CanvasSize;
	text?: string;
	color?: string;
	extensions: Record<string, JsonValue>;
}

export interface CanvasEdgeEndpoints {
	fromNode: string;
	fromSide?: string;
	toNode: string;
	toSide?: string;
}

export interface CanvasEdgeDecorations { fromEnd?: string; toEnd?: string }

export interface CanvasEdge {
	id: string;
	endpoints: CanvasEdgeEndpoints;
	decorations: CanvasEdgeDecorations;
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

export interface CanvasItemTombstone {
	operationId: string;
	baseSemanticHash: string;
	deletedAt: number;
	lastOrderRank: string | null;
}

export interface CanvasResolvedConflict {
	id: string;
	kind: "edit_delete";
	itemKind: "node" | "edge";
	itemId: string;
	operationId: string;
	recordedAt: number;
}

export type CanvasParseReason =
	| "invalid_json" | "root_not_object" | "nodes_not_array" | "edges_not_array"
	| "duplicate_node_id" | "duplicate_edge_id" | "invalid_node" | "invalid_edge"
	| "dangling_edge" | "invalid_json_value" | "limit_exceeded" | "unsupported_version";

export type CanvasParseResult =
	| { kind: "valid"; data: CanvasSemanticData; canonicalBytes: Uint8Array }
	| { kind: "invalid"; reason: CanvasParseReason; detail?: string }
	| { kind: "unsupported"; reason: CanvasParseReason; detail?: string }
	| { kind: "oversized"; reason: "limit_exceeded"; limit: string; measured: number; maximum: number };

export interface CanvasMergeConflict {
	kind: "identity" | "field" | "text" | "order";
	itemKind: "root" | "node" | "edge";
	itemId?: string;
	field?: string;
	local: JsonValue | undefined;
	shared: JsonValue | undefined;
}

export interface CanvasMergeResult {
	data: CanvasSemanticData;
	conflicts: CanvasMergeConflict[];
	resolvedEditDeletes: Array<{ itemKind: "node" | "edge"; itemId: string }>;
}

export interface SemanticPathRef {
	documentId: string;
	kind: "canvas";
	format: "json-canvas";
	formatVersion: 1;
}
