import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canvasContentHash } from "../../core/hash/canvasCanonical";
import { exactFingerprint, markdownContentHash } from "../../core/hash/markdownLf";
import type { HashWant } from "../../protocol/messages";
import { ProtocolFailure } from "../../protocol/errors";
import { answerHashRequest, fingerprintWrites, hashItems, utf16LengthOfUtf8, withFingerprints, YIELD_EVERY_BYTES } from "./hashService";

const hash = { sha256: async (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest()) };
const noYield = { hash, yieldNow: () => Promise.resolve() };
const enc = (s: string) => new TextEncoder().encode(s);
/** What Obsidian's desktop vault.process hands its callback: UTF-8, BOM kept, WHATWG replacement. */
const keepBom = new TextDecoder("utf-8", { ignoreBOM: true });

async function one(path: string, want: HashWant, bytes: Uint8Array) {
	const [v] = await hashItems([{ path, want, bytes }], noYield);
	return v!;
}

test("contentHash and fingerprint equal core hashing: markdown BOM/CRLF, canvas, broken canvas, blob", async () => {
	const mdText = "\uFEFFone\r\ntwo\rthree\n";
	const md = enc(mdText);
	assert.deepEqual(await one("a.md", "contentHash", md), { hash: markdownContentHash(mdText), textLength: mdText.length });
	assert.deepEqual(await one("a.md", "fingerprint", md), { hash: exactFingerprint(md), textLength: mdText.length });
	// Two BOMs: decoding keeps both, markdown-lf-v1 strips exactly one (the old host Hasher's TextDecoder stripped one too many).
	const twoBoms = "\uFEFF\uFEFFa\r\n";
	assert.deepEqual(await one("A.MD", "contentHash", enc(twoBoms)), { hash: markdownContentHash(twoBoms), textLength: 5 });
	const canvas = enc('{ "nodes": [{"id":"n1","type":"text","text":"hi","x":0,"y":0,"width":10,"height":10}], "edges": [] }');
	assert.equal((await one("b.canvas", "contentHash", canvas)).hash, canvasContentHash(canvas));
	assert.notEqual(canvasContentHash(canvas), exactFingerprint(canvas), "canvas hashes its canonical form, not its bytes");
	assert.equal((await one("b.canvas", "fingerprint", canvas)).hash, exactFingerprint(canvas));
	const broken = enc("{ not json");
	assert.equal((await one("c.Canvas", "contentHash", broken)).hash, canvasContentHash(broken));
	const blob = new Uint8Array([1, 2, 3, 0xff]);
	assert.deepEqual(await one("d.png", "contentHash", blob), { hash: exactFingerprint(blob), textLength: 4 });
	assert.equal((await one("d.png", "fingerprint", blob)).hash, exactFingerprint(blob));
});

test("textLength = UTF-16 length of the bytes decoded with the BOM kept, invalid UTF-8 included", async () => {
	const cases: Uint8Array[] = [
		new Uint8Array([]),
		new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), // BOM + a: 2
		enc("aé€\u{1f600}"), // 1+1+1+2
		new Uint8Array([0xc0, 0x80, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80]), // overlong, surrogate, > U+10FFFF
		new Uint8Array([0xe2, 0x82]), // truncated at end
		new Uint8Array([0xf0, 0x9f, 0x98, 0x41]), // truncated then ASCII
		new Uint8Array([0x80, 0xbf, 0xfe, 0xff, 0xe0, 0x9f, 0x80]),
	];
	for (const b of cases) {
		assert.equal(utf16LengthOfUtf8(b), keepBom.decode(b).length, `bytes ${Array.from(b).join(",")}`);
		assert.equal((await one("x.md", "fingerprint", b)).textLength, keepBom.decode(b).length);
		assert.equal((await one("x.md", "contentHash", b)).textLength, keepBom.decode(b).length);
	}
	// Fuzz: random bytes biased towards multi-byte lead/continuation bytes.
	let seed = 12345;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) & 0xff;
	const pool = [0x00, 0x41, 0x7f, 0x80, 0x9f, 0xa0, 0xbf, 0xc0, 0xc2, 0xdf, 0xe0, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff, 0xbb];
	for (let n = 0; n < 3000; n++) {
		const b = new Uint8Array(rnd() % 24);
		for (let i = 0; i < b.length; i++) b[i] = rnd() & 1 ? pool[rnd() % pool.length]! : rnd();
		assert.equal(utf16LengthOfUtf8(b), keepBom.decode(b).length, `bytes ${Array.from(b).join(",")}`);
	}
});

test("hashItems answers in order and yields between large items", async () => {
	let yields = 0;
	const big = new Uint8Array(YIELD_EVERY_BYTES);
	const items = [{ path: "a.bin", want: "fingerprint" as const, bytes: big }, { path: "b.md", want: "fingerprint" as const, bytes: enc("b") }, { path: "c.bin", want: "fingerprint" as const, bytes: big }];
	const out = await hashItems(items, { hash, yieldNow: async () => { yields++; } });
	assert.deepEqual(out.map((v) => v.hash), [exactFingerprint(big), exactFingerprint(enc("b")), exactFingerprint(big)]);
	assert.equal(yields, 2);
});

test("answerHashRequest: not-ready before init, hashes after", async () => {
	await assert.rejects(answerHashRequest([], null), (e) => e instanceof ProtocolFailure && e.error.code === "not-ready");
	const ports = { hash, clock: { yieldNow: () => Promise.resolve() } } as unknown as Parameters<typeof answerHashRequest>[1];
	assert.deepEqual(await answerHashRequest([{ path: "a.md", want: "fingerprint", bytes: enc("hi") }], ports), { t: "hashes", values: [{ hash: exactFingerprint(enc("hi")), textLength: 2 }] });
});

test("write fingerprints are computed before posting and attached to ok write outcomes only", () => {
	const bytes = enc("payload");
	const ops = [
		{ t: "write", opId: 7, area: "vault", path: "a.md", data: { t: "text", text: "x\uD800" }, precondition: { t: "any" }, docId: null, purpose: "settings" },
		{ t: "write", opId: 8, area: "vault", path: "b.bin", data: { t: "bytes", bytes }, precondition: { t: "any" }, docId: null, purpose: "settings" },
		{ t: "removeEmptyFolder", opId: 9, path: "f" },
	] as unknown as Parameters<typeof fingerprintWrites>[0];
	const fps = fingerprintWrites(ops);
	assert.deepEqual(fps, [exactFingerprint(enc("x\uFFFD")), exactFingerprint(bytes), null]);
	structuredClone(bytes, { transfer: [bytes.buffer] }); // posted: detached, the fingerprint survives
	const stat = { path: "a.md", size: 4, mtimeMs: 1, ctimeMs: 1 };
	const results = [
		{ opId: 7, t: "write", outcome: { ok: true, stat } },
		{ opId: 8, t: "write", outcome: { ok: false, reason: "precondition", current: null, message: "m" } },
		{ opId: 9, t: "removeEmptyFolder", ok: true },
	] as unknown as Parameters<typeof withFingerprints>[2];
	const out = withFingerprints(ops, fps, results);
	assert.deepEqual(out[0], { opId: 7, t: "write", outcome: { ok: true, stat, fingerprint: fps[0] } });
	assert.deepEqual(out.slice(1), results.slice(1));
	assert.throws(() => withFingerprints(ops, fps, results.slice(1)), /2 results for 3 ops/);
	assert.throws(() => withFingerprints(ops, fps, [results[1]!, results[0]!, results[2]!]), /expected 7/);
});
