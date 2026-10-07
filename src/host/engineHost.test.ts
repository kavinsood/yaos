import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceId, VaultId } from "../core/types";
import { createInlinePair, type InlinePair } from "../protocol/inlineTransport";
import type { EngineInitConfig, EngineToMain, MainToEngine } from "../protocol/messages";
import { PROTOCOL_VERSION } from "../protocol/messages";
import type { ProtocolError, ProtocolErrorCode } from "../protocol/errors";
import type { HostTransport } from "../protocol/transport";
import { PING_INTERVAL_MS, PING_TIMEOUT_MS } from "../protocol/transport";
import { createWorkerHostTransport, type WorkerLike } from "../protocol/workerTransport";
import { VirtualClock } from "../sim/clock";
import { EngineHost, HostRequestError, STARTUP_PING_TIMEOUT_MS, type EngineCarrier, type EngineEventMessage } from "./engineHost";

type Mode = "ok" | "silent" | { initError: ProtocolErrorCode } | { fatalOnInit: ProtocolErrorCode } | "no-pong-after-init";

interface FakeEngineHandle {
	readonly received: MainToEngine[];
	/** The engine side of the in-process pair (absent on the fake worker). */
	readonly pair: InlinePair | null;
	/** The fake Worker (absent on the in-process pair). */
	readonly worker: FakeWorker | null;
	disposed: boolean;
	/** Stop answering anything (hung engine). */
	hang: boolean;
}

function config(): EngineInitConfig {
	return {
		protocolVersion: PROTOCOL_VERSION,
		vaultId: "v" as VaultId,
		deviceId: "dev" as DeviceId,
		deviceLabel: "test",
		deviceClass: "desktop",
		platform: { os: "macos", isMobile: false, isTablet: false, hardwareConcurrency: 8, deviceMemoryGiB: null, workerSupported: true },
		configDir: ".obsidian",
		caseInsensitiveFs: false,
		relay: { url: "wss://example.invalid", credential: "x" },
		settings: { excludePatterns: [], syncAttachments: true, maxAttachmentBytes: 1, syncSettings: false, trashMode: "obsidian-trash", provisionalBroadcast: false, snapshots: { enabled: false, keepDaily: 0, uploadToBlobStore: false } },
		sideState: { outboxMirror: [], syncedMirror: [] },
		crypto: { suite: 0 },
	};
}

/** The fake engine's answers, shared by both carriers. */
function respond(h: FakeEngineHandle, mode: Mode, m: MainToEngine, post: (m: EngineToMain) => void): void {
	h.received.push(m);
	if (mode === "silent" || h.hang) return;
	if (!("rid" in m)) return;
	const rid = m.rid;
	switch (m.t) {
		case "ping":
			if (mode === "no-pong-after-init" && h.received.some((x) => x.t === "init")) return;
			post({ t: "result", re: rid, value: { t: "pong" } });
			return;
		case "init":
			if (typeof mode === "object" && "initError" in mode) {
				post({ t: "error", re: rid, error: { code: mode.initError, message: "no idb", retryable: true } });
				return;
			}
			if (typeof mode === "object" && "fatalOnInit" in mode) {
				post({ t: "fatal", error: { code: mode.fatalOnInit, message: "nope", retryable: false } });
				return;
			}
			post({ t: "notice", level: "info", code: "booting", message: "init" });
			post({ t: "result", re: rid, value: { t: "ready", protocolVersion: PROTOCOL_VERSION, vaultEpoch: null, recovered: false } });
			return;
		case "shutdown":
			post({ t: "result", re: rid, value: { t: "ok" } });
			return;
		case "openDoc":
			// never answered: lets tests observe abort on teardown
			return;
		default:
			post({ t: "result", re: rid, value: { t: "ok" } });
	}
}

/** The in-process pair (the carrier of tests and harnesses). */
function inlineEngine(clock: VirtualClock, mode: Mode, all: FakeEngineHandle[]): EngineCarrier {
	const pair = createInlinePair({ schedule: clock.schedule });
	const h: FakeEngineHandle = { received: [], pair, worker: null, disposed: false, hang: false };
	all.push(h);
	pair.engine.onMessage((m) => respond(h, mode, m, (out) => pair.engine.post(out)));
	return {
		kind: "inline",
		transport: pair.host,
		dispose() {
			h.disposed = true;
			pair.engine.close();
		},
	};
}

/** A Worker stand-in: the plugin's carrier (createWorkerHostTransport) over it, answers on virtual time. */
class FakeWorker implements WorkerLike {
	private readonly listeners = new Map<string, ((ev: never) => void)[]>();
	terminated = false;

	constructor(
		private readonly clock: VirtualClock,
		private readonly answer: (m: MainToEngine, post: (m: EngineToMain) => void) => void,
	) {}

