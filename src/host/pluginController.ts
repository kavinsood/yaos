/**
 * Plugin controller: owns the persisted plugin data and the HostRuntime
 * lifecycle, and implements the dynamic half of YaosUiHost (status, run state,
 * commands, restart, settings application). No Obsidian runtime imports, so
 * it runs in node tests; plugin.ts supplies the environment.
 *
 * It also decides the suite pin (e2ee-design §12.4, src/host/keys/pin.ts): the engine never sets one. A pin is
 * saved only after an authenticated answer (a successful pinSuite0 / enableE2ee, or a keyringChanged that stored
 * a verified key), and then the engine restarts with the pinned config. Absent stays absent: nothing is inferred
 * from a stored pairing or from the server, and nothing here offers a way back to unencrypted.
 */

import { isVaultId } from "../core/codec/ids";
import { hexToBytes } from "../core/codec/lib0";
import type { BrakeReport, DeviceId, VaultId } from "../core/types";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { EngineResultValue, EngineSettings, UserCommand } from "../protocol/messages";
import type { DeviceCheckMode, DeviceCheckReport, StatusSnapshot } from "../protocol/status";
import { wipeSecrets } from "../protocol/workerTransport";
import { HostRequestError } from "./engineHost";
import type { HostRuntime, HostUiSink } from "./hostRuntime";
import { createHostKeys, type HostKeys } from "./keys/hostKeys";
import {
	isCreating, markedCreating, pinAcross, pinnedSuite0, pinnedSuite1, pinsFromKeyring, refuseEnableE2ee, refuseKeyCommand,
	refusePinSuite0, sawKeyring, withoutCreating, PIN_REFUSAL_TEXT, type PinRefusal,
} from "./keys/pin";
import { plaintextNoticeOnce, type PlaintextNoticeEnv } from "./keys/plaintextNotice";
import { VaultKeyStore, type EpochKey, type SecretStorageLike } from "./keys/secretStore";
import type { HostIdentity } from "./runtimeSupport";
import { sameEngineSettings, sameIdentity, type EngineRunState, type PairedIdentity, type YaosPluginData } from "./ui/api";
import { deviceCheckDeadlineMs } from "./ui/deviceCheck";

export interface ControllerEnv {
	makeRuntime(identity: HostIdentity, settings: () => EngineSettings, ui: HostUiSink, keys: HostKeys): HostRuntime;
	saveData(data: YaosPluginData): Promise<void>;
	notice(level: "info" | "warn" | "error", message: string, timeoutMs?: number): void;
	log?(line: string): void;
	/** Main-thread clock: the SecretStorage startup wait and the deferred restart after a pin change. */
	readonly clock: ClockPort;
	/** Obsidian's SecretStorage (App.secretStorage, obsidian.d.ts :458). Absent: this device can hold no key. */
	readonly secrets?: SecretStorageLike | null;
	/** Vault-local storage (App.loadLocalStorage / saveLocalStorage, d.ts :472 / :480) for the one-time notice flag. */
	readonly localStorage?: Pick<PlaintextNoticeEnv, "load" | "save">;
}

export interface HostNotice {
	readonly text: string;
	readonly timeoutMs?: number;
}

/**
 * The popup the host shows for an engine notice, or null to keep it in the
 * status only. Info notices stay status-only except the settings-reload prompt
 * (legacy also asked for a reload); the daily-limit popup stays up 20 s, as in legacy.
 */
export function hostNotice(level: "info" | "warn" | "error", code: string, message: string): HostNotice | null {
	if (code === "settings-reload") return { text: `YAOS: synced settings changed (${message}). Reload Obsidian to apply them.`, timeoutMs: 15_000 };
	if (level === "info") return null;
	if (code === "daily-limit") return { text: message, timeoutMs: 20_000 };
	return { text: message };
}

