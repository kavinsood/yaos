/**
 * The engine of a device whose gate is closed (pinGate.ts; e2ee-design §12.4): it connects, reads `k` to head, reads
 * again on every live `k` frame, and judges the rows with a Keyring (keyring.ts). It holds no store, no outbox and no
 * seal or blob port, and its relay cannot put a checkpoint. It appends only on the creation path, only on `k`, and
 * only the genesis of enableE2ee (§15.1). Rows reach the keyring through reads only, from one cursor, so it sees
 * `k` in seq order.
 *
 * - Unpinned: keyMissing "encrypted-vault" once `k` shows a record, else "no-pin"; `keyringSeen` likewise (main
 *   makes it sticky in data.json and enforces it on pinSuite0 {link}). installKey (QR or RK) is verified against `k`;
 *   only a verified key goes to main (keyringChanged), which then pins suite 1 and restarts the engine (§12.4 (i)).
 * - Suite 1 without the newest winner's key ("no-key", "revoked-epoch"): installKey works the same way; once the
 *   keyring holds the key and main stored it, `onKeyed` re-checks the gate and the engine starts its VaultRuntime.
 * - pinSuite0 {link}: unpinned, no record ever seen, `k` read to head on this session and empty. {create} and
 *   enableE2ee: `creatable` (started with `creating`, `k` read to head on this session with VAULT_READY.head 0 and
 *   no row). The engine never pins: main does, after `ok`.
 */

import { newClientFrameId } from "../../core/codec/ids";
import type { DeviceClass } from "../../core/limits";
import { RELAY_CLOSE } from "../../core/limits";
import { KEYRING_STREAM, type ClientFrameId, type DeviceId, type Seq, type VaultEpoch, type VaultId } from "../../core/types";
import type { TimerHandle } from "../../ports/clock";
import type { LifecycleEvent } from "../../ports/platform";
import type { RelayConnectResult, RelayEvent, RelaySession } from "../../ports/relay";
import { ProtocolFailure } from "../../protocol/errors";
import type { EngineResultValue, UserCommand } from "../../protocol/messages";
import type { E2eeStatus, EnginePhase, StatusSnapshot } from "../../protocol/status";
import { Keyring, type OwnOutcome } from "../keyring/keyring";
import { KeyRecordKind } from "../keyring/record";
import { backoffMs, connectFailure, newReconnectState, sessionClosed, type ReconnectDecision } from "../runtime/relayPolicy";
import type { HostKeyring } from "./hostKeyring";
import type { ReaderPorts } from "./pinGate";
import { idleStatus } from "./statusMerge";

export type KeyCommand = Extract<UserCommand, { t: "enableE2ee" | "installKey" | "pinSuite0" | "revokeRekey" }>;
/** The commands a closed device answers: the key commands, and the ones it refuses outright (no store, no blob port). */
export type ReaderCommand = KeyCommand | Extract<UserCommand, { t: "cleanUpAttachments" }>;

export interface KeyReaderOptions {
	readonly ports: ReaderPorts;
	readonly vaultId: VaultId;
	readonly deviceId: DeviceId;
	readonly suite: 1 | null;
	readonly creating: boolean;
	readonly paused: boolean;
	readonly keyring: HostKeyring;
	readonly reconnectBaseMs?: number;
	/** Something in the status changed. */
	readonly onChange: () => void;
	/** Suite 1: the keyring holds the newest winner's key and main stored it. Resolves false if the gate stays shut. */
	readonly onKeyed: () => Promise<boolean>;
	/** Diagnostics (never payload or key bytes). */
	readonly log?: (line: string) => void;
}

/** The genesis of enableE2ee, from propose until `k` decides it. */
interface OwnFlow {
	readonly bytes: Uint8Array;
	readonly cfid: ClientFrameId;
	receipted: boolean;
	/** Session generation it was last appended on (-1: resend). */
	sentGen: number;
	readonly resolve: (o: OwnOutcome) => void;
	readonly reject: (e: Error) => void;
}

const NOTICE_LEVEL: Readonly<Record<string, "error" | "warn">> = { "device-revoked": "error", "upgrade-required": "error" };

function refused(message: string): ProtocolFailure {
	return new ProtocolFailure({ code: "refused", message, retryable: false });
}

