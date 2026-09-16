export interface DetachedCrdtValue {
	readonly shared: "value" | "text" | "array" | "map";
	readonly value?: unknown;
	readonly values?: readonly DetachedCrdtValue[];
	readonly entries?: readonly (readonly [string, DetachedCrdtValue])[];
}

export interface DetachedCrdtRoot {
	readonly name: string;
	readonly value: DetachedCrdtValue;
}

function compareUtf16(left: string, right: string): number {
	// Hash ordering must not depend on the host's locale or ICU version.
	return left < right ? -1 : left > right ? 1 : 0;
}

function stableJsonValue(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
	if (Array.isArray(value)) return value.map(stableJsonValue);
	if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
		throw new Error("CRDT root digest contains a non-JSON value");
	}
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => compareUtf16(left, right))
		.map(([key, nested]) => [key, stableJsonValue(nested)]));
}

function stableSnapshot(value: DetachedCrdtValue): unknown {
	if (value.shared === "value") return { shared: "value", value: stableJsonValue(value.value) };
	if (value.shared === "text") return { shared: "text", value: value.value };
	if (value.shared === "array") return { shared: "array", values: (value.values ?? []).map(stableSnapshot) };
	return { shared: "map", entries: [...(value.entries ?? [])]
		.sort(([left], [right]) => compareUtf16(left, right))
		.map(([key, nested]) => [key, stableSnapshot(nested)]) };
}

/** Engine-independent semantic identity for a root CRDT checkpoint. */
export function canonicalCrdtRootDigestBytes(roots: readonly DetachedCrdtRoot[]): Uint8Array {
	const stable = [...roots].sort((left, right) => compareUtf16(left.name, right.name))
		.map((root) => [root.name, stableSnapshot(root.value)]);
	return new TextEncoder().encode(JSON.stringify(stable));
}
