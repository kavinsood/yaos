/**
 * Full clients for the full-client e2e (fullClients.ts): one HostRuntime per device over the simulated
 * Obsidian surfaces (SimVault, SimWorkspace, SimConfigDir, SimSideFiles, SimPlatform) and the REAL composed
 * engine (createEngine) with the production ports (fullEnginePorts): wsRelay, idbStorage on a per-device
 * fake-indexeddb IDBFactory (kept across restarts), httpBlob when the relay advertises it (else null: attachments
 * are not synced, fail closed), crypto by init.crypto as webEngine.ts picks it (suite 0: the identity adapter;
 * suite 1 and unpinned: webCryptoSuite1), web clock/hash/random. Real timers.
 *
 * The engine runs on an in-process pair (main's event loop: protocol/inlineTransport.ts, harness only), or with
 * `carrier: "worker"` on its own thread as in the plugin (plugin.ts workerCarrier, its only carrier): EngineThread
 * is one worker_threads Worker (fullWorker.ts) for the client's life, so the device's IndexedDB outlives engine
 * restarts (each a new runtime: restart, runtimeFor); each carrier is a fresh MessageChannel to it, through
 * createWorkerHostTransport / createWorkerEngineTransport. Every post of an attachment-sized buffer is counted,
 * either way, as moved (detached after the post) or copied (EngineThread.posts, the thread's own).
 *
 * A client runs its own HostRuntime (suite-0 fixture pin), or the plugin controller's (`runtimeFor`, e2ee.ts):
 * then main's real pin and key flow (src/host/pluginController.ts) decides the pin and restarts the engine.
 *
 * NetSwitch wraps the RelayPort (and the blob port) so a device can go offline: connect answers
 * "unavailable", live sessions drop abruptly (1006) and session RPCs fail like a lost network (src/sim/net.ts).
 * With a WireTap (wireTap.ts) the same wrapper timestamps APPENDs and relay events for the latency breakdown;
 * the blob wrapper records every PUT's and GET's start, body size and end (NetSwitch.puts / gets).
 */
import type { IntervalHistogram } from "node:perf_hooks";
import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { Unsubscribe } from "../../src/ports/common";
import type { BlobPort, EnginePorts } from "../../src/ports";
import type { AppendFrame, RelayEvent, RelayPort, RelaySession } from "../../src/ports/relay";
import type { BrakeReport, DeviceId, VaultId } from "../../src/core/types";
import type { ProtocolError } from "../../src/protocol/errors";
import { createInlinePair } from "../../src/protocol/inlineTransport";
import type { EngineInitConfig, EngineSettings } from "../../src/protocol/messages";
import type { StatusSnapshot } from "../../src/protocol/status";
import { createWorkerHostTransport, type WorkerLike } from "../../src/protocol/workerTransport";
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
import { probeHttpBlob, startupBlob } from "../../src/engine/adapters/httpBlob";
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
import { nodeXhr } from "./nodeXhr";
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

/** One BlobPort.put or get that went through a NetSwitch (performance.now() times). */
export interface BlobTransferRecord {
	readonly start: number;
	/**
	 * Body bytes on the wire. put: the total of the `parts` argument (the sealed blob under suite 1), known at the
	 * start; get: the returned body's size, set when it resolves (0 while in flight or not found).
	 */
	bytes: number;
	/** null while the transfer is in flight. */
	end: number | null;
	ok: boolean | null;
}

const partsBytes = (parts: unknown): number =>
	Array.isArray(parts) ? parts.reduce((n: number, p: unknown) => n + (p instanceof Uint8Array ? p.byteLength : 0), 0) : 0;

export class NetSwitch {
	online = true;
	/** Latency timeline hooks (FullClientOptions.tap). */
	tap: SessionTap | null = null;
	/** Every blob PUT this client made, oldest first (fullLatency.ts: is an upload in flight?). */
	readonly puts: BlobTransferRecord[] = [];
	/** Every blob GET this client made, oldest first. */
	readonly gets: BlobTransferRecord[] = [];
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

