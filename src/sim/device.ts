/**
 * SimDevice: one simulated Obsidian device = SimVault + SimWorkspace +
 * SimPlatform + HostRuntime + engine carrier (stand-in engine over an inline
 * pair on the virtual clock, presented to the host as a "worker" so crash,
 * restart and fallback paths run).
 *
 * INTEGRATION: the carrier factory switches to WP-C's createEngine with sim
 * ports (WP-A sim relay/storage) instead of createStandinEngine + StandinHub.
 */

import type { DeviceId, VaultId } from "../core/types";
import type { Unsubscribe } from "../ports/common";
import type { LifecycleEvent, PlatformInfo, PlatformPort } from "../ports/platform";
import type { BrakeReport } from "../core/types";
import type { ProtocolError } from "../protocol/errors";
import { createInlinePair, type InlinePair } from "../protocol/inlineTransport";
import type { EngineSettings } from "../protocol/messages";
import type { StatusSnapshot } from "../protocol/status";
import type { EngineCarrier } from "../host/engineHost";
import { createHasher } from "../host/hashing";
import { HostRuntime, type HostUiSink } from "../host/hostRuntime";
import type { HostIdentity } from "../host/runtimeSupport";
import { createStandinEngine, type StandinEngine } from "../engine/__standins__/engine";
import type { StandinStore } from "../engine/__standins__/docs";
import type { StandinHub } from "../engine/__standins__/hub";
import type { VirtualClock } from "./__standins__/clock";
import { simHashPort } from "./__standins__/sha256";
import { SimConfigDir, SimSideFiles, SimVault, type CaseProfile } from "./vault";
import { SimWorkspace } from "./workspace";

export class SimPlatform implements PlatformPort {
	private readonly listeners = new Set<(e: LifecycleEvent) => void>();
	visible = true;
	online = true;
	constructor(readonly info: PlatformInfo) {}
	isVisible(): boolean {
		return this.visible;
	}
	isOnline(): boolean {
		return this.online;
	}
	onLifecycle(listener: (event: LifecycleEvent) => void): Unsubscribe {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emit(event: LifecycleEvent): void {
		if (event === "hidden" || event === "pagehide" || event === "freeze") this.visible = false;
		if (event === "visible" || event === "resume") this.visible = true;
		if (event === "online") this.online = true;
		if (event === "offline") this.online = false;
		for (const l of [...this.listeners]) l(event);
	}
}

export const SIM_SETTINGS: EngineSettings = {
	excludePatterns: [], syncAttachments: false, maxAttachmentBytes: 0, syncSettings: false,
	trashMode: "obsidian-trash", provisionalBroadcast: false, snapshots: { enabled: false, keepDaily: 0, uploadToBlobStore: false },
};

export interface SimDeviceOptions {
	readonly name: string;
	readonly clock: VirtualClock;
	readonly hub: StandinHub;
	readonly profile?: CaseProfile;
	readonly mobile?: boolean;
	/** Engine persistence delay: changes newer than this die with a crashed engine. */
	readonly persistDelayMs?: number;
	readonly watcherDelayMs?: () => number;
	/** Worker carrier unavailable / fails storage in init (OR-1 paths). */
	readonly workerMode?: "ok" | "unavailable" | "storage-fails";
}

export interface SimUiLog {
	statuses: StatusSnapshot[];
	brakes: BrakeReport[];
	notices: { level: string; code: string; message: string }[];
	fatals: ProtocolError[];
	carriers: { carrier: string | null; ready: boolean; fallbackReason: string | null }[];
}

export class SimDevice {
	readonly vault: SimVault;
	readonly configDir: SimConfigDir;
	readonly sideFiles = new SimSideFiles();
	readonly platform: SimPlatform;
	readonly store: StandinStore = new Map();
	readonly ui: SimUiLog = { statuses: [], brakes: [], notices: [], fatals: [], carriers: [] };
	workspace: SimWorkspace;
	/** Every workspace this device had (one per app incarnation), for invariant counters. */
	readonly workspaces: SimWorkspace[] = [];
	runtime: HostRuntime;
	engine: StandinEngine | null = null;
	private pair: InlinePair | null = null;
	engineStarts = 0;
	/** Texts that existed only in host memory when the app crashed (pending conflict copies; known gap). */
	readonly crashLost: string[] = [];
	readonly deviceId: DeviceId;

