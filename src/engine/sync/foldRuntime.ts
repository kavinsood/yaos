/**
 * Shared machinery of the ns and cfg fold runtimes (DESIGN §c, §c.11, §d.8,
 * §d.9 candidates).
 *
 * State = snapshot (nsFoldV1 / cfgFoldV1) + fold of tail rows in
 * (snapshot, appliedSeq], in seq order. Rows are folded only once the stream
 * has them all (appliedSeq), so live rows of a stale stream wait in tail. A
 * tail row flagged LOCAL_FLAG_UNOPENED (reader-dependent gate failure) halts
 * the fold, as does a frame the fold itself refuses (ns upgradeRules above the
 * known version).
 *
 * Own frames are "pending" (overlaid on the committed fold) from T_edit until
 * the committed fold has them: while in the outbox, and after the receipt
 * removed the outbox record but before the row is folded (stale stream, halt).
 */

import type { CheckpointEncoding } from "../../core/envelope";
import { NS_CANDIDATE_INTERVAL, isCandidateSeq } from "../../core/ns/candidate";
import type { ClientFrameId, DeviceId, Seq, StreamName } from "../../core/types";
import type { Repo } from "../store/repo";
import type { OutboxRecord, SnapshotRecord, TailRecord } from "../store/schema";
import type { OutboxCache } from "../runtime/outboxCache";

/** Local-only tail flag (never on the wire): the row failed a reader-dependent gate check; content = raw payload. */
export const LOCAL_FLAG_UNOPENED = 1 << 20;

export interface FoldCandidate {
	readonly seq: Seq;
	/** Canonical fold bytes (nsFoldV1 / cfgFoldV1) at seq. */
	readonly bytes: Uint8Array;
	readonly authoredBySelf: boolean;
}

export interface FoldHalt {
	readonly seq: Seq;
	readonly reason: "reader-dependent" | "rules-version";
}

/** One committed frame as folded. */
export interface FoldedFrame<Op, E> {
	readonly seq: Seq;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	readonly ops: readonly Op[];
	readonly events: readonly E[];
}

/** An own frame not yet in the committed fold. */
export interface OwnPendingFrame<Op> {
	readonly clientFrameId: ClientFrameId;
	readonly authorNsSeq: Seq;
	readonly ops: readonly Op[];
}

export abstract class FoldRuntime<Op, E> {
	halted: FoldHalt | null = null;
	candidate: FoldCandidate | null = null;
	foldedRows = 0;
	/** Highest tail seq looked at (rows in (through, appliedSeq] are next). */
	private through: Seq = 0;
	private busy: Promise<unknown> = Promise.resolve();
	/** Own frames whose outbox record is gone (receipted) but whose row is not folded yet, in receipt order. */
	private committedOwn: OwnPendingFrame<Op>[] = [];

	constructor(
		protected readonly repo: Repo,
		protected readonly self: DeviceId,
		readonly stream: StreamName,
		private readonly candidateInterval = NS_CANDIDATE_INTERVAL,
	) {}

	/** Snapshot / checkpoint encoding of the committed state (nsFoldV1 / cfgFoldV1). */
	abstract readonly encoding: CheckpointEncoding;
	/** foldRulesVersion written into checkpoints. */
	abstract readonly rulesVersion: number;
	abstract get coversSeq(): Seq;
	/** Replace the committed state from the snapshot (undefined / unusable -> empty). */
	protected abstract reset(snap: SnapshotRecord | undefined): void;
	/** null = deterministic malformation (folds as an empty frame). */
	protected abstract decodeOps(content: Uint8Array): Op[] | null;
	protected abstract foldFrame(row: TailRecord, ops: readonly Op[]): { readonly events: readonly E[]; readonly halted: boolean };
	/** Canonical encoding of the committed state (snapshot / checkpoint bytes). */
	abstract encodeState(): Uint8Array;

