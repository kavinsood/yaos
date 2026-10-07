/**
 * Frame builder + frame sealing units (DESIGN §d.4, §b.6, §j.1; §k.3 WP-C #3):
 * caps, close timing, initial chunking, bodyUpdateRef (x: chunks / BlobPort),
 * FrameTooLargeError, ref resolution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import {
	BLOB_CHUNK_BYTES, FRAME_MAX_BYTES, FRAME_MAX_UPDATES, MAX_INLINE_UPDATE_BYTES, MAX_LOG_BLOB_BYTES, OPEN_FRAME_IDLE_MS, OPEN_FRAME_MAX_MS,
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
import { FrameTooLargeError, buildBodyFrames, initialTextUpdates, splitInitialText, type FrameCtx } from "./frames";
import { assembleChunks, resolveRefContent } from "./refs";

const hash = createWebHash();
const crypto = createNoopCrypto(hash);
const VAULT = "v1" as VaultId;
const ctx: FrameCtx = { vaultId: VAULT, self: "dev1" as DeviceId, crypto, hash, random: createWebRandom(), blob: null };
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

test("buildBodyFrames: > MAX_INLINE_UPDATE_BYTES without a blob store -> x: chunks + bodyUpdateRef held on the last chunk", async () => {
	const u = textUpdate(MAX_INLINE_UPDATE_BYTES + 200_000);
	assert.ok(u.length > MAX_INLINE_UPDATE_BYTES);
	const frames = await buildBodyFrames(ctx, { stream: BODY, content: u, flags: 0, authorNsSeq: 0 as Seq, dependsOn: null, nowMs: 0 });
	const h = toHex(await hash.sha256(u)) as ContentHash;
	const chunks = frames.slice(0, -1);
	const ref = frames[frames.length - 1]!;
	assert.equal(chunks.length, Math.ceil(u.length / BLOB_CHUNK_BYTES));
	for (const c of chunks) {
		assert.equal(c.stream, blobChunkStream(h));
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
	assert.deepEqual(assembleChunks(chunks.map((c) => c.content).reverse(), h), u, "chunks reassemble in any order");
	assert.equal(assembleChunks(chunks.slice(1).map((c) => c.content), h), null, "incomplete");

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
