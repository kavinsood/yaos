/**
 * Frame builder + frame sealing units (DESIGN §d.4, §b.6, §j.1; §k.3 WP-C #3):
 * caps, close timing, initial chunking, bodyUpdateRef (BlobPort only),
 * FrameTooLargeError, ref resolution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { FRAME_MAX_BYTES, FRAME_MAX_UPDATES, MAX_INLINE_UPDATE_BYTES, OPEN_FRAME_IDLE_MS, OPEN_FRAME_MAX_MS } from "../../core/limits";
import { type ClientFrameId, type ContentHash, type DeviceId, type Seq, type StreamName, type VaultId } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { BlobAddress } from "../../ports/crypto";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebHash } from "../adapters/webHash";
import { createWebRandom } from "../adapters/webRandom";
import { gate, type GateCtx } from "../ingest/gate";
import { bytesToHex as toHex, concatBytes } from "../../core/codec/lib0";
import { encodeBodyUpdateRef as encodeBodyRef } from "../../core/codec/contents";
import { FrameBuilder } from "./frameBuilder";
import { FrameTooLargeError, buildBodyFrames, initialTextUpdates, splitInitialText, type FrameCtx } from "./frames";
import { resolveRef, resolveRefContent } from "./refs";
import { ScriptedRandom } from "../adapters/testkit/scriptedRandom";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";

const hash = createWebHash();
const crypto = createNoopCrypto(hash);
const VAULT = "v1" as VaultId;
const ctx: FrameCtx = { vaultId: VAULT, self: "dev1" as DeviceId, crypto, hash, random: createWebRandom(), blob: null, touch: { reuse: async () => true, noted: async () => {} } };
const gctx: GateCtx = { crypto, vaultId: VAULT, maxCheckpointStateBytes: 1 << 20, staleCheck: () => null };
const BODY = "b:doc1" as StreamName;

function textUpdate(chars: number, ch = "a"): Uint8Array {
	const d = new Y.Doc();
	d.getText("text").insert(0, ch.repeat(chars));
	return Y.encodeStateAsUpdate(d);
}

test("FrameBuilder: closes at FRAME_MAX_UPDATES and FRAME_MAX_BYTES; take merges the batch and ORs flags", () => {
	const src = new Y.Doc();
	const ups: Uint8Array[] = [];
	src.on("update", (u: Uint8Array) => ups.push(u));
	for (let i = 0; i < FRAME_MAX_UPDATES; i++) src.getText("text").insert(i, "x");
	const fb = new FrameBuilder();
	assert.equal(fb.empty, true);
	assert.equal(fb.take(), null);
	for (let i = 0; i < FRAME_MAX_UPDATES - 1; i++) assert.equal(fb.push(ups[i]!, i, i === 3 ? 4 : 0), false);
	assert.equal(fb.push(ups[FRAME_MAX_UPDATES - 1]!, 999, 1), true, "count cap");
	const out = fb.take()!;
	assert.equal(out.updates, FRAME_MAX_UPDATES);
	assert.equal(out.flags, 5);
	assert.equal(fb.empty, true);
	assert.equal(fb.pendingBytes, 0);
	const d = new Y.Doc();
	Y.applyUpdate(d, out.content);
	assert.equal(d.getText("text").toString(), "x".repeat(FRAME_MAX_UPDATES));

	const big = new FrameBuilder();
	assert.equal(big.push(textUpdate(FRAME_MAX_BYTES / 2), 0), false);
	assert.equal(big.push(textUpdate(FRAME_MAX_BYTES / 2, "b"), 0), true, "bytes cap");
	const single = new FrameBuilder();
	const u = textUpdate(3);
	single.push(u, 0);
	assert.equal(single.take()!.content, u, "one update: no merge, bytes as given");
});

test("FrameBuilder.dueAt: idle after the last push, capped by max age from the first; stretch scales both", () => {
	const fb = new FrameBuilder();
	assert.equal(fb.dueAt(), null);
	fb.push(textUpdate(1), 1000);
	assert.equal(fb.dueAt(), 1000 + OPEN_FRAME_IDLE_MS);
	fb.push(textUpdate(1, "b"), 1050);
	assert.equal(fb.dueAt(), 1050 + OPEN_FRAME_IDLE_MS);
	fb.push(textUpdate(1, "c"), 1000 + OPEN_FRAME_MAX_MS - 10);
	assert.equal(fb.dueAt(), 1000 + OPEN_FRAME_MAX_MS, "max age wins under continuous typing");
	assert.equal(fb.dueAt(4), Math.min(1000 + OPEN_FRAME_MAX_MS - 10 + OPEN_FRAME_IDLE_MS * 4, 1000 + OPEN_FRAME_MAX_MS * 4));
	fb.take();
	assert.equal(fb.dueAt(), null);
});

test("splitInitialText: <= max units per chunk, never splits a surrogate pair, joins back exactly", () => {
	const emoji = "\u{1F600}";
	for (const text of ["", "abc", "a".repeat(10), "ab" + emoji + "cd" + emoji.repeat(5), (emoji + "x").repeat(100)]) {
		for (const max of [2, 3, 4, 7]) {
			const parts = splitInitialText(text, max);
			assert.equal(parts.join(""), text);
			for (const p of parts) {
				assert.ok(p.length <= max && p.length > 0);
				const last = p.charCodeAt(p.length - 1);
				assert.ok(!(last >= 0xd800 && last <= 0xdbff), "no dangling high surrogate");
				const first = p.charCodeAt(0);
				assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "no leading low surrogate");
			}
		}
	}
	assert.deepEqual(splitInitialText("abcdef", 4), ["abcd", "ef"]);
	assert.deepEqual(splitInitialText(`abc${emoji}`, 4), ["abc", emoji]);
});

test("initialTextUpdates: one update per chunk, each gates on its own, in order they rebuild the text", async () => {
	const text = "line\n".repeat(1000) + "\u{1F600}".repeat(50);
	const doc = new Y.Doc();
	const ups = initialTextUpdates(doc, text, 997);
	assert.equal(ups.length, splitInitialText(text, 997).length);
	assert.equal(doc.getText("text").toString(), text);
	const peer = new Y.Doc();
	for (const u of ups) {
		const [f] = await buildBodyFrames(ctx, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 });
		const g = await gate(gctx, { t: "row", stream: BODY, seq: 1, deviceId: "d" as never, clientFrameId: f!.clientFrameId, payload: f!.sealed });
		assert.ok(g.ok && g.t === "body" && g.insertedChars <= 997);
		Y.applyUpdate(peer, u);
	}
	assert.equal(peer.getText("text").toString(), text);
});

test("buildBodyFrames: inline frame pending (or held on a dependency); content is the raw update", async () => {
	const u = textUpdate(10);
	const [f] = await buildBodyFrames(ctx, { stream: BODY, content: u, flags: 0, authorNsSeq: 3 as Seq, dependsOn: null, nowMs: 5 });
	assert.equal(f!.state, "pending");
	assert.equal(f!.kind, "bodyUpdate");
	assert.deepEqual(f!.content, u);
	const dep = "dep-frame-id-000000000" as ClientFrameId;
	const [h] = await buildBodyFrames(ctx, { stream: BODY, content: u, flags: 0, authorNsSeq: 3 as Seq, dependsOn: dep, nowMs: 5 });
	assert.equal(h!.state, "held");
	assert.equal(h!.dependsOn, dep);
	const [c] = await buildBodyFrames(ctx, { stream: "c:doc2" as StreamName, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 });
	assert.equal(c!.kind, "canvasUpdate");
});

/** In-memory BlobPort; `fail` makes every call throw (store outage). */
function memStore(maxBlobBytes = 64 * 1024 * 1024) {
	const objects = new Map<BlobAddress, Uint8Array>();
	const st = { objects, puts: 0, fail: false, blob: null as unknown as BlobPort };
	st.blob = {
		maxBlobBytes,
		async has(as) { if (st.fail) throw new Error("offline"); return new Set(as.filter((a) => objects.has(a))); },
		async put(a, parts) { if (st.fail) throw new Error("offline"); st.puts++; objects.set(a, concatBytes(parts)); },
		async get(a) { if (st.fail) throw new Error("offline"); return objects.get(a)?.slice() ?? null; },
		list: async () => { throw new Error("unused"); },
		deleteIfUploadedBefore: async () => { throw new Error("unused"); },
	};
	return st;
}

