/**
 * Seeded faults (DESIGN §l.2) on the real stack (composed engine, SimRelay,
 * MemStoragePort):
 *
 *   device     engine (worker) crash (its runtime stops; the user restarts
 *              it); whole-app crash + restart; crash at the
 *              k-th next storage commit (before/after it lands); IndexedDB
 *              wipe while the app is down (with or without the side-file
 *              mirrors); IndexedDB connection lost while running; offline
 *              periods; vault I/O failures; backgrounding; slow watchers (run.ts)
 *   relay      socket drops (1006/1001/1011) at random points of the frame
 *              flow; relay restart (STREAM_RESEND, unreceipted frames lost);
 *              graceful drain; HTTP failures; daily limit; vault epoch reset
 *   world      wall-clock jumps (monotonic intact)
 *   suite 1    key-store loss, forced and concurrent rolls, revoke + re-key,
 *              point-in-time restore, hostile replay and downgrade
 *              (e2eeFaults.ts; drawn only by E2EE_FAULTS in a suite-1 run)
 *
 * Token durability across an app crash: a token typed on the crashed device
 * may be lost only if it was on no disk, in no trash and not in the device's
 * committed storage (inspectStore over a crash copy, resolved asynchronously
 * as the clock runs; settle() waits for every inspection before the checks).
 */

import type { DeviceId, VaultEpoch } from "../core/types";
import type { LifecycleEvent } from "../ports/platform";
import type { TimerHandle } from "../ports/clock";
import { tokensIn, type TokenLedger } from "./actors";
import type { VirtualClock } from "./clock";
import { E2eeFaults, type E2eeFaultAction } from "./e2eeFaults";
import type { SeededRandom } from "./random";
import type { SimDevice } from "./device";
import { inspectStore } from "./inspect";
import type { SimNet } from "./net";
import type { MemStoragePort } from "./storage";

export type FaultAction =
	| { readonly t: "engineCrash"; readonly dev: number }
	| { readonly t: "appCrash"; readonly dev: number; readonly downMs: number }
	| { readonly t: "commitCrash"; readonly dev: number; readonly commits: number; readonly when: "before" | "after"; readonly downMs: number }
	| { readonly t: "idbWipe"; readonly dev: number; readonly mirrors: boolean; readonly downMs: number }
	| { readonly t: "idbLost"; readonly dev: number }
	| { readonly t: "offline"; readonly dev: number; readonly durationMs: number }
	| { readonly t: "ioFail"; readonly dev: number; readonly ops: number }
	| { readonly t: "background"; readonly dev: number; readonly event: "hidden" | "pagehide" | "freeze"; readonly durationMs: number }
	| { readonly t: "socketDrop"; readonly dev: number; readonly code: number }
	| { readonly t: "relayRestart" }
	| { readonly t: "relayDrain" }
	| { readonly t: "httpFail"; readonly durationMs: number }
	| { readonly t: "dailyLimit"; readonly durationMs: number }
	| { readonly t: "epochReset" }
	| { readonly t: "clockSkew"; readonly dev: number; readonly deltaMs: number }
	| E2eeFaultAction;

export type FaultWeights = Readonly<Record<FaultAction["t"], number>>;

export const DEFAULT_FAULTS: FaultWeights = {
	engineCrash: 3, appCrash: 2, commitCrash: 2, idbWipe: 1, idbLost: 1, offline: 4, ioFail: 2, background: 3,
	socketDrop: 4, relayRestart: 1, relayDrain: 1, httpFail: 1, dailyLimit: 0.5, epochReset: 0.3, clockSkew: 1,
	// Suite-1 faults (e2eeFaults.ts): weight 0 here, so suite-0 plans draw exactly as before (generateFault skips
	// zero weights, and these keys come last).
	keyStoreLoss: 0, keyRoll: 0, revoke: 0, epochRestore: 0, hostileReplay: 0, hostileDowngrade: 0,
};

/** The default matrix plus the suite-1 faults (a `crypto: "suite1"` run; in a suite-0 run they are skipped). */
export const E2EE_FAULTS: FaultWeights = {
	...DEFAULT_FAULTS,
	keyStoreLoss: 1, keyRoll: 1.5, revoke: 0.7, epochRestore: 0.5, hostileReplay: 2, hostileDowngrade: 1,
};

