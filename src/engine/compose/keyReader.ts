/**
 * The engine of a device whose write gate is closed (pinGate.ts; e2ee-design §12.4): it connects, reads `k` to
 * head, follows live `k` frames and reports what it saw. That is all. It holds no store, no outbox and no crypto,
 * and its relay cannot append or put a checkpoint, so it writes nothing on any stream (`k` included).
 *
 * Status: phase `key-missing` (or `paused`, or a terminal relay phase such as `revoked`), and `e2ee`:
 *  - unpinned: keyMissing "encrypted-vault" once a `k` record was read, else "no-pin"; `keyringSeen` likewise
 *    (main makes it sticky in data.json);
 *  - suite 1 (until WP-E3's keyring runtime): keyMissing "no-key";
 *  - `creatable` only when started with `creating`, and the session that read `k` to head had VAULT_READY.head 0
 *    and `k` held no row (§15.1 step 3).
 * WP-E3 owns acting on `k` (verifying keys, pinSuite0, enableE2ee): the reader only reads.
 */

import type { DeviceClass } from "../../core/limits";
import { RELAY_CLOSE } from "../../core/limits";
import { KEYRING_STREAM, type DeviceId, type Seq, type VaultEpoch, type VaultId } from "../../core/types";
import type { TimerHandle } from "../../ports/clock";
import type { LifecycleEvent } from "../../ports/platform";
import type { RelayConnectResult, RelayEvent, RelaySession } from "../../ports/relay";
import type { E2eeStatus, EnginePhase, StatusSnapshot } from "../../protocol/status";
import { decodeKeyRecord } from "../keyring/record";
import { backoffMs, connectFailure, newReconnectState, sessionClosed, type ReconnectDecision } from "../runtime/relayPolicy";
import type { ReaderPorts } from "./pinGate";
import { idleStatus } from "./statusMerge";

export interface KeyReaderOptions {
	readonly ports: ReaderPorts;
	readonly vaultId: VaultId;
	readonly deviceId: DeviceId;
	readonly suite: 1 | null;
	readonly creating: boolean;
	readonly paused: boolean;
	readonly reconnectBaseMs?: number;
	/** Something in the status changed. */
	readonly onChange: () => void;
	/** Diagnostics (never payload bytes). */
	readonly log?: (line: string) => void;
}

const NOTICE_LEVEL: Readonly<Record<string, "error" | "warn">> = { "device-revoked": "error", "upgrade-required": "error" };

export class KeyReader {
	vaultEpoch: VaultEpoch | null = null;
	private session: RelaySession | null = null;
	private unsub: (() => void) | null = null;
	private gen = 0;
	private connecting = false;
	private stopped = false;
	private paused: boolean;
	private timer: TimerHandle | null = null;
	private st = newReconnectState();
	/** A relay outcome that stops reconnecting (revoked, upgrade required). */
	private terminal: ReconnectDecision | null = null;
	private notices: { code: string; level: "info" | "warn" | "error"; atMs: number }[] = [];
	// What this vault epoch's `k` holds, as far as read.
	private readonly seqs = new Set<Seq>();
	private afterSeq = 0 as Seq;
	private rows = 0;
	private recordSeen = false;
	/** VAULT_READY.head of the session that last read `k` to head (null: not read to head yet). */
	private readHead: Seq | null = null;
	private reading: Promise<void> | null = null;
	private readAgain = false;

	constructor(private readonly o: KeyReaderOptions) {
		this.paused = o.paused;
	}

	start(): void {
		if (!this.paused) void this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.clearTimer();
		this.drop("stopped");
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
		return this.recordSeen;
	}

	e2ee(): E2eeStatus {
		const unpinned = this.o.suite === null;
		return {
			suite: this.o.suite,
			sealEpoch: 0,
			keyMissing: unpinned ? (this.recordSeen ? "encrypted-vault" : "no-pin") : "no-key",
			keyringSeen: unpinned && this.recordSeen,
			creatable: unpinned && this.o.creating && this.readHead === 0 && this.rows === 0,
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
			// A new vault epoch is a new `k` (§11.5): start over. keyringSeen stays (main keeps it sticky too).
			this.vaultEpoch = session.vaultEpoch;
			this.seqs.clear();
			this.afterSeq = 0 as Seq;
			this.rows = 0;
		}
		this.readHead = null;
		this.session = session;
		this.unsub = session.onEvent((ev) => this.onEvent(gen, ev));
		this.o.onChange();
		this.readK();
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
				if (ev.frame.stream !== KEYRING_STREAM) return;
				if (ev.frame.payload === null) this.readK();
				else this.ingest(ev.frame.seq, ev.frame.payload);
				return;
			case "resendUnreceipted":
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
			let more = true;
			while (more) {
				const page = await session.read(KEYRING_STREAM, this.afterSeq, false);
				if (gen !== this.gen) return;
				// `k` is never checkpointed; one here is unreadable to this device, so `k` is not empty.
				if (page.checkpoint) this.rows++;
				for (const row of page.rows) this.ingest(row.seq, row.payload);
				if (page.nextAfterSeq > this.afterSeq) this.afterSeq = page.nextAfterSeq;
				more = page.more;
			}
			this.readHead = session.headSeq;
			this.st = newReconnectState();
			this.o.onChange();
		} catch (e) {
			if (gen !== this.gen) return;
			this.log(`k read failed: ${e instanceof Error ? e.message : String(e)}`);
			this.drop("read-failed");
			this.decide({ phase: "offline", retryMs: this.retryMs(), notice: null });
		}
	}

	private retryMs(): number {
		this.st.attempts++;
		return backoffMs(this.st.attempts - 1, this.random, this.o.reconnectBaseMs);
	}

	private ingest(seq: Seq, payload: Uint8Array): void {
		if (this.seqs.has(seq)) return;
		this.seqs.add(seq);
		this.rows++;
		if (!this.recordSeen && decodeKeyRecord(payload) !== null) {
			this.recordSeen = true;
			this.log("k record read: keyringSeen");
		}
		this.o.onChange();
	}

	private notice(code: string): void {
		this.notices = [...this.notices.filter((n) => n.code !== code), { code, level: NOTICE_LEVEL[code] ?? "warn", atMs: this.o.ports.clock.now() }];
	}

	private log(line: string): void {
		this.o.log?.(`key reader: ${line}`);
	}
}