	postMessage(message: unknown): void {
		if (this.terminated) return;
		this.clock.schedule(() => {
			if (this.terminated) return;
			this.answer(message as MainToEngine, (out) => this.clock.schedule(() => this.emit("message", { data: out })));
		});
	}

	addEventListener(type: string, listener: (ev: never) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}

	terminate(): void {
		this.terminated = true;
	}

	/** Dispatch a Worker event (the browser's `error` on an uncaught exception in the worker). */
	emit(type: string, ev: unknown): void {
		if (this.terminated) return;
		for (const l of this.listeners.get(type) ?? []) (l as (e: unknown) => void)(ev);
	}
}

function workerEngine(clock: VirtualClock, mode: Mode, all: FakeEngineHandle[]): EngineCarrier {
	let h: FakeEngineHandle | null = null;
	const worker = new FakeWorker(clock, (m, post) => respond(h as FakeEngineHandle, mode, m, post));
	h = { received: [], pair: null, worker, disposed: false, hang: false };
	all.push(h);
	const transport: HostTransport = createWorkerHostTransport(worker, { schedule: clock.schedule });
	const handle = h;
	return {
		kind: "worker",
		transport,
		dispose() {
			handle.disposed = true;
			worker.terminate();
		},
	};
}

type Make = (clock: VirtualClock, all: FakeEngineHandle[]) => EngineCarrier;

const worker = (mode: Mode): Make => (clock, all) => workerEngine(clock, mode, all);
const inline = (mode: Mode): Make => (clock, all) => inlineEngine(clock, mode, all);

interface Harness {
	clock: VirtualClock;
	host: EngineHost;
	engines: FakeEngineHandle[];
	/** createCarrier calls (a throwing one included). */
	constructions: number;
	readies: string[];
	fatals: ProtocolError[];
	events: EngineEventMessage[];
	inits: number;
}

function harness(make: Make, opts: { ping?: boolean } = {}): Harness {
	const clock = new VirtualClock();
	const engines: FakeEngineHandle[] = [];
	const h: Harness = { clock, host: null as unknown as EngineHost, engines, constructions: 0, readies: [], fatals: [], events: [], inits: 0 };
	h.host = new EngineHost({
		clock,
		pingEnabled: opts.ping ?? true,
		createCarrier: () => {
			h.constructions++;
			return make(clock, engines);
		},
		initConfig: async () => {
			h.inits++;
			return config();
		},
		handlers: {
			onEvent: (m) => h.events.push(m),
			onRequest: async () => ({ t: "sideFileWritten" }),
			onReady: (info) => h.readies.push(info.carrier),
			onFatal: (e) => h.fatals.push(e),
		},
	});
	return h;
}

async function startAndSettle(h: Harness, ms = 1_000): Promise<void> {
	void h.host.start();
	await h.clock.advance(ms);
}

/** A request the fake engine never answers, settled to its error code. */
function pendingOpenDoc(h: Harness): Promise<string> {
	return h.host.request({ t: "openDoc", path: "a.md", viewId: 1 }).then(
		() => "resolved",
		(e: unknown) => (e instanceof HostRequestError ? e.error.code : "other"),
	);
}

/**
 * The terminal contract (DESIGN §g.4): the host is stopped, the pending requests were rejected
 * "aborted", onFatal fired once with the truthful message, the carrier was disposed, and no second
 * carrier is built, now or later.
 */
async function assertTerminal(h: Harness, expect: { pending: Promise<string>[]; message: RegExp; code?: ProtocolErrorCode; constructions: number; built?: number }): Promise<void> {
	assert.equal(h.host.isStopped, true, "host stopped");
	assert.equal(h.host.carrierKind, null);
	assert.equal(h.host.isReady, false);
	for (const p of expect.pending) assert.equal(await p, "aborted", "pending request rejected");
	assert.equal(h.fatals.length, 1, "onFatal once");
	assert.match(h.fatals[0]?.message ?? "", expect.message);
	if (expect.code) assert.equal(h.fatals[0]?.code, expect.code);
	assert.equal(h.fatals[0]?.retryable, false);
	assert.ok(h.engines.every((e) => e.disposed), "carrier disposed");
	assert.equal(h.host.post({ t: "docCredit", bytes: 1 }), false);
	await assert.rejects(h.host.request({ t: "command", command: { t: "pause" } }), (e: unknown) => e instanceof HostRequestError && e.error.code === "not-ready");
	// Nothing restarts it: ten virtual minutes later there is still one carrier and one fatal.
	await h.clock.advance(10 * 60_000);
	assert.equal(h.constructions, expect.constructions, "no second carrier");
	assert.equal(h.engines.length, expect.built ?? expect.constructions, "carriers built");
	assert.equal(h.fatals.length, 1);
	assert.deepEqual(h.clock.pendingLabels(), [], "no timer left behind");
	await h.host.stop(); // a no-op once stopped
	assert.equal(h.fatals.length, 1);
}