	/** Every blob call fails like a network error while offline; puts and gets are recorded. All arguments are forwarded. */
	wrapBlob(inner: BlobPort | null): BlobPort | null {
		if (!inner) return null;
		return new Proxy(inner, {
			get: (t, k, recv) => {
				const v = Reflect.get(t, k, recv) as unknown;
				if (typeof v !== "function") return v;
				const f = v as (...x: unknown[]) => unknown;
				return (...a: unknown[]) => {
					if (!this.online) return Promise.reject(netError(`blob ${String(k)}`));
					if (k === "put") return this.timed(this.puts, partsBytes(a[1]), () => f.apply(t, a));
					if (k === "get") return this.timed(this.gets, 0, () => f.apply(t, a));
					return f.apply(t, a);
				};
			},
		});
	}

	/**
	 * Runs one transfer, recording its start, size and end into `into`. Holds no reference to the parts or the
	 * fetched body (only `call` sees the arguments, until it returns; a result is only measured).
	 */
	private timed(into: BlobTransferRecord[], bytes: number, call: () => unknown): unknown {
		const rec: BlobTransferRecord = { start: performance.now(), bytes, end: null, ok: null };
		into.push(rec);
		const done = (ok: boolean) => { rec.end = performance.now(); rec.ok = ok; };
		let p: unknown;
		try {
			p = call();
		} catch (e) {
			done(false);
			throw e;
		}
		Promise.resolve(p).then((v) => {
			if (v instanceof Uint8Array) rec.bytes = v.byteLength;
			done(true);
		}, () => done(false));
		return p;
	}

	setOnline(online: boolean): void {
		this.online = online;
		if (!online) for (const s of [...this.live]) s.drop();
	}
}

// ---- engine ports (both carriers) ------------------------------------------------

export interface EnginePortDeps {
	readonly net: NetSwitch;
	/** The device's IndexedDB (kept across restarts). */
	readonly factory: IDBFactory;
	readonly log: (line: string) => void;
	readonly onBlobKind: (kind: "http" | "none") => void;
	readonly trace?: BootTrace;
	readonly tap?: WireTap;
}

/** The ports of one init, as webEngine.ts makes them, over the device's net switch and IndexedDB. */
export async function fullEnginePorts(config: EngineInitConfig, d: EnginePortDeps): Promise<EnginePorts> {
	const clock = createWebClock();
	const hash = createWebHash();
	const random = createWebRandom();
	const tr = d.trace;
	const tap = d.tap;
	const relay = d.net.wrap(createWsRelayPort({ baseUrl: config.relay.url, credential: config.relay.credential, clock, random,
		...(tr ? { fetch: tr.fetch, WebSocketImpl: tr.WebSocket } : {}), ...(tap ? { WebSocketImpl: tap.webSocket(tr?.WebSocket) } : {}) }));
	const blobOpts = { baseUrl: config.relay.url, vaultId: config.vaultId, credential: config.relay.credential, clock, xhr: nodeXhr };
	// As webEngine.ts: probed at start, and again on a later connect while there is none.
	const blob = await startupBlob(blobOpts, d.log);
	d.onBlobKind(blob ? "http" : "none");
	const probeBlob = async () => {
		const found = await probeHttpBlob(blobOpts);
		if (found) d.onBlobKind("http");
		return d.net.wrapBlob(found);
	};
	const storage = createIdbStoragePort(d.factory, IDBKeyRange);
	const c = config.crypto;
	// As webEngine.ts: suite-1 keys are zero-filled once imported; unpinned gets the adapter with no key.
	const crypto = c.suite === 0 ? createNoopCrypto(hash) : await createWebCryptoSuite1({ vaultId: config.vaultId, random, keys: c.suite === 1 ? c.keys : [] });
	return { relay, storage: tr ? tr.wrapStorage(storage) : storage, clock, random, crypto, hash, blob: d.net.wrapBlob(blob), probeBlob };
}

// ---- engine thread (carrier "worker") ----------------------------------------------

/** Attachment-sized: a post carrying a buffer this large is counted (LargePost). */
export const LARGE_BUFFER_BYTES = 1024 * 1024;

/** Wall-clock ms with sub-ms resolution, comparable across threads and processes (calibrate with a round trip). */
export const absNow = (): number => performance.timeOrigin + performance.now();

/** One post that carried an attachment-sized buffer: moved (detached after the post) or copied by structured clone. */
export interface LargePost {
	readonly kind: "post";
	readonly at: number;
	readonly dir: "main-to-engine" | "engine-to-main";
	/** The protocol message's `t`. */
	readonly t: string;
	readonly bytes: number;
	readonly transferred: boolean;
}

