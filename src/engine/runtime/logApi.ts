/**
 * ns / cfg / body-info surface of the LogEngine (DESIGN §c.13, §c.11, §f.1).
 * Functions over EngineCtx; LogEngine delegates.
 *
 * submitNs / submitCfg: ops are split into frames (<= MAX_NS_OPS_PER_FRAME
 * ops, <= MAX_FRAME_CONTENT_BYTES encoded), sealed and put in the outbox in
 * one T_edit on the edit chain; they resolve once the records are committed,
 * so the optimistic views already include them.
 */

import { cloneCfgFold } from "../../core/cfg/fold";
import { cloneSnapFold, type SnapFoldState } from "../../core/snap/fold";
import { SNAP_MAX_OPS, type SnapOp } from "../../core/snap/record";
import { encodeCfgOps } from "../../core/codec/cfgOps";
import { encodeNsOps } from "../../core/codec/nsOps";
import { MAX_FRAME_CONTENT_BYTES, MAX_NS_OPS_PER_FRAME } from "../../core/limits";
import type { PendingNsFrame } from "../../core/ns/overlay";
import {
	CFG_STREAM, NS_STREAM, SNAP_STREAM, docStream, streamClass, streamDocId,
	type CfgFoldState, type CfgOp, type ClientFrameId, type DocId, type DocKind, type NsFoldIndex, type NsFoldState, type NsOp, type RemoteBodyInfo, type Seq,
} from "../../core/types";
import { buildCfgFrame, buildNsFrame, buildSnapFrame } from "../body/frames";
import type { NewOutboxFrame } from "../store/repo";
import type { FoldHalt } from "../sync/foldRuntime";
import type { EngineCtx } from "./context";

/** Optimistic namespace view (§f.1): committed fold + own pending ns frames. */
export interface NsView {
	/** Overlaid state / index (a copy; the committed fold is not exposed mutable). */
	readonly state: NsFoldState;
	readonly index: NsFoldIndex;
	/** Committed fold coversSeq. */
	readonly coversSeq: Seq;
	/** ns stream caught up (not stale) and the fold has every applied row. */
	readonly caughtUp: boolean;
	/** Committed fold halted (reader-dependent row or rules-version): phase upgrade-required. */
	readonly halted: FoldHalt | null;
	/** A pending own frame would halt the overlay. */
	readonly overlayHalted: boolean;
	/** Own frames not in the committed fold, in order (receipted-unfolded first, then the outbox). */
	readonly pending: readonly PendingNsFrame[];
	/** docIds targeted by an op of a pending frame (RemoteEntry.pendingLocal). */
	readonly pendingDocs: ReadonlySet<DocId>;
}

/** Split ops into frames: at most MAX_NS_OPS_PER_FRAME ops and MAX_FRAME_CONTENT_BYTES encoded each. */
export function chunkOps<T>(ops: readonly T[], encode: (ops: readonly T[]) => Uint8Array): T[][] {
	const out: T[][] = [];
	const fit = (part: T[]): void => {
		if (encode(part).length <= MAX_FRAME_CONTENT_BYTES) {
			out.push(part);
			return;
		}
		if (part.length === 1) throw new RangeError(`one op encodes to more than ${MAX_FRAME_CONTENT_BYTES} bytes`);
		const mid = Math.ceil(part.length / 2);
		fit(part.slice(0, mid));
		fit(part.slice(mid));
	};
	for (let i = 0; i < ops.length; i += MAX_NS_OPS_PER_FRAME) fit(ops.slice(i, i + MAX_NS_OPS_PER_FRAME));
	return out;
}

/** Extra frames committed in the same T_edit as the ns frames (createDoc's initial body frames). */
export type ExtraFrames = (nsFrames: readonly NewOutboxFrame[]) => Promise<readonly NewOutboxFrame[]>;

export async function submitNs(c: EngineCtx, ops: readonly NsOp[], extra?: ExtraFrames): Promise<ClientFrameId[]> {
	if (ops.length === 0) return [];
	const parts = chunkOps(ops, encodeNsOps);
	return c.docs.chain(async () => {
		const frames: NewOutboxFrame[] = [];
		for (const part of parts) frames.push(await buildNsFrame(c.deps, NS_STREAM, part, c.ns.coversSeq, c.now()));
		const more = extra ? await extra(frames) : [];
		c.addOutbox(await c.repo.tEdit([...frames, ...more], c.now()));
		frames.forEach((f, i) => {
			for (const op of parts[i]!) if (op.t === "create") c.pendingCreates.set(op.docId, f.clientFrameId);
		});
		return frames.map((f) => f.clientFrameId);
	});
}

