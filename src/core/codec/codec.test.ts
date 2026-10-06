import { test } from "node:test";
import assert from "node:assert/strict";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { deflateSync } from "fflate";
import { CodecError, Reader, Writer, bytesToHex, hexToBytes, hasLoneSurrogate } from "./lib0";
import { base64urlDecode, base64urlEncode, isDocId, newDocId } from "./ids";
import {
	DEFLATE_MIN_BYTES,
	checkpointAad,
	decodeInner,
	decodeOuter,
	encodeInner,
	encodeOuter,
	frameAad,
	identityCrypto,
	inflateBounded,
	openEnvelope,
	sealEnvelope,
} from "./envelope";
import {
	decodeBlobChunk,
	decodeBodyUpdateRef,
	decodeCheckpointContent,
	encodeBlobChunk,
	encodeBodyUpdateRef,
	encodeCheckpointContent,
} from "./contents";
import { decodeNsOps, encodeNsOps } from "./nsOps";
import { decodeCfgOps, encodeCfgOps } from "./cfgOps";
import { CheckpointEncoding, EnvelopeFlag } from "../envelope";
import type { CfgOp, ClientFrameId, ContentHash, DeviceId, DocId, NsOp, StreamName } from "../types";

const H1 = "11".repeat(32) as ContentHash;
const H2 = "ab".repeat(32) as ContentHash;
const D1 = "AAAAAAAAAAAAAAAAAAAAAA" as DocId;
const D2 = "abcdefghijklmnopqrstu_" as DocId;
const F1 = "f1f1f1f1f1f1f1f1f1f1f1" as ClientFrameId;

function lcg(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

test("lib0: varuint matches lib0 encoding and rejects non-minimal / overflow", () => {
	const values = [0, 1, 127, 128, 255, 300, 16383, 16384, 2 ** 31 - 1, 2 ** 31, 2 ** 32, 2 ** 40 + 7, Number.MAX_SAFE_INTEGER];
	for (const v of values) {
		const ours = new Writer(4).varuint(v).finish();
		const e = encoding.createEncoder();
		encoding.writeVarUint(e, v);
		assert.deepEqual(ours, encoding.toUint8Array(e), `varuint ${v}`);
		assert.equal(new Reader(ours).varuint(), v);
		assert.equal(decoding.readVarUint(decoding.createDecoder(ours)), v);
	}
	assert.throws(() => new Reader(new Uint8Array([0x80, 0x00])).varuint(), CodecError, "non-minimal 0");
	assert.throws(() => new Reader(new Uint8Array([0x81, 0x80, 0x00])).varuint(), CodecError, "non-minimal 1");
	assert.throws(() => new Reader(new Uint8Array([0x80])).varuint(), CodecError, "truncated");
	assert.throws(() => new Reader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x10])).varuint(), CodecError, "2^53");
	assert.throws(() => new Reader(new Uint8Array(9).fill(0xff)).varuint(), CodecError, "too long");
	assert.throws(() => new Writer().varuint(-1), CodecError);
	assert.throws(() => new Writer().varuint(2 ** 53), CodecError);
	assert.throws(() => new Writer().varuint(1.5), CodecError);
});

test("lib0: varstring matches lib0, strict UTF-8, BOM kept, lone surrogates refused", () => {
	for (const s of ["", "abc", "Maße/ΟΔΟΣ/İ.md", "\u{1F600}x", "﻿bom"]) {
		const ours = new Writer().varstring(s).finish();
		const e = encoding.createEncoder();
		encoding.writeVarString(e, s);
		assert.deepEqual(ours, encoding.toUint8Array(e), JSON.stringify(s));
		assert.equal(new Reader(ours).varstring(), s);
	}
	assert.throws(() => new Reader(new Uint8Array([2, 0xc3, 0x28])).varstring(), CodecError, "invalid utf-8");
	assert.throws(() => new Reader(new Uint8Array([3, 0xed, 0xa0, 0x80])).varstring(), CodecError, "encoded surrogate");
	assert.throws(() => new Reader(new Uint8Array([5, 0x61])).varstring(), CodecError, "truncated");
	assert.equal(hasLoneSurrogate("a\uD800"), true);
	assert.equal(hasLoneSurrogate("\uDC00a"), true);
	assert.equal(hasLoneSurrogate("\u{1F600}"), false);
	assert.throws(() => new Writer().varstring("a\uD800b"), CodecError);
	const r = new Reader(new Uint8Array([1, 2]));
	r.u8();
	assert.throws(() => r.end(), CodecError, "trailing");
});