	constructor(readonly opts: SimDeviceOptions) {
		const hasher = createHasher(simHashPort());
		this.deviceId = `dev-${opts.name}` as DeviceId;
		this.vault = new SimVault({ clock: opts.clock, hasher, profile: opts.profile ?? "case-sensitive", watcherDelayMs: opts.watcherDelayMs });
		this.configDir = new SimConfigDir(opts.clock);
		const mobile = opts.mobile ?? false;
		this.platform = new SimPlatform({ os: mobile ? "ios" : "macos", isMobile: mobile, isTablet: false, hardwareConcurrency: mobile ? 6 : 8, deviceMemoryGiB: mobile ? 4 : null, workerSupported: true });
		this.workspace = new SimWorkspace({ clock: opts.clock, vault: this.vault });
		this.workspaces.push(this.workspace);
		this.runtime = this.makeRuntime();
	}

	get name(): string {
		return this.opts.name;
	}

	private carrier(kind: "worker" | "inline"): EngineCarrier {
		const pair = createInlinePair({ schedule: this.opts.clock.schedule });
		const initError: ProtocolError | null = kind === "worker" && this.opts.workerMode === "storage-fails" ? { code: "storage-lost", message: "IndexedDB unavailable in worker", retryable: false } : null;
		const handle = createStandinEngine(pair.engine, {
			carrier: kind, clock: this.opts.clock, hash: simHashPort(), hub: this.opts.hub,
			memberId: this.deviceId, store: this.store, persistDelayMs: this.opts.persistDelayMs ?? 0, initError,
		});
		this.pair = pair;
		this.engine = handle.engine;
		this.engineStarts++;
		return {
			kind,
			transport: pair.host,
			dispose: () => {
				handle.dispose();
				pair.engine.close();
			},
		};
	}

	private makeRuntime(): HostRuntime {
		return this.runtimeFor(
			{ vaultId: "sim-vault" as VaultId, deviceId: this.deviceId, deviceLabel: this.opts.name, relay: { url: "sim://hub", credential: "sim" } },
			() => SIM_SETTINGS,
			{
				onStatus: (s) => this.ui.statuses.push(s),
				onBrake: (b) => this.ui.brakes.push(b),
				onNotice: (level, code, message) => this.ui.notices.push({ level, code, message }),
				onCarrier: (c) => this.ui.carriers.push({ carrier: c.carrier, ready: c.ready, fallbackReason: c.fallbackReason }),
				onFatal: (e) => this.ui.fatals.push(e),
			},
		);
	}

	/** A HostRuntime over this device's vault/workspace/platform/carriers (plugin controller tests). */
	runtimeFor(identity: HostIdentity, settings: () => EngineSettings, ui: HostUiSink): HostRuntime {
		return new HostRuntime({
			clock: this.opts.clock, vault: this.vault, configDir: this.configDir, sideFiles: this.sideFiles,
			workspace: this.workspace, platform: this.platform, hasher: createHasher(simHashPort()),
			identity, settings,
			createWorker: () => (this.opts.workerMode === "unavailable" ? null : this.carrier("worker")),
			createInline: () => this.carrier("inline"),
			pingEnabled: true,
			timeZone: "utc",
			ui,
		});
	}

	start(): Promise<void> {
		return this.runtime.start();
	}

	/** Worker dies (OOM, OS kill): engine state newer than its persistence is lost. */
	crashEngine(reason = "sim crash"): void {
		this.engine?.dispose();
		this.pair?.kill(reason);
	}

	/** Whole app dies: unsaved editor buffers are lost, nothing flushes. Restart with `restartApp`. */
	crashApp(): void {
		for (const c of this.runtime.bindings.pendingConflictCopies()) this.crashLost.push(c.text);
		this.engine?.dispose();
		this.pair?.kill("app crash");
		this.workspace.crashAll();
		void this.runtime.stop().catch(() => undefined);
	}

	/** Fresh app process over the same disk, side files and engine store. */
	async restartApp(): Promise<void> {
		this.workspace = new SimWorkspace({ clock: this.opts.clock, vault: this.vault });
		this.workspaces.push(this.workspace);
		this.runtime = this.makeRuntime();
		await this.runtime.start();
	}

	setOnline(online: boolean): void {
		this.opts.hub.setOnline(this.deviceId, online);
		this.platform.emit(online ? "online" : "offline");
	}
}
