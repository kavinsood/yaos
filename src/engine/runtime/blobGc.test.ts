/**
 * Blob GC through the engine (e2ee-design §10.4): LogEngine.cleanUpBlobs on SimRelay + SimBlobStore. The live
 * set (ns tombstones, cfg blobs, snap parts, outbox, queued transfers, served body refs), every precondition as
 * zero deletes, and the races: R2 orphan reuse, R3 resume after more than the grace offline, R4 repair of the
 * store's check -> delete window.
 *
 * The store runs on its own clock (`storeNow`, the "server" clock); each device on the real clock plus an
 * offset (a device that slept, or a skewed one). Objects are planted at T0 and the store clock then moves past
 * the grace, so everything not live is a candidate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Writer } from "../../core/codec/lib0";
import { sha256Hex } from "../../core/hash/sha256";
import { MAX_INLINE_UPDATE_BYTES } from "../../core/limits";
import { decodeBodyUpdateRef } from "../../core/codec/contents";
import { snapshotId, SnapOpTag, type SnapRecord } from "../../core/snap/record";
import { KEYRING_STREAM, NS_STREAM, SNAP_STREAM, type ClientFrameId, type ContentHash, type DeviceId, type DocId, type NsOp, type StreamName, type VaultId, type VaultPath } from "../../core/types";
import type { ClockPort } from "../../ports/clock";
import type { BlobAddress, CryptoPort } from "../../ports/crypto";
import type { RelaySession } from "../../ports/relay";
import { SimBlobStore } from "../../sim/blobStore";
import { SeededRandom } from "../../sim/random";
import { SimRelay } from "../../sim/relay";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebClock } from "../adapters/webClock";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { createWebHash } from "../adapters/webHash";
import { putSealed } from "../blobs/blobStore";
import type { GcOutcome } from "../blobs/gc";
import { openEnvelope, sealFrame } from "../ingest/envelope";
import type { EngineE2ee } from "../keyring/keyringRuntime";
import { rawAppend } from "../keyring/testkit/engines";
import { VAULT as S1_VAULT, genesis } from "../keyring/testkit/world";
import type { LogEngine } from "./engine";
import { faultyCrypto, startTestEngine, testPorts, testStorage, until } from "./testHarness";

const GRACE = 60 * 60_000;
const A = "dev-a-0123456789abcdef";
const B = "dev-b-0123456789abcdef";
const VAULT = "vault-test";
const T0 = Date.UTC(2026, 9, 1);
const BUDGETS = { maxResidentBytes: 1024 * 1024 * 1024, maxResidentDocs: 64 };

const bytesOf = (i: number): Uint8Array => Uint8Array.from({ length: 48 }, (_, j) => (j === 0 ? i >> 8 : j === 1 ? i : i * 7 + j) & 0xff);
const H = (b: Uint8Array) => sha256Hex(b) as ContentHash;
let docN = 0;
const newDoc = () => `gcdoc${String(++docN).padStart(17, "0")}` as DocId;
const createBlob = (docId: DocId, hash: ContentHash): NsOp => ({ t: "create", docId, kind: "blob", path: `att/${docId}.png` as VaultPath, contentHash: hash, size: 48 });

class World {
	readonly relay = new SimRelay();
	storeNow = T0;
	readonly store = new SimBlobStore({ now: () => this.storeNow });
	/** Plaintext each device can read locally (its vault files). */
	readonly local = new Map<string, Map<ContentHash, Uint8Array>>();
	readonly engines: LogEngine[] = [];

	async device(deviceId: string, o: { crypto?: CryptoPort; e2ee?: EngineE2ee; offset?: { ms: number }; vaultId?: string; blob?: boolean } = {}): Promise<LogEngine> {
		const storage = testStorage();
		const base = createWebClock();
		const offset = o.offset ?? { ms: 0 };
		const clock: ClockPort = { ...base, now: () => base.now() + offset.ms };
		const local = new Map<ContentHash, Uint8Array>();
		this.local.set(deviceId, local);
		const crypto = o.crypto ?? createNoopCrypto(createWebHash());
		const { engine } = await startTestEngine({
			relay: this.relay, deviceId, vaultId: o.vaultId ?? VAULT, storage, crypto, e2ee: o.e2ee,
			tuning: { blobGcGraceMs: GRACE },
			extra: {
				budgets: BUDGETS,
				ports: { ...testPorts(this.relay, storage, crypto), clock, blob: o.blob === false ? null : this.store },
				blobBytes: async (h) => local.get(h) ?? null,
			},
		});
		this.engines.push(engine);
		await until(() => engine.status().phase === "live", 3_000, `${deviceId} live`);
		return engine;
	}

	private genesis: Uint8Array | null = null;

	/** Suite 1 as main hands it in (e2ee-design §18.4): K_1, and the genesis `k` holds (appended once per world). */
	async suite1(seed: number): Promise<{ crypto: CryptoPort; e2ee: EngineE2ee; vaultId: string }> {
		const k1 = new Uint8Array(32).fill(9);
		if (!this.genesis) {
			this.genesis = await genesis(undefined, k1);
			await rawAppend(this.relay, KEYRING_STREAM, this.genesis);
		}
		const s1 = await createWebCryptoSuite1({ vaultId: S1_VAULT, random: new SeededRandom(seed), keys: [{ e: 1, k: k1 }] });
		return { crypto: s1, e2ee: { suite: 1, records: [this.genesis], persist: async () => undefined }, vaultId: S1_VAULT };
	}

	/** An object as an upload at the current store time (suite 0: the stored bytes are the plaintext). */
	plant(i: number): { bytes: Uint8Array; hash: ContentHash; address: BlobAddress } {
		const bytes = bytesOf(i);
		const hash = H(bytes);
		this.store.objects.set(hash as string as BlobAddress, { bytes, uploadedAt: this.storeNow });
		return { bytes, hash, address: hash as string as BlobAddress };
	}

	has(address: string): boolean {
		return this.store.objects.has(address as BlobAddress);
	}

	async stop(): Promise<void> {
		for (const e of this.engines) await e.stop();
	}
}

