import yaml from "js-yaml";
import * as Y from "yjs";
import {
	MAX_FRONTMATTER_FIELD_BYTES,
	MAX_FRONTMATTER_ORDERED_VALUES,
	MAX_FRONTMATTER_SCALAR_STRING_BYTES,
	MAX_FRONTMATTER_SEMANTIC_SERIALIZED_BYTES,
	MAX_FRONTMATTER_SET_TOKENS,
} from "@shared/frontmatterSemanticLimits";
import { getFieldPolicy, type FieldPolicy } from "./frontmatterGuard";
import { splitMarkdownComponents } from "./frontmatterBoundary";

export const FRONTMATTER_SEMANTIC_FORMAT = 1 as const;
export const FRONTMATTER_META_ROOT = "frontmatter:meta";
export const FRONTMATTER_REGISTERS_ROOT = "frontmatter:registers";
export const FRONTMATTER_PRESENCE_ROOT = "frontmatter:presence";
export const FRONTMATTER_SET_ADDS_ROOT = "frontmatter:set-adds";
export const FRONTMATTER_SET_REMOVES_ROOT = "frontmatter:set-removes";
export const FRONTMATTER_ORDERED_ROOT_PREFIX = "frontmatter:ordered:";
const semanticEncoder = new TextEncoder();

export type SemanticScalar = string | number | boolean | null;

export type SemanticRegister =
	| { kind: "value"; key: string; value: SemanticScalar }
	| { kind: "deleted"; key: string };

export type SemanticPresence = { present: boolean; key: string };

export interface SemanticSetAdd {
	field: string;
	key: string;
	normalizedValue: string;
	value: SemanticScalar;
}

export interface SemanticFieldSnapshot {
	key: string;
	policy: Exclude<FieldPolicy, "opaque">;
	value: SemanticScalar | SemanticScalar[];
}

export interface FrontmatterSemanticSnapshot {
	format: typeof FRONTMATTER_SEMANTIC_FORMAT;
	fields: Record<string, SemanticFieldSnapshot>;
}

export type SemanticTransitionResult =
	| { kind: "applied"; changedFields: string[] }
	| { kind: "opaque"; reason: string };

type ParsedSemanticField = SemanticFieldSnapshot;

type ParsedSemanticFrontmatter =
	| { kind: "parsed"; fields: Map<string, ParsedSemanticField> }
	| { kind: "opaque"; reason: string };

export function semanticOrderedRoot(field: string): string {
	return `${FRONTMATTER_ORDERED_ROOT_PREFIX}${normalizeField(field)}`;
}

export function parseSemanticFrontmatter(content: string): ParsedSemanticFrontmatter {
	const split = splitMarkdownComponents(content);
	if (split.kind === "ambiguous") return { kind: "opaque", reason: split.reason };
	if (split.kind === "none") return { kind: "parsed", fields: new Map() };
	let parsed: unknown;
	try {
		parsed = yaml.load(split.yamlText);
	} catch {
		return { kind: "opaque", reason: "yaml-parse-error" };
	}
	if (parsed == null) return { kind: "parsed", fields: new Map() };
	if (!isPlainObject(parsed)) return { kind: "opaque", reason: "frontmatter-non-map-root" };

	const fields = new Map<string, ParsedSemanticField>();
	for (const [key, value] of Object.entries(parsed)) {
		const field = normalizeField(key);
		const policy = getFieldPolicy(field);
		if (policy === "opaque") continue;
		if (!boundedSemanticString(key, MAX_FRONTMATTER_FIELD_BYTES)) {
			return { kind: "opaque", reason: `semantic-key-limit:${field}` };
		}
		if (policy === "register") {
			if (!isSemanticScalar(value)) return { kind: "opaque", reason: `unsupported-register:${field}` };
			fields.set(field, { key, policy, value });
			continue;
		}
		const values = Array.isArray(value) ? value : [value];
		const maxValues = policy === "ordered-list"
			? MAX_FRONTMATTER_ORDERED_VALUES
			: MAX_FRONTMATTER_SET_TOKENS;
		if (values.length > maxValues) return { kind: "opaque", reason: `semantic-entry-limit:${field}` };
		if (!values.every(isSemanticScalar)) return { kind: "opaque", reason: `unsupported-list:${field}` };
		fields.set(field, { key, policy, value: values });
	}
	if (semanticEncoder.encode(JSON.stringify([...fields.entries()])).byteLength
		> MAX_FRONTMATTER_SEMANTIC_SERIALIZED_BYTES) {
		return { kind: "opaque", reason: "semantic-byte-limit" };
	}
	return { kind: "parsed", fields };
}