test("hex and base64url", () => {
	assert.equal(bytesToHex(new Uint8Array([0, 15, 255])), "000fff");
	assert.deepEqual(hexToBytes("000fff"), new Uint8Array([0, 15, 255]));
	assert.throws(() => hexToBytes("0F"), CodecError);
	assert.throws(() => hexToBytes("abc"), CodecError);
	const rnd = lcg(7);
	for (let n = 0; n < 40; n++) {
		const b = new Uint8Array(n).map(() => Math.floor(rnd() * 256));
		const s = base64urlEncode(b);
		assert.equal(s, Buffer.from(b).toString("base64url"));
		assert.deepEqual(base64urlDecode(s), b);
	}
	const id = newDocId({ bytes: (n) => new Uint8Array(n).fill(7), float: () => 0 });
	assert.equal(id.length, 22);
	assert.ok(isDocId(id));
	assert.ok(!isDocId("short"));
	assert.ok(!isDocId("AAAAAAAAAAAAAAAAAAAAA="));
});

test("envelope outer: round trip, version/suite/keyEpoch handling", () => {
	const sealed = new Uint8Array([9, 8, 7]);
	const bytes = encodeOuter({ formatVersion: 1, suite: 0, keyEpoch: 0 }, sealed);
	assert.deepEqual(bytes, new Uint8Array([1, 0, 0, 9, 8, 7]));
	const d = decodeOuter(bytes);
	assert.ok(d.ok);
	if (d.ok) assert.deepEqual(d.sealed, sealed);
	assert.deepEqual(decodeOuter(new Uint8Array([2, 0, 0])), { ok: false, reason: "unsupported-version" });
	assert.deepEqual(decodeOuter(new Uint8Array([1, 7, 0])), { ok: false, reason: "unsupported-suite" });
	assert.deepEqual(decodeOuter(new Uint8Array([1, 0, 1])), { ok: false, reason: "malformed" }, "suite 0 keyEpoch 1");
	assert.deepEqual(decodeOuter(new Uint8Array([1, 1, 0x80, 0x00])), { ok: false, reason: "malformed" }, "non-minimal keyEpoch");
	assert.deepEqual(decodeOuter(new Uint8Array([])), { ok: false, reason: "malformed" });
	const s1 = decodeOuter(new Uint8Array([1, 1, 5, 1]));
	assert.ok(s1.ok && s1.header.keyEpoch === 5);
});

