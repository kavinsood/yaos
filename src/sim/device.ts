/**
 * SimDevice: one simulated Obsidian device = SimVault + SimWorkspace +
 * SimPlatform + HostRuntime + the real composed engine (createEngine over an
 * inline pair on the virtual clock, presented to the host as a "worker" so
 * crash, restart and fallback paths run) on WP-A's MemStoragePort and the
 * run's SimRelay (SimNet).
 *
 * Crashes keep exactly the committed storage state (MemStoragePort.crash());
 * the dying engine's socket drops before anything else can flush.
 */

import type { DeviceId, VaultPath } from "../core/types";
import { pathKey } from "../core/paths/pathKey";
import type { Unsubscribe } from "../ports/common";
import type { BlobPort, EnginePorts } from "../ports";
import type { LifecycleEvent, PlatformInfo, PlatformPort } from "../ports/platform";
import type { BrakeReport } from "../core/types";
import type { ProtocolError } from "../protocol/errors";
import { createInlinePair, type InlinePair } from "../protocol/inlineTransport";
import type { EngineSettings } from "../protocol/messages";
import type { StatusSnapshot } from "../protocol/status";
import type { EngineCarrier } from "../host/engineHost";
import { HostRuntime, type HostUiSink } from "../host/hostRuntime";
import { createHostKeys, type HostKeys } from "../host/keys/hostKeys";
import { pinnedSuite1, pinsFromKeyring, type E2eePin, type PinFields } from "../host/keys/pin";
import { VaultKeyStore } from "../host/keys/secretStore";
import { FakeSecretStorage } from "../host/keys/testkit/fakeSecretStorage";
import { suite0PinForTest } from "../host/keys/testkit/pinFixture";
import type { HostIdentity } from "../host/runtimeSupport";
import { createNoopCrypto } from "../engine/adapters/noopCrypto";
import { createEngine, type ComposedEngine, type EngineHandle } from "../engine/compose/protocolEngine";
import type { VaultRuntime } from "../engine/compose/vaultRuntime";
import { residentText } from "../engine/compose/runtimeOps";
import { FAST_TUNING } from "../engine/runtime/testHarness";
import type { EngineTuning } from "../engine/runtime/options";
import type { ClockPort } from "../ports/clock";
import type { VirtualClock } from "./clock";
import { createDelayedSuite1, delayedHash, realWorkFor } from "./delayedCrypto";
import { simHashOracle, simHashPort } from "./hash";
import { SIM_VAULT_ID, type SimNet } from "./net";
import { hashLabel, SeededRandom } from "./random";
import { MemStoragePort } from "./storage";
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
	readonly net: SimNet;
	readonly profile?: CaseProfile;
	readonly mobile?: boolean;
	/** Settings for this device (default SIM_SETTINGS). */
	readonly settings?: () => EngineSettings;
	/** Engine diagnostics lines (debug). */
	readonly log?: (line: string) => void;
	readonly watcherDelayMs?: () => number;
	/** Worker carrier unavailable / fails storage in init (OR-1 paths). */
	readonly workerMode?: "ok" | "unavailable" | "storage-fails";
	/**
	 * The device's data.json pin (e2ee-design §12.4). Default: the test-only suite-0 fixture, the state a suite-0
	 * link leaves (so the suite-0 runs sync). null: unpinned, which is blocked and writes nothing.
	 */
	readonly pin?: E2eePin | null;
	/** The engine's blob store for each start (default none). */
	readonly blob?: () => BlobPort | null;
	/** Over FAST_TUNING (a roll trigger, the GC grace). */
	readonly tuning?: Partial<EngineTuning>;
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
	/** The device's IndexedDB (survives engine and app crashes with exactly its committed state). */
	storage: MemStoragePort;
	readonly ui: SimUiLog = { statuses: [], brakes: [], notices: [], fatals: [], carriers: [] };
	workspace: SimWorkspace;
	/** Every workspace this device had (one per app incarnation), for invariant counters. */
	readonly workspaces: SimWorkspace[] = [];
	runtime: HostRuntime;
	engine: ComposedEngine | null = null;
	/** The engine's current vault runtime (null while starting or restarting). */
	vrt: VaultRuntime | null = null;
	private handle: EngineHandle | null = null;
	private pair: InlinePair | null = null;
	engineStarts = 0;
	/** Texts that existed only in host memory when the app crashed (pending conflict copies; known gap). */
	readonly crashLost: string[] = [];
	readonly deviceId: DeviceId;
	/** The device's persistent SecretStorage contents (survives app restarts and IndexedDB wipes, like the OS keychain). */
	readonly secretBacking = new Map<string, string>();
	/** This app incarnation's SecretStorage over `secretBacking`. */
	secrets: FakeSecretStorage;
	/** The pin fields of this device's data.json. */
	pinData: PinFields;
	/** This device's wall-clock error (fault); the relay and other devices keep true time. */
	wallSkewMs = 0;
	/** The run's clock as this device sees it: shared timers and monotonic time, skewed wall time. */
	readonly deviceClock: ClockPort = {
		now: () => this.opts.clock.now() + this.wallSkewMs,
		monotonic: () => this.opts.clock.monotonic(),
		setTimer: (ms, fn) => this.opts.clock.setTimer(ms, fn),
		clearTimer: (h) => this.opts.clock.clearTimer(h),
		yieldNow: () => this.opts.clock.yieldNow(),
	};

	constructor(readonly opts: SimDeviceOptions) {
		this.deviceId = `dev-${opts.name}` as DeviceId;
		this.secrets = new FakeSecretStorage(this.secretBacking);
		this.pinData = opts.pin === null ? {} : { e2ee: opts.pin ?? suite0PinForTest() };
		this.storage = new MemStoragePort({ beforeNextTimer: opts.clock.beforeNextTimer, macrotask: opts.clock.macrotask });
		this.vault = new SimVault({ clock: opts.clock, hashes: simHashOracle(), profile: opts.profile ?? "case-sensitive", watcherDelayMs: opts.watcherDelayMs });
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
		const storageFails = kind === "worker" && this.opts.workerMode === "storage-fails";
		const n = ++this.engineStarts;
		const handle = createEngine(pair.engine, {
			carrier: kind,
			clientVersion: "sim",
			tuning: { ...FAST_TUNING, ...(this.opts.tuning ?? {}) },
			startRetryMs: 1_000,
			tzOffsetMinutes: () => 0,
			log: this.opts.log,
			onRuntime: (rt) => {
				if (this.handle === handle) this.vrt = rt;
			},
			makePorts: async (config): Promise<EnginePorts> => {
				if (storageFails) throw new Error("IndexedDB unavailable in worker");
				const random = new SeededRandom(hashLabel(`${this.deviceId}#${n}`));
				const c = config.crypto;
				// As webEngine.ts: suite 0 seals nothing; unpinned and suite 1 get the suite-1 adapter (keys zero-filled on
				// import), on Node WebCrypto behind DelayedCrypto: crypto and hash settle on a task, in seed order.
				const work = c.suite === 0 ? null : realWorkFor(this.opts.clock);
				const hash = work ? delayedHash(work, simHashPort()) : simHashPort();
				const crypto = work ? await createDelayedSuite1(work, { vaultId: config.vaultId, random, keys: c.suite === 1 ? c.keys : [] }) : createNoopCrypto(hash);
				return { relay: this.opts.net.port(this.deviceId), storage: this.storage, clock: this.deviceClock, random, crypto, hash, blob: this.opts.blob?.() ?? null };
			},
		});
		this.pair = pair;
		this.handle = handle;
		this.engine = handle.engine;
		this.vrt = null;
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
			{ vaultId: SIM_VAULT_ID, deviceId: this.deviceId, deviceLabel: this.opts.name, relay: { url: "sim://relay", credential: "sim" } },
			this.opts.settings ?? (() => SIM_SETTINGS),
			{
				onStatus: (s) => this.ui.statuses.push(s),
				onBrake: (b) => this.ui.brakes.push(b),
				onNotice: (level, code, message) => this.ui.notices.push({ level, code, message }),
				onCarrier: (c) => this.ui.carriers.push({ carrier: c.carrier, ready: c.ready, fallbackReason: c.fallbackReason }),
				onFatal: (e) => this.ui.fatals.push(e),
			},
		);
	}

	/** Main's keys for `vaultId` over this device's SecretStorage and pin (what the plugin controller builds). */
	keysFor(vaultId: string): HostKeys {
		return createHostKeys({
			store: new VaultKeyStore(this.secrets, vaultId, this.deviceClock),
			pin: () => this.pinData.e2ee,
			creating: () => this.pinData.creating?.vaultId === vaultId,
			stored: async (info) => {
				if (pinsFromKeyring(this.pinData.e2ee, info.pending, info)) this.pinData = pinnedSuite1(this.pinData);
			},
		});
	}

	/** A HostRuntime over this device's vault/workspace/platform/carriers (plugin controller tests). */
	runtimeFor(identity: HostIdentity, settings: () => EngineSettings, ui: HostUiSink, keys: HostKeys = this.keysFor(identity.vaultId)): HostRuntime {
		return new HostRuntime({
			clock: this.opts.clock, vault: this.vault, configDir: this.configDir, sideFiles: this.sideFiles,
			workspace: this.workspace, platform: this.platform,
			identity, settings,
			createWorker: () => (this.opts.workerMode === "unavailable" ? null : this.carrier("worker")),
			createInline: () => this.carrier("inline"),
			pingEnabled: true,
			ui,
			keys,
			log: this.opts.log ? (line) => this.opts.log?.(`host: ${line}`) : undefined,
		});
	}

	start(): Promise<void> {
		return this.runtime.start();
	}

	/** The carrier dies: storage keeps exactly what was committed, the socket drops first, nothing flushes. */
	private killEngine(reason: string): MemStoragePort {
		// Bound-merge conflict copies not written yet live in the engine (boundDisk) and die with it.
		for (const c of this.vrt?.engine.boundDisk.pendingConflictCopies() ?? []) this.crashLost.push(c.text);
		const dying = this.storage;
		this.storage = dying.crash();
		this.opts.net.relay.dropSession(this.deviceId);
		this.handle?.engine.dispose(true);
		this.pair?.kill(reason);
		this.vrt = null;
		// A second, independent copy of the committed state (for inspection).
		return dying.crash();
	}

	/** Worker dies (OOM, OS kill): engine state newer than its last storage commit is lost. */
	crashEngine(reason = "sim crash"): void {
		this.killEngine(reason);
	}

	/**
	 * Whole app dies: unsaved editor buffers are lost, nothing flushes. Restart
	 * with `restartApp`. `wipe`: the OS also evicted IndexedDB (and with
	 * `dropMirrors` the side-file mirrors too). Returns a private copy of the
	 * committed storage the next start will see (empty after a wipe).
	 */
	crashApp(o: { readonly wipe?: boolean; readonly dropMirrors?: boolean } = {}): MemStoragePort {
		let copy = this.killEngine("app crash");
		this.workspace.crashAll();
		void this.runtime.stop().catch(() => undefined);
		if (o.wipe) {
			this.storage = new MemStoragePort({ beforeNextTimer: this.opts.clock.beforeNextTimer, macrotask: this.opts.clock.macrotask });
			copy = new MemStoragePort({ beforeNextTimer: this.opts.clock.beforeNextTimer, macrotask: this.opts.clock.macrotask });
		}
		if (o.dropMirrors) this.sideFiles.files.clear();
		return copy;
	}

	/** IndexedDB evicted / wiped while running (§e.4 recovery): every database of this device is deleted. */
	async wipeStorage(): Promise<void> {
		for (const name of await this.storage.listDatabases()) await this.storage.deleteDatabase(name);
	}

	/** Fresh app process over the same disk, side files and engine store. */
	async restartApp(): Promise<void> {
		this.secrets = new FakeSecretStorage(this.secretBacking);
		this.workspace = new SimWorkspace({ clock: this.opts.clock, vault: this.vault });
		this.workspaces.push(this.workspace);
		this.runtime = this.makeRuntime();
		await this.runtime.start();
	}

	/** Text of the engine's resident replica of the live doc at `path` (null: unknown or not resident). */
	engineText(path: string): string | null {
		const rt = this.vrt;
		if (!rt) return null;
		const view = rt.port.view();
		const id = view.remoteByPathKey.get(pathKey(path as VaultPath));
		return id ? residentText(rt, id) : null;
	}

	setOnline(online: boolean): void {
		this.opts.net.setOnline(this.deviceId, online);
		this.platform.emit(online ? "online" : "offline");
	}
}
