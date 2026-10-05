/**
 * The single path-key function (DESIGN §c.2):
 *   pathKey(p) = NFC(caseFold15_1(NFC(p)))
 * with full case folding (CaseFolding.txt status C + F) from the frozen
 * generated table casefold15_1.ts. Never String.prototype.toLowerCase.
 *
 * pathKey is segment-wise: "/" is a starter that never composes and is never
 * folded, so pathKey("a/b") === pathKey("a") + "/" + pathKey("b"). The fold
 * relies on this to key folder prefixes (tested in pathKey.test.ts).
 */

import type { PathKey, VaultPath } from "../types";
import { CASE_FOLD_15_1 } from "./casefold15_1";
import { asciiLower, isAscii } from "./segments";

let foldTable: Map<number, string> | null = null;

function table(): Map<number, string> {
	if (foldTable) return foldTable;
	const map = new Map<number, string>();
	const data = CASE_FOLD_15_1;
	let i = 0;
	while (i < data.length) {
		const cp = data[i]!;
		const n = data[i + 1]!;
		let s = "";
		for (let j = 0; j < n; j++) s += String.fromCodePoint(data[i + 2 + j]!);
		map.set(cp, s);
		i += 2 + n;
	}
	foldTable = map;
	return map;
}

/** Full Unicode 15.1 case folding (C + F), code point by code point. No normalization. */
export function caseFold15_1(s: string): string {
	if (isAscii(s)) return asciiLower(s);
	const t = table();
	let out = "";
	for (const ch of s) {
		const mapped = t.get(ch.codePointAt(0)!);
		out += mapped ?? ch;
	}
	return out;
}

/** NFC(caseFold15_1(NFC(s))). Works on whole paths and on single segments alike. */
export function foldKey(s: string): string {
	if (isAscii(s)) return asciiLower(s);
	return caseFold15_1(s.normalize("NFC")).normalize("NFC");
}

/** DESIGN §c.2. Input should be a valid VaultPath (validity guarantees version-stable NFC + folding). */
export function pathKey(path: VaultPath): PathKey {
	return foldKey(path) as PathKey;
}

/** Keys of every prefix: "A/b/c.md" -> ["a", "a/b", "a/b/c.md"]. */
export function prefixKeys(path: VaultPath): PathKey[] {
	const segs = path.split("/");
	const out: PathKey[] = [];
	let acc = "";
	for (let i = 0; i < segs.length; i++) {
		acc = i === 0 ? foldKey(segs[i]!) : `${acc}/${foldKey(segs[i]!)}`;
		out.push(acc as PathKey);
	}
	return out;
}
