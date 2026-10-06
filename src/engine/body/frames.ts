/**
 * Sealing own frames into outbox records (DESIGN §d.4 steps 2-4, §b.6, §j.1).
 *
 *  - body/canvas content > MAX_INLINE_UPDATE_BYTES (raw, the size the gate
 *    checks) becomes a bodyUpdateRef: the update goes to the BlobPort, or
 *    without one to `x:<sha256>` blobChunk frames; the ref frame is then
 *    `held` on the last chunk.
 *  - The outbox record of a ref keeps the full update as `content` (the local
 *    doc re-applies it at load); the sealed payload carries the ref.
 *  - Initial content is inserted in INITIAL_INSERT_CHUNK_CHARS transactions,
 *    one frame each, flag `initial`.
 */

import * as Y from "yjs";
import { EnvelopeFlag, type BlobChunkContent, type EnvelopeKind } from "../../core/envelope";
import { BLOB_CHUNK_BYTES, INITIAL_INSERT_CHUNK_CHARS, MAX_INLINE_UPDATE_BYTES, MAX_LOG_BLOB_BYTES } from "../../core/limits";
import { blobChunkStream, streamClass, type CfgOp, type ClientFrameId, type ContentHash, type DeviceId, type NsOp, type Seq, type StreamName, type VaultId } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { CryptoPort, HashPort } from "../../ports/crypto";
import type { RandomPort } from "../../ports/random";
import { sealFrame } from "../ingest/envelope";
import type { NewOutboxFrame } from "../store/repo";
import { encodeCfgOps } from "../../core/codec/cfgOps";
import { encodeBlobChunk, encodeBodyUpdateRef } from "../../core/codec/contents";
import { newClientFrameId } from "../../core/codec/ids";
import { bytesToHex } from "../../core/codec/lib0";
import { encodeNsOps } from "../../core/codec/nsOps";
import { ORIGIN } from "./yjsCounters";

export interface FrameCtx {
	readonly vaultId: VaultId;
	readonly crypto: CryptoPort;
	readonly hash: HashPort;
	readonly random: RandomPort;
	readonly blob: BlobPort | null;
}

export class FrameTooLargeError extends Error {
	constructor(readonly bytes: number) {
		super(`update of ${bytes} bytes exceeds the log blob limit`);
	}
}

async function seal(ctx: FrameCtx, stream: StreamName, kind: EnvelopeKind, authorNsSeq: Seq, flags: number, sealedContent: Uint8Array, localContent: Uint8Array, state: "pending" | "held", dependsOn: ClientFrameId | null, nowMs: number): Promise<NewOutboxFrame> {
	const clientFrameId = newClientFrameId(ctx.random);
	const s = await sealFrame(ctx.crypto, ctx.vaultId, stream, clientFrameId, kind, authorNsSeq, flags, sealedContent);
	return {
		clientFrameId, stream, kind, state, sealed: s.sealed, content: localContent, authorNsSeq, flags: s.flags & ~EnvelopeFlag.deflate,
		dependsOn, adoptOf: null, createdAtMs: nowMs,
	};
}

export interface BodyFrameInput {
	readonly stream: StreamName;
	readonly content: Uint8Array;
	readonly flags: number;
	readonly authorNsSeq: Seq;
	/** Held dependency (ns create or newest adoptable); null = pending. */
	readonly dependsOn: ClientFrameId | null;
	readonly nowMs: number;
}

/** One body/canvas update -> 1 frame, or (oversize) x: chunks / blob put + a held bodyUpdateRef. */
export async function buildBodyFrames(ctx: FrameCtx, input: BodyFrameInput): Promise<NewOutboxFrame[]> {
	const cls = streamClass(input.stream);
	const kind: EnvelopeKind = cls === "canvas" ? "canvasUpdate" : "bodyUpdate";
	const state = input.dependsOn ? "held" : "pending";
	if (input.content.length <= MAX_INLINE_UPDATE_BYTES) {
		return [await seal(ctx, input.stream, kind, input.authorNsSeq, input.flags, input.content, input.content, state, input.dependsOn, input.nowMs)];
	}
	const hash = bytesToHex(await ctx.hash.sha256(input.content)) as ContentHash;
	const refContent = encodeBodyUpdateRef({ hash, size: input.content.length });
	if (ctx.blob && input.content.length <= ctx.blob.maxBlobBytes) {
		try {
			const address = await ctx.crypto.blobAddress(hash);
			const has = await ctx.blob.has([address]);
			if (!has.has(address)) await ctx.blob.put(address, await ctx.crypto.sealBlob({ address, plaintext: input.content }));
			return [await seal(ctx, input.stream, "bodyUpdateRef", input.authorNsSeq, input.flags, refContent, input.content, state, input.dependsOn, input.nowMs)];
		} catch {
			// Blob store unavailable: fall through to the log path.
		}
	}
	if (input.content.length > MAX_LOG_BLOB_BYTES) throw new FrameTooLargeError(input.content.length);
	const xs = blobChunkStream(hash);
	const total = Math.ceil(input.content.length / BLOB_CHUNK_BYTES);
	const out: NewOutboxFrame[] = [];
	for (let i = 0; i < total; i++) {
		const chunk = input.content.subarray(i * BLOB_CHUNK_BYTES, Math.min(input.content.length, (i + 1) * BLOB_CHUNK_BYTES));
		const c = encodeBlobChunk({ hash, index: i, total, totalSize: input.content.length, chunk });
		out.push(await seal(ctx, xs, "blobChunk", input.authorNsSeq, 0, c, c, "pending", null, input.nowMs));
	}
	// The ref waits for the last chunk (released when no own x: frame remains, DESIGN §e.1). An explicit
	// ns-create / adoptable dependency takes precedence; it is re-pointed to the chunk when released.
	const dep = input.dependsOn ?? out[out.length - 1]!.clientFrameId;
	out.push(await seal(ctx, input.stream, "bodyUpdateRef", input.authorNsSeq, input.flags, refContent, input.content, "held", dep, input.nowMs));
	return out;
}

