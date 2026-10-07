/**
 * WP-E7 open question (e): blob seals and the roll trigger (e2ee-design §4.2), and the blob GC's refusals on a
 * suite-1 device whose write gate is shut, or that is merely offline, not live yet, or waiting for main (§10.4, §12.4,
 * §18.4).
 *
 * - §4.2 counts own seals under e (re-seals included) and "one trigger covers all" subkeys: a blob seal
 *   (kBlob, one nonce) counts like a frame seal (writeGate.ts gatedCrypto onSeal).
 * - The GC precondition "keys-unverified" means a key state (KeyMissingReason); offline / read-only come after it,
 *   and the session's own `k` read decides before any ns / cfg / snap row is judged for the sweep.
 *
 * Keys are the testkit's fixed ranges; nothing secret is printed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../core/hash/sha256";
import { KEYRING_STREAM, NS_STREAM, type ContentHash, type DocId, type NsOp, type VaultPath } from "../../core/types";
import type { BlobAddress } from "../../ports/crypto";
import type { RelayPort, RelaySession } from "../../ports/relay";
import { SimBlobStore } from "../../sim/blobStore";
import { SimRelay } from "../../sim/relay";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { createWebRandom } from "../adapters/webRandom";
import { putSealed } from "../blobs/blobStore";
import type { GcOutcome } from "../blobs/gc";
import type { KeyringChange } from "../keyring/keyring";
import { rawAppend } from "../keyring/testkit/engines";
import { K, VAULT, genesis, roll } from "../keyring/testkit/world";
import type { LogEngine } from "./engine";
import type { EngineTuning } from "./options";
import { startTestEngine, testPorts, testStorage, until } from "./testHarness";

const GRACE = 60 * 60_000;
const T0 = Date.UTC(2026, 9, 1);
const H = (b: Uint8Array) => sha256Hex(b) as ContentHash;
const bytesOf = (i: number): Uint8Array => Uint8Array.from({ length: 48 }, (_, j) => (j === 0 ? i >> 8 : j === 1 ? i : i * 7 + j) & 0xff);
let docN = 0;
const newDoc = () => `rtgdoc${String(++docN).padStart(16, "0")}` as DocId;
const createBlob = (docId: DocId, hash: ContentHash): NsOp => ({ t: "create", docId, kind: "blob", path: `att/${docId}.png` as VaultPath, contentHash: hash, size: 48 });

/** Session `feed` calls wait while `held` (the first step of a session start, before its `k` read). */
class FeedHold implements RelayPort {
	held = false;
	private waiting: (() => void)[] = [];
	constructor(private readonly inner: RelayPort) {}
	async connect(params: Parameters<RelayPort["connect"]>[0]): ReturnType<RelayPort["connect"]> {
		const r = await this.inner.connect(params);
		if (!r.ok) return r;
		const s = r.session;
		const self = this;
		const session = new Proxy(s, {
			get(t, p) {
				if (p === "feed") {
					return async (after: Parameters<RelaySession["feed"]>[0]) => {
						while (self.held) await new Promise<void>((res) => self.waiting.push(res));
						return t.feed(after);
					};
				}
				const v = Reflect.get(t, p, t) as unknown;
				return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
			},
		});
		return { ok: true, session };
	}
	release(): void {
		this.held = false;
		for (const w of this.waiting.splice(0)) w();
	}
}

class World {
	readonly relay = new SimRelay();
	readonly link = new FeedHold(this.relay);
	storeNow = T0;
	readonly store = new SimBlobStore({ now: () => this.storeNow });
	readonly engines: LogEngine[] = [];
	g: Uint8Array | null = null;

	async device(deviceId: string, o: { persist?: (c: KeyringChange) => Promise<void>; tuning?: Partial<EngineTuning> } = {}): Promise<LogEngine> {
		if (!this.g) {
			this.g = await genesis();
			await rawAppend(this.relay, KEYRING_STREAM, this.g);
		}
		const storage = testStorage();
		const crypto = await createWebCryptoSuite1({ vaultId: VAULT, random: createWebRandom(), keys: [{ e: 1, k: K(1) }] });
		const { engine } = await startTestEngine({
			relay: this.link, deviceId, vaultId: VAULT, storage, crypto,
			e2ee: { suite: 1, records: [this.g], persist: o.persist ?? (async () => undefined) },
			tuning: { blobGcGraceMs: GRACE, ...(o.tuning ?? {}) },
			extra: { ports: { ...testPorts(this.link, storage, crypto), blob: this.store }, blobBytes: async () => null },
		});
		this.engines.push(engine);
		await until(() => engine.status().phase === "live", 5_000, `${deviceId} live`);
		return engine;
	}

	/** An unreferenced object uploaded at T0; the store clock then moves past the grace. */
	garbage(): BlobAddress {
		const address = H(bytesOf(100)) as string as BlobAddress;
		this.store.objects.set(address, { bytes: bytesOf(100), uploadedAt: T0 });
		this.storeNow = T0 + 3 * GRACE;
		return address;
	}

	async stop(): Promise<void> {
		this.link.release();
		for (const e of this.engines) await e.stop();
	}
}