export class KeyReader {
	vaultEpoch: VaultEpoch | null = null;
	private kr: Keyring | null = null;
	/** The keyring of the current vault epoch, once open (reads wait for it). */
	private krReady: Promise<Keyring | null> = Promise.resolve(null);
	/** Carried across vault epochs (main keeps it sticky too). */
	private seen = false;
	private session: RelaySession | null = null;
	private unsub: (() => void) | null = null;
	private gen = 0;
	private connecting = false;
	private stopped = false;
	private paused: boolean;
	private timer: TimerHandle | null = null;
	private retryTimer: TimerHandle | null = null;
	private st = newReconnectState();
	/** A relay outcome that stops reconnecting (revoked, upgrade required). */
	private terminal: ReconnectDecision | null = null;
	private notices: { code: string; level: "info" | "warn" | "error"; atMs: number }[] = [];
	// What this vault epoch's `k` holds, as far as read.
	private afterSeq = 0 as Seq;
	/** `k` is never checkpointed; one is unreadable to this device, so `k` is not empty. */
	private kCheckpoint = false;
	/** Session generation in which `k` was read to head, and VAULT_READY.head as that read ended. */
	private readGen = -1;
	private readHead: Seq | null = null;
	private reading: Promise<void> | null = null;
	private readAgain = false;
	private flow: OwnFlow | null = null;
	private keyed = false;

	constructor(private readonly o: KeyReaderOptions) {
		this.paused = o.paused;
	}

	async start(): Promise<void> {
		this.krReady = this.openKeyring();
		await this.krReady;
		if (!this.paused && !this.stopped) void this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.clearTimer();
		if (this.retryTimer !== null) this.o.ports.clock.clearTimer(this.retryTimer);
		this.retryTimer = null;
		this.failFlow("the engine stopped");
		this.drop("stopped");
		void this.krReady.then((kr) => kr?.dispose());
	}

	setPaused(paused: boolean): void {
		if (this.paused === paused) return;
		this.paused = paused;
		if (paused) {
			this.clearTimer();
			this.drop("paused");
		} else {
			this.st = newReconnectState();
			void this.connect();
		}
		this.o.onChange();
	}

	lifecycle(event: LifecycleEvent): void {
		if ((event === "online" || event === "visible" || event === "resume") && !this.session && this.timer !== null && !this.terminal) {
			this.clearTimer();
			void this.connect();
		}
	}

	get keyringSeen(): boolean {
		return this.seen || (this.kr?.keyringSeen ?? false);
	}

	private readToHead(): boolean {
		return this.session !== null && this.readGen === this.gen;
	}

	creatable(): boolean {
		return this.o.suite === null && this.o.creating && this.readToHead() && this.readHead === 0 && (this.kr?.rowCount ?? 1) === 0 && !this.kCheckpoint;
	}

	e2ee(): E2eeStatus {
		const kr = this.kr;
		return {
			suite: this.o.suite,
			sealEpoch: kr?.sealEpoch() ?? 0,
			keyMissing: kr?.keyMissing() ?? (this.o.suite === null ? (this.keyringSeen ? "encrypted-vault" : "no-pin") : "no-key"),
			keyringSeen: this.keyringSeen,
			creatable: this.creatable(),
		};
	}

	phase(): EnginePhase {
		if (this.paused) return "paused";
		return this.terminal?.phase ?? "key-missing";
	}

	status(deviceClass: DeviceClass, transport: "worker" | "inline"): StatusSnapshot {
		const s = idleStatus({ deviceClass, transport, vaultEpoch: this.vaultEpoch, phase: this.phase(), nowMs: this.o.ports.clock.now() });
		return {
			...s,
			headSeq: this.session?.headSeq ?? 0,
			relay: { ...s.relay, connected: this.session !== null },
			notices: [...this.notices],
			e2ee: this.e2ee(),
		};
	}

	// --- commands (§18.4) -----------------------------------------------------------

