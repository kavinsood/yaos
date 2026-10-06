import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs"; // tests only: the Y.Text interleaving check (shipped core stays Yjs-free)
import type { MergeResult } from "../types";
import { DEFAULT_MERGE_LIMITS, merge, mergeValidated } from "./merge";
import { splitLines } from "./myers";
import { applyEditsTo, applyTextEdits, editSize, isTokenBoundary, lineDiffSize, minimalDiff } from "./minimalDiff";
import { prng } from "./prng";

const VOCAB = ["", "a", "b", "# heading", "- item", "same", "same", "😀 emoji", "\t tab", "x y z", "}", "{"];

function randomLine(rnd: () => number, uniq: { n: number }): string {
	if (rnd() < 0.5) return VOCAB[Math.floor(rnd() * VOCAB.length)]!;
	return `line ${uniq.n++} ${rnd() < 0.1 ? "😀" : ""}`;
}

function randomDoc(rnd: () => number, uniq: { n: number }, maxLines: number): string {
	const n = Math.floor(rnd() * maxLines);
	const lines: string[] = [];
	for (let i = 0; i < n; i++) lines.push(randomLine(rnd, uniq));
	const text = lines.join("\n");
	return rnd() < 0.7 && n > 0 ? text + "\n" : text;
}

/** Random line-level edits: insert, delete, replace, toggle the final newline. */
function mutate(rnd: () => number, text: string, uniq: { n: number }, edits: number): string {
	const lines = splitLines(text).map((l) => l.endsWith("\n") ? l.slice(0, -1) : l);
	let trailing = text.endsWith("\n");
	for (let e = 0; e < edits; e++) {
		const r = rnd();
		const at = Math.floor(rnd() * (lines.length + 1));
		if (r < 0.35) lines.splice(at, 0, randomLine(rnd, uniq));
		else if (r < 0.65 && lines.length > 0) lines.splice(Math.min(at, lines.length - 1), 1);
		else if (r < 0.9 && lines.length > 0) lines[Math.min(at, lines.length - 1)] = randomLine(rnd, uniq);
		else trailing = !trailing;
	}
	const joined = lines.join("\n");
	return trailing && lines.length > 0 ? joined + "\n" : joined;
}

function counts(text: string): Map<string, number> {
	const map = new Map<string, number>();
	for (const line of splitLines(text)) map.set(line, (map.get(line) ?? 0) + 1);
	return map;
}

/** Lines whose count on `side` exceeds their count in base (what that side added). */
function added(base: string, side: string): string[] {
	const b = counts(base);
	const out: string[] = [];
	for (const [line, n] of counts(side)) if (n > (b.get(line) ?? 0)) out.push(line);
	return out;
}

function outputLines(result: MergeResult, disk: string, crdt: string): Set<string> {
	switch (result.kind) {
		case "identical": return new Set(splitLines(disk));
		case "disk-only": case "crdt-only": case "clean": return new Set(splitLines(result.text));
		case "conflict": return new Set([...splitLines(result.text), ...splitLines(result.conflictCopy)]);
	}
	void crdt;
}

/** Same line, ignoring the terminator (a final unterminated line may gain "\n" when another side appends after it in a conflict copy). */
function hasLine(set: Set<string>, line: string): boolean {
	return set.has(line) || set.has(line.endsWith("\n") ? line.slice(0, -1) : line + "\n");
}

test("merge: identical and one-sided cases are exact", () => {
	const rnd = prng(11);
	const uniq = { n: 0 };
	for (let round = 0; round < 500; round++) {
		const base = randomDoc(rnd, uniq, 30);
		const side = mutate(rnd, base, uniq, 1 + Math.floor(rnd() * 5));
		const limits = DEFAULT_MERGE_LIMITS;
		assert.deepEqual(merge({ base, disk: side, crdt: side, limits }), { kind: "identical" });
		assert.deepEqual(merge({ base: null, disk: side, crdt: side, limits }), { kind: "identical" });
		if (side === base) continue;
		assert.deepEqual(merge({ base, disk: side, crdt: base, limits }), { kind: "disk-only", text: side });
		assert.deepEqual(merge({ base, disk: base, crdt: side, limits }), { kind: "crdt-only", text: side });
		assert.deepEqual(merge({ base: null, disk: side, crdt: base, limits }), { kind: "conflict", text: base, conflictCopy: side, reason: "no-base" });
	}
});

