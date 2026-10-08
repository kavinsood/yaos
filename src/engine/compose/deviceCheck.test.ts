/**
 * The device check's engine side (deviceCheck.ts) on fake ports: every step's pass and fail path, the zero-progress
 * FAIL, a lost link, suite 1 sealing, the large check's size; then the deviceCheck request through the protocol on a
 * simulated device (protocolEngine.ts): answered with a report, one check at a time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { concatBytes } from "../../core/codec/lib0";
import type { Seq } from "../../core/types";
import type { BlobPort, BlobProgress } from "../../ports/blob";
import type { BlobAddress, SealedBlobParts } from "../../ports/crypto";
import type { RelaySession } from "../../ports/relay";
import { DEVICE_CHECK_QUICK_BYTES } from "../../protocol/messages";
import type { DeviceCheckReport, DeviceEnv } from "../../protocol/status";
import { VirtualClock } from "../../sim/clock";
import { SimDevice } from "../../sim/device";
import { SimNet } from "../../sim/net";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebClock } from "../adapters/webClock";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { createWebHash } from "../adapters/webHash";
import { createWebRandom } from "../adapters/webRandom";
import { HostRequestError } from "../../host/engineHost";
import { runDeviceCheck, type DeviceCheckDeps, type DeviceCheckLive } from "./deviceCheck";

const ENV: DeviceEnv = {
	userAgent: "test-agent", hardwareConcurrency: 6, deviceMemoryGiB: 4, jsHeap: { usedBytes: 50 << 20, totalBytes: 80 << 20, limitBytes: 2048 * 2 ** 20 },
	apis: { xmlHttpRequest: true, webSocket: true, idb: true, subtleCrypto: true },
};

/** A blob store in memory that reports progress as httpBlob does: upload events while a put moves, one per get chunk. */
class FakeStore implements BlobPort {
	readonly objects = new Map<string, Uint8Array>();
	readonly puts: number[] = [];
	constructor(readonly maxBlobBytes = 20_000_000, private readonly o: { progress?: boolean; failPut?: () => Error } = {}) {}
	async has(addresses: readonly BlobAddress[]) {
		return new Set(addresses.filter((a) => this.objects.has(a)));
	}
	async put(address: BlobAddress, parts: SealedBlobParts, _signal?: AbortSignal, progress?: BlobProgress) {
		const body = concatBytes(parts);
		this.puts.push(body.length);
		if (this.o.failPut) throw this.o.failPut();
		if (this.o.progress !== false) for (let i = 1; i <= 4; i++) progress?.(Math.round((body.length * i) / 4));
		this.objects.set(address, body);
	}
	async get(address: BlobAddress, _signal?: AbortSignal, progress?: BlobProgress) {
		const b = this.objects.get(address);
		if (!b) return null;
		for (let i = 0; i < b.length; i += 1 << 20) progress?.(Math.min(1 << 20, b.length - i));
		return b.slice();
	}
	async list(): Promise<never> { throw new Error("unused"); }
	async deleteIfUploadedBefore(): Promise<never> { throw new Error("unused"); }
}

function session(o: { ping?: (() => Promise<{ headSeq: Seq }>) | null } = {}): RelaySession {
	const ping = o.ping === undefined ? async () => ({ headSeq: 7 as Seq }) : o.ping;
	return {
		canWrite: true,
		...(ping ? { ping } : {}),
		feed: async () => ({ entries: [], throughSeq: 7 as Seq, headSeq: 7 as Seq, more: false }),
	} as unknown as RelaySession;
}

function deps(o: { live?: Partial<DeviceCheckLive> | string; store?: BlobPort | null; over?: Partial<DeviceCheckDeps> } = {}): DeviceCheckDeps {
	const hash = createWebHash();
	const clock = createWebClock();
	const live: DeviceCheckLive | string = typeof o.live === "string" ? o.live : {
		crypto: createNoopCrypto(hash), blob: o.store === undefined ? new FakeStore() : o.store, maxBlobBytes: 2_000_000, maxAttachmentBytes: 1024 << 20,
		blobBytesInFlight: 32 << 20, blobGcGraceMs: 7 * 86_400_000, phase: () => "live", session: () => session(), vaultSeq: () => 5 as Seq, linkGen: () => 1,
		...o.live,
	};
	return {
		carrier: "worker", clientVersion: "test",
		platform: { os: "ios", isMobile: true, isTablet: false, hardwareConcurrency: 6, deviceMemoryGiB: null, workerSupported: true },
		deviceClass: "phone", suite: 0, startup: { readyAtMs: 812, runtimeStartMs: 240, repoOpenMs: 31 }, env: () => ENV,
		clock, random: createWebRandom(), hash, live, ...o.over,
	};
}

const byId = (r: DeviceCheckReport) => new Map(r.steps.map((s) => [s.id, s]));