	/** (Re)load from the snapshot and refold the tail. */
	async load(): Promise<FoldedFrame<Op, E>[]> {
		const run = async () => {
			const snap = await this.repo.getSnapshot(this.stream);
			this.reset(snap);
			this.halted = null;
			this.through = Math.max(this.coversSeq, snap?.coversSeq ?? 0);
			const folded = await this.doAdvance();
			// Own rows above the fold (stale stream / halt) stay in the overlay.
			const rest = await this.repo.getTail(this.stream, this.coversSeq);
			this.committedOwn = rest
				.filter((r) => r.deviceId === this.self && !(r.flags & LOCAL_FLAG_UNOPENED))
				.map((r) => ({ clientFrameId: r.clientFrameId, authorNsSeq: r.authorNsSeq, ops: this.decodeOps(r.content) ?? [] }));
			return folded;
		};
		const p = this.busy.then(run, run);
		this.busy = p.catch(() => undefined);
		return p;
	}

	/** Fold every newly available row (serialized). */
	advance(): Promise<FoldedFrame<Op, E>[]> {
		const p = this.busy.then(() => this.doAdvance(), () => this.doAdvance());
		this.busy = p.catch(() => undefined);
		return p;
	}

	private async doAdvance(): Promise<FoldedFrame<Op, E>[]> {
		const rec = this.repo.stream(this.stream);
		if (!rec || this.halted) return [];
		if (rec.appliedSeq <= this.through) return [];
		const target = rec.appliedSeq;
		const rows = await this.repo.getTail(this.stream, this.through, target);
		const out: FoldedFrame<Op, E>[] = [];
		for (const row of rows) {
			if (row.seq <= this.coversSeq) continue;
			if (row.flags & LOCAL_FLAG_UNOPENED) {
				this.halt(row.seq, "reader-dependent");
				return out;
			}
			const ops = row.content.length > 0 ? this.decodeOps(row.content) ?? [] : [];
			const prev = this.coversSeq;
			const { events, halted } = this.foldFrame(row, ops);
			if (halted) {
				this.halt(row.seq, "rules-version");
				return out;
			}
			this.foldedRows++;
			if (row.deviceId === this.self) this.committedOwn = this.committedOwn.filter((f) => f.clientFrameId !== row.clientFrameId);
			if (this.isCandidate(prev, row.seq)) this.candidate = { seq: row.seq, bytes: this.encodeState(), authoredBySelf: row.deviceId === this.self };
			out.push({ seq: row.seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId, ops, events });
		}
		this.through = target;
		return out;
	}

	private halt(seq: Seq, reason: FoldHalt["reason"]): void {
		this.halted = { seq, reason };
		this.through = seq - 1;
	}

	private isCandidate(prev: Seq, s: Seq): boolean {
		const m = this.candidateInterval;
		return m === NS_CANDIDATE_INTERVAL ? isCandidateSeq(prev, s) : Math.floor(s / m) > Math.floor(prev / m);
	}

	/** The receipt removed an own outbox record of this stream: keep it pending until folded. */
	noteCommitted(rec: OutboxRecord): void {
		if (rec.stream !== this.stream || rec.state === "poisoned" || rec.content.length === 0) return;
		if (this.committedOwn.some((f) => f.clientFrameId === rec.clientFrameId)) return;
		this.committedOwn.push({ clientFrameId: rec.clientFrameId, authorNsSeq: rec.authorNsSeq, ops: this.decodeOps(rec.content) ?? [] });
	}

	/** Own frames not in the committed fold, in order: receipted-unfolded first, then the outbox (poisoned excluded). */
	pendingFrames(outbox: OutboxCache): OwnPendingFrame<Op>[] {
		const out = [...this.committedOwn];
		for (const r of outbox.ofStream(this.stream)) {
			if (r.state === "poisoned" || r.content.length === 0) continue;
			out.push({ clientFrameId: r.clientFrameId, authorNsSeq: r.authorNsSeq, ops: this.decodeOps(r.content) ?? [] });
		}
		return out;
	}
}