export function generateFault(rng: SeededRandom, devices: number, weights: FaultWeights): FaultAction {
	const dev = rng.int(devices);
	const keys = (Object.keys(weights) as FaultAction["t"][]).filter((k) => weights[k] > 0);
	let x = rng.float() * keys.reduce((s, k) => s + weights[k], 0);
	let kind = keys[keys.length - 1] ?? "offline";
	for (const k of keys) {
		x -= weights[k];
		if (x < 0) {
			kind = k;
			break;
		}
	}
	switch (kind) {
		case "engineCrash": return { t: "engineCrash", dev };
		case "appCrash": return { t: "appCrash", dev, downMs: rng.range(200, 20_000) };
		case "commitCrash": return { t: "commitCrash", dev, commits: rng.range(1, 12), when: rng.chance(0.5) ? "before" : "after", downMs: rng.range(200, 10_000) };
		case "idbWipe": return { t: "idbWipe", dev, mirrors: rng.chance(0.6), downMs: rng.range(200, 10_000) };
		case "idbLost": return { t: "idbLost", dev };
		case "offline": return { t: "offline", dev, durationMs: rng.range(1_000, 120_000) };
		case "ioFail": return { t: "ioFail", dev, ops: rng.range(1, 3) };
		case "background": return { t: "background", dev, event: rng.pick(["hidden", "pagehide", "freeze"] as const), durationMs: rng.range(100, 30_000) };
		case "socketDrop": return { t: "socketDrop", dev, code: rng.pick([1006, 1006, 1001, 1011]) };
		case "relayRestart": return { t: "relayRestart" };
		case "relayDrain": return { t: "relayDrain" };
		case "httpFail": return { t: "httpFail", durationMs: rng.range(1_000, 30_000) };
		case "dailyLimit": return { t: "dailyLimit", durationMs: rng.range(5_000, 60_000) };
		case "epochReset": return { t: "epochReset" };
		case "clockSkew": return { t: "clockSkew", dev, deltaMs: (rng.chance(0.5) ? 1 : -1) * rng.range(60_000, 3 * 86_400_000) };
		case "keyStoreLoss": return { t: "keyStoreLoss", dev, downMs: rng.range(200, 10_000), rekeyMs: rng.range(2_000, 60_000) };
		case "keyRoll": return { t: "keyRoll", dev, also: devices > 1 && rng.chance(0.5) ? (dev + 1 + rng.int(devices - 1)) % devices : null };
		case "revoke": return { t: "revoke", dev, by: (dev + 1 + rng.int(Math.max(1, devices - 1))) % devices, rekeyMs: rng.range(2_000, 60_000), rkSeed: rng.int(0x7fffffff) };
		case "epochRestore": return { t: "epochRestore", back: rng.range(1, 12) };
		case "hostileReplay": return { t: "hostileReplay", pick: rng.int(0x7fffffff), copies: rng.range(1, 3) };
		case "hostileDowngrade": return { t: "hostileDowngrade", pick: rng.int(0x7fffffff), rows: rng.range(1, 3), join: rng.chance(0.3) };
	}
}

/** Tokens on any disk or in any trash right now. */
export function diskTokens(devs: readonly SimDevice[]): Set<string> {
	const out = new Set<string>();
	for (const x of devs) {
		for (const text of x.vault.snapshot().values()) for (const t of tokensIn(text)) out.add(t);
		for (const r of x.vault.trashed) for (const t of tokensIn(r.text)) out.add(t);
	}
	return out;
}

export class FaultState {
	private readonly down = new Set<number>();
	private readonly offline = new Set<number>();
	private readonly armed = new Set<number>();
	private readonly backgrounded = new Map<number, LifecycleEvent>();
	private readonly timers = new Set<TimerHandle>();
	private readonly inspections: Promise<void>[] = [];
	private inspecting = 0;
	private epochs = 0;
	private httpFailing = false;
	private limited = false;
	/** Tokens an app crash legitimately lost (not durable anywhere). */
	unacked = 0;
	readonly counts: Record<FaultAction["t"], number> = {
		engineCrash: 0, appCrash: 0, commitCrash: 0, idbWipe: 0, idbLost: 0, offline: 0, ioFail: 0, background: 0,
		socketDrop: 0, relayRestart: 0, relayDrain: 0, httpFail: 0, dailyLimit: 0, epochReset: 0, clockSkew: 0,
		keyStoreLoss: 0, keyRoll: 0, revoke: 0, epochRestore: 0, hostileReplay: 0, hostileDowngrade: 0,
	};
	/** Suite-1 faults (null in a suite-0 run: they are skipped). */
	readonly e2ee: E2eeFaults | null;

