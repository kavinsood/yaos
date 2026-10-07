/**
 * Full clients for the full-client e2e (fullClients.ts): one HostRuntime per device over the simulated
 * Obsidian surfaces (SimVault, SimWorkspace, SimConfigDir, SimSideFiles, SimPlatform) and the REAL composed
 * engine (createEngine on the inline carrier) with the production ports: wsRelay, idbStorage on a per-device
 * fake-indexeddb IDBFactory (kept across restarts), httpBlob when the relay advertises it (else null:
 * attachments ride the log as x: blob chunks), crypto by init.crypto as webEngine.ts picks it (suite 0: the
 * identity adapter; suite 1 and unpinned: webCryptoSuite1), web clock/hash/random. Real timers.
 *
 * A client runs its own HostRuntime (suite-0 fixture pin), or the plugin controller's (`runtimeFor`, e2ee.ts):
 * then main's real pin and key flow (src/host/pluginController.ts) decides the pin and restarts the engine.
 *
 * NetSwitch wraps the RelayPort (and the blob port) so a device can go offline: connect answers
 * "unavailable", live sessions drop abruptly (1006) and session RPCs fail like a lost network (src/sim/net.ts).
 * With a WireTap (wireTap.ts) the same wrapper timestamps APPENDs and relay events for the latency breakdown.
 */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { Unsubscribe } from "../../src/ports/common";
import type { BlobPort } from "../../src/ports";
import type { AppendFrame, RelayEvent, RelayPort, RelaySession } from "../../src/ports/relay";
import type { BrakeReport, DeviceId, VaultId } from "../../src/core/types";
import type { ProtocolError } from "../../src/protocol/errors";
import { createInlinePair } from "../../src/protocol/inlineTransport";
import type { EngineSettings } from "../../src/protocol/messages";
import type { StatusSnapshot } from "../../src/protocol/status";
import type { EngineCarrier } from "../../src/host/engineHost";
import { engineHashOracle } from "../../src/host/hashOracle";
import { HostRuntime, type HostUiSink } from "../../src/host/hostRuntime";
import { createHostKeys, type HostKeys } from "../../src/host/keys/hostKeys";
import type { E2eePin } from "../../src/host/keys/pin";
import { VaultKeyStore } from "../../src/host/keys/secretStore";
import { FakeSecretStorage } from "../../src/host/keys/testkit/fakeSecretStorage";
import { suite0PinForTest } from "../../src/host/keys/testkit/pinFixture";
import type { HostIdentity } from "../../src/host/runtimeSupport";
import { DEFAULT_ENGINE_SETTINGS } from "../../src/host/ui/api";
import { createEngine, type EngineHandle } from "../../src/engine/compose/protocolEngine";
import type { VaultRuntime } from "../../src/engine/compose/vaultRuntime";
import type { EngineTuning } from "../../src/engine/runtime/options";
import { createHttpBlob, probeHttpBlob } from "../../src/engine/adapters/httpBlob";
import { createIdbStoragePort } from "../../src/engine/adapters/idbStorage";
import { createNoopCrypto } from "../../src/engine/adapters/noopCrypto";
import { createWebCryptoSuite1 } from "../../src/engine/adapters/webCryptoSuite1";
import { RelayHttpError } from "../../src/engine/adapters/relayHttp";
import { createWebClock } from "../../src/engine/adapters/webClock";
import { createWebHash } from "../../src/engine/adapters/webHash";
import { createWebRandom } from "../../src/engine/adapters/webRandom";
import { createWsRelayPort } from "../../src/engine/adapters/wsRelay";
import { SimPlatform } from "../../src/sim/device";
import { SimConfigDir, SimSideFiles, SimVault } from "../../src/sim/vault";
import { SimWorkspace } from "../../src/sim/workspace";
import type { BootTrace } from "./bootTrace";
import type { Report } from "./engineKit";
import type { OnboardDevice, OnboardedVault } from "./onboard";
import type { SessionTap, WireTap } from "./wireTap";

// ---- network switch ------------------------------------------------------------

const netError = (route: string) => new RelayHttpError(route, 0, "network_error", null);

