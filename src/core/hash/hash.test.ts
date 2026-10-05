import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex } from "./sha256";
import { utf8Decode, utf8Encode, utf8Length } from "./utf8";
import { canonicalizeMarkdown, exactFingerprint, markdownContentHash, markdownTextFromBytes } from "./markdownLf";
import {
	canonicalCanvasBytes, canvasContentHash, canvasFromMergeText, canvasToMergeText, formatCanvasText,
	parseCanvasBytes, parseCanvasText, rankCanvasInFileOrder,
} from "./canvasCanonical";
import { initialCanvasRanks, rankBetween, reconcileCanvasRanks } from "./canvasOrdering";

function prng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test("sha256 matches node:crypto across block boundaries", () => {
	const rnd = prng(1);
	for (const len of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096, 100_003]) {
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) bytes[i] = Math.floor(rnd() * 256);
		assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"), `len ${len}`);
	}
	assert.equal(sha256Hex(utf8Encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("utf8 encode/decode match TextEncoder/TextDecoder", () => {
	const rnd = prng(2);
	const enc = new TextEncoder();
	for (let round = 0; round < 300; round++) {
		let s = "";
		const n = Math.floor(rnd() * 40);
		for (let i = 0; i < n; i++) {
			const r = rnd();
			if (r < 0.4) s += String.fromCharCode(32 + Math.floor(rnd() * 90));
			else if (r < 0.6) s += String.fromCharCode(0x80 + Math.floor(rnd() * 0x780));
			else if (r < 0.8) s += String.fromCharCode(0x800 + Math.floor(rnd() * 0xd000));
			else if (r < 0.95) s += String.fromCodePoint(0x10000 + Math.floor(rnd() * 0xfffff));
			else s += String.fromCharCode(0xd800 + Math.floor(rnd() * 0x800)); // lone surrogate
		}
		const mine = utf8Encode(s);
		assert.deepEqual(mine, enc.encode(s));
		assert.equal(utf8Length(s), mine.length);
		assert.equal(utf8Decode(mine), new TextDecoder().decode(mine));
	}
	for (let round = 0; round < 300; round++) {
		const bytes = new Uint8Array(Math.floor(rnd() * 20));
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rnd() * 256);
		assert.equal(utf8Decode(bytes), new TextDecoder().decode(bytes));
		let fatalRef: string | null;
		try { fatalRef = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fatalRef = null; }
		assert.equal(utf8Decode(bytes, true), fatalRef);
	}
});

test("markdown-lf-v1: one BOM stripped, CRLF/CR -> LF", () => {
	assert.equal(canonicalizeMarkdown("\uFEFF\uFEFFa\r\nb\rc\n"), "\uFEFFa\nb\nc\n");
	assert.equal(markdownContentHash("a\r\nb"), markdownContentHash("a\nb"));
	assert.notEqual(markdownContentHash("a\nb"), markdownContentHash("a\nb\n"));
	const bytes = utf8Encode("\uFEFFx\r\n");
	assert.equal(markdownTextFromBytes(bytes), "x\n");
	assert.equal(exactFingerprint(bytes), createHash("sha256").update(bytes).digest("hex"));
	assert.equal(markdownContentHash("x\n"), createHash("sha256").update("x\n").digest("hex"));
});

const SAMPLE = {
	nodes: [
		{ id: "a", type: "text", text: "hello\nworld", x: 0, y: 0, width: 100, height: 50 },
		{ id: "b", type: "file", file: "x.md", x: -0, y: 10, width: 10, height: 10, color: "1" },
		{ id: "c", type: "custom", foo: { z: 1, a: [1, 2] }, x: 1, y: 1, width: 1, height: 1 },
	],
	edges: [{ id: "e1", fromNode: "a", toNode: "b", fromSide: "left", label: "l" }],
	extra: { k: true },
};

test("canvas parse/canonical/format", () => {
	const parsed = parseCanvasText(JSON.stringify(SAMPLE));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	const canon = new TextDecoder().decode(canonicalCanvasBytes(parsed.data));
	assert.ok(canon.startsWith('{"edges":[{"fromNode":"a"'));
	assert.ok(canon.includes('"x":0,"y":10'));
	const formatted = formatCanvasText(parsed.data);
	assert.ok(formatted.includes('\n\t"nodes": ['));
	// Formatting round-trips to the same logical hash.
	const fmtBytes = utf8Encode(formatted);
	assert.equal(canvasContentHash(fmtBytes), canvasContentHash(utf8Encode(JSON.stringify(SAMPLE))));
	assert.equal(parseCanvasBytes(utf8Encode('{"nodes":[{"id":"a"}]}')).kind, "invalid");
	assert.equal(parseCanvasBytes(utf8Encode('{"nodes":[],"edges":[{"id":"e","fromNode":"x","toNode":"y"}]}')).kind, "invalid");
	assert.equal(parseCanvasBytes(utf8Encode("")).kind, "valid");
	// Invalid canvases still hash stably (raw bytes).
	const bad = utf8Encode("{not json");
	assert.equal(canvasContentHash(bad), sha256Hex(bad));
});

test("canvas merge text round-trips and is one record per line", () => {
	const parsed = parseCanvasText(JSON.stringify(SAMPLE));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	const ranked = rankCanvasInFileOrder(parsed.data);
	const text = canvasToMergeText(ranked);
	assert.equal(text.split("\n").length, 1 + 3 + 1 + 1);
	const back = canvasFromMergeText(text);
	assert.ok(back);
	assert.equal(canvasToMergeText(back!), text);
	assert.deepEqual(canonicalCanvasBytes(back!.data), canonicalCanvasBytes(parsed.data));
	assert.equal(canvasFromMergeText(text.replace('"node"', '"nod"')), null);
	assert.equal(canvasFromMergeText(text + text.split("\n")[1] + "\n"), null, "duplicate node id");
	assert.equal(canvasFromMergeText(text.split("\n").slice(1).join("\n")), null, "doc line missing");
});

test("canvas ranks", () => {
	const ranks = initialCanvasRanks(["a", "b", "c"]);
	assert.equal(ranks.get("a"), "000000GW");
	const between = rankBetween(ranks.get("a")!, ranks.get("b")!);
	assert.ok(between! > ranks.get("a")! && between! < ranks.get("b")!);
	const re = reconcileCanvasRanks(["a", "x", "b", "c"], ranks);
	assert.equal(re.rebalanced, false);
	assert.equal(re.ranks.get("a"), ranks.get("a"));
	assert.ok(re.ranks.get("x")! > ranks.get("a")! && re.ranks.get("x")! < ranks.get("b")!);
});
