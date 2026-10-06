import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { CheckpointEncoding } from "../../core/envelope";
import { FOLD_RULES_VERSION, MAX_FRAME_CONTENT_BYTES } from "../../core/limits";
import { NS_STREAM, SNAP_STREAM, type ClientFrameId, type ContentHash, type DeviceId, type StreamName, type VaultId } from "../../core/types";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { ScriptedRandom } from "../adapters/testkit/scriptedRandom";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { createWebHash } from "../adapters/webHash";
import { faultyCrypto } from "../runtime/testHarness";
import { encodeBodyUpdateRef as encodeBodyRef, encodeCheckpointContent } from "../../core/codec/contents";
import { encodeOuter, frameAad } from "../../core/codec/envelope";
import { sealCheckpoint, sealFrame } from "./envelope";
import { gate, type GateCtx, type GateResult } from "./gate";
import { checkYjsUpdate } from "./yjsCheck";
import { encodeSnapFoldV1 } from "../../core/codec/snapFoldV1";
import { SNAP_FOLD_RULES_VERSION, foldSnapFrame, newSnapFold } from "../../core/snap/fold";
import { encodeSnapOps, snapshotId } from "../../core/snap/record";

const crypto = createNoopCrypto(createWebHash());
const ctx: GateCtx = { crypto, vaultId: "v1" as VaultId, maxCheckpointStateBytes: 1 << 20 };
const BODY = "b:doc1" as StreamName;
const CANVAS = "c:doc2" as StreamName;
const CF = "cf-1" as ClientFrameId;
const DEV = "dev-x" as DeviceId;

async function row(stream: StreamName, content: Uint8Array, kind: "bodyUpdate" | "canvasUpdate" | "bodyUpdateRef" | "nsOps" = stream.startsWith("c:") ? "canvasUpdate" : "bodyUpdate", cf = CF, c: GateCtx = ctx): Promise<GateResult> {
	const s = await sealFrame(crypto, ctx.vaultId, { stream, deviceId: DEV, clientFrameId: CF, kind, authorNsSeq: 0, flags: 0, frameNo: kind === "nsOps" ? 1 : 0, content });
	return gate(c, { t: "row", stream, seq: 1, deviceId: DEV, clientFrameId: cf, payload: s.sealed });
}
function upd(fn: (d: Y.Doc) => void): Uint8Array {
	const d = new Y.Doc();
	fn(d);
	return Y.encodeStateAsUpdate(d);
}
function failReason(r: GateResult): string {
	assert.equal(r.ok, false, "expected a gate failure");
	return (r as { reason: string }).reason;
}

test("gate: valid markdown update passes with inserted char count", async () => {
	const r = await row(BODY, upd((d) => d.getText("text").insert(0, "hello")));
	assert.ok(r.ok && r.t === "body");
	assert.equal(r.insertedChars, 5);
});

test("gate: malformed envelope / kind-stream binding / garbage Yjs", async () => {
	const junk = await gate(ctx, { t: "row", stream: BODY, seq: 1, deviceId: DEV, clientFrameId: CF, payload: new Uint8Array([1, 0]) });
	assert.equal(failReason(junk), "envelope-malformed");
	const empty = await gate(ctx, { t: "row", stream: BODY, seq: 1, deviceId: DEV, clientFrameId: CF, payload: new Uint8Array(0) });
	assert.equal(failReason(empty), "envelope-malformed");
	// Suite 0 leaves the AAD unused (DESIGN §b.1); the kind binding still applies.
	assert.equal(failReason(await row(BODY, new Uint8Array([1]), "nsOps")), "kind-not-allowed");
	assert.equal(failReason(await row(NS_STREAM, upd((d) => d.getText("text").insert(0, "x")), "bodyUpdate")), "kind-not-allowed");
	assert.equal(failReason(await row(BODY, new Uint8Array([0xff, 0xff, 0xff, 0x01, 0x07]))), "decode-failed");
});