async function idle(...es: LogEngine[]): Promise<void> {
	await until(() => es.every((e) => e.isIdle()), 8_000, "idle");
}

async function sweep(e: LogEngine, queued: Iterable<ContentHash> = []): Promise<GcOutcome> {
	return e.cleanUpBlobs(() => queued);
}

function snapRec(createdAtMs: number, parts: readonly ContentHash[]): SnapRecord {
	return {
		version: 1, snapshotId: snapshotId(createdAtMs, "manual"), createdAtMs, deviceLabel: "laptop", reason: "manual", format: 1,
		fileCount: 1, totalBytes: 48 * parts.length, bundleDigest: H(new Uint8Array([createdAtMs & 0xff])),
		parts: parts.map((h) => ({ address: h, size: 48, sha256: h })),
	};
}

/** A raw relay member that appends hand-built frames. */
async function rawDevice(relay: SimRelay, deviceId = "dev-raw-0123456789ab") {
	const r = await relay.connect({ vaultId: VAULT as VaultId, deviceId: deviceId as DeviceId });
	assert.ok(r.ok);
	const s: RelaySession = r.session;
	const noop = createNoopCrypto(createWebHash());
	let n = 0;
	return {
		async send(stream: StreamName, kind: "nsOps" | "snapOps", content: Uint8Array, payload?: Uint8Array): Promise<void> {
			const cf = `rawframe${String(n++).padStart(14, "0")}` as ClientFrameId;
			const sealed = await sealFrame(noop, VAULT as VaultId, { stream, deviceId: deviceId as DeviceId, clientFrameId: cf, kind, authorNsSeq: 0, flags: 0, frameNo: kind === "nsOps" ? 1 : 0, content });
			s.append({ stream, clientFrameId: cf, payload: payload ?? sealed.sealed });
		},
		close: () => s.close(1000, "done"),
	};
}