class DroppableSession implements RelaySession {
	private dead = false;
	private readonly listeners = new Set<(e: RelayEvent) => void>();
	private off: Unsubscribe | null = null;
	constructor(private readonly inner: RelaySession, private readonly ended: () => void, private readonly tap: SessionTap | null) {}
	get vaultEpoch() { return this.inner.vaultEpoch; }
	get headSeq() { return this.inner.headSeq; }
	get canWrite() { return this.inner.canWrite; }
	get limits() { return this.inner.limits; }
	append(frame: AppendFrame): void {
		if (this.dead) return;
		this.tap?.append(frame);
		this.inner.append(frame);
	}
	bufferedBytes(): number { return this.dead ? 0 : this.inner.bufferedBytes(); }
	feed(afterSeq: Parameters<RelaySession["feed"]>[0]) { return this.dead ? Promise.reject(netError("feed")) : this.inner.feed(afterSeq); }
	read(...a: Parameters<RelaySession["read"]>) { return this.dead ? Promise.reject(netError("read")) : this.inner.read(...a); }
	readBatch(...a: Parameters<RelaySession["readBatch"]>) { return this.dead ? Promise.reject(netError("read")) : this.inner.readBatch(...a); }
	putCheckpoint(...a: Parameters<RelaySession["putCheckpoint"]>) { return this.dead ? Promise.reject(netError("checkpoint")) : this.inner.putCheckpoint(...a); }
	onEvent(listener: (e: RelayEvent) => void): Unsubscribe {
		this.listeners.add(listener);
		// Subscribe lazily so the inner session's pre-subscription buffering still applies.
		this.off ??= this.inner.onEvent((e) => {
			if (this.dead) return;
			this.tap?.event(e);
			if (e.t === "closed") this.end();
			this.emit(e);
		});
		return () => this.listeners.delete(listener);
	}
	close(code: number, reason: string): void {
		this.inner.close(code, reason); // emits "closed" synchronously (forwarded above)
		this.end();
	}
	/** The network vanished: an abrupt close the engine sees at once; the real socket is torn down quietly. */
	drop(): void {
		if (this.dead) return;
		this.end();
		this.emit({ t: "closed", code: 1006, errorCode: null, wasClean: false });
		this.off?.();
		this.inner.close(1000, "e2e offline");
	}
	private end(): void {
		if (this.dead) return;
		this.dead = true;
		this.ended();
	}
	private emit(e: RelayEvent): void {
		for (const l of [...this.listeners]) {
			try { l(e); } catch { /* a throwing listener must not starve the others */ }
		}
	}
}

export class NetSwitch {
	online = true;
	/** Latency timeline hooks (FullClientOptions.tap). */
	tap: SessionTap | null = null;
	private readonly live = new Set<DroppableSession>();

	wrap(inner: RelayPort): RelayPort {
		return {
			connect: async (params) => {
				if (!this.online) return { ok: false, reason: "unavailable", retryAfterMs: null };
				const r = await inner.connect(params);
				if (!r.ok) return r;
				if (!this.online) { // went offline while the ticket/upgrade was in flight
					r.session.close(1000, "e2e offline");
					return { ok: false, reason: "unavailable", retryAfterMs: null };
				}
				const s: DroppableSession = new DroppableSession(r.session, () => this.live.delete(s), this.tap);
				this.live.add(s);
				return { ok: true, session: s };
			},
		};
	}

	/** Every blob call fails like a network error while offline. */
	wrapBlob(inner: BlobPort | null): BlobPort | null {
		if (!inner) return null;
		return new Proxy(inner, {
			get: (t, k, recv) => {
				const v = Reflect.get(t, k, recv) as unknown;
				if (typeof v !== "function") return v;
				return (...a: unknown[]) => (this.online ? (v as (...x: unknown[]) => unknown).apply(t, a) : Promise.reject(netError(`blob ${String(k)}`)));
			},
		});
	}

	setOnline(online: boolean): void {
		this.online = online;
		if (!online) for (const s of [...this.live]) s.drop();
	}
}

// ---- full client ---------------------------------------------------------------

export interface ClientUi {
	statuses: StatusSnapshot[];
	brakes: BrakeReport[];
	notices: { level: string; code: string; message: string }[];
	fatals: ProtocolError[];
	carriers: { carrier: string | null; ready: boolean; fallbackReason: string | null }[];
}

export interface FullClientOptions {
	readonly name: string;
	readonly host: string;
	readonly vaultId: string;
	readonly device: OnboardDevice;
	/** Delay of watcher events for external writes (ms). */
	readonly watcherDelayMs: number;
	readonly settings?: Partial<EngineSettings>;
	/** Times this client's relay HTTP calls, socket and storage transactions (bootBench.ts). */
	readonly trace?: BootTrace;
	/** Engine tuning overrides (snapshots.ts: a short blob GC grace). */
	readonly tuning?: Partial<EngineTuning>;
	/** The vault's wire timeline (fullLatency.ts): APPENDs, relay events, engine disk writes, VAULT_READY limits. */
	readonly tap?: WireTap;
}

