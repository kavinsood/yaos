/**
 * Frame builder + frame sealing units (DESIGN §d.4, §b.6, §j.1; §k.3 WP-C #3):
 * caps, close timing, initial chunking, bodyUpdateRef (x: chunks / BlobPort),
 * FrameTooLargeError, ref resolution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import {
	BLOB_CHUNK_BYTES, FRAME_MAX_BYTES, FRAME_MAX_UPDATES, MAX_FRAME_CONTENT_BYTES, MAX_INLINE_UPDATE_BYTES, MAX_LOG_BLOB_BYTES, OPEN_FRAME_IDLE_MS,
	OPEN_FRAME_MAX_MS,
} from "../../core/limits";
import { blobChunkStream, type ClientFrameId, type ContentHash, type DeviceId, type Seq, type StreamName, type VaultId } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { BlobAddress } from "../../ports/crypto";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebHash } from "../adapters/webHash";
import { createWebRandom } from "../adapters/webRandom";
import { gate, type GateCtx } from "../ingest/gate";
import type { Repo } from "../store/repo";
import { bytesToHex as toHex } from "../../core/codec/lib0";
import { encodeBodyUpdateRef as encodeBodyRef } from "../../core/codec/contents";
import { FrameBuilder } from "./frameBuilder";
import { FrameTooLargeError, buildBlobChunkFrame, buildBodyFrames, initialTextUpdates, splitInitialText, type FrameCtx } from "./frames";
import { assembleChunks } from "../blobs/chunks";
import { decodeChunks, resolveRef, resolveRefContent } from "./refs";
import { decodeBlobChunk, encodeBlobChunk } from "../../core/codec/contents";
import { ScriptedRandom } from "../adapters/testkit/scriptedRandom";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { DEFAULT_RELAY_LIMITS } from "../adapters/wsRelay";

const hash = createWebHash();
const crypto = createNoopCrypto(hash);
const VAULT = "v1" as VaultId;
const ctx: FrameCtx = { vaultId: VAULT, self: "dev1" as DeviceId, crypto, hash, random: createWebRandom(), blob: null, touch: { reuse: async () => true, noted: async () => {} } };
const gctx: GateCtx = { crypto, vaultId: VAULT, maxCheckpointStateBytes: 1 << 20 };
const BODY = "b:doc1" as StreamName;

function textUpdate(chars: number, ch = "a"): Uint8Array {
	const d = new Y.Doc();
	d.getText("text").insert(0, ch.repeat(chars));
	return Y.encodeStateAsUpdate(d);
}

/** Incompressible bytes: the frame builder treats an update as opaque, and deflate cannot shrink these. */
function noiseBytes(n: number): Uint8Array {
	const b = new Uint8Array(n);
	let x = 7;
	for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; b[i] = x >>> 24; }
	return b;
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

test("buildBodyFrames: > MAX_INLINE_UPDATE_BYTES without a blob store -> x: chunks + bodyUpdateRef held on the last chunk", async () => {
	const u = textUpdate(MAX_INLINE_UPDATE_BYTES + 200_000);
	assert.ok(u.length > MAX_INLINE_UPDATE_BYTES);
	const frames = await buildBodyFrames(ctx, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 });
	const h = toHex(await hash.sha256(u)) as ContentHash;
	const chunks = frames.slice(0, -1);
	const ref = frames[frames.length - 1]!;
	assert.equal(chunks.length, Math.ceil(u.length / BLOB_CHUNK_BYTES));
	for (const c of chunks) {
		assert.equal(c.stream, blobChunkStream(await crypto.blobAddress(h)));
		assert.equal(c.kind, "blobChunk");
		assert.equal(c.state, "pending");
		assert.ok(c.sealed.length <= 1024 * 1024, "every chunk fits a relay frame");
		const g = await gate(gctx, { t: "row", stream: c.stream, seq: 1, deviceId: "d" as never, clientFrameId: c.clientFrameId, payload: c.sealed });
		assert.ok(g.ok && g.t === "blobchunk", JSON.stringify(g.ok ? g.t : g.reason));
	}
	assert.equal(ref.kind, "bodyUpdateRef");
	assert.equal(ref.state, "held");
	assert.equal(ref.dependsOn, chunks[chunks.length - 1]!.clientFrameId);
	assert.deepEqual(ref.content, u, "outbox keeps the full update for local reload");
	const g = await gate(gctx, { t: "row", stream: BODY, seq: 1, deviceId: "d" as never, clientFrameId: ref.clientFrameId, payload: ref.sealed });
	assert.ok(g.ok && g.t === "bodyRef" && g.ref.hash === h && g.ref.size === u.length);
	assert.deepEqual(assembleChunks(h, decodeChunks(chunks.map((c) => c.content).reverse())), { ok: true, bytes: u }, "chunks reassemble in any order");
	assert.deepEqual(assembleChunks(h, decodeChunks(chunks.slice(1).map((c) => c.content))), { ok: false, reason: "incomplete" });

	const dep = "dep-frame-id-000000000" as ClientFrameId;
	const withDep = await buildBodyFrames(ctx, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: dep, nowMs: 0 });
	assert.equal(withDep[withDep.length - 1]!.dependsOn, dep, "an explicit dependency takes precedence");

	// Resolution from the x: tail: hash checked, then gate stage 2 on the bytes.
	const tail = chunks.map((c, i) => ({ stream: c.stream, seq: i + 1, content: c.content }));
	const repo = { getTail: async (s: StreamName) => tail.filter((r) => r.stream === s) } as unknown as Repo;
	const deps = { repo, crypto, hash, blob: null };
	const refBody = encodeBodyRef({ hash: h, size: u.length });
	assert.deepEqual(await resolveRefContent(deps, BODY, refBody), u);
	const wrongSize = encodeBodyRef({ hash: h, size: u.length - 1 });
	assert.equal(await resolveRefContent(deps, BODY, wrongSize), null);
	tail.pop();
	assert.equal(await resolveRefContent(deps, BODY, refBody), null, "missing chunk -> unavailable yet");
});

