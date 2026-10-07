import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY_STORE_WAIT_MS } from "../../core/limits";
import { VirtualClock } from "../../sim/clock";
import { KeyStoreError, VaultKeyStore, sameKeys, secretIdFor, type EpochKey } from "./secretStore";
import { FakeSecretStorage } from "./testkit/fakeSecretStorage";
import { BAD_VAULT_IDS, testVaultId } from "./testkit/vaultIds";

// Test key bytes are generated, never printed: assertions compare with sameKeys and report only booleans and counts.
function key(e: number, seed: number): EpochKey {
	const k = new Uint8Array(32);
	for (let i = 0; i < 32; i++) k[i] = (seed * 31 + i * 7) & 0xff;
	return { e, k };
}
const record = (n: number): Uint8Array => new Uint8Array([0xa0, n, 1, 2, 3]);

test("secretIdFor: \"yaos-\" + the vaultId's 16 bytes in lowercase hex (37 chars, no hash), one per vault", () => {
	assert.equal(secretIdFor("AAECAwQFBgcICQoLDA0ODw"), "yaos-000102030405060708090a0b0c0d0e0f");
	assert.equal(secretIdFor("_____________________w"), "yaos-ffffffffffffffffffffffffffffffff");
	const a = secretIdFor(testVaultId("vault-a"));
	assert.notEqual(a, secretIdFor(testVaultId("vault-b")));
	assert.equal(a, secretIdFor(testVaultId("vault-a")));
	assert.match(a, /^yaos-[0-9a-f]{32}$/); // setSecret's /^[a-z0-9-]+$/, well under its 64-char limit
	assert.equal(a.length, 37);
});

test("secretIdFor: anything but a canonical 22-char vaultId throws (never names a secret)", () => {
	for (const bad of BAD_VAULT_IDS) {
		assert.throws(() => secretIdFor(bad), TypeError, JSON.stringify(bad));
		assert.throws(() => new VaultKeyStore(new FakeSecretStorage(), bad, new VirtualClock()), TypeError);
	}
});

test("ready(): resolves true at once when the store already holds secrets", async () => {
	const clock = new VirtualClock();
	const fake = new FakeSecretStorage(new Map([["other", "x"]]));
	const store = new VaultKeyStore(fake, testVaultId("v1"), clock);
	assert.equal(await store.ready(), true);
	assert.equal(fake.listenerCount, 0);
});

test("ready(): waits for `changed` (the app's load), then unsubscribes", async () => {
	const clock = new VirtualClock();
	const backing = new Map<string, string>();
	const fake = new FakeSecretStorage(backing, { loaded: false });
	const store = new VaultKeyStore(fake, testVaultId("v1"), clock);
	let answer: boolean | null = null;
	void store.ready().then((v) => (answer = v));
	await clock.advance(KEY_STORE_WAIT_MS - 1);
	assert.equal(answer, null);
	fake.load();
	await clock.settleMicrotasks();
	assert.equal(answer, true);
	assert.equal(fake.listenerCount, 0);
	assert.equal(clock.pendingTimers(), 0);
});

test("ready(): false after KEY_STORE_WAIT_MS without a load; the answer is kept", async () => {
	const clock = new VirtualClock();
	const fake = new FakeSecretStorage(new Map(), { loaded: false });
	const store = new VaultKeyStore(fake, testVaultId("v1"), clock);
	let answer: boolean | null = null;
	void store.ready().then((v) => (answer = v));
	await clock.advance(KEY_STORE_WAIT_MS - 1);
	assert.equal(answer, null);
	await clock.advance(1);
	await clock.settleMicrotasks();
	assert.equal(answer, false);
	assert.equal(fake.listenerCount, 0);
	assert.equal(await store.ready(), false);
	assert.equal(KEY_STORE_WAIT_MS, 5000);
});