const LOG_RING = 400;

/** One Obsidian device: simulated vault/workspace/config/platform, real host runtime and engine. */
export class FullClient {
	/** The device's IndexedDB (kept across restarts). */
	readonly factory = new IDBFactory();
	readonly clock = createWebClock();
	/** Like the plugin: vault preconditions are hashed by the live runtime's engine (main never hashes). */
	readonly hashes = engineHashOracle((body) => this.runtime.engine.request(body));
	readonly vault: SimVault;
	readonly configDir: SimConfigDir;
	readonly sideFiles = new SimSideFiles();
	/** The device's SecretStorage (kept across restarts, like the OS keychain). */
	readonly secrets = new FakeSecretStorage();
	/**
	 * data.json's pin (e2ee-design §12.4). These runs are suite 0: the test-only fixture writes the state a suite-0
	 * link leaves, since nothing infers a pin (absent = unpinned = blocked).
	 */
	pin: E2eePin | undefined = suite0PinForTest();
	readonly platform = new SimPlatform({ os: "macos", isMobile: false, isTablet: false, hardwareConcurrency: 8, deviceMemoryGiB: null, workerSupported: false });
	readonly net = new NetSwitch();
	readonly ui: ClientUi = { statuses: [], brakes: [], notices: [], fatals: [], carriers: [] };
	/** Diagnostics lines (engine + host; never secrets), newest last. */
	readonly logLines: string[] = [];
	readonly workspaces: SimWorkspace[] = [];
	workspace: SimWorkspace;
	runtime: HostRuntime;
	vrt: VaultRuntime | null = null;
	blobKind: "http" | "log" | null = null;
	engineStarts = 0;
	/** Vault cursor of each new vault runtime when it came up (a restart from IndexedDB resumes, not 0). */
	readonly cursorAtStart: number[] = [];
	stopped = false;
	private handle: EngineHandle | null = null;

	constructor(readonly o: FullClientOptions) {
		const tap = o.tap;
		this.vault = new SimVault({ clock: this.clock, hashes: this.hashes, profile: "case-sensitive", watcherDelayMs: () => o.watcherDelayMs,
			...(tap ? { onMutation: (m: { by: string; path: string; to?: string }) => {
				if (m.by !== "sync") return;
				tap.disk(o.name, m.path);
				if (m.to) tap.disk(o.name, m.to);
			} } : {}) });
		this.configDir = new SimConfigDir(this.clock);
		if (tap) {
			const cd = this.configDir;
			const write = cd.writeBytes.bind(cd);
			cd.writeBytes = async (p, b) => {
				await write(p, b);
				tap.disk(o.name, `${this.vault.configDir}/${p}`);
			};
			this.net.tap = tap.forClient(o.name, o.device.deviceId);
		}
		this.workspace = this.newWorkspace();
		this.runtime = this.makeRuntime();
	}

	get name(): string {
		return this.o.name;
	}

	log(line: string): void {
		this.logLines.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
		if (this.logLines.length > LOG_RING) this.logLines.splice(0, this.logLines.length - LOG_RING);
	}

	/** Bound-merge conflict copies this engine wrote (the worker's boundDisk); null while no engine runs. */
	get conflictCopiesWritten(): number | null {
		return this.handle?.engine.boundDisk.stats.conflictCopies ?? null;
	}

	private newWorkspace(): SimWorkspace {
		const ws = new SimWorkspace({ clock: this.clock, vault: this.vault });
		this.workspaces.push(ws);
		return ws;
	}

