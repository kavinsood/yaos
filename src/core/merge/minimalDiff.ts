/**
 * Minimal text diff crdt0 -> target for applying a merge result to Y.Text
 * (DESIGN §f.3). Never a wholesale replace.
 *
 * - Common prefix/suffix trim on code-point boundaries.
 * - Bounded Myers over code points of the middle.
 * - Line granularity fallback: the line diff of the full texts, each hunk
 *   refined by a code-point-safe trim and (budget permitting) char Myers.
 * - The smaller of the two scripts wins, so the result is never larger than
 *   the plain line diff (`lineDiffSize`).
 *
 * Every edit boundary lies on a code-point boundary: Y.Text would turn a split
 * surrogate pair into U+FFFD.
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

/** Line diff of the full texts with each hunk refined at char granularity. */
function refinedLineDiff(from: string, to: string): TextEdit[] {
	const stats: MyersStats = { work: 0 };
	const refined: TextEdit[] = [];
	let shift = 0; // to-offset minus from-offset before the current hunk
	for (const edit of lineDiff(from, to, LINE_BUDGET).edits) {
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
	let size = 0;
	for (const edit of lineDiff(from, to, LINE_BUDGET).edits) size += edit.end - edit.start + edit.text.length;
	return size;
}

/** Ascending, non-overlapping, non-empty edits turning `from` into `to`. */
export function minimalDiff(from: string, to: string): TextEdit[] {
	if (from === to) return [];
	const charEdits = charDiffRange(from, 0, from.length, to, 0, to.length, CHAR_BUDGET);
	// Without surrogates in the script, its UTF-16 size equals its code-point
	// size, which is Myers-minimal and so <= any line diff (lines split on
	// code-point boundaries). Only then can the line diff be skipped.
	if (charEdits !== null && !charEdits.some((e) => hasSurrogate(from, e.start, e.end) || hasSurrogate(e.text, 0, e.text.length))) {
		return charEdits;
	}
	const lineEdits = refinedLineDiff(from, to);
	if (charEdits === null) return lineEdits;
	return editSize(charEdits) <= editSize(lineEdits) ? charEdits : lineEdits;
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
