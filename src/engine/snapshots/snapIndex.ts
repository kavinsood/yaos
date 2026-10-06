/**
 * The snapshot index as SnapshotJob sees it (DESIGN §j.4): the `snap` stream's fold (committed + own pending
 * frames) and the append of own ops. Implemented over the LogEngine by LogPort.snap.
 */
import type { SnapFoldState } from "../../core/snap/fold";
import type { SnapOp } from "../../core/snap/record";
import type { DeviceId } from "../../core/types";

export interface SnapIndexPort {
	readonly self: DeviceId;
	/** `ready` = the log went live in this session and the snap stream is read and not halted. */
	view(): { readonly state: SnapFoldState; readonly ready: boolean };
	/** Appends own ops; resolves once they are in the outbox (and so in view()). */
	submit(ops: readonly SnapOp[]): Promise<void>;
}