test("GC live set: ns entries and tombstones, cfg blobs, live snap parts, outbox frames, queued transfers and served body refs survive; the rest older than the grace goes", async () => {
	const w = new World();
	try {
		const a = await w.device(A);
		const b = await w.device(B);
		const liveBlob = w.plant(1);
		const tomb = w.plant(2);
		const cfgBlob = w.plant(3);
		const snapPart = w.plant(4);
		const deadPart = w.plant(5);
		const queued = w.plant(6);
		const outbox = w.plant(7);
		const garbage = [w.plant(8), w.plant(9), w.plant(10)];
		for (const x of [liveBlob, tomb, outbox]) w.local.get(A)!.set(x.hash, x.bytes);

		const dLive = newDoc();
		const dTomb = newDoc();
		await a.submitNs([createBlob(dLive, liveBlob.hash), createBlob(dTomb, tomb.hash)]);
		await idle(a);
		await a.submitNs([{ t: "delete", docId: dTomb, baseBodySeq: 0 }]);
		await b.submitCfg([{ t: "filePut", file: "themes/T/theme.css" as never, content: { t: "blob", hash: cfgBlob.hash, size: 48 }, pluginVersion: null }]);
		await b.submitSnap([{ t: "put", record: snapRec(T0, [snapPart.hash]) }, { t: "put", record: snapRec(T0 + 1000, [deadPart.hash]) }]);
		await idle(a, b);
		await b.submitSnap([{ t: "del", deviceId: B as DeviceId, snapshotId: snapRec(T0 + 1000, []).snapshotId }]);
		const doc = await a.createDoc("big.md", "seed;");
		await a.editDoc(doc, (t) => t.insert(t.length, "z".repeat(MAX_INLINE_UPDATE_BYTES + 1000)));
		await idle(a, b);
		await until(() => a.c.snap.state.records.size === 1 && (a.c.ns.state.entries.get(dTomb)?.deletedSeq ?? 0) > 0, 3_000, "folded");
		const stream = a.streamOf(doc);
		let bodyRef: ContentHash | null = null;
		for (const row of w.relay.rows(stream)) {
			const o = await openEnvelope(a.c.ports.crypto, VAULT as VaultId, { t: "frame", stream, deviceId: row.deviceId, clientFrameId: row.clientFrameId }, row.payload);
			if (o.ok && o.inner.kind === "bodyUpdateRef") bodyRef = decodeBodyUpdateRef(o.inner.content)!.hash;
		}
		assert.ok(bodyRef, "the big update went out as a bodyUpdateRef");
		assert.ok(w.has(bodyRef), "its update is in the store");
		w.store.objects.set(bodyRef as string as BlobAddress, { ...w.store.objects.get(bodyRef as string as BlobAddress)!, uploadedAt: T0 });

		w.relay.pauseCommits();
		const dOut = newDoc();
		await a.submitNs([createBlob(dOut, outbox.hash)]);
		await until(() => a.c.outbox.size === 1 && w.store.uploadedAt(outbox.address) !== null, 3_000, "outbox frame cleared to send");
		for (const x of [liveBlob, tomb, cfgBlob, snapPart, deadPart, queued, outbox, ...garbage]) {
			w.store.objects.set(x.address, { bytes: x.bytes, uploadedAt: T0 });
		}

		w.storeNow = T0 + 3 * GRACE;
		const fresh = w.plant(11);
		const r = await sweep(a, [queued.hash]);
		assert.deepEqual(r, { deleted: 4, keptNewer: 1, repaired: 0, lost: 0, refused: null, detail: null });
		assert.equal(w.store.deleted.length, 5, "four candidates, then the probe");
		for (const x of [liveBlob, tomb, cfgBlob, snapPart, queued, outbox, fresh]) assert.ok(w.has(x.address), "live or newer survives");
		assert.ok(w.has(bodyRef), "a body ref the relay still serves survives");
		for (const x of [deadPart, ...garbage]) assert.ok(!w.has(x.address), "unreferenced and old: deleted");
		assert.equal(w.store.objects.size, 8, "no probe left behind");
		w.relay.resumeCommits();
	} finally {
		await w.stop();
	}
});

