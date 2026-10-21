/**
 * storeIdentity.ts (identity-per-store §2, §4): find the store's identity, or mint and register one for the next
 * store; the pending identity until the store exists; refusals; legacy cleanup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceId, VaultEpoch, VaultId } from "../../core/types";
import type { IdentityPort, RegisterOutcome } from "../../ports/identity";
import { simHashPort } from "../../sim/hash";
import { SeededRandom } from "../../sim/random";
import { MemStoragePort } from "../../sim/storage";
import type { YS } from "../store/repo";
import { dbName, DB_SCHEMA_VERSION, LEGACY_DB_NAME_PREFIX, STORE, STORE_SPECS } from "../store/schema";
import { deleteLegacyDbs, dropPending, IdentityRefused, mintCredentials, needsRepair, pendingDbName, resolveStoreIdentity, retireKeyHash, type ResolveDeps } from "./storeIdentity";

const VAULT = "vault-0000000000000001" as VaultId;
const EPOCH = "epoch-1" as VaultEpoch;

interface FakeServer extends IdentityPort {
	readonly calls: { deviceId: DeviceId; deviceToken: string; retireKeyHash: string }[];
	answers: RegisterOutcome[];
	used: string | null;
}

/** Answers `answers` in order, then ok. */
function server(answers: RegisterOutcome[] = []): FakeServer {
	const s: FakeServer = {
		calls: [],
		answers,
		used: null,
		register: async (c) => {
			s.calls.push({ ...c });
			return s.answers.shift() ?? { ok: true };
		},
		use: (t) => {
			s.used = t;
		},
	};
	return s;
}

const refuse = (reason: Extract<RegisterOutcome, { ok: false }>["reason"], retryAfterMs: number | null = null): RegisterOutcome => ({ ok: false, reason, retryAfterMs });

function deps(storage: MemStoragePort, identity: IdentityPort, installKey = "install-key-00000001", seed = 1): ResolveDeps {
	return { storage, random: new SeededRandom(seed), hash: simHashPort(), identity, vaultId: VAULT, installKey };
}

/** What LogEngine does when it creates the store (EngineOptions.store): drop the pending DB, write meta.identity. */
async function createStore(storage: MemStoragePort, installKey: string, c: { deviceId: DeviceId; deviceToken?: string; retireKey?: string }, createdAtMs = 1): Promise<string> {
	await dropPending(storage, VAULT, installKey);
	const name = dbName(VAULT, EPOCH, installKey);
	const db = await storage.open<YS>(name, DB_SCHEMA_VERSION, STORE_SPECS);
	try {
		await db.tx([STORE.meta], "readwrite", async (tx) => tx.put(STORE.meta, {
			key: "identity", vaultId: VAULT, vaultEpoch: EPOCH, deviceId: c.deviceId,
			...(c.deviceToken !== undefined ? { deviceToken: c.deviceToken } : {}), ...(c.retireKey !== undefined ? { retireKey: c.retireKey } : {}),
			schemaVersion: DB_SCHEMA_VERSION, clientVersion: "test", createdAtMs, recoveredFromMirror: false,
		}));
	} finally {
		db.close();
	}
	return name;
}

test("mint: 16-byte deviceId, 32-byte token and retire key (base64url); the server gets the retire key's SHA-256 hex", async () => {
	const c = mintCredentials(new SeededRandom(7));
	assert.match(c.deviceId, /^[A-Za-z0-9_-]{22}$/);
	assert.match(c.deviceToken, /^[A-Za-z0-9_-]{43}$/);
	assert.match(c.retireKey, /^[A-Za-z0-9_-]{43}$/);
	const storage = new MemStoragePort();
	const s = server();
	const id = await resolveStoreIdentity(deps(storage, s));
	assert.equal(id.source, "pending");
	assert.equal(id.epoch, undefined, "no store: connect first");
	assert.equal(s.calls.length, 1);
	assert.equal(s.calls[0]!.deviceId, id.creds.deviceId);
	assert.equal(s.calls[0]!.retireKeyHash, await retireKeyHash(simHashPort(), id.creds.retireKey));
	assert.match(s.calls[0]!.retireKeyHash, /^[0-9a-f]{64}$/);
	assert.ok(!JSON.stringify(s.calls).includes(id.creds.retireKey), "the retire key itself never leaves");
	assert.ok((await storage.listDatabases()).includes(pendingDbName(VAULT, "install-key-00000001")));
});

