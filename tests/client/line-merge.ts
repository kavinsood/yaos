import { strict as assert } from "node:assert";
import { lineEditsFromBase, mergeThreeWayLines, splitLines } from "../../src/sync/lineMerge";
import { resolveThreeWayText, type ThreeWayMergeResult } from "../../src/sync/threeWayMerge";
import { suite } from "../harness.ts";

const s = suite("line-merge (diff3)");

function content(result: ThreeWayMergeResult): string {
	assert.equal(result.kind, "clean", `expected a clean merge, got ${JSON.stringify(result)}`);
	return result.kind === "clean" ? result.content : "";
}

function conflictOf(result: ThreeWayMergeResult) {
	assert.equal(result.kind, "conflict", `expected a conflict, got ${JSON.stringify(result)}`);
	if (result.kind !== "conflict") throw new Error("unreachable");
	return result;
}

/** Deterministic PRNG (mulberry32) so property failures are reproducible. */
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ALPHABET = ["a\n", "b\n", "c\n", "\n", "a", "b\r\n", "ü\n", "🙂\n", "a\r\n", "\r\n"];

function randomLines(next: () => number, maxLines: number): string[] {
	const count = Math.floor(next() * (maxLines + 1));
	const lines: string[] = [];
	for (let index = 0; index < count; index++) lines.push(ALPHABET[Math.floor(next() * ALPHABET.length)]!);
	return lines;
}

/** Join lines; a terminator-less line is only legal at the end, so give earlier ones "\n". */
function joinLines(lines: readonly string[]): string {
	return lines.map((line, index) => index < lines.length - 1 && !line.endsWith("\n") ? `${line}\n` : line).join("");
}

function mutate(next: () => number, lines: readonly string[]): string[] {
	const out = lines.slice();
	const operations = Math.floor(next() * 4);
	for (let index = 0; index < operations; index++) {
		const at = Math.floor(next() * (out.length + 1));
		const kind = Math.floor(next() * 3);
		const line = ALPHABET[Math.floor(next() * ALPHABET.length)]!;
		if (kind === 0) out.splice(at, 0, line);
		else if (kind === 1 && out.length > 0) out.splice(Math.min(at, out.length - 1), 1);
		else if (out.length > 0) out[Math.min(at, out.length - 1)] = line;
	}
	return out;
}

function assertWellFormed(result: ThreeWayMergeResult, base: string): void {
	if (result.kind !== "conflict") return;
	const regions = [
		...result.cleanEdits.map((edit) => ({ ...edit, label: `clean:${edit.source}` })),
		...result.conflicts.map((conflict) => ({ start: conflict.baseStart, end: conflict.baseEnd, label: "conflict" })),
	];
	for (const region of regions) {
		assert.ok(region.start >= 0 && region.end <= base.length && region.start <= region.end, "region inside base");
		assert.ok(region.start === 0 || base[region.start - 1] === "\n", "region starts on a line boundary");
		assert.ok(region.end === 0 || region.end === base.length || base[region.end - 1] === "\n", "region ends on a line boundary " + JSON.stringify({ base, region }));
	}
	for (let left = 0; left < regions.length; left++) {
		for (let right = left + 1; right < regions.length; right++) {
			const a = regions[left]!;
			const b = regions[right]!;
			assert.ok(!(a.start < b.end && b.start < a.end), `${a.label} and ${b.label} must not overlap ` + JSON.stringify(result));
		}
	}
	for (const conflict of result.conflicts) {
		assert.notEqual(conflict.disk, conflict.body, "a conflict region must actually differ");
		assert.equal(conflict.base, base.slice(conflict.baseStart, conflict.baseEnd));
	}
}

// ---------------------------------------------------------------- units

s.test("splitLines keeps terminators byte-exact", () => {
	assert.deepEqual(splitLines(""), []);
	assert.deepEqual(splitLines("a"), ["a"]);
	assert.deepEqual(splitLines("a\n"), ["a\n"]);
	assert.deepEqual(splitLines("a\r\nb\nc"), ["a\r\n", "b\n", "c"]);
	assert.deepEqual(splitLines("\n\n"), ["\n", "\n"]);
	assert.deepEqual(splitLines("a\rb\n"), ["a\rb\n"]);
});

