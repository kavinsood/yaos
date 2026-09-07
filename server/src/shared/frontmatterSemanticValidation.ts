import * as Y from "yjs";
import {
	MAX_FRONTMATTER_FIELD_BYTES,
	MAX_FRONTMATTER_NORMALIZED_VALUE_BYTES,
	MAX_FRONTMATTER_ORDERED_VALUES,
	MAX_FRONTMATTER_SCALAR_STRING_BYTES,
	MAX_FRONTMATTER_SEMANTIC_FIELDS,
	MAX_FRONTMATTER_SEMANTIC_SERIALIZED_BYTES,
	MAX_FRONTMATTER_SET_TOKENS,
	MAX_FRONTMATTER_TOKEN_BYTES,
} from "./frontmatterSemanticLimits";

const META_ROOT = "frontmatter:meta";
const REGISTERS_ROOT = "frontmatter:registers";
const PRESENCE_ROOT = "frontmatter:presence";
const SET_ADDS_ROOT = "frontmatter:set-adds";
const SET_REMOVES_ROOT = "frontmatter:set-removes";
const ALIASES_ROOT = "frontmatter:ordered:aliases";
const ALLOWED_ROOTS = new Map<string, "map" | "array">([
	[META_ROOT, "map"],
	[REGISTERS_ROOT, "map"],
	[PRESENCE_ROOT, "map"],
	[SET_ADDS_ROOT, "map"],
	[SET_REMOVES_ROOT, "map"],
	[ALIASES_ROOT, "array"],
]);
const REGISTER_FIELDS = new Set(["title", "timeestimate", "tasksourcetype"]);
const SET_FIELDS = new Set(["tags", "cssclasses"]);
const LIST_FIELDS = new Set([...SET_FIELDS, "aliases"]);
const encoder = new TextEncoder();
type SharedRoot = NonNullable<ReturnType<Y.Doc["share"]["get"]>>;

export function validateFrontmatterSemanticRoots(doc: Y.Doc): string | null {
	const semanticRoots = [...doc.share.entries()].filter(([name]) => name.startsWith("frontmatter:"));
	if (semanticRoots.length === 0) return null;
	for (const [name, root] of semanticRoots) {
		const expected = ALLOWED_ROOTS.get(name);
		if (!expected || !rootKindMatches(root, expected)) {
			return "frontmatter_semantic_root_invalid";
		}
	}

	const meta = existingMap(doc, META_ROOT);
	if (!meta || meta.size !== 1 || meta.get("format") !== 1) return "frontmatter_semantic_format_invalid";
	const registers = existingMap(doc, REGISTERS_ROOT);
	const presence = existingMap(doc, PRESENCE_ROOT);
	const additions = existingMap(doc, SET_ADDS_ROOT);
	const removals = existingMap(doc, SET_REMOVES_ROOT);
	const ordered = existingArray(doc, ALIASES_ROOT);
	if ((registers?.size ?? 0) > MAX_FRONTMATTER_SEMANTIC_FIELDS || (presence?.size ?? 0) > MAX_FRONTMATTER_SEMANTIC_FIELDS
		|| (additions?.size ?? 0) > MAX_FRONTMATTER_SET_TOKENS || (removals?.size ?? 0) > MAX_FRONTMATTER_SET_TOKENS
		|| (ordered?.length ?? 0) > MAX_FRONTMATTER_ORDERED_VALUES) {
		return "frontmatter_semantic_limit_exceeded";
	}
	for (const [field, value] of registers ?? []) {
		if (!REGISTER_FIELDS.has(field) || !validRegister(field, value)) return "frontmatter_semantic_register_invalid";
	}
	for (const [field, value] of presence ?? []) {
		if (!LIST_FIELDS.has(field) || !validPresence(field, value)) return "frontmatter_semantic_presence_invalid";
	}
	for (const [token, value] of additions ?? []) {
		if (!boundedIdentifier(token, MAX_FRONTMATTER_TOKEN_BYTES) || !validSetAdd(value)) return "frontmatter_semantic_set_invalid";
	}
	for (const [token, value] of removals ?? []) {
		if (!boundedIdentifier(token, MAX_FRONTMATTER_TOKEN_BYTES) || value !== true) return "frontmatter_semantic_remove_invalid";
	}
	const orderedValues = ordered?.toArray() ?? [];
	if (!orderedValues.every(isBoundedScalar)) return "frontmatter_semantic_ordered_invalid";

	const serialized = JSON.stringify({
		meta: Array.from(meta.entries()),
		registers: Array.from(registers?.entries() ?? []),
		presence: Array.from(presence?.entries() ?? []),
		additions: Array.from(additions?.entries() ?? []),
		removals: Array.from(removals?.entries() ?? []),
		ordered: { aliases: orderedValues },
	});
	return encoder.encode(serialized).byteLength <= MAX_FRONTMATTER_SEMANTIC_SERIALIZED_BYTES
		? null
		: "frontmatter_semantic_limit_exceeded";
}

