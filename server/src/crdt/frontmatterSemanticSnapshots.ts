import type { CrdtRootSnapshot, CrdtValueSnapshot } from "./crdtEngine";
import {
	MAX_FRONTMATTER_FIELD_BYTES, MAX_FRONTMATTER_NORMALIZED_VALUE_BYTES, MAX_FRONTMATTER_ORDERED_VALUES,
	MAX_FRONTMATTER_SCALAR_STRING_BYTES, MAX_FRONTMATTER_SEMANTIC_FIELDS,
	MAX_FRONTMATTER_SEMANTIC_SERIALIZED_BYTES, MAX_FRONTMATTER_SET_TOKENS, MAX_FRONTMATTER_TOKEN_BYTES,
} from "../shared/frontmatterSemanticLimits";

const ROOTS = new Map<string, "map" | "array">([
	["frontmatter:meta", "map"], ["frontmatter:registers", "map"], ["frontmatter:presence", "map"],
	["frontmatter:set-adds", "map"], ["frontmatter:set-removes", "map"],
	["frontmatter:ordered:aliases", "array"],
]);
const REGISTER_FIELDS = new Set(["title", "timeestimate", "tasksourcetype"]);
const SET_FIELDS = new Set(["tags", "cssclasses"]);
const LIST_FIELDS = new Set([...SET_FIELDS, "aliases"]);
const encoder = new TextEncoder();

function value(snapshot: CrdtValueSnapshot): unknown {
	if (snapshot.shared === "value" || snapshot.shared === "text") return snapshot.value;
	if (snapshot.shared === "array") return snapshot.values.map(value);
	return Object.fromEntries(snapshot.entries.map(([key, nested]) => [key, value(nested)]));
}

function map(roots: Map<string, CrdtRootSnapshot["value"]>, name: string): Map<string, unknown> | null {
	const root = roots.get(name);
	return root?.shared === "map" ? new Map(root.entries.map(([key, nested]) => [key, value(nested)])) : null;
}

export function validateFrontmatterSemanticSnapshots(roots: readonly CrdtRootSnapshot[]): string | null {
	const semantic = roots.filter((root) => root.name.startsWith("frontmatter:"));
	if (semantic.length === 0) return null;
	for (const root of semantic) if (ROOTS.get(root.name) !== root.value.shared) return "frontmatter_semantic_root_invalid";
	const byName = new Map(semantic.map((root) => [root.name, root.value]));
	const meta = map(byName, "frontmatter:meta");
	const registers = map(byName, "frontmatter:registers");
	const presence = map(byName, "frontmatter:presence");
	const additions = map(byName, "frontmatter:set-adds");
	const removals = map(byName, "frontmatter:set-removes");
	const aliasesRoot = byName.get("frontmatter:ordered:aliases");
	const aliases = aliasesRoot?.shared === "array" ? aliasesRoot.values.map(value) : null;
	if (!meta || meta.size !== 1 || meta.get("format") !== 1) return "frontmatter_semantic_format_invalid";
	if ((registers?.size ?? 0) > MAX_FRONTMATTER_SEMANTIC_FIELDS
		|| (presence?.size ?? 0) > MAX_FRONTMATTER_SEMANTIC_FIELDS
		|| (additions?.size ?? 0) > MAX_FRONTMATTER_SET_TOKENS
		|| (removals?.size ?? 0) > MAX_FRONTMATTER_SET_TOKENS
		|| (aliases?.length ?? 0) > MAX_FRONTMATTER_ORDERED_VALUES) return "frontmatter_semantic_limit_exceeded";
	for (const [field, entry] of registers ?? []) {
		if (!REGISTER_FIELDS.has(field) || !validRegister(field, entry)) return "frontmatter_semantic_register_invalid";
	}
	for (const [field, entry] of presence ?? []) {
		if (!LIST_FIELDS.has(field) || !validPresence(field, entry)) return "frontmatter_semantic_presence_invalid";
	}
	for (const [token, entry] of additions ?? []) {
		if (!bounded(token, MAX_FRONTMATTER_TOKEN_BYTES) || !validSetAdd(entry)) return "frontmatter_semantic_set_invalid";
	}
	for (const [token, entry] of removals ?? []) {
		if (!bounded(token, MAX_FRONTMATTER_TOKEN_BYTES) || entry !== true) return "frontmatter_semantic_remove_invalid";
	}
	if (!(aliases ?? []).every(scalar)) return "frontmatter_semantic_ordered_invalid";
	const serialized = JSON.stringify({ meta: [...meta], registers: [...registers ?? []], presence: [...presence ?? []],
		additions: [...additions ?? []], removals: [...removals ?? []], ordered: { aliases: aliases ?? [] } });
	return encoder.encode(serialized).byteLength <= MAX_FRONTMATTER_SEMANTIC_SERIALIZED_BYTES
		? null : "frontmatter_semantic_limit_exceeded";
}

function validRegister(field: string, entry: unknown): boolean {
	if (!record(entry) || !bounded(entry.key, MAX_FRONTMATTER_FIELD_BYTES) || normalize(entry.key) !== field) return false;
	return entry.kind === "deleted" ? exact(entry, ["kind", "key"])
		: entry.kind === "value" && exact(entry, ["kind", "key", "value"]) && scalar(entry.value);
}
function validPresence(field: string, entry: unknown): boolean {
	return record(entry) && exact(entry, ["present", "key"]) && typeof entry.present === "boolean"
		&& bounded(entry.key, MAX_FRONTMATTER_FIELD_BYTES) && normalize(entry.key) === field;
}
function validSetAdd(entry: unknown): boolean {
	return record(entry) && exact(entry, ["field", "key", "normalizedValue", "value"])
		&& typeof entry.field === "string" && SET_FIELDS.has(entry.field)
		&& bounded(entry.key, MAX_FRONTMATTER_FIELD_BYTES)
		&& bounded(entry.normalizedValue, MAX_FRONTMATTER_NORMALIZED_VALUE_BYTES)
		&& scalar(entry.value) && normalize(entry.key) === entry.field
		&& entry.normalizedValue === `${entry.value === null ? "null" : typeof entry.value}:${JSON.stringify(entry.value)}`;
}
function scalar(entry: unknown): entry is string | number | boolean | null {
	return entry === null || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))
		|| bounded(entry, MAX_FRONTMATTER_SCALAR_STRING_BYTES);
}
function bounded(entry: unknown, maximum: number): entry is string {
	return typeof entry === "string" && entry.length > 0 && entry.length <= maximum
		&& encoder.encode(entry).byteLength <= maximum;
}
function normalize(entry: string): string { return entry.trim().toLowerCase(); }
function record(entry: unknown): entry is Record<string, unknown> {
	return typeof entry === "object" && entry !== null && !Array.isArray(entry);
}
function exact(entry: Record<string, unknown>, expected: string[]): boolean {
	const keys = Object.keys(entry).sort();
	return keys.length === expected.length && expected.slice().sort().every((key, index) => key === keys[index]);
}
