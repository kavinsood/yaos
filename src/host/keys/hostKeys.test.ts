import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY_STORE_WAIT_MS } from "../../core/limits";
import { VirtualClock } from "../../sim/clock";
import { createHostKeys, KeyRefused } from "./hostKeys";
import type { E2eePin } from "./pin";
import { plaintextNoticeOnce, PLAINTEXT_NOTICE_KEY } from "./plaintextNotice";
import { KeyStoreError, VaultKeyStore, sameKeys, type EpochKey } from "./secretStore";
import { FakeSecretStorage } from "./testkit/fakeSecretStorage";
import { testVaultId } from "./testkit/vaultIds";

function key(e: number, seed: number): EpochKey {
	const k = new Uint8Array(32);
	for (let i = 0; i < 32; i++) k[i] = (seed * 13 + i * 3 + 1) & 0xff;
	return { e, k };
}
const record = (n: number): Uint8Array => new Uint8Array([0xb0, n, 9]);
/** Runs `p` while the store's startup wait (§6.1) elapses on `clock`. */
async function waited<T>(clock: VirtualClock, p: Promise<T>): Promise<T> {
	await clock.advance(KEY_STORE_WAIT_MS);
	return p;
}

test("crypto(): unpinned and suite 0 carry no keys and do not wait for the store (unpinned starts its wait)", async () => {
	const clock = new VirtualClock();
	const fake = new FakeSecretStorage(new Map(), { loaded: false });
	const store = new VaultKeyStore(fake, testVaultId("v"), clock);
	let pin: E2eePin | undefined;
	let creating = false;
	const hk = createHostKeys({ store, pin: () => pin, creating: () => creating });
	assert.deepEqual(await hk.crypto(), { suite: null, creating: false });
	creating = true;
	assert.deepEqual(await hk.crypto(), { suite: null, creating: true });
	pin = { suite: null, keyringSeen: true };
	assert.deepEqual(await hk.crypto(), { suite: null, creating: true });
	pin = { suite: 0 };
	assert.deepEqual(await hk.crypto(), { suite: 0 });
	assert.equal(clock.pendingTimers(), 1, "one startup wait, for a later persist");
	fake.load();
	await clock.settleMicrotasks();
	assert.equal(clock.pendingTimers(), 0);
});

test("persist(): waits until SecretStorage loaded, so a store it read too early is not replaced (§6.1 Startup)", async () => {
	const clock = new VirtualClock();
	const backing = new Map<string, string>();
	new VaultKeyStore(new FakeSecretStorage(backing), testVaultId("v"), clock).merge({ keys: [key(1, 8)], records: [record(1)] });
	const fake = new FakeSecretStorage(backing, { loaded: false });
	const store = new VaultKeyStore(fake, testVaultId("v"), clock);
	const hk = createHostKeys({ store, pin: () => undefined, creating: () => false });
	let done = false;
	const p = hk.persist({ keys: [key(2, 9)], records: [record(1), record(2)], pending: null }).then(() => void (done = true));
	await clock.advance(10);
	assert.equal(done, false, "not stored before the load");
	fake.load();
	await p;
	assert.ok(sameKeys(store.load()!.keys, [key(1, 8), key(2, 9)]));
	// An empty store that loaded long ago: crypto() started the wait at engine start, so a later persist does not wait.
	const empty = createHostKeys({ store: new VaultKeyStore(new FakeSecretStorage(), testVaultId("w"), clock), pin: () => undefined, creating: () => false });
	await empty.crypto();
	await clock.advance(KEY_STORE_WAIT_MS);
	await empty.persist({ keys: [key(1, 10)], records: [record(1)], pending: null });
});

test("crypto(): suite 1 waits for the store, then loads fresh key buffers", async () => {
	const clock = new VirtualClock();
	const backing = new Map<string, string>();
	new VaultKeyStore(new FakeSecretStorage(backing), testVaultId("v"), clock).merge({ keys: [key(1, 1)], records: [record(1)] });
	const fake = new FakeSecretStorage(backing, { loaded: false });
	const hk = createHostKeys({ store: new VaultKeyStore(fake, testVaultId("v"), clock), pin: () => ({ suite: 1 }), creating: () => false });
	let got: Awaited<ReturnType<typeof hk.crypto>> | null = null;
	void hk.crypto().then((c) => (got = c));
	await clock.advance(100);
	assert.equal(got, null);
	fake.load();
	await clock.settleMicrotasks();
	const c = got as unknown as { suite: 1; keys: EpochKey[]; records: Uint8Array[] };
	assert.equal(c.suite, 1);
	assert.ok(sameKeys(c.keys, [key(1, 1)]));
	assert.equal(c.records.length, 1);
});

