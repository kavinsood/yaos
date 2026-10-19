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
import { decodeBodyUpdateRef, decodeCheckpointContent } from "../../core/codec/contents";
import { bytesEqual, Reader } from "../../core/codec/lib0";
import { decodeNsOps } from "../../core/codec/nsOps";
import { CFG_FOLD_RULES_VERSION } from "../../core/cfg/fold";
import { verifyCfgCheckpoint, type CfgVerifyResult } from "../../core/cfg/verify";
import { verifyNsCheckpoint, type NsVerifyResult } from "../../core/ns/verify";
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

/**
 * The highest fold rules version this reader implements, per fold (DESIGN §c.10). Production: the constants
 * (FOLD_RULES_VERSION, CFG_FOLD_RULES_VERSION, SNAP_FOLD_RULES_VERSION); tests raise them to stand in for an
 * upgraded client (EngineTuning.knownRules).
 */
export interface KnownRules {
	readonly ns: number;
	readonly cfg: number;
	readonly snap: number;
}

export const KNOWN_RULES: KnownRules = { ns: FOLD_RULES_VERSION, cfg: CFG_FOLD_RULES_VERSION, snap: SNAP_FOLD_RULES_VERSION };

export interface GateCtx {
	readonly crypto: CryptoPort;
	readonly vaultId: VaultId;
	/** Checkpoint state bound (relay maxCheckpointBytes, inflated states may be larger). */
	readonly maxCheckpointStateBytes: number;
	/** The keyring's answer (keyringRuntime.ts); suite 0 and unpinned answer null. */
	readonly staleCheck: StaleCheck;
	/** Default KNOWN_RULES. */
	readonly knownRules?: KnownRules;
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
	/** Depends on this reader's version/keys: ns/cfg/snap halt, bodies quarantine (retried on upgrade or new keys). */
	readonly readerDependent: boolean;
	/**
	 * Reader-dependent because the writer is newer: an envelope formatVersion or suite byte, a checkpoint encoding,
	 * a fold state formatVersion or a foldRulesVersion this reader does not implement. Only an upgrade opens it
	 * (phase upgrade-required); the other reader-dependent failures wait for keys or `k`.
	 */
	readonly newer: boolean;
}

export type GateResult = GatePass | GateFail;

const fail = (reason: QuarantineReason, detail: string, readerDependent = false, newer = false): GateFail => ({ ok: false, reason, detail, readerDependent, newer });
/** A newer writer (GateFail.newer). */
const newer = (detail: string): GateFail => fail("envelope-version", detail, true, true);

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
		// A formatVersion or a suite byte this build does not know (no header: decodeOuter refused it) is a newer
		// writer; a known suite this port cannot open is a missing key or pin.
		const isNewer = opened.reason === "unsupported-version" || (opened.reason === "unsupported-suite" && !opened.header);
		return fail(QUARANTINE_REASON[opened.reason], opened.reason, isReaderDependent(opened.reason, keyVerified), isNewer);
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

/**
 * A failed ns / cfg verify (core/ns/verify.ts, core/cfg/verify.ts) as a gate failure. Only a newer foldRulesVersion
 * depends on the reader (§c.10 upgrade-required: catchUp.ts halts the fold at the checkpoint); the rest is the
 * writer's fault (a disputed checkpoint: re-read the rows without it, or freeze the stream if they are gone).
 */
function verifyFail(what: string, v: Extract<NsVerifyResult | CfgVerifyResult, { ok: false }>): GateFail {
	switch (v.reason) {
		case "malformed":
		case "non-canonical": return fail("decode-failed", `${what}: ${v.detail}`);
		case "covers-seq": return fail("checkpoint-mismatch", `${what}: ${v.detail}`);
		case "upgrade-required": return newer(`${what}: ${v.detail}`);
		case "invariant":
		case "rules-version": return fail("checkpoint-invariant", `${what}: ${v.detail}`);
	}
}

/** Highest checkpoint encoding this build knows: a byte above it is a newer writer's, below it a bad one. */
const MAX_KNOWN_ENCODING = Math.max(...Object.values(CheckpointEncoding));