	/** A key command while the gate is shut. Zero-fills its SECRET buffer; refusals throw ProtocolFailure `refused`. */
	async command(c: ReaderCommand): Promise<EngineResultValue> {
		switch (c.t) {
			case "cleanUpAttachments":
				// Blob GC deletes under kAddr from K_1 and needs a verified sealing key (blobGc.ts preconditions): a closed
				// device has neither, so it answers the GC's own refusal rather than a retryable not-ready.
				return { t: "attachmentsCleaned", deleted: 0, keptNewer: 0, repaired: 0, lost: 0, refused: "keys-unverified", detail: "this device has no usable encryption pin or key" };
			case "installKey": {
				const kr = await this.keyringFor(() => (c.source === "qr" ? c.k : c.rk).fill(0));
				if (c.source === "qr") {
					// pending: kept unverified (nothing persisted) until `k` shows its record (§12.4 (i)); status says key-missing.
					if ((await kr.installQr(c.e, c.k)) === "conflict") throw refused("the key does not match the vault's key record for its epoch; a verified key is never replaced");
				} else await kr.installRk(c.rk);
				this.changed();
				return { t: "ok" };
			}
			case "pinSuite0":
				this.mayPinSuite0(c.source);
				return { t: "ok" };
			case "enableE2ee":
				await this.enableE2ee(c.rk);
				return { t: "ok" };
			case "revokeRekey":
				c.rk.fill(0);
				throw refused(this.o.suite === 1 ? "this device does not hold the vault key; install it first" : "revoke needs an encrypted vault");
		}
	}

	private async keyringFor(drop: () => void): Promise<Keyring> {
		const kr = await this.krReady;
		if (!kr || !this.o.ports.keys) {
			drop();
			throw refused("this device cannot hold a vault key");
		}
		return kr;
	}

	/** §12.4 (ii), (iii): whether main may pin suite 0. */
	private mayPinSuite0(source: "link" | "create"): void {
		if (this.o.suite !== null) throw refused("this device is already pinned");
		if (source === "create") {
			if (!this.creatable()) throw refused("not on the creation path (needs VAULT_READY.head = 0 and an empty k, read on this session)");
			return;
		}
		if (this.keyringSeen) throw refused("this device has read an encryption key record for the vault");
		if (!this.readToHead() || !this.kr) throw refused("k is not read to head yet");
		if (this.kr.rowCount > 0 || this.kCheckpoint) throw refused("k is not empty");
	}

	/** §15.1 steps 3-4: resolves once the genesis won and main stored K_1 and the record; main then pins suite 1. */
	private async enableE2ee(rk: Uint8Array): Promise<void> {
		try {
			if (this.o.suite !== null) throw refused("this device is already pinned");
			if (!this.creatable()) throw refused("not on the creation path (needs VAULT_READY.head = 0 and an empty k, read on this session)");
			if (this.flow) throw refused("a key record is already in flight");
			const kr = await this.keyringFor(() => undefined);
			const own = await kr.propose(KeyRecordKind.genesis, rk); // persists the pending K_1 first (§18.4)
			const outcome = await new Promise<OwnOutcome>((resolve, reject) => {
				this.flow = { bytes: own.bytes, cfid: newClientFrameId(this.o.ports.random), receipted: false, sentGen: -1, resolve, reject };
				this.log("genesis proposed");
				this.send();
			});
			if (outcome !== "won") throw refused("another genesis won; this device stays unpinned");
		} finally {
			rk.fill(0);
		}
	}

	/** Append the own genesis on this session, once per session (the relay deduplicates a resend by its frame id). */
	private send(): void {
		const f = this.flow;
		const s = this.session;
		if (!f || f.receipted || !s || !s.canWrite || !this.readToHead() || f.sentGen === this.gen) return;
		f.sentGen = this.gen;
		s.append({ stream: KEYRING_STREAM, clientFrameId: f.cfid, payload: f.bytes });
	}

	private finish(o: OwnOutcome): void {
		const f = this.flow;
		if (!f) return;
		this.flow = null;
		this.log(`genesis settled: ${o}`);
		f.resolve(o);
	}

	private failFlow(why: string): void {
		const f = this.flow;
		if (!f) return;
		this.flow = null;
		const kr = this.kr;
		void (kr ? kr.abandonOwn() : Promise.resolve()).finally(() => f.reject(refused(`the genesis was not committed (${why})`)));
	}