// --- bring-up ----------------------------------------------------------------

test("worker carrier: ping then init; events during init pass through; stop() shuts it down", async () => {
	const h = harness(worker("ok"));
	await startAndSettle(h);
	assert.equal(h.host.carrierKind, "worker");
	assert.equal(h.host.isReady, true);
	assert.deepEqual(h.readies, ["worker"]);
	assert.equal(h.inits, 1);
	assert.equal(h.constructions, 1);
	const first = h.engines[0];
	assert.ok(first);
	assert.deepEqual(first.received.slice(0, 2).map((m) => m.t), ["ping", "init"]);
	assert.equal((first.received[0] as { rid: number }).rid, 1, "rid starts at 1");
	assert.ok(h.events.some((e) => e.t === "notice"));
	const r = await new Promise((resolve, reject) => {
		h.host.request({ t: "command", command: { t: "pause" } }).then(resolve, reject);
		void h.clock.advance(10);
	});
	assert.deepEqual(r, { t: "ok" });
	await stopHost(h);
	assert.equal(first.disposed, true);
	assert.ok(first.received.some((m) => m.t === "shutdown"));
	assert.deepEqual(h.fatals, [], "a graceful stop is not a fatal");
});

test("in-process carrier (tests, harnesses) brings up the same way", async () => {
	const h = harness(inline("ok"));
	await startAndSettle(h);
	assert.equal(h.host.carrierKind, "inline");
	assert.deepEqual(h.readies, ["inline"]);
	await stopHost(h);
});

// --- terminal cases: one carrier, every failure stops the host ---------------

test("terminal: the worker cannot be constructed (no Worker / Blob URL / bundle)", async () => {
	const h = harness(() => {
		throw new Error("this app cannot run background workers (Worker or Blob URLs are unavailable)");
	});
	await startAndSettle(h);
	await assertTerminal(h, {
		pending: [],
		message: /^the sync engine could not start: this app cannot run background workers \(Worker or Blob URLs are unavailable\)$/,
		code: "internal",
		constructions: 1,
		built: 0,
	});
	assert.equal(h.inits, 0);
	assert.deepEqual(h.readies, []);
});

test("terminal: the worker misses the startup pong", async () => {
	const h = harness(worker("silent"));
	void h.host.start();
	await h.clock.advance(100);
	// Before ready nothing can be pending from callers: requests are refused, not queued.
	const early = h.host.request({ t: "command", command: { t: "pause" } }).then(() => "resolved", (e: unknown) => (e instanceof HostRequestError ? e.error.code : "other"));
	assert.equal(await early, "not-ready");
	assert.deepEqual(h.fatals, [], "still waiting for the pong");
	await h.clock.advance(STARTUP_PING_TIMEOUT_MS);
	assert.equal(h.engines[0]?.worker?.terminated, true, "silent worker terminated");
	await assertTerminal(h, { pending: [], message: /^the sync engine did not answer within 5 s of starting$/, code: "timeout", constructions: 1 });
	assert.equal(h.inits, 0, "init config never built");
	assert.deepEqual(h.readies, []);
});

test("terminal: the worker errors (uncaught exception in the worker)", async () => {
	const h = harness(worker("ok"));
	await startAndSettle(h);
	assert.equal(h.host.isReady, true);
	const pending = [pendingOpenDoc(h), pendingOpenDoc(h)];
	await h.clock.advance(5);
	h.engines[0]?.worker?.emit("error", { message: "ReferenceError: x is not defined" });
	await h.clock.advance(5);
	assert.equal(h.engines[0]?.worker?.terminated, true);
	await assertTerminal(h, { pending, message: /^the sync engine failed: worker error: ReferenceError: x is not defined$/, code: "internal", constructions: 1 });
	assert.deepEqual(h.readies, ["worker"], "ready once, never again");
});

test("terminal: the worker errors during startup", async () => {
	const h = harness(worker("silent"));
	void h.host.start();
	await h.clock.advance(100);
	h.engines[0]?.worker?.emit("messageerror", { type: "messageerror" });
	await h.clock.advance(5);
	await assertTerminal(h, { pending: [], message: /^the sync engine failed: worker messageerror: messageerror$/, constructions: 1 });
	assert.deepEqual(h.readies, []);
});

test("terminal: the carrier's transport fails", async () => {
	const h = harness(inline("ok"));
	await startAndSettle(h);
	const pending = [pendingOpenDoc(h)];
	await h.clock.advance(5);
	h.engines[0]?.pair?.kill("engine crashed");
	await h.clock.advance(5);
	await assertTerminal(h, { pending, message: /^the sync engine failed: engine crashed$/, code: "internal", constructions: 1 });
});

