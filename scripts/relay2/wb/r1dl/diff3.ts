/**
 * Reference line-based three-way merge (diff3) for the W4 R1 harness — NOT the product implementation.
 *
 * W3 owns the in-repo diff3 used by the plugin (D4). This copy exists only so the R1 fixture table can be validated
 * before W3 lands and so R1 can cross-check W3's results case by case. Semantics mirror D4:
 *   - base present: non-overlapping changes merge; overlapping changes that differ → conflict; identical changes on
 *     both sides → taken once (false conflicts avoided).
 *   - no base: identical → skip (0 rows); otherwise → conflict copy. No "superset wins".
 * Adjacent edits (one side ends where the other starts, or two insertions at the same point) count as overlapping,
 * like git's default.
 */

export type MergeResult = { kind: "clean"; text: string } | { kind: "conflict"; reason: string };
export type NoBaseResult = { kind: "skip" } | { kind: "conflict"; reason: string };

/** Split keeping line terminators so join("") round-trips exactly (incl. a missing final newline). */
export function splitLines(text: string): string[] {
	if (text === "") return [];
	const out: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") { out.push(text.slice(start, i + 1)); start = i + 1; }
	if (start < text.length) out.push(text.slice(start));
	return out;
}

interface Hunk { start: number; end: number; lines: string[] } // replace base[start, end) with lines

/** LCS (DP; reference-only, fine for fixture-sized texts) → hunks over `base`. */
export function hunks(base: string[], side: string[]): Hunk[] {
	const n = base.length, m = side.length;
	if (n * m > 25_000_000) throw new Error(`reference diff3 too large (${n}x${m} lines)`);
	const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
		dp[i]![j] = base[i] === side[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
	const out: Hunk[] = [];
	let i = 0, j = 0;
	let cur: Hunk | null = null;
	const flush = () => { if (cur) { out.push(cur); cur = null; } };
	while (i < n || j < m) {
		if (i < n && j < m && base[i] === side[j]) { flush(); i++; j++; }
		else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) { cur ??= { start: i, end: i, lines: [] }; cur.lines.push(side[j]!); j++; }
		else { cur ??= { start: i, end: i, lines: [] }; cur.end = i + 1; i++; }
	}
	flush();
	return out;
}

/** Text of `side` over base[start, end), given that side's hunks. */
function sideRange(base: string[], hs: Hunk[], start: number, end: number): string[] {
	const out: string[] = [];
	let i = start;
	for (const h of hs) {
		if (h.end < start || h.start > end) continue;
		while (i < h.start) out.push(base[i++]!);
		out.push(...h.lines);
		i = Math.max(i, h.end);
	}
	while (i < end) out.push(base[i++]!);
	return out;
}

export function merge3(baseText: string, oursText: string, theirsText: string): MergeResult {
	const base = splitLines(baseText);
	const ours = hunks(base, splitLines(oursText)).map((h) => ({ ...h, side: 0 as const }));
	const theirs = hunks(base, splitLines(theirsText)).map((h) => ({ ...h, side: 1 as const }));
	const all = [...ours, ...theirs].sort((a, b) => a.start - b.start || a.end - b.end);
	const out: string[] = [];
	let pos = 0;
	let k = 0;
	while (k < all.length) {
		const group = [all[k]!];
		let start = all[k]!.start, end = all[k]!.end;
		k++;
		while (k < all.length) {
			const h = all[k]!;
			const touches = h.start < end || (h.start === end && (h.start === h.end || start === end || h.side !== group.at(-1)!.side));
			if (!touches) break;
			group.push(h); end = Math.max(end, h.end); k++;
		}
		while (pos < start) out.push(base[pos++]!);
		const sides = new Set(group.map((h) => h.side));
		if (sides.size === 1) {
			out.push(...sideRange(base, group, start, end));
		} else {
			const a = sideRange(base, group.filter((h) => h.side === 0), start, end).join("");
			const b = sideRange(base, group.filter((h) => h.side === 1), start, end).join("");
			if (a !== b) return { kind: "conflict", reason: `overlapping edits at base lines ${start + 1}-${end}` };
			out.push(a);
		}
		pos = end;
	}
	while (pos < base.length) out.push(base[pos++]!);
	return { kind: "clean", text: out.join("") };
}

export function mergeNoBase(ours: string, theirs: string): NoBaseResult {
	return ours === theirs ? { kind: "skip" } : { kind: "conflict", reason: "no base and content differs" };
}