/**
 * T_adopt record (DESIGN §d.5): another device's provisional update re-sealed
 * under a fresh own clientFrameId (own AAD), flag `adopted`, state adoptable.
 */
export async function buildAdoptFrame(
	ctx: FrameCtx, stream: StreamName, kind: EnvelopeKind, authorNsSeq: Seq, flags: number, content: Uint8Array,
	adoptOf: { readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly receivedAtMs: number }, nowMs: number,
): Promise<NewOutboxFrame> {
	const clientFrameId = newClientFrameId(ctx.random);
	const f = flags | EnvelopeFlag.adopted;
	const s = await sealFrame(ctx.crypto, ctx.vaultId, stream, clientFrameId, kind, authorNsSeq, f, content);
	return {
		clientFrameId, stream, kind, state: "adoptable", sealed: s.sealed, content, authorNsSeq, flags: s.flags & ~EnvelopeFlag.deflate,
		dependsOn: null, adoptOf, createdAtMs: nowMs,
	};
}

export async function buildNsFrame(ctx: FrameCtx, stream: StreamName, ops: readonly NsOp[], authorNsSeq: Seq, nowMs: number): Promise<NewOutboxFrame> {
	const content = encodeNsOps(ops);
	return seal(ctx, stream, "nsOps", authorNsSeq, 0, content, content, "pending", null, nowMs);
}

export async function buildCfgFrame(ctx: FrameCtx, stream: StreamName, ops: readonly CfgOp[], authorNsSeq: Seq, nowMs: number): Promise<NewOutboxFrame> {
	const content = encodeCfgOps(ops);
	return seal(ctx, stream, "cfgOps", authorNsSeq, 0, content, content, "pending", null, nowMs);
}

/** One x:<hash> blobChunk frame (pending, no dependency). */
export async function buildBlobChunkFrame(ctx: FrameCtx, chunk: BlobChunkContent, authorNsSeq: Seq, nowMs: number): Promise<NewOutboxFrame> {
	const content = encodeBlobChunk(chunk);
	return seal(ctx, blobChunkStream(chunk.hash), "blobChunk", authorNsSeq, 0, content, content, "pending", null, nowMs);
}

/** Split text into <= max UTF-16 unit chunks without cutting a surrogate pair. */
export function splitInitialText(text: string, max = INITIAL_INSERT_CHUNK_CHARS): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		let end = Math.min(text.length, i + max);
		if (end < text.length) {
			const c = text.charCodeAt(end - 1);
			if (c >= 0xd800 && c <= 0xdbff) end--;
		}
		out.push(text.slice(i, end));
		i = end;
	}
	return out;
}

/**
 * Insert the initial text into `doc` (Y.Text "text") in chunked transactions
 * and return one update per chunk, captured from the transactions themselves.
 */
export function initialTextUpdates(doc: Y.Doc, text: string, max = INITIAL_INSERT_CHUNK_CHARS): Uint8Array[] {
	const ytext = doc.getText("text");
	const updates: Uint8Array[] = [];
	const listener = (u: Uint8Array, origin: unknown) => {
		if (origin === ORIGIN.INITIAL) updates.push(u);
	};
	doc.on("update", listener);
	try {
		for (const chunk of splitInitialText(text, max)) {
			doc.transact(() => ytext.insert(ytext.length, chunk), ORIGIN.INITIAL);
		}
	} finally {
		doc.off("update", listener);
	}
	return updates;
}