/** Engine-thread diagnostics (FullClientOptions.engineEvents); `at` is the thread's absNow(). */
export type EngineThreadEvent =
	| { readonly kind: "append"; readonly at: number; readonly stream: string; readonly frameId: string; readonly bytes: number }
	| { readonly kind: "relay"; readonly at: number; readonly t: RelayEvent["t"]; readonly stream: string | null; readonly frameId: string | null; readonly deviceId: string | null }
	| { readonly kind: "blob"; readonly at: number; readonly op: "put" | "get"; readonly phase: "start" | "end" | "error"; readonly bytes: number; readonly error: string | null }
	/** The thread's 1 ms heartbeat fired this late (>= ENGINE_GAP_EVENT_MS). */
	| { readonly kind: "gap"; readonly at: number; readonly ms: number }
	| LargePost;

export const ENGINE_GAP_EVENT_MS = 20;

/** An event-loop delay histogram (monitorEventLoopDelay), ms. */
export interface LoopStats { readonly n: number; readonly p50: number; readonly p99: number; readonly max: number; readonly mean: number }

export function loopStats(h: IntervalHistogram): LoopStats {
	const ms = (ns: number) => Math.round(ns / 1e4) / 100;
	return { n: h.count, p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max), mean: ms(h.count > 0 ? h.mean : 0) };
}

export interface EngineThreadProbe {
	/** The thread's absNow() when it answered. */
	readonly at: number;
	/** monitorEventLoopDelay({ resolution: 1 }) since the last reset. */
	readonly loop: LoopStats;
	/** Longest gap of the thread's 1 ms heartbeat since the last reset. */
	readonly heartbeatMaxGapMs: number;
	readonly heapUsedBytes: number;
	/** The thread's own ArrayBuffers (memoryUsage().arrayBuffers is per isolate). */
	readonly arrayBuffersBytes: number;
	/** Engine-to-main posts of attachment-sized buffers so far. */
	readonly posts: readonly LargePost[];
}

/** Main -> engine thread. */
export type ToEngineThread =
	| { readonly t: "carrier"; readonly id: number; readonly port: MessagePort; readonly tuning?: Partial<EngineTuning> }
	| { readonly t: "dispose"; readonly id: number }
	| { readonly t: "online"; readonly online: boolean }
	| { readonly t: "probe"; readonly rid: number; readonly reset: boolean };

/** Engine thread -> main. */
export type FromEngineThread =
	| { readonly t: "up" }
	| { readonly t: "log"; readonly line: string }
	| { readonly t: "blobKind"; readonly kind: "http" | "none" }
	| { readonly t: "probe"; readonly rid: number; readonly value: EngineThreadProbe }
	| { readonly t: "event"; readonly e: EngineThreadEvent };

export interface EngineThreadData {
	/** Post EngineThreadEvents (FullClientOptions.engineEvents set). */
	readonly events: boolean;
}

function largeBuffers(v: unknown, out: Uint8Array[], depth: number): Uint8Array[] {
	if (depth > 8 || typeof v !== "object" || v === null) return out;
	if (ArrayBuffer.isView(v)) {
		if (v.byteLength >= LARGE_BUFFER_BYTES) out.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
		return out;
	}
	for (const x of Array.isArray(v) ? v : Object.values(v)) largeBuffers(x, out, depth + 1);
	return out;
}

/** post(), and the attachment-sized buffers `message` carried: each one detached afterwards was moved, not copied. */
export function postCounted(dir: LargePost["dir"], message: unknown, post: () => void): LargePost[] {
	const big = largeBuffers(message, [], 0);
	const sizes = big.map((b) => b.byteLength);
	post();
	if (big.length === 0) return [];
	const at = absNow();
	const t = String((message as { t?: unknown }).t);
	return big.map((b, i) => ({ kind: "post", at, dir, t, bytes: sizes[i]!, transferred: b.byteLength === 0 && b.buffer.byteLength === 0 }));
}

/** What a carrier's transport hears: a message's data, or a failure's message (workerTransport.ts describe()). */
type CarrierListener = (ev: { readonly data: unknown; readonly message: string }) => void;

interface EngineThreadSink {
	log(line: string): void;
	blobKind(kind: "http" | "none"): void;
	readonly event?: (e: EngineThreadEvent) => void;
}