test("merge property: no line added by disk or crdt is ever lost (seeded, 3000 rounds)", () => {
	const kinds = new Map<string, number>();
	for (let seed = 1; seed <= 3000; seed++) {
		const rnd = prng(seed * 7919);
		const uniq = { n: 0 };
		const base = randomDoc(rnd, uniq, 40);
		const disk = mutate(rnd, base, uniq, Math.floor(rnd() * 6));
		const crdt = mutate(rnd, base, uniq, Math.floor(rnd() * 6));
		const result = merge({ base, disk, crdt, limits: DEFAULT_MERGE_LIMITS });
		const key = result.kind === "conflict" ? `conflict:${result.reason}` : result.kind;
		kinds.set(key, (kinds.get(key) ?? 0) + 1);
		const out = outputLines(result, disk, crdt);
		for (const line of [...added(base, disk), ...added(base, crdt)]) {
			assert.ok(hasLine(out, line), `seed ${seed}: lost ${JSON.stringify(line)} (${key})`);
		}
		if (result.kind === "clean") {
			// Clean output contains every added line exactly (terminators included).
			const exact = new Set(splitLines(result.text));
			for (const line of [...added(base, disk), ...added(base, crdt)]) assert.ok(exact.has(line), `seed ${seed}: clean lost ${JSON.stringify(line)}`);
			// Clean merges are symmetric.
			const swapped = merge({ base, disk: crdt, crdt: disk, limits: DEFAULT_MERGE_LIMITS });
			if (swapped.kind === "clean") assert.equal(swapped.text, result.text, `seed ${seed}: asymmetric clean merge`);
		}
		if (result.kind === "conflict") {
			assert.equal(result.conflictCopy, disk, "conflict copy is always the full disk text");
			// text keeps every line crdt added (the crdt side wins every conflict region).
			const text = new Set(splitLines(result.text));
			for (const line of added(base, crdt)) assert.ok(hasLine(text, line), `seed ${seed}: conflict text lost crdt line`);
		}
	}
	// The generator must actually exercise every path.
	for (const k of ["identical", "disk-only", "crdt-only", "clean", "conflict:both-edited"]) assert.ok((kinds.get(k) ?? 0) > 20, `${k}: ${kinds.get(k)}`);
});

test("merge: clean disjoint edits, identical hunks once, overlap -> crdt + clean disk hunks", () => {
	const base = "a\nb\nc\nd\ne\nf\ng\n";
	const limits = DEFAULT_MERGE_LIMITS;
	assert.deepEqual(merge({ base, disk: "A\nb\nc\nd\ne\nf\ng\n", crdt: "a\nb\nc\nd\ne\nf\nG\n", limits }), { kind: "clean", text: "A\nb\nc\nd\ne\nf\nG\n" });
	assert.deepEqual(merge({ base, disk: "a\nB\nc\nd\nE\nf\ng\n", crdt: "a\nB\nc\nd\ne\nf\ng\n", limits }), { kind: "clean", text: "a\nB\nc\nd\nE\nf\ng\n" });
	const disk = "A\nb\nc\nD1\ne\nf\ng\n";
	const crdt = "a\nb\nc\nD2\ne\nf\ng\n";
	assert.deepEqual(merge({ base, disk, crdt, limits }), { kind: "conflict", text: "A\nb\nc\nD2\ne\nf\ng\n", conflictCopy: disk, reason: "both-edited" });
	// Both append at EOF -> conflict, never glued.
	assert.equal(merge({ base: "x", disk: "x\ny", crdt: "xz", limits }).kind, "conflict");
	// Both sides deleting one of two equal lines delete it once, not both.
	assert.deepEqual(merge({ base: "p\nsame\nsame\nq\n", disk: "p\nsame\nq\n", crdt: "p\nsame\nq\n", limits }), { kind: "identical" });
	assert.deepEqual(merge({ base: "p\nsame\nsame\nq\nr\n", disk: "p\nsame\nq\nr\n", crdt: "p\nsame\nq\nR\n", limits }), { kind: "clean", text: "p\nsame\nq\nR\n" });
});

