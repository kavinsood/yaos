/**
 * Typing during a max-size upload: the UI thread stays smooth while an attachment of the largest size the blob store
 * takes uploads in the background. Device A is split as the plugin runs on desktop: its host (HostRuntime, the
 * BindingManager over a bound editor, the vault) on the main thread, its engine on a worker thread (FullClient
 * carrier "worker", fullWorker.ts) with the production ports. Device B, a second full client with the note open in a
 * bound editor, runs in a child process (this file with --peer), so its work never lands on A's event loop.
 *
 * On a fresh vault (plain = suite 0; e2ee = suite 1 through the plugin controller, as e2ee.ts), A types --rate keys/s
 * into its editor (one editor transaction per key, at fixed times):
 *   baseline  --baseline-s seconds of typing;
 *   upload    an attachment appears on A's disk (an external write) and A keeps typing until it is on B's disk. Its
 *             size is the store's cap as the engine derives it: GET /api/capabilities maxBlobUploadBytes
 *             (httpBlob.ts probeHttpBlob; limits.ts MAX_BLOB_UPLOAD_BYTES when the relay names none), less the
 *             sealing overhead under suite 1 (sealedBlob.ts maxSealedBlobPlaintext). It must equal A's status
 *             maxBlobBytes, and the settings' maxAttachmentBytes is above it (localState.ts classify).
 * The windows are separated by a drain (every key in B's view). Per window:
 *   A main (the UI thread)  monitorEventLoopDelay({ resolution: 1 }), the longest gap of a 1 ms heartbeat, and each
 *                           key's synchronous dispatch: its editor transaction plus the BindingManager flush that
 *                           pushed it (binding.ts flushSlot, timed through an own-property wrapper);
 *   A engine thread         the same loop stats (diagnostic);
 *   key -> peer             from the key's scheduled press to the key in B's editor, split at the first body-stream
 *                           APPEND on A's socket after the key's flush and that frame's PROVISIONAL / COMMITTED on B;
 *   memory                  peak RSS of each process (sampled every 100 ms; resourceUsage().maxRSS at the end);
 *   transfers               every post of an attachment-sized buffer between a main thread and its engine thread,
 *                           moved (the buffer is detached after the post) or copied (fullKit.ts postCounted).
 * Clocks: absNow() on each thread, A's engine thread and B calibrated by the round trip with the least delay.
 *
 * Gates (exit 1 when one fails; the numbers are written either way), upload window: A main event-loop delay max
 * <= 50 ms and dispatch p99 <= 16 ms; key -> peer p50 <= the baseline's + 100 ms; no key over 1 s to B (each stall's
 * frame timeline is in extra.<vault>.stalls); B's attachment sha256-identical; B's view = A's view = the header plus
 * every typed key, in order, and both disks follow.
 *
 *   node --import jiti/register e2e/client/typingDuringUpload.ts --host URL --label L [--vault plain|e2ee|both]
 *     [--rate 12] [--baseline-s 10] [--watcher-ms 100] [--upload-timeout-s 600]
 *
 * Writes LOG_DIR/client-e2e-typing-<label>-<stamp>.json (no secrets: no tokens, keys or payloads).
 */
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes as nodeRandomBytes, randomFillSync } from "node:crypto";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { makeRecoveryKey } from "../../src/core/codec/recoveryKey";
import { maxSealedBlobPlaintext } from "../../src/core/codec/sealedBlob";
import { probeHttpBlob } from "../../src/engine/adapters/httpBlob";
import { createWebClock } from "../../src/engine/adapters/webClock";
import type { BindingManager } from "../../src/host/binding";
import { VaultKeyStore } from "../../src/host/keys/secretStore";
import { YaosController } from "../../src/host/pluginController";
import type { PairedIdentity } from "../../src/host/ui/api";
import { DEFAULT_ENGINE_SETTINGS, defaultPluginData, type YaosPluginData } from "../../src/host/ui/api";
import type { StatusSnapshot } from "../../src/protocol/status";
import type { SimEditorView } from "../../src/sim/workspace";
import { Report, sleep } from "./engineKit";
import { waitFor } from "./fullCheck";
import {
	absNow, FullClient, LARGE_BUFFER_BYTES, type ClientUi, type EngineThread, type EngineThreadEvent, type EngineThreadProbe,
	type LargePost, type LoopStats, loopStats,
} from "./fullKit";
import { installPlugin } from "./fullScenarios2";
import { DEFAULT_LOG_DIR, onboardVault, type OnboardDevice, type OnboardedVault } from "./onboard";

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const SELF = fileURLToPath(import.meta.url);
const HOST = arg("host", "http://127.0.0.1:8791").replace(/\/+$/, "");
const LABEL = arg("label", "local");
const VAULT_ARG = arg("vault", "both");
const RATE = Number(arg("rate", "12"));
const BASELINE_S = Number(arg("baseline-s", "10"));
const WATCHER_MS = Number(arg("watcher-ms", "100"));
const UPLOAD_TIMEOUT_S = Number(arg("upload-timeout-s", "600"));
const WARMUP_S = 1;

const NOTE = "typing/during-upload.md";
const ATTACHMENT = "typing/max-size.mp4";
const HEADER = "# typing during a max-size upload\n\n";
/** The typed text: this phrase, over and over, one key per character. */
const PHRASE = "the quick brown fox jumps over the lazy dog 0123456789.\n";
const typedText = (n: number) => PHRASE.repeat(Math.ceil(n / PHRASE.length)).slice(0, n);

const GATE_LOOP_MAX_MS = 50;
const GATE_DISPATCH_P99_MS = 16;
const GATE_P50_SLACK_MS = 100;
const GATE_KEY_MAX_MS = 1000;
/** Heartbeat gaps at least this long are kept with their time (timelines). */
const GAP_MS = 20;

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const MB = (b: number) => r1(b / 1e6);

interface Dist { readonly n: number; readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number }

function dist(values: readonly number[]): Dist | null {
	if (values.length === 0) return null;
	const s = [...values].sort((x, y) => x - y);
	const at = (q: number) => r2(s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]!);
	return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: r2(s[s.length - 1]!) };
}

// ---- meters (both processes) -----------------------------------------------------

/** A late beat of a 1 ms heartbeat: absNow() when it fired and how late it was (the thread was blocked before `at`). */
type Gap = readonly [at: number, ms: number];

interface MainWindow {
	readonly loop: LoopStats;
	readonly heartbeatMaxGapMs: number;
	readonly gaps: readonly Gap[];
	readonly peakRssBytes: number;
	readonly peakArrayBuffersBytes: number;
	readonly peakHeapUsedBytes: number;
}

/** The thread's own loop stats and memory (EngineThreadProbe without its post list). */
interface ThreadWindow { readonly loop: LoopStats; readonly heartbeatMaxGapMs: number; readonly heapUsedBytes: number; readonly arrayBuffersBytes: number }

const threadWindow = (p: EngineThreadProbe): ThreadWindow =>
	({ loop: p.loop, heartbeatMaxGapMs: p.heartbeatMaxGapMs, heapUsedBytes: p.heapUsedBytes, arrayBuffersBytes: p.arrayBuffersBytes });

