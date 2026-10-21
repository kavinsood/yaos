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
 *              flow, and targeted ones (targetedDrop: right after an APPEND
 *              was admitted, right before a held PROVISIONAL's COMMIT_NOTICE,
 *              right before STREAM_RECEIPTS); live messages lost on an open
 *              socket (lostSend: a send the server swallowed, the client's gap
 *              feed recovers); a failed group commit (commitFail: durability,
 *              PROVISIONAL holders dropped; or the runtime lost after the write,
 *              before fan-out); drawn only by RELAY_FAULTS; relay restart (STREAM_RESEND, unreceipted frames lost;
 *              with relaySubsLost every subscription is empty until its
 *              client resends it);
 *              graceful drain; HTTP failures; daily limit; vault epoch reset
 *   blob store stalls (the whole path, or PUT bodies only; no byte moves: the idle
 *              window or a link abort ends the call) and slow periods (12 KiB/s ..
 *              1 MiB/s), blobStore.ts;
 *              drawn only by BLOB_FAULTS
 *   world      wall-clock jumps (monotonic intact)
 *   identity   clone: with one app down, its user copies another device's vault folder over its own (notes, config
 *              dir with data.json, plugins/yaos/state/ with the other's mirrors) and opens it as a new vault
 *              registration; both run (identity-per-store §4 "Clone"). syncedConfig: a sync tool carries
 *              plugins/yaos/ (data.json, state/) between two running devices for a while. Drawn only by
 *              CLONE_FAULTS; skipped in a suite-1 run (the copy carries no keychain)
 *   suspend    suspend-kill with a budget: hidden / pagehide / freeze, then the OS
 *              kills the app after B storage commits (0: at the event, before
 *              any posted work runs; null: never), with the host's saveViews
 *              landed or lost; restart from the crash copy. Drawn only by
 *              SUSPEND_FAULTS (or forced by run.ts SimConfig.suspend); every
 *              event's at-risk tokens and how far the flush got are recorded
 *              (SuspendRecord) so the runner can measure loss per budget
 *   suite 1    key-store loss, forced and concurrent rolls, revoke + re-key,
 *              point-in-time restore, hostile replay and downgrade
 *              (e2eeFaults.ts; drawn only by E2EE_FAULTS in a suite-1 run)
 *
 * Token durability across an app crash: a token typed on the crashed device
 * may be lost only if it was on no disk, in no trash and not in the device's
 * committed storage (inspectStore over a crash copy, resolved asynchronously
 * as the clock runs; settle() waits for every inspection before the checks).
 */

import type { DeviceId } from "../core/types";
import type { LifecycleEvent } from "../ports/platform";
import type { TimerHandle } from "../ports/clock";
import type { SimStallScope } from "./blobStore";
import type { DropPoint } from "./relay";
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
	/**
	 * Device `dev`'s socket is lost at the next `at` point of its frame flow (a-relay-engine DropPoint); with offlineMs
	 * the network stays down that long (a tunnel, a dead Wi-Fi): its resend comes late, maybe past the dedupe window.
	 */
	| { readonly t: "targetedDrop"; readonly dev: number; readonly at: DropPoint; readonly offlineMs: number }
	/** The next `count` live messages to `dev` are lost while its socket stays open. */
	| { readonly t: "lostSend"; readonly dev: number; readonly count: number }
	/** The next group commit (holding a PROVISIONAL some socket was sent, with `provisional`) fails. */
	| { readonly t: "commitFail"; readonly fault: "durability" | "restart-after"; readonly provisional: boolean }
	| { readonly t: "relayRestart" }
	/** Relay restart whose socket attachments kept no subscription (overflow): every set empty until resent. */
	| { readonly t: "relaySubsLost" }
	| { readonly t: "relayDrain" }
	| { readonly t: "httpFail"; readonly durationMs: number }
	| { readonly t: "dailyLimit"; readonly durationMs: number }
	| { readonly t: "epochReset" }
	| { readonly t: "clockSkew"; readonly dev: number; readonly deltaMs: number }
	| E2eeFaultAction
	| { readonly t: "blobStall"; readonly durationMs: number; readonly scope: SimStallScope }
	| { readonly t: "blobSlow"; readonly durationMs: number; readonly bytesPerSec: number }
	| SuspendKillAction
	/** Device `dev` (app down for downMs) becomes a clone of device `src`'s vault folder (SimDevice.cloneFrom). */
	| { readonly t: "clone"; readonly dev: number; readonly src: number; readonly downMs: number }
	/** A sync tool carries plugins/yaos/ between `dev` and `peer` for durationMs (dev's data.json wins). */
	| { readonly t: "syncedConfig"; readonly dev: number; readonly peer: number; readonly durationMs: number };

