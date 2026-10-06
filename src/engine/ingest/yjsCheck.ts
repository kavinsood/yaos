/**
 * Structural Yjs update check (DESIGN §d.6 stage 2), no doc needed.
 *
 *  - roots: markdown = exactly Y.Text "text" (sequence items only);
 *           canvas = Y.Map "nodes" | "edges" | "doc" (map entries only);
 *  - content: markdown String | Deleted; canvas String | Deleted | Any |
 *    Type(Y.Map | Y.Text); no subdocs, embeds, formats, binary, JSON;
 *  - inserted UTF-16 units <= maxChars; bytes <= maxBytes.
 *
 * Items whose parent is implied by an origin inherit it from a struct that was
 * gated earlier, so only explicit parents are checked.
 */

import * as Y from "yjs";

export type DocClass = "body" | "canvas";

export type YjsCheckResult =
	| { readonly ok: true; readonly insertedChars: number; readonly structs: number }
	| { readonly ok: false; readonly reason: "decode-failed" | "disallowed-type" | "oversize" | "yjs-structure"; readonly detail: string };

const CANVAS_ROOTS = new Set(["nodes", "edges", "doc"]);

export function checkYjsUpdate(update: Uint8Array, cls: DocClass, limits: { readonly maxBytes: number; readonly maxChars: number }): YjsCheckResult {
	if (update.length > limits.maxBytes) return { ok: false, reason: "oversize", detail: `bytes ${update.length} > ${limits.maxBytes}` };
	let decoded: { structs: Array<Y.Item | Y.GC | Y.Skip>; ds: unknown };
	try {
		decoded = Y.decodeUpdate(update) as typeof decoded;
	} catch (e) {
		return { ok: false, reason: "decode-failed", detail: e instanceof Error ? e.message.slice(0, 120) : "decode" };
	}
	let chars = 0;
	for (const s of decoded.structs) {
		if (!(s instanceof Y.Item)) continue; // GC / Skip carry no content
		const parent = s.parent as unknown;
		const sub = s.parentSub;
		if (typeof parent === "string") {
			if (cls === "body") {
				if (parent !== "text") return { ok: false, reason: "disallowed-type", detail: `root ${parent.slice(0, 40)}` };
				if (sub !== null) return { ok: false, reason: "yjs-structure", detail: "map entry on text root" };
			} else {
				if (!CANVAS_ROOTS.has(parent)) return { ok: false, reason: "disallowed-type", detail: `root ${parent.slice(0, 40)}` };
				if (sub === null) return { ok: false, reason: "yjs-structure", detail: "sequence item on canvas map root" };
			}
		}
		const c = s.content;
		if (c instanceof Y.ContentString) {
			chars += c.str.length;
		} else if (c instanceof Y.ContentDeleted) {
			// ok
		} else if (cls === "canvas" && c instanceof Y.ContentAny) {
			for (const v of c.arr) chars += anyChars(v);
		} else if (cls === "canvas" && c instanceof Y.ContentType) {
			const t = c.type as unknown as { constructor: unknown };
			if (t.constructor !== Y.Map && t.constructor !== Y.Text) return { ok: false, reason: "disallowed-type", detail: "nested type" };
		} else {
			return { ok: false, reason: "disallowed-type", detail: (c as object).constructor.name };
		}
		if (chars > limits.maxChars) return { ok: false, reason: "oversize", detail: `chars > ${limits.maxChars}` };
	}
	return { ok: true, insertedChars: chars, structs: decoded.structs.length };
}

function anyChars(v: unknown): number {
	if (typeof v === "string") return v.length;
	if (v === null || typeof v !== "object") return 8;
	if (v instanceof Uint8Array) return v.length;
	let n = 0;
	if (Array.isArray(v)) for (const x of v) n += anyChars(x);
	else for (const [k, x] of Object.entries(v as Record<string, unknown>)) n += k.length + anyChars(x);
	return n;
}