export function hostIdentityOf(id: PairedIdentity, deviceLabel: string): HostIdentity {
	// SECRET: relay.credential is the device token. Never log the result.
	return { vaultId: id.vaultId as VaultId, deviceId: id.deviceId as DeviceId, deviceLabel, relay: { url: id.host, credential: id.deviceToken } };
}

function safeMessage(e: unknown): string {
	return e instanceof Error ? e.message : typeof e === "string" ? e : "unknown error";
}

/** Same vault on the same relay: the pin and the stored keys still apply. */
function sameVault(a: PairedIdentity | null, b: PairedIdentity | null): boolean {
	return a !== null && b !== null && a.host === b.host && a.vaultId === b.vaultId;
}

/** Thrown for a key or pin command this device's state refuses before it reaches the engine. */
export class PinRefusedError extends Error {
	constructor(readonly refusal: PinRefusal) {
		super(`YAOS: ${PIN_REFUSAL_TEXT[refusal]}.`);
		this.name = "PinRefusedError";
	}
}

export class YaosController {
	private runtime: HostRuntime | null = null;
	private snapshot: StatusSnapshot | null = null;
	private pendingBrake: BrakeReport | null = null;
	private run: EngineRunState;
	private readonly listeners = new Set<() => void>();
	private queue: Promise<void> = Promise.resolve();
	private keyStore: VaultKeyStore | null = null;
	private readonly plaintextNotice: () => void;
	/** User commands awaiting the engine: a pin-change restart waits for them (one may be the one that pinned). */
	private inflight = 0;
	private restartWanted = false;
	private restartTimer: TimerHandle | null = null;

	constructor(
		private current: YaosPluginData,
		private readonly env: ControllerEnv,
	) {
		this.run = { phase: current.identity ? "stopped" : "unpaired", transport: null, lastError: null };
		this.plaintextNotice = plaintextNoticeOnce({
			load: (k) => env.localStorage?.load(k) ?? null,
			save: (k, v) => env.localStorage?.save(k, v),
			show: (text) => env.notice("warn", text, 15_000),
		});
	}

	/** The vault's SecretStorage entry (one per vault id; kept so the startup wait runs once). */
	private keyStoreFor(vaultId: string): VaultKeyStore | null {
		const secrets = this.env.secrets;
		if (!secrets) return null;
		if (this.keyStore?.vaultId !== vaultId) this.keyStore = new VaultKeyStore(secrets, vaultId, this.env.clock);
		return this.keyStore;
	}

