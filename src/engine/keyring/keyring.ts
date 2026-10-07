/**
 * The keyring engine (e2ee-design §11, §12.4, §14). It owns the KeyBook, judges `k` rows (evaluate.ts), hands
 * new keys and the winning records to the host before anything is sealed under them (§18.4 persist-before-use),
 * and answers what the write gate and the stale-epoch rule need. Operations run one at a time.
 *
 * The engine never sets a pin: an unpinned keyring only reports, and persists a key once it verifies against a
 * valid record (§12.4 (i)); main then pins suite 1 and restarts the engine.
 */

import { bytesEqual } from "../../core/codec/lib0";
import type { Seq } from "../../core/types";
import type { CryptoPort, KeyringCrypto } from "../../ports/crypto";
import type { KeyMissingReason } from "../../protocol/status";
import { KeyBook, type KRow, type StaleVerdict } from "./book";
import { buildKeyRecord } from "./build";
import { evaluate } from "./evaluate";
import { KeyRecordKind, decodeKeyRecord } from "./record";

type Fields = Record<string, string | number | boolean | null>;

export type KeyringMode = "suite1" | "suite0" | "unpinned";

/** keyringChanged (§18.4). SECRET: `keys`. */
export interface KeyringChange {
	/** Keys main has not stored yet, each once. */
	readonly keys: readonly { readonly e: number; readonly k: Uint8Array }[];
	/** Every winning record, by epoch, then (suite 1) the revokes held open (§11.5, KeyBook.openRecords): the full set. */
	readonly records: readonly Uint8Array[];
	/** Epoch of an own key whose record is not decided yet (§11.4 step 2); a stored key at an epoch with neither a record nor this may be dropped. */
	readonly pending: number | null;
}

export interface KeyringOptions {
	readonly mode: KeyringMode;
	readonly vaultId: string;
	/** suite1: required. unpinned: needed only to take a QR key or the RK (§12.4 (i)). */
	readonly kc?: (KeyringCrypto & Pick<CryptoPort, "keyState" | "sealEpoch">) | null;
	/** Winners decided before and revokes held open (SecretStorage `records`, §6.1, §11.5). */
	readonly records?: readonly Uint8Array[];
	readonly keyringSeen?: boolean;
	/** Must resolve only once main has stored the change. */
	readonly persist?: (c: KeyringChange) => Promise<void>;
	readonly diag?: (code: string, fields: Fields) => void;
	/** An unpinned device read its first `k` record: main stores the sticky `keyringSeen` (§12.4). */
	readonly onKeyringSeen?: () => void;
}

export type QrResult = "verified" | "pending" | "conflict" | "same";
export type OwnOutcome = "won" | "lost" | "pending";

export class Keyring {
	private readonly book = new KeyBook();
	private readonly kc: NonNullable<KeyringOptions["kc"]> | null;
	private rk: Uint8Array | null = null;
	private own: { readonly e: number; readonly kind: KeyRecordKind; readonly bytes: Uint8Array } | null = null;
	/** `rk` came with the own genesis or revoke (propose), not from installRk: it goes once that record settles. */
	private rkOwn = false;
	private persistedVersion = 0;
	private persistedOpen: readonly Uint8Array[] = [];
	private persistedPending: number | null = null;
	private unsent: { readonly e: number; readonly k: Uint8Array }[] = [];
	private readonly reported = new WeakSet<KRow>();
	private queue: Promise<unknown> = Promise.resolve();
	private seen: boolean;
	private disposed = false;

	private constructor(private readonly o: KeyringOptions) {
		this.kc = o.kc ?? null;
		this.seen = o.keyringSeen ?? false;
		if (o.mode === "suite1" && !this.kc) throw new Error("keyring: suite 1 needs KeyringCrypto");
	}

	static async open(o: KeyringOptions): Promise<Keyring> {
		const k = new Keyring(o);
		await k.run(async () => {
			// A stored revoke whose key is not held was stored open (a winner's key is stored with it, §18.4).
			for (const b of o.mode === "suite1" ? (o.records ?? []) : []) {
				const rec = decodeKeyRecord(b);
				const open = rec?.kind === KeyRecordKind.revoke && !k.kc!.keyState(rec.e).held;
				if (!(open ? k.book.addStoredOpen(b) : k.book.addStored(b))) k.diag("keyring/garbage", { stored: true });
			}
			k.persistedVersion = k.book.version;
			k.persistedOpen = k.book.openRecords();
			await k.settleAll();
		});
		return k;
	}

