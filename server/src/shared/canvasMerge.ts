import type {
	CanvasEdge, CanvasMergeConflict, CanvasMergeResult, CanvasNode, CanvasSemanticData, JsonValue,
} from "./canvasTypes";

function cloneValue<T extends JsonValue | undefined>(value: T): T {
	if (value === undefined || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as T;
	const result: Record<string, JsonValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		Object.defineProperty(result, key, { value: cloneValue(entry), enumerable: true, configurable: true, writable: true });
	}
	return result as T;
}

function equal(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left === undefined || right === undefined || left === null || right === null) return false;
	if (typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && left.length === right.length
			&& left.every((entry, index) => equal(entry, right[index]));
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
	return [...keys].every((key) => equal(leftRecord[key], rightRecord[key]));
}

function cloneNode(node: CanvasNode): CanvasNode {
	return cloneValue(node as unknown as JsonValue) as unknown as CanvasNode;
}

function cloneEdge(edge: CanvasEdge): CanvasEdge {
	return cloneValue(edge as unknown as JsonValue) as unknown as CanvasEdge;
}

function field<T extends JsonValue | undefined>(
	base: T,
	shared: T,
	local: T,
	conflicts: CanvasMergeConflict[],
	context: Omit<CanvasMergeConflict, "kind" | "local" | "shared">,
): T {
	if (equal(shared, local)) return cloneValue(shared);
	if (equal(base, shared)) return cloneValue(local);
	if (equal(base, local)) return cloneValue(shared);
	conflicts.push({ kind: "field", ...context, local: cloneValue(local), shared: cloneValue(shared) });
	return cloneValue(shared);
}

interface TextEdit { start: number; end: number; replacement: string }

function oneTextEdit(base: string, changed: string): TextEdit {
	let start = 0;
	while (start < base.length && start < changed.length && base[start] === changed[start]) start++;
	let baseEnd = base.length;
	let changedEnd = changed.length;
	while (baseEnd > start && changedEnd > start && base[baseEnd - 1] === changed[changedEnd - 1]) {
		baseEnd--;
		changedEnd--;
	}
	return { start, end: baseEnd, replacement: changed.slice(start, changedEnd) };
}

function textField(base: string, shared: string, local: string): { value: string; conflict: boolean } {
	if (shared === local) return { value: shared, conflict: false };
	if (base === shared) return { value: local, conflict: false };
	if (base === local) return { value: shared, conflict: false };
	const sharedEdit = oneTextEdit(base, shared);
	const localEdit = oneTextEdit(base, local);
	const overlap = sharedEdit.start <= localEdit.end && localEdit.start <= sharedEdit.end;
	if (overlap) return { value: shared, conflict: true };
	const edits = [sharedEdit, localEdit].sort((left, right) => right.start - left.start);
	let value = base;
	for (const edit of edits) value = value.slice(0, edit.start) + edit.replacement + value.slice(edit.end);
	return { value, conflict: false };
}

function extensionFields(
	base: Record<string, JsonValue>, shared: Record<string, JsonValue>, local: Record<string, JsonValue>,
	conflicts: CanvasMergeConflict[], itemKind: "node" | "edge", itemId: string,
): Record<string, JsonValue> {
	const result = Object.create(null) as Record<string, JsonValue>;
	for (const key of new Set([...Object.keys(base), ...Object.keys(shared), ...Object.keys(local)])) {
		const value = field(base[key], shared[key], local[key], conflicts,
			{ itemKind, itemId, field: `extensions.${key}` });
		if (value !== undefined) result[key] = value;
	}
	return result;
}

function mergeNode(base: CanvasNode, shared: CanvasNode, local: CanvasNode, conflicts: CanvasMergeConflict[]): CanvasNode {
	const payload = field(base.payload as unknown as JsonValue, shared.payload as unknown as JsonValue,
		local.payload as unknown as JsonValue, conflicts, { itemKind: "node", itemId: base.id, field: "payload" }) as unknown as CanvasNode["payload"];
	const position = field(base.position as unknown as JsonValue, shared.position as unknown as JsonValue,
		local.position as unknown as JsonValue, conflicts, { itemKind: "node", itemId: base.id, field: "position" }) as unknown as CanvasNode["position"];
	const size = field(base.size as unknown as JsonValue, shared.size as unknown as JsonValue,
		local.size as unknown as JsonValue, conflicts, { itemKind: "node", itemId: base.id, field: "size" }) as unknown as CanvasNode["size"];
	const color = field(base.color, shared.color, local.color, conflicts, { itemKind: "node", itemId: base.id, field: "color" });
	let text: string | undefined;
	if (payload.type === "text") {
		const merged = textField(base.text ?? "", shared.text ?? "", local.text ?? "");
		text = merged.value;
		if (merged.conflict) conflicts.push({ kind: "text", itemKind: "node", itemId: base.id, field: "text",
			local: local.text ?? "", shared: shared.text ?? "" });
	}
	return { id: base.id, payload, position, size, ...(text !== undefined ? { text } : {}),
		...(color !== undefined ? { color } : {}),
		extensions: extensionFields(base.extensions, shared.extensions, local.extensions, conflicts, "node", base.id) };
}