/** The main thread's event loop (delay histogram, 1 ms heartbeat) and the process's memory, per window. */
class MainMeter {
	/** Every heartbeat gap >= GAP_MS since the meter started. */
	readonly allGaps: Gap[] = [];
	peakRssBytes = 0;
	private readonly loop: IntervalHistogram = monitorEventLoopDelay({ resolution: 1 });
	private beat = performance.now();
	private maxGap = 0;
	private gaps: Gap[] = [];
	private peak = { rss: 0, arrayBuffers: 0, heapUsed: 0 };
	private readonly timers: NodeJS.Timeout[];

	constructor() {
		this.loop.enable();
		this.timers = [
			setInterval(() => {
				const now = performance.now();
				const gap = now - this.beat;
				this.beat = now;
				if (gap > this.maxGap) this.maxGap = gap;
				if (gap >= GAP_MS) {
					const g: Gap = [absNow(), r2(gap)];
					this.gaps.push(g);
					this.allGaps.push(g);
				}
			}, 1),
			setInterval(() => this.sample(), 100),
		];
		for (const t of this.timers) t.unref();
	}

	/** A new window starts now. */
	reset(): void {
		this.loop.reset();
		this.beat = performance.now();
		this.maxGap = 0;
		this.gaps = [];
		this.peak = { rss: 0, arrayBuffers: 0, heapUsed: 0 };
		this.sample();
	}

	snapshot(): MainWindow {
		this.sample();
		return { loop: loopStats(this.loop), heartbeatMaxGapMs: r2(this.maxGap), gaps: [...this.gaps],
			peakRssBytes: this.peak.rss, peakArrayBuffersBytes: this.peak.arrayBuffers, peakHeapUsedBytes: this.peak.heapUsed };
	}

	/** Peak RSS of the process: the sampled peak, and the kernel's (resourceUsage maxRSS is in KiB). */
	processPeak(): { readonly sampledBytes: number; readonly maxRssBytes: number } {
		this.sample();
		return { sampledBytes: this.peakRssBytes, maxRssBytes: process.resourceUsage().maxRSS * 1024 };
	}

	stop(): void {
		for (const t of this.timers) clearInterval(t);
		this.loop.disable();
	}

	private sample(): void {
		const m = process.memoryUsage();
		this.peak.rss = Math.max(this.peak.rss, m.rss);
		this.peak.arrayBuffers = Math.max(this.peak.arrayBuffers, m.arrayBuffers);
		this.peak.heapUsed = Math.max(this.peak.heapUsed, m.heapUsed);
		this.peakRssBytes = Math.max(this.peakRssBytes, m.rss);
	}
}

/** The other clock's offset (its absNow() minus ours), from the round trip with the least delay. */
async function calibrate(ping: () => Promise<{ sentAt: number; gotAt: number; at: number }>, n = 12): Promise<{ offsetMs: number; rttMs: number }> {
	let best = { offsetMs: 0, rttMs: Infinity };
	for (let i = 0; i < n; i++) {
		const p = await ping();
		const rtt = p.gotAt - p.sentAt;
		if (rtt < best.rttMs) best = { offsetMs: p.at - (p.sentAt + p.gotAt) / 2, rttMs: rtt };
	}
	return { offsetMs: Math.round(best.offsetMs * 1000) / 1000, rttMs: Math.round(best.rttMs * 1000) / 1000 };
}

const threadPing = (t: EngineThread) => async () => {
	const p = await t.probe(false);
	return { sentAt: p.sentAt, gotAt: p.gotAt, at: p.value.at };
};

/** An engine thread's events on its main thread's clock: posts from main are stamped there already. */
const onMain = (e: EngineThreadEvent, offsetMs: number): EngineThreadEvent =>
	e.kind === "post" && e.dir === "main-to-engine" ? e : { ...e, at: e.at - offsetMs };

const lastStatus = (c: FullClient): StatusSnapshot | undefined => c.ui.statuses.at(-1);
const live = (c: FullClient) => lastStatus(c)?.phase === "live";
const sealing = (c: FullClient) => live(c) && lastStatus(c)?.e2ee?.suite === 1 && lastStatus(c)?.e2ee?.sealEpoch === 1;

function statusDigest(s: StatusSnapshot | undefined): unknown {
	if (!s) return null;
	const { outboxFrames, unreceiptedFrames, pendingDiskOps, pendingBlobs } = s.counts;
	return { phase: s.phase, transport: s.transport, deviceClass: s.deviceClass, maxBlobBytes: s.maxBlobBytes,
		counts: { outboxFrames, unreceiptedFrames, pendingDiskOps, pendingBlobs }, e2ee: s.e2ee ? { suite: s.e2ee.suite, sealEpoch: s.e2ee.sealEpoch, keyMissing: s.e2ee.keyMissing } : null };
}

/** The plugin controller over a client (e2ee.ts): main's real pin and key flow; `creating` = this device enables E2EE. */
function controllerFor(client: FullClient, identity: PairedIdentity, creating: boolean): YaosController {
	const data: YaosPluginData = { ...defaultPluginData(client.name), identity, engine: { ...DEFAULT_ENGINE_SETTINGS, syncSettings: true },
		...(creating ? { creating: { vaultId: identity.vaultId } } : {}) };
	return new YaosController(data, {
		makeRuntime: (id, settings, ui, keys) => client.runtimeFor(id, settings, ui, keys),
		saveData: async () => {},
		notice: () => {},
		log: (l) => client.log(`main: ${l}`),
		clock: client.clock,
		secrets: client.secrets,
	});
}

// ---- device B (the --peer child) --------------------------------------------------

interface PeerStart { readonly host: string; readonly vaultId: string; readonly vaultGeneration: string; readonly device: OnboardDevice; readonly watcherMs: number; readonly e2ee: boolean }

type PeerOp =
	| ({ readonly op: "start" } & PeerStart)
	| { readonly op: "installKey"; readonly k: Uint8Array }
	| { readonly op: "openNote"; readonly path: string; readonly header: string; readonly phrase: string }
	| { readonly op: "watchAttachment"; readonly path: string; readonly size: number; readonly sha256: string }
	| { readonly op: "clock" }
	| { readonly op: "meter"; readonly reset: boolean }
	| { readonly op: "settle"; readonly text: string; readonly timeoutMs: number }
	| { readonly op: "final" }
	| { readonly op: "stop" };
type PeerRequest = PeerOp & { readonly rid: number };

/** B's clock (absNow) throughout. */
interface AttachmentSeen {
	readonly t: "attachment";
	/** B's vault write of it returned. */
	readonly landedAt: number | null;
	/** B's poll saw it at full size. */
	readonly seenAt: number;
	readonly verifiedAt: number;
	readonly ok: boolean;
	readonly sha256: string;
	readonly bytes: number;
}