test("buildBodyFrames: BlobPort path puts once (deduped by has), falls back to x: chunks when the store fails", async () => {
	const store = new Map<BlobAddress, Uint8Array>();
	let puts = 0;
	let fail = false;
	const blob: BlobPort = {
		maxBlobBytes: 64 * 1024 * 1024,
		async has(as) {
			if (fail) throw new Error("offline");
			return new Set(as.filter((a) => store.has(a)));
		},
		async put(a, b) {
			puts++;
			store.set(a, b);
		},
		async get(a) {
			return store.get(a) ?? null;
		},
		list: async () => { throw new Error("unused"); },
		deleteIfUploadedBefore: async () => { throw new Error("unused"); },
	};
	const bctx = { ...ctx, blob };
	const u = textUpdate(MAX_INLINE_UPDATE_BYTES + 10);
	const one = await buildBodyFrames(bctx, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 });
	assert.equal(one.length, 1);
	assert.equal(one[0]!.kind, "bodyUpdateRef");
	assert.equal(one[0]!.state, "pending");
	await buildBodyFrames(bctx, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 });
	assert.equal(puts, 1, "second put skipped: has() answered");
	const repo = { getTail: async () => [] } as unknown as Repo;
	const refBody = encodeBodyRef({ hash: toHex(await hash.sha256(u)) as ContentHash, size: u.length });
	assert.deepEqual(await resolveRefContent({ repo, crypto, hash, blob }, BODY, refBody), u, "resolved from the blob store");
	fail = true;
	const fb = await buildBodyFrames(bctx, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 });
	assert.equal(fb.length, 3, "2 chunks + held ref");
});