	private carrier(): EngineCarrier {
		const pair = createInlinePair();
		this.engineStarts++;
		const handle = createEngine(pair.engine, {
			carrier: "inline",
			clientVersion: "full-e2e",
			...(this.o.tuning ? { tuning: this.o.tuning } : {}),
			tzOffsetMinutes: () => 0,
			log: (line) => this.log(`engine: ${line}`),
			onRuntime: (rt) => {
				if (this.handle !== handle) return;
				this.vrt = rt;
				if (rt) this.cursorAtStart.push(rt.log.c.repo.cursor.vaultSeq);
			},
			makePorts: async (config) => {
				const clock = createWebClock();
				const hash = createWebHash();
				const random = createWebRandom();
				const tr = this.o.trace;
				const tap = this.o.tap;
				const relay = this.net.wrap(createWsRelayPort({ baseUrl: config.relay.url, credential: config.relay.credential, clock, random,
					...(tr ? { fetch: tr.fetch, WebSocketImpl: tr.WebSocket } : {}), ...(tap ? { WebSocketImpl: tap.webSocket(tr?.WebSocket) } : {}) }));
				const blobOpts = { baseUrl: config.relay.url, vaultId: config.vaultId, credential: config.relay.credential };
				const blob = await probeHttpBlob(blobOpts).catch(() => createHttpBlob(blobOpts));
				this.blobKind = blob ? "http" : "log";
				const storage = createIdbStoragePort(this.factory, IDBKeyRange);
				const c = config.crypto;
				// As webEngine.ts: suite-1 keys are zero-filled once imported; unpinned gets the adapter with no key.
				const crypto = c.suite === 0 ? createNoopCrypto(hash) : await createWebCryptoSuite1({ vaultId: config.vaultId, random, keys: c.suite === 1 ? c.keys : [] });
				return { relay, storage: tr ? tr.wrapStorage(storage) : storage, clock, random, crypto, hash, blob: this.net.wrapBlob(blob) };
			},
		});
		this.handle = handle;
		this.vrt = null;
		return {
			kind: "inline",
			transport: pair.host,
			dispose: () => {
				handle.dispose();
				pair.host.close();
			},
		};
	}

	private makeRuntime(): HostRuntime {
		const { o } = this;
		return this.hostRuntime(
			{ vaultId: o.vaultId as VaultId, deviceId: o.device.deviceId as DeviceId, deviceLabel: o.name, relay: { url: o.host, credential: o.device.deviceToken } },
			() => ({ ...DEFAULT_ENGINE_SETTINGS, syncSettings: true, ...o.settings }),
			createHostKeys({ store: new VaultKeyStore(this.secrets, o.vaultId, this.clock), pin: () => this.pin, creating: () => false }),
			null,
		);
	}

	/**
	 * The plugin controller's runtime (ControllerEnv.makeRuntime): it becomes this client's runtime, and the
	 * controller's UI sink sees everything this client's `ui` records.
	 */
	runtimeFor(identity: HostIdentity, settings: () => EngineSettings, ui: HostUiSink, keys: HostKeys): HostRuntime {
		this.runtime = this.hostRuntime(identity, settings, keys, ui);
		return this.runtime;
	}

	private hostRuntime(identity: HostIdentity, settings: () => EngineSettings, keys: HostKeys, also: HostUiSink | null): HostRuntime {
		return new HostRuntime({
			clock: this.clock, vault: this.vault, configDir: this.configDir, sideFiles: this.sideFiles,
			workspace: this.workspace, platform: this.platform,
			identity, settings,
			createWorker: () => null,
			createInline: () => this.carrier(),
			pingEnabled: true,
			keys,
			log: (line) => this.log(`host: ${line}`),
			ui: {
				onStatus: (s) => { this.ui.statuses.push(s); if (this.ui.statuses.length > 50) this.ui.statuses.shift(); also?.onStatus(s); },
				onBrake: (b) => { this.ui.brakes.push(b); also?.onBrake(b); },
				onNotice: (level, code, message) => { this.ui.notices.push({ level, code, message }); also?.onNotice(level, code, message); },
				onCarrier: (c) => { this.ui.carriers.push({ carrier: c.carrier, ready: c.ready, fallbackReason: c.fallbackReason }); also?.onCarrier(c); },
				onFatal: (e) => { this.ui.fatals.push(e); also?.onFatal(e); },
			},
		});
	}

	start(): Promise<void> {
		return this.runtime.start();
	}

	/** App quits: the runtime shuts the engine down; open views close without saving. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		await this.runtime.stop();
		this.workspace.dispose();
		this.vrt = null;
	}

	/** Fresh app process over the same disk, config dir, side files and IndexedDB (stops first if running). */
	async restart(): Promise<void> {
		await this.stop();
		this.stopped = false;
		this.workspace = this.newWorkspace();
		this.runtime = this.makeRuntime();
		await this.runtime.start();
	}

	setOnline(online: boolean): void {
		this.net.setOnline(online);
		this.platform.emit(online ? "online" : "offline");
	}
}

// ---- scenario context ----------------------------------------------------------

export interface FullCtx {
	readonly R: Report;
	readonly host: string;
	readonly vault: OnboardedVault;
	/** Every running client (a scenario may add one). */
	readonly clients: FullClient[];
	/** Creates (does not start) a client for an onboarded device. */
	newClient(name: string, device: OnboardDevice): FullClient;
	/** The vault's wire timeline (every client of newClient feeds it). */
	readonly tap: WireTap;
	/** Relay process restart (null when the host is not local). */
	readonly relay: null | { stop(): void; start(): void };
}
