import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceId, VaultId } from "../core/types";
import { createInlinePair, type InlinePair } from "../protocol/inlineTransport";
import type { EngineInitConfig, MainToEngine } from "../protocol/messages";
import { PROTOCOL_VERSION } from "../protocol/messages";
import type { ProtocolErrorCode } from "../protocol/errors";
import { PING_INTERVAL_MS, PING_TIMEOUT_MS } from "../protocol/transport";
import { VirtualClock } from "../sim/clock";
import { EngineHost, HostRequestError, STARTUP_PING_TIMEOUT_MS, type CarrierKind, type EngineCarrier, type EngineEventMessage } from "./engineHost";

type Mode = "ok" | "silent" | { initError: ProtocolErrorCode } | { fatalOnInit: ProtocolErrorCode } | "no-pong-after-init";

interface FakeEngineHandle {
	readonly kind: CarrierKind;
	readonly pair: InlinePair;
	readonly received: MainToEngine[];
	disposed: boolean;
	/** Stop answering anything (hung worker). */
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
		crypto: { suite: 0 },
		settings: { excludePatterns: [], syncAttachments: true, maxAttachmentBytes: 1, syncSettings: false, trashMode: "obsidian-trash", provisionalBroadcast: false, snapshots: { enabled: false, keepDaily: 0, uploadToBlobStore: false } },
		sideState: { outboxMirror: [], syncedMirror: [] },
	};
}

function fakeEngine(clock: VirtualClock, kind: CarrierKind, mode: Mode, all: FakeEngineHandle[]): EngineCarrier {
	const pair = createInlinePair({ schedule: clock.schedule });
	const h: FakeEngineHandle = { kind, pair, received: [], disposed: false, hang: false };
	all.push(h);
	pair.engine.onMessage((m) => {
		h.received.push(m);
		if (mode === "silent" || h.hang) return;
		if (!("rid" in m)) return;
		const rid = m.rid;
		switch (m.t) {
			case "ping":
				if (mode === "no-pong-after-init" && h.received.some((x) => x.t === "init")) return;
				pair.engine.post({ t: "result", re: rid, value: { t: "pong" } });
				return;
			case "init":
				if (typeof mode === "object" && "initError" in mode) {
					pair.engine.post({ t: "error", re: rid, error: { code: mode.initError, message: "no idb", retryable: false } });
					return;
				}
				if (typeof mode === "object" && "fatalOnInit" in mode) {
					pair.engine.post({ t: "fatal", error: { code: mode.fatalOnInit, message: "nope", retryable: false } });
					return;
				}
				pair.engine.post({ t: "notice", level: "info", code: "booting", message: "init" });
				pair.engine.post({ t: "result", re: rid, value: { t: "ready", protocolVersion: PROTOCOL_VERSION, vaultEpoch: null, recovered: false } });
				return;
			case "shutdown":
				pair.engine.post({ t: "result", re: rid, value: { t: "ok" } });
				return;
			case "openDoc":
				// never answered: lets tests observe abort on teardown
				return;
			default:
				pair.engine.post({ t: "result", re: rid, value: { t: "ok" } });
		}
	});
	return {
		kind,
		transport: pair.host,
		dispose() {
			h.disposed = true;
			pair.engine.close();
		},
	};
}

interface Harness {
	clock: VirtualClock;
	host: EngineHost;
	engines: FakeEngineHandle[];
	readies: { carrier: CarrierKind; restart: boolean }[];
	downs: string[];
	fatals: ProtocolErrorCode[];
	events: EngineEventMessage[];
	inits: { carrier: CarrierKind; workerSupported: boolean }[];
}

function harness(opts: { worker: (n: number) => Mode | null; inline?: Mode; ping?: boolean }): Harness {
	const clock = new VirtualClock();
	const engines: FakeEngineHandle[] = [];
	const h: Harness = { clock, host: null as unknown as EngineHost, engines, readies: [], downs: [], fatals: [], events: [], inits: [] };
	let workerCount = 0;
	h.host = new EngineHost({
		clock,
		pingEnabled: opts.ping ?? true,
		createWorker: () => {
			const mode = opts.worker(workerCount++);
			return mode === null ? null : fakeEngine(clock, "worker", mode, engines);
		},
		createInline: () => fakeEngine(clock, "inline", opts.inline ?? "ok", engines),
		initConfig: async (carrier, workerSupported) => {
			h.inits.push({ carrier, workerSupported });
			return config();
		},
		handlers: {
			onEvent: (m) => h.events.push(m),
			onRequest: async () => ({ t: "sideFileWritten" }),
			onReady: (info) => h.readies.push({ carrier: info.carrier, restart: info.restart }),
			onDown: (reason) => h.downs.push(reason),
			onFatal: (e) => h.fatals.push(e.code),
		},
	});
	return h;
}

