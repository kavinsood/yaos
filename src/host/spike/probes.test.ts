import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { indexedDB as fakeIndexedDB, IDBFactory as FakeFactory, IDBOpenDBRequest as FakeOpenRequest } from "fake-indexeddb";
import { runIdbProbe } from "./idbProbe";
import { installSpikeWorker, type SpikeWorkerEnv } from "./spikeWorkerHandler";
import { runWorkerProbe, type WorkerLike } from "./workerProbe";

/** An IDBFactory whose requests never fire: models a WebView where IndexedDB hangs. */
class HangingFactory extends FakeFactory {
	override open(): IDBOpenDBRequest {
		return new FakeOpenRequest();
	}
	override deleteDatabase(): IDBOpenDBRequest {
		return new FakeOpenRequest();
	}
}

test("runIdbProbe: open/put/get/close/delete against fake-indexeddb", async () => {
	const r = await runIdbProbe(() => fakeIndexedDB, { where: "main", timeoutMs: 2000 });
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.equal(r.typeofIndexedDB, "object");
	assert.equal(r.open.upgradeFired, true);
	assert.equal(r.equal, true);
	assert.equal(r.close.ok, true);
	assert.equal(r.deleteDatabase.ok, true);
	assert.match(r.dbName, /^yaos-spike-probe-/);
});

test("runIdbProbe: missing, throwing and hanging factories are reported as data", async () => {
	const missing = await runIdbProbe(() => undefined, { where: "worker" });
	assert.equal(missing.ok, false);
	assert.equal(missing.typeofIndexedDB, "undefined");
	assert.equal(missing.open.skipped, true);

	const throwing = await runIdbProbe(
		() => {
			throw Object.assign(new Error("denied"), { name: "SecurityError" });
		},
		{ where: "worker" },
	);
	assert.equal(throwing.typeofIndexedDB, "threw");
	assert.deepEqual(throwing.accessError, { name: "SecurityError", message: "denied" });

	const hanging = await runIdbProbe(() => new HangingFactory(), { where: "worker", timeoutMs: 40 });
	assert.equal(hanging.ok, false);
	assert.equal(hanging.open.hang, true);
	assert.equal(hanging.put.skipped, true);
	assert.equal(hanging.deleteDatabase.hang, true);
});

function env(over: Partial<SpikeWorkerEnv> = {}): SpikeWorkerEnv {
	return {
		getIndexedDB: () => fakeIndexedDB,
		subtle: globalThis.crypto.subtle,
		typeofWebSocket: typeof WebSocket,
		typeofStructuredClone: typeof structuredClone,
		typeofFetch: typeof fetch,
		storage: { persisted: () => Promise.resolve(false) },
		userAgent: "node-test",
		hardwareConcurrency: 4,
		location: "blob:test",
		...over,
	};
}

/** A "worker" whose body runs in-process behind a MessageChannel: real structured clone + transfer semantics. */
function channelWorker(workerEnv: SpikeWorkerEnv, opts: { silent?: boolean } = {}): { worker: WorkerLike; terminated: () => boolean } {
	const ch = new MessageChannel();
	let terminated = false;
	if (!opts.silent) {
		installSpikeWorker(
			{
				postMessage: (m, t) => ch.port2.postMessage(m, t),
				addEventListener: (type, l) => {
					if (type === "message" || type === "messageerror") ch.port2.addEventListener(type, l as never);
				},
			},
			workerEnv,
		);
	} else {
		ch.port2.addEventListener("message", () => undefined);
	}
	const errorListeners: ((ev: Event) => void)[] = [];
	const worker: WorkerLike = {
		postMessage: (m, t) => ch.port1.postMessage(m, t),
		addEventListener: (type, l) => {
			if (type === "error") errorListeners.push(l);
			else ch.port1.addEventListener(type as "message", l as never);
		},
		terminate: () => {
			terminated = true;
			ch.port1.close();
			ch.port2.close();
		},
	};
	return { worker, terminated: () => terminated };
}