test("buildBodyFrames: > MAX_INLINE_UPDATE_BYTES without a blob store -> FrameTooLargeError (the doc freezes oversize-local), nothing for the log", async () => {
	const u = textUpdate(MAX_INLINE_UPDATE_BYTES + 10);
	assert.ok(u.length > MAX_INLINE_UPDATE_BYTES);
	await assert.rejects(buildBodyFrames(ctx, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 }), FrameTooLargeError);
	const at = textUpdate(MAX_INLINE_UPDATE_BYTES - 200);
	assert.ok(at.length <= MAX_INLINE_UPDATE_BYTES);
	const [f] = await buildBodyFrames(ctx, { stream: BODY, content: at, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 });
	assert.equal(f!.kind, "bodyUpdate", "up to the inline cap still rides the log as a plain update");
});

test("buildBodyFrames: BlobPort path: one ref frame (pending or held on a dependency), put once (deduped by has); resolved from the store only", async () => {
	const st = memStore();
	const bctx = { ...ctx, blob: st.blob };
	const u = textUpdate(MAX_INLINE_UPDATE_BYTES + 200_000);
	const h = toHex(await hash.sha256(u)) as ContentHash;
	const one = await buildBodyFrames(bctx, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 });
	assert.equal(one.length, 1);
	assert.equal(one[0]!.kind, "bodyUpdateRef");
	assert.equal(one[0]!.state, "pending");
	assert.deepEqual(one[0]!.content, u, "outbox keeps the full update for local reload");
	assert.ok(one[0]!.sealed.length < 256, `the relay sees a small ref, not the update: ${one[0]!.sealed.length} B`);
	assert.deepEqual([...st.objects.keys()], [await crypto.blobAddress(h)]);
	const g = await gate(gctx, { t: "row", stream: BODY, seq: 1, deviceId: "d" as never, clientFrameId: one[0]!.clientFrameId, payload: one[0]!.sealed });
	assert.ok(g.ok && g.t === "bodyRef" && g.ref.hash === h && g.ref.size === u.length);
	const dep = "dep-frame-id-000000000" as ClientFrameId;
	const held = await buildBodyFrames(bctx, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: dep, nowMs: 0 });
	assert.equal(held.length, 1);
	assert.equal(held[0]!.state, "held");
	assert.equal(held[0]!.dependsOn, dep);
	assert.equal(st.puts, 1, "second put skipped: has() answered");

	const deps = { crypto, hash, blob: st.blob };
	const refBody = encodeBodyRef({ hash: h, size: u.length });
	assert.deepEqual(await resolveRefContent(deps, BODY, refBody), u, "resolved from the blob store");
	assert.equal(await resolveRefContent(deps, BODY, encodeBodyRef({ hash: h, size: u.length - 1 })), null);
	assert.deepEqual(await resolveRef({ ...deps, blob: null }, BODY, refBody), { ok: false, deterministic: false }, "no store: unavailable, never from the log");
	st.objects.clear();
	assert.deepEqual(await resolveRef(deps, BODY, refBody), { ok: false, deterministic: false }, "absent: unavailable");
});