async function startAndSettle(h: Harness, ms = 1_000): Promise<void> {
	void h.host.start();
	await h.clock.advance(ms);
}

test("worker probe: ping then init; events during init pass through", async () => {
	const h = harness({ worker: () => "ok" });
	await startAndSettle(h);
	assert.equal(h.host.carrierKind, "worker");
	assert.equal(h.host.isReady, true);
	assert.equal(h.host.probedWorkerSupported, true);
	assert.deepEqual(h.readies, [{ carrier: "worker", restart: false }]);
	assert.deepEqual(h.inits, [{ carrier: "worker", workerSupported: true }]);
	const first = h.engines[0];
	assert.ok(first);
	assert.deepEqual(first.received.slice(0, 2).map((m) => m.t), ["ping", "init"]);
	assert.equal((first.received[0] as { rid: number }).rid, 1, "rid starts at 1 per carrier");
	assert.ok(h.events.some((e) => e.t === "notice"));
	const r = await new Promise((resolve, reject) => {
		h.host.request({ t: "command", command: { t: "pause" } }).then(resolve, reject);
		void h.clock.advance(10);
	});
	assert.deepEqual(r, { t: "ok" });
	await stopHost(h);
	assert.equal(first.disposed, true);
	assert.ok(first.received.some((m) => m.t === "shutdown"));
});

test("worker without pong in 5 s falls back to inline; init config built for inline", async () => {
	const h = harness({ worker: () => "silent" });
	await startAndSettle(h, STARTUP_PING_TIMEOUT_MS + 1_000);
	assert.equal(h.host.carrierKind, "inline");
	assert.equal(h.host.lastFallbackReason, "worker:timeout");
	assert.equal(h.host.probedWorkerSupported, false);
	assert.deepEqual(h.inits, [{ carrier: "inline", workerSupported: false }]);
	assert.equal(h.engines[0]?.disposed, true, "silent worker terminated");
	await stopHost(h);
});

test("storage failure in worker init (OR-1) falls back to inline", async () => {
	const h = harness({ worker: () => ({ initError: "storage-lost" }) });
	await startAndSettle(h);
	assert.equal(h.host.carrierKind, "inline");
	assert.equal(h.host.lastFallbackReason, "worker:storage-lost");
	assert.deepEqual(h.inits, [
		{ carrier: "worker", workerSupported: true },
		{ carrier: "inline", workerSupported: true },
	]);
	await stopHost(h);
});

test("no Worker available: straight to inline", async () => {
	const h = harness({ worker: () => null });
	await startAndSettle(h);
	assert.equal(h.host.carrierKind, "inline");
	assert.equal(h.host.lastFallbackReason, "worker-unavailable");
	await stopHost(h);
});

test("carrier crash: pending requests aborted, onDown, restart on a new generation", async () => {
	const h = harness({ worker: () => "ok" });
	await startAndSettle(h);
	const first = h.engines[0];
	assert.ok(first);
	const pending = h.host.request({ t: "openDoc", path: "a.md", viewId: 1 });
	const settled = pending.then(
		() => "resolved",
		(e: unknown) => (e instanceof HostRequestError ? e.error.code : "other"),
	);
	await h.clock.advance(5);
	first.pair.kill("worker crashed");
	await h.clock.advance(1_000);
	assert.equal(await settled, "aborted");
	assert.deepEqual(h.downs, ["failure: worker crashed"]);
	assert.equal(h.host.carrierKind, "worker");
	assert.equal(h.engines.length, 2);
	assert.deepEqual(h.readies.map((r) => r.restart), [false, true]);
	assert.equal(h.host.restarts, 1);
	// The new carrier numbers rids from 1 again.
	assert.equal((h.engines[1]?.received[0] as { rid: number }).rid, 1);
	await stopHost(h);
});