/** Apply a text-derived semantic delta inside the caller's Yjs transaction. */
export function applyFrontmatterSemanticTransition(
	doc: Y.Doc,
	previousContent: string,
	nextContent: string,
	createToken: () => string = () => crypto.randomUUID(),
): SemanticTransitionResult {
	const previous = parseSemanticFrontmatter(previousContent);
	const next = parseSemanticFrontmatter(nextContent);
	if (next.kind === "opaque") return next;
	const previousFields = previous.kind === "parsed" ? previous.fields : new Map<string, ParsedSemanticField>();
	const meta = doc.getMap<number>(FRONTMATTER_META_ROOT);
	const seeded = meta.get("format") === FRONTMATTER_SEMANTIC_FORMAT;
	const registers = doc.getMap<SemanticRegister>(FRONTMATTER_REGISTERS_ROOT);
	const presence = doc.getMap<SemanticPresence>(FRONTMATTER_PRESENCE_ROOT);
	const additions = doc.getMap<SemanticSetAdd>(FRONTMATTER_SET_ADDS_ROOT);
	const removals = doc.getMap<boolean>(FRONTMATTER_SET_REMOVES_ROOT);
	const changedFields: string[] = [];
	const allFields = new Set([...previousFields.keys(), ...next.fields.keys()]);

	for (const field of allFields) {
		const prior = previousFields.get(field);
		const current = next.fields.get(field);
		if (seeded && semanticFieldEqual(prior, current)) continue;
		const policy = current?.policy ?? prior?.policy;
		if (!policy) continue;
		changedFields.push(field);
		if (policy === "register") {
			registers.set(field, current
				? { kind: "value", key: current.key, value: current.value as SemanticScalar }
				: { kind: "deleted", key: prior?.key ?? field });
			continue;
		}

		presence.set(field, { present: current !== undefined, key: current?.key ?? prior?.key ?? field });
		if (policy === "set-like") {
			applySetTransition(
				field,
				current?.key ?? prior?.key ?? field,
				asScalarList(prior?.value),
				asScalarList(current?.value),
				additions,
				removals,
				createToken,
			);
			continue;
		}
		applyOrderedTransition(
			doc.getArray<SemanticScalar>(semanticOrderedRoot(field)),
			asScalarList(current?.value),
		);
	}

	if (!seeded) meta.set("format", FRONTMATTER_SEMANTIC_FORMAT);
	return { kind: "applied", changedFields: changedFields.sort() };
}

export function readFrontmatterSemanticSnapshot(doc: Y.Doc): FrontmatterSemanticSnapshot | null {
	if (doc.getMap<number>(FRONTMATTER_META_ROOT).get("format") !== FRONTMATTER_SEMANTIC_FORMAT) return null;
	const fields: Record<string, SemanticFieldSnapshot> = {};
	for (const [field, register] of doc.getMap<SemanticRegister>(FRONTMATTER_REGISTERS_ROOT)) {
		if (register.kind === "value") {
			fields[field] = { key: register.key, policy: "register", value: register.value };
		}
	}

	const additions = doc.getMap<SemanticSetAdd>(FRONTMATTER_SET_ADDS_ROOT);
	const removals = doc.getMap<boolean>(FRONTMATTER_SET_REMOVES_ROOT);
	const presence = doc.getMap<SemanticPresence>(FRONTMATTER_PRESENCE_ROOT);
	const setFields = new Set<string>();
	for (const [field] of presence) if (getFieldPolicy(field) === "set-like") setFields.add(field);
	for (const [, add] of additions) if (getFieldPolicy(add.field) === "set-like") setFields.add(add.field);
	for (const field of setFields) {
		const state = presence.get(field);
		let fallbackKey: string | null = null;
		const byIdentity = new Map<string, Array<{ token: string; value: SemanticScalar }>>();
		for (const [token, add] of additions) {
			if (add.field !== field || removals.get(token) === true) continue;
			fallbackKey ??= add.key;
			const values = byIdentity.get(add.normalizedValue) ?? [];
			values.push({ token, value: add.value });
			byIdentity.set(add.normalizedValue, values);
		}
		if (byIdentity.size === 0 && state?.present !== true) continue;
		const value = Array.from(byIdentity.entries())
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, values]) => values.sort((left, right) => left.token.localeCompare(right.token))[0]!.value);
		fields[field] = { key: state?.key ?? fallbackKey ?? field, policy: "set-like", value };
	}

	for (const [field, state] of presence) {
		if (!state.present) continue;
		const policy = getFieldPolicy(field);
		if (policy === "ordered-list") {
			fields[field] = {
				key: state.key,
				policy,
				value: doc.getArray<SemanticScalar>(semanticOrderedRoot(field)).toArray(),
			};
		}
	}
	return { format: FRONTMATTER_SEMANTIC_FORMAT, fields };
}

