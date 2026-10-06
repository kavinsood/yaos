import { test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createWorkerHostTransport, type WorkerLike, type WorkerScopeLike } from "../protocol/workerTransport";
import type { EngineToMain, MainToEngine } from "../protocol/messages";
import { PROTOCOL_VERSION } from "../protocol/messages";
import { buildInitConfig } from "../host/runtimeSupport";
import { SimSideFiles } from "../sim/vault";
import { SIM_SETTINGS } from "../sim/device";
import type { DeviceId, VaultId } from "../core/types";
import { startWorkerEngine } from "./workerMain";

function channel(): { worker: WorkerLike; scope: WorkerScopeLike; close(): void } {
	const ch = new MessageChannel();
	const worker: WorkerLike = {
		postMessage: (m, t) => ch.port1.postMessage(m, t),
		addEventListener: ((type: string, l: (ev: never) => void) => {
			if (type !== "error") ch.port1.addEventListener(type as "message", l as never);
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
	return { worker, scope, close: () => { ch.port1.close(); ch.port2.close(); } };
}

test("worker entry answers ping before init, inits on IndexedDB and accepts observations over a real structured-clone channel", async (t) => {
	// The worker's IndexedDB (Node has none): a fresh fake-indexeddb factory.
	const g = globalThis as { indexedDB?: unknown; IDBKeyRange?: unknown };
	const saved = { indexedDB: g.indexedDB, IDBKeyRange: g.IDBKeyRange };
	g.indexedDB = new IDBFactory();
	g.IDBKeyRange = IDBKeyRange;
	t.after(() => {
		g.indexedDB = saved.indexedDB;
		g.IDBKeyRange = saved.IDBKeyRange;
	});
	const ch = channel();
	const engine = startWorkerEngine(ch.scope);
	const host = createWorkerHostTransport(ch.worker);
	const inbox: EngineToMain[] = [];
	const waiters: (() => void)[] = [];
	host.onMessage((m) => {
		inbox.push(m);
		for (const w of waiters.splice(0)) w();
	});
	const waitFor = async (pred: (m: EngineToMain) => boolean): Promise<EngineToMain> => {
		const deadline = Date.now() + 3_000;
		for (;;) {
			const hit = inbox.find(pred);
			if (hit) return hit;
			if (Date.now() > deadline) throw new Error(`timeout; got ${inbox.map((m) => m.t).join(",")}`);
			await new Promise<void>((r) => {
				waiters.push(r);
				setTimeout(r, 50);
			});
		}
	};
	t.after(() => {
		engine.dispose();
		host.close();
		ch.close();
	});
	const post = (m: MainToEngine) => host.post(m);
	post({ t: "ping", rid: 1 });
	const pong = await waitFor((m) => m.t === "result" && m.re === 1);
	assert.deepEqual(pong.t === "result" && pong.value, { t: "pong" });
	const config = await buildInitConfig({
		identity: { vaultId: "v" as VaultId, deviceId: "d" as DeviceId, deviceLabel: "test", relay: { url: "wss://x", credential: "c" }, crypto: { suite: 0 } },
		platform: { os: "linux", isMobile: false, isTablet: false, hardwareConcurrency: 4, deviceMemoryGiB: null, workerSupported: true },
		carrier: "worker", workerSupported: true, configDir: ".obsidian", caseInsensitiveFs: false, settings: SIM_SETTINGS, side: new SimSideFiles(),
	});
	post({ t: "init", rid: 2, config });
	const ready = await waitFor((m) => (m.t === "result" || m.t === "error") && m.re === 2);
	assert.equal(ready.t, "result", JSON.stringify(ready));
	assert.equal(ready.t === "result" && ready.value.t === "ready" && ready.value.protocolVersion, PROTOCOL_VERSION);
	post({ t: "observations", rid: 3, scanId: 1, complete: true, chunk: [{ stat: { path: "a.md", size: 2, mtimeMs: 1, ctimeMs: 1 } }] });
	// No relay here (wss://x is unreachable) and no known epoch: the disk side waits for the
	// first connect, so the observations are accepted but no read follows (the sim covers that).
	const obs = await waitFor((m) => (m.t === "result" || m.t === "error") && m.re === 3);
	assert.equal(obs.t, "result", JSON.stringify(obs));
	const status = await waitFor((m) => m.t === "status");
	assert.equal(status.t, "status");
});
