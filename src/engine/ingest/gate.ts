/**
 * The ingest gate, stages 1-2 (DESIGN §d.6). Pure CPU work, run BEFORE any
 * transaction. Stage 3 (causal hole, post-apply size) runs at apply time in
 * body/handles.ts; stage 4 (apply or quarantine) is the caller's.
 *
 * Every committed row, read row, checkpoint, provisional and resolved ref
 * passes through gate().
 */

import { CheckpointEncoding, type BodyUpdateRefContent, type CheckpointContent, type EnvelopeOpenFailure, type InnerEnvelope } from "../../core/envelope";
import { FOLD_RULES_VERSION, MAX_DOC_TEXT_CHARS, MAX_FRAME_CONTENT_BYTES } from "../../core/limits";
import type { CfgFoldState, CfgOp, ClientFrameId, DeviceId, NsFoldState, NsOp, Seq, StreamName, VaultId } from "../../core/types";
import { streamClass } from "../../core/types";
import type { CryptoPort } from "../../ports/crypto";
import type { QuarantineReason } from "../store/schema";
import { decodeCfgOps } from "../../core/codec/cfgOps";
import { decodeOuter } from "../../core/codec/envelope";
import { decodeCfgFoldV1, encodeCfgFoldV1 } from "../../core/codec/cfgFoldV1";
import { decodeBodyUpdateRef, decodeCheckpointContent } from "../../core/codec/contents";
import { bytesEqual } from "../../core/codec/lib0";
import { decodeNsFoldV1, encodeNsFoldV1 } from "../../core/codec/nsFoldV1";
import { decodeNsOps } from "../../core/codec/nsOps";
import { CFG_FOLD_RULES_VERSION } from "../../core/cfg/fold";
import { decodeSnapFoldV1, encodeSnapFoldV1 } from "../../core/codec/snapFoldV1";
import { SNAP_FOLD_RULES_VERSION, type SnapFoldState } from "../../core/snap/fold";
import { decodeSnapOps, type SnapOp } from "../../core/snap/record";
import { isReaderDependent, openEnvelope } from "./envelope";
import { checkYjsUpdate } from "./yjsCheck";

/**
 * e2ee-design §14.3 for a frame at `seq` (null: a provisional, not committed yet) or a checkpoint at coversSeq,
 * sealed under keyEpoch. "stale": below the winning revoke and past S_rot. "hold": not decidable by this reader
 * yet (a revoke it cannot settle, or `k` rows not judged yet); reader-dependent.
 */
export type StaleCheck = (keyEpoch: number, seq: Seq | null) => "stale" | "hold" | null;

export interface GateCtx {
	readonly crypto: CryptoPort;
	readonly vaultId: VaultId;
	/** Checkpoint state bound (relay maxCheckpointBytes, inflated states may be larger). */
	readonly maxCheckpointStateBytes: number;
	/** The keyring's answer (keyringRuntime.ts); suite 0 and unpinned answer null. */
	readonly staleCheck: StaleCheck;
}

export type GateSubject =
	| { readonly t: "row"; readonly stream: StreamName; readonly seq: Seq; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly payload: Uint8Array }
	| { readonly t: "provisional"; readonly stream: StreamName; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly payload: Uint8Array }
	| { readonly t: "checkpoint"; readonly stream: StreamName; readonly coversSeq: Seq; readonly payload: Uint8Array };