export function serializeFrontmatterSemanticSnapshot(snapshot: FrontmatterSemanticSnapshot): string {
	const fields = Object.entries(snapshot.fields)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([field, value]) => [field, value.policy, value.key, value.value]);
	return JSON.stringify({ format: snapshot.format, fields });
}

function applySetTransition(
	field: string,
	key: string,
	previous: SemanticScalar[],
	next: SemanticScalar[],
	additions: Y.Map<SemanticSetAdd>,
	removals: Y.Map<boolean>,
	createToken: () => string,
): void {
	const previousIdentities = new Set(previous.map(normalizeScalar));
	const nextByIdentity = new Map(next.map((value) => [normalizeScalar(value), value]));
	for (const identity of previousIdentities) {
		if (nextByIdentity.has(identity)) continue;
		for (const [token, add] of additions) {
			if (add.field === field && add.normalizedValue === identity && removals.get(token) !== true) {
				removals.set(token, true);
			}
		}
	}
	const live = new Set<string>();
	for (const [token, add] of additions) {
		if (add.field === field && removals.get(token) !== true) live.add(add.normalizedValue);
	}
	for (const [identity, value] of nextByIdentity) {
		if (live.has(identity)) continue;
		const token = createToken();
		additions.set(token, { field, key, normalizedValue: identity, value });
	}
}

function applyOrderedTransition(target: Y.Array<SemanticScalar>, next: SemanticScalar[]): void {
	const previous = target.toArray();
	const matrix = lcsMatrix(previous, next);
	let priorIndex = 0;
	let nextIndex = 0;
	let targetIndex = 0;
	while (priorIndex < previous.length || nextIndex < next.length) {
		if (
			priorIndex < previous.length
			&& nextIndex < next.length
			&& normalizeScalar(previous[priorIndex]!) === normalizeScalar(next[nextIndex]!)
		) {
			priorIndex++;
			nextIndex++;
			targetIndex++;
		} else if (
			nextIndex < next.length
			&& (priorIndex === previous.length || matrix[priorIndex]![nextIndex + 1]! >= matrix[priorIndex + 1]![nextIndex]!)
		) {
			target.insert(targetIndex, [next[nextIndex]!]);
			nextIndex++;
			targetIndex++;
		} else {
			target.delete(targetIndex, 1);
			priorIndex++;
		}
	}
}

function lcsMatrix(left: SemanticScalar[], right: SemanticScalar[]): number[][] {
	const matrix = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
	for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex--) {
		for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex--) {
			matrix[leftIndex]![rightIndex] = normalizeScalar(left[leftIndex]!) === normalizeScalar(right[rightIndex]!)
				? 1 + matrix[leftIndex + 1]![rightIndex + 1]!
				: Math.max(matrix[leftIndex + 1]![rightIndex]!, matrix[leftIndex]![rightIndex + 1]!);
		}
	}
	return matrix;
}

function semanticFieldEqual(
	left: ParsedSemanticField | undefined,
	right: ParsedSemanticField | undefined,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function asScalarList(value: SemanticScalar | SemanticScalar[] | undefined): SemanticScalar[] {
	return value === undefined ? [] : (Array.isArray(value) ? value : [value]);
}

function normalizeField(field: string): string {
	return field.trim().toLowerCase();
}

function normalizeScalar(value: SemanticScalar): string {
	return `${value === null ? "null" : typeof value}:${JSON.stringify(value)}`;
}

function isSemanticScalar(value: unknown): value is SemanticScalar {
	if (typeof value === "string") return boundedSemanticString(value, MAX_FRONTMATTER_SCALAR_STRING_BYTES);
	return value === null || typeof value === "boolean"
		|| (typeof value === "number" && Number.isFinite(value));
}

function boundedSemanticString(value: string, maxBytes: number): boolean {
	return value.length <= maxBytes && semanticEncoder.encode(value).byteLength <= maxBytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}