	constructor(
		private readonly clock: VirtualClock,
		private readonly devs: readonly SimDevice[],
		private readonly net: SimNet,
		private readonly ledger: TokenLedger,
		o: { readonly suite1?: boolean; readonly weights?: FaultWeights | null; readonly initialRk?: () => Uint8Array } = {},
	) {
		this.e2ee = o.suite1 ? new E2eeFaults(clock, devs, net, (i) => this.down.has(i), (o.weights?.epochRestore ?? 0) > 0, o.initialRk ?? null) : null;
	}

	/** run.ts, after every plan step. */
	afterStep(): void {
		this.e2ee?.afterStep();
	}

	isDown(i: number): boolean {
		return this.down.has(i);
	}

	isBackground(i: number): boolean {
		return this.backgrounded.has(i);
	}

	private later(ms: number, fn: () => void): void {
		const h = this.clock.setTimer(ms, () => {
			this.timers.delete(h);
			fn();
		}, "sim-fault");
		this.timers.add(h);
	}

	run(f: FaultAction): string {
		switch (f.t) {
			case "relayRestart":
				this.net.relay.restart();
				this.counts.relayRestart++;
				return "fault relayRestart";
			case "relayDrain":
				this.net.relay.drain();
				this.counts.relayDrain++;
				return "fault relayDrain";
			case "httpFail":
				if (this.httpFailing) return "skip fault httpFail: already failing";
				this.httpFailing = true;
				this.net.relay.setHttpFailure(true);
				this.counts.httpFail++;
				this.later(f.durationMs, () => this.healHttp());
				return `fault httpFail ${f.durationMs}ms`;
			case "dailyLimit":
				if (this.limited) return "skip fault dailyLimit: already limited";
				this.limited = true;
				this.net.relay.setDailyLimit(true, f.durationMs);
				this.counts.dailyLimit++;
				this.later(f.durationMs, () => this.healLimit());
				return `fault dailyLimit ${f.durationMs}ms`;
			case "epochReset": {
				const epoch = `sim-epoch-reset-${++this.epochs}` as VaultEpoch;
				this.net.relay.resetEpoch(epoch);
				this.counts.epochReset++;
				return `fault epochReset ${epoch}`;
			}
			case "keyRoll":
			case "revoke":
			case "epochRestore":
			case "hostileReplay":
			case "hostileDowngrade": {
				if (!this.e2ee) return `skip fault ${f.t}: suite 0`;
				if ("dev" in f && this.down.has(f.dev)) return `skip fault ${this.devs[f.dev]?.name ?? "?"} ${f.t}: app down`;
				const line = this.e2ee.run(f);
				if (!line.startsWith("skip")) this.counts[f.t]++;
				return line;
			}
			default:
				return this.runDevice(f);
		}
	}

	private runDevice(f: Extract<FaultAction, { dev: number }>): string {
		const d = this.devs[f.dev];
		if (!d) return `skip fault ${f.t}: no device`;
		const tag = `fault ${d.name} ${f.t}`;
		if (this.down.has(f.dev)) return `skip ${tag}: app down`;
		switch (f.t) {
			case "engineCrash":
				d.crashEngine();
				break;
			case "appCrash":
				this.crash(f.dev, f.downMs, {});
				this.counts.appCrash++;
				return `${tag} down ${f.downMs}ms`;
			case "commitCrash": {
				if (this.armed.has(f.dev)) return `skip ${tag}: already armed`;
				this.armed.add(f.dev);
				const storage = d.storage;
				let left = f.commits;
				storage.setCommitHook(() => {
					if (--left > 0) return "commit";
					storage.setCommitHook(null);
					queueMicrotask(() => {
						if (!this.armed.delete(f.dev) || this.down.has(f.dev) || d.storage !== storage) return;
						this.crash(f.dev, f.downMs, {});
					});
					return f.when === "before" ? "crash-before" : "crash-after";
				});
				this.counts.commitCrash++;
				return `${tag} at +${f.commits} ${f.when}, down ${f.downMs}ms`;
			}
			case "idbWipe":
				this.crash(f.dev, f.downMs, { wipe: true, dropMirrors: !f.mirrors });
				this.counts.idbWipe++;
				return `${tag} mirrors=${f.mirrors} down ${f.downMs}ms`;
			case "idbLost":
				void d.storage.listDatabases().then((names) => names.forEach((n) => d.storage.loseConnection(n)), () => undefined);
				break;
			case "offline":
				if (this.offline.has(f.dev)) return `skip ${tag}: already offline`;
				this.offline.add(f.dev);
				d.setOnline(false);
				this.later(f.durationMs, () => this.reconnect(f.dev));
				this.counts.offline++;
				return `${tag} ${f.durationMs}ms`;
			case "ioFail":
				d.vault.failNextOps += f.ops;
				this.counts.ioFail++;
				return `${tag} x${f.ops}`;
			case "background":
				if (this.backgrounded.has(f.dev)) return `skip ${tag}: already backgrounded`;
				this.backgrounded.set(f.dev, f.event);
				d.platform.emit(f.event);
				this.later(f.durationMs, () => this.foreground(f.dev));
				this.counts.background++;
				return `${tag} ${f.event} ${f.durationMs}ms`;
			case "socketDrop":
				this.net.relay.dropSession(d.deviceId as DeviceId, f.code);
				this.counts.socketDrop++;
				return `${tag} ${f.code}`;
			case "clockSkew":
				d.wallSkewMs += f.deltaMs;
				this.counts.clockSkew++;
				return `${tag} ${f.deltaMs}`;
			case "keyStoreLoss":
				// SecretStorage (the OS keychain) wiped while the app is down: it restarts pinned, key-missing "no-key".
				if (!this.e2ee) return `skip ${tag}: suite 0`;
				this.crash(f.dev, f.downMs, { wipeSecrets: true });
				this.e2ee.scheduleRekey(f.dev, f.downMs + f.rekeyMs);
				this.counts.keyStoreLoss++;
				return `${tag} down ${f.downMs}ms rekey +${f.rekeyMs}ms`;
		}
		this.counts[f.t]++;
		return tag;
	}

