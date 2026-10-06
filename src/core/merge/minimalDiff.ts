/**
 * Minimal text diff crdt0 -> target for applying a merge result to Y.Text
 * (DESIGN §f.3). Never a wholesale replace.
 *
 * - Common prefix/suffix trim, backed off to token boundaries.
 * - Bounded Myers over the tokens of the middle (tokenDiffRange).
 * - Line granularity fallback: the line diff of the full texts, each hunk
 *   refined the same way (budget permitting) or by a code-point-safe trim.
 * - Token alignment (tokenAlign) of whichever script is used, see below.
 * - The token script is used when it is no larger than the plain line diff
 *   (`lineDiffSize`); otherwise the aligned refined line diff, else the plain
 *   one. So the result is never larger than the plain line diff.
 *
 * Every edit boundary lies on a code-point boundary: Y.Text would turn a split
 * surrogate pair into U+FFFD.
 *
 * Tokens. A char-minimal script happily reuses single characters of the old
 * text inside new words ("cat" -> "cart" inserts "r"; "[A.2]" -> "[B.27] "
 * keeps "[", ".2" and "]"; "the cat" -> "a dog" keeps the "a" of "cat").
 * Applied to a Y.Text that is harmless alone, but a concurrent edit then
 * lands inside the new word, or a concurrent delete of the old word takes the
 * reused characters with it (sim seed 511: "[A.[B.23] 53]"). So the diff unit
 * is a token: a run of word characters (Unicode letters, digits, combining
 * marks, "_") or any single other code point; a boundary never splits a
 * surrogate pair. Myers over tokens keeps whole words or nothing of them.
 * tokenAlign then:
 * 1. widens every edit until both its ends are token boundaries in both
 *    texts (a no-op for token scripts; the trim fallback needs it).
 * 2. A pure insert or delete slides along the equal text around it (the same
 *    script, shifted) to its best-scoring token-aligned position: line
 *    breaks, then whitespace, then punctuation (Fraser's lossless cleanup,
 *    diff-match-patch scores). A trim alone puts "- new\n" into "- a\n- b\n"
 *    as "new\n- " after the "- " of "b", and a concurrent delete of "- b"
 *    then takes the new item's "- " (sim heavy seed 124: "[A.86]\n" became
 *    "]\n[A.86" before the old "]\n"). Ties go to the edit that starts with
 *    an opening or ends with a closing bracket: deleting "[B.9]" from
 *    "[B.9][B.26]" scores the same as deleting "9][B.", and a concurrent
 *    delete of "[B.9]" then takes the "[B." of "[B.26]" (3-device sim seeds
 *    786, 894). Remaining ties keep the original, else the rightmost.
 * 3. A short equality between two edits (no longer than the larger side of
 *    either neighbour, Fraser's semantic cleanup rule) is absorbed into one
 *    edit if it holds no whitespace, so punctuation inside a changed word
 *    ("[A.2]" -> "[B.27]") is not reused. Whitespace-separated words stay
 *    separate edits: absorbing " " between "the"->"a" and "cat"->"dog" would
 *    rewrite the space and scramble a concurrent insert next to it. An
 *    equality holding "\n" is therefore never absorbed: lines stay anchors.
 * 4. A replacement takes short punctuation runs at its ends when that makes
 *    it cover whole whitespace-separated chunks (glue): "[Z.1]" -> "[A.15]"
 *    does not keep the old "[".
 *
 * applyEditsTo puts a replacement inside the old run, see there.
 */

import { LINE_BUDGET, lineDiff, myers, type MyersBudget, type MyersStats } from "./myers";

/** Replace from[start, end) with text. Offsets are UTF-16 indices into `from`. */
export interface TextEdit {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

/** Myers over the tokens of the whole (trimmed) texts. */
export const TOKEN_BUDGET: MyersBudget = { maxD: 1_500, maxWork: 8_000_000 };
/** Per line-hunk refinement and the total refinement work across hunks. */
export const HUNK_TOKEN_BUDGET: MyersBudget = { maxD: 400, maxWork: 1_000_000 };
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

interface TokenSeq { readonly ids: Int32Array; readonly offsets: Int32Array }

/**
 * Interns word tokens by content without slicing them out (2M-char inputs):
 * open addressing on a multiplicative hash, equal hashes confirmed char by
 * char. Ids start above the code-point range.
 */
class WordTable {
	private slots = new Int32Array(1024).fill(-1);
	private readonly hash: number[] = [];
	private readonly src: string[] = [];
	private readonly at: number[] = [];
	private readonly len: number[] = [];

