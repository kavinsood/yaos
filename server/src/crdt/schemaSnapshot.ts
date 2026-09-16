import type {
	CrdtRootSnapshot,
	CrdtValueSnapshot,
} from "./crdtEngine";

export type MapSnapshot = Extract<CrdtValueSnapshot, { readonly shared: "map" }>;
export type ArraySnapshot = Extract<CrdtValueSnapshot, { readonly shared: "array" }>;
export type TextSnapshot = Extract<CrdtValueSnapshot, { readonly shared: "text" }>;

export function rootsByName(roots: readonly CrdtRootSnapshot[]): ReadonlyMap<string, CrdtRootSnapshot["value"]> {
	return new Map(roots.map((root) => [root.name, root.value]));
}

export function mapSnapshot(value: CrdtValueSnapshot | undefined): MapSnapshot | null {
	return value?.shared === "map" ? value : null;
}

export function arraySnapshot(value: CrdtValueSnapshot | undefined): ArraySnapshot | null {
	return value?.shared === "array" ? value : null;
}

export function mapEntries(value: MapSnapshot | null): ReadonlyMap<string, CrdtValueSnapshot> {
	return new Map(value?.entries ?? []);
}

export function snapshotValue(value: CrdtValueSnapshot | undefined): unknown {
	if (!value) return undefined;
	if (value.shared === "value" || value.shared === "text") return value.value;
	if (value.shared === "array") return value.values.map(snapshotValue);
	const result: Record<string, unknown> = {};
	for (const [key, entry] of value.entries) result[key] = snapshotValue(entry);
	return result;
}

export function scalarSnapshot(value: unknown): CrdtValueSnapshot {
	return { shared: "value", value };
}

export function mapValueSnapshot(entries: Iterable<readonly [string, CrdtValueSnapshot]>): MapSnapshot {
	return { shared: "map", entries: [...entries] };
}

export function textSnapshot(value: string): TextSnapshot {
	return { shared: "text", value };
}