test("envelope inner: deflate rule, bounded inflate, malformed cases", () => {
	const small = new Uint8Array(DEFLATE_MIN_BYTES - 1).fill(65);
	const e1 = encodeInner({ kind: "bodyUpdate", authorNsSeq: 3, flags: EnvelopeFlag.deflate, frameNo: 0, content: small });
	const d1 = decodeInner(e1);
	assert.ok(d1.ok);
	if (d1.ok) {
		assert.equal(d1.inner.flags & EnvelopeFlag.deflate, 0, "below threshold: not deflated, flag cleared");
		assert.deepEqual(d1.inner.content, small);
	}
	const big = new Uint8Array(DEFLATE_MIN_BYTES).fill(65);
	const e2 = encodeInner({ kind: "nsOps", authorNsSeq: 300, flags: EnvelopeFlag.initial, frameNo: 7, content: big });
	assert.ok(e2.length < 200);
	const d2 = decodeInner(e2);
	assert.ok(d2.ok);
	if (d2.ok) {
		assert.equal(d2.inner.kind, "nsOps");
		assert.equal(d2.inner.authorNsSeq, 300);
		assert.equal(d2.inner.flags, EnvelopeFlag.initial | EnvelopeFlag.deflate);
		assert.equal(d2.inner.frameNo, 7);
		assert.deepEqual(d2.inner.content, big);
	}
	// Incompressible content >= 4096 stays raw.
	const rnd = lcg(1);
	const noise = new Uint8Array(8192).map(() => Math.floor(rnd() * 256));
	const d3 = decodeInner(encodeInner({ kind: "bodyUpdate", authorNsSeq: 0, flags: 0, frameNo: 0, content: noise }));
	assert.ok(d3.ok && d3.inner.flags === 0 && d3.inner.content.length === 8192);
	// never
	const d4 = decodeInner(encodeInner({ kind: "bodyUpdate", authorNsSeq: 0, flags: 0, frameNo: 0, content: big }, { deflate: "never" }));
	assert.ok(d4.ok && d4.inner.flags === 0);

	assert.deepEqual(decodeInner(new Uint8Array([99, 0, 0, 0])), { ok: false, reason: "malformed" }, "unknown kind");
	assert.deepEqual(decodeInner(new Uint8Array([0, 0, 0, 0])), { ok: false, reason: "malformed" }, "kind 0");
	assert.deepEqual(decodeInner(new Uint8Array([2, 0x80, 0, 0, 0])), { ok: false, reason: "malformed" }, "non-minimal authorNsSeq");
	assert.deepEqual(decodeInner(new Uint8Array([2, 0])), { ok: false, reason: "malformed" }, "truncated flags");
	assert.deepEqual(decodeInner(new Uint8Array([2, 0, 0])), { ok: false, reason: "malformed" }, "truncated frameNo");
	assert.deepEqual(decodeInner(new Uint8Array([2, 0, 4, 0])), { ok: false, reason: "malformed" }, "empty deflate");
	assert.deepEqual(decodeInner(new Uint8Array([2, 0, 4, 0, 0xff, 0xff])), { ok: false, reason: "malformed" }, "bad deflate");
	const z = deflateSync(new Uint8Array(1_000_000));
	assert.deepEqual(decodeInner(new Uint8Array([2, 0, 4, 0, ...z]), 100_000), { ok: false, reason: "malformed" }, "bomb bounded");
	assert.equal(inflateBounded(z, 1_000_000).length, 1_000_000);
	assert.throws(() => inflateBounded(z.subarray(0, z.length - 3), 2_000_000), CodecError, "truncated deflate");
	// Unknown flag bits are ignored.
	const d5 = decodeInner(new Uint8Array([2, 0, 0x80, 0x01, 0, 1, 2]));
	assert.ok(d5.ok && d5.inner.flags === 128 && d5.inner.content.length === 2);
});

test("envelope inner: frameNo is >= 1 for nsOps/cfgOps and 0 for every other kind (e2ee-design §8.1)", () => {
	const ok = (b: number[]) => { const d = decodeInner(new Uint8Array(b)); return d.ok ? d.inner.frameNo : d.reason; };
	assert.equal(ok([1, 0, 0, 1]), 1, "nsOps frameNo 1");
	assert.equal(ok([4, 0, 0, 0xac, 0x02]), 300, "cfgOps frameNo 300");
	assert.equal(ok([1, 0, 0, 0]), "malformed", "nsOps frameNo 0");
	assert.equal(ok([4, 0, 0, 0]), "malformed", "cfgOps frameNo 0");
	assert.equal(ok([1, 0, 0, 0x81, 0x00]), "malformed", "non-minimal frameNo");
	for (const code of [2, 3, 5, 6, 7]) {
		assert.equal(ok([code, 0, 0, 0]), 0, `kind ${code} frameNo 0`);
		assert.equal(ok([code, 0, 0, 1]), "malformed", `kind ${code} frameNo 1`);
	}
	const content = new Uint8Array([1]);
	assert.throws(() => encodeInner({ kind: "nsOps", authorNsSeq: 0, flags: 0, frameNo: 0, content }), CodecError);
	assert.throws(() => encodeInner({ kind: "cfgOps", authorNsSeq: 0, flags: 0, frameNo: 1.5, content }), CodecError);
	assert.throws(() => encodeInner({ kind: "bodyUpdate", authorNsSeq: 0, flags: 0, frameNo: 2, content }), CodecError);
});