test("buildBodyFrames: a store error still emits only the ref (BlobTouch R3 re-puts it before send); above the store's cap -> FrameTooLargeError", async () => {
	const st = memStore();
	st.fail = true;
	const u = textUpdate(MAX_INLINE_UPDATE_BYTES + 10);
	const out = await buildBodyFrames({ ...ctx, blob: st.blob }, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 });
	assert.deepEqual(out.map((f) => [f.stream, f.kind]), [[BODY, "bodyUpdateRef"]]);
	assert.equal(st.objects.size, 0);
	const small = memStore(MAX_INLINE_UPDATE_BYTES + 1);
	await assert.rejects(buildBodyFrames({ ...ctx, blob: small.blob }, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 }), FrameTooLargeError);
	assert.equal(small.puts, 0);
});

// ---- suite 1 (e2ee-design §10, WP-E6a) -------------------------------------------------------

const VAULT1 = "AAAAAAAAAAAAAAAAAAAAAA" as VaultId;
const K1 = Uint8Array.from({ length: 32 }, (_, i) => i);
const K2 = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i);

async function suite1(tag: number, o: { e2?: Uint8Array | null; verified?: readonly number[] } = {}) {
	const random = new ScriptedRandom();
	for (let i = 0; i < 64; i++) random.push(Uint8Array.from([tag, i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
	const keys = [{ e: 1, k: K1.slice() }, ...(o.e2 === null ? [] : [{ e: 2, k: (o.e2 ?? K2).slice() }])];
	const c = await createWebCryptoSuite1({ vaultId: VAULT1, random, keys });
	for (const e of o.verified ?? [1, 2]) c.markVerified(e);
	c.setSealEpoch(o.verified && !o.verified.includes(2) ? 1 : 2);
	return c;
}

test("suite 1, store path: ref blobs sealed at their address; tampered -> deterministic only under a verified key", async () => {
	const objects = new Map<BlobAddress, Uint8Array>();
	let down = false;
	const blob: BlobPort = {
		maxBlobBytes: 10 * 1024 * 1024,
		has: async (as) => { if (down) throw new Error("offline"); return new Set(as.filter((a) => objects.has(a))); },
		put: async (a, parts) => void objects.set(a, concatBytes(parts)),
		get: async (a) => { if (down) throw new Error("offline"); return objects.get(a)?.slice() ?? null; },
		list: async () => { throw new Error("unused"); },
		deleteIfUploadedBefore: async () => { throw new Error("unused"); },
	};
	const s1 = await suite1(0xe3);
	const u = textUpdate(MAX_INLINE_UPDATE_BYTES + 10);
	const h = toHex(await hash.sha256(u)) as ContentHash;
	const frames = await buildBodyFrames({ ...ctx, vaultId: VAULT1, crypto: s1, blob }, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 });
	assert.equal(frames.length, 1);
	const addr = await s1.blobAddress(h);
	assert.deepEqual([...objects.keys()], [addr]);
	assert.notDeepEqual(objects.get(addr)!.subarray(0, 64), u.subarray(0, 64), "sealed");
	const at = async (c: Awaited<ReturnType<typeof suite1>>, refBody = encodeBodyRef({ hash: h, size: u.length })) => resolveRef({ crypto: c, hash, blob }, BODY, refBody);
	const reader = await suite1(0xe4);
	const unverified = await suite1(0xe5, { verified: [1] });
	const noK2 = await suite1(0xe6, { e2: null, verified: [1] });
	assert.deepEqual(await at(reader), { ok: true, bytes: u });
	assert.deepEqual(await at(reader, encodeBodyRef({ hash: h, size: u.length - 1 })), { ok: false, deterministic: true }, "bytes of the ref's hash, wrong size: the ref is bad");
	const good = objects.get(addr)!;
	objects.set(addr, good.map((b, i) => (i === 40 ? b ^ 1 : b)));
	assert.deepEqual(await at(reader), { ok: false, deterministic: true }, "tampered at rest, verified key");
	assert.deepEqual(await at(unverified), { ok: false, deterministic: false }, "unverified key: never deterministic");
	assert.deepEqual(await at(noK2), { ok: false, deterministic: false }, "unknown key");
	down = true;
	assert.deepEqual(await at(reader), { ok: false, deterministic: false }, "store error");
	down = false;
	objects.clear();
	assert.deepEqual(await at(reader), { ok: false, deterministic: false }, "absent everywhere");
});

