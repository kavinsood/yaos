/**
 * Writing verified snapshot entries back (DESIGN §j.4), unchanged from the local-only flow: files are written as
 * ordinary local edits (the reconciler picks them up on its next scan). A differing current file is first copied
 * to a conflict name (precondition absent); the restore write then uses precondition fingerprint(current) /
 * absent, so a file edited between the read and the write is not clobbered (reported failed). The reconciler's
 * brake still applies to whatever the restore changes.
 */
import { exactFingerprint } from "../../core/hash/markdownLf";
import { conflictName } from "../../core/plan/conflictName";
import type { VerifiedEntry } from "../../core/snap/verify";
import type { PathKey, PathKeyFn, VaultPath } from "../../core/types";
import type { ClockPort } from "../../ports/clock";
import type { WritePrecondition } from "../../ports/vault";
import { LANE, type DiskOp, type DiskOpPurpose, type DiskReadResult } from "../../protocol/messages";
import type { DiskGateway } from "../reconcile/deps";
import { SNAP_MAX_TEXT_BYTES } from "../../core/snap/bundle";

export interface RestoreResult {
	readonly restored: readonly VaultPath[];
	readonly unchanged: readonly VaultPath[];
	readonly copies: readonly VaultPath[];
	readonly failed: readonly VaultPath[];
}

export interface RestorerDeps {
	readonly disk: DiskGateway;
	readonly clock: ClockPort;
	readonly pathKey: PathKeyFn;
	readonly deviceLabel: string;
	readonly tzOffsetMinutes: number;
	/** Paths taken in the vault now (conflict names avoid them). */
	readonly taken: Iterable<VaultPath>;
	readonly nextOpId: () => number;
}

export class Restorer {
	private readonly taken: Set<PathKey>;
	readonly out = { restored: [] as VaultPath[], unchanged: [] as VaultPath[], copies: [] as VaultPath[], failed: [] as VaultPath[] };

	constructor(private readonly d: RestorerDeps, private readonly want: ReadonlySet<VaultPath> | null) {
		this.taken = new Set([...d.taken].map((p) => d.pathKey(p)));
	}

	readonly entry = async (e: VerifiedEntry): Promise<void> => {
		if (this.want && !this.want.has(e.path)) return;
		const { out } = this;
		const [cur] = await this.d.disk.read([{ area: "vault", path: e.path, maxBytes: SNAP_MAX_TEXT_BYTES }], LANE.background);
		let pre: WritePrecondition = { t: "absent" };
		if (cur?.ok) {
			const fp = exactFingerprint(cur.bytes);
			if ((fp as string) === e.hash) { out.unchanged.push(e.path); return; } // both are sha256 of the exact bytes
			const copy = conflictName({
				path: e.path, docId: null, deviceLabel: this.d.deviceLabel, nowMs: this.d.clock.now(),
				tzOffsetMinutes: this.d.tzOffsetMinutes, pathKey: this.d.pathKey, isTaken: (k) => this.taken.has(k),
			});
			if (!(await this.write(copy, cur.bytes, { t: "absent" }, "conflict-copy"))) { out.failed.push(e.path); return; }
			this.taken.add(this.d.pathKey(copy));
			out.copies.push(copy);
			pre = { t: "fingerprint", fingerprint: fp };
		} else if (!isMissing(cur)) {
			out.failed.push(e.path);
			return;
		}
		if (await this.write(e.path, e.data, pre, "snapshot-restore")) {
			this.taken.add(this.d.pathKey(e.path));
			out.restored.push(e.path);
		} else out.failed.push(e.path);
	};

	private async write(path: VaultPath, bytes: Uint8Array, precondition: WritePrecondition, purpose: DiskOpPurpose): Promise<boolean> {
		const op: DiskOp = { t: "write", opId: this.d.nextOpId(), area: "vault", path, data: { t: "bytes", bytes }, precondition, docId: null, purpose };
		const [res] = await this.d.disk.exec([op], LANE.background);
		return res?.t === "write" && res.outcome.ok;
	}
}

function isMissing(r: DiskReadResult | undefined): boolean {
	return r !== undefined && !r.ok && r.reason === "missing";
}