	get mode(): KeyringMode {
		return this.o.mode;
	}
	get keyringSeen(): boolean {
		return this.seen;
	}
	/** Rows of `k` seen this vaultEpoch, garbage included (§12.4 (ii): "k read to head is empty"). */
	get rowCount(): number {
		return this.book.kRows().length;
	}

	/** `k` rows (catch-up, live or the stored tail), any order; already-seen seqs are skipped. */
	ingest(rows: readonly { readonly seq: Seq; readonly bytes: Uint8Array }[]): Promise<void> {
		return this.run(async () => {
			let added = false;
			for (const r of rows) added = this.book.add(r.seq, r.bytes) !== null || added;
			if (!added) return;
			if (this.book.anyRecord() && !this.seen) {
				this.seen = true;
				if (this.o.mode === "unpinned") this.o.onKeyringSeen?.();
			}
			await this.settleAll();
		});
	}

	/** A QR key (§12.1, §14.2 step 3). Zero-fills `raw`. Nothing is persisted unless it verifies. */
	installQr(e: number, raw: Uint8Array): Promise<QrResult> {
		return this.run(async () => {
			if (!this.kc) {
				raw.fill(0);
				throw new Error("keyring: no KeyringCrypto");
			}
			const res = await this.kc.install(e, raw);
			if (res === "conflict") this.diag("keyring/conflict", { e, source: "qr" });
			if (res !== "installed") return res;
			this.book.source.set(e, "oob");
			await this.settleAll();
			const s = this.book.source.get(e);
			return s === "verified" ? "verified" : s === "oob" ? "pending" : "conflict";
		});
	}

	/** The RK (§12.4, §13.3). Held in memory while a genesis or revoke row still needs it; zero-filled after. */
	installRk(rk: Uint8Array): Promise<"verified" | "pending"> {
		return this.run(async () => {
			if (!this.kc) {
				rk.fill(0);
				throw new Error("keyring: no KeyringCrypto");
			}
			this.takeRk(rk);
			await this.settleAll();
			return this.book.highestKeyed() > 0 ? "verified" : "pending";
		});
	}

	/**
	 * Steps 1-2 of a roll (§11.4), a revoke (§14.2) or the genesis (§15.1): generate K_e, build the record and
	 * persist the pending key. The caller appends `bytes` to `k`, reads `k` through the receipt and calls settleOwn.
	 * `rk` (genesis, revoke) is copied and held until the record settles, so that an earlier record for e under the
	 * same RK is judged with it rather than outvoted by the own key (§11.3); the caller zero-fills its own copy.
	 */
	propose(kind: KeyRecordKind, rk?: Uint8Array): Promise<{ readonly e: number; readonly bytes: Uint8Array }> {
		return this.run(async () => {
			const kc = this.kc;
			if (!kc || this.own) throw new Error(kc ? "keyring: a record is already in flight" : "keyring: no KeyringCrypto");
			const genesis = kind === KeyRecordKind.genesis;
			if (genesis && (this.book.rows.length > 0 || this.book.winners.size > 0)) throw new Error("keyring: genesis needs an empty k and no stored record");
			const e = genesis ? 1 : this.book.highestWinner() + 1;
			if (!genesis && this.book.source.get(e - 1) !== "verified") throw new Error(`keyring: epoch ${e - 1} is not keyed`);
			if (kind !== KeyRecordKind.roll && !rk) throw new Error("keyring: the recovery key is required");
			await kc.generate(e);
			this.book.source.set(e, "own");
			try {
				const bytes = await buildKeyRecord(kc, this.o.vaultId, e, kind, rk);
				this.own = { e, kind, bytes };
				if (rk) {
					this.zeroRk();
					this.rk = rk.slice();
					this.rkOwn = true;
				}
				if (!(await this.flush())) throw new Error("keyring: persist failed");
				return { e, bytes };
			} catch (err) {
				this.own = null;
				this.dropOwn(e);
				this.releaseRk();
				throw err;
			}
		});
	}