test("quick check, suite 0: every step passes (seal skipped), with times, rates and the transfer events counted", async () => {
	const store = new FakeStore();
	const r = await runDeviceCheck("quick", deps({ store }));
	assert.equal(r.mode, "quick");
	assert.deepEqual(r.steps.map((s) => s.id), ["engine", "sha256-1mb", "sha256-10mb", "seal-10mb", "relay-socket", "relay-http", "blob-1mb", "blob-10mb", "limits"]);
	const s = byId(r);
	for (const [id, step] of s) assert.equal(step.status, id === "seal-10mb" ? "skip" : "pass", `${id}: ${step.detail}`);
	assert.match(s.get("engine")!.detail, /background worker; ready 812 ms after the worker started; vault runtime start 240 ms; IndexedDB open 31 ms; ios phone/);
	assert.equal(s.get("sha256-10mb")!.data.bytes, 10_000_000);
	assert.equal(s.get("relay-socket")!.data.headSeq, 7);
	assert.equal(s.get("relay-http")!.data.afterSeq, 5);
	assert.deepEqual(store.puts, [...DEVICE_CHECK_QUICK_BYTES], "one PUT per size, the plaintext under suite 0");
	const big = s.get("blob-10mb")!.data;
	assert.equal(big.uploadProgressEvents, 4);
	assert.equal(big.uploadProgressBytes, 10_000_000);
	assert.equal(big.downloadChunks, 10);
	assert.equal(big.downloadBytes, 10_000_000);
	assert.equal(big.linkLost, false);
	for (const k of ["hashMs", "existsMs", "sealMs", "uploadMs", "downloadMs", "openMs", "verifyMs"]) assert.equal(typeof big[k], "number", k);
	assert.match(s.get("limits")!.detail, /attachments up to 2 MB .*device memory 4 GiB; JS heap 50 MiB used of 2048 MiB/);
	assert.equal(r.notes.length, 1);
	assert.match(r.notes[0]!, /1 MB, 10 MB.*Clean up unused server attachments.*7 day/);
});

test("an upload with no progress event fails its step (the idle window would cut a longer one); the rest still pass", async () => {
	const r = await runDeviceCheck("quick", deps({ store: new FakeStore(20_000_000, { progress: false }) }));
	const s = byId(r);
	for (const id of ["blob-1mb", "blob-10mb"]) {
		assert.equal(s.get(id)!.status, "fail");
		assert.match(s.get(id)!.detail, /no progress event.*60 s idle window/);
		assert.equal(s.get(id)!.data.uploadProgressEvents, 0);
	}
	assert.equal(s.get("relay-http")!.status, "pass");
	assert.equal(s.get("limits")!.status, "pass");
});

test("the relay link lost mid-transfer fails the step with the transfer's error and says so", async () => {
	let gen = 1;
	const store = new FakeStore(20_000_000, { failPut: () => { gen++; return new Error("relay blobs/put failed: network aborted"); } });
	const r = await runDeviceCheck("quick", deps({ store, live: { linkGen: () => gen } }));
	const s = byId(r).get("blob-1mb")!;
	assert.equal(s.status, "fail");
	assert.equal(s.error, "relay blobs/put failed: network aborted");
	assert.match(s.detail, /network aborted \(the relay link was lost during the transfer\)/);
	assert.equal(s.data.linkLost, true);
});

test("suite 1: seal and open 10 MB through the CryptoPort, and the blob round trip seals with it", async () => {
	const random = createWebRandom();
	const c = await createWebCryptoSuite1({ vaultId: "AAAAAAAAAAAAAAAAAAAAAA", random, keys: [{ e: 1, k: random.bytes(32) }] });
	c.markVerified(1);
	c.setSealEpoch(1);
	const store = new FakeStore();
	const r = await runDeviceCheck("quick", deps({ store, live: { crypto: c }, over: { suite: 1 } }));
	const s = byId(r);
	for (const [id, step] of s) assert.equal(step.status, "pass", `${id}: ${step.detail}`);
	assert.ok((s.get("seal-10mb")!.data.sealedBytes as number) > 10_000_000);
	assert.ok(store.puts.every((n, i) => n > DEVICE_CHECK_QUICK_BYTES[i]!), "sealed (padded) bodies were stored");
});

test("no vault runtime: the steps that need it fail with the reason; engine and hashing still run", async () => {
	const why = "the vault runtime is not running yet";
	const r = await runDeviceCheck("quick", deps({ live: why, over: { suite: 1 } }));
	const s = byId(r);
	for (const id of ["engine", "sha256-1mb", "sha256-10mb"]) assert.equal(s.get(id)!.status, "pass", id);
	for (const id of ["seal-10mb", "relay-socket", "relay-http", "blob-1mb", "blob-10mb", "limits"]) {
		assert.equal(s.get(id)!.status, "fail", id);
		assert.ok(s.get(id)!.detail.startsWith(why), id);
	}
	assert.equal(r.notes.length, 0, "no test blob was stored");
});