test("gate: disallowed Yjs types on markdown docs", async () => {
	const cases: [string, Uint8Array][] = [
		["map root", upd((d) => d.getMap("meta").set("k", "v"))],
		["array root", upd((d) => d.getArray("text2").insert(0, [1]))],
		["xml fragment", upd((d) => d.getXmlFragment("text").insert(0, [new Y.XmlText("x")]))],
		["formatted text", upd((d) => d.getText("text").insert(0, "bold", { bold: true }))],
		["embed", upd((d) => d.getText("text").insertEmbed(0, { image: "x.png" }))],
		["subdoc", upd((d) => d.getMap("text").set("sub", new Y.Doc()))],
	];
	for (const [name, u] of cases) {
		const reason = failReason(await row(BODY, u));
		assert.ok(reason === "disallowed-type" || reason === "yjs-structure", `${name}: ${reason}`);
	}
});

test("gate: canvas allows map roots with Any/Map/Text, rejects arrays and sequence roots", async () => {
	const ok = await row(CANVAS, upd((d) => {
		d.getMap("nodes").set("n1", { x: 1, label: "hi" });
		d.getMap("doc").set("t", new Y.Text("t"));
	}));
	assert.ok(ok.ok && ok.t === "body");
	assert.equal(failReason(await row(CANVAS, upd((d) => d.getMap("nodes").set("a", new Y.Array())))), "disallowed-type");
	assert.equal(failReason(await row(CANVAS, upd((d) => d.getMap("other").set("a", 1)))), "disallowed-type");
	assert.equal(failReason(await row(CANVAS, upd((d) => d.getText("text").insert(0, "x")))), "disallowed-type");
});

test("gate: oversize content and char caps", async () => {
	const big = new Uint8Array(MAX_FRAME_CONTENT_BYTES + 1);
	assert.equal(failReason(await row(BODY, big)), "oversize");
	const u = upd((d) => d.getText("text").insert(0, "x".repeat(100)));
	const r = checkYjsUpdate(u, "body", { maxBytes: 1 << 20, maxChars: 50 });
	assert.ok(!r.ok && r.reason === "oversize");
	const r2 = checkYjsUpdate(u, "body", { maxBytes: 10, maxChars: 1e9 });
	assert.ok(!r2.ok && r2.reason === "oversize");
});

test("gate: unknown key is reader-dependent; ns malformation is deterministic (folds empty)", async () => {
	const fc = faultyCrypto();
	fc.failOpen = true;
	const r = await row(BODY, upd((d) => d.getText("text").insert(0, "x")), "bodyUpdate", CF, { ...ctx, crypto: fc });
	assert.ok(!r.ok && r.reason === "crypto-unknown-key" && r.readerDependent);
	const ns = await row(NS_STREAM, new Uint8Array([9, 9, 9]), "nsOps");
	assert.ok(ns.ok && ns.t === "ns" && ns.ops === null && ns.detail !== null);
});

test("gate: bodyUpdateRef decodes; bad ref content fails decode", async () => {
	const ok = await row(BODY, encodeBodyRef({ hash: "ab".repeat(32) as never, size: 2_000_000 }), "bodyUpdateRef");
	assert.ok(ok.ok && ok.t === "bodyRef" && ok.ref.size === 2_000_000);
	assert.equal(failReason(await row(BODY, new Uint8Array([1]), "bodyUpdateRef")), "decode-failed");
});