test("AAD layout v2", () => {
	const enc = (s: string) => [...new TextEncoder().encode(s)];
	const s0 = { formatVersion: 1, suite: 0, keyEpoch: 0 } as const;
	const s1 = { formatVersion: 1, suite: 1, keyEpoch: 300 } as const;
	assert.deepEqual(frameAad(s0, "v", "ns", "d", "x"), new Uint8Array([...enc("yaos/f2"), 1, 0, 0, 1, 0x76, 2, 0x6e, 0x73, 1, 0x64, 1, 0x78]));
	assert.deepEqual(frameAad(s1, "v", "ns", "d", "x"), new Uint8Array([...enc("yaos/f2"), 1, 1, 0xac, 0x02, 1, 0x76, 2, 0x6e, 0x73, 1, 0x64, 1, 0x78]));
	assert.deepEqual(checkpointAad(s0, "v", "ns", 300), new Uint8Array([...enc("yaos/c2"), 1, 0, 0, 1, 0x76, 2, 0x6e, 0x73, 0xac, 0x02]));
	// Length-prefixed fields: moving a byte between deviceId and clientFrameId changes the AAD.
	assert.notDeepEqual(frameAad(s0, "v", "ns", "dx", ""), frameAad(s0, "v", "ns", "d", "x"));
});

test("seal/open with the identity suite: binding checks", async () => {
	const crypto = identityCrypto();
	const ns = "ns" as StreamName;
	const dev = "devA" as DeviceId;
	const fb = (stream: StreamName) => ({ t: "frame" as const, stream, deviceId: dev, clientFrameId: F1 });
	const content = encodeNsOps([{ t: "upgradeRules", version: 1 }]);
	const { sealed: bytes, flags } = await sealEnvelope(crypto, { vaultId: "v1", binding: fb(ns), inner: { kind: "nsOps", authorNsSeq: 4, flags: 0, frameNo: 9, content } });
	assert.equal(flags, 0);
	assert.deepEqual([...bytes.subarray(0, 7)], [1, 0, 0, 1, 4, 0, 9], "suite 0: header then the plain inner envelope, no padding");
	const ok = await openEnvelope(crypto, { vaultId: "v1", binding: fb(ns), bytes });
	assert.ok(ok.ok);
	if (ok.ok) assert.deepEqual([ok.inner.content, ok.inner.frameNo], [content, 9]);
	assert.deepEqual(await openEnvelope(crypto, { vaultId: "v1", binding: fb(`b:${D1}` as StreamName), bytes }), { ok: false, reason: "kind-stream-mismatch", header: { formatVersion: 1, suite: 0, keyEpoch: 0 } });
	assert.equal((await openEnvelope(crypto, { vaultId: "v1", binding: fb("zz" as StreamName), bytes }) as { reason: string }).reason, "kind-stream-mismatch");
	assert.equal((await openEnvelope(crypto, { vaultId: "v1", binding: fb("k" as StreamName), bytes }) as { reason: string }).reason, "kind-stream-mismatch", "keyring stream carries no envelopes");
	await assert.rejects(sealEnvelope(crypto, { vaultId: "v1", binding: fb(ns), inner: { kind: "nsOps", authorNsSeq: 4, flags: 0, frameNo: 0, content } }), CodecError);

	const ckContent = encodeCheckpointContent({ encoding: CheckpointEncoding.nsFoldV1, coversSeq: 77, foldRulesVersion: 1, state: new Uint8Array([1]) });
	const { sealed: ck } = await sealEnvelope(crypto, {
		vaultId: "v1", binding: { t: "checkpoint", stream: ns, coversSeq: 77 },
		inner: { kind: "checkpoint", authorNsSeq: 77, flags: 0, frameNo: 0, content: ckContent },
	});
	assert.ok((await openEnvelope(crypto, { vaultId: "v1", binding: { t: "checkpoint", stream: ns, coversSeq: 77 }, bytes: ck })).ok);
	assert.equal((await openEnvelope(crypto, { vaultId: "v1", binding: fb(ns), bytes: ck }) as { reason: string }).reason, "kind-stream-mismatch", "checkpoint kind on a frame row");
	assert.deepEqual(await openEnvelope(crypto, { vaultId: "v1", binding: fb(ns), bytes: new Uint8Array([1, 1, 1]) }), { ok: false, reason: "unsupported-suite", header: { formatVersion: 1, suite: 1, keyEpoch: 1 } },
		"a suite-0 reader cannot open suite 1");
});

