/**
 * Shared machinery of the ns and cfg fold runtimes (DESIGN §c, §c.11, §d.8,
 * §d.9 candidates).
 *
 * State = snapshot (nsFoldV1 / cfgFoldV1) + fold of tail rows in
 * (snapshot, appliedSeq], in seq order. Rows are folded only once the stream
 * has them all (appliedSeq), so live rows of a stale stream wait in tail. A
 * tail row flagged LOCAL_FLAG_UNOPENED (reader-dependent gate failure) halts
 * the fold, as does a frame the fold itself refuses (ns upgradeRules above the
 * known version); resume() lifts it once the row is re-gated (quarantineRelease.ts).
 * A remote checkpoint of newer rules or format (catchUp.ts) halts it too
 * (haltAtCheckpoint): the stream stays stale, and nothing of the halt is stored,
 * so an upgraded client reads and adopts the checkpoint on its next start.
 * FoldHalt.upgrade: only a newer client can lift the halt (phase upgrade-required).
 * A row flagged LOCAL_FLAG_STALE_EPOCH (e2ee-design §14.3) folds as one
 * frame-level ignored/stale-epoch event.
 *
 * Own frames are "pending" (overlaid on the committed fold) from T_edit until
 * the committed fold has them: while in the outbox, and after the receipt
 * removed the outbox record but before the row is folded (stale stream, halt).
 *
 * allocFrameNo() hands out the stream's own frameNos (e2ee-design §8.2).
 */

import type { CheckpointEncoding } from "../../core/envelope";
import { decodeOuter } from "../../core/codec/envelope";
import { NS_DEDUPE_RING } from "../../core/limits";
import { NS_CANDIDATE_INTERVAL, isCandidateSeq } from "../../core/ns/candidate";
import type { ClientFrameId, DeviceId, Seq, StreamName } from "../../core/types";
import type { Repo } from "../store/repo";
import type { OutboxRecord, SnapshotRecord, TailRecord } from "../store/schema";
import type { OutboxCache } from "../runtime/outboxCache";

/** Local-only tail flag (never on the wire): the row failed a reader-dependent gate check; content = raw payload. */
export const LOCAL_FLAG_UNOPENED = 1 << 20;
/** Local-only tail flag: a stale-epoch frame (e2ee-design §14.3); content is empty. */
export const LOCAL_FLAG_STALE_EPOCH = 1 << 21;

export interface FoldCandidate {
	readonly seq: Seq;
	/** Canonical fold bytes (nsFoldV1 / cfgFoldV1) at seq. */
	readonly bytes: Uint8Array;
	readonly authoredBySelf: boolean;
	/** foldRulesVersion of the state in `bytes` (the checkpoint header must equal it, §b.5 V2). */
	readonly rulesVersion: number;
}

export interface FoldHalt {
	/** The row the fold stopped before, or the coversSeq of the checkpoint it cannot adopt. */
	readonly seq: Seq;
	/**
	 * reader-dependent: a tail row did not open (LOCAL_FLAG_UNOPENED); rules-version: the fold refused a frame (ns
	 * upgradeRules above the known version); newer-checkpoint: the stream's checkpoint has newer rules or format.
	 */
	readonly reason: "reader-dependent" | "rules-version" | "newer-checkpoint";
	/** Only an upgraded client gets past it (a newer writer); false: waiting for keys or `k` (§d.6). */
	readonly upgrade: boolean;
}

/** An unopened payload whose envelope formatVersion or suite byte this build does not know: a newer writer. */
export function newerEnvelope(payload: Uint8Array): boolean {
	const o = decodeOuter(payload);
	return !o.ok && (o.reason === "unsupported-version" || o.reason === "unsupported-suite");
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
	readonly frameNo: number;
	readonly ops: readonly Op[];
}

export abstract class FoldRuntime<Op, E> {
	/** Halt from a row (unopened or refused): load() and resume() clear it, the rows decide again. */
	private rowHalt: FoldHalt | null = null;
	/** Halt from a newer checkpoint: kept across load() for the runtime's life (the stream stays stale). */
	private checkpointHalt: FoldHalt | null = null;
	candidate: FoldCandidate | null = null;
	foldedRows = 0;
	/** Highest tail seq looked at (rows in (through, appliedSeq] are next). */
	private through: Seq = 0;
	private busy: Promise<unknown> = Promise.resolve();
	/** Own frames whose outbox record is gone (receipted) but whose row is not folded yet, in receipt order. */
	private committedOwn: OwnPendingFrame<Op>[] = [];
	/** Highest own frameNo seen outside the fold state and the outbox (tail above the fold, receipts, allocations). */
	private ownFrameNoSeen = 0;
	/** The first allocation of this runtime skips NS_DEDUPE_RING numbers (e2ee-design §8.2). */
	private allocated = false;
	/** Floor carried by epoch migration (meta frameNoFloor). */
	frameNoFloor = 0;
	/** coversSeq of a stored snapshot reset() could not use (the state started empty), else null. */
	private unusableSnapshot: Seq | null = null;

