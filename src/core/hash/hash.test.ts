import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SYNC_HASH_MAX_BYTES } from "../limits";
import { sha256, sha256Hex } from "./sha256";
import { refHashPort as H } from "./testkit/hashRef";
import { utf8Encode } from "../codec/lib0";
import { canonicalizeMarkdown, exactFingerprint, markdownContentHash } from "./markdownLf";
import {
	CANVAS_LIMITS, canonicalCanvasBytes, canvasContentHash, canvasFromMergeText, canvasJsonValue, canvasLogicalHash, canvasToMergeText, formatCanvasBytes, formatCanvasText,
	parseCanvasBytes, parseCanvasText,
} from "./canvasCanonical";
import { rankCanvasInFileOrder } from "./testkit/canvasRanks";
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
	for (const len of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4095, 4096]) {
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) bytes[i] = Math.floor(rnd() * 256);
		assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"), `len ${len}`);
	}
	assert.equal(sha256Hex(utf8Encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("pure-JS sha256 refuses inputs over SYNC_HASH_MAX_BYTES (fail closed)", () => {
	assert.equal(SYNC_HASH_MAX_BYTES, 4096);
	for (const len of [SYNC_HASH_MAX_BYTES + 1, 64 * 1024, 100_003]) {
		const bytes = new Uint8Array(len);
		assert.throws(() => sha256(bytes), RangeError, `sha256 len ${len}`);
		assert.throws(() => sha256Hex(bytes), RangeError, `sha256Hex len ${len}`);
	}
	// A view over a larger buffer is bounded by its own length.
	const big = new Uint8Array(SYNC_HASH_MAX_BYTES * 2);
	assert.equal(sha256Hex(big.subarray(0, SYNC_HASH_MAX_BYTES)), createHash("sha256").update(big.subarray(0, SYNC_HASH_MAX_BYTES)).digest("hex"));
});

test("markdown-lf-v1: one BOM stripped, CRLF/CR -> LF", async () => {
	assert.equal(canonicalizeMarkdown("\uFEFF\uFEFFa\r\nb\rc\n"), "\uFEFFa\nb\nc\n");
	assert.equal(await markdownContentHash(H, "a\r\nb"), await markdownContentHash(H, "a\nb"));
	assert.notEqual(await markdownContentHash(H, "a\nb"), await markdownContentHash(H, "a\nb\n"));
	const bytes = utf8Encode("\uFEFFx\r\n");
	assert.equal(await exactFingerprint(H, bytes), createHash("sha256").update(bytes).digest("hex"));
	assert.equal(await markdownContentHash(H, "x\n"), createHash("sha256").update("x\n").digest("hex"));
	// Content far over SYNC_HASH_MAX_BYTES hashes through the port.
	const large = "line\r\n".repeat(200_000);
	assert.equal(await markdownContentHash(H, large), createHash("sha256").update("line\n".repeat(200_000)).digest("hex"));
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

test("canvas parse/canonical/format", async () => {
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
	assert.deepEqual(formatCanvasBytes(parsed.data), fmtBytes);
	assert.equal(await canvasContentHash(H, fmtBytes), await canvasContentHash(H, utf8Encode(JSON.stringify(SAMPLE))));
	assert.equal(parseCanvasBytes(utf8Encode('{"nodes":[{"id":"a"}]}')).kind, "invalid");
	assert.equal(parseCanvasBytes(utf8Encode('{"nodes":[],"edges":[{"id":"e","fromNode":"x","toNode":"y"}]}')).kind, "invalid");
	assert.equal(parseCanvasBytes(utf8Encode("")).kind, "valid");
	// Invalid canvases still hash stably (raw bytes).
	const bad = utf8Encode("{not json");
	assert.equal(await canvasContentHash(H, bad), sha256Hex(bad));
});

test("canvas limits: raw bytes, node and edge counts, canonical bytes -> oversized (never parsed into a merge)", () => {
	const node = (i: number) => ({ id: `n${i}`, type: "text", text: "", x: 0, y: 0, width: 1, height: 1 });
	const of = (v: unknown) => parseCanvasBytes(utf8Encode(JSON.stringify(v)));
	const huge = of({ nodes: [{ ...node(0), text: "x".repeat(CANVAS_LIMITS.canonicalBytes * 2) }], edges: [] });
	assert.deepEqual(huge.kind === "oversized" && huge.limit, "canonicalBytes", "raw bytes over twice the canonical limit");
	const many = of({ nodes: Array.from({ length: CANVAS_LIMITS.nodes + 1 }, (_, i) => node(i)), edges: [] });
	assert.deepEqual(many.kind === "oversized" && [many.limit, many.measured], ["nodes", CANVAS_LIMITS.nodes + 1]);
	const edges = Array.from({ length: CANVAS_LIMITS.edges + 1 }, (_, i) => ({ id: `e${i}`, fromNode: "n0", toNode: "n0" }));
	const wired = of({ nodes: [node(0)], edges });
	assert.deepEqual(wired.kind === "oversized" && wired.limit, "edges");
	// Under the raw-byte bound and every per-field limit, over the canonical one (unknown fields of 200 KiB each).
	const fat = (n: number) => of({ nodes: Array.from({ length: n }, (_, i) => ({ ...node(i), z: "x".repeat(200 * 1024) })), edges: [] });
	const big = fat(6);
	assert.deepEqual(big.kind === "oversized" && big.limit, "canonicalBytes", "canonical bytes over the limit");
	assert.equal(fat(4).kind, "valid");
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
	assert.equal(canvasToMergeText(back), text);
	assert.deepEqual(canonicalCanvasBytes(back.data), canonicalCanvasBytes(parsed.data));
	assert.equal(canvasFromMergeText(text.replace('"node"', '"nod"')), null);
	assert.equal(canvasFromMergeText(text + text.split("\n")[1] + "\n"), null, "duplicate node id");
	const lines = text.split("\n");
	assert.ok(lines[lines.length - 2]!.startsWith('{"doc":'), "doc line is last");
	assert.equal(canvasFromMergeText(lines.filter((l) => !l.startsWith('{"doc":')).join("\n")), null, "doc line missing");
	// Order-agnostic: a doc line first parses the same.
	const docFirst = [lines[lines.length - 2], ...lines.slice(0, -2)].join("\n") + "\n";
	assert.equal(canvasToMergeText(canvasFromMergeText(docFirst)!), text);
});

test("canvas logical hash: empty canvas = empty content; formatting and dangling edges ignored", async () => {
	const empty = sha256Hex(new Uint8Array(0));
	assert.equal(await canvasContentHash(H, utf8Encode("")), empty);
	assert.equal(await canvasContentHash(H, utf8Encode('{"nodes":[],"edges":[]}')), empty);
	assert.equal(await canvasContentHash(H, utf8Encode("{\n  \"nodes\": []\n}\n")), empty);
	assert.notEqual(await canvasContentHash(H, utf8Encode('{"x":1}')), empty, "root fields are content");
	const parsed = parseCanvasText(JSON.stringify(SAMPLE));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	assert.equal(await canvasLogicalHash(H, parsed.data), await canvasContentHash(H, utf8Encode(formatCanvasText(parsed.data))));
	const dangling = { ...parsed.data, edges: new Map(parsed.data.edges), edgeOrder: [...parsed.data.edgeOrder, "zz"] };
	dangling.edges.set("zz", { id: "zz", endpoints: { fromNode: "a", toNode: "gone" }, decorations: {}, extensions: {} });
	assert.equal(await canvasLogicalHash(H, dangling), await canvasLogicalHash(H, parsed.data));
	assert.equal(canvasJsonValue({ a: [1, Infinity] }), undefined);
	assert.equal(JSON.stringify(canvasJsonValue({ a: [1, "x"] })), '{"a":[1,"x"]}');
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
	// Repeated "send to back": each new first record halves the gap below the old one until none is left, and the
	// whole order is re-ranked from scratch, in the desired order.
	let order = ["a", "b", "c"];
	let cur: Map<string, string> = ranks;
	let rebalances = 0;
	for (let i = 0; i < 12; i++) {
		order = [`s${i}`, ...order];
		const r = reconcileCanvasRanks(order, cur);
		if (r.rebalanced) {
			rebalances++;
			assert.deepEqual(r.ranks, initialCanvasRanks(order));
		}
		cur = r.ranks;
		assert.deepEqual([...cur.entries()].sort((x, y) => (x[1] < y[1] ? -1 : 1)).map(([id]) => id), order);
	}
	assert.equal(rebalances, 1, "ten halvings of the first gap, then one rebalance");
	assert.equal(rankBetween("0000001!", null), null, "a malformed rank allocates nothing");
	assert.equal(rankBetween(null, "zzzzzzzzzzzz"), null, "a rank past 2^53 allocates nothing");
});