s.test("disjoint edits on both sides merge (closed-file both sides, non-overlapping)", () => {
	const base = "# Title\n\nintro\n\nmiddle\n\noutro\n";
	const disk = "# Title (disk)\n\nintro\n\nmiddle\n\noutro\n";
	const body = "# Title\n\nintro\n\nmiddle\n\noutro (server)\n";
	assert.equal(content(mergeThreeWayLines(base, disk, body)), "# Title (disk)\n\nintro\n\nmiddle\n\noutro (server)\n");
});

s.test("edits to adjacent lines merge cleanly", () => {
	const base = "one\ntwo\nthree\nfour\n";
	assert.equal(content(mergeThreeWayLines(base, "one\nTWO\nthree\nfour\n", "one\ntwo\nTHREE\nfour\n")),
		"one\nTWO\nTHREE\nfour\n");
});

s.test("insertion at the edge of the other side's replacement stays next to it", () => {
	const base = "a\nb\nc\n";
	assert.equal(content(mergeThreeWayLines(base, "a\nX\nb\nc\n", "a\nB\nc\n")), "a\nX\nB\nc\n");
	assert.equal(content(mergeThreeWayLines(base, "a\nb\nX\nc\n", "a\nB\nc\n")), "a\nB\nX\nc\n");
});

s.test("same line changed differently on both sides is a conflict (overlapping)", () => {
	const base = "alpha\nbeta\ngamma\n";
	const result = conflictOf(mergeThreeWayLines(base, "alpha\nDISK\ngamma\n", "alpha\nBODY\ngamma\n"));
	assert.equal(result.conflicts.length, 1);
	assert.deepEqual(result.conflicts[0], { baseStart: 6, baseEnd: 11, base: "beta\n", disk: "DISK\n", body: "BODY\n" });
	assert.equal(resolveThreeWayText(result, ["disk"]), "alpha\nDISK\ngamma\n");
	assert.equal(resolveThreeWayText(result, ["body"]), "alpha\nBODY\ngamma\n");
	assert.equal(resolveThreeWayText(result, ["base"]), base);
});

s.test("a line-level conflict is detected even where a char merge would interleave", () => {
	// Char diff3 would merge "Xbc" + "abY" -> "XbY" inside one line. Line diff3 must not.
	const result = mergeThreeWayLines("abc\n", "Xbc\n", "abY\n");
	assert.equal(result.kind, "conflict");
});

s.test("conflict keeps the non-overlapping clean edits from both sides", () => {
	const base = "1\n2\n3\n4\n5\n";
	const result = conflictOf(mergeThreeWayLines(base, "1d\n2\n3D\n4\n5\n", "1\n2\n3B\n4\n5b\n"));
	assert.equal(result.conflicts.length, 1);
	assert.equal(resolveThreeWayText(result, ["disk"]), "1d\n2\n3D\n4\n5b\n");
	assertWellFormed(result, base);
});

s.test("insertions at the same place differ -> conflict; equal -> taken once", () => {
	const base = "a\nb\n";
	conflictOf(mergeThreeWayLines(base, "a\nX\nb\n", "a\nY\nb\n"));
	conflictOf(mergeThreeWayLines("a\n", "a\nX\n", "a\nY\n"));
	assert.equal(content(mergeThreeWayLines(base, "a\nX\nb\nd\n", "a\nX\nb\n")), "a\nX\nb\nd\n");
});

s.test("insertion strictly inside the other side's deleted range conflicts", () => {
	const base = "a\nb\nc\nd\n";
	conflictOf(mergeThreeWayLines(base, "a\nd\n", "a\nb\nX\nc\nd\n"));
});