test("merge: size and edit-count limits", () => {
	const limits = { maxInputChars: 100, maxEditsPerSide: 3 };
	const big = "x\n".repeat(60);
	assert.deepEqual(merge({ base: big, disk: big + "d\n", crdt: "c\n" + big, limits }), { kind: "conflict", text: "c\n" + big, conflictCopy: big + "d\n", reason: "too-large" });
	// One-sided still exact above the limit (no diff runs).
	assert.deepEqual(merge({ base: big, disk: big + "d\n", crdt: big, limits }), { kind: "disk-only", text: big + "d\n" });
	const base = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
	const disk = "1\nA\n3\nB\n5\nC\n7\nD\n9\n";
	const r = merge({ base, disk, crdt: base + "z\n", limits });
	assert.deepEqual(r, { kind: "conflict", text: base + "z\n", conflictCopy: disk, reason: "too-large" });
});

test("mergeValidated: invalid merged text becomes a both-edited conflict keeping crdt", () => {
	const base = "a\nb\nc\n";
	const r = mergeValidated({ base, disk: "A\nb\nc\n", crdt: "a\nb\nC\n", limits: DEFAULT_MERGE_LIMITS }, (t) => !t.includes("A") || !t.includes("C"));
	assert.deepEqual(r, { kind: "conflict", text: "a\nb\nC\n", conflictCopy: "A\nb\nc\n", reason: "both-edited" });
});

// ---------------------------------------------------------------------------
// minimalDiff
// ---------------------------------------------------------------------------

function randomChars(rnd: () => number, n: number): string {
	let s = "";
	for (let i = 0; i < n; i++) {
		const r = rnd();
		if (r < 0.55) s += "abcde \n"[Math.floor(rnd() * 7)];
		else if (r < 0.75) s += String.fromCodePoint(0x1f600 + Math.floor(rnd() * 4));
		else if (r < 0.8) s += String.fromCodePoint(0x1d400 + Math.floor(rnd() * 2)); // shared high surrogate with different lows
		else if (r < 0.9) s += "é中";
		else s += "xy";
	}
	return s;
}

function mutateChars(rnd: () => number, s: string, edits: number): string {
	const cps = Array.from(s);
	for (let e = 0; e < edits; e++) {
		const at = Math.floor(rnd() * (cps.length + 1));
		const r = rnd();
		if (r < 0.4) cps.splice(at, 0, ...Array.from(randomChars(rnd, 1 + Math.floor(rnd() * 4))));
		else if (r < 0.7) cps.splice(at, 1 + Math.floor(rnd() * 3));
		else cps.splice(at, 1, ...Array.from(randomChars(rnd, 1)));
	}
	return cps.join("");
}

function assertCodePointSafe(text: string, offset: number, label: string): void {
	const before = text.charCodeAt(offset - 1);
	const after = text.charCodeAt(offset);
	assert.ok(!(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff), `${label} splits a surrogate pair at ${offset}`);
}

