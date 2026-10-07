/**
 * Sealing own frames into outbox records (DESIGN §d.4 steps 2-4, §b.6, §j.1).
 *
 *  - body/canvas content > MAX_INLINE_UPDATE_BYTES (raw, the size the gate
 *    checks) becomes a bodyUpdateRef: the update goes to the BlobPort, sealed
 *    at CryptoPort.blobAddress(sha256) (e2ee-design §10.1), and only the
 *    small ref (plaintext sha256 + size) rides the log. A failed PUT still
 *    emits the ref: BlobTouch (R3) re-PUTs it from the record's content and
 *    holds the frame until the store has it. Without a store, or above its
 *    cap, FrameTooLargeError: the doc freezes oversize-local (docRuntime).
 *    Blob bytes never ride the relay's sequence log.
 *  - The outbox record of a ref keeps the full update as `content` (the local
 *    doc re-applies it at load); the sealed payload carries the ref.
 *  - Initial content is inserted in INITIAL_INSERT_CHUNK_CHARS transactions,
 *    one frame each, flag `initial`.
 */

import * as Y from "yjs";
import { EnvelopeFlag, type EnvelopeKind } from "../../core/envelope";
import { INITIAL_INSERT_CHUNK_CHARS, MAX_INLINE_UPDATE_BYTES } from "../../core/limits";
import { streamClass, type CfgOp, type ClientFrameId, type ContentHash, type DeviceId, type NsOp, type Seq, type StreamName, type VaultId } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { CryptoPort, HashPort } from "../../ports/crypto";
import type { RandomPort } from "../../ports/random";
import { putSealed, storePlaintextCap, type PutPolicy } from "../blobs/blobStore";
import { sealFrame } from "../ingest/envelope";
import type { NewOutboxFrame } from "../store/repo";
import { encodeCfgOps } from "../../core/codec/cfgOps";
import { encodeBodyUpdateRef } from "../../core/codec/contents";
import { newClientFrameId } from "../../core/codec/ids";
import { bytesToHex } from "../../core/codec/lib0";
import { encodeNsOps } from "../../core/codec/nsOps";
import { encodeSnapOps, type SnapOp } from "../../core/snap/record";
import { ORIGIN } from "./yjsCounters";

export interface FrameCtx {
	readonly vaultId: VaultId;
	/** This device: the AAD binds every own frame to it (e2ee-design §7.1). */
	readonly self: DeviceId;
	readonly crypto: CryptoPort;
	readonly hash: HashPort;
	readonly random: RandomPort;
	readonly blob: BlobPort | null;
	/** When a present blob may be re-used (e2ee-design §10.4 R2). */
	readonly touch: PutPolicy;
}

export class FrameTooLargeError extends Error {
	constructor(readonly bytes: number) {
		super(`update of ${bytes} bytes needs the blob store (none, or above its limit)`);
	}
}

/** frameNo is ≥ 1 for nsOps / cfgOps (allocated by the caller, e2ee-design §8.2) and 0 for every other kind. */
async function seal(ctx: FrameCtx, stream: StreamName, kind: EnvelopeKind, authorNsSeq: Seq, flags: number, frameNo: number, sealedContent: Uint8Array, localContent: Uint8Array, state: "pending" | "held", dependsOn: ClientFrameId | null, nowMs: number): Promise<NewOutboxFrame> {
	const clientFrameId = newClientFrameId(ctx.random);
	const s = await sealFrame(ctx.crypto, ctx.vaultId, { stream, deviceId: ctx.self, clientFrameId, kind, authorNsSeq, flags, frameNo, content: sealedContent });
	return {
		clientFrameId, stream, kind, state, sealed: s.sealed, content: localContent, authorNsSeq, flags: s.flags & ~EnvelopeFlag.deflate,
		frameNo: frameNo === 0 ? null : frameNo, keyEpoch: s.keyEpoch, dependsOn, adoptOf: null, createdAtMs: nowMs,
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

/** One body/canvas update -> 1 frame: inline, or (oversize) a bodyUpdateRef after a blob put; FrameTooLargeError without a store. */
export async function buildBodyFrames(ctx: FrameCtx, input: BodyFrameInput): Promise<NewOutboxFrame[]> {
	const cls = streamClass(input.stream);
	const kind: EnvelopeKind = cls === "canvas" ? "canvasUpdate" : "bodyUpdate";
	const state = input.dependsOn ? "held" : "pending";
	if (input.content.length <= MAX_INLINE_UPDATE_BYTES) {
		return [await seal(ctx, input.stream, kind, input.authorNsSeq, input.flags, 0, input.content, input.content, state, input.dependsOn, input.nowMs)];
	}
	if (!ctx.blob || input.content.length > storePlaintextCap(ctx.crypto, ctx.blob)) throw new FrameTooLargeError(input.content.length);
	const hash = bytesToHex(await ctx.hash.sha256(input.content)) as ContentHash;
	const refContent = encodeBodyUpdateRef({ hash, size: input.content.length });
	try {
		await putSealed(ctx.blob, ctx.crypto, hash, input.content, ctx.touch);
	} catch {
		// Store error: the sender's R3 gate (BlobTouch.ready) re-PUTs from the record's content before it sends the ref.
	}
	return [await seal(ctx, input.stream, "bodyUpdateRef", input.authorNsSeq, input.flags, 0, refContent, input.content, state, input.dependsOn, input.nowMs)];
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
	const s = await sealFrame(ctx.crypto, ctx.vaultId, { stream, deviceId: ctx.self, clientFrameId, kind, authorNsSeq, flags: f, frameNo: 0, content });
	return {
		clientFrameId, stream, kind, state: "adoptable", sealed: s.sealed, content, authorNsSeq, flags: s.flags & ~EnvelopeFlag.deflate,
		frameNo: null, keyEpoch: s.keyEpoch, dependsOn: null, adoptOf, createdAtMs: nowMs,
	};
}

export async function buildNsFrame(ctx: FrameCtx, stream: StreamName, ops: readonly NsOp[], authorNsSeq: Seq, frameNo: number, nowMs: number): Promise<NewOutboxFrame> {
	const content = encodeNsOps(ops);
	return seal(ctx, stream, "nsOps", authorNsSeq, 0, frameNo, content, content, "pending", null, nowMs);
}

export async function buildCfgFrame(ctx: FrameCtx, stream: StreamName, ops: readonly CfgOp[], authorNsSeq: Seq, frameNo: number, nowMs: number): Promise<NewOutboxFrame> {
	const content = encodeCfgOps(ops);
	return seal(ctx, stream, "cfgOps", authorNsSeq, 0, frameNo, content, content, "pending", null, nowMs);
}

/** One snap-index frame (DESIGN §j.4): small records only, never a ref; frameNo 0 (no replay window, e2ee-design §8.2). */
export async function buildSnapFrame(ctx: FrameCtx, stream: StreamName, ops: readonly SnapOp[], authorNsSeq: Seq, nowMs: number): Promise<NewOutboxFrame> {
	const content = encodeSnapOps(ops);
	return seal(ctx, stream, "snapOps", authorNsSeq, 0, 0, content, content, "pending", null, nowMs);
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
