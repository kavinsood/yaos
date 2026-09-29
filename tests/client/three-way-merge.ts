import { strict as assert } from "node:assert";
import { mergeThreeWayText, resolveThreeWayText } from "../../src/sync/threeWayMerge";
import { suite } from "../harness.ts";

const s = suite("three-way-merge");

s.test("merges disjoint offline edits", () => {
	const result = mergeThreeWayText(
		"title\nold middle\ntail\n",
		"disk title\nold middle\ntail\n",
		"title\nold middle\nbody tail\n",
	);
	assert.equal(result.kind, "clean");
	if (result.kind === "clean") {
		assert.equal(result.content, "disk title\nold middle\nbody tail\n");
	}
});

s.test("deduplicates the same edit made by both sides", () => {
	const result = mergeThreeWayText("alpha beta", "alpha BETA", "alpha BETA");
	assert.deepEqual(result, { kind: "clean", outcome: "identical", content: "alpha BETA", edits: [] });
});

s.test("the same insertion is taken once even where the diff could place it at another offset", () => {
	// The editor side's diff also moves a prefix, which can shift where it
	// places the shared append by one repeated character.
	const base = "# Note\n\nseed\n";
	const body = `${base}remote edit\n`;
	const editor = `local heading\n${body}`;
	const merged = mergeThreeWayText(base, editor, body);
	assert.equal(merged.kind, "clean");
	assert.equal(merged.kind === "clean" ? merged.content : null, editor);
	const repeated = mergeThreeWayText("a\nb\n", "x\na\nb\nb\n", "a\nb\nb\n");
	assert.equal(repeated.kind === "clean" ? repeated.content : null, "x\na\nb\nb\n");
});

s.test("reports overlapping edits without inventing a winner", () => {
	const result = mergeThreeWayText("alpha beta gamma", "alpha DISK gamma", "alpha BODY gamma");
	assert.equal(result.kind, "conflict");
	if (result.kind === "conflict") {
		assert.equal(result.conflicts.length, 1);
		assert.equal(result.conflicts[0]?.base, "beta");
		assert.equal(result.conflicts[0]?.disk, "DISK");
		assert.equal(result.conflicts[0]?.body, "BODY");
	}
});

s.test("handles independent insertions at different positions", () => {
	const result = mergeThreeWayText("middle", "start middle", "middle end");
	assert.equal(result.kind, "clean");
	if (result.kind === "clean") assert.equal(result.content, "start middle end");
});

s.test("treats concurrent insertions at one position as a conflict", () => {
	const result = mergeThreeWayText("ab", "a disk b", "a body b");
	assert.equal(result.kind, "conflict");
});

s.test("resolves each conflict explicitly while retaining independent edits", () => {
	const result = mergeThreeWayText(
		"head\nshared\ntail\n",
		"disk head\ndisk shared\ntail\n",
		"head\nbody shared\nbody tail\n",
	);
	assert.equal(result.kind, "conflict");
	if (result.kind === "conflict") {
		assert.equal(
			resolveThreeWayText(result, ["body"]),
			"disk head\nbody shared\nbody tail\n",
		);
	}
});

s.test("coalesces transitive overlapping edits into one review region", () => {
	const result = mergeThreeWayText("abcdef", "aXXef", "abYYf");
	assert.equal(result.kind, "conflict");
	if (result.kind === "conflict") assert.equal(result.conflicts.length, 1);
});

s.test("refuses pathological inputs outside declared bounds", () => {
	assert.deepEqual(
		mergeThreeWayText("abc", "adc", "aec", { maxInputCharacters: 2, maxEditsPerSide: 10 }),
		{ kind: "too-large", outcome: "too-large", reason: "input" },
	);
});

s.test("bounds pathological large divergent edits conservatively", () => {
	const base = `head\n${"a".repeat(1_300_000)}\ntail`;
	const startedAt = performance.now();
	const result = mergeThreeWayText(
		base,
		`head\n${"b".repeat(1_300_000)}\ntail`,
		`head\n${"c".repeat(1_300_000)}\ntail`,
	);
	assert.equal(result.kind, "conflict");
	assert.ok(performance.now() - startedAt < 2_000);
});

await s.done();