	data(): YaosPluginData {
		return this.current;
	}
	status(): StatusSnapshot | null {
		return this.snapshot;
	}
	runState(): EngineRunState {
		return this.run;
	}
	brake(): BrakeReport | null {
		return this.pendingBrake;
	}
	get activeRuntime(): HostRuntime | null {
		return this.runtime;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const l of [...this.listeners]) {
			try {
				l();
			} catch (e) {
				this.env.log?.(`onChange listener threw: ${safeMessage(e)}`);
			}
		}
	}

	private setRun(next: Partial<EngineRunState>): void {
		this.run = { ...this.run, ...next };
		this.changed();
	}

	/** Serialize start/stop/restart so overlapping UI actions cannot interleave. */
	private serial(fn: () => Promise<void>): Promise<void> {
		const p = this.queue.then(fn, fn);
		this.queue = p.catch(() => undefined);
		return p;
	}

	start(): Promise<void> {
		return this.serial(() => this.startNow());
	}

	stop(): Promise<void> {
		return this.serial(() => this.stopNow());
	}

	restartEngine(): Promise<void> {
		return this.serial(async () => {
			await this.stopNow();
			await this.startNow();
		});
	}

	private async startNow(): Promise<void> {
		const identity = this.current.identity;
		if (!identity) {
			this.setRun({ phase: "unpaired", transport: null });
			return;
		}
		if (this.runtime) return;
		const ui: HostUiSink = {
			onStatus: (s) => {
				if (this.runtime !== rt) return;
				this.snapshot = s;
				if (s.brake) this.pendingBrake = s.brake;
				// §12.4: the first k genesis an unpinned device reads makes keyringSeen sticky (no suite-0 link after).
				if (s.e2ee?.keyringSeen && sameVault(identity, this.current.identity)) {
					const seen = sawKeyring(this.current);
					if (seen !== this.current) void this.savePin(seen).catch((e: unknown) => this.env.log?.(`saving keyringSeen failed: ${safeMessage(e)}`));
				}
				this.changed();
			},
			onBrake: (b) => {
				if (this.runtime !== rt) return;
				this.pendingBrake = b;
				this.changed();
			},
			onNotice: (level, code, message) => {
				const n = this.runtime === rt ? hostNotice(level, code, message) : null;
				if (n) this.env.notice(level, n.text, n.timeoutMs);
			},
			onCarrier: (c) => {
				if (this.runtime !== rt || this.run.phase === "failed") return;
				this.setRun({ phase: c.ready ? "running" : "starting", transport: c.carrier });
			},
			onFatal: (e) => {
				if (this.runtime !== rt) return;
				this.setRun({ phase: "failed", lastError: `${e.code}: ${e.message}` });
				this.env.notice("error", `YAOS stopped: ${e.message}`);
			},
		};
		const keys = createHostKeys({
			store: this.keyStoreFor(identity.vaultId),
			// The pin of this runtime's vault only: after the user left it, nothing applies (the restart follows).
			pin: () => (sameVault(identity, this.current.identity) ? this.current.e2ee : undefined),
			creating: () => isCreating(this.current, this.current.identity?.vaultId ?? null),
			stored: (info) => this.keyringStored(rt, identity, info),
			plaintext: this.plaintextNotice,
		});
		const rt = this.env.makeRuntime(hostIdentityOf(identity, this.current.deviceLabel), () => this.current.engine, ui, keys);
		this.runtime = rt;
		this.pendingBrake = null;
		this.setRun({ phase: "starting", transport: null, lastError: null });
		try {
			await rt.start();
		} catch (e) {
			if (this.runtime === rt) this.setRun({ phase: "failed", lastError: safeMessage(e) });
		}
	}

	private async stopNow(): Promise<void> {
		this.restartWanted = false;
		if (this.restartTimer !== null) {
			this.env.clock.clearTimer(this.restartTimer);
			this.restartTimer = null;
		}
		const rt = this.runtime;
		this.runtime = null;
		this.snapshot = null;
		this.pendingBrake = null;
		if (rt) {
			try {
				await rt.stop();
			} catch (e) {
				this.env.log?.(`stop failed: ${safeMessage(e)}`);
			}
		}
		this.setRun({ phase: this.current.identity ? "stopped" : "unpaired", transport: null });
	}

	async command(command: UserCommand): Promise<EngineResultValue> {
		const rt = this.runtime;
		const vault = this.current.identity;
		const refusal = this.refusal(command);
		if (!rt || this.run.phase !== "running" || refusal) {
			wipeSecrets({ t: "command", rid: 0, command }); // never sent: drop the SECRET bytes here (§6.3)
			if (refusal) throw new PinRefusedError(refusal);
			throw new Error("YAOS is not running.");
		}
		this.inflight++;
		try {
			const value = await rt.command(command);
			if ((command.t === "approveBrake" || command.t === "rejectBrake") && this.pendingBrake?.id === command.brakeId) {
				this.pendingBrake = null;
				this.changed();
			}
			if (value.t === "ok" && this.runtime === rt && sameVault(vault, this.current.identity)) await this.pinAfter(command);
			return value;
		} catch (e) {
			throw new Error(safeMessage(e));
		} finally {
			this.inflight--;
			this.kickRestart();
		}
	}

	/** Main's own refusals (§12.4); the engine checks `k` itself. */
	private refusal(command: UserCommand): PinRefusal | null {
		const vaultId = this.current.identity?.vaultId ?? null;
		switch (command.t) {
			case "pinSuite0":
				return refusePinSuite0(this.current, vaultId, command.source);
			case "enableE2ee":
				return refuseEnableE2ee(this.current, vaultId);
			case "installKey":
			case "revokeRekey":
				return refuseKeyCommand(this.current, command.t);
			default:
				return null;
		}
	}

	/** §12.4 (ii) / (iii): a successful pinSuite0 or enableE2ee pins; the engine restarts with the pinned config. */
	private async pinAfter(command: UserCommand): Promise<void> {
		const next = command.t === "pinSuite0" ? pinnedSuite0(this.current) : command.t === "enableE2ee" ? pinnedSuite1(this.current) : this.current;
		if (next === this.current) return;
		await this.savePin(next);
		this.requestRestart();
	}

	/**
	 * keyringChanged was stored (§18.4): pin suite 1 from a verified key (§12.4 (i)), saved before the engine gets its
	 * answer. A runtime being replaced decides nothing (its store write stands: it is the same vault's secret).
	 */
	private async keyringStored(rt: HostRuntime, identity: PairedIdentity, info: { readonly pending: number | null; readonly keys: number; readonly records: number }): Promise<void> {
		if (this.runtime !== rt || !sameVault(identity, this.current.identity)) return;
		if (!pinsFromKeyring(this.current.e2ee, info.pending, info)) return;
		await this.savePin(pinnedSuite1(this.current));
		this.requestRestart();
	}

	private async savePin(next: YaosPluginData): Promise<void> {
		if (next === this.current) return;
		this.current = next;
		await this.env.saveData(next);
		this.changed();
	}

	/** Restart with the pinned config once no user command is in flight, a macrotask after the pinning answer. */
	private requestRestart(): void {
		this.restartWanted = true;
		this.kickRestart();
	}

	private kickRestart(): void {
		if (!this.restartWanted || this.inflight > 0 || this.restartTimer !== null) return;
		this.restartTimer = this.env.clock.setTimer(0, () => {
			this.restartTimer = null;
			if (!this.restartWanted || this.inflight > 0) return;
			this.restartWanted = false;
			void this.restartEngine();
		});
	}

	private forgetKeys(vaultId: string): void {
		const store = this.keyStoreFor(vaultId);
		store?.forget();
		if (this.keyStore === store) this.keyStore = null;
	}

	/**
	 * §15.1 step 1 done: this device created `vaultId` on the server (WP-E5's creation flow calls this right after
	 * the creating response). Only this marker lets enableE2ee or pinSuite0 "create" through.
	 */
	async markCreating(vaultId: string): Promise<void> {
		if (!isVaultId(vaultId)) throw new TypeError("not a vault id");
		await this.savePin(markedCreating(this.current, vaultId, this.current.identity?.vaultId ?? null));
	}

	/**
	 * §15.1: the creation of `vaultId` failed its step-3 check (the vault was not empty). The marker goes and no pin is
	 * set, so the device stays unpinned and blocked (§12.4). The engine restarts without `creating`.
	 */
	async abandonCreating(vaultId: string): Promise<void> {
		const next = withoutCreating(this.current, vaultId);
		if (next === this.current) return;
		await this.savePin(next);
		if (this.current.identity?.vaultId === vaultId) this.requestRestart();
	}

	/**
	 * The 3-byte recovery-key checksum of a 32-byte secret, first 3 bytes of SHA-256 (§13.1), hashed by the engine
	 * (main never hashes). `secret` is not changed: a copy is transferred and wiped. Needs an initialized engine.
	 */
	async rkChecksum(secret: Uint8Array): Promise<Uint8Array> {
		const rt = this.runtime;
		if (!rt || secret.length !== 32) throw new Error("YAOS is not running.");
		const bytes = secret.slice();
		let r: Awaited<ReturnType<HostRuntime["engine"]["request"]>>;
		try {
			r = await rt.engine.request({ t: "hashRequest", items: [{ path: "recovery-key", want: "fingerprint", bytes }] });
		} catch (e) {
			throw new Error(safeMessage(e));
		} finally {
			if (bytes.byteLength > 0) bytes.fill(0); // empty once transferred (detached)
		}
		const hash = r.t === "hashes" && r.values.length === 1 ? r.values[0]!.hash : "";
		if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("YAOS: the engine returned no checksum.");
		return hexToBytes(hash.slice(0, 6));
	}

	/**
	 * The on-device self-test: the engine runs it on its live ports (engine/compose/deviceCheck.ts); its deadline scales
	 * with the bytes it moves (ui/deviceCheck.ts), not the default request timeout.
	 */
	async deviceCheck(mode: DeviceCheckMode): Promise<DeviceCheckReport> {
		const rt = this.runtime;
		if (!rt || this.run.phase !== "running") throw new Error("YAOS is not running.");
		let r: EngineResultValue;
		try {
			r = await rt.engine.request({ t: "deviceCheck", mode }, deviceCheckDeadlineMs(mode, this.snapshot?.maxBlobBytes ?? null));
		} catch (e) {
			throw new Error(safeMessage(e));
		}
		if (r.t !== "deviceCheck") throw new Error("the sync engine returned no device check report");
		return r.report;
	}

	/**
	 * SECRET: the key a pairing or re-key QR carries (§12.1, §14.2 step 3): the stored key of the epoch this device
	 * seals under, as a fresh copy the caller zero-fills. Null unless the device is pinned to suite 1, the engine
	 * reports the key usable (keyMissing null) and the store holds that epoch.
	 */
	vaultKeyForQr(): EpochKey | null {
		const identity = this.current.identity;
		const e2ee = this.snapshot?.e2ee;
		if (!identity || this.current.e2ee?.suite !== 1 || !e2ee || e2ee.suite !== 1 || e2ee.keyMissing !== null || e2ee.sealEpoch < 1) return null;
		const stored = this.keyStoreFor(identity.vaultId)?.load() ?? null;
		if (!stored) return null;
		let out: EpochKey | null = null;
		for (const key of stored.keys) {
			if (key.e === e2ee.sealEpoch && key.k.length === 32 && !out) out = { e: key.e, k: key.k.slice() };
			key.k.fill(0);
		}
		return out;
	}

	/** Persist, then apply: identity/label change restarts (or stops); engine settings go live. */
	async updateData(mutate: (d: YaosPluginData) => YaosPluginData): Promise<void> {
		const prev = this.current;
		const raw = mutate(prev);
		if (raw === prev) return;
		// The pin fields are the controller's: kept in the same vault, dropped on another one (never set here).
		const same = sameVault(prev.identity, raw.identity);
		const next = pinAcross(prev, raw, same, raw.identity?.vaultId ?? null);
		this.current = next;
		await this.env.saveData(next);
		if (!sameIdentity(prev.identity, next.identity) || prev.deviceLabel !== next.deviceLabel) {
			await this.restartEngine();
			// §6.1 Forget keys: leaving a vault (unpair, another vault or relay) blanks its secret, once the old
			// vault's engine is gone (it can no longer store into it).
			if (!same && prev.identity) this.forgetKeys(prev.identity.vaultId);
		} else if (!sameEngineSettings(prev.engine, next.engine) && this.runtime && this.run.phase === "running") {
			try {
				await this.runtime.command({ t: "updateSettings", settings: next.engine });
			} catch (e) {
				// A timeout only ends the wait: the engine took the settings first and keeps applying them
				// (protocolEngine.ts "updateSettings"). Any other error leaves them for its next restart.
				const timedOut = e instanceof HostRequestError && e.error.code === "timeout";
				this.env.notice("warn", timedOut ? "Settings saved; the engine is still applying them." : `Settings saved; the engine will apply them on restart (${safeMessage(e)}).`);
			}
		}
		this.changed();
	}
}