test("minimalDiff property: applies to target, code-point safe, token-aligned, size <= line diff (seeded, 4000 rounds)", () => {
	for (let seed = 1; seed <= 4000; seed++) {
		const rnd = prng(seed * 104729);
		const from = randomChars(rnd, Math.floor(rnd() * 120));
		const to = rnd() < 0.1 ? randomChars(rnd, Math.floor(rnd() * 120)) : mutateChars(rnd, from, Math.floor(rnd() * 8));
		const edits = minimalDiff(from, to);
		assert.equal(applyTextEdits(from, edits), to, `seed ${seed}`);
		assert.ok(editSize(edits) <= lineDiffSize(from, to), `seed ${seed}: ${editSize(edits)} > ${lineDiffSize(from, to)}`);
		let cursor = 0;
		let shift = 0;
		for (const edit of edits) {
			assert.ok(edit.start >= cursor && edit.end >= edit.start && (edit.end > edit.start || edit.text.length > 0), `seed ${seed}: bad edit order`);
			const b0 = edit.start + shift;
			const b1 = b0 + edit.text.length;
			for (const [str, at] of [[from, edit.start], [from, edit.end], [to, b0], [to, b1]] as const) {
				assert.ok(isTokenBoundary(str, at), `seed ${seed}: edit ${JSON.stringify(edit)} ends inside a token at ${at}`);
			}
			shift += edit.text.length - (edit.end - edit.start);
			assertCodePointSafe(from, edit.start, `seed ${seed} start`);
			assertCodePointSafe(from, edit.end, `seed ${seed} end`);
			const first = edit.text.charCodeAt(0);
			const last = edit.text.charCodeAt(edit.text.length - 1);
			assert.ok(!(first >= 0xdc00 && first <= 0xdfff), `seed ${seed}: insert starts with a low surrogate`);
			assert.ok(!(last >= 0xd800 && last <= 0xdbff), `seed ${seed}: insert ends with a high surrogate`);
			cursor = edit.end;
		}
	}
	assert.deepEqual(minimalDiff("same", "same"), []);
	assert.deepEqual(minimalDiff("hello world", "hello brave world"), [{ start: 6, end: 6, text: "brave " }]);
	// Shared high surrogate, different low: the whole pair is replaced (an emoji is a token of its own).
	assert.deepEqual(minimalDiff("a\u{1f600}b", "a\u{1f601}b"), [{ start: 1, end: 3, text: "\u{1f601}" }]);
	// U+1D400 is a letter: "a\u{1d400}b" is one word, replaced whole.
	assert.deepEqual(minimalDiff("a\u{1d400}b", "a\u{1d401}b"), [{ start: 0, end: 4, text: "a\u{1d401}b" }]);
});

test("minimalDiff: edits are whole tokens; punctuation between changed words is not reused; lines stay anchors", () => {
	assert.deepEqual(minimalDiff("the cat sat", "the cart sat"), [{ start: 4, end: 7, text: "cart" }]);
	assert.deepEqual(minimalDiff("x=1;", "x=12;"), [{ start: 2, end: 3, text: "12" }]);
	assert.deepEqual(minimalDiff("caf\u00e9 ok", "cafe\u0301 ok"), [{ start: 0, end: 4, text: "cafe\u0301" }], "combining marks belong to the word");
	assert.deepEqual(minimalDiff("[A.2]\n", "[B.27] \n"), [{ start: 0, end: 5, text: "[B.27] " }], "sim seed 961: the leading [ is not reused (glue)");
	assert.deepEqual(minimalDiff("[A.6] x\n", "[A.53] x\n"), [{ start: 3, end: 4, text: "53" }]);
	assert.deepEqual(minimalDiff("one\ntwo\n", "One\nTwo\n"), [{ start: 0, end: 3, text: "One" }, { start: 4, end: 7, text: "Two" }], "a kept \\n is never absorbed");
	assert.deepEqual(minimalDiff("a.b", "x.y"), [{ start: 0, end: 3, text: "x.y" }]);
	assert.deepEqual(minimalDiff("a, b", "x, y"), [{ start: 0, end: 2, text: "x," }, { start: 3, end: 4, text: "y" }], "glue takes the \",\" of the chunk; the space between edits stays");
	// A delete can slide along a repeated "[B." with equal boundary scores; the bracket tie-break keeps it whole.
	assert.deepEqual(minimalDiff("seed[B.9][B.26]", "seed[B.26]"), [{ start: 4, end: 9, text: "" }], "sim seed 786: not \"9][B.\"");
	assert.deepEqual(minimalDiff("se[A.1][A.17]", "se[A.17]"), [{ start: 2, end: 7, text: "" }], "sim seed 894: not \"1][A.\"");
});

