/**
 * Canonical JSON (DESIGN §j.3: cfg json registers hold canonical JSON):
 * object keys sorted by UTF-16 code units (recursively), no whitespace,
 * primitives as JSON.stringify writes them. Pure; never throws.
 */

const MAX_DEPTH = 256;

function canon(v: unknown, depth: number): string {
	if (depth > MAX_DEPTH) throw new RangeError("json too deep");
	if (v === null || typeof v !== "object") {
		const s = JSON.stringify(v);
		if (s === undefined) throw new TypeError("not json");
		return s;
	}
	if (Array.isArray(v)) {
		let out = "[";
		for (let i = 0; i < v.length; i++) out += (i === 0 ? "" : ",") + canon(v[i], depth + 1);
		return out + "]";
	}
	const o = v as Record<string, unknown>;
	const keys = Object.keys(o).sort();
	let out = "{";
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i]!;
		out += (i === 0 ? "" : ",") + JSON.stringify(k) + ":" + canon(o[k], depth + 1);
	}
	return out + "}";
}

/** Canonical form of a parsed JSON value; null if it is not representable (too deep, undefined, function). */
export function canonicalJson(value: unknown): string | null {
	try {
		return canon(value, 0);
	} catch {
		return null;
	}
}

/** Canonical form of JSON text; null if the text is not JSON. */
export function canonicalizeJsonText(text: string): string | null {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return null;
	}
	return canonicalJson(v);
}

export function isCanonicalJson(text: string): boolean {
	return typeof text === "string" && canonicalizeJsonText(text) === text;
}

/** Parses JSON text; undefined if invalid. */
export function tryParseJson(text: string): { readonly value: unknown } | undefined {
	try {
		return { value: JSON.parse(text) as unknown };
	} catch {
		return undefined;
	}
}