/**
 * Backgrounding the OS ends with a kill: `event` fires (the host's synchronous flush runs), then the app dies after
 * `budget` storage commits on the device (0: right after the event's synchronous part, before any posted message,
 * timer or commit runs; null: never killed, foreground after `durationMs`), or at SUSPEND_DEADLINE_MS of virtual time
 * if the budget is not used up by then. `save`: whether the host's saveViews (Obsidian's view save) landed on disk
 * before death ("landed": the views saveViews picks, one per bound doc, are saved synchronously at the event) or died with the process
 * ("lost": no view saves anything until the kill; with budget null only the event's own saveViews is dropped).
 */
export interface SuspendKillAction {
	readonly t: "suspendKill";
	readonly dev: number;
	readonly event: "hidden" | "pagehide" | "freeze";
	readonly budget: number | null;
	readonly save: "landed" | "lost";
	readonly downMs: number;
	readonly durationMs: number;
}

/** A suspend-kill whose budget was not used up dies here (the OS kills a suspended app eventually). */
export const SUSPEND_DEADLINE_MS = 5_000;
/** After a clone, the user removes the abandoned store's registration in the console this much later. */
export const CLONE_REMOVE_MS = 60_000;
/** Budgets the random matrix draws (null: never killed). */
export const SUSPEND_BUDGETS: readonly (number | null)[] = [0, 1, 2, 3, 5, null];

/** One suspend-kill event as it ran (stats; run.ts resolves `lost` at the end of the run). */
export interface SuspendRecord {
	readonly dev: string;
	readonly event: SuspendKillAction["event"];
	readonly budget: number | null;
	readonly save: SuspendKillAction["save"];
	/** Live tokens typed on the device and on no disk at the event (only these may be lost legitimately). */
	readonly atRisk: readonly string[];
	/** ... of which in the device's committed storage at the event (inspection; filled asynchronously). */
	committedAtEvent: Set<string> | null;
	/** Open frames (non-empty builders) in the engine at the event and at the kill. */
	readonly openFramesAtEvent: number;
	openFramesAtKill: number | null;
	/** Stores of each storage commit after the event, until the kill (or the deadline when never killed). */
	readonly commits: string[];
	/** Side-file (mirror) writes after the event, until the kill / deadline. */
	sideWrites: number;
	/** Views saved to disk after the event, until the kill / deadline. */
	saves: number;
	killedBy: "budget" | "deadline" | "heal" | "never" | null;
}

export type FaultWeights = Readonly<Record<FaultAction["t"], number>>;

