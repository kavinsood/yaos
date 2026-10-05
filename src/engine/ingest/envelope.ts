/**
 * Seal/open relay payloads through the CryptoPort (DESIGN §b.1, §d.6 stage 1).
 * Codec stand-in: ../sync/__standins__/envelopeCodec (WP-A at integration).
 */

import { ALLOWED_KINDS, CryptoSuite, ENVELOPE_FORMAT_VERSION, EnvelopeFlag, type EnvelopeKind, type EnvelopeOpenResult } from "../../core/envelope";
import type { ClientFrameId, Seq, StreamName, VaultId } from "../../core/types";
import { streamClass } from "../../core/types";
import type { CryptoPort } from "../../ports/crypto";
import { checkpointAad, decodeInner, decodeOuter, encodeInner, encodeOuter, frameAad } from "../sync/__standins__/envelopeCodec";

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
	const inner = encodeInner(kind, authorNsSeq, flags, content);
	const sealedInner = await crypto.seal({ aad: frameAad(vaultId, stream, clientFrameId), plaintext: inner.bytes });
	return { sealed: encodeOuter({ formatVersion: ENVELOPE_FORMAT_VERSION, suite: crypto.suite, keyEpoch: crypto.keyEpoch }, sealedInner), flags: inner.flags };
}

export async function sealCheckpoint(crypto: CryptoPort, vaultId: VaultId, stream: StreamName, coversSeq: Seq, content: Uint8Array, authorNsSeq: Seq): Promise<Uint8Array> {
	const inner = encodeInner("checkpoint", authorNsSeq, 0, content);
	const sealedInner = await crypto.seal({ aad: checkpointAad(vaultId, stream, coversSeq), plaintext: inner.bytes });
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
	let outer;
	try {
		outer = decodeOuter(payload);
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (outer.header.formatVersion !== ENVELOPE_FORMAT_VERSION) return { ok: false, reason: "unsupported-version" };
	if (outer.header.suite !== CryptoSuite.none && outer.header.suite !== CryptoSuite.xchacha20poly1305) return { ok: false, reason: "unsupported-suite" };
	const aad = binding.t === "frame" ? frameAad(vaultId, binding.stream, binding.clientFrameId) : checkpointAad(vaultId, binding.stream, binding.coversSeq);
	const opened = await crypto.open({ suite: outer.header.suite, keyEpoch: outer.header.keyEpoch, aad, sealed: outer.sealed });
	if (!opened.ok) return { ok: false, reason: opened.reason === "unknown-key" ? "unknown-key" : opened.reason === "auth-failed" ? "auth-failed" : "unsupported-suite" };
	let inner;
	try {
		inner = decodeInner(opened.plaintext);
	} catch {
		return { ok: false, reason: "malformed" };
	}
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