	constructor(
		protected readonly repo: Repo,
		protected readonly self: DeviceId,
		readonly stream: StreamName,
		private readonly candidateInterval = NS_CANDIDATE_INTERVAL,
	) {}

	/** Snapshot / checkpoint encoding of the committed state (nsFoldV1 / cfgFoldV1). */
	abstract readonly encoding: CheckpointEncoding;
	/** foldRulesVersion of the committed state (written into its checkpoints). */
	abstract readonly rulesVersion: number;
	abstract get coversSeq(): Seq;
	/** Replace the committed state from the snapshot (undefined / unusable -> empty). false = it was unusable. */
	protected abstract reset(snap: SnapshotRecord | undefined): boolean;
	/** null = deterministic malformation (folds as an empty frame). */
	protected abstract decodeOps(content: Uint8Array): Op[] | null;
	protected abstract foldFrame(row: TailRecord, ops: readonly Op[]): { readonly events: readonly E[]; readonly halted: boolean };
	/**
	 * A stale-epoch row (§14.3, §9.3): one frame-level ignored/stale-epoch event, coversSeq = seq; neither the
	 * clientFrameId ring nor the replay window changes (as for replay-*).
	 */
	protected abstract foldStale(row: TailRecord): readonly E[];
	/** Canonical encoding of the committed state (snapshot / checkpoint bytes). */
	abstract encodeState(): Uint8Array;
	/** This device's replay right edge R in the committed fold (0 = none). */
	protected abstract ownReplayEdge(): number;

	/** Why the fold stopped (a row halt first), or null. */
	get halted(): FoldHalt | null {
		return this.rowHalt ?? this.checkpointHalt;
	}

	/** The stream's checkpoint at coversSeq has rules or a format this reader does not implement (catchUp.ts). */
	haltAtCheckpoint(coversSeq: Seq): void {
		this.checkpointHalt = { seq: coversSeq, reason: "newer-checkpoint", upgrade: true };
	}
	/** A read of the stream completed or adopted a checkpoint: no newer checkpoint stands in the way. */
	clearCheckpointHalt(): void {
		this.checkpointHalt = null;
	}