test("contents: checkpoint / blobChunk / bodyUpdateRef round trip and malformed", () => {
	const ck = { encoding: CheckpointEncoding.yjsStateV1, coversSeq: 1234, foldRulesVersion: 1, state: new Uint8Array([5, 6]) };
	assert.deepEqual(decodeCheckpointContent(encodeCheckpointContent(ck)), ck);
	assert.equal(decodeCheckpointContent(new Uint8Array([9, 0, 0])), null, "unknown encoding");
	assert.equal(decodeCheckpointContent(new Uint8Array([1, 0x80, 0x00, 0])), null, "non-minimal");
	const bc = { hash: H1, index: 1, total: 3, totalSize: 99, chunk: new Uint8Array([1, 2, 3]) };
	assert.deepEqual(decodeBlobChunk(encodeBlobChunk(bc)), bc);
	assert.equal(decodeBlobChunk(new Uint8Array(31)), null);
	assert.equal(decodeBlobChunk(new Uint8Array([...new Uint8Array(32), 3, 3, 0])), null, "index >= total");
	const br = { hash: H2, size: 5_000_000 };
	assert.deepEqual(decodeBodyUpdateRef(encodeBodyUpdateRef(br)), br);
	assert.equal(decodeBodyUpdateRef(new Uint8Array([...encodeBodyUpdateRef(br), 0])), null, "trailing");
});

const ALL_NS_OPS: NsOp[] = [
	{ t: "create", docId: D1, kind: "markdown", path: "Notes/a.md", contentHash: H1, size: 12 },
	{ t: "create", docId: D2, kind: "blob", path: "img.png", contentHash: H2, size: 2 ** 40 },
	{ t: "rename", docId: D1, path: "Maße/ΟΔΟΣ.md" },
	{ t: "delete", docId: D2, baseBodySeq: 300 },
	{ t: "restore", docId: D2, path: "img.png", againstDeleteSeq: 301 },
	{ t: "setBlob", docId: D2, hash: H1, size: 7, baseRev: 9 },
	{ t: "upgradeRules", version: 2 },
	{ t: "create", docId: D2, kind: "canvas", path: "invalid?path.canvas", contentHash: H1, size: 0 },
];