test("GC preconditions: each refusal deletes nothing", async (t) => {
	const garbageOnly = (w: World) => { w.plant(100); w.storeNow = T0 + 3 * GRACE; };
	const noDeletes = (w: World, r: GcOutcome, refused: string) => {
		assert.equal(r.refused, refused, r.detail ?? "");
		assert.equal(r.deleted, 0);
		assert.ok(w.has(H(bytesOf(100))), "garbage kept");
		assert.ok(w.store.deleted.every((x) => (x as string) !== H(bytesOf(100))));
	};

	await t.test("no-store", async () => {
		const w = new World();
		try {
			const a = await w.device(A, { blob: false });
			garbageOnly(w);
			noDeletes(w, await sweep(a), "no-store");
			assert.equal(w.store.calls.put + w.store.calls.list, 0);
		} finally { await w.stop(); }
	});

	await t.test("keys-unverified (suite 1, K_1 not confirmed)", async () => {
		const w = new World();
		try {
			// The keyring verifies K_1 against the genesis (the gate opens); the port then reports it unconfirmed.
			const p = await w.suite1(5);
			let confirmed = true;
			const crypto: CryptoPort = { ...p.crypto, keyState: (e) => ({ held: p.crypto.keyState(e).held, verified: confirmed && p.crypto.keyState(e).verified }) };
			const a = await w.device(A, { ...p, crypto });
			confirmed = false;
			garbageOnly(w);
			noDeletes(w, await sweep(a), "keys-unverified");
			assert.equal(w.store.calls.list, 0);
		} finally { await w.stop(); }
	});

	await t.test("offline", async () => {
		const w = new World();
		try {
			const a = await w.device(A);
			a.disconnect();
			garbageOnly(w);
			noDeletes(w, await sweep(a), "offline");
		} finally { await w.stop(); }
	});

	await t.test("read-only", async () => {
		const w = new World();
		try {
			const a = await w.device(A);
			w.relay.setReadOnly(A as DeviceId, true);
			a.disconnect();
			await a.reconnect();
			await until(() => a.status().phase === "live", 3_000, "reconnected");
			garbageOnly(w);
			noDeletes(w, await sweep(a), "read-only");
		} finally { await w.stop(); }
	});

	await t.test("not-caught-up (ns / cfg / snap reads fail)", async () => {
		const w = new World();
		try {
			const a = await w.device(A);
			garbageOnly(w);
			w.relay.setHttpFailure(true);
			noDeletes(w, await sweep(a), "not-caught-up");
			w.relay.setHttpFailure(false);
		} finally { await w.stop(); }
	});

	await t.test("fold-incomplete: an ns row this reader cannot open (the fold halts)", async () => {
		const w = new World();
		try {
			const a = await w.device(A);
			const raw = await rawDevice(w.relay);
			await raw.send(NS_STREAM, "nsOps", new Uint8Array(0), new Uint8Array([9, 9, 9]));
			await until(async () => (await a.c.ns.gap()) !== null, 3_000, "ns halted");
			raw.close();
			garbageOnly(w);
			const r = await sweep(a);
			noDeletes(w, r, "fold-incomplete");
			assert.match(r.detail!, /^ns row \d+: halted/);
		} finally { await w.stop(); }
	});

	await t.test("fold-incomplete: a snap record version this reader does not know", async () => {
		const w = new World();
		try {
			const a = await w.device(A);
			const raw = await rawDevice(w.relay);
			await raw.send(SNAP_STREAM, "snapOps", new Writer().varuint(1).u8(SnapOpTag.put).varbytes(new Uint8Array([9, 1, 2, 3])).finish());
			await until(() => w.relay.rows(SNAP_STREAM).length === 1 && a.isIdle(), 3_000, "snap row");
			raw.close();
			garbageOnly(w);
			const r = await sweep(a);
			noDeletes(w, r, "fold-incomplete");
			assert.match(r.detail!, /^snap row \d+: snap record version unknown$/);
		} finally { await w.stop(); }
	});

	await t.test("body-unreadable: a served body row that no longer opens here", async () => {
		const w = new World();
		try {
			const fc = faultyCrypto();
			const a = await w.device(A, { crypto: fc });
			const b = await w.device(B);
			const doc = await b.createDoc("n.md", "hello");
			await idle(b);
			await until(() => a.listDocs().some((d) => d.docId === doc) && a.isIdle(), 3_000, "a has the doc");
			fc.failOpen = true;
			garbageOnly(w);
			const r = await sweep(a);
			noDeletes(w, r, "body-unreadable");
			assert.match(r.detail!, /unknown-key/);
		} finally { await w.stop(); }
	});

	await t.test("addressing-mismatch: no referenced blob is in the listing", async () => {
		const w = new World();
		try {
			const a = await w.device(A);
			const ref = bytesOf(101);
			await a.submitNs([createBlob(newDoc(), H(ref))]);
			await idle(a);
			garbageOnly(w);
			const r = await sweep(a);
			noDeletes(w, r, "addressing-mismatch");
		} finally { await w.stop(); }
	});

	await t.test("busy, and stop() aborts a running sweep before it deletes", async () => {
		const w = new World();
		try {
			const a = await w.device(A);
			garbageOnly(w);
			let entered!: () => void;
			const inList = new Promise<void>((r) => (entered = r));
			let release!: () => void;
			const held = new Promise<void>((r) => (release = r));
			w.store.hooks.beforeList = async () => { entered(); await held; };
			const first = sweep(a);
			await inList;
			const second = await sweep(a);
			assert.equal(second.refused, "busy");
			const stopping = a.stop();
			release();
			await stopping;
			const r = await first;
			noDeletes(w, r, "interrupted");
		} finally { await w.stop(); }
	});
});

