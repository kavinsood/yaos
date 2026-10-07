/**
 * The keyring inside a running engine (e2ee-design §9.3, §11.4, §11.5, §12.4, §15.1). It feeds `k` rows to the
 * Keyring, answers the write gate, moves the phase between key-missing and live, and runs the own-record flows:
 * genesis (creation path), roll (§4.2 trigger), revoke (§14.2) and the re-publish after a reset (§11.5).
 *
 * Own `k` records are appended on the session directly, not through the outbox: they carry no envelope and are
 * never sealed, and a lost append is sent again with the same clientFrameId (the relay deduplicates it). A
 * receipt becomes the tail row it stands for (the bytes are known), so the keyring judges it in seq order (R2:
 * every `k` row below the receipt's seq was delivered before it).
 *
 * The stale-epoch rule (§14.3) is answered only while every `k` row that can precede the row being gated is
 * judged; otherwise the row is held (reader-dependent) and re-gated after the next keyring change.
 */

import { newClientFrameId } from "../../core/codec/ids";
import { KEYRING_STREAM, type ClientFrameId, type Seq } from "../../core/types";
import type { TimerHandle } from "../../ports/clock";
import type { RelayEvent } from "../../ports/relay";
import type { E2eeStatus, KeyMissingReason } from "../../protocol/status";
import type { EngineCtx } from "../runtime/context";
import { regateUnopened, retryReaderQuarantine } from "../runtime/quarantineRelease";
import type { TailRecord } from "../store/schema";
import { keyRecordRow } from "../sync/ingestRow";
import type { StaleVerdict } from "./book";
import { Keyring, type KeyringChange, type OwnOutcome, type QrResult } from "./keyring";
import { KeyRecordKind } from "./record";
import { KeyringRefusedError, keyringCryptoOf } from "./writeGate";

/** EngineOptions.e2ee: the pin main read from data.json (§12.4). Required: there is no default suite. */
export type EngineE2ee =
	| { readonly suite: 0 }
	| { readonly suite: 1; readonly records: readonly Uint8Array[]; readonly persist: (c: KeyringChange) => Promise<void> }
	| { readonly suite: null; readonly creating: boolean; readonly keyringSeen: boolean; readonly persist: (c: KeyringChange) => Promise<void> };

interface OwnFlow {
	readonly e: number;
	readonly bytes: Uint8Array;
	readonly cfid: ClientFrameId;
	/** Seq of the own record in `k`, once receipted or read. */
	seq: Seq | null;
	readonly resolve: (o: OwnOutcome) => void;
	readonly reject: (e: Error) => void;
}

const META_WRITE_MS = 30_000;

export class KeyringRuntime {
	/** Session generation in which `k` was read to VAULT_READY.head (§12.4 (ii), §15.1 step 3). */
	private kReadGen = -1;
	private headZero = false;
	private wasBlocked = true;
	private flow: OwnFlow | null = null;
	/** Own `k` appends without a receipt yet (the flow's record, re-publishes): cfid -> bytes. */
	private readonly unreceipted = new Map<ClientFrameId, Uint8Array>();
	private retryTimer: TimerHandle | null = null;
	/** Own seals under `epoch` (§4.2), and what MetaKeyring holds. */
	private seals = { epoch: 0, n: 0 };
	private stored = { sum: "", n: 0, atMono: -Infinity };
	/** Highest `k` seq that arrived on a session (a live row or an own receipt), judged or not. */
	private kArrived: Seq = 0;
	/** The keyring has judged every stored `k` row through this seq (ingestTail). */
	private kJudged: Seq = 0;

	private constructor(private readonly c: EngineCtx, readonly kr: Keyring, readonly suite: 0 | 1 | null, private readonly creating: boolean) {}

	static async open(c: EngineCtx, e2ee: EngineE2ee): Promise<KeyringRuntime> {
		const crypto = c.ports.crypto;
		const kc = keyringCryptoOf(crypto);
		if (e2ee.suite === 0 && crypto.suite !== 0) throw new Error("e2ee: a suite-0 pin needs the suite-0 crypto port");
		if (e2ee.suite === 1 && (crypto.suite !== 1 || !kc)) throw new Error("e2ee: a suite-1 pin needs the suite-1 crypto port");
		const persist = e2ee.suite === 0 ? undefined : (ch: KeyringChange) => e2ee.persist(ch);
		const kr = await Keyring.open({
			mode: e2ee.suite === 0 ? "suite0" : e2ee.suite === 1 ? "suite1" : "unpinned",
			vaultId: c.opts.vaultId,
			kc: e2ee.suite === 0 ? null : kc,
			records: e2ee.suite === 1 ? e2ee.records : [],
			keyringSeen: e2ee.suite === null && e2ee.keyringSeen,
			persist,
			diag: (code, f) => c.diag(code, f),
			onKeyringSeen: () => c.scheduleStatus(),
		});
		const rt = new KeyringRuntime(c, kr, e2ee.suite, e2ee.suite === null && e2ee.creating);
		const meta = await c.repo.getMeta("keyring");
		if (meta?.key === "keyring" && meta.sealEpoch === kr.sealEpoch()) rt.seals = { epoch: meta.sealEpoch, n: meta.ownSeals };
		await rt.ingestTail();
		rt.wasBlocked = rt.blocked();
		return rt;
	}

