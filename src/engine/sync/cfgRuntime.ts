/**
 * cfg runtime (DESIGN §c.11, §d.8, §d.9): the committed cfg fold (cfgFoldV1
 * snapshot + tail rows) and the optimistic view with own pending cfg frames.
 * Same shape as NsRuntime (FoldRuntime); cfg frames have no dependsOn and no
 * rules-version halt, only reader-dependent rows halt.
 */

import { CheckpointEncoding } from "../../core/envelope";
import { decodeCfgFoldV1, encodeCfgFoldV1 } from "../../core/codec/cfgFoldV1";
import { decodeCfgOps } from "../../core/codec/cfgOps";
import { CFG_FOLD_RULES_VERSION, foldCfgFrame, newCfgFoldState, overlayPendingCfg, type CfgFoldEvent } from "../../core/cfg/fold";
import { NS_CANDIDATE_INTERVAL } from "../../core/ns/candidate";
import { CFG_STREAM, type CfgFoldState, type CfgOp, type DeviceId, type Seq } from "../../core/types";
import type { Repo } from "../store/repo";
import type { SnapshotRecord, TailRecord } from "../store/schema";
import type { OutboxCache } from "../runtime/outboxCache";
import { FoldRuntime, type FoldedFrame } from "./foldRuntime";

export type FoldedCfgFrame = FoldedFrame<CfgOp, CfgFoldEvent>;

export class CfgRuntime extends FoldRuntime<CfgOp, CfgFoldEvent> {
	readonly encoding = CheckpointEncoding.cfgFoldV1;
	readonly rulesVersion = CFG_FOLD_RULES_VERSION;
	state: CfgFoldState = newCfgFoldState();

	constructor(repo: Repo, self: DeviceId, candidateModulus = NS_CANDIDATE_INTERVAL) {
		super(repo, self, CFG_STREAM, candidateModulus);
	}

	get coversSeq(): Seq {
		return this.state.coversSeq;
	}

	protected reset(snap: SnapshotRecord | undefined): void {
		const st = snap && snap.encoding === CheckpointEncoding.cfgFoldV1 && snap.bytes.length > 0 ? decodeCfgFoldV1(snap.bytes) : null;
		this.state = st ?? newCfgFoldState();
	}

	protected decodeOps(content: Uint8Array): CfgOp[] | null {
		return decodeCfgOps(content);
	}

	protected foldFrame(row: TailRecord, ops: readonly CfgOp[]): { events: readonly CfgFoldEvent[]; halted: boolean } {
		return { events: foldCfgFrame(this.state, { seq: row.seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId, ops }), halted: false };
	}

	encodeState(): Uint8Array {
		return encodeCfgFoldV1(this.state);
	}

	/** Committed cfg fold + own pending cfg frames (outbox, receipted-unfolded). */
	view(outbox: OutboxCache): CfgFoldState {
		const pending = this.pendingFrames(outbox);
		if (pending.length === 0) return this.state;
		return overlayPendingCfg(this.state, this.self, pending.map((f) => ({ clientFrameId: f.clientFrameId, ops: f.ops }))).state;
	}
}
