/**
 * Minimal text diff crdt0 -> target for applying a merge result to Y.Text
 * (DESIGN §f.3). Never a wholesale replace.
 *
 * - Common prefix/suffix trim on code-point boundaries.
 * - Bounded Myers over code points of the middle.
 * - Line granularity fallback: the line diff of the full texts, each hunk
 *   refined by a code-point-safe trim and (budget permitting) char Myers.
 * - Token alignment (tokenAlign) of whichever script is used, see below.
 * - The char script is used when it is no larger than the plain line diff
 *   (`lineDiffSize`); otherwise the aligned refined line diff, which never
 *   is. So the result is never larger than the plain line diff.
 *
 * Every edit boundary lies on a code-point boundary: Y.Text would turn a split
 * surrogate pair into U+FFFD.
 *
 * Token alignment. A char-minimal script happily reuses single characters of
 * the old text inside new words ("cat" -> "cart" inserts "r"; "[A.2]" ->
 * "[B.27] " keeps "[", ".2" and "]"). Applied to a Y.Text that is harmless
 * alone, but a concurrent edit then lands inside the new word, or a
 * concurrent delete of the old word takes the reused characters with it
 * (sim seed 511: "[A.[B.23] 53]"). So every edit is widened until both its
 * ends are token boundaries in both texts. A token is a run of word
 * characters (Unicode letters, digits, combining marks, "_") or any single
 * other code point; a boundary never splits a surrogate pair. Then a short
 * equality between two edits (no longer than the larger side of either
 * neighbour, Fraser's semantic cleanup rule) is absorbed into one edit, so
 * punctuation between changed words is not reused either. "\n" is a token of
 * its own and an equality containing one is never absorbed: lines stay
 * anchors, edits never grow across a kept line break.
 */

import { LINE_BUDGET, lineDiff, myers, type MyersBudget, type MyersStats } from "./myers";