test("buildBodyFrames: > MAX_LOG_BLOB_BYTES with no blob store -> FrameTooLargeError", async () => {
	const u = textUpdate(MAX_LOG_BLOB_BYTES + 1);
	await assert.rejects(buildBodyFrames(ctx, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 }), FrameTooLargeError);
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

test("suite 1, log path: x: named by the blob address; full 768 KiB chunk frames seal under the 1 MiB relay frame and pass the gate", async () => {
	const s1 = await suite1(0xe1);
	const c1: FrameCtx = { ...ctx, vaultId: VAULT1, crypto: s1 };
	const g1: GateCtx = { crypto: await suite1(0xe2), vaultId: VAULT1, maxCheckpointStateBytes: 1 << 20 };
	const u = noiseBytes(3 * BLOB_CHUNK_BYTES - 1000);
	const h = toHex(await hash.sha256(u)) as ContentHash;
	const frames = await buildBodyFrames(c1, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 });
	const xs = blobChunkStream(await s1.blobAddress(h));
	assert.notEqual(xs, blobChunkStream(h as unknown as BlobAddress), "never x:<sha256>");
	assert.ok(!xs.includes(h));
	const chunks = frames.slice(0, -1);
	assert.equal(chunks.length, 3);
	for (const c of chunks) {
		assert.equal(c.stream, xs);
		assert.ok(c.content.length <= MAX_FRAME_CONTENT_BYTES);
		assert.ok(c.sealed.length <= DEFAULT_RELAY_LIMITS.maxFrameBytes, `${c.sealed.length}`);
		const g = await gate(g1, { t: "row", stream: c.stream, seq: 1, deviceId: c1.self, clientFrameId: c.clientFrameId, payload: c.sealed });
		assert.ok(g.ok && g.t === "blobchunk", JSON.stringify(g.ok ? g.t : g.reason));
	}
	assert.equal(decodeBlobChunk(chunks[0]!.content)!.chunk.length, BLOB_CHUNK_BYTES);
	assert.ok(chunks[0]!.sealed.length > BLOB_CHUNK_BYTES, "a full chunk, incompressible: not shrunk by deflate");
	// The largest chunk frame the log path makes: the 11th 768 KiB chunk of an 8 MiB blob.
	const last = await buildBlobChunkFrame(c1, await s1.blobAddress(h), { hash: h, index: 10, total: 11, totalSize: MAX_LOG_BLOB_BYTES, chunk: noiseBytes(BLOB_CHUNK_BYTES) }, 0 as Seq, 0);
	assert.ok(last.content.length <= MAX_FRAME_CONTENT_BYTES);
	// Padmé bucket 49 x 16 KiB (784 KiB), plus the outer header, nonce and tag: ~240 KiB under the 1 MiB frame.
	assert.ok(last.sealed.length > 49 * 16 * 1024 && last.sealed.length <= 49 * 16 * 1024 + 28 + 64, `${last.sealed.length}`);
	assert.ok(last.sealed.length <= DEFAULT_RELAY_LIMITS.maxFrameBytes);
	const ref = frames.at(-1)!;
	const g = await gate(g1, { t: "row", stream: BODY, seq: 2, deviceId: c1.self, clientFrameId: ref.clientFrameId, payload: ref.sealed });
	assert.ok(g.ok && g.t === "bodyRef" && g.ref.hash === h, "the ref carries the plaintext sha256 (sealed)");

	// Resolution (a real Yjs update: refs check it) from the committed x: rows, on another device; a chunk with
	// other bytes (same shape) is deterministic, a missing one is not.
	const y = textUpdate(2 * BLOB_CHUNK_BYTES + 5000);
	const yh = toHex(await hash.sha256(y)) as ContentHash;
	const yChunks = (await buildBodyFrames(c1, { stream: BODY, content: y, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 })).slice(0, -1);
	assert.equal(yChunks.length, 3);
	const tail = yChunks.map((c, i) => ({ stream: c.stream, seq: i + 1, content: c.content }));
	const deps = { repo: { getTail: async (st: StreamName) => tail.filter((r) => r.stream === st) } as unknown as Repo, crypto: g1.crypto, hash, blob: null };
	const refBody = encodeBodyRef({ hash: yh, size: y.length });
	const ok = await resolveRef(deps, BODY, refBody);
	assert.ok(ok.ok && Buffer.compare(ok.bytes, y) === 0, JSON.stringify(ok.ok ? ok.bytes.length : ok));
	const second = decodeBlobChunk(tail[1]!.content)!;
	tail[1] = { ...tail[1]!, content: encodeBlobChunk({ ...second, chunk: second.chunk.map((b) => b ^ 1) }) };
	assert.deepEqual(await resolveRef(deps, BODY, refBody), { ok: false, deterministic: true });
	tail.splice(1, 1);
	assert.deepEqual(await resolveRef(deps, BODY, refBody), { ok: false, deterministic: false });
});

test("suite 1, store path: ref blobs sealed at their address; tampered -> deterministic only under a verified key", async () => {
	const objects = new Map<BlobAddress, Uint8Array>();
	let down = false;
	const blob: BlobPort = {
		maxBlobBytes: 10 * 1024 * 1024,
		has: async (as) => { if (down) throw new Error("offline"); return new Set(as.filter((a) => objects.has(a))); },
		put: async (a, b) => void objects.set(a, b.slice()),
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
	const repo = { getTail: async () => [] } as unknown as Repo;
	const at = async (c: Awaited<ReturnType<typeof suite1>>, refBody = encodeBodyRef({ hash: h, size: u.length })) => resolveRef({ repo, crypto: c, hash, blob }, BODY, refBody);
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