test("pending identity: a second start before the store exists reuses it (no second registration); creating the store consumes it", async () => {
	const storage = new MemStoragePort();
	const s = server();
	const first = await resolveStoreIdentity(deps(storage, s, undefined, 1));
	const again = await resolveStoreIdentity(deps(storage, s, undefined, 2));
	assert.deepEqual(again.creds, first.creds);
	assert.equal(s.calls.length, 1, "registered once");
	await createStore(storage, "install-key-00000001", first.creds);
	assert.ok(!(await storage.listDatabases()).some((n) => n.startsWith("yaos3-pending:")), "pending dropped before the store");
	const found = await resolveStoreIdentity(deps(storage, s, undefined, 3));
	assert.equal(found.source, "store");
	assert.deepEqual(found.creds, first.creds);
	assert.equal(found.epoch, EPOCH, "offline start from the one store");
	assert.equal(s.calls.length, 1, "a found store never registers");
});

test("network refusal keeps the minted identity: the retry registers the same one", async () => {
	const storage = new MemStoragePort();
	const s = server([refuse("network")]);
	await assert.rejects(resolveStoreIdentity(deps(storage, s)), (e: unknown) => e instanceof IdentityRefused && e.reason === "network");
	const id = await resolveStoreIdentity(deps(storage, s, undefined, 9));
	assert.equal(s.calls.length, 2);
	assert.equal(s.calls[0]!.deviceId, s.calls[1]!.deviceId);
	assert.equal(id.creds.deviceId, s.calls[0]!.deviceId);
});

test("device_exists / device_retired: mint again (up to 3 a start), then give up as device-exists", async () => {
	const storage = new MemStoragePort();
	const s = server([refuse("device-exists"), refuse("device-retired")]);
	const id = await resolveStoreIdentity(deps(storage, s));
	assert.equal(s.calls.length, 3);
	assert.equal(new Set(s.calls.map((c) => c.deviceId)).size, 3, "a new id each time");
	assert.equal(id.creds.deviceId, s.calls[2]!.deviceId);

	const storage2 = new MemStoragePort();
	const s2 = server([refuse("device-exists"), refuse("device-exists"), refuse("device-exists")]);
	await assert.rejects(resolveStoreIdentity(deps(storage2, s2)), (e: unknown) => e instanceof IdentityRefused && e.reason === "device-exists");
	assert.equal(s2.calls.length, 3);
});

test("refusals: only a re-pair fixes grant_revoked / unauthorized / grant_required / no grant; the limits carry Retry-After", async () => {
	for (const r of ["grant-revoked", "unauthorized", "grant-required", "no-grant"] as const) assert.ok(needsRepair(r), r);
	for (const r of ["network", "device-limit", "registration-limit", "rate-limited", "device-exists"] as const) assert.ok(!needsRepair(r), r);
	const storage = new MemStoragePort();
	const s = server([refuse("registration-limit", 3_600_000)]);
	await assert.rejects(resolveStoreIdentity(deps(storage, s)), (e: unknown) => e instanceof IdentityRefused && e.reason === "registration-limit" && e.retryAfterMs === 3_600_000);
	const s2 = server([refuse("grant-revoked")]);
	await assert.rejects(resolveStoreIdentity(deps(new MemStoragePort(), s2)), (e: unknown) => e instanceof IdentityRefused && e.reason === "grant-revoked");
});

test("same origin, two install keys (a vault copied on one machine): distinct identities, each finds only its own store", async () => {
	const storage = new MemStoragePort();
	const s = server();
	const a = await resolveStoreIdentity(deps(storage, s, "install-key-aaaaaaaa", 1));
	await createStore(storage, "install-key-aaaaaaaa", a.creds);
	const b = await resolveStoreIdentity(deps(storage, s, "install-key-bbbbbbbb", 2));
	assert.notEqual(b.creds.deviceId, a.creds.deviceId);
	assert.equal(b.source, "pending", "A's store is not B's");
	await createStore(storage, "install-key-bbbbbbbb", b.creds);
	assert.deepEqual((await resolveStoreIdentity(deps(storage, s, "install-key-aaaaaaaa", 3))).creds, a.creds);
	assert.deepEqual((await resolveStoreIdentity(deps(storage, s, "install-key-bbbbbbbb", 4))).creds, b.creds);
});

