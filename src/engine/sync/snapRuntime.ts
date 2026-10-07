/**
 * snap runtime (DESIGN §j.4): the committed snapshot-index fold (snapFoldV1 snapshot + tail rows) and the
 * optimistic view with own pending snap frames. Same shape as CfgRuntime (FoldRuntime): no rules-version halt,
 * only reader-dependent rows halt. Unknown record versions fold as ignored ops (reported as diagnostics).
 */

import { CheckpointEncoding } from "../../core/envelope";
import { decodeSnapFoldV1, encodeSnapFoldV1 } from "../../core/codec/snapFoldV1";
import { NS_CANDIDATE_INTERVAL } from "../../core/ns/candidate";
import { SNAP_FOLD_RULES_VERSION, foldSnapFrame, newSnapFold, overlayPendingSnap, type SnapFoldEvent, type SnapFoldState } from "../../core/snap/fold";
import { decodeSnapOps, type SnapOp } from "../../core/snap/record";
import { SNAP_STREAM, type DeviceId, type Seq } from "../../core/types";
import type { Repo } from "../store/repo";
import type { SnapshotRecord, TailRecord } from "../store/schema";
import type { OutboxCache } from "../runtime/outboxCache";
import { FoldRuntime } from "./foldRuntime";

export class SnapRuntime extends FoldRuntime<SnapOp, SnapFoldEvent> {
	readonly encoding = CheckpointEncoding.snapFoldV1;
	readonly rulesVersion = SNAP_FOLD_RULES_VERSION;
	state: SnapFoldState = newSnapFold();
	/** Ops ignored because of an unknown record version (diagnostics; the fold skips them). */
	unknownVersions = 0;

	constructor(repo: Repo, self: DeviceId, candidateModulus = NS_CANDIDATE_INTERVAL) {
		super(repo, self, SNAP_STREAM, candidateModulus);
	}

	get coversSeq(): Seq {
		return this.state.coversSeq;
	}

	protected reset(snap: SnapshotRecord | undefined): boolean {
		const st = snap && snap.encoding === CheckpointEncoding.snapFoldV1 && snap.bytes.length > 0 ? decodeSnapFoldV1(snap.bytes) : null;
		this.state = st ?? newSnapFold();
		return !snap || st !== null;
	}

	protected decodeOps(content: Uint8Array): SnapOp[] | null {
		return decodeSnapOps(content);
	}

	protected foldFrame(row: TailRecord, ops: readonly SnapOp[]): { events: readonly SnapFoldEvent[]; halted: boolean } {
		const events = foldSnapFrame(this.state, { seq: row.seq, deviceId: row.deviceId, ops });
		for (const e of events) if (e.outcome.t === "ignored" && e.outcome.reason === "unknown-version") this.unknownVersions++;
		return { events, halted: false };
	}

	/** A put of an unknown record version: its parts are invisible here (blobs/gc.ts must not collect them). */
	protected rowGap(ops: readonly SnapOp[]): string | null {
		return ops.some((op) => op.t === "putUnknown") ? "snap record version unknown" : null;
	}

	encodeState(): Uint8Array {
		return encodeSnapFoldV1(this.state);
	}

	/** snap frames carry frameNo 0: no replay window (e2ee-design §8.2). */
	protected ownReplayEdge(): number {
		return 0;
	}

	/** Committed index + own pending snap frames (outbox, receipted-unfolded). */
	view(outbox: OutboxCache): SnapFoldState {
		const pending = this.pendingFrames(outbox);
		if (pending.length === 0) return this.state;
		return overlayPendingSnap(this.state, this.self, pending);
	}
}
