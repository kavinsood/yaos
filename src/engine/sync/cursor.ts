/**
 * Vault cursor bookkeeping (DESIGN §d.7 "Cursor advance").
 *
 * V = meta.cursor.vaultSeq: every commit <= V is accounted. Accounted seqs
 * above V are tracked in memory. The tracker mirrors the persisted value: it is
 * only advanced by commit() AFTER the accounting transaction committed, and
 * preview() computes the V that transaction must persist. Repo serializes all
 * accounting transactions, so preview() is exact.
 */

import type { Seq } from "../../core/types";

export class CursorTracker {
	private v: Seq;
	private readonly above = new Set<Seq>();
	private maxAccounted: Seq;
	headSeqSeen: Seq;
	/** Monotonic ms when V+1 was first seen missing while a higher seq was accounted. */
	private gapSince: number | null = null;

	constructor(vaultSeq: Seq, headSeqSeen: Seq) {
		this.v = vaultSeq;
		this.maxAccounted = vaultSeq;
		this.headSeqSeen = headSeqSeen;
	}

	get vaultSeq(): Seq {
		return this.v;
	}

	get highestAccounted(): Seq {
		return this.maxAccounted;
	}

	isAccounted(seq: Seq): boolean {
		return seq <= this.v || this.above.has(seq);
	}

	/** V after additionally accounting `seqs` (and everything <= jumpTo). */
	preview(seqs: Iterable<Seq>, jumpTo: Seq = 0): Seq {
		let v = Math.max(this.v, jumpTo);
		const extra = new Set<Seq>();
		for (const s of seqs) if (s > v) extra.add(s);
		while (this.above.has(v + 1) || extra.has(v + 1)) v++;
		return v;
	}

	/** Called after the accounting tx committed with persisted V = newV. */
	commit(seqs: Iterable<Seq>, newV: Seq, nowMono: number): void {
		for (const s of seqs) {
			if (s > this.v) this.above.add(s);
			if (s > this.maxAccounted) this.maxAccounted = s;
		}
		if (newV > this.v) this.v = newV;
		if (this.v > this.maxAccounted) this.maxAccounted = this.v;
		for (const s of this.above) if (s <= this.v) this.above.delete(s);
		if (this.above.size === 0) this.gapSince = null;
		else if (this.gapSince === null) this.gapSince = nowMono;
	}

	/** True when V+1 has been missing for >= thresholdMs while higher seqs are accounted, or a head hint is above V. */
	gapDue(nowMono: number, thresholdMs: number): boolean {
		if (this.headSeqSeen > this.v && this.above.size === 0 && this.gapSince === null) return false;
		return this.gapSince !== null && nowMono - this.gapSince >= thresholdMs;
	}

	/** Reset the gap timer (a feed was started for it). */
	gapHandled(nowMono: number): void {
		if (this.gapSince !== null) this.gapSince = nowMono;
	}

	pendingAbove(): number {
		return this.above.size;
	}

	/** Session lost: in-memory accounting above V is still valid (committed); nothing to do. Kept for symmetry. */
	reset(vaultSeq: Seq): void {
		this.v = vaultSeq;
		this.above.clear();
		this.maxAccounted = vaultSeq;
		this.gapSince = null;
	}
}