const ENCODING_OF: Readonly<Record<"ns" | "cfg" | "snap" | "body" | "canvas", CheckpointEncoding>> = {
	ns: CheckpointEncoding.nsFoldV1, cfg: CheckpointEncoding.cfgFoldV1, snap: CheckpointEncoding.snapFoldV1,
	body: CheckpointEncoding.yjsStateV1, canvas: CheckpointEncoding.yjsStateV1,
};

/** The leading varuint of a fold state (its formatVersion), or null when there is none. */
function leadingVersion(state: Uint8Array): number | null {
	try {
		return new Reader(state).varuint();
	} catch {
		return null;
	}
}

/**
 * Stage 1-2 for checkpoints. Newer-writer cases are checked before any decode, so a format this reader cannot
 * parse halts (upgrade-required) instead of looking corrupt: an encoding byte above the known ones, a fold state
 * formatVersion above 1, a foldRulesVersion above KnownRules.
 */
async function gateCheckpoint(ctx: GateCtx, cls: "ns" | "cfg" | "snap" | "body" | "canvas", coversSeq: Seq, inner: InnerEnvelope): Promise<GateResult> {
	const ck = decodeCheckpointContent(inner.content);
	if (!ck) {
		const enc = inner.content[0];
		return enc !== undefined && enc > MAX_KNOWN_ENCODING ? newer(`checkpoint encoding ${enc}`) : fail("decode-failed", "checkpoint content");
	}
	if (ck.coversSeq !== coversSeq) return fail("checkpoint-mismatch", `inner ${ck.coversSeq} != relay ${coversSeq}`);
	if (ck.state.length > ctx.maxCheckpointStateBytes) return fail("oversize", `checkpoint state ${ck.state.length}`);
	if (ck.encoding === CheckpointEncoding.retired) return { ok: true, t: "checkpoint", inner, checkpoint: ck, nsState: null, cfgState: null };
	if (ck.encoding !== ENCODING_OF[cls]) return fail("kind-not-allowed", `encoding ${ck.encoding}`);
	const known = ctx.knownRules ?? KNOWN_RULES;
	if (cls === "ns" || cls === "cfg" || cls === "snap") {
		const format = leadingVersion(ck.state);
		if (format !== null && format > 1) return newer(`${cls} state formatVersion ${format}`);
		if (ck.foldRulesVersion > known[cls]) return newer(`${cls} foldRulesVersion ${ck.foldRulesVersion}`);
	}
	switch (cls) {
		case "body":
		case "canvas": {
			const r = checkYjsUpdate(ck.state, cls, { maxBytes: ctx.maxCheckpointStateBytes, maxChars: MAX_DOC_TEXT_CHARS });
			if (!r.ok) return fail(r.reason, `checkpoint: ${r.detail}`);
			return { ok: true, t: "checkpoint", inner, checkpoint: ck, nsState: null, cfgState: null };
		}
		case "ns": {
			// V1 (canonical re-encode) + V2 (structural invariants, foldRulesVersion, coversSeq binding), §b.5.
			const v = verifyNsCheckpoint(ck, coversSeq, { knownRulesVersion: known.ns });
			if (!v.ok) return verifyFail("nsFoldV1", v);
			return { ok: true, t: "checkpoint", inner, checkpoint: ck, nsState: v.state, cfgState: null };
		}
		case "cfg": {
			// V1 + V2 as ns (§b.5 "Verification is V1 + V2").
			const v = verifyCfgCheckpoint(ck, coversSeq, known.cfg);
			if (!v.ok) return verifyFail("cfgFoldV1", v);
			return { ok: true, t: "checkpoint", inner, checkpoint: ck, nsState: null, cfgState: v.state };
		}
		case "snap": {
			const st = decodeSnapFoldV1(ck.state);
			if (!st) return fail("decode-failed", "snapFoldV1");
			if (!bytesEqual(encodeSnapFoldV1(st), ck.state)) return fail("decode-failed", "snapFoldV1 not canonical");
			if (st.coversSeq !== coversSeq) return fail("checkpoint-mismatch", "snapFoldV1 coversSeq");
			return { ok: true, t: "checkpoint", inner, checkpoint: ck, nsState: null, cfgState: null, snapState: st };
		}
	}
}