test("minimalDiff + applyEditsTo: concurrent Y.Text edits never split a word, both clientID orders give the same text", () => {
	// Device 1 applies a disk write (minimalDiff + applyEditsTo), device 2 concurrently
	// deletes the old token or inserts next to it. `want` is exact: the remote edit keeps
	// its side whatever the clientIDs.
	const cases: { base: string; disk: string; remote: (t: Y.Text) => void; want: string }[] = [
		{ base: "[A.2]\n", disk: "[B.27] \n", remote: (t) => t.delete(0, 5), want: "[B.27] \n" },
		{ base: "seed 1 [Z.1]\n", disk: "seed 1 [A.15] \n", remote: (t) => t.delete(7, 5), want: "seed 1 [A.15] \n" },
		{ base: "[A.6] \n", disk: "[A.53] \n", remote: (t) => t.insert(6, "[B.23] "), want: "[A.53] [B.23] \n" },
		{ base: "[A.34]\n", disk: "\n[A.55] ", remote: (t) => t.insert(7, "[B.39] "), want: "\n[A.55] [B.39] " },
		{ base: "the cat sat\n", disk: "the cart sat\n", remote: (t) => t.insert(7, "s"), want: "the carts sat\n" },
		{ base: "the cat sat\n", disk: "the cart sat\n", remote: (t) => t.insert(4, "s"), want: "the scart sat\n" },
		{ base: "the cat sat\n", disk: "a dog sat\n", remote: (t) => t.insert(4, "big "), want: "a big dog sat\n" },
		{ base: "the cat sat\n", disk: "a dog sat\n", remote: (t) => t.insert(7, " big"), want: "a dog big sat\n" },
		// A list insert slides to the line start, so deleting the next item keeps the new one whole.
		{ base: "- a\n- b\n", disk: "- a\n- new\n- b\n", remote: (t) => t.delete(4, 4), want: "- a\n- new\n" },
		{ base: "x [A.2]\n", disk: "x [B.1] [A.2]\n", remote: (t) => t.delete(2, 5), want: "x [B.1] \n" },
		{ base: "x[C.2][B.14]\n", disk: "x[B.14]\n", remote: (t) => t.delete(1, 5), want: "x[B.14]\n" },
	];
	for (const c of cases) {
		for (const order of [0, 1]) {
			const d1 = new Y.Doc();
			d1.clientID = order === 0 ? 1 : 2;
			const d2 = new Y.Doc();
			d2.clientID = order === 0 ? 2 : 1;
			d1.getText("t").insert(0, c.base);
			Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
			const t1 = d1.getText("t");
			d1.transact(() => applyEditsTo(t1, c.base, minimalDiff(c.base, c.disk)));
			assert.equal(t1.toString(), c.disk);
			c.remote(d2.getText("t"));
			Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2));
			Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
			const merged = t1.toString();
			assert.equal(merged, d2.getText("t").toString());
			assert.equal(merged, c.want, `${JSON.stringify(c.base)} -> ${JSON.stringify(c.disk)} (order ${order})`);
		}
	}
});

test("minimalDiff: far-apart edits in a long single line stay small", () => {
	const from = "word ".repeat(20_000);
	const to = "WORD " + from.slice(5, 50_000) + "inserted " + from.slice(50_000, -5) + "end. ";
	const edits = minimalDiff(from, to);
	assert.equal(applyTextEdits(from, edits), to);
	assert.ok(editSize(edits) < 40, `size ${editSize(edits)}`);
});

// ---------------------------------------------------------------------------
// Bounded on 2M-char inputs
// ---------------------------------------------------------------------------