	private onRefused(ev: Extract<RelayEvent, { t: "refused" }>): void {
		const f = this.flow;
		if (!f || ev.stream !== KEYRING_STREAM || ev.clientFrameId !== f.cfid) return;
		if (ev.reason === "durability") {
			f.sentGen = -1;
			this.send();
		} else if (ev.reason === "daily-limit") {
			if (this.retryTimer !== null) this.o.ports.clock.clearTimer(this.retryTimer);
			this.retryTimer = this.o.ports.clock.setTimer(ev.retryAfterMs ?? 60_000, () => {
				this.retryTimer = null;
				if (this.flow !== f) return;
				f.sentGen = -1;
				this.send();
			});
		} else this.failFlow(ev.reason);
	}

	// --- connection ---------------------------------------------------------------

	private random = () => this.o.ports.random.float();

	private async connect(): Promise<void> {
		if (this.connecting || this.session || this.stopped || this.paused || this.terminal) return;
		this.connecting = true;
		let r: RelayConnectResult;
		try {
			r = await this.o.ports.relay.connect({ vaultId: this.o.vaultId, deviceId: this.o.deviceId });
		} catch (e) {
			this.log(`connect threw: ${e instanceof Error ? e.message : String(e)}`);
			r = { ok: false, reason: "unavailable", retryAfterMs: null };
		} finally {
			this.connecting = false;
		}
		if (this.stopped || this.paused) {
			if (r.ok) r.session.close(RELAY_CLOSE.normal, this.stopped ? "stopped" : "paused");
			return;
		}
		if (!r.ok) {
			this.log(`connect failed: ${r.reason}`);
			this.decide(connectFailure(r.reason, r.retryAfterMs, this.st, this.random, this.o.reconnectBaseMs));
			return;
		}
		this.onSession(r.session);
	}

	private onSession(session: RelaySession): void {
		const gen = ++this.gen;
		if (session.vaultEpoch !== this.vaultEpoch) {
			const first = this.vaultEpoch === null;
			this.vaultEpoch = session.vaultEpoch;
			this.afterSeq = 0 as Seq;
			this.kCheckpoint = false;
			// A new vault epoch is a new `k` (§11.5): a fresh keyring. keyringSeen stays.
			if (!first) this.newEpoch();
		}
		this.readHead = null;
		this.session = session;
		this.unsub = session.onEvent((ev) => this.onEvent(gen, ev));
		this.o.onChange();
		this.readK();
	}

	private newEpoch(): void {
		this.failFlow("the vault epoch changed");
		const old = this.krReady;
		this.krReady = (async () => {
			const kr = await old;
			if (kr) {
				this.seen ||= kr.keyringSeen;
				await kr.abandonOwn();
				kr.dispose();
			}
			return this.openKeyring();
		})();
	}

	private async openKeyring(): Promise<Keyring | null> {
		const o = this.o;
		if (o.suite === 1 && !o.ports.keys) {
			this.log("suite 1 without a suite-1 crypto port");
			this.kr = null;
			return null;
		}
		const kr = await Keyring.open({
			mode: o.suite === 1 ? "suite1" : "unpinned",
			vaultId: o.vaultId,
			kc: o.ports.keys,
			records: o.keyring.records,
			keyringSeen: this.seen,
			persist: o.keyring.persist,
			diag: (code, fields) => this.log(`${code} ${JSON.stringify(fields)}`),
			onKeyringSeen: () => o.onChange(),
		});
		this.kr = kr;
		return kr;
	}

	private decide(d: ReconnectDecision): void {
		if (d.notice) this.notice(d.notice);
		if (d.retryMs === null) {
			this.terminal = d;
		} else {
			this.schedule(d.retryMs);
		}
		this.o.onChange();
	}

	private schedule(ms: number): void {
		this.clearTimer();
		if (this.stopped || this.paused) return;
		this.timer = this.o.ports.clock.setTimer(ms, () => {
			this.timer = null;
			void this.connect();
		});
	}

	private clearTimer(): void {
		if (this.timer !== null) this.o.ports.clock.clearTimer(this.timer);
		this.timer = null;
	}

	private drop(reason: string): void {
		const s = this.session;
		this.session = null;
		this.gen++;
		this.unsub?.();
		this.unsub = null;
		this.readHead = null;
		if (s) s.close(RELAY_CLOSE.normal, reason);
	}