test("nsOps: round trip, forward-compatible body tails, malformed frames", () => {
	const bytes = encodeNsOps(ALL_NS_OPS);
	assert.deepEqual(decodeNsOps(bytes), ALL_NS_OPS);
	// Body tail bytes are ignored.
	const w = new Writer();
	w.varuint(1).u8(2).varbytes(new Writer().varstring(D1).varstring("x.md").u8(1).u8(2).finish());
	assert.deepEqual(decodeNsOps(w.finish()), [{ t: "rename", docId: D1, path: "x.md" }]);

	const ops1 = encodeNsOps([{ t: "rename", docId: D1, path: "x.md" }]);
	const bad: Array<[string, Uint8Array]> = [
		["empty", new Uint8Array([])],
		["opCount 0", new Uint8Array([0])],
		["opCount 513", new Writer().varuint(513).finish()],
		["trailing after last op", new Uint8Array([...ops1, 0])],
		["truncated", ops1.subarray(0, ops1.length - 1)],
		["unknown tag", new Uint8Array([1, 9, 0])],
		["tag 0", new Uint8Array([1, 0, 0])],
		["non-minimal opCount", new Uint8Array([0x81, 0x00, ...ops1.subarray(1)])],
		["bad docId", new Writer().varuint(1).u8(2).varbytes(new Writer().varstring("short").varstring("x.md").finish()).finish()],
		["unknown kindCode", new Writer().varuint(1).u8(1).varbytes(new Writer().varstring(D1).u8(4).varstring("a.md").raw(new Uint8Array(32)).varuint(1).finish()).finish()],
		["body too short", new Writer().varuint(1).u8(3).varbytes(new Writer().varstring(D1).finish()).finish()],
		["invalid utf-8 path", new Writer().varuint(1).u8(2).varbytes(new Writer().varstring(D1).varbytes(new Uint8Array([0xff])).finish()).finish()],
		["varuint > 2^53", new Writer().varuint(1).u8(6).varbytes(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])).finish()],
	];
	for (const [name, b] of bad) assert.equal(decodeNsOps(b), null, name);
	assert.throws(() => encodeNsOps([]), CodecError);
	assert.throws(() => encodeNsOps([{ t: "rename", docId: "bad" as DocId, path: "x" }]), CodecError);
	assert.throws(() => encodeNsOps(new Array(513).fill({ t: "upgradeRules", version: 1 })), CodecError);
	assert.equal(decodeNsOps(encodeNsOps(new Array(512).fill({ t: "upgradeRules", version: 1 })))?.length, 512);
});

test("cfgOps: round trip and malformed frames", () => {
	const ops: CfgOp[] = [
		{ t: "jsonSet", file: "app.json", key: "vimMode", valueJson: "true" },
		{ t: "jsonDel", file: "app.json", key: "x" },
		{ t: "filePut", file: "plugins/a/data.json", content: { t: "inline", bytes: new Uint8Array([1, 2]) }, pluginVersion: "1.2.3" },
		{ t: "filePut", file: "snippets/a.css", content: { t: "blob", hash: H1, size: 70000 }, pluginVersion: null },
		{ t: "fileDel", file: "snippets/b.css" },
		{ t: "pluginSet", pluginId: "dataview", enabled: true },
		{ t: "pluginSet", pluginId: "calendar", enabled: false },
		{ t: "pluginDel", pluginId: "old" },
	];
	assert.deepEqual(decodeCfgOps(encodeCfgOps(ops)), ops);
	const one = (tag: number, body: Uint8Array) => new Writer().varuint(1).u8(tag).varbytes(body).finish();
	assert.equal(decodeCfgOps(one(5, new Writer().varstring("p").u8(2).finish())), null, "enabled 2");
	assert.equal(decodeCfgOps(one(3, new Writer().varstring("f").u8(3).finish())), null, "content tag 3");
	assert.equal(decodeCfgOps(one(7, new Uint8Array([]))), null, "unknown tag");
	assert.equal(decodeCfgOps(new Uint8Array([0])), null, "opCount 0");
	assert.deepEqual(decodeCfgOps(one(6, new Writer().varstring("p").u8(1).finish())), [{ t: "pluginDel", pluginId: "p" }], "body tail ignored");
});