export async function submitCfg(c: EngineCtx, ops: readonly CfgOp[]): Promise<ClientFrameId[]> {
	if (ops.length === 0) return [];
	const parts = chunkOps(ops, encodeCfgOps);
	return c.docs.chain(async () => {
		const frames: NewOutboxFrame[] = [];
		for (const part of parts) frames.push(await buildCfgFrame(c.deps, CFG_STREAM, part, c.ns.coversSeq, c.now()));
		c.addOutbox(await c.repo.tEdit(frames, c.now()));
		return frames.map((f) => f.clientFrameId);
	});
}

/** Own snap-index ops (DESIGN §j.4) -> frames of <= SNAP_MAX_OPS ops; resolves once committed (in snapView()). */
export async function submitSnap(c: EngineCtx, ops: readonly SnapOp[]): Promise<ClientFrameId[]> {
	if (ops.length === 0) return [];
	const parts: SnapOp[][] = [];
	for (let i = 0; i < ops.length; i += SNAP_MAX_OPS) parts.push(ops.slice(i, i + SNAP_MAX_OPS));
	return c.docs.chain(async () => {
		const frames: NewOutboxFrame[] = [];
		for (const part of parts) frames.push(await buildSnapFrame(c.deps, SNAP_STREAM, part, c.ns.coversSeq, c.now()));
		c.addOutbox(await c.repo.tEdit(frames, c.now()));
		return frames.map((f) => f.clientFrameId);
	});
}

/** Snapshot index: committed fold + own pending snap frames (a copy); `caughtUp` = stream read, not halted. */
export function snapView(c: EngineCtx): { readonly state: SnapFoldState; readonly caughtUp: boolean } {
	const v = c.snap.view(c.outbox);
	const rec = c.repo.stream(SNAP_STREAM);
	return { state: v === c.snap.state ? cloneSnapFold(v) : v, caughtUp: (!rec || !rec.stale) && c.snap.halted === null };
}

export function nsView(c: EngineCtx): NsView {
	const ov = c.ns.overlay(c.outbox);
	const pendingDocs = new Set<DocId>();
	for (const f of ov.pending) for (const op of f.ops) if ("docId" in op) pendingDocs.add(op.docId);
	const rec = c.repo.stream(NS_STREAM);
	const caughtUp = !rec || (!rec.stale && c.ns.halted === null);
	return { state: ov.state, index: ov.index, coversSeq: c.ns.coversSeq, caughtUp, halted: c.ns.halted, overlayHalted: ov.halted, pending: ov.pending, pendingDocs };
}

/** Committed cfg fold + own pending cfg frames (a copy). */
export function cfgView(c: EngineCtx): CfgFoldState {
	const v = c.cfg.view(c.outbox);
	return v === c.cfg.state ? cloneCfgFold(v) : v;
}

/** Kind of a doc in the optimistic view (committed entry first). */
export function docKind(c: EngineCtx, docId: DocId): DocKind | null {
	const e = c.ns.resolve(docId);
	if (e) return e.kind;
	for (const f of c.ns.pendingFrames(c.outbox)) for (const op of f.ops) if (op.t === "create" && op.docId === docId) return op.kind;
	return null;
}

/** Body info of a markdown / canvas doc (null: unknown doc or blob). */
export function bodyInfo(c: EngineCtx, docId: DocId, kind: DocKind | null = docKind(c, docId)): RemoteBodyInfo | null {
	if (kind === null) return null;
	const stream = docStream(kind, docId);
	if (!stream) return null;
	const rec = c.repo.stream(stream);
	if (!rec) {
		const own = c.outbox.ofStream(stream).length > 0;
		return { stream, version: { remoteSeq: 0, localOrder: 0 }, caughtUp: true, hasContent: own, frozen: false };
	}
	const hasContent = rec.remoteHeadSeq > 0 || rec.snapshotCoversSeq > 0 || rec.tailRows > 0 || rec.bodyVersion.localOrder > 0 || c.outbox.ofStream(stream).length > 0;
	return {
		stream,
		version: rec.bodyVersion,
		caughtUp: rec.appliedSeq >= rec.remoteHeadSeq && !c.docs.causalPending(stream),
		hasContent,
		frozen: rec.frozen === 1,
	};
}

/** Docs with own body / canvas records in the outbox (RemoteView.docsWithPendingBody). */
export function docsWithPendingBody(c: EngineCtx): Set<DocId> {
	const out = new Set<DocId>();
	for (const r of c.outbox.values()) {
		const cls = streamClass(r.stream);
		if (cls !== "body" && cls !== "canvas") continue;
		const d = streamDocId(r.stream);
		if (d) out.add(d);
	}
	return out;
}