type PeerMessage =
	| { readonly t: "reply"; readonly rid: number; readonly ok: true; readonly value: unknown }
	| { readonly t: "reply"; readonly rid: number; readonly ok: false; readonly error: string }
	/** The first n typed keys are in B's view, in order. */
	| { readonly t: "seen"; readonly n: number; readonly at: number }
	| { readonly t: "order"; readonly detail: unknown }
	| AttachmentSeen;

interface MeterReading { readonly main: MainWindow; readonly engine: ThreadWindow | null }
interface LargeIo { readonly at: number; readonly ms: number; readonly bytes: number }
interface Settled { readonly view: boolean; readonly disk: boolean; readonly viewLength: number; readonly diskLength: number | null }

interface PeerFinal {
	readonly carriers: ClientUi["carriers"];
	readonly fatals: string[];
	readonly status: unknown;
	/** B's engine-thread events on B's main clock. */
	readonly events: EngineThreadEvent[];
	readonly mainGaps: Gap[];
	readonly posts: { readonly mainToEngine: LargePost[]; readonly engineToMain: LargePost[] };
	/** B's vault writes of attachment-sized buffers (the sim's write is synchronous). */
	readonly largeWrites: LargeIo[];
	readonly peak: { readonly sampledBytes: number; readonly maxRssBytes: number };
	readonly order: unknown;
	readonly logTail: string[];
	readonly engineOffset: { readonly offsetMs: number; readonly rttMs: number } | null;
}

async function peerMain(): Promise<void> {
	const send = (m: PeerMessage, then?: () => void) => process.send?.(m, undefined, undefined, then ? () => then() : undefined);
	const meter = new MainMeter();
	const events: EngineThreadEvent[] = [];
	const largeWrites: LargeIo[] = [];
	let b: FullClient | null = null;
	let ctl: YaosController | null = null;
	let engineOffset: { offsetMs: number; rttMs: number } | null = null;
	let note: { readonly path: string; readonly view: SimEditorView } | null = null;
	let order: unknown = null;
	let watch: { readonly path: string; landedAt: number | null } | null = null;
	const client = (): FullClient => {
		if (!b) throw new Error("not started");
		return b;
	};

	const handle = async (m: PeerRequest): Promise<unknown> => {
		switch (m.op) {
			case "start": {
				const c = new FullClient({ name: "b", host: m.host, vaultId: m.vaultId, device: m.device, watcherDelayMs: m.watcherMs, carrier: "worker", engineEvents: (e) => events.push(e) });
				b = c;
				installPlugin(c);
				const write = c.vault.write.bind(c.vault);
				c.vault.write = async (path, data, precondition) => {
					const s = performance.now();
					const out = await write(path, data, precondition);
					if (typeof data !== "string" && data.byteLength >= LARGE_BUFFER_BYTES) {
						const at = absNow();
						largeWrites.push({ at, ms: r2(performance.now() - s), bytes: data.byteLength });
						if (watch && path === watch.path && out.ok) watch.landedAt ??= at;
					}
					return out;
				};
				if (m.e2ee) {
					ctl = controllerFor(c, { host: m.host, vaultId: m.vaultId, deviceId: m.device.deviceId, deviceToken: m.device.deviceToken, deviceName: "b", vaultGeneration: m.vaultGeneration }, false);
					await c.thread?.ready;
					await ctl.start();
					await waitFor(() => lastStatus(c)?.phase === "key-missing" && lastStatus(c)?.e2ee?.keyMissing === "encrypted-vault", "b sees an encrypted vault", 60_000, performance.now(), 50);
				} else {
					await c.start();
					await waitFor(() => live(c), "b live", 60_000, performance.now(), 50);
				}
				if (c.thread) engineOffset = await calibrate(threadPing(c.thread));
				return null;
			}
			case "installKey": {
				const c = client();
				if (!ctl) throw new Error("installKey on a plain vault");
				const r = await ctl.command({ t: "installKey", source: "qr", e: 1, k: m.k });
				if (r.t !== "ok") throw new Error(`installKey: ${r.t}`);
				await waitFor(() => sealing(c), "b live under K_1", 60_000, performance.now(), 50);
				return null;
			}
			case "openNote": {
				const c = client();
				await waitFor(() => c.vault.textOf(m.path) === m.header, `${m.path} on b`, 60_000, performance.now(), 20);
				const view = c.workspace.openFile(m.path);
				if (!view) throw new Error(`b cannot open ${m.path}`);
				await waitFor(() => view.isBound() && view.buffer === m.header, "b's view bound", 30_000, performance.now(), 10);
				note = { path: m.path, view };
				let plan = "";
				let seen = 0;
				const check = () => {
					const buf = view.buffer;
					const body = buf.slice(m.header.length);
					while (plan.length < body.length) plan += m.phrase.repeat(64);
					if (!buf.startsWith(m.header) || body !== plan.slice(0, body.length)) {
						if (order === null) {
							let d = 0;
							while (d < body.length && body[d] === plan[d]) d++;
							order = { at: absNow(), length: buf.length, headerIntact: buf.startsWith(m.header), firstDiffAt: d, got: body.slice(d, d + 16), want: plan.slice(d, d + 16) };
							send({ t: "order", detail: order });
						}
						return;
					}
					if (body.length > seen) {
						seen = body.length;
						send({ t: "seen", n: seen, at: absNow() });
					}
				};
				// SimEditorView applies every transaction through its own this.change (remote entries included): an own
				// property sees each one as it lands; the poll covers anything else that replaces the buffer.
				const v = view as unknown as { change(c: unknown, kind: string): void };
				const change = v.change;
				v.change = (cs, kind) => {
					change.call(view, cs, kind);
					if (kind !== "local") check();
				};
				setInterval(check, 25).unref();
				return null;
			}
			case "watchAttachment": {
				const c = client();
				const w = { path: m.path, landedAt: null as number | null };
				watch = w;
				let busy = false;
				const poll = setInterval(() => {
					if (busy) return;
					busy = true;
					void (async () => {
						const st = await c.vault.stat(m.path);
						if (!st || st.size !== m.size) {
							busy = false;
							return;
						}
						clearInterval(poll);
						const seenAt = absNow();
						const bytes = await c.vault.readBytes(m.path);
						const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
						send({ t: "attachment", landedAt: w.landedAt, seenAt, verifiedAt: absNow(), ok: digest === m.sha256, sha256: digest, bytes: bytes.byteLength });
					})();
				}, 20);
				return null;
			}
			case "clock":
				return absNow();
			case "meter": {
				const c = client();
				if (m.reset) {
					if (c.thread) await c.thread.probe(true);
					meter.reset();
					return null;
				}
				const main = meter.snapshot();
				const engine = c.thread ? threadWindow((await c.thread.probe(false)).value) : null;
				return { main, engine } satisfies MeterReading;
			}
			case "settle": {
				const c = client();
				const n = note;
				if (!n) throw new Error("no note open");
				try {
					await waitFor(() => n.view.buffer === m.text && c.vault.textOf(n.path) === m.text, "b's view and disk", m.timeoutMs, performance.now(), 20);
				} catch { /* reported below */ }
				const disk = c.vault.textOf(n.path);
				return { view: n.view.buffer === m.text, disk: disk === m.text, viewLength: n.view.buffer.length, diskLength: disk?.length ?? null } satisfies Settled;
			}
			case "final": {
				const c = client();
				const probe = c.thread ? (await c.thread.probe(false)).value : null;
				const off = engineOffset?.offsetMs ?? 0;
				return {
					carriers: c.ui.carriers,
					fatals: c.ui.fatals.map((f) => f.code),
					status: statusDigest(lastStatus(c)),
					events: events.map((e) => onMain(e, off)),
					mainGaps: meter.allGaps,
					posts: { mainToEngine: c.thread?.posts ?? [], engineToMain: (probe?.posts ?? []).map((p) => ({ ...p, at: p.at - off })) },
					largeWrites,
					peak: meter.processPeak(),
					order,
					logTail: c.logLines.slice(-60),
					engineOffset,
				} satisfies PeerFinal;
			}
			case "stop": {
				const c = client();
				try { await ctl?.stop(); } catch { /* best effort */ }
				await c.stop();
				await c.thread?.close();
				meter.stop();
				return null;
			}
		}
	};

	process.on("disconnect", () => process.exit(2));
	process.on("message", (raw) => {
		const m = raw as PeerRequest;
		handle(m).then(
			(value) => send({ t: "reply", rid: m.rid, ok: true, value }, m.op === "stop" ? () => process.exit(0) : undefined),
			(e: unknown) => send({ t: "reply", rid: m.rid, ok: false, error: e instanceof Error ? e.message : String(e) }),
		);
	});
}