test("terminal: the worker misses a liveness pong", async () => {
	const h = harness(worker("no-pong-after-init"));
	await startAndSettle(h);
	assert.equal(h.host.isReady, true);
	const pending = [pendingOpenDoc(h)];
	// Ready at t=0: the first ping goes out at PING_INTERVAL_MS, its pong is due PING_TIMEOUT_MS later.
	await h.clock.advance(PING_INTERVAL_MS + PING_TIMEOUT_MS - 1_000 - 100); // t = 24.9 s
	assert.deepEqual(h.fatals, [], "the pong is not late yet");
	await h.clock.advance(200); // t = 25.1 s
	assert.equal(h.engines[0]?.worker?.terminated, true, "hung worker terminated");
	await assertTerminal(h, { pending, message: /^the sync engine stopped answering \(no pong within 15 s\)$/, code: "internal", constructions: 1 });
});

test("terminal: init answers storage-lost (OR-1)", async () => {
	const h = harness(worker({ initError: "storage-lost" }));
	await startAndSettle(h);
	assert.equal(h.inits, 1);
	await assertTerminal(h, { pending: [], message: /^the sync engine could not start: no idb$/, code: "storage-lost", constructions: 1 });
	assert.deepEqual(h.readies, []);
});

// --- other fatal paths -------------------------------------------------------

test("protocol error answering init stops the host", async () => {
	const h = harness(worker({ initError: "version-mismatch" }));
	await startAndSettle(h);
	await assertTerminal(h, { pending: [], message: /could not start/, code: "version-mismatch", constructions: 1 });
});

test("fatal message from the engine stops the host", async () => {
	const h = harness(worker({ fatalOnInit: "storage-lost" }));
	await startAndSettle(h);
	assert.equal(h.fatals[0]?.message, "nope");
	await assertTerminal(h, { pending: [], message: /^nope$/, code: "storage-lost", constructions: 1 });
});

// --- teardown races ----------------------------------------------------------

test("messages from a torn-down carrier are ignored", async () => {
	const h = harness(inline("ok"));
	await startAndSettle(h);
	const first = h.engines[0];
	assert.ok(first?.pair);
	const oldEngineSide = first.pair.engine;
	first.pair.kill("test");
	await h.clock.advance(1_000);
	const before = h.events.length;
	// The pair is closed: posts are dropped at the transport, nothing reaches the handlers.
	oldEngineSide.post({ t: "notice", level: "warn", code: "stale", message: "old" });
	await h.clock.advance(10);
	assert.equal(h.events.length, before);
	assert.equal(h.events.some((e) => e.t === "notice" && e.code === "stale"), false);
	assert.equal(h.constructions, 1);
});

test("engine requests are answered on the same carrier", async () => {
	const h = harness(inline("ok"));
	await startAndSettle(h);
	const e = h.engines[0];
	assert.ok(e?.pair);
	const answers: unknown[] = [];
	e.pair.engine.onMessage((m) => {
		if (m.t === "result" || m.t === "error") answers.push(m);
	});
	e.pair.engine.post({ t: "sideFileRead", rid: 7, name: "outbox-a.bin" });
	await h.clock.advance(10);
	assert.deepEqual(answers, [{ t: "result", re: 7, value: { t: "sideFileWritten" } }]);
	await stopHost(h);
});

test("carrier dies while stop() awaits shutdown: a stop, not a fatal", async () => {
	const h = harness(inline("ok"));
	await startAndSettle(h);
	const first = h.engines[0];
	assert.ok(first?.pair);
	first.hang = true; // shutdown never answered
	first.pair.kill("app crash"); // failure listeners fire on the next tick, after stop() began
	const p = h.host.stop();
	await h.clock.advance(10_000);
	await p;
	assert.equal(h.constructions, 1, "no new carrier after stop() began");
	assert.deepEqual(h.fatals, []);
	assert.equal(h.host.isStopped, true);
	assert.equal(first.disposed, true);
});

test("stop() while the carrier is still starting disposes it and never reports ready", async () => {
	const h = harness(worker("silent"));
	void h.host.start();
	await h.clock.advance(100); // startup ping outstanding
	const p = h.host.stop();
	await h.clock.advance(STARTUP_PING_TIMEOUT_MS + 1_000);
	await p;
	assert.equal(h.constructions, 1);
	assert.equal(h.engines[0]?.disposed, true);
	assert.deepEqual(h.readies, []);
	assert.deepEqual(h.fatals, [], "stopping is not a fatal");
});

/** stop() awaits the shutdown answer, which needs virtual time to pass. */
async function stopHost(h: Harness): Promise<void> {
	const p = h.host.stop();
	await h.clock.advance(4_000);
	await p;
}