test("ping timeout restarts; more than 3 restarts in 10 min => inline only", async () => {
	const h = harness({ worker: () => "no-pong-after-init" });
	await startAndSettle(h);
	assert.equal(h.host.carrierKind, "worker");
	for (let i = 0; i < 4; i++) await h.clock.advance(PING_INTERVAL_MS + PING_TIMEOUT_MS + 100);
	assert.equal(h.downs.length, 4);
	assert.ok(h.downs.every((d) => d === "ping-timeout"));
	assert.equal(h.host.carrierKind, "inline");
	assert.equal(h.host.lastFallbackReason, "too-many-restarts");
	assert.equal(h.engines.filter((e) => e.kind === "worker").length, 4);
	// Inline keeps answering pings: no more restarts.
	await h.clock.advance(5 * PING_INTERVAL_MS);
	assert.equal(h.downs.length, 4);
	await stopHost(h);
});

test("restarts spread over more than 10 minutes stay on the worker", async () => {
	const h = harness({ worker: () => "ok" });
	await startAndSettle(h);
	for (let i = 0; i < 5; i++) {
		h.engines[h.engines.length - 1]?.pair.kill("crash");
		await h.clock.advance(4 * 60_000);
	}
	assert.equal(h.host.restarts, 5);
	assert.equal(h.host.carrierKind, "worker");
	await stopHost(h);
});

test("terminal error during init stops the host (no fallback)", async () => {
	const h = harness({ worker: () => ({ initError: "version-mismatch" }) });
	await startAndSettle(h);
	assert.deepEqual(h.fatals, ["version-mismatch"]);
	assert.equal(h.host.isStopped, true);
	assert.equal(h.host.carrierKind, null);
	assert.equal(h.engines.length, 1);
});

test("fatal message stops the host", async () => {
	const h = harness({ worker: () => ({ fatalOnInit: "storage-lost" }) });
	await startAndSettle(h);
	assert.deepEqual(h.fatals, ["storage-lost"]);
	assert.equal(h.host.isStopped, true);
	assert.equal(h.host.post({ t: "docCredit", bytes: 1 }), false);
});

test("messages from an old generation are ignored", async () => {
	const h = harness({ worker: () => "ok" });
	await startAndSettle(h);
	const first = h.engines[0];
	assert.ok(first);
	const oldEngineSide = first.pair.engine;
	h.host.simulateFailure("test");
	await h.clock.advance(1_000);
	assert.equal(h.engines.length, 2);
	const before = h.events.length;
	// The old pair is closed: posts are dropped at the transport; even a direct
	// delivery attempt does not reach the handlers.
	oldEngineSide.post({ t: "notice", level: "warn", code: "stale", message: "old" });
	await h.clock.advance(10);
	assert.equal(h.events.length, before);
	assert.equal(h.events.some((e) => e.t === "notice" && e.code === "stale"), false);
	await stopHost(h);
});

test("engine requests are answered on the same generation", async () => {
	const h = harness({ worker: () => "ok" });
	await startAndSettle(h);
	const e = h.engines[0];
	assert.ok(e);
	const answers: unknown[] = [];
	e.pair.engine.onMessage((m) => {
		if (m.t === "result" || m.t === "error") answers.push(m);
	});
	e.pair.engine.post({ t: "sideFileRead", rid: 7, name: "outbox-a.bin" });
	await h.clock.advance(10);
	assert.deepEqual(answers, [{ t: "result", re: 7, value: { t: "sideFileWritten" } }]);
	await stopHost(h);
});

test("carrier dies while stop() awaits shutdown: no zombie restart", async () => {
	const h = harness({ worker: () => "ok" });
	await startAndSettle(h);
	const first = h.engines[0];
	assert.ok(first);
	first.hang = true; // shutdown never answered
	first.pair.kill("app crash"); // failure listeners fire on the next tick, after stop() began
	const p = h.host.stop();
	await h.clock.advance(10_000);
	await p;
	assert.equal(h.engines.length, 1, "no new carrier after stop() began");
	assert.equal(h.host.restarts, 0);
	assert.equal(h.host.isStopped, true);
	assert.equal(first.disposed, true);
});

test("stop() while a carrier is still starting disposes it and never reports ready", async () => {
	const h = harness({ worker: () => "silent" });
	void h.host.start();
	await h.clock.advance(100); // startup ping outstanding
	const p = h.host.stop();
	await h.clock.advance(STARTUP_PING_TIMEOUT_MS + 1_000);
	await p;
	assert.equal(h.engines.length, 1, "no inline fallback after stop()");
	assert.equal(h.engines[0]?.disposed, true);
	assert.deepEqual(h.readies, []);
});

/** stop() awaits the shutdown answer, which needs virtual time to pass. */
async function stopHost(h: Harness): Promise<void> {
	const p = h.host.stop();
	await h.clock.advance(4_000);
	await p;
}