	/**
	 * The stored `k` rows through appliedSeq, the prefix known to be complete: the keyring decides winners in seq
	 * order (§11.3), so a live row past a gap waits in the tail until the read below it lands. Rows already
	 * ingested are skipped by seq (KeyBook.add).
	 */
	private async ingestTail(): Promise<void> {
		const through = this.c.repo.stream(KEYRING_STREAM)?.appliedSeq ?? 0;
		if (through === 0) return;
		const rows = (await this.c.repo.getTail(KEYRING_STREAM)).filter((r) => r.seq <= through);
		if (rows.length > 0) await this.kr.ingest(rows.map((r) => ({ seq: r.seq, bytes: r.content })));
		if (through > this.kJudged) this.kJudged = through;
	}

	// ------------------------------------------------------------------ §14.3

	/** sessionLoop, at arrival (before any batching): a `k` row or an own `k` receipt. */
	noteArrived(ev: RelayEvent): void {
		const seq = ev.t === "committed" && ev.frame.stream === KEYRING_STREAM ? ev.frame.seq : ev.t === "receipt" && ev.stream === KEYRING_STREAM ? ev.seq : 0;
		if (seq > this.kArrived) this.kArrived = seq;
	}

	/**
	 * Every `k` row that can precede a row being gated now is judged. On a session the rows below a row arrive
	 * before it (R2), in the session's `k` read or live; so: `k` was read to head on this session, every `k` row
	 * that arrived since is stored and judged, and `k` is not stale (rows known from a feed only).
	 */
	private kComplete(): boolean {
		const k = this.c.repo.stream(KEYRING_STREAM);
		return this.c.session !== null && this.kReadGen === this.c.gen && !k?.stale && this.kArrived <= this.kJudged;
	}

	/** GateCtx.staleCheck (gate.ts). seq null: a provisional, which commits after everything judged so far. */
	staleCheck(keyEpoch: number, seq: Seq | null): StaleVerdict {
		if (this.suite !== 1) return null;
		if (!this.kComplete()) return "hold";
		return this.kr.staleCheck(keyEpoch, seq ?? Number.MAX_SAFE_INTEGER);
	}

	// ------------------------------------------------------------------ gate

	keyMissing(): KeyMissingReason | null {
		return this.kr.keyMissing();
	}
	blocked(): boolean {
		return this.kr.keyMissing() !== null;
	}
	/** Unpinned, or a vault this pin cannot read: only `k` is read (§9.3, §12.4); ns, cfg and bodies wait. */
	readsOnlyK(): boolean {
		const m = this.kr.keyMissing();
		return m === "no-pin" || m === "encrypted-vault";
	}
	/** §15.1 step 3: started with `creating`, read VAULT_READY.head = 0 and `k` to head, empty, on this session. */
	creatable(): boolean {
		return this.suite === null && this.creating && this.headZero && this.kReadGen === this.c.gen && this.c.session !== null && this.kr.rowCount === 0;
	}
	status(): E2eeStatus {
		return { suite: this.suite, sealEpoch: this.kr.sealEpoch(), keyMissing: this.kr.keyMissing(), keyringSeen: this.kr.keyringSeen, creatable: this.creatable() };
	}
	/** Every seal of the gated crypto port (writeGate.ts). */
	noteSeal(): void {
		const e = this.kr.sealEpoch();
		if (e !== this.seals.epoch) this.seals = { epoch: e, n: 0 };
		this.seals.n++;
	}

	/** After any keyring change: settle the own record, then open or shut the gate. */
	private async afterChange(): Promise<void> {
		const f = this.flow;
		if (f && f.seq !== null) {
			const o = await this.kr.settleOwn();
			if (o === "won" || o === "lost") this.finish(f, o);
		}
		const c = this.c;
		// New keys, a settled revoke or more of `k` judged: held and unopened rows are re-gated (§9.3, §14.3).
		if (this.suite === 1 && c.session) {
			await regateUnopened(c).catch((e) => c.diag("unopened-regate-failed", { error: String(e) }));
			void retryReaderQuarantine(c).catch((e) => c.diag("quarantine-retry-failed", { error: String(e) }));
		}
		const b = this.blocked();
		c.scheduleStatus();
		if (b === this.wasBlocked) return;
		this.wasBlocked = b;
		c.diag("keyring/gate", { open: !b, reason: this.kr.keyMissing() });
		if (c.phase === "live" || c.phase === "daily-limit" || c.phase === "key-missing") c.setPhase(c.livePhase());
		if (b) return;
		c.sender.pump();
		for (const h of [...c.handles.all()]) if (!h.builder.empty) void c.docs.closeFrame(h);
		c.sess.scheduleCatchUp();
	}