/**
 * The device's engine thread (fullWorker.ts). One Worker for the client's life (its IndexedDB, net switch and
 * heartbeat); each carrier() is one engine over a fresh MessageChannel, disposed when the host terminates it. The
 * thread keeps the process alive only while it starts or a carrier is live.
 */
export class EngineThread {
	/** The thread loaded its modules: a carrier's startup ping (STARTUP_PING_TIMEOUT_MS) only measures the engine. */
	readonly ready: Promise<void>;
	/** Main-to-engine posts of attachment-sized buffers. */
	readonly posts: LargePost[] = [];
	private readonly worker: Worker;
	private readonly probes = new Map<number, (p: EngineThreadProbe) => void>();
	private readonly carriers = new Map<number, Set<CarrierListener>>();
	private nextId = 1;
	private nextRid = 1;
	private up = false;

	constructor(name: string, private readonly sink: EngineThreadSink) {
		const data: EngineThreadData = { events: sink.event !== undefined };
		// execArgv is inherited: --import jiti/register loads the TypeScript entry.
		this.worker = new Worker(new URL("./fullWorker.ts", import.meta.url), { name: `yaos-engine-${name}`, workerData: data });
		let started!: () => void;
		let broke!: (e: Error) => void;
		this.ready = new Promise<void>((resolve, reject) => {
			started = resolve;
			broke = reject;
		});
		this.worker.on("message", (m: FromEngineThread) => {
			switch (m.t) {
				case "up":
					this.up = true;
					this.hold();
					started();
					return;
				case "log":
					sink.log(m.line);
					return;
				case "blobKind":
					sink.blobKind(m.kind);
					return;
				case "probe":
					this.probes.get(m.rid)?.(m.value);
					this.probes.delete(m.rid);
					return;
				case "event":
					sink.event?.(m.e);
					return;
			}
		});
		const failAll = (reason: string) => {
			broke(new Error(reason));
			for (const listeners of this.carriers.values()) for (const l of [...listeners]) l({ data: null, message: reason });
		};
		this.worker.on("error", (e) => failAll(`engine thread error: ${e.message}`));
		this.worker.on("exit", (code) => failAll(`engine thread exited (${code})`));
	}

	/** A worker carrier: what plugin.ts workerCarrier returns, over this thread. */
	carrier(tuning: Partial<EngineTuning> | undefined): EngineCarrier {
		const { port1, port2 } = new MessageChannel();
		const id = this.nextId++;
		const failures = new Set<CarrierListener>();
		this.carriers.set(id, failures);
		this.send({ t: "carrier", id, port: port2, ...(tuning ? { tuning } : {}) }, [port2]);
		this.hold();
		const worker: WorkerLike = {
			postMessage: (message, transfer) => {
				for (const p of postCounted("main-to-engine", message, () => port1.postMessage(message, transfer as ArrayBuffer[]))) {
					this.posts.push(p);
					this.sink.event?.(p);
				}
			},
			addEventListener: (type: string, listener: CarrierListener) => {
				if (type === "message") port1.on("message", (data: unknown) => listener({ data, message: "" }));
				else if (type === "messageerror") port1.on("messageerror", (e: Error) => listener({ data: null, message: e.message }));
				else failures.add(listener);
			},
			terminate: () => {
				if (!this.carriers.delete(id)) return;
				this.send({ t: "dispose", id });
				port1.close();
				this.hold();
			},
		};
		const transport = createWorkerHostTransport(worker);
		return { kind: "worker", transport, dispose: () => transport.close() };
	}

	/** The thread's loop stats (reset: start a new window); sentAt / gotAt bracket its `at` (clock calibration). */
	probe(reset: boolean): Promise<{ readonly sentAt: number; readonly gotAt: number; readonly value: EngineThreadProbe }> {
		const rid = this.nextRid++;
		const sentAt = absNow();
		return new Promise((resolve) => {
			this.probes.set(rid, (value) => resolve({ sentAt, gotAt: absNow(), value }));
			this.send({ t: "probe", rid, reset });
		});
	}

	setOnline(online: boolean): void {
		this.send({ t: "online", online });
	}

	/** Ends the thread once its client is stopped for good (nothing restarts it). */
	async close(): Promise<void> {
		this.carriers.clear();
		await this.worker.terminate();
	}

	private send(m: ToEngineThread, transfer: MessagePort[] = []): void {
		this.worker.postMessage(m, transfer);
	}

