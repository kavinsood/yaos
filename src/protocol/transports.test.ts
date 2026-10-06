import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import type { DocId, DeviceId, VaultId } from "../core/types";
import type { EngineToMain, MainToEngine } from "./messages";
import type { EngineTransport, HostTransport } from "./transport";
import { createInlinePair } from "./inlineTransport";
import {
	createWorkerEngineTransport,
	createWorkerHostTransport,
	owned,
	postOwned,
	transferablesOf,
	TransferOwnershipError,
	type WorkerLike,
	type WorkerScopeLike,
} from "./workerTransport";

// ---------------------------------------------------------------------------
// Carriers under test
// ---------------------------------------------------------------------------

interface Carrier {
	readonly name: string;
	readonly host: HostTransport;
	readonly engine: EngineTransport;
	/** Make the engine side "crash" (worker error / inline kill). */
	crash(): void;
	dispose(): void;
}

function inlineCarrier(): Carrier {
	const pair = createInlinePair();
	return { name: "inline", host: pair.host, engine: pair.engine, crash: () => pair.kill("killed"), dispose: () => pair.host.close() };
}

/** A Worker simulated by a MessageChannel: real structured clone + transfer semantics. */
function channelWorkerCarrier(): Carrier {
	const ch = new MessageChannel();
	const errorListeners: ((ev: unknown) => void)[] = [];
	const worker: WorkerLike = {
		postMessage: (m, t) => ch.port1.postMessage(m, t),
		addEventListener: ((type: string, l: (ev: never) => void) => {
			if (type === "error") errorListeners.push(l as (ev: unknown) => void);
			else ch.port1.addEventListener(type as "message", l as never);
		}) as WorkerLike["addEventListener"],
		terminate: () => ch.port1.close(),
	};
	const scope: WorkerScopeLike = {
		postMessage: (m, t) => ch.port2.postMessage(m, t),
		addEventListener: ((type: string, l: (ev: never) => void) => ch.port2.addEventListener(type as "message", l as never)) as WorkerScopeLike["addEventListener"],
		close: () => ch.port2.close(),
	};
	ch.port1.start();
	ch.port2.start();
	const host = createWorkerHostTransport(worker);
	const engine = createWorkerEngineTransport(scope);
	return {
		name: "worker(MessageChannel)",
		host,
		engine,
		crash: () => {
			for (const l of errorListeners) l({ type: "error", message: "boom" });
		},
		dispose: () => {
			host.close();
			ch.port2.close();
		},
	};
}

const CARRIERS: readonly (() => Carrier)[] = [inlineCarrier, channelWorkerCarrier];
const CARRIER_NAMES = ["inline", "worker(MessageChannel)"];

// ---------------------------------------------------------------------------
// A recorded trace covering every message shape with [T] fields
// ---------------------------------------------------------------------------

const D1 = "doc-1" as DocId;
const bytes = (...xs: number[]) => new Uint8Array(xs);