	// ------------------------------------------------------------------ rows

	/**
	 * After a live batch (or, `read`, a `k` read) stored `rows`: own appends are settled and the complete `k` prefix
	 * goes to the keyring. A read can complete the prefix without new rows (live rows past a gap were stored).
	 */
	async ingestRows(rows: readonly TailRecord[], read = false): Promise<void> {
		const k = rows.filter((r) => r.stream === KEYRING_STREAM);
		if (k.length === 0 && !read) return;
		for (const r of k) {
			if (r.deviceId !== this.c.self) continue;
			this.unreceipted.delete(r.clientFrameId);
			if (this.flow?.cfid === r.clientFrameId) this.flow.seq = r.seq;
		}
		await this.ingestTail();
		await this.afterChange();
	}

	/** A receipt for an own `k` append: the row it stands for (liveIngest stores it as a committed row). */
	receiptRow(ev: Extract<RelayEvent, { t: "receipt" }>): TailRecord | null {
		const bytes = ev.stream === KEYRING_STREAM ? this.unreceipted.get(ev.clientFrameId) : undefined;
		if (!bytes) return null;
		return keyRecordRow({ stream: KEYRING_STREAM, seq: ev.seq, deviceId: this.c.self, clientFrameId: ev.clientFrameId, payload: bytes });
	}

	/** Session start, after `k` was read to head (sessionLoop): resend or settle the own record, then re-publish. */
	async afterKRead(gen: number, headSeq: Seq): Promise<void> {
		const c = this.c;
		if (gen !== c.gen) return;
		this.kReadGen = gen;
		this.headZero = headSeq === 0;
		const f = this.flow;
		if (f && f.seq === null) {
			const o = await this.kr.settleOwn();
			if (o === "won" || o === "lost") this.finish(f, o);
			else this.send(f.cfid, f.bytes);
		}
		// §11.5: stored winners missing from `k` (a reset or restore), verbatim, in epoch order.
		if (this.suite === 1 && !this.blocked()) {
			for (const b of this.kr.republishable()) {
				c.diag("keyring/republish", { bytes: b.length });
				this.send(newClientFrameId(c.ports.random), b);
			}
		}
		await this.afterChange();
	}

	// ------------------------------------------------------------------ own records

	private send(cfid: ClientFrameId, bytes: Uint8Array): void {
		this.unreceipted.set(cfid, bytes);
		const s = this.c.session;
		if (!s || !s.canWrite || this.kReadGen !== this.c.gen) return; // sent again after the next session's `k` read
		s.append({ stream: KEYRING_STREAM, clientFrameId: cfid, payload: bytes });
	}

	/** §11.4 steps 2-4 (also §14.2, §15.1): persist the pending key, append, settle once `k` shows the record. */
	private async runOwn(kind: KeyRecordKind, rk?: Uint8Array): Promise<OwnOutcome> {
		if (this.flow) throw new KeyringRefusedError("a key record is already in flight");
		const own = await this.kr.propose(kind, rk);
		return new Promise<OwnOutcome>((resolve, reject) => {
			const f: OwnFlow = { e: own.e, bytes: own.bytes, cfid: newClientFrameId(this.c.ports.random), seq: null, resolve, reject };
			this.flow = f;
			this.c.diag("keyring/propose", { e: own.e, kind });
			this.send(f.cfid, f.bytes);
		});
	}

	private finish(f: OwnFlow, o: OwnOutcome): void {
		if (this.flow !== f) return;
		this.flow = null;
		this.unreceipted.delete(f.cfid);
		this.c.diag("keyring/own-settled", { e: f.e, outcome: o });
		f.resolve(o);
	}

	private async fail(f: OwnFlow, why: string): Promise<void> {
		if (this.flow !== f) return;
		this.flow = null;
		this.unreceipted.delete(f.cfid);
		await this.kr.abandonOwn();
		f.reject(new Error(`keyring: own record not committed (${why})`));
		await this.afterChange();
	}

