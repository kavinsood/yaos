/**
 * Namespace runtime (DESIGN §c, §d.7 step 5, §e.1 dependsOn, §f.1 overlay).
 *
 * Committed state = nsFoldV1 snapshot + fold of ns tail rows (FoldRuntime).
 * The optimistic view (§f.1) folds own pending frames (outbox + receipted but
 * not yet folded) over a clone of the committed state.
 *
 * reconcileHeld() is state-based so it is crash-safe: a held record whose
 * dependency record is gone is released when the fold has its doc (live /
 * deleted), and waits while the doc is absent and the create is not folded yet
 * (in the outbox, or receipted with its row not folded), and is deleted when
 * the create folded without its doc (the fold ignored the frame: replay-stale,
 * duplicate-frame, stale-epoch). The frames of a doc merged away (held, or a
 * live create's pending body frames, dependsOn = the create, DESIGN §e.1) stay
 * as they are: they may hold own edits past the create no file holds (I1). The
 * held ones are never sent; the pending ones commit as junk rows on the loser's
 * stream, which nobody materializes (§d.4). They leave with the loser's stream
 * (retire drop, maintenance.ts), after the planner moved the disk side off it.
 */

import { CheckpointEncoding } from "../../core/envelope";
import { FOLD_RULES_VERSION } from "../../core/limits";
import { decodeNsFoldV1, encodeNsFoldV1 } from "../../core/codec/nsFoldV1";
import { decodeNsOps } from "../../core/codec/nsOps";
import { NS_CANDIDATE_INTERVAL } from "../../core/ns/candidate";
import { DEFAULT_NS_FOLD_RULES, buildIndex, foldNsFrameWith, newNsFoldState, nsFoldHalted, type NsFoldRules } from "../../core/ns/fold";
import { overlayPending, type NsOverlay, type PendingNsFrame } from "../../core/ns/overlay";
import { removedDeletes } from "../../core/ns/pruned";
import { pathKey } from "../../core/paths/pathKey";
import {
	NS_STREAM, streamClass, streamDocId,
	type ClientFrameId, type DeviceId, type DocId, type DocKind, type NsEntry, type NsFoldEvent, type NsFoldIndex, type NsFoldState, type NsOp, type ReplayWindow, type Seq, type VaultPath,
} from "../../core/types";
import type { OutboxChange } from "../store/repo";
import type { OutboxRecord, SnapshotRecord, TailRecord } from "../store/schema";
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
	/**
	 * Deleted entries the committed fold removed (DESIGN §c.9 "Pruned docs"), by docId: their delete base must
	 * outlive them. Set in the same step that removes the entry (a fold, or a reload past it), so no view sees the doc
	 * gone without its base; context.afterNsChange then keeps the base on the doc's stream record and drops it here.
	 */
	readonly removedDeletes = new Map<DocId, NsEntry>();

	/**
	 * The fold's tunables. knownRulesVersion: the highest fold rules this reader implements (tests raise it: an
	 * upgraded client); prune: the tombstone cap and hysteresis (EngineTuning.nsPrune; FOLD, the same on every device).
	 */
	readonly rules: NsFoldRules;

	constructor(
		repo: FoldRepo, self: DeviceId, candidateModulus = NS_CANDIDATE_MODULUS, knownRulesVersion = FOLD_RULES_VERSION,
		prune: Pick<NsFoldRules, "tombstoneCap" | "pruneHysteresis"> & { readonly prunedCap?: number } = DEFAULT_NS_FOLD_RULES,
	) {
		super(repo, self, NS_STREAM, candidateModulus);
		const d = DEFAULT_NS_FOLD_RULES;
		const prunedCap = prune.prunedCap ?? d.prunedCap;
		const same = knownRulesVersion === d.knownRulesVersion && prune.tombstoneCap === d.tombstoneCap && prune.pruneHysteresis === d.pruneHysteresis && prunedCap === d.prunedCap;
		this.rules = same ? d : { ...d, knownRulesVersion, tombstoneCap: prune.tombstoneCap, pruneHysteresis: prune.pruneHysteresis, prunedCap };
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
		const before = this.state.entries;
		this.state = st ?? newNsFoldState();
		this.index = buildIndex(this.state);
		// A checkpoint adopted past a prune skips its event: the deleted entries it lacks (none at an engine start).
		this.noteRemoved(removedDeletes([], before, this.state.entries));
		return !snap || st !== null;
	}

	private noteRemoved(entries: readonly NsEntry[]): void {
		for (const e of entries) this.removedDeletes.set(e.docId, e);
	}

	protected decodeOps(content: Uint8Array): NsOp[] | null {
		return decodeNsOps(content);
	}

	protected foldFrame(row: TailRecord, ops: readonly NsOp[]): { events: readonly NsFoldEvent[]; halted: boolean } {
		const events = foldNsFrameWith(this.rules, this.state, this.index, { seq: row.seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId, authorNsSeq: row.authorNsSeq, frameNo: row.frameNo ?? 0, ops });
		this.noteRemoved(removedDeletes(events, null, this.state.entries));
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

	/**
	 * Committed fold + own pending frames (§f.1). Memoized: the fold folds in place, so the key is the state, its
	 * coversSeq (every folded row moves it), the committed own frames and the stream's outbox records (put replaces
	 * a record object). Callers read the result only; a refold per call was O(entries) for each synced write.
	 */
	overlay(outbox: OutboxCache): NsOverlay & { readonly pending: readonly PendingNsFrame[] } {
		const recs = outbox.ofStream(this.stream);
		const m = this.ovMemo;
		if (m && m.state === this.state && m.index === this.index && m.coversSeq === this.state.coversSeq && m.ownGen === this.committedOwnGen && sameRecords(m.recs, recs)) return m.result;
		const pending = this.pendingFrames(outbox);
		const result = { ...overlayPending(this.state, this.index, this.self, pending, this.rules), pending };
		this.ovMemo = { state: this.state, index: this.index, coversSeq: this.state.coversSeq, ownGen: this.committedOwnGen, recs, result };
		return result;
	}

	private ovMemo: {
		readonly state: NsFoldState; readonly index: NsFoldIndex; readonly coversSeq: Seq; readonly ownGen: number;
		readonly recs: readonly OutboxRecord[]; readonly result: NsOverlay & { readonly pending: readonly PendingNsFrame[] };
	} | null = null;

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
			// Merged away: kept as they are (held ones never sent). They can carry own edits past the create that only
			// they hold (I1: typed into an editor bound to the loser, its save lost with the app). The planner writes
			// the loser's text to its file before the rebind, and the retire drop of the loser's stream deletes them
			// (maintenance.ts), once the disk side no longer tracks the doc.
			if (e.state === "merged") continue;
			if (!held) continue; // a live create's body frame (DESIGN §e.1): already pending
			changes.push({ t: "release", clientFrameId: r.clientFrameId });
		}
		return changes;
	}
}

function sameRecords(a: readonly OutboxRecord[], b: readonly OutboxRecord[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