	private hold(): void {
		if (!this.up || this.carriers.size > 0) this.worker.ref();
		else this.worker.unref();
	}
}

// ---- full client ---------------------------------------------------------------

export interface ClientUi {
	statuses: StatusSnapshot[];
	brakes: BrakeReport[];
	notices: { level: string; code: string; message: string }[];
	fatals: ProtocolError[];
	carriers: { carrier: string | null; ready: boolean }[];
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
	/** Where the engine runs: main's event loop (default) or its own thread, as the plugin's worker. */
	readonly carrier?: "inline" | "worker";
	/** carrier "worker": the engine thread's diagnostics (typingDuringUpload.ts). */
	readonly engineEvents?: (e: EngineThreadEvent) => void;
}

const LOG_RING = 400;

/** One Obsidian device: simulated vault/workspace/config/platform, real host runtime and engine. */
export class FullClient {
	/** The device's IndexedDB (kept across restarts), on the inline carrier; the engine thread holds its own. */
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
	/** "http" = the relay's blob store (R2); "none" = the relay has none (attachments not synced); null = not started. */
	blobKind: "http" | "none" | null = null;
	engineStarts = 0;
	/** Vault cursor of each new vault runtime when it came up (a restart from IndexedDB resumes, not 0). */
	readonly cursorAtStart: number[] = [];
	stopped = false;
	/** carrier "worker": the engine's thread (null on the inline carrier). */
	readonly thread: EngineThread | null;
	private handle: EngineHandle | null = null;

	constructor(readonly o: FullClientOptions) {
		const tap = o.tap;
		if (o.carrier === "worker" && (tap || o.trace)) throw new Error("tap and trace time main-thread calls: inline carrier only");
		this.thread = o.carrier === "worker"
			? new EngineThread(o.name, { log: (line) => this.log(`engine: ${line}`), blobKind: (k) => { this.blobKind = k; }, ...(o.engineEvents ? { event: o.engineEvents } : {}) })
			: null;
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

	/** Bound-merge conflict copies this engine wrote (the worker's boundDisk); null while no engine runs (or on its own thread). */
	get conflictCopiesWritten(): number | null {
		return this.handle?.engine.boundDisk.stats.conflictCopies ?? null;
	}

	private newWorkspace(): SimWorkspace {
		const ws = new SimWorkspace({ clock: this.clock, vault: this.vault });
		this.workspaces.push(ws);
		return ws;
	}

	private inlineCarrier(): EngineCarrier {
		const pair = createInlinePair();
		this.engineStarts++;
		const log = (line: string) => this.log(`engine: ${line}`);
		const handle = createEngine(pair.engine, {
			carrier: "inline",
			clientVersion: "full-e2e",
			...(this.o.tuning ? { tuning: this.o.tuning } : {}),
			tzOffsetMinutes: () => 0,
			log,
			onRuntime: (rt) => {
				if (this.handle !== handle) return;
				this.vrt = rt;
				if (rt) this.cursorAtStart.push(rt.log.c.repo.cursor.vaultSeq);
			},
			makePorts: (config) => fullEnginePorts(config, { net: this.net, factory: this.factory, log, onBlobKind: (k) => { this.blobKind = k; },
				...(this.o.trace ? { trace: this.o.trace } : {}), ...(this.o.tap ? { tap: this.o.tap } : {}) }),
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
			createCarrier: () => {
				if (!this.thread) return this.inlineCarrier();
				this.engineStarts++;
				return this.thread.carrier(this.o.tuning);
			},
			pingEnabled: true,
			keys,
			log: (line) => this.log(`host: ${line}`),
			ui: {
				onStatus: (s) => { this.ui.statuses.push(s); if (this.ui.statuses.length > 50) this.ui.statuses.shift(); also?.onStatus(s); },
				onBrake: (b) => { this.ui.brakes.push(b); also?.onBrake(b); },
				onNotice: (level, code, message) => { this.ui.notices.push({ level, code, message }); also?.onNotice(level, code, message); },
				onCarrier: (c) => { this.ui.carriers.push({ carrier: c.carrier, ready: c.ready }); also?.onCarrier(c); },
				onFatal: (e) => { this.ui.fatals.push(e); also?.onFatal(e); },
			},
		});
	}

	async start(): Promise<void> {
		await this.thread?.ready;
		await this.runtime.start();
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
		if (this.thread) this.thread.setOnline(online);
		else this.net.setOnline(online);
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