test("gate: checkpoints (binding, encoding, size, structure)", async () => {
	const state = upd((d) => d.getText("text").insert(0, "state"));
	const ck = (coversSeq: number, encoding: number, st: Uint8Array, bound = coversSeq) =>
		sealCheckpoint(crypto, ctx.vaultId, BODY, bound, encodeCheckpointContent({ encoding: encoding as never, coversSeq, foldRulesVersion: FOLD_RULES_VERSION, state: st }), 0);
	const ok = await gate(ctx, { t: "checkpoint", stream: BODY, coversSeq: 7, payload: await ck(7, CheckpointEncoding.yjsStateV1, state) });
	assert.ok(ok.ok && ok.t === "checkpoint");
	assert.equal(failReason(await gate(ctx, { t: "checkpoint", stream: BODY, coversSeq: 8, payload: await ck(7, CheckpointEncoding.yjsStateV1, state, 8) })), "checkpoint-mismatch");
	assert.equal(failReason(await gate(ctx, { t: "checkpoint", stream: BODY, coversSeq: 8, payload: await ck(7, CheckpointEncoding.yjsStateV1, state) })), "checkpoint-mismatch");
	const asRow = await sealFrame(crypto, ctx.vaultId, { stream: BODY, deviceId: DEV, clientFrameId: CF, kind: "bodyUpdate", authorNsSeq: 0, flags: 0, frameNo: 0, content: state });
	assert.equal(failReason(await gate(ctx, { t: "checkpoint", stream: BODY, coversSeq: 7, payload: asRow.sealed })), "kind-not-allowed", "a frame is not a checkpoint");
	assert.equal(failReason(await gate(ctx, { t: "checkpoint", stream: BODY, coversSeq: 7, payload: await ck(7, CheckpointEncoding.nsFoldV1, state) })), "kind-not-allowed");
	const small = { ...ctx, maxCheckpointStateBytes: 4 };
	assert.equal(failReason(await gate(small, { t: "checkpoint", stream: BODY, coversSeq: 7, payload: await ck(7, CheckpointEncoding.yjsStateV1, state) })), "oversize");
	const bad = upd((d) => d.getMap("evil").set("k", 1));
	assert.equal(failReason(await gate(ctx, { t: "checkpoint", stream: BODY, coversSeq: 7, payload: await ck(7, CheckpointEncoding.yjsStateV1, bad) })), "disallowed-type");
});

test("gate: suite-1 failures map to quarantine reasons; only key-dependent ones are reader-dependent (e2ee-design §9.2)", async () => {
	const vaultId = "AAAAAAAAAAAAAAAAAAAAAA" as VaultId;
	const random = new ScriptedRandom();
	const s1 = await createWebCryptoSuite1({ vaultId, random, keys: [{ e: 1, k: new Uint8Array(32).fill(1) }, { e: 2, k: new Uint8Array(32).fill(2) }] });
	s1.markVerified(1);
	s1.setSealEpoch(1);
	const c1: GateCtx = { ...ctx, crypto: s1, vaultId };
	const content = upd((d) => d.getText("text").insert(0, "x"));
	random.push(new Uint8Array(12).fill(7), new Uint8Array(12).fill(8));
	const s = await sealFrame(s1, vaultId, { stream: BODY, deviceId: DEV, clientFrameId: CF, kind: "bodyUpdate", authorNsSeq: 0, flags: 0, frameNo: 0, content });
	const at = (payload: Uint8Array, c = c1) => gate(c, { t: "row", stream: BODY, seq: 1, deviceId: DEV, clientFrameId: CF, payload });
	const verdict = (r: GateResult) => (r.ok ? "ok" : `${r.reason}/${r.readerDependent}`);
	const with_ = (i: number, v: number) => { const o = s.sealed.slice(); o[i] = v; return o; };
	assert.equal(verdict(await at(s.sealed)), "ok");
	const flipped = s.sealed.slice();
	flipped[40]! ^= 1;
	assert.equal(verdict(await at(flipped)), "crypto-auth/false", "bad tag under a verified key: the sender's fault");
	assert.equal(verdict(await at(with_(2, 2))), "crypto-auth/true", "bad tag under an unverified key: maybe ours");
	assert.equal(verdict(await at(with_(2, 9))), "crypto-unknown-key/true");
	const plain = await sealFrame(crypto, vaultId, { stream: BODY, deviceId: DEV, clientFrameId: CF, kind: "bodyUpdate", authorNsSeq: 0, flags: 0, frameNo: 0, content });
	assert.equal(verdict(await at(plain.sealed)), "crypto-downgrade/false", "suite-0 bytes to a suite-1 reader");
	assert.equal(verdict(await at(s.sealed, { ...ctx, vaultId })), "crypto-unknown-key/true", "suite-1 bytes to a suite-0 reader");
	const header = { formatVersion: 1, suite: 1, keyEpoch: 1 } as const;
	const unpadded = await s1.seal({ purpose: "frame", keyEpoch: 1, aad: frameAad(header, vaultId, BODY, DEV, CF), plaintext: new Uint8Array(256) });
	assert.equal(verdict(await at(encodeOuter(header, unpadded))), "envelope-padding/false");
});