export type GatePass =
	| { readonly ok: true; readonly t: "ignored" }
	/** A committed frame below the winning revoke past S_rot (§14.3): ns/cfg fold it as empty, bodies ignore it. */
	| { readonly ok: true; readonly t: "stale"; readonly keyEpoch: number }
	/** ops = null: deterministic malformation, folds as an empty frame (§c.3). */
	| { readonly ok: true; readonly t: "ns"; readonly inner: InnerEnvelope; readonly ops: readonly NsOp[] | null; readonly detail: string | null }
	/** ops = null: deterministic malformation, folds as an empty frame (§c.11). */
	| { readonly ok: true; readonly t: "cfg"; readonly inner: InnerEnvelope; readonly ops: readonly CfgOp[] | null }
	/** ops = null: malformed (bounds, schema), folds as an empty frame (DESIGN §j.4). */
	| { readonly ok: true; readonly t: "snap"; readonly inner: InnerEnvelope; readonly ops: readonly SnapOp[] | null }
	| { readonly ok: true; readonly t: "body"; readonly inner: InnerEnvelope; readonly update: Uint8Array; readonly insertedChars: number }
	| { readonly ok: true; readonly t: "bodyRef"; readonly inner: InnerEnvelope; readonly ref: BodyUpdateRefContent }
	| {
		readonly ok: true; readonly t: "checkpoint"; readonly inner: InnerEnvelope; readonly checkpoint: CheckpointContent;
		readonly nsState: NsFoldState | null; readonly cfgState: CfgFoldState | null; readonly snapState?: SnapFoldState | null;
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

const QUARANTINE_REASON: Readonly<Record<EnvelopeOpenFailure, QuarantineReason>> = {
	"malformed": "envelope-malformed",
	"unsupported-version": "envelope-version",
	"unsupported-suite": "crypto-unknown-key",
	"unknown-key": "crypto-unknown-key",
	"auth-failed": "crypto-auth",
	"suite-downgrade": "crypto-downgrade",
	"bad-padding": "envelope-padding",
	"kind-stream-mismatch": "kind-not-allowed",
};

export async function gate(ctx: GateCtx, subject: GateSubject): Promise<GateResult> {
	const cls = streamClass(subject.stream);
	// keyring: k records carry no envelope (e2ee-design §11); WP-E3 reads them.
	if (cls === "other" || cls === "keyring") return { ok: true, t: "ignored" };
	const stale = staleVerdict(ctx, subject);
	if (stale) return stale;
	const binding = subject.t === "checkpoint"
		? { t: "checkpoint" as const, stream: subject.stream, coversSeq: subject.coversSeq }
		: { t: "frame" as const, stream: subject.stream, deviceId: subject.deviceId, clientFrameId: subject.clientFrameId };
	const opened = await openEnvelope(ctx.crypto, ctx.vaultId, binding, subject.payload);
	if (!opened.ok) {
		// auth-failed is reader-dependent only while the epoch's key is unverified (e2ee-design §9.2).
		const keyVerified = opened.header ? ctx.crypto.keyState(opened.header.keyEpoch).verified : false;
		return fail(QUARANTINE_REASON[opened.reason], opened.reason, isReaderDependent(opened.reason, keyVerified));
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
		case "snap":
			return { ok: true, t: "snap", inner, ops: decodeSnapOps(inner.content) };
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
	}
}

const IGNORED: GatePass = { ok: true, t: "ignored" };

/**
 * §14.3 before opening: the header's keyEpoch decides, so every reader agrees whether or not it holds that key.
 * A provisional is never adopted under either verdict (its committed row is judged when it lands).
 */
function staleVerdict(ctx: GateCtx, subject: GateSubject): GateResult | null {
	const outer = decodeOuter(subject.payload);
	if (!outer.ok || outer.header.keyEpoch === 0) return null;
	const e = outer.header.keyEpoch;
	const v = ctx.staleCheck(e, subject.t === "row" ? subject.seq : subject.t === "checkpoint" ? subject.coversSeq : null);
	if (v === null) return null;
	if (subject.t === "provisional") return IGNORED;
	if (v === "hold") return fail("keyring-hold", `keyEpoch ${e}`, true);
	return subject.t === "row" ? { ok: true, t: "stale", keyEpoch: e } : fail("stale-epoch", `keyEpoch ${e}`);
}

async function gateCheckpoint(ctx: GateCtx, cls: "ns" | "cfg" | "snap" | "body" | "canvas", coversSeq: Seq, inner: InnerEnvelope): Promise<GateResult> {
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
		case "snap": {
			if (ck.encoding !== CheckpointEncoding.snapFoldV1) return fail("kind-not-allowed", `encoding ${ck.encoding}`);
			if (ck.foldRulesVersion > SNAP_FOLD_RULES_VERSION) return fail("envelope-version", `snap foldRulesVersion ${ck.foldRulesVersion}`, true);
			const st = decodeSnapFoldV1(ck.state);
			if (!st) return fail("decode-failed", "snapFoldV1");
			if (!bytesEqual(encodeSnapFoldV1(st), ck.state)) return fail("decode-failed", "snapFoldV1 not canonical");
			if (st.coversSeq !== coversSeq) return fail("checkpoint-mismatch", "snapFoldV1 coversSeq");
			return { ok: true, t: "checkpoint", inner, checkpoint: ck, nsState: null, cfgState: null, snapState: st };
		}
	}
}
