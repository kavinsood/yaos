import { test } from "node:test";
import assert from "node:assert/strict";
import { diffTokens, lineDiff, myers, splitLines, type Hunk } from "./myers";
import { prng } from "./prng";

function applyHunks(a: Int32Array, b: Int32Array, hunks: readonly Hunk[]): number[] {
	const out: number[] = [];
	let cursor = 0;
	for (const h of hunks) {
		assert.ok(h.aStart >= cursor && h.aEnd >= h.aStart && h.bEnd >= h.bStart, "hunks ascending");
		for (let i = cursor; i < h.aStart; i++) out.push(a[i]!);
		for (let j = h.bStart; j < h.bEnd; j++) out.push(b[j]!);
		cursor = h.aEnd;
	}
	for (let i = cursor; i < a.length; i++) out.push(a[i]!);
	return out;
}

function randomSeq(rnd: () => number, n: number, alphabet: number): Int32Array {
	const out = new Int32Array(n);
	for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * alphabet);
	return out;
}

test("diffTokens: valid scripts with exact, anchored and coarse paths (seeded)", () => {
	let anchored = 0;
	for (let seed = 1; seed <= 2000; seed++) {
		const rnd = prng(seed);
		const a = randomSeq(rnd, Math.floor(rnd() * 80), 2 + Math.floor(rnd() * 200));
		const b = Int32Array.from(a);
		const edits = Array.from(b);
		for (let e = Math.floor(rnd() * 20); e > 0; e--) {
			const at = Math.floor(rnd() * (edits.length + 1));
			if (rnd() < 0.5) edits.splice(at, 1);
			else edits.splice(at, 0, Math.floor(rnd() * 300));
		}
		const target = Int32Array.from(edits);
		const tiny = { maxD: 1 + Math.floor(rnd() * 6), maxWork: 1 + Math.floor(rnd() * 60) };
		const { hunks, exact } = diffTokens(a, target, rnd() < 0.5 ? tiny : { maxD: 1000, maxWork: 1e7 });
		if (!exact) anchored++;
		assert.deepEqual(applyHunks(a, target, hunks), Array.from(target), `seed ${seed}`);
		for (let k = 1; k < hunks.length; k++) {
			const p = hunks[k - 1]!;
			const h = hunks[k]!;
			assert.ok(!(p.aEnd === h.aStart && p.bEnd === h.bStart), "adjacent hunks are merged");
		}
	}
	assert.ok(anchored > 200, `fallback exercised ${anchored} times`);
});

test("myers is optimal on small inputs (matches LCS DP)", () => {
	for (let seed = 1; seed <= 300; seed++) {
		const rnd = prng(seed + 99);
		const a = randomSeq(rnd, Math.floor(rnd() * 25), 4);
		const b = randomSeq(rnd, Math.floor(rnd() * 25), 4);
		const hunks = myers(a, 0, a.length, b, 0, b.length, { maxD: 1000, maxWork: 1e7 })!;
		const d = hunks.reduce((s, h) => s + (h.aEnd - h.aStart) + (h.bEnd - h.bStart), 0);
		const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
		for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
			dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
		}
		assert.equal(d, a.length + b.length - 2 * dp[0]![0]!, `seed ${seed}`);
	}
});

test("splitLines / lineDiff", () => {
	assert.deepEqual(splitLines("a\nb"), ["a\n", "b"]);
	assert.deepEqual(splitLines("a\n"), ["a\n"]);
	assert.deepEqual(splitLines(""), []);
	assert.deepEqual(lineDiff("a\nb\nc\n", "a\nB\nc\n").edits, [{ start: 2, end: 4, text: "B\n" }]);
	assert.deepEqual(lineDiff("a", "a\n").edits, [{ start: 0, end: 1, text: "a\n" }]);
});