export const DEFAULT_FAULTS: FaultWeights = {
	engineCrash: 3, appCrash: 2, commitCrash: 2, idbWipe: 1, idbLost: 1, offline: 4, ioFail: 2, background: 3,
	socketDrop: 4, relayRestart: 1, relayDrain: 1, httpFail: 1, dailyLimit: 0.5, epochReset: 0.3, clockSkew: 1,
	// Suite-1 faults (e2eeFaults.ts) and the blob store's (BLOB_FAULTS): weight 0 here, so the plans draw exactly
	// as before (generateFault skips zero weights, and these keys come last).
	keyStoreLoss: 0, keyRoll: 0, revoke: 0, epochRestore: 0, hostileReplay: 0, hostileDowngrade: 0,
	blobStall: 0, blobSlow: 0,
	// Subscriptions (SUBS_FAULTS): last and weight 0 here, so the default plans draw as before.
	relaySubsLost: 0,
	// Suspend-kill (SUSPEND_FAULTS): last and weight 0 here, so the default plans draw as before.
	suspendKill: 0,
	// Identity per store (CLONE_FAULTS): last and weight 0 here, so the default plans draw as before.
	clone: 0, syncedConfig: 0,
	// Targeted relay faults (RELAY_FAULTS): last and weight 0 here, so the default plans draw as before.
	targetedDrop: 0, lostSend: 0, commitFail: 0,
};

/**
 * The default matrix plus the relay faults at targeted points of the frame flow: socket drops right after an APPEND,
 * before a held PROVISIONAL's notice and before the receipts; live messages lost on an open socket (gap feed); failed
 * group commits (durability: PROVISIONAL holders dropped; runtime lost after the write). Paired with the checkpoint
 * world's small dedupe windows (run.ts), a resend after a lost receipt can outlive its original's window.
 */
export const RELAY_FAULTS: FaultWeights = { ...DEFAULT_FAULTS, socketDrop: 2, targetedDrop: 6, lostSend: 2, commitFail: 2, offline: 5 };

/**
 * The default matrix plus a copied vault folder run as a second device (clone) and a sync tool carrying the plugin's
 * folder between two devices (syncedConfig): identity-per-store §4, §5.2.
 */
export const CLONE_FAULTS: FaultWeights = { ...DEFAULT_FAULTS, clone: 1.5, syncedConfig: 1 };

/** The default matrix plus suspend-kill with a budget (opt-in, like BLOB_FAULTS). */
export const SUSPEND_FAULTS: FaultWeights = { ...DEFAULT_FAULTS, suspendKill: 4 };

/**
 * Subscription churn: relay restarts (sets restored from the attachments, then resent), restarts that lose every
 * set, socket drops (a new session subscribes again) and backgrounding (park / wake), over the default matrix.
 */
export const SUBS_FAULTS: FaultWeights = { ...DEFAULT_FAULTS, relayRestart: 3, relaySubsLost: 3, socketDrop: 6, background: 4 };

/** The default matrix plus the suite-1 faults (a `crypto: "suite1"` run; in a suite-0 run they are skipped). */
export const E2EE_FAULTS: FaultWeights = {
	...DEFAULT_FAULTS,
	keyStoreLoss: 1, keyRoll: 1.5, revoke: 0.7, epochRestore: 0.5, hostileReplay: 2, hostileDowngrade: 1,
};

/**
 * "Two devices edit the same canvas offline" (the concurrent canvas matrices): offline periods dominate (both
 * devices are often offline at once, each editing its own copy of the same canvases), the default faults around them.
 */
export const CANVAS_FAULTS: FaultWeights = { ...DEFAULT_FAULTS, offline: 16 };

/** The default matrix plus blob store stalls and slow periods (the "blob stall/slow faults" matrices). */
export const BLOB_FAULTS: FaultWeights = { ...DEFAULT_FAULTS, blobStall: 5, blobSlow: 5 };