test("ready(): a store without Events (Obsidian before 1.13) does not wait", async () => {
	const clock = new VirtualClock();
	const store = new VaultKeyStore({ setSecret() {}, getSecret: () => null, listSecrets: () => [] }, testVaultId("v1"), clock);
	assert.equal(await store.ready(), false);
	assert.equal(clock.pendingTimers(), 0);
});

test("merge/load round trip; namespaced per vault; a restart (new store over the same backing) keeps keys", () => {
	const clock = new VirtualClock();
	const backing = new Map<string, string>();
	const fake = new FakeSecretStorage(backing);
	const a = new VaultKeyStore(fake, testVaultId("vault-a"), clock);
	const b = new VaultKeyStore(fake, testVaultId("vault-b"), clock);
	assert.equal(a.load(), null);
	const counts = a.merge({ keys: [key(1, 1)], records: [record(1)] });
	assert.deepEqual(counts, { keys: 1, records: 1 });
	assert.equal(b.load(), null, "vault b sees nothing of vault a");
	assert.equal(b.holdsKeys(), false);
	assert.equal(a.holdsKeys(), true);
	assert.deepEqual([...backing.keys()], [a.id]);

	const restarted = new VaultKeyStore(new FakeSecretStorage(backing), testVaultId("vault-a"), clock);
	const v = restarted.load();
	assert.ok(v);
	assert.ok(sameKeys(v.keys, [key(1, 1)]));
	assert.equal(v.records.length, 1);
	assert.ok(sameKeys(v.records.map((r, i) => ({ e: i + 1, k: r })), [{ e: 1, k: record(1) }]));
});

test("load() returns fresh buffers each time (zero-filling one leaves the store intact)", () => {
	const clock = new VirtualClock();
	const store = new VaultKeyStore(new FakeSecretStorage(), testVaultId("v1"), clock);
	store.merge({ keys: [key(1, 9)], records: [record(1)] });
	const first = store.load()!;
	first.keys[0]!.k.fill(0);
	assert.ok(sameKeys(store.load()!.keys, [key(1, 9)]));
});

test("merge never replaces a held epoch; adds new epochs; records follow the latest non-empty set", () => {
	const clock = new VirtualClock();
	const store = new VaultKeyStore(new FakeSecretStorage(), testVaultId("v1"), clock);
	store.merge({ keys: [key(1, 1)], records: [record(1)] });
	const c = store.merge({ keys: [key(1, 2), key(2, 3)], records: [record(1), record(2)] });
	assert.deepEqual(c, { keys: 2, records: 2 });
	assert.ok(sameKeys(store.load()!.keys, [key(1, 1), key(2, 3)]));
	// Records-only flush (keys: []) keeps the keys and takes the records.
	const d = store.merge({ keys: [], records: [record(3)] });
	assert.deepEqual(d, { keys: 2, records: 1 });
	// Keys-only (records: []) keeps the stored records.
	const e = store.merge({ keys: [key(3, 4)], records: [] });
	assert.deepEqual(e, { keys: 3, records: 1 });
});

test("merge does not keep or mutate the caller's buffers", () => {
	const clock = new VirtualClock();
	const store = new VaultKeyStore(new FakeSecretStorage(), testVaultId("v1"), clock);
	const k = key(1, 5);
	store.merge({ keys: [k], records: [record(1)] });
	assert.ok(sameKeys([k], [key(1, 5)]), "caller's buffer untouched by merge");
	k.k.fill(0);
	assert.ok(sameKeys(store.load()!.keys, [key(1, 5)]), "the store kept its own encoding");
});