	private onEvent(gen: number, ev: RelayEvent): void {
		if (gen !== this.gen) return;
		switch (ev.t) {
			case "committed":
				// Every `k` row is taken from a read at the cursor, so the keyring sees `k` in seq order.
				if (ev.frame.stream === KEYRING_STREAM) this.readK();
				return;
			case "receipt":
				if (ev.stream === KEYRING_STREAM && this.flow?.cfid === ev.clientFrameId) {
					this.flow.receipted = true;
					this.readK();
				}
				return;
			case "refused":
				this.onRefused(ev);
				return;
			case "resendUnreceipted":
				if (this.flow && !this.flow.receipted) this.flow.sentGen = -1;
				this.readK();
				return;
			case "closed": {
				this.session = null;
				this.unsub?.();
				this.unsub = null;
				this.readHead = null;
				this.gen++;
				const d = sessionClosed(ev.code, ev.errorCode, false, this.st, this.random, this.o.reconnectBaseMs);
				// The reader keeps no epoch state to migrate: an epoch close is a reconnect that re-reads `k`.
				this.decide(d.phase === "epoch-migrating" ? { phase: "offline", retryMs: this.retryMs(), notice: null } : d);
				return;
			}
			default:
				return;
		}
	}

	// --- reading k --------------------------------------------------------------------

	/** Read `k` on the current session from the cursor to its end; coalesces while a read runs. */
	private readK(): void {
		if (this.reading) {
			this.readAgain = true;
			return;
		}
		this.readAgain = false;
		const run = this.readOnce();
		this.reading = run;
		void run.finally(() => {
			if (this.reading === run) this.reading = null;
			if (this.readAgain) this.readK();
		});
	}

	private async readOnce(): Promise<void> {
		const session = this.session;
		const gen = this.gen;
		if (!session) return;
		try {
			const kr = await this.krReady;
			const epoch = this.vaultEpoch;
			let more = gen === this.gen;
			while (more) {
				const page = await session.read(KEYRING_STREAM, this.afterSeq, false);
				// Rows of this vault epoch's `k` stay valid across a reconnect; a new epoch reset the cursor.
				if (this.vaultEpoch !== epoch || this.stopped) return;
				if (page.checkpoint) this.kCheckpoint = true;
				if (kr && page.rows.length > 0) await kr.ingest(page.rows.map((r) => ({ seq: r.seq, bytes: r.payload })));
				if (page.nextAfterSeq > this.afterSeq) this.afterSeq = page.nextAfterSeq;
				more = page.more && gen === this.gen;
			}
			if (gen !== this.gen) return;
			this.readGen = gen;
			this.readHead = session.headSeq;
			this.st = newReconnectState();
			await this.afterRead(kr);
			this.changed();
		} catch (e) {
			if (gen !== this.gen) return;
			this.log(`k read failed: ${e instanceof Error ? e.message : String(e)}`);
			this.drop("read-failed");
			this.decide({ phase: "offline", retryMs: this.retryMs(), notice: null });
		}
	}

	/** `k` is read to head on this session: settle or (re)send the own genesis. */
	private async afterRead(kr: Keyring | null): Promise<void> {
		const f = this.flow;
		if (!f || !kr) return;
		const o = await kr.settleOwn();
		if (this.flow !== f) return;
		if (o === "won" || o === "lost") this.finish(o);
		else this.send(); // not in `k` yet
	}

	/** After any keyring change: report, and on suite 1 let the gate open once the key is held. */
	private changed(): void {
		this.o.onChange();
		if (this.o.suite !== 1 || this.keyed || this.stopped || this.kr?.keyMissing() !== null) return;
		this.keyed = true;
		void this.o.onKeyed().then((open) => {
			if (!open) this.keyed = false;
		}, () => {
			this.keyed = false;
		});
	}

	private retryMs(): number {
		this.st.attempts++;
		return backoffMs(this.st.attempts - 1, this.random, this.o.reconnectBaseMs);
	}

	private notice(code: string): void {
		this.notices = [...this.notices.filter((n) => n.code !== code), { code, level: NOTICE_LEVEL[code] ?? "warn", atMs: this.o.ports.clock.now() }];
	}

	private log(line: string): void {
		this.o.log?.(`key reader: ${line}`);
	}
}
