/**
 * Bounded Myers O(ND) diff over integer token sequences (interned lines or
 * code points), ported from legacy-src/sync/lineMerge.ts and generalised.
 *
 * Every function here is exact: when a budget is exceeded the changed middle
 * becomes one coarse hunk (still a correct edit script, only less precise).
 */

export interface Hunk {
	/** a[aStart, aEnd) is replaced by b[bStart, bEnd). */
	readonly aStart: number;
	readonly aEnd: number;
	readonly bStart: number;
	readonly bEnd: number;
}

export interface MyersBudget {
	/** Max edit distance (tokens inserted + deleted) explored. */
	readonly maxD: number;
	/** Max snake steps (approximate work units). */
	readonly maxWork: number;
}

/** Line diffs: legacy MAX_LINE_DIFF_DISTANCE / MAX_LINE_DIFF_WORK. */
export const LINE_BUDGET: MyersBudget = { maxD: 2_000, maxWork: 20_000_000 };

/** Optional accumulator of work spent (snake steps), so callers can bound a series of calls. */
export interface MyersStats { work: number }

type Tokens = Int32Array;

/**
 * Myers greedy diff of a[aStart, aEnd) vs b[bStart, bEnd). Hunks in absolute
 * coordinates, ascending, non-adjacent. null if the budget is exceeded.
 * Memory is O(D^2) for the trace, so maxD bounds it (2000 -> ~16 MB worst).
 */
export function myers(a: Tokens, aStart: number, aEnd: number, b: Tokens, bStart: number, bEnd: number, budget: MyersBudget, stats?: MyersStats): Hunk[] | null {
	const n = aEnd - aStart;
	const m = bEnd - bStart;
	if (n === 0 && m === 0) return [];
	if (n === 0 || m === 0) return [{ aStart, aEnd, bStart, bEnd }];
	const max = Math.min(n + m, budget.maxD);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	let work = 0;
	let found = -1;
	for (let d = 0; d <= max; d++) {
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
				? v[offset + k + 1]!
				: v[offset + k - 1]! + 1;
			let y = x - k;
			const snakeStart = x;
			while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
				x++;
				y++;
			}
			work += 1 + x - snakeStart;
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
		trace.push(v.slice(offset - d, offset + d + 1));
		if (found >= 0) break;
		if (work > budget.maxWork) break;
	}
	if (stats) stats.work += work;
	if (found < 0) return null;

	// Backtrack single-token operations from the end.
	const opsKind: number[] = []; // 0 = insert, 1 = delete
	const opsA: number[] = [];
	const opsB: number[] = [];
	let x = n;
	let y = m;
	for (let d = found; d > 0; d--) {
		const previous = trace[d - 1]!;
		const at = (k: number) => previous[k + d - 1]!;
		const k = x - y;
		const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
		const previousX = at(previousK);
		const previousY = previousX - previousK;
		while (x > previousX && y > previousY) {
			x--;
			y--;
		}
		opsKind.push(x === previousX ? 0 : 1);
		opsA.push(previousX);
		opsB.push(previousY);
		x = previousX;
		y = previousY;
	}

	const hunks: { aStart: number; aEnd: number; bStart: number; bEnd: number }[] = [];
	let current: { aStart: number; aEnd: number; bStart: number; bEnd: number } | null = null;
	for (let i = opsKind.length - 1; i >= 0; i--) {
		const ai = aStart + opsA[i]!;
		const bi = bStart + opsB[i]!;
		if (current === null || current.aEnd !== ai || current.bEnd !== bi) {
			current = { aStart: ai, aEnd: ai, bStart: bi, bEnd: bi };
			hunks.push(current);
		}
		if (opsKind[i] === 1) current.aEnd++;
		else current.bEnd++;
	}
	return hunks;
}

/**
 * Common prefix/suffix trim, then Myers. Over budget: patience-style anchors
 * (tokens unique on both sides, longest increasing run), bounded Myers per gap,
 * a coarse hunk for any gap still over budget. Total work stays bounded by
 * ~3 x budget.maxWork.
 */
export function diffTokens(a: Tokens, b: Tokens, budget: MyersBudget, stats?: MyersStats): { hunks: Hunk[]; exact: boolean } {
	let prefix = 0;
	const limit = Math.min(a.length, b.length);
	while (prefix < limit && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < limit - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
	const aEnd = a.length - suffix;
	const bEnd = b.length - suffix;
	const local: MyersStats = { work: 0 };
	const exact = myers(a, prefix, aEnd, b, prefix, bEnd, budget, local);
	if (stats) stats.work += local.work;
	if (exact) return { hunks: exact, exact: true };
	return { hunks: anchoredDiff(a, prefix, aEnd, b, prefix, bEnd, budget, stats), exact: false };
}

/** Indices (into `values`) of one longest strictly increasing subsequence. */
function longestIncreasing(values: Int32Array): Int32Array {
	const n = values.length;
	if (n === 0) return new Int32Array(0);
	const tails = new Int32Array(n);
	const tailIdx = new Int32Array(n);
	const prev = new Int32Array(n).fill(-1);
	let len = 0;
	for (let i = 0; i < n; i++) {
		const v = values[i]!;
		let lo = 0;
		let hi = len;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (tails[mid]! < v) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) prev[i] = tailIdx[lo - 1]!;
		tails[lo] = v;
		tailIdx[lo] = i;
		if (lo === len) len++;
	}
	const out = new Int32Array(len);
	let k = tailIdx[len - 1]!;
	for (let j = len - 1; j >= 0; j--) {
		out[j] = k;
		k = prev[k]!;
	}
	return out;
}