function mainTrace(): MainToEngine[] {
	return [
		{
			t: "init",
			rid: 1,
			config: {
				protocolVersion: 1,
				vaultId: "v" as VaultId,
				deviceId: "d" as DeviceId,
				deviceLabel: "Mac",
				deviceClass: "desktop",
				platform: { os: "macos", isMobile: false, isTablet: false, hardwareConcurrency: 8, deviceMemoryGiB: null, workerSupported: true },
				configDir: ".obsidian",
				caseInsensitiveFs: true,
				relay: { url: "https://relay.invalid", credential: "secret" },
				settings: {
					excludePatterns: ["tmp/**"],
					syncAttachments: true,
					maxAttachmentBytes: 1 << 20,
					syncSettings: false,
					trashMode: "obsidian-trash",
					provisionalBroadcast: true,
					snapshots: { enabled: false, keepDaily: 3, uploadToBlobStore: false },
				},
				sideState: { outboxMirror: [bytes(1, 2, 3), null], syncedMirror: [null, bytes(9)] },
			},
		},
		{ t: "ping", rid: 2 },
		{ t: "openDoc", rid: 3, path: "a.md", viewId: 7 },
		{ t: "textChunk", uploadId: 1, bytes: bytes(104, 0, 105, 0), last: true },
		{ t: "bodyAttach", docId: D1, viewId: 7, editor: 1, base: null, saved: 1 },
		{ t: "bodyPush", docId: D1, viewId: 7, seq: 1, base: 0, after: null, changes: [2, [0, " world"], [1]] },
		{ t: "bodyPush", docId: D1, viewId: 7, seq: 2, base: 0, after: 1, changes: [8, [0, "", "x"]] },
		{ t: "bodyReload", docId: D1, viewId: 7, reload: 1, text: 2 },
		{ t: "bodySaveMark", docId: D1, viewId: 7, version: 3, seq: null },
		{ t: "hashRequest", rid: 4, items: [{ path: "a.md", want: "fingerprint", bytes: bytes(1) }, { path: "b.md", want: "contentHash", bytes: bytes(2, 3) }] },
		{ t: "closeDoc", docId: D1, viewId: 7 },
		{ t: "vaultEvents", events: [{ t: "modify", path: "b.md", stat: { path: "b.md", size: 3, mtimeMs: 5, ctimeMs: 1 } }, { t: "rename", from: "x/a.md", to: "y/a.md", stat: null }] },
		{ t: "result", re: 1, value: { t: "reads", results: [{ path: "b.md", ok: true, stat: { path: "b.md", size: 3, mtimeMs: 5, ctimeMs: 1 }, bytes: bytes(97, 98, 99) }, { path: "c.md", ok: false, reason: "missing", stat: null }] } },
		{ t: "result", re: 2, value: { t: "sideFile", bytes: bytes(4, 4) } },
		{ t: "result", re: 3, value: { t: "sideFile", bytes: null } },
		{ t: "docCredit", bytes: 3 },
		{ t: "lifecycle", event: "pagehide" },
		{ t: "error", re: 4, error: { code: "timeout", message: "t", retryable: true } },
	];
}

function engineTrace(): EngineToMain[] {
	return [
		{ t: "result", re: 1, value: { t: "ready", protocolVersion: 1, vaultEpoch: "e1", recovered: false } },
		{ t: "result", re: 2, value: { t: "pong" } },
		{ t: "result", re: 3, value: { t: "bind", bind: { docId: D1, kind: "markdown", frozen: false } } },
		{ t: "body", docId: D1, weight: 40, event: { t: "bound", viewId: 7, attach: 1, version: 0, changes: [2], length: 2 } },
		{ t: "body", docId: D1, weight: 60, event: { t: "entry", from: 0, to: 1, changes: [2, [0, "!"]], length: 3, origin: "remote", author: null } },
		{ t: "body", docId: D1, weight: 60, event: { t: "entry", from: 1, to: 2, changes: [3, [0, " world"]], length: 9, origin: "editor", author: { viewId: 7, seq: 1 } } },
		{ t: "body", docId: D1, weight: 30, event: { t: "reject", viewId: 7, seq: 2, version: 2 } },
		{ t: "body", docId: D1, weight: 20, event: { t: "durable", version: 2 } },
		{ t: "body", docId: D1, weight: 30, event: { t: "reloaded", viewId: 7, reload: 1, save: true } },
		{ t: "result", re: 4, value: { t: "hashes", values: [{ hash: "ff", textLength: 1 }, { hash: "ee", textLength: 2 }] } },
		{ t: "readRequest", rid: 1, reads: [{ area: "vault", path: "b.md", maxBytes: 100 }] },
		{
			t: "diskOps",
			rid: 2,
			lane: 3,
			ops: [
				{ t: "write", opId: 1, area: "vault", path: "n.md", data: { t: "text", text: "x" }, precondition: { t: "absent" }, docId: null, purpose: "materialize" },
				{ t: "write", opId: 2, area: "vault", path: "img.png", data: { t: "bytes", bytes: bytes(137, 80) }, precondition: { t: "any" }, docId: null, purpose: "materialize" },
				{ t: "rename", opId: 3, from: "a.md", to: "b.md", precondition: { t: "any" }, docId: D1, purpose: "remote-move" },
			],
		},
		{ t: "sideFileWrite", rid: 3, name: "outbox-a.bin", bytes: bytes(8, 8, 8, 8) },
		{ t: "docRetarget", docId: D1, change: { t: "renamed", path: "z.md" } },
		{ t: "notice", level: "warn", code: "c", message: "m" },
	];
}

