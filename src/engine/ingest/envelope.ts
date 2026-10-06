/**
 * Seal/open relay payloads through the CryptoPort (DESIGN §b.1, §d.6 stage 1).
 * Codec: core/codec/envelope.ts. The engine stores flags without the deflate
 * bit (content is kept inflated), so the open result clears it.
 */

import { ALLOWED_KINDS, ENVELOPE_FORMAT_VERSION, EnvelopeFlag, type EnvelopeKind, type EnvelopeOpenResult } from "../../core/envelope";
import type { ClientFrameId, Seq, StreamName, VaultId } from "../../core/types";
import { streamClass } from "../../core/types";
import type { CryptoPort } from "../../ports/crypto";
import { checkpointAad, decodeInner, decodeOuter, encodeInner, encodeOuter, frameAad } from "../../core/codec/envelope";
import { Reader } from "../../core/codec/lib0";

/** Flags of an encoded inner envelope (kind u8, varuint authorNsSeq, varuint flags). */
function innerFlags(inner: Uint8Array): number {
	const r = new Reader(inner);
	r.u8();
	r.varuint();
	return r.varuint();
}

export interface SealedFrame {
	/** Exact relay payload. */
	readonly sealed: Uint8Array;
	/** Flags as sealed (deflate bit included when compressed). */
	readonly flags: number;
}

export async function sealFrame(
	crypto: CryptoPort, vaultId: VaultId, stream: StreamName, clientFrameId: ClientFrameId,
	kind: EnvelopeKind, authorNsSeq: Seq, flags: number, content: Uint8Array,
): Promise<SealedFrame> {
	const inner = encodeInner({ kind, authorNsSeq, flags, content });
	const sealedInner = await crypto.seal({ aad: frameAad(vaultId, stream, clientFrameId), plaintext: inner });
	return { sealed: encodeOuter({ formatVersion: ENVELOPE_FORMAT_VERSION, suite: crypto.suite, keyEpoch: crypto.keyEpoch }, sealedInner), flags: innerFlags(inner) };
}

export async function sealCheckpoint(crypto: CryptoPort, vaultId: VaultId, stream: StreamName, coversSeq: Seq, content: Uint8Array, authorNsSeq: Seq): Promise<Uint8Array> {
	const inner = encodeInner({ kind: "checkpoint", authorNsSeq, flags: 0, content });
	const sealedInner = await crypto.seal({ aad: checkpointAad(vaultId, stream, coversSeq), plaintext: inner });
	return encodeOuter({ formatVersion: ENVELOPE_FORMAT_VERSION, suite: crypto.suite, keyEpoch: crypto.keyEpoch }, sealedInner);
}

export type Binding =
	| { readonly t: "frame"; readonly stream: StreamName; readonly clientFrameId: ClientFrameId }
	| { readonly t: "checkpoint"; readonly stream: StreamName; readonly coversSeq: Seq };

/**
 * Stage 1: header, CryptoPort.open with the binding AAD, inner decode, kind
 * check. The returned inner content is inflated (deflate bit cleared).
 */
export async function openEnvelope(crypto: CryptoPort, vaultId: VaultId, binding: Binding, payload: Uint8Array): Promise<EnvelopeOpenResult> {
	const outer = decodeOuter(payload);
	if (!outer.ok) return outer;
	const aad = binding.t === "frame" ? frameAad(vaultId, binding.stream, binding.clientFrameId) : checkpointAad(vaultId, binding.stream, binding.coversSeq);
	const opened = await crypto.open({ suite: outer.header.suite, keyEpoch: outer.header.keyEpoch, aad, sealed: outer.sealed });
	if (!opened.ok) return { ok: false, reason: opened.reason === "unknown-key" ? "unknown-key" : opened.reason === "auth-failed" ? "auth-failed" : "unsupported-suite" };
	const dec = decodeInner(opened.plaintext);
	if (!dec.ok) return dec;
	const inner = dec.inner;
	const cls = streamClass(binding.stream);
	if (cls === "other") return { ok: false, reason: "kind-stream-mismatch" };
	const allowed = ALLOWED_KINDS[cls];
	if (!allowed.includes(inner.kind)) return { ok: false, reason: "kind-stream-mismatch" };
	if ((binding.t === "checkpoint") !== (inner.kind === "checkpoint")) return { ok: false, reason: "kind-stream-mismatch" };
	return { ok: true, header: outer.header, inner: { ...inner, flags: inner.flags & ~EnvelopeFlag.deflate } };
}

/** Reader-dependent failures (DESIGN §d.6): halt ns/cfg folds instead of folding as empty. */
export function isReaderDependent(reason: Exclude<EnvelopeOpenResult, { ok: true }>["reason"]): boolean {
	return reason === "unsupported-version" || reason === "unsupported-suite" || reason === "unknown-key" || reason === "auth-failed";
}