test("GC R2: an orphan the store already has is PUT again on reuse, so a sweep before its reference commits keeps it", async () => {
	const w = new World();
	try {
		const a = await w.device(A);
		const b = await w.device(B);
		const orphan = w.plant(20);
		w.storeNow = T0 + 3 * GRACE;
		await putSealed(w.store, a.c.ports.crypto, orphan.hash, orphan.bytes, a.c.touch);
		assert.equal(w.store.uploadedAt(orphan.address), w.storeNow, "re-PUT refreshed the upload time");
		const r = await sweep(b);
		assert.equal(r.refused, null);
		assert.equal(r.keptNewer, 1);
		assert.ok(w.has(orphan.address));
		const puts = w.store.calls.put;
		await putSealed(w.store, a.c.ports.crypto, orphan.hash, orphan.bytes, a.c.touch);
		assert.equal(w.store.calls.put, puts, "an own PUT less than grace/2 ago is reused");

		// A committed reference is reused at any age (a live snap part re-used by a later snapshot).
		const part = w.plant(21);
		await b.submitSnap([{ t: "put", record: snapRec(T0, [part.hash]) }]);
		await idle(a, b);
		await until(() => a.c.snap.state.records.size === 1, 3_000, "snap folded");
		w.store.objects.set(part.address, { bytes: part.bytes, uploadedAt: T0 });
		const before = w.store.calls.put;
		await putSealed(w.store, a.c.ports.crypto, part.hash, part.bytes, a.c.touch);
		assert.equal(w.store.calls.put, before);
		assert.equal(w.store.uploadedAt(part.address), T0);
	} finally {
		await w.stop();
	}
});

test("GC R3: a device back after more than the grace offline PUTs again before sending a reference another device's sweep deleted", async () => {
	const w = new World();
	try {
		const offset = { ms: 0 };
		const a = await w.device(A, { offset });
		const b = await w.device(B);
		const x = w.plant(30);
		w.local.get(A)!.set(x.hash, x.bytes);
		await putSealed(w.store, a.c.ports.crypto, x.hash, x.bytes, a.c.touch);
		a.disconnect();
		const d = newDoc();
		await a.submitNs([createBlob(d, x.hash)]);
		assert.equal(a.c.outbox.size, 1);

		offset.ms = 2 * GRACE;
		w.storeNow = T0 + 3 * GRACE;
		const r = await sweep(b);
		assert.equal(r.deleted, 1);
		assert.ok(!w.has(x.address), "the offline device's upload was garbage to the sweeper");

		await a.reconnect();
		await until(() => a.isIdle() && b.c.ns.state.entries.has(d), 5_000, "reference committed");
		assert.ok(w.has(x.address), "re-PUT from local bytes before the frame went out");
		assert.equal(w.store.uploadedAt(x.address), w.storeNow);
		assert.ok(a.diagnostics().some((e) => e.code === "blob-refreshed"));
	} finally {
		await w.stop();
	}
});

