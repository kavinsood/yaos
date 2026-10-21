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
 * absent and the create is not folded yet (in the outbox, or receipted with
 * its row not folded), and is deleted when the create folded without its doc
 * (the fold ignored the frame: replay-stale, duplicate-frame, stale-epoch).
 * A live create's body frames (pending / sent, dependsOn = the create,
 * DESIGN §e.1) are deleted once their create folded
 * merged away; the ones the relay already committed are junk rows on the
 * loser's stream, which nobody materializes (§d.4). Otherwise they stay
 * pending, like released held frames.
 */

import { CheckpointEncoding } from "../../core/envelope";
import { FOLD_RULES_VERSION } from "../../core/limits";
import { decodeNsFoldV1, encodeNsFoldV1 } from "../../core/codec/nsFoldV1";
import { decodeNsOps } from "../../core/codec/nsOps";
import { NS_CANDIDATE_INTERVAL } from "../../core/ns/candidate";
import { DEFAULT_NS_FOLD_RULES, buildIndex, foldNsFrameWith, newNsFoldState, nsFoldHalted, type NsFoldRules } from "../../core/ns/fold";
import { overlayPending, type NsOverlay, type PendingNsFrame } from "../../core/ns/overlay";
import { pathKey } from "../../core/paths/pathKey";
import {
	NS_STREAM, streamClass, streamDocId,
	type ClientFrameId, type DeviceId, type DocId, type DocKind, type NsEntry, type NsFoldEvent, type NsFoldIndex, type NsFoldState, type NsOp, type ReplayWindow, type Seq, type VaultPath,
} from "../../core/types";
import type { OutboxChange } from "../store/repo";
import type { SnapshotRecord, TailRecord } from "../store/schema";
import type { OutboxCache } from "../runtime/outboxCache";
import { FoldRuntime, type FoldCandidate, type FoldedFrame, type FoldRepo } from "./foldRuntime";

export { LOCAL_FLAG_STALE_EPOCH, LOCAL_FLAG_UNOPENED } from "./foldRuntime";
/** An ns row s is a checkpoint candidate iff floor(s / M) > floor(prev / M) (core/ns/candidate, §d.9). */
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
	state: NsFoldState = newNsFoldState();
	index: NsFoldIndex = buildIndex(this.state);

	/** knownRulesVersion: the highest fold rules this reader implements (tests raise it: an upgraded client). */
	private readonly rules: NsFoldRules;

	constructor(repo: FoldRepo, self: DeviceId, candidateModulus = NS_CANDIDATE_MODULUS, knownRulesVersion = FOLD_RULES_VERSION) {
		super(repo, self, NS_STREAM, candidateModulus);
		this.rules = knownRulesVersion === DEFAULT_NS_FOLD_RULES.knownRulesVersion ? DEFAULT_NS_FOLD_RULES : { ...DEFAULT_NS_FOLD_RULES, knownRulesVersion };
	}

	get coversSeq(): Seq {
		return this.state.coversSeq;
	}

	/** The state's own version (upgradeRules moves it), not this build's FOLD_RULES_VERSION: header = state (§b.5 V2). */
	get rulesVersion(): number {
		return this.state.foldRulesVersion;
	}

	protected reset(snap: SnapshotRecord | undefined): boolean {
		const st = snap && snap.encoding === CheckpointEncoding.nsFoldV1 && snap.bytes.length > 0 ? decodeNsFoldV1(snap.bytes) : null;
		this.state = st ?? newNsFoldState();
		this.index = buildIndex(this.state);
		return !snap || st !== null;
	}

	protected decodeOps(content: Uint8Array): NsOp[] | null {
		return decodeNsOps(content);
	}

	protected foldFrame(row: TailRecord, ops: readonly NsOp[]): { events: readonly NsFoldEvent[]; halted: boolean } {
		const events = foldNsFrameWith(this.rules, this.state, this.index, { seq: row.seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId, authorNsSeq: row.authorNsSeq, frameNo: row.frameNo ?? 0, ops });
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

	protected ownRecentFrames(): readonly ClientFrameId[] {
		return this.state.recentFrames.get(this.self) ?? [];
	}

	protected windowOf(deviceId: DeviceId): ReplayWindow | undefined {
		return this.state.replay.get(deviceId);
	}

	protected ringOf(deviceId: DeviceId): readonly ClientFrameId[] {
		return this.state.recentFrames.get(deviceId) ?? [];
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
		return { ...overlayPending(this.state, this.index, this.self, pending, this.rules), pending };
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
			if (!r.dependsOn) continue;
			// Only an ns create holds a frame. A store from before adoptables stopped holding (DESIGN §d.5) can still
			// have frames held behind an adopted record: they count as dependency-gone.
			const dep = outbox.get(r.dependsOn);
			if (dep && dep.adoptOf === null) continue;
			const held = r.state === "held";
			if (!held && r.state !== "pending") continue;
			const cls = streamClass(r.stream);
			const docId = cls === "body" || cls === "canvas" ? streamDocId(r.stream) : null;
			if (!docId) {
				if (held) changes.push({ t: "release", clientFrameId: r.clientFrameId });
				continue;
			}
			const e = this.state.entries.get(docId);
			if (!e) {
				// Create not folded yet (or still stale): wait. Folded without the doc (the fold ignored or refused the
				// frame): the doc never exists, so its frames are junk.
				if (!dep && !this.committedPending(r.dependsOn) && !this.halted) changes.push({ t: "delete", clientFrameId: r.clientFrameId });
				continue;
			}
			if (e.state === "merged") {
				changes.push({ t: "delete", clientFrameId: r.clientFrameId });
				continue;
			}
			if (!held) continue; // a live create's body frame (DESIGN §e.1): already pending
			changes.push({ t: "release", clientFrameId: r.clientFrameId });
		}
		return changes;
	}
}