function bigDoc(rnd: () => number, chars: number): string {
	const lines: string[] = [];
	let total = 0;
	let n = 0;
	while (total < chars) {
		const line = `line ${n++} ${"lorem ipsum ".repeat(1 + Math.floor(rnd() * 6))}\n`;
		lines.push(line);
		total += line.length;
	}
	return lines.join("").slice(0, chars);
}

function scatter(rnd: () => number, text: string, edits: number, tag: string, lane = -1): string {
	const lines = splitLines(text);
	for (let e = 0; e < edits; e++) {
		let at = Math.floor(rnd() * (lines.length - 1));
		if (lane >= 0) at = at - (at % 4) + lane; // disjoint lanes: never the same or adjacent line
		if (at >= lines.length - 1) continue;
		lines[at] = `${tag} ${e}\n`;
	}
	return lines.join("");
}

function measure<T>(fn: () => T): { value: T; ms: number; heapMb: number } {
	const g = globalThis as { gc?: () => void };
	g.gc?.();
	const heap0 = process.memoryUsage().heapUsed;
	const t0 = performance.now();
	const value = fn();
	const ms = performance.now() - t0;
	const heapMb = (process.memoryUsage().heapUsed - heap0) / 1048576;
	return { value, ms, heapMb };
}

test("merge + minimalDiff are bounded on 2M-char inputs", (t) => {
	const rnd = prng(2024);
	const size = DEFAULT_MERGE_LIMITS.maxInputChars - 1000;
	const base = bigDoc(rnd, size);
	const scenarios: { name: string; disk: string; crdt: string }[] = [
		{ name: "500 disjoint edits per side (clean)", disk: scatter(rnd, base, 500, "DISK", 0), crdt: scatter(rnd, base, 500, "CRDT", 2) },
		{ name: "200 random edits per side", disk: scatter(rnd, base, 200, "DISK"), crdt: scatter(rnd, base, 200, "CRDT") },
		{ name: "3000 random edits per side (anchored fallback)", disk: scatter(rnd, base, 3000, "DISK"), crdt: scatter(rnd, base, 3000, "CRDT") },
		{ name: "both sides rewritten", disk: bigDoc(prng(1), size), crdt: bigDoc(prng(2), size) },
	];
	for (const s of scenarios) {
		const m = measure(() => merge({ base, disk: s.disk, crdt: s.crdt, limits: DEFAULT_MERGE_LIMITS }));
		const result = m.value;
		if (s.name.endsWith("(clean)")) assert.equal(result.kind, "clean");
		const target = result.kind === "identical" ? s.crdt : result.text;
		const d = measure(() => minimalDiff(s.crdt, target));
		assert.equal(applyTextEdits(s.crdt, d.value), target);
		// Worst case for the apply step: crdt -> full disk text.
		const w = measure(() => minimalDiff(s.crdt, s.disk));
		assert.equal(applyTextEdits(s.crdt, w.value), s.disk);
		assert.ok(editSize(w.value) <= lineDiffSize(s.crdt, s.disk));
		t.diagnostic(`${s.name}: merge ${result.kind}${result.kind === "conflict" ? `(${result.reason})` : ""} ${m.ms.toFixed(0)} ms, heap +${m.heapMb.toFixed(0)} MB; minimalDiff(crdt->merged) ${d.value.length} edits ${d.ms.toFixed(0)} ms; minimalDiff(crdt->disk) ${w.value.length} edits ${w.ms.toFixed(0)} ms, heap +${w.heapMb.toFixed(0)} MB`);
		assert.ok(m.ms < 10_000, `merge took ${m.ms} ms`);
		assert.ok(d.ms < 10_000 && w.ms < 10_000, `minimalDiff took ${d.ms}/${w.ms} ms`);
	}
	const over = base + "x".repeat(2000);
	const tooBig = measure(() => merge({ base: over, disk: over + "d\n", crdt: "c\n" + over, limits: DEFAULT_MERGE_LIMITS }));
	assert.equal(tooBig.value.kind, "conflict");
	t.diagnostic(`over limit: ${tooBig.ms.toFixed(1)} ms`);
	assert.ok(tooBig.ms < 50);
});