test("GC R4: a reference committed in the store's check -> delete window is uploaded again from local bytes, or reported lost", async (t) => {
	for (const haveBytes of [true, false]) {
		await t.test(haveBytes ? "repaired" : "lost", async () => {
			const w = new World();
			try {
				const a = await w.device(A);
				const b = await w.device(B);
				const x = w.plant(40);
				if (haveBytes) w.local.get(A)!.set(x.hash, x.bytes);
				w.storeNow = T0 + 3 * GRACE;
				const d = newDoc();
				let raced = false;
				w.store.hooks.beforeDelete = async (addrs) => {
					if (raced || !addrs.includes(x.address)) return;
					raced = true;
					// b re-uploads and commits a reference after the store's check, before its delete.
					await w.store.put(x.address, [x.bytes]);
					await b.submitNs([createBlob(d, x.hash)]);
					await until(() => b.isIdle() && b.c.ns.state.entries.has(d), 5_000, "b committed");
				};
				const r = await sweep(a);
				assert.ok(raced);
				assert.equal(r.refused, null);
				assert.equal(r.deleted, 1, "the store reports the raced address deleted");
				if (haveBytes) {
					assert.deepEqual([r.repaired, r.lost], [1, 0]);
					assert.ok(w.has(x.address), "uploaded again");
				} else {
					assert.deepEqual([r.repaired, r.lost], [0, 1]);
					assert.ok(!w.has(x.address));
				}
			} finally {
				await w.stop();
			}
		});
	}
});

test("GC suite 1: addresses are HMACs; the live blob survives, garbage goes, and no plaintext hash reaches the store", async () => {
	const w = new World();
	try {
		const p = await w.suite1(1);
		const crypto = p.crypto;
		const a = await w.device(A, p);
		const keep = bytesOf(50);
		const drop = bytesOf(51);
		await putSealed(w.store, crypto, H(keep), keep, a.c.touch);
		await putSealed(w.store, crypto, H(drop), drop, a.c.touch);
		await a.submitNs([createBlob(newDoc(), H(keep))]);
		await idle(a);
		const keepAddr = await crypto.blobAddress(H(keep));
		assert.notEqual(keepAddr, H(keep));
		for (const o of w.store.objects.values()) (o as { uploadedAt: number }).uploadedAt = T0;
		w.storeNow = T0 + 3 * GRACE;
		const r = await sweep(a);
		assert.deepEqual([r.refused, r.deleted], [null, 1]);
		assert.deepEqual([...w.store.objects.keys()], [keepAddr]);
		for (const addr of [...w.store.deleted, ...w.store.objects.keys()] as string[]) assert.ok(addr !== H(keep) && addr !== H(drop));
	} finally {
		await w.stop();
	}
});

test("GC stop: engine stop ends a sweep whose fresh read the relay never answers (stop awaits the sweep before it closes the session)", async () => {
	const w = new World();
	const a = await w.device(A);
	let reads = 0;
	a.c.sess.readFresh = () => (reads++, new Promise<boolean>(() => undefined));
	let out: GcOutcome | "pending" = "pending";
	void sweep(a).then((o) => (out = o));
	const settled = (): GcOutcome | "pending" => out;
	await until(() => reads === 1, 2_000, "fresh read in flight");
	assert.equal(settled(), "pending");
	let stopped = false;
	const stop = w.stop().then(() => (stopped = true));
	await until(() => stopped, 2_000, "engine stopped");
	await stop;
	await until(() => settled() !== "pending", 1_000, "sweep ended");
	const end = settled();
	assert.ok(end !== "pending");
	assert.equal(end.deleted, 0);
});