/** Replace from[start, end) with text. Offsets are UTF-16 indices into `from`. */
export interface TextEdit {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

export const CHAR_BUDGET: MyersBudget = { maxD: 1_500, maxWork: 8_000_000 };
/** Per line-hunk refinement and the total refinement work across hunks. */
export const HUNK_CHAR_BUDGET: MyersBudget = { maxD: 400, maxWork: 1_000_000 };
export const TOTAL_REFINE_WORK = 8_000_000;

function isHigh(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLow(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

/** Code-point-safe common prefix of a[aFrom, aTo) and b[bFrom, bTo). */
function commonPrefix(a: string, aFrom: number, aTo: number, b: string, bFrom: number, bTo: number): number {
	const limit = Math.min(aTo - aFrom, bTo - bFrom);
	let n = 0;
	while (n < limit && a.charCodeAt(aFrom + n) === b.charCodeAt(bFrom + n)) n++;
	// Never end between a high and a low surrogate of either side.
	if (n > 0 && isHigh(a.charCodeAt(aFrom + n - 1))) {
		const aSplits = aFrom + n < aTo && isLow(a.charCodeAt(aFrom + n));
		const bSplits = bFrom + n < bTo && isLow(b.charCodeAt(bFrom + n));
		if (aSplits || bSplits) n--;
	}
	return n;
}

/** Code-point-safe common suffix of a[aFrom, aTo) and b[bFrom, bTo). */
function commonSuffix(a: string, aFrom: number, aTo: number, b: string, bFrom: number, bTo: number): number {
	const limit = Math.min(aTo - aFrom, bTo - bFrom);
	let n = 0;
	while (n < limit && a.charCodeAt(aTo - 1 - n) === b.charCodeAt(bTo - 1 - n)) n++;
	// Never start between a high and a low surrogate of either side.
	if (n > 0 && isLow(a.charCodeAt(aTo - n))) {
		const aSplits = aTo - n - 1 >= aFrom && isHigh(a.charCodeAt(aTo - n - 1));
		const bSplits = bTo - n - 1 >= bFrom && isHigh(b.charCodeAt(bTo - n - 1));
		if (aSplits || bSplits) n--;
	}
	return n;
}

interface CodePoints { readonly cps: Int32Array; readonly offsets: Int32Array }

/** Code points of s[from, to); offsets[i] = UTF-16 offset (absolute) of code point i. */
function codePoints(s: string, from: number, to: number): CodePoints {
	const cps = new Int32Array(to - from);
	const offsets = new Int32Array(to - from + 1);
	let count = 0;
	let i = from;
	while (i < to) {
		const code = s.charCodeAt(i);
		offsets[count] = i;
		if (isHigh(code) && i + 1 < to && isLow(s.charCodeAt(i + 1))) {
			cps[count++] = ((code - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00) + 0x10000;
			i += 2;
		} else {
			cps[count++] = code;
			i += 1;
		}
	}
	offsets[count] = to;
	return { cps: cps.subarray(0, count), offsets: offsets.subarray(0, count + 1) };
}

/**
 * Char-level diff of from[aFrom, aTo) -> to[bFrom, bTo) (absolute offsets),
 * trimmed then Myers over code points. null when over budget.
 */
function charDiffRange(
	from: string, aFrom: number, aTo: number,
	to: string, bFrom: number, bTo: number,
	budget: MyersBudget, stats?: MyersStats,
): TextEdit[] | null {
	const prefix = commonPrefix(from, aFrom, aTo, to, bFrom, bTo);
	const suffix = commonSuffix(from, aFrom + prefix, aTo, to, bFrom + prefix, bTo);
	const a0 = aFrom + prefix;
	const a1 = aTo - suffix;
	const b0 = bFrom + prefix;
	const b1 = bTo - suffix;
	if (a0 === a1 && b0 === b1) return [];
	if (a0 === a1 || b0 === b1) return [{ start: a0, end: a1, text: to.slice(b0, b1) }];
	const ca = codePoints(from, a0, a1);
	const cb = codePoints(to, b0, b1);
	const hunks = myers(ca.cps, 0, ca.cps.length, cb.cps, 0, cb.cps.length, budget, stats);
	if (hunks === null) return null;
	return hunks.map((h) => ({
		start: ca.offsets[h.aStart]!,
		end: ca.offsets[h.aEnd]!,
		text: to.slice(cb.offsets[h.bStart]!, cb.offsets[h.bEnd]!),
	}));
}

/** Line diff of the full texts (`lines`) with each hunk refined at char granularity. */
function refinedLineDiff(from: string, to: string, lines: readonly TextEdit[]): TextEdit[] {
	const stats: MyersStats = { work: 0 };
	const refined: TextEdit[] = [];
	let shift = 0; // to-offset minus from-offset before the current hunk
	for (const edit of lines) {
		const bStart = edit.start + shift;
		const bEnd = bStart + edit.text.length;
		shift += edit.text.length - (edit.end - edit.start);
		let pieces: TextEdit[] | null = null;
		if (stats.work < TOTAL_REFINE_WORK) {
			pieces = charDiffRange(from, edit.start, edit.end, to, bStart, bEnd, HUNK_CHAR_BUDGET, stats);
		}
		if (pieces === null) {
			const prefix = commonPrefix(from, edit.start, edit.end, to, bStart, bEnd);
			const suffix = commonSuffix(from, edit.start + prefix, edit.end, to, bStart + prefix, bEnd);
			pieces = [{ start: edit.start + prefix, end: edit.end - suffix, text: to.slice(bStart + prefix, bEnd - suffix) }];
		}
		for (const piece of pieces) refined.push(piece);
	}
	return refined;
}

function hasSurrogate(s: string, from: number, to: number): boolean {
	for (let i = from; i < to; i++) {
		const code = s.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdfff) return true;
	}
	return false;
}

export function editSize(edits: readonly TextEdit[]): number {
	let size = 0;
	for (const edit of edits) size += edit.end - edit.start + edit.text.length;
	return size;
}

/** Size of the plain line diff (the bound minimalDiff never exceeds). */
export function lineDiffSize(from: string, to: string): number {
	return editSize(lineDiff(from, to, LINE_BUDGET).edits);
}

// --- token alignment ---------------------------------------------------------

const WORD_RE = /[\p{L}\p{N}\p{M}_]/u;

function isWordCp(cp: number): boolean {
	if (cp < 0x80) return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f;
	return WORD_RE.test(String.fromCodePoint(cp));
}

/** Code point ending at i (i > 0); a lone surrogate counts as itself. */
function cpBefore(s: string, i: number): number {
	const c = s.charCodeAt(i - 1);
	if (isLow(c) && i >= 2) {
		const h = s.charCodeAt(i - 2);
		if (isHigh(h)) return ((h - 0xd800) << 10) + (c - 0xdc00) + 0x10000;
	}
	return c;
}

/** Code point starting at i (i < s.length); a lone surrogate counts as itself. */
function cpAt(s: string, i: number): number {
	const c = s.charCodeAt(i);
	if (isHigh(c) && i + 1 < s.length) {
		const l = s.charCodeAt(i + 1);
		if (isLow(l)) return ((c - 0xd800) << 10) + (l - 0xdc00) + 0x10000;
	}
	return c;
}

/** True at the ends and between two tokens: never inside a surrogate pair or a run of word characters. */
export function isTokenBoundary(s: string, i: number): boolean {
	if (i <= 0 || i >= s.length) return true;
	if (isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i))) return false;
	return !(isWordCp(cpBefore(s, i)) && isWordCp(cpAt(s, i)));
}

/** An edit as from[a0, a1) -> to[b0, b1). */
interface Span { a0: number; a1: number; b0: number; b1: number }

function hasLineBreak(s: string, from: number, to: number): boolean {
	for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) return true;
	return false;
}

