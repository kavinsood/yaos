import { test } from "node:test";
import assert from "node:assert/strict";
import { indexedDB as fakeIndexedDB, IDBFactory as FakeFactory, IDBObjectStore as FakeObjectStore, IDBOpenDBRequest as FakeOpenRequest } from "fake-indexeddb";
import { BENCH_SIZES, fromHex, runCryptoProbe, toHex, type CryptoProbeEnv } from "./cryptoProbe";
import { computeE2eeVerdict, computeVerdicts, type SpikeReport } from "./report";
import { installSpikeWorker } from "./spikeWorkerHandler";
import { runWorkerProbe, type WorkerLike } from "./workerProbe";

const realSubtle = globalThis.crypto.subtle;
const grv = (a: Uint8Array): Uint8Array => globalThis.crypto.getRandomValues(a);
const FAST = { benchMs: 15, benchMaxIters: 20, sizes: [1024, 65536] };

function env(over: Partial<CryptoProbeEnv> = {}): CryptoProbeEnv {
	return { subtle: realSubtle, getRandomValues: grv, getIndexedDB: () => fakeIndexedDB, ...over };
}

/** A SubtleCrypto that overrides some methods: models a broken or permissive implementation. */
function patchedSubtle(over: Partial<Record<keyof SubtleCrypto, (...args: never[]) => unknown>>): SubtleCrypto {
	return new Proxy(realSubtle, {
		get(target, prop) {
			const o = (over as Record<PropertyKey, unknown>)[prop];
			if (o) return o;
			const v: unknown = Reflect.get(target, prop);
			return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
		},
	});
}

class HangingFactory extends FakeFactory {
	override open(): IDBOpenDBRequest {
		return new FakeOpenRequest();
	}
	override deleteDatabase(): IDBOpenDBRequest {
		return new FakeOpenRequest();
	}
}

test("hex helpers round-trip", () => {
	assert.equal(toHex(fromHex("00ff10a5")), "00ff10a5");
	assert.deepEqual([...fromHex("0b0b")], [11, 11]);
});

test("runCryptoProbe: Node WebCrypto + fake-indexeddb passes every check with the published known answers", async () => {
	const r = await runCryptoProbe(env(), { where: "worker", ...FAST });
	assert.equal(r.ok, true, JSON.stringify(r, null, 1));
	assert.deepEqual(r.random.value, { distinct: true, nonZero: true, max65536Ok: true, over65536: "QuotaExceededError" });
	assert.deepEqual(r.importNonExtractable.value, { extractable: false, type: "secret", exportRaw: "InvalidAccessError", exportJwk: "InvalidAccessError", hkdfExtractableTrue: "SyntaxError" });
	assert.deepEqual(r.hkdf.value, { rfc5869A1: true, derivedAesExtractable: false, derivedHmacExtractable: false, derivedHmacTagBytes: 32 });
	assert.deepEqual(r.hmac.value, { rfc4231Tc2: true, verifyGood: true, verifyFlipped: false });
	assert.deepEqual(r.aesGcm.value, {
		gcmTc16Encrypt: true,
		gcmTc16Decrypt: true,
		overheadBytes: 16,
		roundTrip: true,
		tamperCiphertext: "OperationError",
		tamperTag: "OperationError",
		wrongAad: "OperationError",
		wrongNonce: "OperationError",
	});
	assert.deepEqual(r.idbKey.value, {
		keySource: "hkdf-derived",
		storedType: "[object CryptoKey]",
		isCryptoKey: true,
		extractable: false,
		algorithm: "AES-GCM",
		usages: ["decrypt", "encrypt"],
		opensOldCiphertext: true,
		sealsForOriginal: true,
		exportRaw: "InvalidAccessError",
	});
	assert.equal(r.idbKey.deleteDatabase?.ok, true);
	assert.deepEqual(
		r.bench.rows.map((x) => x.bytes),
		[1024, 65536],
	);
	for (const row of r.bench.rows) {
		assert.ok(row.iters >= 3 && row.iters <= 20, `iters ${row.iters}`);
		assert.ok(row.sealMeanMs >= 0 && row.openMeanMs >= 0);
	}
	assert.deepEqual(BENCH_SIZES, [1024, 65536, 1048576]);
});

test("runCryptoProbe: no crypto.subtle -> every subtle step skipped, getRandomValues still measured", async () => {
	const r = await runCryptoProbe(env({ subtle: undefined }), { where: "main", ...FAST });
	assert.equal(r.ok, false);
	assert.equal(r.typeofSubtle, "undefined");
	assert.equal(r.random.ok, true);
	for (const s of [r.importNonExtractable, r.hkdf, r.hmac, r.aesGcm, r.idbKey]) assert.equal(s.skipped, true);
	assert.equal(r.bench.skipped, true);
});

test("runCryptoProbe: a decrypt that accepts forged ciphertext is reported as a FAILED check, not a pass", async () => {
	const lax = patchedSubtle({
		decrypt: (async (alg: AesGcmParams, key: CryptoKey, data: BufferSource) => {
			try {
				return await realSubtle.decrypt(alg, key, data);
			} catch {
				return new ArrayBuffer(0);
			}
		}) as never,
	});
	const r = await runCryptoProbe(env({ subtle: lax }), { where: "worker", ...FAST });
	assert.equal(r.aesGcm.ok, false);
	const v = r.aesGcm.value as Record<string, unknown>;
	assert.equal(v.tamperTag, "accepted");
	assert.equal(v.wrongAad, "accepted");
	assert.equal(r.ok, false);
});

