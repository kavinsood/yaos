/**
 * The ingest gate, stages 1-2 (DESIGN §d.6). Pure CPU work, run BEFORE any
 * transaction. Stage 3 (causal hole, post-apply size) runs at apply time in
 * body/handles.ts; stage 4 (apply or quarantine) is the caller's.
 *
 * Every committed row, read row, checkpoint, provisional and resolved ref
 * passes through gate().
 */

import { CheckpointEncoding, type BodyUpdateRefContent, type CheckpointContent, type InnerEnvelope } from "../../core/envelope";
import { FOLD_RULES_VERSION, MAX_DOC_TEXT_CHARS, MAX_FRAME_CONTENT_BYTES } from "../../core/limits";
import type { CfgFoldState, CfgOp, ClientFrameId, DeviceId, NsFoldState, NsOp, Seq, StreamName, VaultId } from "../../core/types";
import { streamClass } from "../../core/types";
import type { CryptoPort } from "../../ports/crypto";
import type { QuarantineReason } from "../store/schema";
import { decodeCfgOps } from "../../core/codec/cfgOps";
import { decodeCfgFoldV1, encodeCfgFoldV1 } from "../../core/codec/cfgFoldV1";
import { decodeBodyUpdateRef, decodeCheckpointContent } from "../../core/codec/contents";
import { bytesEqual } from "../../core/codec/lib0";
import { decodeNsFoldV1, encodeNsFoldV1 } from "../../core/codec/nsFoldV1";
import { decodeNsOps } from "../../core/codec/nsOps";
import { CFG_FOLD_RULES_VERSION } from "../../core/cfg/fold";
import { isReaderDependent, openEnvelope } from "./envelope";
import { checkYjsUpdate } from "./yjsCheck";

export interface GateCtx {
	readonly crypto: CryptoPort;
	readonly vaultId: VaultId;
	/** Checkpoint state bound (relay maxCheckpointBytes, inflated states may be larger). */
	readonly maxCheckpointStateBytes: number;
}

export type GateSubject =
	| { readonly t: "row"; readonly stream: StreamName; readonly seq: Seq; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly payload: Uint8Array }
	| { readonly t: "provisional"; readonly stream: StreamName; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly payload: Uint8Array }
	| { readonly t: "checkpoint"; readonly stream: StreamName; readonly coversSeq: Seq; readonly payload: Uint8Array };

export type GatePass =
	| { readonly ok: true; readonly t: "ignored" }
	/** ops = null: deterministic malformation, folds as an empty frame (§c.3). */
	| { readonly ok: true; readonly t: "ns"; readonly inner: InnerEnvelope; readonly ops: readonly NsOp[] | null; readonly detail: string | null }
	/** ops = null: deterministic malformation, folds as an empty frame (§c.11). */
	| { readonly ok: true; readonly t: "cfg"; readonly inner: InnerEnvelope; readonly ops: readonly CfgOp[] | null }
	| { readonly ok: true; readonly t: "body"; readonly inner: InnerEnvelope; readonly update: Uint8Array; readonly insertedChars: number }
	| { readonly ok: true; readonly t: "bodyRef"; readonly inner: InnerEnvelope; readonly ref: BodyUpdateRefContent }
	| { readonly ok: true; readonly t: "blobchunk"; readonly inner: InnerEnvelope }
	| {
		readonly ok: true; readonly t: "checkpoint"; readonly inner: InnerEnvelope; readonly checkpoint: CheckpointContent;
		readonly nsState: NsFoldState | null; readonly cfgState: CfgFoldState | null;
	};

export interface GateFail {
	readonly ok: false;
	readonly reason: QuarantineReason;
	readonly detail: string;
	/** Depends on this reader's version/keys: ns/cfg halt, bodies quarantine (retried on upgrade). */
	readonly readerDependent: boolean;
}

export type GateResult = GatePass | GateFail;

const fail = (reason: QuarantineReason, detail: string, readerDependent = false): GateFail => ({ ok: false, reason, detail, readerDependent });