const sweep = (e: LogEngine): Promise<GcOutcome> => e.cleanUpBlobs(() => []);

test("roll trigger (§4.2): blob seals count as own seals; blob uploads alone past rollOwnSeals roll the epoch", async () => {
	const w = new World();
	try {
		const x = await w.device("dev-x-0123456789abcdef", { tuning: { rollOwnSeals: 4 } });
		const seal = (i: number) => putSealed(w.store, x.c.deps.crypto, H(bytesOf(i)), bytesOf(i), x.c.touch);
		for (let i = 0; i < 3; i++) await seal(i);
		await new Promise((r) => setTimeout(r, 300)); // a dozen maintenance ticks (FAST_TUNING maintenanceMs 25)
		assert.equal(x.status().e2ee?.sealEpoch, 1, "3 blob seals: below the trigger");
		await seal(3);
		await until(() => x.status().e2ee?.sealEpoch === 2, 8_000, "rolled to epoch 2");
		const own = w.relay.streams().flatMap((s) => w.relay.rows(s)).filter((r) => r.deviceId === "dev-x-0123456789abcdef");
		assert.deepEqual(own.map((r) => r.stream), [KEYRING_STREAM], "no frame was sealed: the roll record is the device's only row");
	} finally {
		await w.stop();
	}
});

test("GC on a suite-1 device that is merely offline: refused 'offline', not 'keys-unverified'", async () => {
	const w = new World();
	try {
		const a = await w.device("dev-a-0123456789abcdef");
		a.disconnect();
		const garbage = w.garbage();
		const r = await sweep(a);
		assert.deepEqual([r.refused, r.deleted], ["offline", 0], r.detail ?? "");
		assert.ok(w.store.objects.has(garbage));
	} finally {
		await w.stop();
	}
});

test("GC while main has not stored the newest key (persist-before-use, §18.4): refused 'keys-unverified' (no-key), nothing listed or deleted", async () => {
	const w = new World();
	let stall: Promise<void> | null = null;
	let unstall = () => {};
	try {
		const a = await w.device("dev-a-0123456789abcdef", {
			persist: (c) => (c.keys.some((x) => x.e === 2) ? (stall ??= new Promise<void>((r) => (unstall = r))) : Promise.resolve()),
		});
		await rawAppend(w.relay, KEYRING_STREAM, await roll(2));
		await until(() => stall !== null && a.status().e2ee?.keyMissing === "no-key", 5_000, "K_2 derived, its store in flight");
		const garbage = w.garbage();
		const lists = w.store.calls.list;
		const r = await sweep(a);
		assert.equal(r.refused, "keys-unverified", r.detail ?? "");
		assert.match(r.detail ?? "", /no-key/);
		assert.equal(r.deleted, 0);
		assert.equal(w.store.calls.list, lists, "refused before listing");
		unstall();
		await until(() => a.status().e2ee?.keyMissing === null && a.status().e2ee?.sealEpoch === 2, 5_000, "stored, gate open");
		const again = await sweep(a);
		assert.deepEqual([again.refused, again.deleted], [null, 1], again.detail ?? "");
		assert.ok(!w.store.objects.has(garbage));
	} finally {
		unstall();
		await w.stop();
	}
});

test("GC before the session's k read (§14.3): refused before any ns row is judged; no keyring-hold quarantine, no freeze", async () => {
	const w = new World();
	try {
		const a = await w.device("dev-a-0123456789abcdef");
		const b = await w.device("dev-b-0123456789abcdef");
		a.disconnect();
		// An attachment another device uploads and references in ns while A is away (under K_1, which A holds).
		const att = bytesOf(7);
		await putSealed(w.store, b.c.deps.crypto, H(att), att, b.c.touch);
		await b.submitNs([createBlob(newDoc(), H(att))]);
		await until(() => w.relay.rows(NS_STREAM).length > 0, 5_000, "b's ns row committed");
		const garbage = w.garbage();
		w.link.held = true;
		const back = a.reconnect();
		await until(() => a.c.session !== null && a.status().phase === "catching-up", 5_000, "A's session start is on the wire");
		assert.equal(a.c.keyring.sendReady(), false, "this session's k is not read yet");
		const r = await sweep(a);
		const gap = await a.c.ns.gap();
		w.link.release();
		await back;
		await until(() => a.status().phase === "live", 5_000, "A live again");
		assert.equal(r.deleted, 0, "nothing deleted before the k read");
		assert.ok(w.store.objects.has(garbage));
		assert.equal(r.refused, "not-caught-up", `refused ${r.refused}: ${r.detail ?? ""}`);
		assert.equal(gap, null, `the sweep's read halted the ns fold before the k read: ${gap?.reason ?? ""}`);
		assert.equal(a.status().counts.quarantinedRows, 0, "no ns row was held for the sweep");
		assert.equal(a.status().counts.frozenDocs, 0);
		assert.equal((await a.c.repo.quarantineOf(NS_STREAM)).length, 0);
		const after = await sweep(a);
		assert.deepEqual([after.refused, after.deleted], [null, 1], after.detail ?? "");
	} finally {
		await w.stop();
	}
});