s.test("the same insertion is not duplicated where repeated lines make its position ambiguous", () => {
	const base = "# Note\n\nseed\n";
	const body = `${base}remote edit\n`;
	const disk = `local heading\n${body}`;
	assert.equal(content(mergeThreeWayLines(base, disk, body)), disk);
	assert.equal(content(mergeThreeWayLines("a\nb\n", "x\na\nb\nb\n", "a\nb\nb\n")), "x\na\nb\nb\n");
	// Both sides delete one of two equal lines (and disk also edits the line before):
	// the diffs may pick different copies, so this must never delete both. It is
	// reported as a conflict (safe) rather than guessed.
	const ambiguous = mergeThreeWayLines("x\nb\nb\ny\n", "X\nb\ny\n", "x\nb\ny\n");
	assert.ok(ambiguous.kind === "conflict" || (ambiguous.kind === "clean" && ambiguous.content === "X\nb\ny\n"), JSON.stringify(ambiguous));
	if (ambiguous.kind === "conflict") {
		assert.equal(resolveThreeWayText(ambiguous, ["disk"]), "X\nb\ny\n");
		assert.equal(resolveThreeWayText(ambiguous, ["body"]), "x\nb\ny\n");
	}
	// Without the neighbouring edit the shared deletion is recognised as one edit.
	assert.equal(content(mergeThreeWayLines("x\nb\nb\ny\n", "x\nb\ny\n", "x\nb\ny\nz\n")), "x\nb\ny\nz\n");
});

s.test("CRLF is preserved and a CRLF<->LF switch is a change to that line", () => {
	const base = "a\r\nb\r\nc\r\n";
	assert.equal(content(mergeThreeWayLines(base, "A\r\nb\r\nc\r\n", "a\r\nb\r\nC\r\n")), "A\r\nb\r\nC\r\n");
	assert.equal(content(mergeThreeWayLines(base, "a\nb\r\nc\r\n", "a\r\nb\r\nC\r\n")), "a\nb\r\nC\r\n");
	conflictOf(mergeThreeWayLines(base, "a\r\nb\nc\r\n", "a\r\nB\r\nc\r\n"));
	assert.equal(content(mergeThreeWayLines(base, "a\nb\nc\n", base)), "a\nb\nc\n");
});

s.test("trailing newline handling", () => {
	// Disk adds the trailing newline, body edits line 1.
	assert.equal(content(mergeThreeWayLines("a\nb", "a\nb\n", "A\nb")), "A\nb\n");
	// Disk removes it, body edits line 1.
	assert.equal(content(mergeThreeWayLines("a\nb\n", "a\nb", "A\nb\n")), "A\nb");
	// Both touch the last line differently.
	conflictOf(mergeThreeWayLines("a\nb", "a\nb\n", "a\nbb"));
	// Both add the same trailing newline.
	assert.equal(content(mergeThreeWayLines("a\nb", "a\nb\n", "a\nb\n")), "a\nb\n");
	// Appending to a file without trailing newline on one side, top edit on the other.
	assert.equal(content(mergeThreeWayLines("a\nb", "a\nb\nc", "Z\na\nb")), "Z\na\nb\nc");
});

s.test("empty files", () => {
	assert.deepEqual(mergeThreeWayLines("", "", ""), { kind: "clean", outcome: "identical", content: "", edits: [] });
	assert.equal(content(mergeThreeWayLines("", "x\n", "")), "x\n");
	assert.equal(content(mergeThreeWayLines("", "", "y\n")), "y\n");
	assert.equal(content(mergeThreeWayLines("", "x\n", "x\n")), "x\n");
	conflictOf(mergeThreeWayLines("", "x\n", "y\n"));
	// Disk emptied the file while the server edited it: conflict, never silent loss.
	conflictOf(mergeThreeWayLines("a\nb\n", "", "a\nB\n"));
	// Disk emptied the file and the server did nothing: the deletion wins.
	assert.equal(content(mergeThreeWayLines("a\nb\n", "", "a\nb\n")), "");
});

s.test("unicode lines (astral, combining, CJK, RTL) merge by line", () => {
	const base = "🙂 smile\ncafé\n日本語\nשלום\n";
	const disk = "🙂🙂 smile\ncafé\n日本語\nשלום\n";
	const body = "🙂 smile\ncafé\n日本語です\nשלום\n";
	assert.equal(content(mergeThreeWayLines(base, disk, body)), "🙂🙂 smile\ncafé\n日本語です\nשלום\n");
	const conflict = conflictOf(mergeThreeWayLines(base, "🙂 smile\ncafé\n日本語\nשלום\n", "🙂 smile\ncafê\n日本語\nשלום\n"));
	assert.equal(conflict.conflicts[0]!.base, "café\n");
});