	/** A refusal on `k` (sessionLoop). true: it was a `k` frame. */
	onRefused(ev: Extract<RelayEvent, { t: "refused" }>): boolean {
		if (ev.stream !== KEYRING_STREAM) return false;
		const bytes = this.unreceipted.get(ev.clientFrameId);
		if (!bytes) return true;
		if (ev.reason === "durability") this.send(ev.clientFrameId, bytes);
		else if (ev.reason === "daily-limit") {
			if (this.retryTimer !== null) this.c.ports.clock.clearTimer(this.retryTimer);
			this.retryTimer = this.c.ports.clock.setTimer(ev.retryAfterMs ?? 60_000, () => {
				this.retryTimer = null;
				const b = this.unreceipted.get(ev.clientFrameId);
				if (b) this.send(ev.clientFrameId, b);
			});
		} else {
			this.unreceipted.delete(ev.clientFrameId);
			if (this.flow?.cfid === ev.clientFrameId) void this.fail(this.flow, ev.reason);
		}
		return true;
	}

	/** Session closed: re-publishes are recomputed next session; the own record is resent after the `k` read. */
	onClosed(): void {
		for (const cfid of [...this.unreceipted.keys()]) if (cfid !== this.flow?.cfid) this.unreceipted.delete(cfid);
	}

	// ------------------------------------------------------------------ commands (§18.4)

	async installQr(e: number, k: Uint8Array): Promise<QrResult> {
		const r = await this.kr.installQr(e, k);
		await this.afterChange();
		return r;
	}

	async installRk(rk: Uint8Array): Promise<"verified" | "pending"> {
		const r = await this.kr.installRk(rk);
		await this.afterChange();
		return r;
	}

	/** §15.1 steps 3-4: only while creatable; resolves once the genesis won and main stored K_1 and the record. */
	async enableE2ee(rk: Uint8Array): Promise<void> {
		try {
			if (!this.creatable()) throw new KeyringRefusedError("not on the creation path (needs VAULT_READY.head = 0 and an empty k, read on this session)");
			const o = await this.runOwn(KeyRecordKind.genesis, rk);
			if (o !== "won") throw new KeyringRefusedError("another genesis won; this device stays unpinned");
		} finally {
			rk.fill(0);
		}
	}

	/** §12.4 (ii), (iii): whether main may pin suite 0. The engine never pins; main pins and restarts it. */
	pinSuite0(source: "link" | "create"): void {
		if (this.suite !== null) throw new KeyringRefusedError("this device is already pinned");
		if (source === "create" && !this.creatable()) throw new KeyringRefusedError("not on the creation path");
		if (source === "link") {
			if (this.kr.keyringSeen) throw new KeyringRefusedError("this device has read an encryption key record for the vault");
			if (this.kReadGen !== this.c.gen || !this.c.session) throw new KeyringRefusedError("k is not read to head yet");
			if (this.kr.rowCount > 0) throw new KeyringRefusedError("k is not empty");
		}
	}

	/** §14.2 step 2: a revoke record for r = highest epoch + 1 under `rk` (zero-filled). */
	async revokeRekey(rk: Uint8Array): Promise<OwnOutcome> {
		try {
			if (this.suite !== 1) throw new KeyringRefusedError("revoke needs a suite-1 pin");
			return await this.runOwn(KeyRecordKind.revoke, rk);
		} finally {
			rk.fill(0);
		}
	}

	// ------------------------------------------------------------------ maintenance

	/** Maintenance tick: MetaKeyring (lazy, §4.2) and the roll trigger. */
	async tick(): Promise<void> {
		const c = this.c;
		if (this.suite !== 1) return;
		const base = { sealEpoch: this.kr.sealEpoch(), ...this.kr.summary() };
		const sum = JSON.stringify(base);
		const n = this.ownSeals();
		if (sum !== this.stored.sum || (n !== this.stored.n && c.mono() - this.stored.atMono >= META_WRITE_MS)) {
			await c.repo.putKeyringMeta({ key: "keyring", ...base, ownSeals: n });
			this.stored = { sum, n, atMono: c.mono() };
		}
		if (this.flow || !c.session?.canWrite || c.phase !== "live") return;
		if (!this.kr.rollDue(c.repo.cursor.headSeqSeen, this.ownSeals(), c.tuning.rollSeqSpan, c.tuning.rollOwnSeals)) return;
		void this.runOwn(KeyRecordKind.roll).then(
			(o) => c.diag("keyring/roll", { outcome: o }),
			(e) => c.diag("keyring/roll-failed", { error: String(e) }),
		);
	}

	private ownSeals(): number {
		return this.seals.epoch === this.kr.sealEpoch() ? this.seals.n : 0;
	}

	stop(): void {
		if (this.retryTimer !== null) this.c.ports.clock.clearTimer(this.retryTimer);
		this.retryTimer = null;
		const f = this.flow;
		this.flow = null;
		f?.reject(new Error("keyring: engine stopped"));
		this.kr.dispose();
	}
}