test("runCryptoProbe: an exportable 'non-extractable' key fails importNonExtractable", async () => {
	const leaky = patchedSubtle({ exportKey: (async () => new ArrayBuffer(32)) as never });
	const r = await runCryptoProbe(env({ subtle: leaky }), { where: "worker", ...FAST });
	assert.equal(r.importNonExtractable.ok, false);
	assert.equal((r.importNonExtractable.value as Record<string, unknown>).exportRaw, "accepted");
	assert.equal(r.idbKey.ok, false, "the IDB step also re-checks exportKey on the read-back key");
});

test("runCryptoProbe: an IDB that stores the key as a plain object fails the IDB step", async () => {
	// Models a WebView whose structured clone does not keep CryptoKey: the stored value comes back as {}.
	const proto = FakeObjectStore.prototype;
	const origPut = proto.put;
	proto.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
		return origPut.call(this, { ...(value as object), key: {} }, key);
	} as typeof proto.put;
	try {
		const r = await runCryptoProbe(env(), { where: "worker", ...FAST });
		assert.equal(r.idbKey.ok, false);
		assert.equal((r.idbKey.value as Record<string, unknown>).storedType, "[object Object]");
		assert.equal(r.aesGcm.ok, true);
		assert.equal(r.ok, false);
	} finally {
		proto.put = origPut;
	}
});

test("runCryptoProbe: hanging and throwing IndexedDB are reported as data", async () => {
	const hang = await runCryptoProbe(env({ getIndexedDB: () => new HangingFactory() }), { where: "worker", stepTimeoutMs: 40, ...FAST });
	assert.equal(hang.idbKey.hang, true);
	assert.equal(hang.idbKey.deleteDatabase?.hang, true);
	assert.equal(hang.aesGcm.ok, true);
	assert.equal(hang.bench.ok, true);
	const threw = await runCryptoProbe(
		env({
			getIndexedDB: () => {
				throw Object.assign(new Error("denied"), { name: "SecurityError" });
			},
		}),
		{ where: "worker", ...FAST },
	);
	assert.equal(threw.idbKey.skipped, true);
	assert.deepEqual(threw.idbKey.error, { name: "SecurityError", message: "denied" });
});

function channelWorker(): WorkerLike {
	const ch = new MessageChannel();
	installSpikeWorker(
		{
			postMessage: (m, t) => ch.port2.postMessage(m, t),
			addEventListener: (type, l) => {
				if (type === "message" || type === "messageerror") ch.port2.addEventListener(type, l as never);
			},
		},
		{ getIndexedDB: () => fakeIndexedDB, subtle: realSubtle, getRandomValues: grv, typeofWebSocket: "function", typeofStructuredClone: "function", typeofFetch: "function" },
	);
	return {
		postMessage: (m, t) => ch.port1.postMessage(m, t),
		addEventListener: (type, l) => {
			if (type !== "error") ch.port1.addEventListener(type as "message", l as never);
		},
		terminate: () => {
			ch.port1.close();
			ch.port2.close();
		},
	};
}

test("runWorkerProbe: crypto-only steps run the probe in the worker and skip the OR-1 steps", async () => {
	const r = await runWorkerProbe({
		source: "x",
		makeUrl: () => "blob:e2ee",
		makeWorker: () => channelWorker(),
		revokeUrl: () => undefined,
		timeouts: { pings: 0 },
		steps: { idb: false, transfer: false, crypto: true },
		cryptoOpts: FAST,
	});
	assert.equal(r.ok, true);
	assert.equal(r.probe.received, false);
	assert.equal(r.transfer.attempted, false);
	assert.equal(r.crypto?.received, true);
	assert.equal(r.crypto?.report?.where, "worker");
	assert.equal(r.crypto?.report?.ok, true, JSON.stringify(r.crypto, null, 1));
	assert.equal(r.crypto?.report?.bench.rows.length, 2);
});

test("runWorkerProbe: OR-1 default steps do not run the crypto probe", async () => {
	const r = await runWorkerProbe({ source: "x", makeUrl: () => "blob:or1", makeWorker: () => channelWorker(), revokeUrl: () => undefined, timeouts: { pings: 1, transferBytes: 1024 } });
	assert.equal(r.ok, true);
	assert.equal(r.probe.received, true);
	assert.equal(r.transfer.intact, true);
	assert.equal(r.crypto, undefined);
});

test("computeE2eeVerdict / computeVerdicts: OK, failed and missing lines", async () => {
	const good = await runCryptoProbe(env(), { where: "main", ...FAST });
	const bad = { ...good, ok: false, aesGcm: { ...good.aesGcm, ok: false, value: { tamperTag: "accepted" } } };
	const v = computeE2eeVerdict({ worker: null, main: good });
	assert.equal(v.mainCryptoOk, true);
	assert.equal(v.workerCryptoOk, false);
	assert.match(v.lines[0] ?? "", /^E2EE worker: NOT MEASURED \(no worker run\)$/);
	assert.ok(v.lines.some((l) => /^E2EE main thread: OK /.test(l)));
	assert.ok(v.lines.some((l) => l.startsWith("E2EE main thread IDB key: stored as [object CryptoKey], extractable false")));
	assert.ok(v.lines.some((l) => /^E2EE main thread AES-256-GCM: 1 KiB seal .* 64 KiB seal /.test(l)));
	const f = computeE2eeVerdict({ worker: null, main: bad });
	assert.ok(f.lines.some((l) => l.includes('FAILED') && l.includes('aesGcm check failed {"tamperTag":"accepted"}')));
	const report: SpikeReport = { spike: { id: "s", version: "0", build: "t", startedAt: "", ran: ["e2ee"] }, env: {}, e2ee: { worker: null, main: good } };
	const all = computeVerdicts(report);
	assert.equal(all.e2ee?.mainCryptoOk, true);
	assert.ok(all.lines.some((l) => l.startsWith("E2EE main thread: OK")));
	assert.equal(all.or1, undefined);
});