s.test("lineEditsFromBase produces line-aligned edits that reproduce the target", () => {
	const base = "a\nb\nc\nd\n";
	const target = "a\nB\nc\nd\ne\n";
	const edits = lineEditsFromBase(base, target);
	assert.deepEqual(edits.map(({ start, end, replacement }) => ({ start, end, replacement })), [
		{ start: 2, end: 4, replacement: "B\n" },
		{ start: 8, end: 8, replacement: "e\n" },
	]);
});

s.test("too-large inputs are refused, not merged", () => {
	const big = "x\n".repeat(20);
	assert.deepEqual(mergeThreeWayLines(big, `${big}a\n`, `b\n${big}`, { maxInputCharacters: 10, maxEditsPerSide: 10 }),
		{ kind: "too-large", outcome: "too-large", reason: "input" });
	const lines = Array.from({ length: 30 }, (_, index) => `line ${index}\n`);
	const disk = lines.map((line, index) => index % 2 ? `D${line}` : line).join("");
	const body = lines.map((line, index) => index % 2 ? line : `B${line}`).join("");
	assert.deepEqual(mergeThreeWayLines(lines.join(""), disk, body, { maxInputCharacters: 1e6, maxEditsPerSide: 5 }),
		{ kind: "too-large", outcome: "too-large", reason: "edit-count" });
});

// ---------------------------------------------------------------- properties

s.test("property: merge(b, x, b) = x, merge(b, b, y) = y, merge(b, x, x) = x", () => {
	const next = rng(0xd1ff3);
	for (let trial = 0; trial < 3000; trial++) {
		const baseLines = randomLines(next, 12);
		const base = joinLines(baseLines);
		const x = joinLines(mutate(next, baseLines));
		assert.equal(content(mergeThreeWayLines(base, x, base)), x, `merge(b,x,b) trial ${trial}`);
		assert.equal(content(mergeThreeWayLines(base, base, x)), x, `merge(b,b,y) trial ${trial}`);
		assert.equal(content(mergeThreeWayLines(base, x, x)), x, `merge(b,x,x) trial ${trial}`);
		assert.equal(content(mergeThreeWayLines(base, base, base)), base);
	}
});

s.test("property: line edits always reproduce the target exactly", () => {
	const next = rng(0xe117);
	for (let trial = 0; trial < 3000; trial++) {
		const base = joinLines(randomLines(next, 15));
		const target = joinLines(randomLines(next, 15));
		const edits = lineEditsFromBase(base, target);
		let output = base;
		for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
			output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
		}
		assert.equal(output, target, `trial ${trial}`);
	}
});

s.test("property: random three-way merges are well-formed, symmetric and resolvable", () => {
	const next = rng(0x5eed);
	let clean = 0;
	let conflicts = 0;
	for (let trial = 0; trial < 4000; trial++) {
		const baseLines = randomLines(next, 12);
		const base = joinLines(baseLines);
		const disk = joinLines(mutate(next, baseLines));
		const body = joinLines(mutate(next, baseLines));
		const forward = mergeThreeWayLines(base, disk, body);
		const backward = mergeThreeWayLines(base, body, disk);
		assert.notEqual(forward.kind, "too-large");
		assert.equal(forward.kind, backward.kind, `symmetric kind, trial ${trial}`);
		assertWellFormed(forward, base);
		if (forward.kind === "clean" && backward.kind === "clean") {
			clean++;
			assert.equal(forward.content, backward.content, `symmetric content, trial ${trial}`);
		}
		if (forward.kind === "conflict" && backward.kind === "conflict") {
			conflicts++;
			assert.equal(forward.conflicts.length, backward.conflicts.length);
			// Choosing one side everywhere and the other side's clean edits never throws
			// and always yields a string built only from the three inputs' lines.
			const pool = new Set([...splitLines(base), ...splitLines(disk), ...splitLines(body)]
				.map((line) => line.replace(/\n$/, "")));
			for (const choice of ["disk", "body", "base"] as const) {
				const resolved = resolveThreeWayText(forward, forward.conflicts.map(() => choice));
				for (const line of splitLines(resolved)) assert.ok(pool.has(line.replace(/\n$/, "")), `foreign line ${JSON.stringify(line)}`);
			}
		}
	}
	assert.ok(clean > 200 && conflicts > 200, `exercised both outcomes (clean=${clean}, conflicts=${conflicts})`);
});