export async function gate(ctx: GateCtx, subject: GateSubject): Promise<GateResult> {
	const cls = streamClass(subject.stream);
	if (cls === "other") return { ok: true, t: "ignored" };
	const binding = subject.t === "checkpoint"
		? { t: "checkpoint" as const, stream: subject.stream, coversSeq: subject.coversSeq }
		: { t: "frame" as const, stream: subject.stream, clientFrameId: subject.clientFrameId };
	const opened = await openEnvelope(ctx.crypto, ctx.vaultId, binding, subject.payload);
	if (!opened.ok) {
		const rd = isReaderDependent(opened.reason);
		const reason: QuarantineReason =
			opened.reason === "malformed" ? "envelope-malformed"
				: opened.reason === "unsupported-version" ? "envelope-version"
					: opened.reason === "unknown-key" || opened.reason === "unsupported-suite" ? "crypto-unknown-key"
						: opened.reason === "auth-failed" ? "crypto-auth" : "kind-not-allowed";
		return fail(reason, opened.reason, rd);
	}
	const inner = opened.inner;
	if (subject.t === "checkpoint") return gateCheckpoint(ctx, cls, subject.coversSeq, inner);
	if (inner.content.length > MAX_FRAME_CONTENT_BYTES) return fail("oversize", `content ${inner.content.length}`);
	switch (cls) {
		case "ns": {
			const ops = decodeNsOps(inner.content);
			return { ok: true, t: "ns", inner, ops, detail: ops ? null : "nsOps decode" };
		}
		case "cfg":
			return { ok: true, t: "cfg", inner, ops: decodeCfgOps(inner.content) };
		case "body":
		case "canvas": {
			if (inner.kind === "bodyUpdateRef") {
				const ref = decodeBodyUpdateRef(inner.content);
				return ref ? { ok: true, t: "bodyRef", inner, ref } : fail("decode-failed", "bodyUpdateRef");
			}
			const r = checkYjsUpdate(inner.content, cls, { maxBytes: MAX_FRAME_CONTENT_BYTES, maxChars: MAX_DOC_TEXT_CHARS });
			if (!r.ok) return fail(r.reason, r.detail);
			return { ok: true, t: "body", inner, update: inner.content, insertedChars: r.insertedChars };
		}
		case "blobchunk":
			return { ok: true, t: "blobchunk", inner };
	}
}

async function gateCheckpoint(ctx: GateCtx, cls: "ns" | "cfg" | "body" | "canvas" | "blobchunk", coversSeq: Seq, inner: InnerEnvelope): Promise<GateResult> {
	const ck = decodeCheckpointContent(inner.content);
	if (!ck) return fail("decode-failed", "checkpoint content");
	if (ck.coversSeq !== coversSeq) return fail("checkpoint-mismatch", `inner ${ck.coversSeq} != relay ${coversSeq}`);
	if (ck.state.length > ctx.maxCheckpointStateBytes) return fail("oversize", `checkpoint state ${ck.state.length}`);
	if (ck.encoding === CheckpointEncoding.retired) return { ok: true, t: "checkpoint", inner, checkpoint: ck, nsState: null, cfgState: null };
	switch (cls) {
		case "body":
		case "canvas": {
			if (ck.encoding !== CheckpointEncoding.yjsStateV1) return fail("kind-not-allowed", `encoding ${ck.encoding}`);
			const r = checkYjsUpdate(ck.state, cls, { maxBytes: ctx.maxCheckpointStateBytes, maxChars: MAX_DOC_TEXT_CHARS });
			if (!r.ok) return fail(r.reason, `checkpoint: ${r.detail}`);
			return { ok: true, t: "checkpoint", inner, checkpoint: ck, nsState: null, cfgState: null };
		}
		case "ns": {
			if (ck.encoding !== CheckpointEncoding.nsFoldV1) return fail("kind-not-allowed", `encoding ${ck.encoding}`);
			if (ck.foldRulesVersion > FOLD_RULES_VERSION) return fail("envelope-version", `foldRulesVersion ${ck.foldRulesVersion}`, true);
			const st = decodeNsFoldV1(ck.state);
			if (!st) return fail("decode-failed", "nsFoldV1");
			// V1 canonical form; V2 subset: coversSeq binding.
			if (!bytesEqual(encodeNsFoldV1(st), ck.state)) return fail("decode-failed", "nsFoldV1 not canonical");
			if (st.coversSeq !== coversSeq) return fail("checkpoint-mismatch", "nsFoldV1 coversSeq");
			return { ok: true, t: "checkpoint", inner, checkpoint: ck, nsState: st, cfgState: null };
		}
		case "cfg": {
			if (ck.encoding !== CheckpointEncoding.cfgFoldV1) return fail("kind-not-allowed", `encoding ${ck.encoding}`);
			if (ck.foldRulesVersion > CFG_FOLD_RULES_VERSION) return fail("envelope-version", `cfg foldRulesVersion ${ck.foldRulesVersion}`, true);
			const st = decodeCfgFoldV1(ck.state);
			if (!st) return fail("decode-failed", "cfgFoldV1");
			if (!bytesEqual(encodeCfgFoldV1(st), ck.state)) return fail("decode-failed", "cfgFoldV1 not canonical");
			if (st.coversSeq !== coversSeq) return fail("checkpoint-mismatch", "cfgFoldV1 coversSeq");
			return { ok: true, t: "checkpoint", inner, checkpoint: ck, nsState: null, cfgState: st };
		}
		case "blobchunk":
			return fail("kind-not-allowed", "blobchunk checkpoint must be retired");
	}
}