	id(s: string, i: number, j: number, h: number): number {
		const n = j - i;
		let k = h & (this.slots.length - 1);
		for (let e = this.slots[k]!; e >= 0; e = this.slots[k]!) {
			if (this.hash[e] === h && this.len[e] === n && sameRun(this.src[e]!, this.at[e]!, s, i, n)) return 0x110000 + e;
			k = (k + 1) & (this.slots.length - 1);
		}
		const e = this.hash.length;
		this.hash.push(h);
		this.src.push(s);
		this.at.push(i);
		this.len.push(n);
		this.slots[k] = e;
		if (2 * this.hash.length > this.slots.length) this.grow();
		return 0x110000 + e;
	}

	private grow(): void {
		const slots = new Int32Array(this.slots.length * 2).fill(-1);
		for (let e = 0; e < this.hash.length; e++) {
			let k = this.hash[e]! & (slots.length - 1);
			while (slots[k]! >= 0) k = (k + 1) & (slots.length - 1);
			slots[k] = e;
		}
		this.slots = slots;
	}
}

function sameRun(a: string, ai: number, b: string, bi: number, n: number): boolean {
	for (let k = 0; k < n; k++) if (a.charCodeAt(ai + k) !== b.charCodeAt(bi + k)) return false;
	return true;
}

/**
 * Tokens of s[from, to) (both ends token boundaries) as ids: a single code
 * point is its own id; a longer word gets an interned id above the code
 * point range. offsets[i] = UTF-16 offset (absolute) of token i.
 */
function tokenize(s: string, from: number, to: number, words: WordTable): TokenSeq {
	const ids = new Int32Array(to - from);
	const offsets = new Int32Array(to - from + 1);
	let n = 0;
	let i = from;
	while (i < to) {
		offsets[n] = i;
		const c0 = s.charCodeAt(i);
		const cp = c0 < 0x80 ? c0 : cpAt(s, i);
		const w = cp > 0xffff ? 2 : 1;
		if (!(cp < 0x80 ? ASCII_WORD[cp] === 1 : isWordCp(cp))) {
			ids[n++] = cp;
			i += w;
			continue;
		}
		let h = Math.imul(cp, 0x9e3779b1);
		let j = i + w;
		while (j < to) {
			const c = s.charCodeAt(j);
			if (c < 0x80) {
				if (ASCII_WORD[c] === 0) break;
				h = Math.imul(h ^ c, 0x01000193);
				j++;
				continue;
			}
			const d = cpAt(s, j);
			if (!isWordCp(d)) break;
			h = Math.imul(h ^ d, 0x01000193);
			j += d > 0xffff ? 2 : 1;
		}
		ids[n++] = j - i > w ? words.id(s, i, j, (h ^ (h >>> 15)) | 0) : cp;
		i = j;
	}
	offsets[n] = to;
	return { ids: ids.subarray(0, n), offsets: offsets.subarray(0, n + 1) };
}

/**
 * Token-level diff of from[aFrom, aTo) -> to[bFrom, bTo) (absolute offsets,
 * token boundaries): common prefix/suffix trimmed back to token boundaries,
 * then Myers over tokens. Every edit boundary is a token boundary in both
 * texts. null when over budget.
 */
function tokenDiffRange(
	from: string, aFrom: number, aTo: number,
	to: string, bFrom: number, bTo: number,
	budget: MyersBudget, stats?: MyersStats,
): TextEdit[] | null {
	let prefix = commonPrefix(from, aFrom, aTo, to, bFrom, bTo);
	while (prefix > 0 && !(isTokenBoundary(from, aFrom + prefix) && isTokenBoundary(to, bFrom + prefix))) prefix--;
	let suffix = commonSuffix(from, aFrom + prefix, aTo, to, bFrom + prefix, bTo);
	while (suffix > 0 && !(isTokenBoundary(from, aTo - suffix) && isTokenBoundary(to, bTo - suffix))) suffix--;
	const a0 = aFrom + prefix;
	const a1 = aTo - suffix;
	const b0 = bFrom + prefix;
	const b1 = bTo - suffix;
	if (a0 === a1 && b0 === b1) return [];
	if (a0 === a1 || b0 === b1) return [{ start: a0, end: a1, text: to.slice(b0, b1) }];
	const words = new WordTable();
	const ta = tokenize(from, a0, a1, words);
	const tb = tokenize(to, b0, b1, words);
	const hunks = myers(ta.ids, 0, ta.ids.length, tb.ids, 0, tb.ids.length, budget, stats);
	if (hunks === null) return null;
	return hunks.map((h) => ({
		start: ta.offsets[h.aStart]!,
		end: ta.offsets[h.aEnd]!,
		text: to.slice(tb.offsets[h.bStart]!, tb.offsets[h.bEnd]!),
	}));
}

/** Line diff of the full texts (`lines`) with each hunk refined at token granularity. */
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
			pieces = tokenDiffRange(from, edit.start, edit.end, to, bStart, bEnd, HUNK_TOKEN_BUDGET, stats);
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

function hasLineBreak(s: string, from: number, to: number): boolean {
	for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) return true;
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

/** ASCII_WORD[c] === 1 for [0-9A-Za-z_]. */
const ASCII_WORD = /* @__PURE__ */ (() => {
	const t = new Uint8Array(128);
	for (let c = 0; c < 128; c++) t[c] = (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f ? 1 : 0;
	return t;
})();

/** BMP classification cache (0 unknown, 1 word, 2 other), allocated on first use. */
let bmpClass: Uint8Array | null = null;
const astralClass = new Map<number, boolean>();

function isWordCp(cp: number): boolean {
	if (cp < 0x80) return ASCII_WORD[cp] === 1;
	if (cp > 0xffff) {
		let c = astralClass.get(cp);
		if (c === undefined) {
			c = WORD_RE.test(String.fromCodePoint(cp));
			if (astralClass.size < 4096) astralClass.set(cp, c);
		}
		return c;
	}
	const cache = (bmpClass ??= new Uint8Array(0x10000));
	let c = cache[cp]!;
	if (c === 0) cache[cp] = c = WORD_RE.test(String.fromCharCode(cp)) ? 1 : 2;
	return c === 1;
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

/** Unicode White_Space (all of it is in the BMP). */
function isSpaceCp(cp: number): boolean {
	if (cp < 0x80) return cp === 0x20 || (cp >= 0x09 && cp <= 0x0d);
	return /\s/u.test(String.fromCharCode(cp));
}

function hasSpace(s: string, from: number, to: number): boolean {
	for (let i = from; i < to; i++) if (isSpaceCp(s.charCodeAt(i))) return true;
	return false;
}

/** diff-match-patch's lossless boundary score between code points c1 | c2 (-1: text edge). */
function boundaryScore(c1: number, c2: number): number {
	if (c1 < 0 || c2 < 0) return 6;
	if (c1 === 10 || c1 === 13 || c2 === 10 || c2 === 13) return 4;
	const ws1 = isSpaceCp(c1);
	const ws2 = isSpaceCp(c2);
	const word1 = isWordCp(c1);
	if (!word1 && !ws1 && ws2) return 3;
	if (ws1 || ws2) return 2;
	return !word1 || !isWordCp(c2) ? 1 : 0;
}

const OPEN_RE = /\p{Ps}/u;
const CLOSE_RE = /\p{Pe}/u;

/** Opening / closing bracket (Unicode Ps / Pe). */
function isOpenCp(cp: number): boolean {
	if (cp < 0x80) return cp === 0x28 || cp === 0x5b || cp === 0x7b;
	return OPEN_RE.test(String.fromCodePoint(cp));
}

function isCloseCp(cp: number): boolean {
	if (cp < 0x80) return cp === 0x29 || cp === 0x5d || cp === 0x7d;
	return CLOSE_RE.test(String.fromCodePoint(cp));
}

/** Max UTF-16 units a pure insert/delete slides each way (keeps the pass linear on long runs). */
const SLIDE_MAX = 256;

/**
 * Slide a pure insert or delete within from[lo, hi) along the equal text
 * around it to its best-scoring token-aligned position. Sliding right by n is
 * valid while the next n units equal the edit's first n (the edit text
 * rotates); left mirrors it. Replacements stay put.
 */
function slide(from: string, to: string, s: Span, lo: number, hi: number): void {
	const ins = s.a0 === s.a1;
	if (ins === (s.b0 === s.b1)) return;
	const src = ins ? to : from;
	const x = ins ? s.b0 : s.a0;
	const len = ins ? s.b1 - s.b0 : s.a1 - s.a0;
	const score = (k: number): number => {
		const a0 = s.a0 + k;
		const a1 = s.a1 + k;
		const before = a0 > 0 ? cpBefore(from, a0) : -1;
		const head = cpAt(src, x + k);
		const tail = cpBefore(src, x + k + len);
		const after = a1 < from.length ? cpAt(from, a1) : -1;
		// Tie-break: an edit that opens a bracket at its start or closes one at its end
		// ("[B.9]", not "9][B." in "[B.9][B.26]"); one that does the reverse last.
		const bracket = (isOpenCp(head) ? 1 : isCloseCp(head) ? -1 : 0) + (isCloseCp(tail) ? 1 : isOpenCp(tail) ? -1 : 0);
		return 5 * (boundaryScore(before, head) + boundaryScore(tail, after)) + bracket;
	};
	let best = 0;
	let bestScore = score(0);
	const consider = (k: number): void => {
		if (!(isTokenBoundary(from, s.a0 + k) && isTokenBoundary(from, s.a1 + k) && isTokenBoundary(to, s.b0 + k) && isTokenBoundary(to, s.b1 + k))) return;
		const sc = score(k);
		if (sc > bestScore || (sc === bestScore && best !== 0 && k > best)) {
			best = k;
			bestScore = sc;
		}
	};
	for (let k = 0; k < SLIDE_MAX; ) {
		const p = s.a1 + k;
		const n = p + 1 < hi && isHigh(from.charCodeAt(p)) && isLow(from.charCodeAt(p + 1)) ? 2 : 1;
		if (p + n > hi || from.slice(p, p + n) !== src.slice(x + k, x + k + n)) break;
		k += n;
		consider(k);
	}
	for (let k = 0; -k < SLIDE_MAX; ) {
		const p = s.a0 + k;
		const n = p - 2 >= lo && isLow(from.charCodeAt(p - 1)) && isHigh(from.charCodeAt(p - 2)) ? 2 : 1;
		if (p - n < lo || from.slice(p - n, p) !== src.slice(x + k + len - n, x + k + len)) break;
		k -= n;
		consider(k);
	}
	s.a0 += best;
	s.a1 += best;
	s.b0 += best;
	s.b1 += best;
}

/**
 * Widen ascending non-overlapping edits until both ends are token boundaries
 * in `from` and in `to`, merging edits that meet; slide pure inserts/deletes
 * to their best boundary; absorb short whitespace-free equalities between
 * edits; glue punctuation to replacements (header, steps 1-4). The text
 * between two edits is the same in both strings, so a widening step is one
 * code point of it on both sides.
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
	for (let i = 0; i < snapped.length; i++) slide(from, to, snapped[i]!, snapped[i - 1]?.a1 ?? 0, snapped[i + 1]?.a0 ?? from.length);
	const out: Span[] = [];
	for (const s of snapped) {
		let cur = s;
		for (let prev = out[out.length - 1]; prev; prev = out[out.length - 1]) {
			const eq = cur.a0 - prev.a1;
			if (eq > Math.max(prev.a1 - prev.a0, prev.b1 - prev.b0) || eq > Math.max(cur.a1 - cur.a0, cur.b1 - cur.b0)) break;
			if (hasSpace(from, prev.a1, cur.a0)) break;
			out.pop();
			cur = { a0: prev.a0, a1: cur.a1, b0: prev.b0, b1: cur.b1 };
		}
		out.push(cur);
	}
	for (let i = 0; i < out.length; i++) glue(from, to, out[i]!, out[i - 1]?.a1 ?? 0, out[i + 1]?.a0 ?? from.length);
	const done: Span[] = [];
	for (const s of out) {
		const prev = done[done.length - 1];
		if (prev && s.a0 <= prev.a1) {
			prev.a1 = s.a1;
			prev.b1 = s.b1;
		} else done.push(s);
	}
	return done.map((s) => ({ start: s.a0, end: s.a1, text: to.slice(s.b0, s.b1) }));
}

const isPunctCp = (cp: number): boolean => !isWordCp(cp) && !isSpaceCp(cp);

/**
 * A replacement whose ends are short runs of punctuation away from
 * whitespace (or a text edge) in both texts takes those runs: it then
 * replaces whole whitespace-separated chunks. "seed [Z.1]" -> "seed [A.15] "
 * is "Z.1]" -> "A.15] " after alignment and keeps the old "[", which a
 * concurrent delete of "[Z.1]" takes along (sim seeds 961, 974); glued it is
 * "[Z.1]" -> "[A.15] ". "foo(bar)" -> "foo(baz)" stays "bar" -> "baz": the
 * chunk holds a word outside the edit. Each run is at most the larger side.
 */
function glue(from: string, to: string, s: Span, lo: number, hi: number): void {
	if (s.a0 === s.a1 || s.b0 === s.b1) return;
	const max = Math.max(s.a1 - s.a0, s.b1 - s.b0);
	let q = s.a0;
	while (q > lo && s.a0 - q < max) {
		const cp = cpBefore(from, q);
		if (!isPunctCp(cp)) break;
		q -= cp > 0xffff ? 2 : 1;
	}
	let r = s.a1;
	while (r < hi && r - s.a1 < max) {
		const cp = cpAt(from, r);
		if (!isPunctCp(cp)) break;
		r += cp > 0xffff ? 2 : 1;
	}
	if (q === s.a0 && r === s.a1) return;
	const qb = s.b0 - (s.a0 - q);
	const rb = s.b1 + (r - s.a1);
	const open = (q === 0 || isSpaceCp(from.charCodeAt(q - 1))) && (qb === 0 || isSpaceCp(to.charCodeAt(qb - 1)));
	const close = (r === from.length || isSpaceCp(from.charCodeAt(r))) && (rb === to.length || isSpaceCp(to.charCodeAt(rb)));
	if (!open || !close) return;
	s.a0 = q;
	s.b0 = qb;
	s.a1 = r;
	s.b1 = rb;
}

/** Ascending, non-overlapping, non-empty, token-aligned edits turning `from` into `to`. */
export function minimalDiff(from: string, to: string): TextEdit[] {
	if (from === to) return [];
	const raw = tokenDiffRange(from, 0, from.length, to, 0, to.length, TOKEN_BUDGET);
	const aligned = raw === null ? null : tokenAlign(from, to, raw);
	// A token script is token-minimal, not char-minimal, so it is checked against the
	// line diff. Skipped for one edit inside one line: the line structure is unchanged
	// and exactly that line differs, so every line diff replaces it whole on both sides.
	const one = aligned?.length === 1 ? aligned[0]! : null;
	if (one && !hasLineBreak(from, one.start, one.end) && !hasLineBreak(one.text, 0, one.text.length)) return aligned!;
	const lines = lineDiff(from, to, LINE_BUDGET).edits;
	if (aligned !== null && editSize(aligned) <= editSize(lines)) return aligned;
	// Pieces stay inside their line hunk (hunk ends follow a "\n" or are text ends,
	// so they are token boundaries in both texts, and the equal lines between hunks
	// hold "\n", so they are never absorbed; slides move pieces without growing them;
	// glue grows a piece only over punctuation, never past whitespace such as "\n"):
	// the aligned script is never larger than `lines`. The check is belt and braces.
	const refined = tokenAlign(from, to, refinedLineDiff(from, to, lines));
	return editSize(refined) <= editSize(lines) ? refined : lines;
}

/** The two Y.Text methods applyEditsTo needs (structural: core stays Yjs-free). */
export interface TextSink {
	insert(index: number, text: string): void;
	delete(index: number, length: number): void;
}

/**
 * Apply minimalDiff(from, ...) edits to a Y.Text holding `from` (call inside
 * one transaction), end to start so offsets stay valid. A replacement inserts
 * its new text inside the old run, after its first code point, then deletes
 * the run on both sides. Yjs anchors an insert to its neighbours (origin and
 * right origin); here both are characters being deleted, which no concurrent
 * insert at the run's edges can share, so such an insert keeps its side
 * whatever the clientIDs. Deleting first anchors the new text after the
 * deleted run (Yjs skips deleted items to the right), next to a concurrent
 * insert at the right edge: "[A.34]\n" -> "\n[A.55] " beside a remote append
 * gave "[A.[B.39] 55] " for one clientID order (sim seed 558), "cat" ->
 * "cart" beside a remote "s" gave "scart". Inserting first has the same
 * problem at the left edge ("dogbig "). A one-code-point run has no inside:
 * insert first (appends after a word are the commoner case).
 */
export function applyEditsTo(target: TextSink, from: string, edits: readonly TextEdit[]): void {
	for (let i = edits.length - 1; i >= 0; i--) {
		const e = edits[i]!;
		if (e.text.length === 0) {
			if (e.end > e.start) target.delete(e.start, e.end - e.start);
			continue;
		}
		const cp = e.start + 1 < e.end && isHigh(from.charCodeAt(e.start)) && isLow(from.charCodeAt(e.start + 1)) ? 2 : 1;
		const m = e.end - e.start > cp ? e.start + cp : e.start;
		target.insert(m, e.text);
		if (e.end > m) target.delete(m + e.text.length, e.end - m);
		if (m > e.start) target.delete(e.start, m - e.start);
	}
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