s.test("property: edits in disjoint line regions of unique lines always merge to the union", () => {
	const next = rng(0xabc);
	for (let trial = 0; trial < 2000; trial++) {
		const count = 4 + Math.floor(next() * 30);
		const base = Array.from({ length: count }, (_, index) => `line ${index}\n`);
		// Split into alternating regions separated by at least one untouched line.
		const cut = 1 + Math.floor(next() * (count - 3));
		const disk = base.slice();
		const body = base.slice();
		const expected = base.slice();
		const diskAt = Math.floor(next() * cut);
		const bodyAt = cut + 1 + Math.floor(next() * (count - cut - 1));
		const diskKind = Math.floor(next() * 3);
		const bodyKind = Math.floor(next() * 3);
		// Apply right-most first so indices stay valid.
		const applyAt = (lines: string[], at: number, kind: number, tag: string) => {
			if (kind === 0) lines.splice(at, 1, `${tag} ${trial}\n`);
			else if (kind === 1) lines.splice(at, 1);
			else lines.splice(at, 0, `${tag} new ${trial}\n`);
		};
		applyAt(body, bodyAt, bodyKind, "body");
		applyAt(expected, bodyAt, bodyKind, "body");
		applyAt(disk, diskAt, diskKind, "disk");
		applyAt(expected, diskAt, diskKind, "disk");
		assert.equal(content(mergeThreeWayLines(base.join(""), disk.join(""), body.join(""))), expected.join(""), `trial ${trial}`);
	}
});

s.test("property: the same unique line changed differently on both sides always conflicts", () => {
	const next = rng(0xc0ff1c7);
	for (let trial = 0; trial < 1000; trial++) {
		const count = 1 + Math.floor(next() * 20);
		const base = Array.from({ length: count }, (_, index) => `line ${index}\n`);
		const at = Math.floor(next() * count);
		const disk = base.slice();
		const body = base.slice();
		disk[at] = `disk ${trial}\n`;
		body[at] = `body ${trial}\n`;
		const result = conflictOf(mergeThreeWayLines(base.join(""), disk.join(""), body.join("")));
		assert.equal(result.conflicts.length, 1);
		assert.equal(result.conflicts[0]!.disk, `disk ${trial}\n`);
		assert.equal(result.conflicts[0]!.body, `body ${trial}\n`);
	}
});

// ---------------------------------------------------------------- performance

s.test("performance: 100k-line file with scattered edits on both sides merges quickly", () => {
	const lines = Array.from({ length: 100_000 }, (_, index) => `line ${index} ${"x".repeat(index % 13)}\n`);
	const disk = lines.slice();
	const body = lines.slice();
	for (let index = 0; index < 200; index++) {
		disk[index * 400] = `disk ${index}\n`;
		body[index * 400 + 200] = `body ${index}\n`;
	}
	const started = performance.now();
	const result = mergeThreeWayLines(lines.join(""), disk.join(""), body.join(""));
	const elapsed = performance.now() - started;
	assert.equal(result.kind, "clean");
	if (result.kind === "clean") assert.equal(result.edits.length, 400);
	assert.ok(elapsed < 2_000, `merge took ${elapsed.toFixed(0)} ms`);
});

s.test("performance: wholly rewritten 1.3M-char sides are bounded (coarse but exact)", () => {
	const next = rng(42);
	const make = () => Array.from({ length: 80_000 }, () => `${Math.floor(next() * 1e6)} words\n`).join("");
	const base = make();
	const disk = make();
	const body = make();
	assert.ok(base.length > 1_000_000);
	const started = performance.now();
	const result = mergeThreeWayLines(base, disk, body);
	const elapsed = performance.now() - started;
	assert.equal(result.kind, "conflict");
	assert.ok(elapsed < 3_000, `merge took ${elapsed.toFixed(0)} ms`);
	if (result.kind === "conflict") {
		assert.equal(resolveThreeWayText(result, result.conflicts.map(() => "disk")), disk);
		assert.equal(resolveThreeWayText(result, result.conflicts.map(() => "body")), body);
	}
});

await s.done();