test("crypto(): suite 1 with nothing stored (or no SecretStorage) starts key-missing, empty", async () => {
	const clock = new VirtualClock();
	const none = createHostKeys({ store: null, pin: () => ({ suite: 1 }), creating: () => false });
	assert.deepEqual(await none.crypto(), { suite: 1, keys: [], records: [] });
	// An empty store cannot prove it loaded: the start waits KEY_STORE_WAIT_MS, then goes on key-missing.
	const empty = createHostKeys({ store: new VaultKeyStore(new FakeSecretStorage(), testVaultId("v"), clock), pin: () => ({ suite: 1 }), creating: () => false });
	const p = empty.crypto();
	await clock.advance(KEY_STORE_WAIT_MS);
	assert.deepEqual(await p, { suite: 1, keys: [], records: [] });
});

test("persist(): stores before the pin decision, which completes before persist resolves (persist-before-use)", async () => {
	const clock = new VirtualClock();
	const backing = new Map<string, string>();
	const store = new VaultKeyStore(new FakeSecretStorage(backing), testVaultId("v"), clock);
	const order: string[] = [];
	let pin: E2eePin | undefined;
	const hk = createHostKeys({
		store, pin: () => pin, creating: () => false,
		stored: async (info) => {
			order.push(`stored:${store.holdsKeys()}:${info.keys}/${info.records}/${info.pending}`);
			await clock.settleMicrotasks();
			pin = { suite: 1 };
			order.push("pinned");
		},
	});
	const change = { keys: [key(1, 2)], records: [record(1)], pending: null };
	await waited(clock, hk.persist(change).then(() => order.push("acked")));
	assert.deepEqual(order, ["stored:true:1/1/null", "pinned", "acked"]);
	assert.ok(change.keys[0]!.k.every((b) => b === 0), "the change's key buffer is zero-filled once stored");
	assert.ok(sameKeys(store.load()!.keys, [key(1, 2)]));
});

test("persist(): refused under a suite-0 pin, nothing stored, buffers zero-filled", async () => {
	const clock = new VirtualClock();
	const fake = new FakeSecretStorage();
	let decided = 0;
	const hk = createHostKeys({ store: new VaultKeyStore(fake, testVaultId("v"), clock), pin: () => ({ suite: 0 }), creating: () => false, stored: async () => void decided++ });
	const change = { keys: [key(1, 3)], records: [record(1)], pending: null };
	await assert.rejects(hk.persist(change), KeyRefused);
	assert.equal(fake.writes, 0);
	assert.equal(decided, 0);
	assert.ok(change.keys[0]!.k.every((b) => b === 0));
});

test("persist(): a store failure rejects before any pin decision", async () => {
	let decided = 0;
	const hk = createHostKeys({ store: null, pin: () => undefined, creating: () => false, stored: async () => void decided++ });
	const change = { keys: [key(1, 4)], records: [record(1)], pending: null };
	await assert.rejects(hk.persist(change), (e: unknown) => e instanceof KeyStoreError && e.reason === "unavailable");
	assert.equal(decided, 0);
	assert.ok(change.keys[0]!.k.every((b) => b === 0));
});

test("plaintext notice: shown once per vault when keys are stored or loaded on a plaintext store", async () => {
	const clock = new VirtualClock();
	const local = new Map<string, string>();
	const shown: string[] = [];
	const env = { load: (k: string) => local.get(k) ?? null, save: (k: string, v: string) => void local.set(k, v), show: (t: string) => void shown.push(t) };
	const backing = new Map<string, string>();
	const plain = new FakeSecretStorage(backing, { encryption: false });
	const hk = createHostKeys({ store: new VaultKeyStore(plain, testVaultId("v"), clock), pin: () => undefined, creating: () => false, plaintext: plaintextNoticeOnce(env) });
	await waited(clock, hk.persist({ keys: [key(1, 5)], records: [record(1)], pending: null }));
	await hk.persist({ keys: [key(2, 6)], records: [record(1)], pending: null });
	assert.equal(shown.length, 1);
	assert.equal(local.get(PLAINTEXT_NOTICE_KEY), "1");
	// A restart (new notice function) remembers it was shown.
	const again = createHostKeys({ store: new VaultKeyStore(plain, testVaultId("v"), clock), pin: () => ({ suite: 1 }), creating: () => false, plaintext: plaintextNoticeOnce(env) });
	await again.crypto();
	assert.equal(shown.length, 1);
	// An encrypted store never shows it.
	const enc = createHostKeys({ store: new VaultKeyStore(new FakeSecretStorage(), testVaultId("w"), clock), pin: () => undefined, creating: () => false, plaintext: plaintextNoticeOnce({ ...env, load: () => null }) });
	await waited(clock, enc.persist({ keys: [key(1, 7)], records: [record(1)], pending: null }));
	assert.equal(shown.length, 1);
	assert.ok(!shown[0]!.match(/[0-9a-f]{16}/));
});