	/** (Re)load from the snapshot and refold the tail. */
	async load(): Promise<FoldedFrame<Op, E>[]> {
		const run = async () => {
			const snap = await this.repo.getSnapshot(this.stream);
			this.unusableSnapshot = this.reset(snap) ? null : snap!.coversSeq;
			this.rowHalt = null;
			this.through = Math.max(this.coversSeq, snap?.coversSeq ?? 0);
			const folded = await this.doAdvance();
			// Own rows above the fold (stale stream / halt) stay in the overlay.
			const rest = await this.repo.getTail(this.stream, this.coversSeq);
			this.committedOwn = rest
				.filter((r) => r.deviceId === this.self && !(r.flags & LOCAL_FLAG_UNOPENED))
				.map((r) => ({ clientFrameId: r.clientFrameId, authorNsSeq: r.authorNsSeq, frameNo: r.frameNo ?? 0, ops: this.decodeOps(r.content) ?? [] }));
			for (const f of this.committedOwn) this.seeFrameNo(f.frameNo);
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
		if (!rec || this.rowHalt) return [];
		if (rec.appliedSeq <= this.through) return [];
		const target = rec.appliedSeq;
		const rows = await this.repo.getTail(this.stream, this.through, target);
		const out: FoldedFrame<Op, E>[] = [];
		for (const row of rows) {
			if (row.seq <= this.coversSeq) continue;
			if (row.flags & LOCAL_FLAG_UNOPENED) {
				this.halt(row.seq, "reader-dependent", newerEnvelope(row.content));
				return out;
			}
			const ops = row.content.length > 0 ? this.decodeOps(row.content) ?? [] : [];
			const prev = this.coversSeq;
			const { events, halted } = row.flags & LOCAL_FLAG_STALE_EPOCH ? { events: this.foldStale(row), halted: false } : this.foldFrame(row, ops);
			if (halted) {
				this.halt(row.seq, "rules-version", true);
				return out;
			}
			this.foldedRows++;
			if (row.deviceId === this.self) this.committedOwn = this.committedOwn.filter((f) => f.clientFrameId !== row.clientFrameId);
			if (this.isCandidate(prev, row.seq)) this.candidate = { seq: row.seq, bytes: this.encodeState(), authoredBySelf: row.deviceId === this.self, rulesVersion: this.rulesVersion };
			out.push({ seq: row.seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId, ops, events });
		}
		this.through = target;
		return out;
	}

	/** The rows that halted the fold were re-gated: lift a reader-dependent halt (serialized with advance). */
	resume(): Promise<void> {
		const run = async () => {
			if (this.rowHalt?.reason === "reader-dependent") this.rowHalt = null;
		};
		const p = this.busy.then(run, run);
		this.busy = p.catch(() => undefined);
		return p;
	}

	/**
	 * Why the committed state may lack what the relay's rows say (blobs/gc.ts precondition), or null: the fold
	 * halted; the stored snapshot did not decode (reset() started empty); a tail row up to appliedSeq did not open
	 * (reader-dependent), failed the gate (stored empty), does not decode, is not folded yet, or holds an op this
	 * reader ignores for being newer than it (rowGap). Folds the available rows first.
	 */
	async gap(): Promise<{ readonly seq: Seq; readonly reason: string } | null> {
		await this.advance();
		const run = async () => {
			if (this.halted) return { seq: this.halted.seq, reason: `halted (${this.halted.reason})` };
			if (this.unusableSnapshot !== null) return { seq: this.unusableSnapshot, reason: "snapshot does not decode" };
			const rec = this.repo.stream(this.stream);
			if (!rec) return null;
			const snap = await this.repo.getSnapshot(this.stream);
			for (const row of await this.repo.getTail(this.stream, snap?.coversSeq ?? 0, rec.appliedSeq)) {
				if (row.flags & LOCAL_FLAG_UNOPENED) return { seq: row.seq, reason: "row does not open" };
				if (row.content.length === 0) return { seq: row.seq, reason: "row failed the gate" };
				const ops = this.decodeOps(row.content);
				if (!ops) return { seq: row.seq, reason: "row does not decode" };
				const why = this.rowGap(ops);
				if (why) return { seq: row.seq, reason: why };
				if (row.seq > this.coversSeq) return { seq: row.seq, reason: "row not folded" };
			}
			return null;
		};
		const p = this.busy.then(run, run);
		this.busy = p.catch(() => undefined);
		return p;
	}

	/** An op of a committed row this reader folds as ignored although a newer reader may not (null = none). */
	protected rowGap(_ops: readonly Op[]): string | null {
		return null;
	}

	private halt(seq: Seq, reason: FoldHalt["reason"], upgrade: boolean): void {
		this.rowHalt = { seq, reason, upgrade };
		this.through = seq - 1;
	}

	private isCandidate(prev: Seq, s: Seq): boolean {
		const m = this.candidateInterval;
		return m === NS_CANDIDATE_INTERVAL ? isCandidateSeq(prev, s) : Math.floor(s / m) > Math.floor(prev / m);
	}

	/**
	 * The receipt removed an own outbox record of this stream: keep it pending until folded. A commit seq the fold
	 * already covers is not pending: folded, or under the snapshot (a late receipt, e.g. a resend deduped against a
	 * row a checkpoint collected, after this device adopted that checkpoint). Kept, it never left the overlay.
	 */
	noteCommitted(rec: OutboxRecord, seq: Seq | null = null): void {
		if (rec.stream !== this.stream || rec.state === "poisoned" || rec.content.length === 0) return;
		this.seeFrameNo(rec.frameNo ?? 0);
		if (seq !== null && seq <= this.coversSeq) return;
		if (this.committedOwn.some((f) => f.clientFrameId === rec.clientFrameId)) return;
		this.committedOwn.push({ clientFrameId: rec.clientFrameId, authorNsSeq: rec.authorNsSeq, frameNo: rec.frameNo ?? 0, ops: this.decodeOps(rec.content) ?? [] });
	}

	private seeFrameNo(f: number): void {
		if (f > this.ownFrameNoSeen) this.ownFrameNoSeen = f;
	}

	/**
	 * Next own frameNo of this stream (e2ee-design §8.2): 1 + the highest own
	 * frameNo known (fold R, own tail rows and receipts above the fold, the
	 * outbox incl. poisoned, the epoch-migration floor, earlier allocations).
	 * The first allocation of a runtime adds NS_DEDUPE_RING, skipping numbers
	 * an in-flight frame may have used when IndexedDB was lost. Gaps are fine.
	 */
	allocFrameNo(outbox: OutboxCache): number {
		let max = this.maxOwnFrameNo(outbox);
		if (!this.allocated) {
			max += NS_DEDUPE_RING;
			this.allocated = true;
		}
		this.ownFrameNoSeen = max + 1;
		return max + 1;
	}

	/** Highest own frameNo this runtime knows of (epoch migration carries it, §8.2). */
	maxOwnFrameNo(outbox: OutboxCache): number {
		let max = Math.max(this.ownReplayEdge(), this.ownFrameNoSeen, this.frameNoFloor);
		for (const r of outbox.ofStream(this.stream)) max = Math.max(max, r.frameNo ?? 0);
		return max;
	}

	/** Own frames not in the committed fold, in order: receipted-unfolded first, then the outbox (poisoned excluded). */
	pendingFrames(outbox: OutboxCache): OwnPendingFrame<Op>[] {
		const out = [...this.committedOwn];
		for (const r of outbox.ofStream(this.stream)) {
			if (r.state === "poisoned" || r.content.length === 0) continue;
			out.push({ clientFrameId: r.clientFrameId, authorNsSeq: r.authorNsSeq, frameNo: r.frameNo ?? 0, ops: this.decodeOps(r.content) ?? [] });
		}
		return out;
	}
}