test("runWorkerProbe: worker + IDB + transfer over a MessageChannel worker", async () => {
	const revoked: string[] = [];
	const cw = channelWorker(env());
	const r = await runWorkerProbe({
		source: "/* worker source */",
		makeUrl: () => "blob:fake/1",
		makeWorker: () => cw.worker,
		revokeUrl: (u) => revoked.push(u),
		timeouts: { pings: 3, transferBytes: 4096 },
	});
	assert.equal(r.ok, true, JSON.stringify(r, null, 1));
	assert.equal(r.boot.received, true);
	assert.equal(r.firstPong.received, true);
	assert.equal(r.pingRttsMs.length, 3);
	assert.equal(r.probe.received, true);
	const self = r.probe.report;
	assert.ok(self);
	assert.equal(self.idb.ok, true);
	assert.equal(self.idb.where, "worker");
	assert.equal(self.cryptoSubtle.digest.ok, true);
	assert.equal(self.cryptoSubtle.digest.value, createHash("sha256").update("yaos").digest("hex"));
	assert.deepEqual(self.storagePersisted, { present: true, result: { ok: true, ms: self.storagePersisted.result?.ms ?? 0, value: false } });
	assert.equal(r.transfer.detachedOnSend, true, "sender buffer detached by the transfer list");
	assert.equal(r.transfer.senderByteLengthAfterPost, 0);
	assert.equal(r.transfer.workerReceivedBytes, 4096);
	assert.equal(r.transfer.workerPatternOk, true);
	assert.equal(r.transfer.intact, true);
	assert.equal(r.transfer.workerByteLengthAfterPost, 0, "worker-side buffer detached on echo");
	assert.deepEqual(r.events, []);
	assert.equal(r.terminate.ok, true);
	assert.deepEqual(revoked, ["blob:fake/1"]);
	assert.equal(cw.terminated(), true);
});

test("runWorkerProbe: worker IDB failure still yields a worker-OK report", async () => {
	const cw = channelWorker(env({ getIndexedDB: () => undefined, subtle: undefined, storage: undefined }));
	const r = await runWorkerProbe({ source: "x", makeUrl: () => "blob:2", makeWorker: () => cw.worker, revokeUrl: () => undefined, timeouts: { pings: 1 } });
	assert.equal(r.ok, true);
	assert.equal(r.probe.report?.idb.ok, false);
	assert.equal(r.probe.report?.typeofIndexedDB, "undefined");
	assert.equal(r.probe.report?.cryptoSubtle.digest.skipped, true);
	assert.deepEqual(r.probe.report?.storagePersisted, { present: false });
});

test("runWorkerProbe: constructor throws -> construct error, URL revoked, no worker steps", async () => {
	const revoked: string[] = [];
	const r = await runWorkerProbe({
		source: "x",
		makeUrl: () => "blob:3",
		makeWorker: () => {
			throw Object.assign(new Error("Failed to construct 'Worker'"), { name: "SecurityError" });
		},
		revokeUrl: (u) => revoked.push(u),
	});
	assert.equal(r.ok, false);
	assert.deepEqual(r.construct.error, { name: "SecurityError", message: "Failed to construct 'Worker'" });
	assert.equal(r.firstPong.received, false);
	assert.deepEqual(revoked, ["blob:3"]);
});

test("runWorkerProbe: Blob URL creation fails -> stops before construction", async () => {
	let constructed = false;
	const r = await runWorkerProbe({
		source: "x",
		makeUrl: () => {
			throw new TypeError("createObjectURL is not a function");
		},
		makeWorker: () => {
			constructed = true;
			throw new Error("unreachable");
		},
		revokeUrl: () => undefined,
	});
	assert.equal(r.blobUrl.ok, false);
	assert.equal(r.construct.skipped, true);
	assert.equal(constructed, false);
});

test("runWorkerProbe: silent worker -> no pong within timeout, error events captured, terminated", async () => {
	const cw = channelWorker(env(), { silent: true });
	let errorListener: ((ev: Event) => void) | null = null;
	const worker: WorkerLike = {
		postMessage: (m, t) => cw.worker.postMessage(m, t),
		addEventListener: (type, l) => {
			if (type === "error") errorListener = l;
			else cw.worker.addEventListener(type, l);
		},
		terminate: () => cw.worker.terminate(),
	};
	setTimeout(() => {
		const fire: unknown = errorListener;
		if (typeof fire === "function") fire({ message: "Uncaught SyntaxError", filename: "blob:x", lineno: 1, colno: 2 });
	}, 10);
	const r = await runWorkerProbe({ source: "x", makeUrl: () => "blob:4", makeWorker: () => worker, revokeUrl: () => undefined, timeouts: { firstPongMs: 60, graceMs: 20 } });
	assert.equal(r.ok, false);
	assert.equal(r.construct.ok, true);
	assert.equal(r.firstPong.received, false);
	assert.equal(r.events[0]?.type, "error");
	assert.equal(r.events[0]?.message, "Uncaught SyntaxError");
	assert.equal(cw.terminated(), true);
});