	/**
	 * After `k` was read through the own record's receipt (§11.4 step 4). "won": new seals use e. An own genesis read
	 * in `k` but undecided sits behind a genesis this device cannot judge (evaluate.ts): it lost, and its K_1 goes.
	 */
	settleOwn(): Promise<OwnOutcome | null> {
		return this.run(async () => {
			const own = this.own;
			if (!own) return null;
			const w = this.book.winners.get(own.e);
			if (!w && (own.kind !== KeyRecordKind.genesis || !this.book.rows.some((r) => bytesEqual(r.bytes, own.bytes)))) return "pending";
			const won = w !== undefined && bytesEqual(w.row.bytes, own.bytes);
			this.own = null;
			if (!w) this.dropOwn(own.e);
			this.releaseRk();
			await this.flush();
			return won ? "won" : "lost";
		});
	}

	/** The own record will not commit (refused, or the flow was cancelled): drop its key unless its epoch is decided. */
	abandonOwn(): Promise<void> {
		return this.run(async () => {
			if (!this.own) return;
			const e = this.own.e;
			this.own = null;
			if (!this.book.winners.has(e)) this.dropOwn(e);
			this.releaseRk();
			await this.flush();
		});
	}

	keyMissing(): KeyMissingReason | null {
		if (this.o.mode === "suite0") return this.book.anyRecord() ? "encrypted-vault" : null;
		if (this.o.mode === "unpinned") return this.seen ? "encrypted-vault" : "no-pin";
		const hk = this.book.highestKeyed();
		if (this.book.openRevokes().some((r) => r.state === "duplicate" || r.rec!.e > hk)) return "revoked-epoch";
		if (this.book.highestRevokeWinner() > hk) return "revoked-epoch";
		// A newer winner without its key, or persist-before-use: until main stores the newest key, nothing is sealed (§18.4).
		return hk === 0 || this.book.highestWinner() > hk || this.kc!.sealEpoch() !== hk ? "no-key" : null;
	}

	sealEpoch(): number {
		return this.o.mode === "suite1" ? this.kc!.sealEpoch() : 0;
	}

	/** §14.3, for a frame's seq or a checkpoint's coversSeq. */
	staleCheck(keyEpoch: number, seq: Seq): StaleVerdict {
		return this.o.mode === "suite1" ? this.book.staleCheck(keyEpoch, seq) : null;
	}

	/** Highest winning revoke: own frames sealed below it are re-sealed before sending (§14.2 step 4). */
	minSendEpoch(): number {
		return this.book.highestRevokeWinner();
	}

	/** Stored winners with no record in `k` this vaultEpoch (§11.5). */
	republishable(): readonly Uint8Array[] {
		return this.o.mode === "suite1" ? this.book.republishable() : [];
	}

	/** §4.2: headSeq − firstSeq(e) ≥ span, or own seals under e ≥ maxSeals. */
	rollDue(headSeq: Seq, ownSeals: number, span: number, maxSeals: number): boolean {
		if (this.o.mode !== "suite1" || this.own || this.keyMissing() !== null) return false;
		const e = this.kc!.sealEpoch();
		if (e === 0 || e !== this.book.highestWinner()) return false;
		const first = this.book.winners.get(e)!.seq;
		return ownSeals >= maxSeals || (first !== null && headSeq - first >= span);
	}

	/** Diagnostics only: no key bytes (MetaKeyring, §18.3). */
	summary(): { readonly epochs: readonly { readonly e: number; readonly firstSeq: Seq | null; readonly kind: number; readonly verified: boolean }[]; readonly revokeEpoch: number | null; readonly sRot: Seq | null } {
		const epochs = [...this.book.winners.entries()].sort((a, b) => a[0] - b[0])
			.map(([e, w]) => ({ e, firstSeq: w.seq, kind: w.row.rec!.kind, verified: this.book.source.get(e) === "verified" }));
		const r = this.book.highestRevokeWinner();
		return { epochs, revokeEpoch: r || null, sRot: r ? (this.book.winners.get(r)!.seq ?? null) : null };
	}

