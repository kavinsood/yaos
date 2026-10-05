/**
 * Optimistic overlay (DESIGN §f.1 RemoteEntry = OptimisticRemote(committed
 * fold + own pending ns ops)). Folds the device's pending frames, in outbox
 * order, on a copy-on-write clone at pseudo-seqs coversSeq + 1 + i. The
 * committed state/index are not modified.
 */

import type { ClientFrameId, DeviceId, DocId, NsFoldEvent, NsFoldIndex, NsFoldState, NsOp, Seq } from "../types";
import { cloneNsFold } from "./index";
import { DEFAULT_NS_FOLD_RULES, foldNsFrameWith, nsFoldHalted, type NsFoldRules } from "./fold";

export interface PendingNsFrame {
	readonly clientFrameId: ClientFrameId;
	readonly authorNsSeq: Seq;
	readonly ops: readonly NsOp[];
}

export interface NsOverlay {
	readonly state: NsFoldState;
	readonly index: NsFoldIndex;
	readonly events: readonly NsFoldEvent[];
	/** docIds whose entry differs from the committed fold (added, changed, recased, pruned). Ascending. */
	readonly touched: readonly DocId[];
	/** A pending frame would halt the fold (upgradeRules above the known version); later frames were not applied. */
	readonly halted: boolean;
}

export function overlayPending(
	state: NsFoldState,
	index: NsFoldIndex,
	deviceId: DeviceId,
	frames: readonly PendingNsFrame[],
	rules: NsFoldRules = DEFAULT_NS_FOLD_RULES,
): NsOverlay {
	const c = cloneNsFold(state, index);
	const events: NsFoldEvent[] = [];
	let halted = false;
	for (let i = 0; i < frames.length; i++) {
		const f = frames[i]!;
		const ev = foldNsFrameWith(rules, c.state, c.index, { seq: state.coversSeq + 1 + i, deviceId, clientFrameId: f.clientFrameId, authorNsSeq: f.authorNsSeq, ops: f.ops });
		events.push(...ev);
		if (nsFoldHalted(ev)) { halted = true; break; }
	}
	const touched = new Set<DocId>();
	for (const [id, e] of c.state.entries) if (state.entries.get(id) !== e) touched.add(id);
	for (const id of state.entries.keys()) if (!c.state.entries.has(id)) touched.add(id);
	return { state: c.state, index: c.index, events, touched: [...touched].sort(), halted };
}