test("engine basics fails off the worker carrier and when the engine's scope lacks an API", async () => {
	const inline = byId(await runDeviceCheck("large", deps({ over: { carrier: "inline" } }))).get("engine")!;
	assert.equal(inline.status, "fail");
	assert.match(inline.detail, /inline carrier, not the worker/);
	const env: DeviceEnv = { ...ENV, apis: { ...ENV.apis, xmlHttpRequest: false } };
	const noXhr = byId(await runDeviceCheck("large", deps({ over: { env: () => env } }))).get("engine")!;
	assert.equal(noXhr.status, "fail");
	assert.match(noXhr.detail, /missing in the engine's scope: XMLHttpRequest/);
	const unprobed = byId(await runDeviceCheck("large", deps({ over: { env: () => null, startup: { readyAtMs: null, runtimeStartMs: null, repoOpenMs: null } } })));
	assert.equal(unprobed.get("engine")!.status, "pass");
	assert.match(unprobed.get("engine")!.detail, /ready time not recorded; no vault runtime start recorded; IndexedDB open time not recorded/);
	assert.match(unprobed.get("limits")!.detail, /device memory not exposed; performance.memory not exposed/);
});

test("relay socket: not connected, no ping, and a pong that never comes all fail the step", async () => {
	const off = byId(await runDeviceCheck("quick", deps({ live: { session: () => null, phase: () => "offline" } })));
	assert.equal(off.get("relay-socket")!.detail, "not connected (phase offline)");
	assert.equal(off.get("relay-http")!.status, "fail");
	const noPing = byId(await runDeviceCheck("quick", deps({ live: { session: () => session({ ping: null }) } })));
	assert.equal(noPing.get("relay-socket")!.detail, "this relay session cannot ping");
	// The ping's deadline on a clock whose long timers fire at once.
	const clock = createWebClock();
	const fast = { ...clock, setTimer: (ms: number, fn: () => void) => clock.setTimer(ms >= 15_000 ? 0 : ms, fn) };
	const silent = byId(await runDeviceCheck("quick", deps({ live: { session: () => session({ ping: () => new Promise(() => undefined) }) }, over: { clock: fast } })));
	assert.equal(silent.get("relay-socket")!.status, "fail");
	assert.equal(silent.get("relay-socket")!.detail, "no pong within 15 s");
});

test("large check: one round trip at the blob queue's maxBlobBytes; skipped without a blob store", async () => {
	const store = new FakeStore();
	const r = await runDeviceCheck("large", deps({ store, live: { maxBlobBytes: 3_500_000 } }));
	assert.deepEqual(r.steps.map((s) => s.id), ["engine", "blob-max", "limits"]);
	const blob = byId(r).get("blob-max")!;
	assert.equal(blob.status, "pass", blob.detail);
	assert.equal(blob.name, "Blob round trip at the max size (3.5 MB)");
	assert.deepEqual(store.puts, [3_500_000]);
	const none = byId(await runDeviceCheck("large", deps({ store: null }))).get("blob-max")!;
	assert.equal(none.status, "skip");
	assert.equal(none.detail, "the relay has no blob store: attachments do not sync");
});

test("deviceCheck over the protocol: the engine answers with a report; a second request while one runs is refused", async () => {
	const clock = new VirtualClock();
	clock.onError = (e) => { throw e; };
	const net = new SimNet(clock);
	const store = new FakeStore();
	const a = new SimDevice({ name: "A", clock, net, blob: () => store });
	void a.start();
	await clock.advance(5_000);
	assert.equal(a.ui.statuses.at(-1)?.phase, "live");
	const first = a.runtime.engine.request({ t: "deviceCheck", mode: "quick" }, 600_000);
	const second = a.runtime.engine.request({ t: "deviceCheck", mode: "quick" }, 600_000).then(() => null, (e: unknown) => e);
	let answer: Awaited<typeof first> | null = null;
	void first.then((v) => { answer = v; });
	for (let i = 0; i < 200 && answer === null; i++) await clock.advance(100);
	const refused = await second;
	assert.ok(refused instanceof HostRequestError, String(refused));
	assert.equal(refused.error.code, "bad-request");
	assert.equal(refused.error.message, "a device check is already running");
	assert.ok(answer !== null, "answered");
	const value = answer as Awaited<typeof first>;
	assert.equal(value.t, "deviceCheck");
	if (value.t !== "deviceCheck") return;
	const s = byId(value.report);
	assert.equal(s.get("engine")!.status, "pass", s.get("engine")!.detail);
	assert.equal(s.get("relay-socket")!.detail, "this relay session cannot ping", "the sim relay has no ping");
	assert.equal(s.get("relay-http")!.status, "pass", s.get("relay-http")!.detail);
	assert.equal(s.get("blob-10mb")!.status, "pass", s.get("blob-10mb")!.detail);
	assert.ok((s.get("engine")!.data.repoOpenMs as number) >= 0);
	assert.equal(typeof s.get("engine")!.data.runtimeStartMs, "number");
	assert.ok(store.puts.length === 2 && [...store.objects.keys()].length === 2, "the test blobs went to the runtime's store");
});
