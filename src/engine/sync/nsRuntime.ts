/**
 * Namespace runtime (DESIGN §c, §d.7 step 5, §e.1 dependsOn, §f.1 overlay).
 *
 * Committed state = nsFoldV1 snapshot + fold of ns tail rows (FoldRuntime).
 * The optimistic view (§f.1) folds own pending frames (outbox + receipted but
 * not yet folded) over a clone of the committed state.
 *
 * reconcileHeld() is state-based so it is crash-safe: a held record whose
 * dependency record is gone is released when the fold has its doc (live /
 * deleted), deleted when the doc was merged away, and waits while the doc is
 * absent (create not folded yet).
 */

import { CheckpointEncoding } from "../../core/envelope";
import { FOLD_RULES_VERSION } from "../../core/limits";
import { decodeNsFoldV1, encodeNsFoldV1 } from "../../core/codec/nsFoldV1";
import { decodeNsOps } from "../../core/codec/nsOps";
import { NS_CANDIDATE_INTERVAL } from "../../core/ns/candidate";
import { buildIndex, foldNsFrame, newNsFoldState, nsFoldHalted } from "../../core/ns/fold";
import { overlayPending, type NsOverlay, type PendingNsFrame } from "../../core/ns/overlay";
import { pathKey } from "../../core/paths/pathKey";
import {
	NS_STREAM, streamClass, streamDocId,
	type DeviceId, type DocId, type DocKind, type NsEntry, type NsFoldEvent, type NsFoldIndex, type NsFoldState, type NsOp, type Seq, type VaultPath,
} from "../../core/types";
import type { OutboxChange, Repo } from "../store/repo";
import type { SnapshotRecord, TailRecord } from "../store/schema";
import type { OutboxCache } from "../runtime/outboxCache";
import { FoldRuntime, type FoldCandidate, type FoldedFrame } from "./foldRuntime";

export { LOCAL_FLAG_STALE_EPOCH, LOCAL_FLAG_UNOPENED } from "./foldRuntime";
/** FOLD (V3): an ns row s is a candidate iff floor(s / M) > floor(prev / M) (core/ns/candidate). */
export const NS_CANDIDATE_MODULUS = NS_CANDIDATE_INTERVAL;

export type NsCandidate = FoldCandidate;
export type FoldedNsFrame = FoldedFrame<NsOp, NsFoldEvent>;

export interface DocInfo {
	readonly docId: DocId;
	readonly path: VaultPath;
	readonly kind: DocKind;
	readonly state: NsEntry["state"] | "pending";
	readonly aliasOf: DocId | null;
}

export class NsRuntime extends FoldRuntime<NsOp, NsFoldEvent> {
	readonly encoding = CheckpointEncoding.nsFoldV1;
	readonly rulesVersion = FOLD_RULES_VERSION;
	state: NsFoldState = newNsFoldState();
	index: NsFoldIndex = buildIndex(this.state);

	constructor(repo: Repo, self: DeviceId, candidateModulus = NS_CANDIDATE_MODULUS) {
		super(repo, self, NS_STREAM, candidateModulus);
	}

	get coversSeq(): Seq {
		return this.state.coversSeq;
	}

	protected reset(snap: SnapshotRecord | undefined): void {
		const st = snap && snap.encoding === CheckpointEncoding.nsFoldV1 && snap.bytes.length > 0 ? decodeNsFoldV1(snap.bytes) : null;
		this.state = st ?? newNsFoldState();
		this.index = buildIndex(this.state);
	}

	protected decodeOps(content: Uint8Array): NsOp[] | null {
		return decodeNsOps(content);
	}

	protected foldFrame(row: TailRecord, ops: readonly NsOp[]): { events: readonly NsFoldEvent[]; halted: boolean } {
		const events = foldNsFrame(this.state, this.index, { seq: row.seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId, authorNsSeq: row.authorNsSeq, frameNo: row.frameNo ?? 0, ops });
		return { events, halted: nsFoldHalted(events) };
	}

	protected foldStale(row: TailRecord): readonly NsFoldEvent[] {
		if (row.seq <= this.state.coversSeq) return [];
		this.state.coversSeq = row.seq;
		return [{ seq: row.seq, index: -1, deviceId: row.deviceId, clientFrameId: row.clientFrameId, docId: null, outcome: { kind: "ignored", reason: "stale-epoch" } }];
	}

	encodeState(): Uint8Array {
		return encodeNsFoldV1(this.state);
	}

	protected ownReplayEdge(): number {
		return this.state.replay.get(this.self)?.r ?? 0;
	}

	entry(docId: DocId): NsEntry | undefined {
		return this.state.entries.get(docId);
	}

	/** Alias-resolved entry. */
	resolve(docId: DocId): NsEntry | undefined {
		const e = this.state.entries.get(docId);
		if (e && e.state === "merged" && e.aliasOf) return this.state.entries.get(e.aliasOf);
		return e;
	}

	docAt(path: VaultPath): DocId | null {
		return this.index.byPathKey.get(pathKey(path)) ?? null;
	}

	/** Committed fold + own pending frames (§f.1). */
	overlay(outbox: OutboxCache): NsOverlay & { readonly pending: readonly PendingNsFrame[] } {
		const pending = this.pendingFrames(outbox);
		return { ...overlayPending(this.state, this.index, this.self, pending), pending };
	}

	/** Docs of the optimistic view; "pending" = not in the committed fold yet. */
	listDocs(outbox: OutboxCache): DocInfo[] {
		const ov = this.overlay(outbox);
		const out: DocInfo[] = [];
		for (const e of ov.state.entries.values()) {
			const committed = this.state.entries.has(e.docId);
			out.push({ docId: e.docId, path: e.path, kind: e.kind, state: committed ? e.state : "pending", aliasOf: e.aliasOf });
		}
		return out;
	}

	/** dependsOn rule for ns creates (DESIGN §e.1). */
	reconcileHeld(outbox: OutboxCache): OutboxChange[] {
		const changes: OutboxChange[] = [];
		for (const r of outbox.values()) {
			if (r.state !== "held" || !r.dependsOn || outbox.has(r.dependsOn)) continue;
			const cls = streamClass(r.stream);
			const docId = cls === "body" || cls === "canvas" ? streamDocId(r.stream) : null;
			if (!docId) {
				changes.push({ t: "release", clientFrameId: r.clientFrameId });
				continue;
			}
			const e = this.state.entries.get(docId);
			if (!e) continue; // create not folded yet (or still stale): wait
			if (e.state === "merged") {
				changes.push({ t: "delete", clientFrameId: r.clientFrameId });
				continue;
			}
			if (r.kind === "bodyUpdateRef") {
				const chunk = outbox.lastChunkBefore(r.order);
				if (chunk) {
					changes.push({ t: "repoint", clientFrameId: r.clientFrameId, dependsOn: chunk.clientFrameId });
					continue;
				}
			}
			changes.push({ t: "release", clientFrameId: r.clientFrameId });
		}
		return changes;
	}
}