function anchoredDiff(a: Tokens, aStart: number, aEnd: number, b: Tokens, bStart: number, bEnd: number, budget: MyersBudget, stats?: MyersStats): Hunk[] {
	// Tokens occurring exactly once in each range.
	const seenA = new Map<number, number>(); // token -> position, or -1 if repeated
	for (let i = aStart; i < aEnd; i++) {
		const t = a[i]!;
		seenA.set(t, seenA.has(t) ? -1 : i);
	}
	const seenB = new Map<number, number>();
	for (let j = bStart; j < bEnd; j++) {
		const t = b[j]!;
		seenB.set(t, seenB.has(t) ? -1 : j);
	}
	const anchorA: number[] = [];
	const anchorB: number[] = [];
	for (let j = bStart; j < bEnd; j++) {
		const t = b[j]!;
		if (seenB.get(t) !== j) continue;
		const i = seenA.get(t);
		if (i === undefined || i < 0) continue;
		anchorA.push(i);
		anchorB.push(j);
	}
	const keep = longestIncreasing(Int32Array.from(anchorA));
	const hunks: Hunk[] = [];
	const total: MyersStats = { work: 0 };
	const gap = (a0: number, a1: number, b0: number, b1: number) => {
		if (a0 === a1 && b0 === b1) return;
		let sub: Hunk[] | null = null;
		if (total.work < 2 * budget.maxWork) {
			sub = myers(a, a0, a1, b, b0, b1, { maxD: budget.maxD, maxWork: Math.max(1, 2 * budget.maxWork - total.work) }, total);
		}
		if (sub === null) sub = [{ aStart: a0, aEnd: a1, bStart: b0, bEnd: b1 }];
		for (const h of sub) hunks.push(h);
	};
	let ai = aStart;
	let bj = bStart;
	for (let k = 0; k < keep.length; k++) {
		const i = anchorA[keep[k]!]!;
		const j = anchorB[keep[k]!]!;
		gap(ai, i, bj, j);
		ai = i + 1;
		bj = j + 1;
	}
	gap(ai, aEnd, bj, bEnd);
	if (stats) stats.work += total.work;
	// Merge hunks that became adjacent (gap boundaries).
	const merged: Hunk[] = [];
	for (const h of hunks) {
		const last = merged[merged.length - 1];
		if (last && last.aEnd === h.aStart && last.bEnd === h.bStart) {
			merged[merged.length - 1] = { aStart: last.aStart, aEnd: h.aEnd, bStart: last.bStart, bEnd: h.bEnd };
		} else merged.push(h);
	}
	return merged;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** A line is the text up to and including "\n"; a final unterminated line is its own (different) line. */
export function splitLines(text: string): string[] {
	const lines: string[] = [];
	let from = 0;
	while (from < text.length) {
		const newline = text.indexOf("\n", from);
		if (newline < 0) {
			lines.push(text.slice(from));
			break;
		}
		lines.push(text.slice(from, newline + 1));
		from = newline + 1;
	}
	return lines;
}

export interface LineText {
	/** Interned line ids. */
	readonly ids: Int32Array;
	/** offsets[i] = char offset of line i; offsets[ids.length] = text.length. */
	readonly offsets: Int32Array;
}

export class LineInterner {
	private readonly map = new Map<string, number>();
	readonly texts: string[] = [];
	tokenize(text: string): LineText {
		const lines = splitLines(text);
		const ids = new Int32Array(lines.length);
		const offsets = new Int32Array(lines.length + 1);
		let offset = 0;
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			let id = this.map.get(line);
			if (id === undefined) {
				id = this.texts.length;
				this.map.set(line, id);
				this.texts.push(line);
			}
			ids[index] = id;
			offsets[index] = offset;
			offset += line.length;
		}
		offsets[lines.length] = offset;
		return { ids, offsets };
	}
}

/** Line diff of a -> b as char-offset hunks (coarse when over LINE_BUDGET). */
export function lineDiff(a: string, b: string, budget: MyersBudget = LINE_BUDGET): { edits: { start: number; end: number; text: string }[]; exact: boolean } {
	const interner = new LineInterner();
	const la = interner.tokenize(a);
	const lb = interner.tokenize(b);
	const { hunks, exact } = diffTokens(la.ids, lb.ids, budget);
	return {
		exact,
		edits: hunks.map((h) => ({
			start: la.offsets[h.aStart]!,
			end: la.offsets[h.aEnd]!,
			text: b.slice(lb.offsets[h.bStart]!, lb.offsets[h.bEnd]!),
		})),
	};
}