/** Slow-period rates: log-uniform over EDGE / congested cellular (12-25 KiB/s, adapters/httpBlob.ts) .. 1 MiB/s. */
const SLOW_MIN_BPS = 12 * 1024;
const SLOW_MAX_BPS = 1024 * 1024;

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
		case "relaySubsLost": return { t: "relaySubsLost" };
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
		case "blobStall": return { t: "blobStall", durationMs: rng.range(2_000, 90_000), scope: rng.chance(0.5) ? "path" : "put" };
		case "blobSlow": return { t: "blobSlow", durationMs: rng.range(5_000, 150_000), bytesPerSec: Math.round(SLOW_MIN_BPS * (SLOW_MAX_BPS / SLOW_MIN_BPS) ** rng.float()) };
		case "clone": return { t: "clone", dev, src: (dev + 1 + rng.int(Math.max(1, devices - 1))) % devices, downMs: rng.range(200, 10_000) };
		case "syncedConfig": return { t: "syncedConfig", dev, peer: (dev + 1 + rng.int(Math.max(1, devices - 1))) % devices, durationMs: rng.range(5_000, 120_000) };
		case "targetedDrop": return { t: "targetedDrop", dev, at: rng.pick(["append", "notice", "notice", "receipt", "receipt"] as const), offlineMs: rng.chance(0.5) ? 0 : rng.range(1_000, 60_000) };
		case "lostSend": return { t: "lostSend", dev, count: rng.range(1, 4) };
		case "commitFail": return { t: "commitFail", fault: rng.chance(0.6) ? "durability" : "restart-after", provisional: rng.chance(0.7) };
		case "suspendKill": return { t: "suspendKill", dev, event: rng.pick(["hidden", "pagehide", "freeze"] as const), budget: rng.pick(SUSPEND_BUDGETS), save: rng.chance(0.5) ? "landed" : "lost", downMs: rng.range(200, 10_000), durationMs: rng.range(100, 30_000) };
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

/** Open frames (edits in a non-empty builder) in the device's engine. */
function openFrames(d: SimDevice): number {
	let n = 0;
	for (const h of d.vrt?.log.c.handles.all() ?? []) if (!h.builder.empty) n++;
	return n;
}