test("merge refuses bad keys, another vault's value and an unavailable store, with fixed secret-free text", () => {
	const clock = new VirtualClock();
	const backing = new Map<string, string>();
	const fake = new FakeSecretStorage(backing);
	const store = new VaultKeyStore(fake, testVaultId("v1"), clock);
	assert.throws(() => store.merge({ keys: [{ e: 1, k: new Uint8Array(16) }], records: [] }), (e: unknown) => e instanceof KeyStoreError && e.reason === "write-failed");
	assert.throws(() => store.merge({ keys: [{ e: 0, k: new Uint8Array(32) }], records: [] }), KeyStoreError);
	// A value written for another vault id under this id (should never happen): refused, never overwritten.
	const other = new VaultKeyStore(fake, testVaultId("v2"), clock);
	other.merge({ keys: [key(1, 1)], records: [record(1)] });
	backing.set(store.id, backing.get(other.id)!);
	assert.throws(() => store.merge({ keys: [key(1, 2)], records: [record(1)] }), (e: unknown) => e instanceof KeyStoreError && e.reason === "other-vault");
	assert.equal(store.load(), null);
	fake.available = false;
	const fresh = new VaultKeyStore(fake, testVaultId("v3"), clock);
	assert.throws(() => fresh.merge({ keys: [key(1, 3)], records: [record(1)] }), (e: unknown) => {
		if (!(e instanceof KeyStoreError) || e.reason !== "unavailable") return false;
		return !/[0-9a-f]{16}/.test(e.message);
	});
});

test("merge verifies by reading back (a store that drops writes is a write failure)", () => {
	const clock = new VirtualClock();
	const dropping = { setSecret() {}, getSecret: () => null, listSecrets: () => [] };
	const store = new VaultKeyStore(dropping, testVaultId("v1"), clock);
	assert.throws(() => store.merge({ keys: [key(1, 1)], records: [record(1)] }), (e: unknown) => e instanceof KeyStoreError && e.reason === "write-failed");
});

test("load() treats a malformed value as no value (fail closed)", () => {
	const clock = new VirtualClock();
	const backing = new Map<string, string>();
	const store = new VaultKeyStore(new FakeSecretStorage(backing), testVaultId("v1"), clock);
	for (const bad of ["", "{", "null", "[]", JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, vaultId: testVaultId("v1"), suite: 1, keys: [{ e: 1, k: "AAAA" }], records: [] }),
		JSON.stringify({ v: 1, vaultId: testVaultId("v1"), suite: 1, keys: [{ e: 1.5, k: "x" }], records: [] }), JSON.stringify({ v: 1, vaultId: testVaultId("v1"), suite: 0, keys: [], records: [] })]) {
		backing.set(store.id, bad);
		assert.equal(store.load(), null);
	}
});

test("forget() blanks the vault's secret (no delete API) and leaves other vaults alone", () => {
	const clock = new VirtualClock();
	const backing = new Map<string, string>();
	const fake = new FakeSecretStorage(backing);
	const a = new VaultKeyStore(fake, testVaultId("a"), clock);
	const b = new VaultKeyStore(fake, testVaultId("b"), clock);
	a.merge({ keys: [key(1, 1)], records: [record(1)] });
	b.merge({ keys: [key(1, 2)], records: [record(1)] });
	a.forget();
	assert.equal(backing.get(a.id), "");
	assert.equal(a.load(), null);
	assert.equal(b.holdsKeys(), true);
	const writes = fake.writes;
	new VaultKeyStore(fake, testVaultId("never-stored"), clock).forget();
	assert.equal(fake.writes, writes, "forget writes nothing for a vault that never stored");
});

test("plaintext(): reflects the runtime-only isEncryptionAvailable(), false when absent", () => {
	const clock = new VirtualClock();
	assert.equal(new VaultKeyStore(new FakeSecretStorage(new Map(), { encryption: false }), testVaultId("v"), clock).plaintext(), true);
	assert.equal(new VaultKeyStore(new FakeSecretStorage(), testVaultId("v"), clock).plaintext(), false);
	assert.equal(new VaultKeyStore({ setSecret() {}, getSecret: () => null, listSecrets: () => [] }, testVaultId("v"), clock).plaintext(), false);
});

test("FakeSecretStorage mirrors setSecret's id validation", () => {
	const fake = new FakeSecretStorage();
	assert.throws(() => fake.setSecret("Bad_Id", "x"));
	assert.throws(() => fake.setSecret("a".repeat(65), "x"));
	fake.setSecret(secretIdFor(testVaultId("v")), "x");
});