/**
 * Widen ascending non-overlapping edits until both ends are token boundaries
 * in `from` and in `to`, merging edits that meet; then absorb short equalities
 * (without "\n") between edits. The text between two edits is the same in
 * both strings, so a widening step is one code point of it on both sides.
 */
export function tokenAlign(from: string, to: string, edits: readonly TextEdit[]): TextEdit[] {
	const spans: Span[] = [];
	let shift = 0;
	for (const e of edits) {
		const b0 = e.start + shift;
		spans.push({ a0: e.start, a1: e.end, b0, b1: b0 + e.text.length });
		shift += e.text.length - (e.end - e.start);
	}
	const snapped: Span[] = [];
	for (let i = 0; i < spans.length; i++) {
		let { a0, a1, b0, b1 } = spans[i]!;
		const prev = snapped[snapped.length - 1];
		const minA = prev ? prev.a1 : 0;
		while (a0 > minA && !(isTokenBoundary(from, a0) && isTokenBoundary(to, b0))) {
			const n = a0 - 2 >= minA && isLow(from.charCodeAt(a0 - 1)) && isHigh(from.charCodeAt(a0 - 2)) ? 2 : 1;
			a0 -= n;
			b0 -= n;
		}
		const maxA = spans[i + 1]?.a0 ?? from.length;
		while (a1 < maxA && !(isTokenBoundary(from, a1) && isTokenBoundary(to, b1))) {
			const n = a1 + 2 <= maxA && isHigh(from.charCodeAt(a1)) && isLow(from.charCodeAt(a1 + 1)) ? 2 : 1;
			a1 += n;
			b1 += n;
		}
		if (prev && a0 <= prev.a1) {
			prev.a1 = a1;
			prev.b1 = b1;
		} else snapped.push({ a0, a1, b0, b1 });
	}
	const out: Span[] = [];
	for (const s of snapped) {
		let cur = s;
		for (let prev = out[out.length - 1]; prev; prev = out[out.length - 1]) {
			const eq = cur.a0 - prev.a1;
			if (eq > Math.max(prev.a1 - prev.a0, prev.b1 - prev.b0) || eq > Math.max(cur.a1 - cur.a0, cur.b1 - cur.b0)) break;
			if (hasLineBreak(from, prev.a1, cur.a0)) break;
			out.pop();
			cur = { a0: prev.a0, a1: cur.a1, b0: prev.b0, b1: cur.b1 };
		}
		out.push(cur);
	}
	return out.map((s) => ({ start: s.a0, end: s.a1, text: to.slice(s.b0, s.b1) }));
}

/** Ascending, non-overlapping, non-empty, token-aligned edits turning `from` into `to`. */
export function minimalDiff(from: string, to: string): TextEdit[] {
	if (from === to) return [];
	const raw = charDiffRange(from, 0, from.length, to, 0, to.length, CHAR_BUDGET);
	const charEdits = raw === null ? null : tokenAlign(from, to, raw);
	// A surrogate-free raw script has UTF-16 size = code-point size, Myers-minimal, so
	// <= any line diff (lines split on code-point boundaries). If alignment did not
	// grow it, the line diff can be skipped.
	if (raw !== null && charEdits !== null && editSize(charEdits) === editSize(raw) && !raw.some((e) => hasSurrogate(from, e.start, e.end) || hasSurrogate(e.text, 0, e.text.length))) {
		return charEdits;
	}
	const lines = lineDiff(from, to, LINE_BUDGET).edits;
	if (charEdits !== null && editSize(charEdits) <= editSize(lines)) return charEdits;
	// Pieces stay inside their line hunk (hunk ends follow a "\n" or are text ends,
	// so they are token boundaries in both texts, and the equal lines between hunks
	// are never absorbed): the aligned script is never larger than `lines`.
	return tokenAlign(from, to, refinedLineDiff(from, to, lines));
}

/** Apply ascending non-overlapping edits (reference implementation; the engine applies to Y.Text). */
export function applyTextEdits(from: string, edits: readonly TextEdit[]): string {
	const parts: string[] = [];
	let cursor = 0;
	for (const edit of edits) {
		if (edit.start < cursor || edit.end < edit.start) throw new Error("edits must be ascending and non-overlapping");
		parts.push(from.slice(cursor, edit.start), edit.text);
		cursor = edit.end;
	}
	parts.push(from.slice(cursor));
	return parts.join("");
}