export class FaultState {
	private readonly down = new Set<number>();
	/** Devices that have not joined yet (holdBack); also in `down`. */
	private readonly held = new Set<number>();
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
	/** The canvas world's view of a clone fault (run.ts): why the copy cannot be taken now, and the copy itself. */
	canvasClone: {
		readonly blocked: (src: number) => string | null;
		readonly copiedOver: (dst: SimDevice, others: readonly SimDevice[]) => void;
	} | null = null;
	readonly counts: Record<FaultAction["t"], number> = {
		engineCrash: 0, appCrash: 0, commitCrash: 0, idbWipe: 0, idbLost: 0, offline: 0, ioFail: 0, background: 0,
		socketDrop: 0, relayRestart: 0, relayDrain: 0, httpFail: 0, dailyLimit: 0, epochReset: 0, clockSkew: 0,
		keyStoreLoss: 0, keyRoll: 0, revoke: 0, epochRestore: 0, hostileReplay: 0, hostileDowngrade: 0,
		blobStall: 0, blobSlow: 0, relaySubsLost: 0, suspendKill: 0, clone: 0, syncedConfig: 0,
		targetedDrop: 0, lostSend: 0, commitFail: 0,
	};
	/** The device pair a sync tool links now (syncedConfig), and how to end it. */
	private synced: { readonly a: number; readonly b: number; readonly end: () => void } | null = null;
	/** Every suspend-kill that ran, in order. */
	readonly suspends: SuspendRecord[] = [];
	/** Suspend-kills not killed yet (heal kills them). */
	private readonly pendingKills = new Map<number, () => void>();
	/** Stores a clone abandoned, not yet removed in the console (CLONE_REMOVE_MS): removed at heal. */
	private readonly abandoned = new Set<DeviceId>();
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
			case "relaySubsLost":
				this.net.relay.restart(true);
				this.counts.relaySubsLost++;
				return "fault relaySubsLost";
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
			case "blobStall":
				if (this.net.blobs.stalled !== null) return "skip fault blobStall: already stalled";
				this.net.blobs.setStall(f.scope);
				this.counts.blobStall++;
				this.later(f.durationMs, () => this.net.blobs.setStall(null));
				return `fault blobStall ${f.scope} ${f.durationMs}ms`;
			case "blobSlow":
				if (this.net.blobs.slowRate !== null) return "skip fault blobSlow: already slow";
				this.net.blobs.setSlow(f.bytesPerSec);
				this.counts.blobSlow++;
				this.later(f.durationMs, () => this.net.blobs.setSlow(null));
				return `fault blobSlow ${f.durationMs}ms ${f.bytesPerSec}B/s`;
			case "commitFail":
				this.net.relay.armCommitFault(f.fault, f.provisional ? "provisional" : "any");
				this.counts.commitFail++;
				return `fault commitFail ${f.fault}${f.provisional ? " (provisional)" : ""}`;
			case "epochReset": {
				const epoch = `sim-epoch-reset-${++this.epochs}`;
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
				this.net.relay.dropSession(d.deviceId, f.code);
				this.counts.socketDrop++;
				return `${tag} ${f.code}`;
			case "targetedDrop": {
				const i = f.dev;
				// Fired by the relay later: the network is lost then (unless the device is down or offline already).
				const then = f.offlineMs > 0 ? () => {
					if (this.down.has(i) || this.offline.has(i) || this.devs[i] !== d) return;
					this.offline.add(i);
					d.setOnline(false);
					this.later(f.offlineMs, () => this.reconnect(i));
				} : null;
				this.net.relay.armDrop(d.deviceId, f.at, then);
				this.counts.targetedDrop++;
				return `${tag} at ${f.at}${f.offlineMs > 0 ? `, offline ${f.offlineMs}ms` : ""}`;
			}
			case "lostSend":
				this.net.relay.loseSends(d.deviceId, f.count);
				this.counts.lostSend++;
				return `${tag} x${f.count}`;
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
			case "suspendKill":
				return this.suspendKill(f, d, tag);
			case "clone":
				return this.clone(f, d, tag);
			case "syncedConfig":
				return this.syncConfig(f, d, tag);
		}
		this.counts[f.t]++;
		return tag;
	}

	private suspendKill(f: SuspendKillAction, d: SimDevice, tag: string): string {
		if (this.armed.has(f.dev)) return `skip ${tag}: already armed`;
		if (this.backgrounded.has(f.dev)) return `skip ${tag}: already backgrounded`;
		const i = f.dev;
		const onDisk = diskTokens(this.devs);
		const atRisk = this.ledger.live().filter((e) => e.dev === d.name && !onDisk.has(e.token)).map((e) => e.token);
		const rec: SuspendRecord = {
			dev: d.name, event: f.event, budget: f.budget, save: f.save, atRisk, committedAtEvent: null,
			openFramesAtEvent: openFrames(d), openFramesAtKill: null, commits: [], sideWrites: 0, saves: 0, killedBy: null,
		};
		this.suspends.push(rec);
		if (atRisk.length > 0) {
			this.inspecting++;
			this.inspections.push(inspectStore(this.clock, d.storage.copy()).then((texts) => {
				const kept = new Set<string>();
				for (const t of texts) for (const tok of tokensIn(t)) kept.add(tok);
				rec.committedAtEvent = new Set(atRisk.filter((t) => kept.has(t)));
			}).finally(() => this.inspecting--));
		}
		const storage = d.storage;
		const ws = d.workspace;
		const side0 = d.sideFiles.writes;
		const saves0 = () => ws.views_().reduce((n, v) => n + v.counters.saves, 0);
		const savesAt = saves0();
		this.counts.suspendKill++;
		const label = `${tag} ${f.event} budget ${f.budget ?? "never"} save ${f.save}`;
		// Commits after the event (until the kill; with no kill, until the deadline: how long the whole flush takes).
		let n = 0;
		const finish = () => {
			storage.setCommitHook(null);
			this.armed.delete(i);
			this.pendingKills.delete(i);
			rec.sideWrites = d.sideFiles.writes - side0;
			rec.saves = saves0() - savesAt;
			rec.openFramesAtKill = openFrames(d);
		};
		const kill = (by: "budget" | "deadline" | "heal") => {
			if (rec.killedBy !== null) return;
			rec.killedBy = by;
			finish();
			if (this.down.has(i) || d.storage !== storage) return;
			this.crash(i, f.downMs, {});
		};
		if (f.save === "lost") ws.savesBlocked = true;
		this.backgrounded.set(i, f.event);
		d.platform.emit(f.event);
		// The host's own saveViews (hostRuntime onLifecycle), landed in full before death.
		if (f.save === "landed") {
			const bm = d.runtime.bindings;
			for (const { view } of bm.viewsToSave(bm.boundDocs())) if (view.isDirty()) void view.save();
		}
		if (f.budget === 0) {
			kill("budget");
			return label;
		}
		this.armed.add(i);
		storage.setCommitHook((info) => {
			n++;
			rec.commits.push(info.stores.join("+"));
			if (f.budget === null || n < f.budget) return "commit";
			storage.setCommitHook(null);
			queueMicrotask(() => kill("budget"));
			return "crash-after";
		});
		if (f.budget === null) {
			// Only the event's own saveViews is dropped: every save it starts runs before the next timer.
			if (f.save === "lost") this.later(0, () => (ws.savesBlocked = false));
			const done = () => {
				if (rec.killedBy !== null) return;
				rec.killedBy = "never";
				finish();
			};
			this.pendingKills.set(i, done);
			this.later(SUSPEND_DEADLINE_MS, done);
			this.later(f.durationMs, () => this.foreground(i));
			return label;
		}
		this.pendingKills.set(i, () => kill("heal"));
		this.later(SUSPEND_DEADLINE_MS, () => kill("deadline"));
		return label;
	}

	/**
	 * The clone fault: `d`'s app dies (as appCrash: tokens on no disk and in no committed storage are allowed lost),
	 * then its user copies src's folder over d's and opens it as a new vault registration. What lived only in d's
	 * folder or d's old store (now never opened: another install key) went with the user's copy: exempt (deleted).
	 */
	private clone(f: Extract<FaultAction, { t: "clone" }>, d: SimDevice, tag: string): string {
		const src = this.devs[f.src];
		if (this.e2ee) return `skip ${tag}: suite 1 (the copy carries no keychain)`;
		if (!src || src === d) return `skip ${tag}: no source`;
		if (this.down.has(f.src)) return `skip ${tag}: source app down`;
		if (this.synced && [f.dev, f.src].some((i) => i === this.synced?.a || i === this.synced?.b)) return `skip ${tag}: config synced`;
		const midSave = this.canvasClone?.blocked(f.src) ?? null;
		if (midSave) return `skip ${tag}: ${midSave}`;
		const old = [...d.identities];
		this.crash(f.dev, f.downMs, {});
		const others = diskTokens(this.devs.filter((x) => x !== d));
		const mine = new Set<string>();
		for (const text of d.vault.snapshot().values()) for (const t of tokensIn(text)) mine.add(t);
		// Typed on dst (live, or unacked by a crash: a half-written save or an unsent edit the copy replaced).
		for (const e of this.ledger.entries.values()) if (e.dev === d.name) mine.add(e.token);
		for (const t of mine) if (!others.has(t)) this.ledger.deleted(t);
		this.canvasClone?.copiedOver(d, this.devs.filter((x) => x !== d));
		d.cloneFrom(src);
		// The user removes the old registration in the console later (or inactivity retirement does): a create of the
		// abandoned store whose body never reached the relay is then dropped, and re-created by whoever holds the file
		// (DESIGN §i.5 "Abandoned creates").
		for (const id of old) this.abandoned.add(id);
		this.later(CLONE_REMOVE_MS, () => this.removeAbandoned());
		this.counts.clone++;
		return `${tag} of ${src.name}, down ${f.downMs}ms`;
	}

	private removeAbandoned(): void {
		for (const id of this.abandoned) this.net.removeDevice(id);
		this.abandoned.clear();
	}

	/**
	 * syncedConfig: a sync tool (Syncthing, iCloud Drive) carries <configDir>/plugins/yaos/ between two running devices:
	 * the side files both ways, 2 s after each change, and data.json (dev's grant and pin win; the peer's next runtime
	 * start uses them). Each store writes only its own state dir, so the carried dirs are foreign to the receiver.
	 */
	private syncConfig(f: Extract<FaultAction, { t: "syncedConfig" }>, d: SimDevice, tag: string): string {
		const peer = this.devs[f.peer];
		if (this.e2ee) return `skip ${tag}: suite 1`;
		if (!peer || peer === d) return `skip ${tag}: no peer`;
		if (this.down.has(f.peer)) return `skip ${tag}: peer app down`;
		if (this.synced) return `skip ${tag}: already synced`;
		const carry = (to: SimDevice) => (path: string, bytes: Uint8Array | null) => {
			this.later(2_000, () => {
				if (bytes) to.sideFiles.files.set(path, bytes);
				else to.sideFiles.files.delete(path);
			});
		};
		for (const [from, to] of [[d, peer], [peer, d]] as const) {
			for (const [k, v] of from.sideFiles.files) if (!to.sideFiles.files.has(k)) to.sideFiles.files.set(k, v.slice());
			from.sideFiles.onChange = carry(to);
		}
		peer.grantSecret = d.grantSecret;
		peer.pinData = structuredClone(d.pinData);
		const end = () => {
			d.sideFiles.onChange = null;
			peer.sideFiles.onChange = null;
			this.synced = null;
		};
		this.synced = { a: f.dev, b: f.peer, end };
		this.later(f.durationMs, end);
		this.counts.syncedConfig++;
		return `${tag} with ${peer.name} ${f.durationMs}ms`;
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
		if (candidates.length > 0) this.inspect(copy, candidates);
	}

	private inspect(copy: MemStoragePort, candidates: readonly string[]): void {
		this.inspecting++;
		this.inspections.push(inspectStore(this.clock, copy).then((texts) => {
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

	/** A device whose app has not started yet (run.ts late join): down for actors and faults until join(i) or heal. */
	holdBack(i: number): void {
		this.held.add(i);
		this.down.add(i);
	}

	/** The held-back device's app starts (a fresh device joining the vault); false if it was not held back. */
	join(i: number): boolean {
		if (!this.held.delete(i)) return false;
		this.restart(i);
		return true;
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

	/** All faults off: cancel pending fault timers, reconnect, restart, foreground, no I/O failures, blob store well. */
	heal(): void {
		// A suspend-kill still waiting for its budget dies now (restarted below); a never-killed one stops counting.
		for (const end of [...this.pendingKills.values()]) end();
		this.pendingKills.clear();
		for (const h of this.timers) this.clock.clearTimer(h);
		this.timers.clear();
		for (const i of [...this.offline]) this.reconnect(i);
		for (const i of [...this.backgrounded.keys()]) this.foreground(i);
		this.held.clear();
		for (const i of [...this.down]) this.restart(i);
		for (const i of [...this.armed]) this.devs[i]?.storage.setCommitHook(null);
		this.armed.clear();
		this.healHttp();
		this.healLimit();
		this.net.relay.disarm();
		// Calls a stall caught stay dead (blobStore.ts header): their idle windows or link aborts end them.
		this.net.blobs.setStall(null);
		this.net.blobs.setSlow(null);
		for (const d of this.devs) d.vault.failNextOps = 0;
		this.synced?.end();
		this.e2ee?.heal();
		this.removeAbandoned();
	}
}