	/** App crash of device i (optionally with an IDB wipe); restart after downMs. */
	private crash(i: number, downMs: number, o: { readonly wipe?: boolean; readonly dropMirrors?: boolean; readonly wipeSecrets?: boolean }): void {
		const d = this.devs[i]!;
		const onDisk = diskTokens(this.devs);
		const candidates = this.ledger.live().filter((e) => e.dev === d.name && !onDisk.has(e.token)).map((e) => e.token);
		const copy = d.crashApp(o);
		if (o.wipeSecrets) d.secretBacking.clear();
		this.armed.delete(i);
		this.down.add(i);
		this.backgrounded.delete(i);
		this.later(downMs, () => this.restart(i));
		if (candidates.length > 0) this.inspect(copy, d.deviceId as DeviceId, candidates);
	}

	private inspect(copy: MemStoragePort, deviceId: DeviceId, candidates: readonly string[]): void {
		this.inspecting++;
		this.inspections.push(inspectStore(this.clock, copy, deviceId).then((texts) => {
			const kept = new Set<string>();
			for (const t of texts) for (const tok of tokensIn(t)) kept.add(tok);
			for (const tok of candidates) {
				if (kept.has(tok) || this.ledger.entries.get(tok)?.state !== "live") continue;
				this.ledger.unacked(tok);
				this.unacked++;
			}
		}).finally(() => this.inspecting--));
	}

	/** Wait (running the clock) for every crash inspection. */
	async settle(horizonMs = 120_000): Promise<boolean> {
		if (this.inspecting > 0) await this.clock.runUntil(() => this.inspecting === 0, horizonMs);
		await Promise.all(this.inspections);
		const e2ee = this.e2ee ? await this.e2ee.stop(horizonMs) : true;
		return this.inspecting === 0 && e2ee;
	}

	private restart(i: number): void {
		const d = this.devs[i];
		if (!d || !this.down.delete(i)) return;
		void d.restartApp().catch(() => undefined);
	}

	private reconnect(i: number): void {
		const d = this.devs[i];
		if (!d || !this.offline.delete(i)) return;
		d.setOnline(true);
	}

	private foreground(i: number): void {
		const d = this.devs[i];
		const ev = this.backgrounded.get(i);
		if (!d || ev === undefined) return;
		this.backgrounded.delete(i);
		if (!this.down.has(i)) d.platform.emit(ev === "freeze" ? "resume" : "visible");
	}

	private healHttp(): void {
		this.httpFailing = false;
		this.net.relay.setHttpFailure(false);
	}

	private healLimit(): void {
		this.limited = false;
		this.net.relay.setDailyLimit(false);
	}

	/** All faults off: cancel pending fault timers, reconnect, restart, foreground, no I/O failures. */
	heal(): void {
		for (const h of this.timers) this.clock.clearTimer(h);
		this.timers.clear();
		for (const i of [...this.offline]) this.reconnect(i);
		for (const i of [...this.backgrounded.keys()]) this.foreground(i);
		for (const i of [...this.down]) this.restart(i);
		for (const i of [...this.armed]) this.devs[i]?.storage.setCommitHook(null);
		this.armed.clear();
		this.healHttp();
		this.healLimit();
		for (const d of this.devs) d.vault.failNextOps = 0;
		this.e2ee?.heal();
	}
}