function mergeEdge(base: CanvasEdge, shared: CanvasEdge, local: CanvasEdge, conflicts: CanvasMergeConflict[]): CanvasEdge {
	const endpoints = field(base.endpoints as unknown as JsonValue, shared.endpoints as unknown as JsonValue,
		local.endpoints as unknown as JsonValue, conflicts, { itemKind: "edge", itemId: base.id, field: "endpoints" }) as unknown as CanvasEdge["endpoints"];
	const decorations = field(base.decorations as unknown as JsonValue, shared.decorations as unknown as JsonValue,
		local.decorations as unknown as JsonValue, conflicts, { itemKind: "edge", itemId: base.id, field: "decorations" }) as unknown as CanvasEdge["decorations"];
	const color = field(base.color, shared.color, local.color, conflicts, { itemKind: "edge", itemId: base.id, field: "color" });
	const label = field(base.label, shared.label, local.label, conflicts, { itemKind: "edge", itemId: base.id, field: "label" });
	return { id: base.id, endpoints, decorations, ...(color !== undefined ? { color } : {}),
		...(label !== undefined ? { label } : {}),
		extensions: extensionFields(base.extensions, shared.extensions, local.extensions, conflicts, "edge", base.id) };
}

function mergeItems<T extends CanvasNode | CanvasEdge>(
	itemKind: "node" | "edge",
	base: ReadonlyMap<string, T>, shared: ReadonlyMap<string, T>, local: ReadonlyMap<string, T>,
	conflicts: CanvasMergeConflict[], resolvedEditDeletes: CanvasMergeResult["resolvedEditDeletes"],
	clone: (item: T) => T, merge: (base: T, shared: T, local: T, conflicts: CanvasMergeConflict[]) => T,
): Map<string, T> {
	const result = new Map<string, T>();
	for (const id of new Set([...base.keys(), ...shared.keys(), ...local.keys()])) {
		const baseItem = base.get(id);
		const sharedItem = shared.get(id);
		const localItem = local.get(id);
		if (!baseItem) {
			if (sharedItem && localItem && !equal(sharedItem, localItem)) {
				conflicts.push({ kind: "identity", itemKind, itemId: id,
					local: localItem as unknown as JsonValue, shared: sharedItem as unknown as JsonValue });
				result.set(id, clone(sharedItem));
			} else if (sharedItem ?? localItem) result.set(id, clone((sharedItem ?? localItem)!));
			continue;
		}
		if (!sharedItem && !localItem) continue;
		if (!sharedItem && localItem) {
			if (!equal(baseItem, localItem)) {
				result.set(id, clone(localItem));
				resolvedEditDeletes.push({ itemKind, itemId: id });
			}
			continue;
		}
		if (sharedItem && !localItem) {
			if (!equal(baseItem, sharedItem)) {
				result.set(id, clone(sharedItem));
				resolvedEditDeletes.push({ itemKind, itemId: id });
			}
			continue;
		}
		result.set(id, merge(baseItem, sharedItem!, localItem!, conflicts));
	}
	return result;
}

function mergeOrder(
	base: readonly string[], shared: readonly string[], local: readonly string[], live: ReadonlySet<string>,
	conflicts: CanvasMergeConflict[], itemKind: "node" | "edge",
): string[] {
	const clean = (order: readonly string[]) => order.filter((id, index) => live.has(id) && order.indexOf(id) === index);
	const baseClean = clean(base);
	const sharedClean = clean(shared);
	const localClean = clean(local);
	let selected: string[];
	if (equal(sharedClean, localClean)) selected = [...sharedClean];
	else if (equal(baseClean, sharedClean)) selected = [...localClean];
	else if (equal(baseClean, localClean)) selected = [...sharedClean];
	else {
		selected = [...sharedClean];
		conflicts.push({ kind: "order", itemKind, field: "order",
			local: localClean as unknown as JsonValue, shared: sharedClean as unknown as JsonValue });
	}
	for (const id of live) if (!selected.includes(id)) selected.push(id);
	return selected;
}

export function mergeCanvasThreeWay(
	base: CanvasSemanticData | null,
	shared: CanvasSemanticData,
	local: CanvasSemanticData,
): CanvasMergeResult {
	const conflicts: CanvasMergeConflict[] = [];
	const resolvedEditDeletes: CanvasMergeResult["resolvedEditDeletes"] = [];
	const safeBase: CanvasSemanticData = base ?? {
		rootFields: Object.create(null) as Record<string, JsonValue>, nodes: new Map(), nodeOrder: [], edges: new Map(), edgeOrder: [],
	};
	const rootFields = Object.create(null) as Record<string, JsonValue>;
	for (const key of new Set([...Object.keys(safeBase.rootFields), ...Object.keys(shared.rootFields), ...Object.keys(local.rootFields)])) {
		const value = field(safeBase.rootFields[key], shared.rootFields[key], local.rootFields[key], conflicts,
			{ itemKind: "root", field: key });
		if (value !== undefined) rootFields[key] = value;
	}
	const nodes = mergeItems("node", safeBase.nodes, shared.nodes, local.nodes, conflicts, resolvedEditDeletes,
		cloneNode, mergeNode);
	const edges = mergeItems("edge", safeBase.edges, shared.edges, local.edges, conflicts, resolvedEditDeletes,
		cloneEdge, mergeEdge);
	const nodeOrder = mergeOrder(safeBase.nodeOrder, shared.nodeOrder, local.nodeOrder, new Set(nodes.keys()), conflicts, "node");
	const edgeOrder = mergeOrder(safeBase.edgeOrder, shared.edgeOrder, local.edgeOrder, new Set(edges.keys()), conflicts, "edge");
	return { data: { rootFields, nodes, nodeOrder, edges, edgeOrder }, conflicts, resolvedEditDeletes };
}