/** Buffers referenced by [T] fields (to check detachment after post). */
function tBuffers(m: MainToEngine | EngineToMain): Uint8Array[] {
	const out: Uint8Array[] = [];
	const visit = (v: unknown) => {
		if (v instanceof Uint8Array) out.push(v);
		else if (Array.isArray(v)) v.forEach(visit);
		else if (v && typeof v === "object") Object.values(v).forEach(visit);
	};
	visit(m);
	return out;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

async function runTrace(make: () => Carrier) {
	const c = make();
	const atEngine: MainToEngine[] = [];
	const atHost: EngineToMain[] = [];
	c.engine.onMessage((m) => atEngine.push(m));
	c.host.onMessage((m) => atHost.push(m));
	const detached: boolean[] = [];
	const mains = mainTrace();
	const engines = engineTrace();
	for (let i = 0; i < Math.max(mains.length, engines.length); i++) {
		const m = mains[i];
		if (m) {
			const bufs = tBuffers(m);
			const transferred = transferablesOf(m);
			postOwned(c.host, m);
			// Every [T] buffer was transferred: detached on the sender.
			for (const b of bufs) detached.push(b.byteLength === 0);
			assert.equal(transferred.length, bufs.length, `all buffers of ${m.t} are [T]`);
		}
		const e = engines[i];
		if (e) {
			const bufs = tBuffers(e);
			postOwned(c.engine, e);
			for (const b of bufs) detached.push(b.byteLength === 0);
		}
	}
	for (let i = 0; i < 20 && (atEngine.length < mains.length || atHost.length < engines.length); i++) await tick();
	c.dispose();
	return { atEngine, atHost, detached };
}

// ---------------------------------------------------------------------------

test("transferablesOf: lists every [T] buffer and rejects non-owned views", () => {
	const all = [...mainTrace(), ...engineTrace()];
	for (const m of all) assert.equal(transferablesOf(m).length, tBuffers(m).length, m.t);
	const big = new Uint8Array(16);
	const view = big.subarray(4, 8);
	assert.throws(() => transferablesOf({ t: "textChunk", uploadId: 1, bytes: view, last: true }), TransferOwnershipError);
	const fixed = owned(view);
	assert.notEqual(fixed.buffer, big.buffer);
	assert.equal(fixed.byteLength, 4);
	assert.equal(owned(big), big, "owned() keeps exclusively owned buffers");
	const shared = new Uint8Array(4);
	assert.throws(
		() => transferablesOf({ t: "hashRequest", rid: 1, items: [{ path: "a.md", want: "fingerprint", bytes: shared }, { path: "b.md", want: "fingerprint", bytes: shared }] }),
		TransferOwnershipError,
	);
});

test("worker and inline carriers deliver identical results on the recorded trace; [T] buffers are detached", async () => {
	const results = [];
	for (const make of CARRIERS) results.push(await runTrace(make));
	const [inline, worker] = results;
	assert.ok(inline && worker);
	assert.deepEqual(inline.atEngine, mainTrace(), "inline: engine got the trace");
	assert.deepEqual(inline.atHost, engineTrace(), "inline: host got the trace");
	assert.deepEqual(worker.atEngine, inline.atEngine, "parity main->engine");
	assert.deepEqual(worker.atHost, inline.atHost, "parity engine->main");
	assert.ok(inline.detached.length >= 8, `${inline.detached.length} buffers`);
	assert.ok(inline.detached.every(Boolean), "inline detaches transferred buffers");
	assert.ok(worker.detached.every(Boolean), "worker detaches transferred buffers");
	assert.deepEqual(inline.detached, worker.detached);
});

for (const [i, make] of CARRIERS.entries()) {
	const name = CARRIER_NAMES[i];
	test(`${name}: buffers until the first listener, FIFO, macrotask delivery`, async () => {
		const c = make();
		const got: number[] = [];
		for (let i = 1; i <= 3; i++) c.host.post({ t: "ping", rid: i });
		await tick();
		c.engine.onMessage((m) => {
			if (m.t === "ping") got.push(m.rid);
		});
		c.host.post({ t: "ping", rid: 4 });
		await tick();
		await tick();
		assert.deepEqual(got, [1, 2, 3, 4]);
		// Delivery is never synchronous and never before queued microtasks.
		const order: string[] = [];
		c.engine.onMessage(() => order.push("delivered"));
		c.host.post({ t: "ping", rid: 5 });
		order.push("sync");
		void Promise.resolve().then(() => order.push("microtask"));
		await tick();
		assert.deepEqual(order.slice(0, 3), ["sync", "microtask", "delivered"]);
		c.dispose();
	});

	test(`${name}: crash fires onFailure once; posts after close are dropped`, async () => {
		const c = make();
		const reasons: string[] = [];
		c.host.onFailure((r) => reasons.push(r));
		const got: unknown[] = [];
		c.engine.onMessage((m) => got.push(m));
		c.crash();
		c.crash();
		await tick();
		assert.equal(reasons.length, 1);
		c.host.post({ t: "ping", rid: 1 });
		await tick();
		assert.equal(got.length, 0);
		c.dispose();
	});
}

test("worker_threads: a real thread round-trips through the worker carrier with transfers", async () => {
	// The engine side runs the real createWorkerEngineTransport inside a thread
	// (parentPort is a MessagePort); the host side is the real host transport.
	const src = `
		const { parentPort } = require("node:worker_threads");
		const scope = {
			postMessage: (m, t) => parentPort.postMessage(m, t),
			addEventListener: (type, l) => parentPort.on(type, (data) => l({ data })),
			close: () => parentPort.close(),
		};
		const { createJiti } = require("jiti");
		const load = createJiti(${JSON.stringify(new URL("./workerTransport.ts", import.meta.url).pathname)});
		const { createWorkerEngineTransport, postOwned } = load(${JSON.stringify(new URL("./workerTransport.ts", import.meta.url).pathname)});
		const t = createWorkerEngineTransport(scope);
		t.onMessage((m) => {
			if (m.t === "textChunk") postOwned(t, { t: "result", re: m.uploadId, value: { t: "reads", results: [{ path: "a.md", ok: true, stat: null, bytes: m.bytes }] } });
			if (m.t === "ping") t.post({ t: "result", re: m.rid, value: { t: "pong" } });
		});
	`;
	const w = new Worker(src, { eval: true });
	const shim: WorkerLike = {
		postMessage: (m, t) => w.postMessage(m, t as never),
		addEventListener: ((type: string, l: (ev: unknown) => void) => {
			if (type === "message") w.on("message", (data) => l({ data }));
			else w.on("error", (e) => l(e));
		}) as WorkerLike["addEventListener"],
		terminate: () => void w.terminate(),
	};
	const host = createWorkerHostTransport(shim);
	const got: EngineToMain[] = [];
	host.onMessage((m) => got.push(m));
	const update = bytes(1, 2, 3, 4);
	postOwned(host, { t: "textChunk", uploadId: 8, bytes: update, last: true });
	assert.equal(update.byteLength, 0, "transferred to the thread");
	host.post({ t: "ping", rid: 9 });
	for (let i = 0; i < 400 && got.length < 2; i++) await tick();
	host.close();
	assert.deepEqual(got, [
		{ t: "result", re: 8, value: { t: "reads", results: [{ path: "a.md", ok: true, stat: null, bytes: bytes(1, 2, 3, 4) }] } },
		{ t: "result", re: 9, value: { t: "pong" } },
	]);
});