test("gate: snap rows and checkpoints (DESIGN §j.4)", async () => {
	const T = Date.UTC(2026, 9, 7);
	const H = (n: number) => n.toString(16).padStart(64, "0") as ContentHash;
	const record = {
		version: 1 as const, snapshotId: snapshotId(T, "daily"), createdAtMs: T, deviceLabel: "l", reason: "daily" as const, format: 1,
		fileCount: 1, totalBytes: 1, bundleDigest: H(1), parts: [{ address: H(2), size: 9, sha256: H(2) }],
	};
	const seal = async (content: Uint8Array, kind: "snapOps" | "nsOps") =>
		gate(ctx, { t: "row", stream: SNAP_STREAM, seq: 1, deviceId: DEV, clientFrameId: CF, payload: (await sealFrame(crypto, ctx.vaultId, { stream: SNAP_STREAM, deviceId: DEV, clientFrameId: CF, kind, authorNsSeq: 0, flags: 0, frameNo: kind === "nsOps" ? 1 : 0, content })).sealed });
	const ok = await seal(encodeSnapOps([{ t: "put", record }]), "snapOps");
	assert.ok(ok.ok && ok.t === "snap" && ok.ops?.length === 1);
	const junk = await seal(new Uint8Array([9, 9, 9]), "snapOps");
	assert.ok(junk.ok && junk.t === "snap" && junk.ops === null, "malformed: deterministic, folds empty");
	assert.equal(failReason(await seal(encodeSnapOps([{ t: "put", record }]), "nsOps")), "kind-not-allowed");

	const st = newSnapFold();
	foldSnapFrame(st, { seq: 7, deviceId: "dev-x-0123456789abcdef" as DeviceId, ops: [{ t: "put", record }] });
	st.coversSeq = 7;
	const ck = (bytes: Uint8Array, encoding: CheckpointEncoding = CheckpointEncoding.snapFoldV1, coversSeq = 7) =>
		sealCheckpoint(crypto, ctx.vaultId, SNAP_STREAM, coversSeq, encodeCheckpointContent({ encoding, coversSeq, foldRulesVersion: SNAP_FOLD_RULES_VERSION, state: bytes }), 0);
	const good = await gate(ctx, { t: "checkpoint", stream: SNAP_STREAM, coversSeq: 7, payload: await ck(encodeSnapFoldV1(st)) });
	assert.ok(good.ok && good.t === "checkpoint" && good.snapState?.records.size === 1);
	assert.equal(failReason(await gate(ctx, { t: "checkpoint", stream: SNAP_STREAM, coversSeq: 7, payload: await ck(encodeSnapFoldV1(st), CheckpointEncoding.cfgFoldV1) })), "kind-not-allowed");
	assert.equal(failReason(await gate(ctx, { t: "checkpoint", stream: SNAP_STREAM, coversSeq: 7, payload: await ck(new Uint8Array([1, 2, 3])) })), "decode-failed");
	assert.equal(failReason(await gate(ctx, { t: "checkpoint", stream: SNAP_STREAM, coversSeq: 8, payload: await ck(encodeSnapFoldV1(st), CheckpointEncoding.snapFoldV1, 8) })), "checkpoint-mismatch");
});