/** The orchestrator's handle on B. */
class Peer {
	readonly seen: { readonly n: number; readonly at: number }[] = [];
	seenN = 0;
	order: unknown = null;
	attachment: AttachmentSeen | null = null;
	private readonly child: ChildProcess;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private nextRid = 1;
	private gone: string | null = null;

	constructor() {
		// execArgv is inherited (--import jiti/register); "advanced" carries the epoch key as bytes.
		this.child = fork(SELF, ["--peer"], { serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] });
		this.child.on("message", (raw) => {
			const m = raw as PeerMessage;
			switch (m.t) {
				case "reply": {
					const p = this.pending.get(m.rid);
					this.pending.delete(m.rid);
					if (m.ok) p?.resolve(m.value);
					else p?.reject(new Error(`b: ${m.error}`));
					return;
				}
				case "seen":
					this.seen.push({ n: m.n, at: m.at });
					this.seenN = m.n;
					return;
				case "order":
					this.order ??= m.detail;
					return;
				case "attachment":
					this.attachment = m;
					return;
			}
		});
		this.child.on("exit", (code, signal) => {
			this.gone = `b exited (${code ?? signal})`;
			for (const p of this.pending.values()) p.reject(new Error(this.gone));
			this.pending.clear();
		});
	}

	call<T>(op: PeerOp): Promise<T> {
		if (this.gone) return Promise.reject(new Error(this.gone));
		const rid = this.nextRid++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(rid, { resolve: resolve as (v: unknown) => void, reject });
			this.child.send({ rid, ...op });
		});
	}

	ping = async () => {
		const sentAt = absNow();
		const at = await this.call<number>({ op: "clock" });
		return { sentAt, gotAt: absNow(), at };
	};

	kill(): void {
		if (!this.gone) this.child.kill();
	}
}

// ---- device A: typing ------------------------------------------------------------

type WindowName = "warmup" | "baseline" | "upload";

interface Key {
	readonly i: number;
	readonly window: WindowName;
	/** The scheduled press (A's absNow): the latency origin. */
	readonly pressAt: number;
	/** When its transaction ran: later than pressAt while A's main thread was busy. */
	readonly at: number;
	readonly editMs: number;
	/** The flush that pushed it (bodyPush posted). */
	flushAt: number | null;
	flushMs: number | null;
}

interface Flush { readonly at: number; readonly ms: number; readonly pushed: number; readonly keys: number }

/** Types into A's bound view at RATE keys/s and times each key's dispatch. */
class Typist {
	readonly keys: Key[] = [];
	readonly flushes: Flush[] = [];
	private unflushed: Key[] = [];

	constructor(private readonly view: SimEditorView, bindings: BindingManager) {
		const bm = bindings as unknown as { flushSlot(slot: unknown): void; readonly stats: BindingManager["stats"] };
		const flushSlot = bm.flushSlot;
		// BindingManager calls this.flushSlot (binding.ts onLocal's coalesce timer, onSaveRead, flushAll): an own
		// property shadows the method, so each flush is timed where it runs. A flush that posted a bodyPush
		// (stats.pushes moved) carried every key typed since the last one that did.
		bm.flushSlot = (slot) => {
			const pushes = bm.stats.pushes;
			const s = performance.now();
			flushSlot.call(bm, slot);
			const ms = performance.now() - s;
			const at = absNow();
			const pushed = bm.stats.pushes - pushes;
			const carried = pushed > 0 ? this.unflushed.splice(0) : [];
			for (const k of carried) {
				k.flushAt = at;
				k.flushMs = ms;
			}
			this.flushes.push({ at, ms: Math.round(ms * 1000) / 1000, pushed, keys: carried.length });
		};
	}

	/** One key every 1000/RATE ms from now (drift-free; keys due while main was blocked go back to back). */
	async type(window: WindowName, done: (elapsedMs: number) => boolean, maxMs: number): Promise<void> {
		const period = 1000 / RATE;
		const t0 = absNow();
		for (let k = 0; ; k++) {
			const pressAt = t0 + k * period;
			const wait = pressAt - absNow();
			if (wait > 0) await sleep(wait);
			else await new Promise<void>((r) => setImmediate(r));
			if (done(pressAt - t0) || pressAt - t0 > maxMs) return;
			this.press(window, pressAt);
		}
	}

	private press(window: WindowName, pressAt: number): void {
		const i = this.keys.length;
		const at = absNow();
		const s = performance.now();
		this.view.edit(HEADER.length + i, 0, PHRASE[i % PHRASE.length]!);
		const editMs = performance.now() - s;
		const key: Key = { i, window, pressAt, at, editMs, flushAt: null, flushMs: null };
		this.keys.push(key);
		this.unflushed.push(key);
	}
}

// ---- one vault -----------------------------------------------------------------

type VaultKind = "plain" | "e2ee";

interface WindowReading { readonly startAt: number; readonly endAt: number; readonly aMain: MainWindow; readonly aEngine: ThreadWindow; readonly b: MeterReading }

interface WindowRow {
	readonly vault: VaultKind;
	readonly window: "baseline" | "upload";
	readonly ms: number;
	readonly keys: number;
	readonly aMainLoop: LoopStats;
	readonly aMainHeartbeatMaxGapMs: number;
	readonly aMainGapsOver20Ms: number;
	readonly dispatchMs: Dist | null;
	readonly editMs: Dist | null;
	readonly flushMs: Dist | null;
	/** Scheduled press -> its transaction ran. */
	readonly pressLagMs: Dist | null;
	readonly aEngineLoop: LoopStats;
	readonly aEngineHeartbeatMaxGapMs: number;
	readonly keyToPeerMs: Dist | null;
	readonly senderMs: Dist | null;
	readonly relayMs: Dist | null;
	readonly receiverMs: Dist | null;
	readonly keysOver1s: number;
	readonly bMainLoop: LoopStats;
	readonly bMainHeartbeatMaxGapMs: number;
	readonly bEngineLoop: LoopStats | null;
	readonly peakRssMB: { readonly a: number; readonly b: number };
	readonly peakArrayBuffersMB: { readonly a: number; readonly b: number };
	readonly uploadWallMs: number | null;
}

