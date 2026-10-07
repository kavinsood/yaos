/**
 * The keyring's bookkeeping (e2ee-design §11.3, §14.3): `k` rows in seq order, the sticky winner per epoch,
 * and how this device holds each K_e. Pure: no crypto, no I/O. evaluate.ts decides winners; keyring.ts
 * drives both.
 */

import { bytesEqual } from "../../core/codec/lib0";
import type { Seq } from "../../core/types";
import { KeyRecordKind, decodeKeyRecord, type KeyRecord } from "./record";

/**
 * How this device holds K_e. Authoritative sources reject a record whose kcv differs:
 * - verified: the key of the epoch's winner;
 * - oob: a QR key (§12.1, §14.2 step 3);
 * - prev: opened from a valid record's prevWrap (the backward chain, §11.1).
 * - own: generated here for a record not yet decided (§11.4 step 2), or a host key without a stored record. It
 *   yields to the first valid record of its epoch.
 */
export type KeySource = "verified" | "oob" | "prev" | "own";

export type RowState =
	/** Not decidable with the keys held now (§11.3: pending is not invalid). */
	| "pending"
	| "winner"
	/** Judged against the keys held: wrong kcv, a wrap that does not open, a prevWrap to another key. */
	| "invalid"
	/** Another record already won this epoch (event keyring/duplicate). */
	| "duplicate"
	/** Byte-identical to the winner (a re-publish): a no-op. */
	| "same"
	/** Not a canonical record (event keyring/garbage). */
	| "garbage";

export interface KRow {
	/** null: a stored winner (SecretStorage, §6.1). */
	readonly seq: Seq | null;
	readonly bytes: Uint8Array;
	readonly rec: KeyRecord | null;
	state: RowState;
}

export interface Winner {
	readonly row: KRow;
	/** Seq of the winner's bytes in `k` this vaultEpoch (firstSeq(e), S_rot); null until seen (§11.5, §14.3). */
	seq: Seq | null;
}

export type StaleVerdict = "stale" | "hold" | null;

export class KeyBook {
	readonly rows: KRow[] = [];
	readonly winners = new Map<number, Winner>();
	readonly source = new Map<number, KeySource>();
	/** Bumped whenever the winner set changes (what main must store). */
	version = 0;
	private readonly seqs = new Set<Seq>();

	/** A stored winner from init (§18.4 `records`). Returns false for unreadable bytes. */
	addStored(bytes: Uint8Array): boolean {
		const rec = decodeKeyRecord(bytes);
		if (!rec || this.winners.has(rec.e)) return false;
		const row: KRow = { seq: null, bytes, rec, state: "winner" };
		this.winners.set(rec.e, { row, seq: null });
		return true;
	}

	/** A `k` row. null: this seq was already ingested. */
	add(seq: Seq, bytes: Uint8Array): KRow | null {
		if (this.seqs.has(seq)) return null;
		this.seqs.add(seq);
		const rec = decodeKeyRecord(bytes);
		const row: KRow = { seq, bytes, rec, state: rec ? "pending" : "garbage" };
		let i = this.rows.length;
		while (i > 0 && (this.rows[i - 1]!.seq ?? 0) > seq) i--;
		this.rows.splice(i, 0, row);
		if (rec) {
			const w = this.winners.get(rec.e);
			if (w) this.settle(w, row);
		}
		return row;
	}

	decide(e: number, row: KRow): void {
		row.state = "winner";
		const w: Winner = { row, seq: row.seq };
		this.winners.set(e, w);
		this.source.set(e, "verified");
		this.version++;
		for (const r of this.rows) if (r !== row && r.rec?.e === e && r.state === "pending") this.settle(w, r);
	}

	private settle(w: Winner, row: KRow): void {
		if (bytesEqual(row.bytes, w.row.bytes)) {
			row.state = "same";
			if (w.seq === null || (row.seq !== null && row.seq < w.seq)) w.seq = row.seq;
		} else row.state = "duplicate";
	}

	/** §11.3: a roll for e is not adopted while a revoke for an epoch ≥ e exists, pending or valid. */
	blocksRoll(e: number): boolean {
		for (const w of this.winners.values()) if (w.row.rec!.kind === KeyRecordKind.revoke && w.row.rec!.e >= e) return true;
		return this.rows.some((r) => r.rec?.kind === KeyRecordKind.revoke && r.rec.e >= e && (r.state === "pending" || r.state === "duplicate"));
	}

	highestWinner(): number {
		let h = 0;
		for (const e of this.winners.keys()) if (e > h) h = e;
		return h;
	}

	/** Highest epoch whose winner's key this device holds. */
	highestKeyed(): number {
		let h = 0;
		for (const [e, s] of this.source) if (s === "verified" && this.winners.has(e) && e > h) h = e;
		return h;
	}

	highestRevokeWinner(): number {
		let h = 0;
		for (const [e, w] of this.winners) if (w.row.rec!.kind === KeyRecordKind.revoke && e > h) h = e;
		return h;
	}

	/**
	 * Revoke rows this device cannot settle and that may outrank its keys: pending ones, and (the live race) a
	 * revoke that arrived after a roll already won its epoch, above every revoke that won (§11.3, §14.3).
	 */
	openRevokes(): readonly KRow[] {
		const hr = this.highestRevokeWinner();
		return this.rows.filter((r) => {
			if (r.rec?.kind !== KeyRecordKind.revoke) return false;
			if (r.state === "pending") return !this.winners.has(r.rec.e);
			return r.state === "duplicate" && r.rec.e > hr && this.winners.get(r.rec.e)?.row.rec!.kind === KeyRecordKind.roll;
		});
	}

	/**
	 * §14.3 for a frame (seq) or a checkpoint (coversSeq) sealed under keyEpoch: stale for a winning revoke r with
	 * keyEpoch < r past S_rot; "hold" (reader-dependent) past an open revoke, until it is settled.
	 */
	staleCheck(keyEpoch: number, seq: Seq): StaleVerdict {
		for (const [r, w] of this.winners) {
			if (w.row.rec!.kind === KeyRecordKind.revoke && keyEpoch < r && w.seq !== null && seq > w.seq) return "stale";
		}
		for (const row of this.openRevokes()) if (keyEpoch < row.rec!.e && seq > row.seq!) return "hold";
		return null;
	}

	/** Stored winners whose epoch has no record in `k` (§11.5), in epoch order. */
	republishable(): readonly Uint8Array[] {
		const seen = new Set<number>();
		for (const r of this.rows) if (r.rec) seen.add(r.rec.e);
		return [...this.winners.entries()].filter(([e]) => !seen.has(e)).sort((a, b) => a[0] - b[0]).map(([, w]) => w.row.bytes);
	}

	/** Every winning record by epoch: what main stores (§6.1). */
	records(): readonly Uint8Array[] {
		return [...this.winners.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w.row.bytes);
	}

	anyRecord(): boolean {
		return this.rows.some((r) => r.rec !== null);
	}
}