	/**
	 * The engine is done with this keyring (stop, a new vaultEpoch, the gate's check): zero-fill the RK and drop
	 * from the adapter every key main has not stored. The adapter exports a key once, so the next keyring on the same
	 * port would take it for stored and seal under it (§18.4); dropped, it is derived (or entered) and handed over again.
	 */
	dispose(): void {
		this.disposed = true;
		this.zeroRk();
		this.dropUnstored(this.unsent);
		this.unsent = [];
	}

	private async settleAll(): Promise<void> {
		if (this.kc && this.o.mode !== "suite0") {
			await evaluate(this.book, { kc: this.kc, vaultId: this.o.vaultId, rk: this.rk, diag: (c, f) => this.diag(c, f) });
		}
		for (const r of this.book.rows) {
			if (this.reported.has(r) || (r.state !== "duplicate" && r.state !== "garbage")) continue;
			this.reported.add(r);
			this.diag(r.state === "garbage" ? "keyring/garbage" : "keyring/duplicate", { e: r.rec?.e ?? null, seq: r.seq });
		}
		const rkWanted = this.rkOwn || this.book.highestKeyed() === 0 || this.book.rows.some((r) => r.state === "pending" && r.rec!.kind !== KeyRecordKind.roll);
		if (this.rk && !rkWanted) this.zeroRk();
		await this.flush();
	}

	/** Persist new keys and the winner set, then move the seal epoch up. false: persist failed, nothing advanced. */
	private async flush(): Promise<boolean> {
		const kc = this.kc;
		if (!kc || this.o.mode === "suite0") return true;
		const keys = [...this.unsent, ...kc.exportForHost()];
		const pending = this.own && !this.book.winners.has(this.own.e) ? this.own.e : null;
		const version = this.book.version;
		// Open revokes go with the winners (§11.5): a reset or restore that drops one from `k` must not reopen the gate.
		const open = this.o.mode === "suite1" ? this.book.openRecords() : [];
		const openChanged = open.length !== this.persistedOpen.length || open.some((b, i) => !bytesEqual(b, this.persistedOpen[i]!));
		if (keys.length > 0 || version !== this.persistedVersion || openChanged || pending !== this.persistedPending) {
			if (!this.o.persist) throw new Error("keyring: no persist hook");
			try {
				await this.o.persist({ keys, records: [...this.book.records(), ...open], pending });
			} catch (err) {
				this.diag("keyring/persist-failed", { error: String(err) });
				if (this.disposed) this.dropUnstored(keys);
				else this.unsent = keys;
				return false;
			}
			this.unsent = [];
			this.persistedVersion = version;
			this.persistedOpen = open;
			this.persistedPending = pending;
		}
		const hk = this.book.highestKeyed();
		if (hk > kc.sealEpoch()) kc.setSealEpoch(hk);
		return true;
	}

	private takeRk(rk: Uint8Array): void {
		this.zeroRk();
		this.rk = rk.slice();
		rk.fill(0);
	}

	private zeroRk(): void {
		this.rk?.fill(0);
		this.rk = null;
		this.rkOwn = false;
	}

	/** The own record settled or was abandoned: the RK it came with is no longer needed. */
	private releaseRk(): void {
		if (this.rkOwn) this.zeroRk();
	}

	/** Keys main did not store: zero-filled, and out of the adapter unless one is already sealed under. */
	private dropUnstored(keys: readonly { readonly e: number; readonly k: Uint8Array }[]): void {
		for (const x of keys) {
			x.k.fill(0);
			if (this.kc && x.e !== this.kc.sealEpoch()) this.kc.drop(x.e);
		}
	}

	private dropOwn(e: number): void {
		if (this.book.source.get(e) !== "own") return;
		this.kc!.drop(e);
		this.book.source.delete(e);
	}

	private diag(code: string, fields: Fields): void {
		this.o.diag?.(code, fields);
	}

	private run<T>(fn: () => Promise<T>): Promise<T> {
		const p = this.queue.then(fn);
		this.queue = p.catch(() => undefined);
		return p;
	}
}