function existingMap(doc: Y.Doc, name: string): Y.Map<unknown> | null {
	const root = doc.share.get(name);
	return root ? doc.getMap<unknown>(name) : null;
}

function existingArray(doc: Y.Doc, name: string): Y.Array<unknown> | null {
	const root = doc.share.get(name);
	return root ? doc.getArray<unknown>(name) : null;
}

function rootKindMatches(root: SharedRoot, expected: "map" | "array"): boolean {
	if (root instanceof Y.Map) return expected === "map";
	if (root instanceof Y.Array) return expected === "array";
	const hasMapItems = root._map.size > 0;
	const hasSequenceItems = root._start !== null;
	if (hasMapItems === hasSequenceItems) return false;
	return expected === "map" ? hasMapItems : hasSequenceItems;
}

function validRegister(field: string, value: unknown): boolean {
	if (!isRecord(value) || !boundedIdentifier(value.key, MAX_FRONTMATTER_FIELD_BYTES)
		|| normalizeField(value.key) !== field) return false;
	if (value.kind === "deleted") return exactKeys(value, ["kind", "key"]);
	return value.kind === "value" && exactKeys(value, ["kind", "key", "value"])
		&& isBoundedScalar(value.value);
}

function validPresence(field: string, value: unknown): boolean {
	return isRecord(value) && exactKeys(value, ["present", "key"])
		&& typeof value.present === "boolean" && boundedIdentifier(value.key, MAX_FRONTMATTER_FIELD_BYTES)
		&& normalizeField(value.key) === field;
}

function validSetAdd(value: unknown): boolean {
	return isRecord(value) && exactKeys(value, ["field", "key", "normalizedValue", "value"])
		&& typeof value.field === "string" && SET_FIELDS.has(value.field)
		&& boundedIdentifier(value.key, MAX_FRONTMATTER_FIELD_BYTES)
		&& boundedIdentifier(value.normalizedValue, MAX_FRONTMATTER_NORMALIZED_VALUE_BYTES)
		&& isBoundedScalar(value.value)
		&& normalizeField(value.key) === value.field
		&& value.normalizedValue === normalizeScalar(value.value);
}

function isBoundedScalar(value: unknown): value is string | number | boolean | null {
	return value === null || typeof value === "boolean"
		|| (typeof value === "number" && Number.isFinite(value))
		|| boundedByteString(value, MAX_FRONTMATTER_SCALAR_STRING_BYTES);
}

function boundedIdentifier(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && value.length > 0 && boundedByteString(value, maxBytes);
}

function boundedByteString(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && value.length <= maxBytes
		&& encoder.encode(value).byteLength <= maxBytes;
}

function normalizeScalar(value: string | number | boolean | null): string {
	return `${value === null ? "null" : typeof value}:${JSON.stringify(value)}`;
}

function normalizeField(value: string): string {
	return value.trim().toLowerCase();
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const keys = Object.keys(value).sort();
	return keys.length === expected.length && expected.slice().sort().every((key, index) => keys[index] === key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