test("IndexedDB loss: the store and the pending DB go together; the next start mints a new identity", async () => {
	const storage = new MemStoragePort();
	const s = server();
	const first = await resolveStoreIdentity(deps(storage, s, undefined, 1));
	await createStore(storage, "install-key-00000001", first.creds);
	for (const n of await storage.listDatabases()) await storage.deleteDatabase(n);
	const next = await resolveStoreIdentity(deps(storage, s, undefined, 2));
	assert.equal(next.source, "pending");
	assert.notEqual(next.creds.deviceId, first.creds.deviceId);
	assert.equal(s.calls.length, 2);
});

test("a store without a usable identity (no token: not a grant install's) is deleted; the newest store's identity wins", async () => {
	const storage = new MemStoragePort();
	const s = server();
	const name = await createStore(storage, "install-key-00000001", { deviceId: "dev-old-000000000000" as DeviceId });
	const id = await resolveStoreIdentity(deps(storage, s));
	assert.equal(id.source, "pending");
	assert.ok(!(await storage.listDatabases()).includes(name), "the token-less store is gone");

	const storage2 = new MemStoragePort();
	const old = { deviceId: "dev-old-000000000000" as DeviceId, deviceToken: "t".repeat(43), retireKey: "r".repeat(43) };
	const nu = { deviceId: "dev-new-000000000000" as DeviceId, deviceToken: "u".repeat(43), retireKey: "s".repeat(43) };
	await createStore(storage2, "install-key-00000001", old, 1);
	const db = await storage2.open<YS>(dbName(VAULT, "epoch-2" as VaultEpoch, "install-key-00000001"), DB_SCHEMA_VERSION, STORE_SPECS);
	await db.tx([STORE.meta], "readwrite", async (tx) => tx.put(STORE.meta, { key: "identity", vaultId: VAULT, vaultEpoch: "epoch-2" as VaultEpoch, ...nu, schemaVersion: DB_SCHEMA_VERSION, clientVersion: "t", createdAtMs: 2, recoveredFromMirror: false }));
	db.close();
	const found = await resolveStoreIdentity(deps(storage2, server()));
	assert.deepEqual(found.creds, nu);
	assert.equal(found.epoch, undefined, "two epochs: connect first");
});

test("an epoch change's two stores: the new one names the old (supersedes) and wins whatever the wall clock said", async () => {
	// Sim seed 602 (3 devices, faults): the new epoch's store was created under a -42 h clock skew; the newest by
	// createdAtMs was the old, already retired store, and every start after failed unauthorized.
	const storage = new MemStoragePort();
	const old = { deviceId: "dev-old-000000000000" as DeviceId, deviceToken: "t".repeat(43), retireKey: "r".repeat(43) };
	const nu = { deviceId: "dev-new-000000000000" as DeviceId, deviceToken: "u".repeat(43), retireKey: "s".repeat(43) };
	await createStore(storage, "install-key-00000001", old, 5_000);
	const db = await storage.open<YS>(dbName(VAULT, "epoch-2" as VaultEpoch, "install-key-00000001"), DB_SCHEMA_VERSION, STORE_SPECS);
	await db.tx([STORE.meta], "readwrite", async (tx) => tx.put(STORE.meta, { key: "identity", vaultId: VAULT, vaultEpoch: "epoch-2" as VaultEpoch, ...nu, schemaVersion: DB_SCHEMA_VERSION, clientVersion: "t", createdAtMs: 1, recoveredFromMirror: false, supersedes: [old.deviceId] }));
	db.close();
	const found = await resolveStoreIdentity(deps(storage, server()));
	assert.deepEqual(found.creds, nu);
	assert.equal(found.epoch, undefined, "two epochs: connect first");
});

test("legacy cleanup: the identity-less yaos2:<vaultId>:* stores of this vault are deleted, nothing else", async () => {
	const storage = new MemStoragePort();
	const names = [`${LEGACY_DB_NAME_PREFIX}:${VAULT}:e1`, `${LEGACY_DB_NAME_PREFIX}:${VAULT}:e2`, `${LEGACY_DB_NAME_PREFIX}:other-vault:e1`, dbName(VAULT, EPOCH, "k")];
	for (const n of names) (await storage.open<YS>(n, DB_SCHEMA_VERSION, STORE_SPECS)).close();
	assert.equal(await deleteLegacyDbs(storage, VAULT), 2);
	assert.deepEqual([...(await storage.listDatabases())].sort(), [names[2]!, names[3]!].sort());
});