interface Mark { readonly at: number; readonly who: string; readonly what: string }

function engineMark(e: EngineThreadEvent, who: "a" | "b"): Mark {
	switch (e.kind) {
		case "append": return { at: e.at, who: `${who}.engine`, what: `APPEND ${e.stream} #${e.frameId} ${e.bytes} B` };
		case "relay": return { at: e.at, who: `${who}.engine`, what: `${e.t}${e.stream ? ` ${e.stream} #${e.frameId}` : ""}` };
		case "blob": return { at: e.at, who: `${who}.engine`, what: `blob ${e.op} ${e.phase} ${e.bytes} B${e.error ? ` (${e.error})` : ""}` };
		case "gap": return { at: e.at - e.ms, who: `${who}.engine`, what: `loop blocked ${r1(e.ms)} ms` };
		case "post": return { at: e.at, who: `${who}.${e.dir === "main-to-engine" ? "main" : "engine"}`, what: `post ${e.t} ${e.bytes} B ${e.transferred ? "moved" : "COPIED"}` };
	}
}

const gapMark = (g: Gap, who: string): Mark => ({ at: g[0] - g[1], who, what: `loop blocked ${r1(g[1])} ms` });

async function runVault(R: Report, kind: VaultKind, meter: MainMeter, vaults: OnboardedVault[]): Promise<WindowRow[]> {
	R.step(`typing during a max-size upload, ${kind === "e2ee" ? "E2EE on (suite 1)" : "E2EE off (suite 0)"}`);
	const vault = await onboardVault(HOST, { devices: 2, label: `typing-${kind}-${LABEL}` });
	vaults.push(vault);
	const dA = vault.devices[0]!;
	const aEvents: EngineThreadEvent[] = [];
	const a = new FullClient({ name: "a", host: HOST, vaultId: vault.vaultId, device: dA, watcherDelayMs: WATCHER_MS, carrier: "worker", engineEvents: (e) => aEvents.push(e) });
	installPlugin(a);
	const thread = a.thread!;
	const peer = new Peer();
	let ctl: YaosController | null = null;
	const x: Record<string, unknown> = {};
	R.extra[kind] = x;
	try {
		// ---- setup: both devices live on the vault's suite
		if (kind === "e2ee") {
			const c = controllerFor(a, { host: HOST, vaultId: vault.vaultId, deviceId: dA.deviceId, deviceToken: dA.deviceToken, deviceName: "a", vaultGeneration: vault.vaultGeneration }, true);
			ctl = c;
			await thread.ready;
			await c.start();
			await waitFor(() => lastStatus(a)?.e2ee?.creatable === true, "a creatable", 30_000, performance.now(), 50);
			const r = await c.command({ t: "enableE2ee", rk: makeRecoveryKey(new Uint8Array(nodeRandomBytes(32))) });
			if (r.t !== "ok") throw new Error(`enableE2ee on a: ${r.t}`);
			await waitFor(() => sealing(a), "a live under K_1", 60_000, performance.now(), 50);
		} else {
			await a.start();
			await waitFor(() => live(a), "a live", 60_000, performance.now(), 50);
		}
		await peer.call({ op: "start", host: HOST, vaultId: vault.vaultId, vaultGeneration: vault.vaultGeneration, device: vault.devices[1]!, watcherMs: WATCHER_MS, e2ee: kind === "e2ee" });
		if (kind === "e2ee") {
			// A fresh copy (VaultKeyStore.load decodes each call): sent to B's process as bytes, never printed, zeroed after.
			const k = new VaultKeyStore(a.secrets, vault.vaultId, a.clock).load()?.keys.find((y) => y.e === 1)?.k;
			if (!k) throw new Error("a stores no key for epoch 1");
			try { await peer.call({ op: "installKey", k }); } finally { k.fill(0); }
		}

		// ---- the attachment's size, as the engine derives it
		const caps = await (await fetch(`${HOST}/api/capabilities`)).json() as { attachments?: unknown; maxBlobUploadBytes?: unknown };
		const store = await probeHttpBlob({ baseUrl: HOST, vaultId: vault.vaultId, credential: dA.deviceToken, clock: createWebClock() });
		if (!store) throw new Error("the relay has no blob store (attachments are not synced)");
		const cap = store.maxBlobBytes;
		const size = kind === "e2ee" ? maxSealedBlobPlaintext(cap) : cap;
		await waitFor(() => (lastStatus(a)?.maxBlobBytes ?? null) !== null, "a's maxBlobBytes", 30_000, performance.now(), 20);
		const statusMax = lastStatus(a)?.maxBlobBytes ?? null;
		x.size = { advertisedMaxBlobUploadBytes: caps.maxBlobUploadBytes ?? null, storeCapBytes: cap, attachmentBytes: size, statusMaxBlobBytes: statusMax,
			maxAttachmentBytes: DEFAULT_ENGINE_SETTINGS.maxAttachmentBytes };
		R.check(`${kind}: the attachment is the largest the store moves (= A's status maxBlobBytes, <= maxAttachmentBytes)`,
			size > 0 && size === statusMax && size <= DEFAULT_ENGINE_SETTINGS.maxAttachmentBytes, x.size);

		// ---- the note, open in a bound editor on both
		a.vault.userWrite(NOTE, HEADER);
		const va = a.workspace.openFile(NOTE);
		if (!va) throw new Error(`a cannot open ${NOTE}`);
		await waitFor(() => va.isBound(), "a's view bound", 30_000, performance.now(), 10);
		await peer.call({ op: "openNote", path: NOTE, header: HEADER, phrase: PHRASE });
		const runtime = a.runtime;
		const typist = new Typist(va, runtime.bindings);
		const reads: LargeIo[] = [];
		const readBytes = a.vault.readBytes.bind(a.vault);
		a.vault.readBytes = async (p) => {
			const s = performance.now();
			const out = await readBytes(p);
			if (out.byteLength >= LARGE_BUFFER_BYTES) reads.push({ at: absNow(), ms: r2(performance.now() - s), bytes: out.byteLength });
			return out;
		};

		const bytes = new Uint8Array(size);
		randomFillSync(bytes);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const offB = await calibrate(peer.ping);
		const offW = await calibrate(threadPing(thread));
		x.clocks = { bMinusA: offB, aEngineMinusAMain: offW };

		const measure = async (run: () => Promise<void>): Promise<WindowReading> => {
			await thread.probe(true);
			await peer.call({ op: "meter", reset: true });
			meter.reset();
			const startAt = absNow();
			await run();
			const endAt = absNow();
			const aMain = meter.snapshot();
			const aEngine = threadWindow((await thread.probe(false)).value);
			const b = await peer.call<MeterReading>({ op: "meter", reset: false });
			return { startAt, endAt, aMain, aEngine, b };
		};
		const drain = async (what: string, ms: number) => {
			try {
				await waitFor(() => peer.seenN >= typist.keys.length || peer.order !== null, what, ms, performance.now(), 10);
				return true;
			} catch {
				return false;
			}
		};

		// ---- warmup, baseline, upload
		await typist.type("warmup", (t) => t >= WARMUP_S * 1000, 60_000);
		R.check(`${kind}: warmup keys reached b`, await drain("warmup keys on b", 30_000), { keys: typist.keys.length, seen: peer.seenN });
		const baseline = await measure(() => typist.type("baseline", (t) => t >= BASELINE_S * 1000, BASELINE_S * 1000 + 1000));
		R.check(`${kind}: baseline keys reached b`, await drain("baseline keys on b", 60_000), { keys: typist.keys.length, seen: peer.seenN });

		await peer.call({ op: "watchAttachment", path: ATTACHMENT, size, sha256 });
		const w0 = performance.now();
		const writeAt = absNow();
		a.vault.externalWrite(ATTACHMENT, bytes);
		// The sim's own write (SimVault.commit), not the client's: let its loop delay land before the window opens.
		const simWriteMs = r2(performance.now() - w0);
		await sleep(10);
		const upload = await measure(() => typist.type("upload", () => peer.attachment !== null, UPLOAD_TIMEOUT_S * 1000));
		const att = peer.attachment as AttachmentSeen | null;
		R.check(`${kind}: b has the attachment, sha256-identical`, att?.ok === true && att.bytes === size,
			att ? { bytes: att.bytes, ok: att.ok, sha256: att.sha256.slice(0, 16), want: sha256.slice(0, 16) } : `not on b within ${UPLOAD_TIMEOUT_S} s`);
		const drained = await drain("every key on b", 60_000);

		// ---- convergence
		const expected = HEADER + typedText(typist.keys.length);
		try {
			await waitFor(() => va.buffer === expected && a.vault.textOf(NOTE) === expected, "a's view and disk", 30_000, performance.now(), 20);
		} catch { /* reported below */ }
		const bSettled = await peer.call<Settled>({ op: "settle", text: expected, timeoutMs: 30_000 });
		const aSettled = { view: va.buffer === expected, disk: a.vault.textOf(NOTE) === expected };
		R.check(`${kind}: b's view = a's view = header + every typed key, in order (disks follow)`,
			drained && peer.order === null && aSettled.view && aSettled.disk && bSettled.view && bSettled.disk,
			{ keys: typist.keys.length, seenOnB: peer.seenN, order: peer.order, a: aSettled, b: bSettled });
		let idle = true;
		try {
			await waitFor(() => { const c = lastStatus(a)?.counts; return c?.outboxFrames === 0 && c.pendingBlobs === 0 && c.pendingDiskOps === 0; }, "a idle", 60_000, performance.now(), 50);
		} catch { idle = false; }
		R.check(`${kind}: a's outbox, blob queue and disk ops drained`, idle, statusDigest(lastStatus(a)));

		const bFinal = await peer.call<PeerFinal>({ op: "final" });
		const aProbe = (await thread.probe(false)).value;
		const carriers = [...a.ui.carriers, ...bFinal.carriers];
		R.check(`${kind}: both engines ran on the worker carrier`,
			carriers.length > 0 && carriers.every((c) => c.carrier === "worker") && lastStatus(a)?.transport === "worker",
			{ a: a.ui.carriers, b: bFinal.carriers });
		R.check(`${kind}: no fatal on either device`, a.ui.fatals.length === 0 && bFinal.fatals.length === 0, { a: a.ui.fatals.map((f) => f.code), b: bFinal.fatals });
		R.check(`${kind}: a's runtime was not replaced while typing`, a.runtime === runtime && a.engineStarts === a.ui.carriers.length, { engineStarts: a.engineStarts });

		// ---- transfers: the attachment crossed each main <-> engine boundary moved, never copied
		const aIn = thread.posts.filter((p) => p.bytes >= size);
		const bOut = bFinal.posts.engineToMain.filter((p) => p.bytes >= size);
		const allPosts = { aMainToEngine: thread.posts, aEngineToMain: aProbe.posts, bMainToEngine: bFinal.posts.mainToEngine, bEngineToMain: bFinal.posts.engineToMain };
		x.posts = allPosts;
		x.largeReadsOnA = reads;
		x.largeWritesOnB = bFinal.largeWrites;
		R.check(`${kind}: the attachment's bytes were moved to a's engine thread (detached after the post), never copied`,
			aIn.length >= 1 && thread.posts.every((p) => p.transferred), { attachmentPosts: aIn.length, copied: thread.posts.filter((p) => !p.transferred) });
		R.check(`${kind}: b's engine thread moved them to b's main (detached after the post), never copied`,
			bOut.length >= 1 && bFinal.posts.engineToMain.every((p) => p.transferred), { attachmentPosts: bOut.length, copied: bFinal.posts.engineToMain.filter((p) => !p.transferred) });
		R.check(`${kind}: no attachment-sized copy crossed a thread boundary`,
			[...aProbe.posts, ...bFinal.posts.mainToEngine].every((p) => p.transferred), { aEngineToMain: aProbe.posts.length, bMainToEngine: bFinal.posts.mainToEngine.length });

		// ---- per key: seen on B, and the frame that carried it
		const bOn = (at: number) => at - offB.offsetMs;
		const seenAt: (number | null)[] = typist.keys.map(() => null);
		let prev = 0;
		for (const s of peer.seen) {
			for (let i = prev; i < s.n && i < seenAt.length; i++) seenAt[i] = bOn(s.at);
			prev = Math.max(prev, s.n);
		}
		const aEv = aEvents.map((e) => onMain(e, offW.offsetMs));
		const bEv = bFinal.events.map((e) => ({ ...e, at: bOn(e.at) }) as EngineThreadEvent);
		const bodyAppends = aEv.filter((e): e is Extract<EngineThreadEvent, { kind: "append" }> => e.kind === "append" && e.stream.startsWith("b:")).sort((p, q) => p.at - q.at);
		const arrived = new Map<string, number>();
		for (const e of bEv) {
			if (e.kind !== "relay" || (e.t !== "provisional" && e.t !== "committed") || !e.stream || !e.frameId) continue;
			const k = `${e.stream}#${e.frameId}`;
			arrived.set(k, Math.min(arrived.get(k) ?? Infinity, e.at));
		}
		interface Row { readonly k: Key; readonly appendAt: number | null; readonly arriveAt: number | null; readonly seenAt: number | null }
		const rows: Row[] = [];
		let ptr = 0;
		for (const k of typist.keys) {
			let appendAt: number | null = null;
			let arriveAt: number | null = null;
			if (k.flushAt !== null) {
				while (ptr < bodyAppends.length && bodyAppends[ptr]!.at < k.flushAt - 1) ptr++;
				const ap = bodyAppends[ptr];
				if (ap) {
					appendAt = ap.at;
					arriveAt = arrived.get(`${ap.stream}#${ap.frameId}`) ?? null;
				}
			}
			rows.push({ k, appendAt, arriveAt, seenAt: seenAt[k.i] ?? null });
		}
		const ofWindow = (w: WindowName) => rows.filter((r) => r.k.window === w);
		const kp = (r: Row) => (r.seenAt === null ? null : r.seenAt - r.k.pressAt);
		const nums = (v: (number | null)[]) => v.filter((y): y is number => y !== null);

		// ---- timelines of the keys over 1 s (and of the upload's worst key)
		const marks: Mark[] = [
			...typist.keys.map((k) => ({ at: k.at, who: "a.main", what: `key ${k.i} typed (${r1(k.at - k.pressAt)} ms late, edit ${r2(k.editMs)} ms)` })),
			...typist.flushes.map((f) => ({ at: f.at, who: "a.main", what: `flush ${f.ms} ms, ${f.pushed} push, ${f.keys} keys` })),
			...meter.allGaps.map((g) => gapMark(g, "a.main")),
			...reads.map((r) => ({ at: r.at, who: "a.main", what: `vault read ${r.bytes} B (${r.ms} ms)` })),
			...aEv.map((e) => engineMark(e, "a")),
			...bEv.map((e) => engineMark(e, "b")),
			...bFinal.mainGaps.map((g) => gapMark([bOn(g[0]), g[1]], "b.main")),
			...bFinal.largeWrites.map((w) => ({ at: bOn(w.at), who: "b.main", what: `vault write ${w.bytes} B (${w.ms} ms)` })),
			...peer.seen.map((s) => ({ at: bOn(s.at), who: "b.main", what: `b's view has ${s.n} keys` })),
			{ at: writeAt, who: "a.main", what: `attachment written to a's disk (${size} B)` },
		].sort((p, q) => p.at - q.at);
		const timeline = (r: Row) => {
			const from = r.k.pressAt - 50;
			const to = (r.seenAt ?? r.k.pressAt + 5000) + 20;
			return marks.filter((m) => m.at >= from && m.at <= to).slice(0, 400).map((m) => `${r1(m.at - r.k.pressAt)} ${m.who} ${m.what}`);
		};
		const stalls: unknown[] = [];
		const slow = rows.filter((r) => (kp(r) ?? Infinity) > GATE_KEY_MAX_MS && r.k.window !== "warmup");
		let coveredTo = -Infinity;
		for (let i = 0; i < slow.length; ) {
			const first = slow[i]!;
			const group: Row[] = [];
			const end = first.seenAt ?? Infinity;
			while (i < slow.length && slow[i]!.k.pressAt <= Math.max(end, coveredTo)) group.push(slow[i++]!);
			if (group.length === 0) group.push(slow[i++]!);
			coveredTo = Math.max(...group.map((g) => g.seenAt ?? Infinity));
			const worst = group.reduce((p, q) => ((kp(q) ?? Infinity) > (kp(p) ?? Infinity) ? q : p));
			if (stalls.length < 5) {
				stalls.push({ window: worst.k.window, keys: group.length, firstKey: group[0]!.k.i, worstKey: worst.k.i, worstMs: kp(worst) === null ? null : r1(kp(worst)!),
					timeline: timeline(worst) });
			}
		}
		x.stalls = stalls;
		const up = ofWindow("upload").filter((r) => kp(r) !== null);
		const worstUp = up.length ? up.reduce((p, q) => (kp(q)! > kp(p)! ? q : p)) : null;
		x.worstUploadKey = worstUp ? { key: worstUp.k.i, ms: r1(kp(worstUp)!), timeline: timeline(worstUp) } : null;

		// ---- the upload's phases (ms after the write to a's disk)
		const rel = (at: number | null | undefined) => (at === null || at === undefined ? null : r1(at - writeAt));
		const blobAt = (ev: EngineThreadEvent[], op: "put" | "get", phase: "start" | "end" | "error") =>
			ev.find((e) => e.kind === "blob" && e.op === op && e.phase === phase && e.bytes >= (phase === "start" && op === "get" ? 0 : size) && e.at >= writeAt)?.at ?? null;
		const landedAt = att?.landedAt !== null && att?.landedAt !== undefined ? bOn(att.landedAt) : att ? bOn(att.seenAt) : null;
		const uploadWallMs = landedAt === null ? null : r1(landedAt - writeAt);
		x.upload = {
			simWriteMs, uploadWallMs,
			phasesMs: {
				aRead: rel(reads.find((r) => r.at >= writeAt)?.at), aPostToEngine: rel(aIn[0]?.at), aPutStart: rel(blobAt(aEv, "put", "start")), aPutEnd: rel(blobAt(aEv, "put", "end")),
				aPutError: rel(blobAt(aEv, "put", "error")), bGetStart: rel(blobAt(bEv, "get", "start")), bGetEnd: rel(blobAt(bEv, "get", "end")), bPostToMain: rel(bOut[0] ? bOn(bOut[0].at) : null),
				bLanded: rel(landedAt), bVerified: rel(att ? bOn(att.verifiedAt) : null),
			},
			blobErrors: [...aEv, ...bEv].filter((e) => e.kind === "blob" && e.phase === "error").map((e) => (e.kind === "blob" ? e.error : null)),
		};

		// ---- per-window rows and gates
		const peaks = { a: meter.processPeak(), b: bFinal.peak };
		x.peakRss = peaks;
		const row = (w: "baseline" | "upload", rd: WindowReading): WindowRow => {
			const rs = ofWindow(w);
			return {
				vault: kind, window: w, ms: Math.round(rd.endAt - rd.startAt), keys: rs.length,
				aMainLoop: rd.aMain.loop, aMainHeartbeatMaxGapMs: rd.aMain.heartbeatMaxGapMs, aMainGapsOver20Ms: rd.aMain.gaps.length,
				dispatchMs: dist(rs.map((r) => r.k.editMs + (r.k.flushMs ?? 0))),
				editMs: dist(rs.map((r) => r.k.editMs)),
				flushMs: dist(nums(rs.map((r) => r.k.flushMs))),
				pressLagMs: dist(rs.map((r) => r.k.at - r.k.pressAt)),
				aEngineLoop: rd.aEngine.loop, aEngineHeartbeatMaxGapMs: rd.aEngine.heartbeatMaxGapMs,
				keyToPeerMs: dist(nums(rs.map(kp))),
				senderMs: dist(nums(rs.map((r) => (r.appendAt === null ? null : r.appendAt - r.k.pressAt)))),
				relayMs: dist(nums(rs.map((r) => (r.appendAt === null || r.arriveAt === null ? null : r.arriveAt - r.appendAt)))),
				receiverMs: dist(nums(rs.map((r) => (r.arriveAt === null || r.seenAt === null ? null : r.seenAt - r.arriveAt)))),
				keysOver1s: rs.filter((r) => (kp(r) ?? Infinity) > GATE_KEY_MAX_MS).length,
				bMainLoop: rd.b.main.loop, bMainHeartbeatMaxGapMs: rd.b.main.heartbeatMaxGapMs, bEngineLoop: rd.b.engine?.loop ?? null,
				peakRssMB: { a: MB(rd.aMain.peakRssBytes), b: MB(rd.b.main.peakRssBytes) },
				peakArrayBuffersMB: { a: MB(rd.aMain.peakArrayBuffersBytes), b: MB(rd.b.main.peakArrayBuffersBytes) },
				uploadWallMs: w === "upload" ? uploadWallMs : null,
			};
		};
		const rowsOut = [row("baseline", baseline), row("upload", upload)];
		x.windows = rowsOut;
		x.windowGaps = { baseline: { aMain: baseline.aMain.gaps, bMain: baseline.b.main.gaps }, upload: { aMain: upload.aMain.gaps, bMain: upload.b.main.gaps } };
		x.keys = rows.map((r) => [r.k.i, r.k.window[0], r1(r.k.at - r.k.pressAt), r2(r.k.editMs), r.k.flushMs === null ? null : r2(r.k.flushMs),
			r.appendAt === null ? null : r1(r.appendAt - r.k.pressAt), r.arriveAt === null ? null : r1(r.arriveAt - r.k.pressAt), kp(r) === null ? null : r1(kp(r)!)]);
		x.keysColumns = ["key", "window (w/b/u)", "pressLagMs", "editMs", "flushMs", "appendMs", "arriveOnBMs", "keyToPeerMs"];
		for (const r of rows) {
			const v = kp(r);
			if (v !== null && r.k.window !== "warmup") R.record(`${kind}_${r.k.window}_key_to_peer`, v);
			if (r.k.window !== "warmup") R.record(`${kind}_${r.k.window}_dispatch`, r.k.editMs + (r.k.flushMs ?? 0));
		}

		const [bl, ul] = rowsOut as [WindowRow, WindowRow];
		R.check(`${kind} gate: upload window, A main event-loop delay max <= ${GATE_LOOP_MAX_MS} ms`, ul.aMainLoop.max <= GATE_LOOP_MAX_MS,
			{ loop: ul.aMainLoop, heartbeatMaxGapMs: ul.aMainHeartbeatMaxGapMs, gaps: upload.aMain.gaps.map((g) => [rel(g[0]), g[1]]) });
		R.check(`${kind} gate: upload window, keystroke dispatch p99 <= ${GATE_DISPATCH_P99_MS} ms`, (ul.dispatchMs?.p99 ?? Infinity) <= GATE_DISPATCH_P99_MS, ul.dispatchMs);
		R.check(`${kind} gate: upload window, key -> peer p50 <= baseline p50 + ${GATE_P50_SLACK_MS} ms`,
			ul.keyToPeerMs !== null && bl.keyToPeerMs !== null && ul.keyToPeerMs.p50 <= bl.keyToPeerMs.p50 + GATE_P50_SLACK_MS, { baseline: bl.keyToPeerMs, upload: ul.keyToPeerMs });
		R.check(`${kind} gate: no keystroke stalled behind the upload (key -> peer max <= ${GATE_KEY_MAX_MS} ms)`,
			ul.keysOver1s === 0 && (ul.keyToPeerMs?.max ?? Infinity) <= GATE_KEY_MAX_MS, { max: ul.keyToPeerMs?.max ?? null, over1s: ul.keysOver1s, stalls: stalls.length });
		if (R.checks.some((c) => !c.ok && c.scenario === `typing during a max-size upload, ${kind === "e2ee" ? "E2EE on (suite 1)" : "E2EE off (suite 0)"}`)) {
			x.aLogTail = a.logLines.slice(-60);
			x.bLogTail = bFinal.logTail;
		}
		return rowsOut;
	} finally {
		try { await peer.call({ op: "stop" }); } catch { /* the checks report it */ }
		peer.kill();
		try { await ctl?.stop(); } catch { /* best effort */ }
		try { await a.stop(); } catch { /* best effort */ }
		await thread.close();
	}
}

function printRows(rows: readonly WindowRow[]): void {
	const d = (v: Dist | null, ...k: ("p50" | "p95" | "p99" | "max")[]) => (v ? k.map((q) => v[q]).join("/") : "-");
	console.log("\nvault  window    keys  A-loop p50/p99/max  A-hb-max  dispatch p50/p99/max  A-eng-loop max  key->peer p50/p95/max  B-loop max  B-eng-loop max  rss A/B MB  upload ms");
	for (const r of rows) {
		console.log([
			r.vault.padEnd(6), r.window.padEnd(9), String(r.keys).padStart(4),
			`${r.aMainLoop.p50}/${r.aMainLoop.p99}/${r.aMainLoop.max}`.padStart(19), String(r.aMainHeartbeatMaxGapMs).padStart(9),
			d(r.dispatchMs, "p50", "p99", "max").padStart(21), String(r.aEngineLoop.max).padStart(15),
			d(r.keyToPeerMs, "p50", "p95", "max").padStart(22), String(r.bMainLoop.max).padStart(11), String(r.bEngineLoop?.max ?? "-").padStart(15),
			`${r.peakRssMB.a}/${r.peakRssMB.b}`.padStart(11), String(r.uploadWallMs ?? "-").padStart(10),
		].join(" "));
	}
}

async function main(): Promise<void> {
	const kinds: VaultKind[] = VAULT_ARG === "both" ? ["plain", "e2ee"] : VAULT_ARG === "plain" || VAULT_ARG === "e2ee" ? [VAULT_ARG] : [];
	if (kinds.length === 0) throw new Error(`--vault plain|e2ee|both, not ${VAULT_ARG}`);
	const R = new Report();
	const meter = new MainMeter();
	const vaults: OnboardedVault[] = [];
	const rows: WindowRow[] = [];
	R.extra.config = { host: HOST, rate: RATE, baselineS: BASELINE_S, warmupS: WARMUP_S, watcherMs: WATCHER_MS, uploadTimeoutS: UPLOAD_TIMEOUT_S, node: process.version,
		gates: { loopMaxMs: GATE_LOOP_MAX_MS, dispatchP99Ms: GATE_DISPATCH_P99_MS, p50SlackMs: GATE_P50_SLACK_MS, keyMaxMs: GATE_KEY_MAX_MS } };
	R.extra.windows = rows;
	let fatal: string | null = null;
	try {
		for (const k of kinds) rows.push(...await runVault(R, k, meter, vaults));
	} catch (e) {
		fatal = e instanceof Error ? e.message : String(e);
		console.log(`FATAL ${fatal}`);
	}
	meter.stop();
	R.extra.peakRssA = meter.processPeak();
	printRows(rows);
	const merged = vaults[0] ? { ...vaults[0], devices: vaults.flatMap((v) => v.devices) } : null;
	const [, failed] = R.write(DEFAULT_LOG_DIR, "client-e2e-typing", LABEL, HOST, merged, fatal);
	process.exit(failed > 0 || fatal ? 1 : 0);
}

if (process.argv.includes("--peer")) await peerMain();
else await main();
