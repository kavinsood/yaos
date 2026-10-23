// The key-roll signal (e2ee-design §14.5, relay-wire §3.2, §4.2, §4.3) through the real Router and vault hosts on Node
// SQLite: the operator's blocking removals ("Revoke pairing", "Revoke" of a device enrolled without a grant) count in
// `vault_meta.removals` in the revoke's own transaction and reach every remaining streams socket as VAULT_REKEY; a store
// removed under a live grant, a leave and a self-retire do not count; VAULT_READY carries the signal to a device that
// connects later; a device's VAULT_REKEYED covers removals up to the count it names (never above the vault's, never
// backwards); both counts survive a new runtime and a D8b restore to a point before the removal.
import assert from "node:assert/strict";

import { randomBase64Url } from "../../server/src/base64url";
import { sha256Hex } from "../../server/src/hex";
import { suite } from "../harness.ts";
import type { FakeSocket } from "./helpers/fakePorts.ts";
import { newDevice, type DeviceSeed, type VaultObject } from "./helpers/workerHarness.ts";
import { ORIGIN, claim, deviceFetch, enrollVia, json, ownerCode, resetRows, withWorld, type World } from "./helpers/operatorWorld.ts";

const s = suite("rekey-signal");

interface Store extends DeviceSeed {
	retireKeyHash: string;
}

async function newStore(deviceId: string): Promise<Store> {
	const retireKey = randomBase64Url(32);
	return { ...newDevice(deviceId), retireKeyHash: await sha256Hex(new TextEncoder().encode(retireKey)) };
}

const grantAuth = (secret: string): Record<string, string> => ({ Authorization: `Grant ${secret}` });

function vaultFetch(world: World, vaultId: string, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
	const { json: body, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (body !== undefined) headers.set("Content-Type", "application/json");
	return world.router.fetch(new Request(`${ORIGIN}/vault/${vaultId}/${path}`,
		{ ...rest, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), world.env);
}

/** A pairing grant with one registered store: its grantId and the store. */
async function pairStore(world: World, cookie: string, vaultId: string, deviceId: string, name: string):
	Promise<{ grantId: string; secret: string; store: Store }> {
	const secret = randomBase64Url(32);
	const code = (await json(await ownerCode(world, cookie, vaultId, "device"))).pairingCode as string;
	const enrolled = await world.fetch("/enroll", { method: "POST", origin: null,
		json: { pairingCode: code, enrollmentRequestId: `grant-request-${secret.slice(0, 8)}`, grantSecret: secret, grantName: name } });
	assert.equal(enrolled.status, 200, "grant enroll");
	const grantId = (await json(enrolled)).grantId as string;
	const store = await newStore(deviceId);
	const registered = await vaultFetch(world, vaultId, "auth/device", { method: "POST", headers: grantAuth(secret),
		json: { deviceId: store.deviceId, deviceToken: store.token, retireKeyHash: store.retireKeyHash } });
	assert.equal(registered.status, 200, "register");
	return { grantId, secret, store };
}

/** A streams socket of `deviceId`, opened on the vault host (the D6 seam). */
function connect(vault: VaultObject, deviceId: string): FakeSocket {
	assert.equal(vault.host.acceptStreams(deviceId).status, 200);
	return vault.registry.lastClient!;
}

function rekeyed(vault: VaultObject, socket: FakeSocket, removals: unknown): void {
	vault.host.webSocketMessage(socket, `__YPS:${JSON.stringify({ type: "VAULT_REKEYED", removals })}`);
}

function signal(vault: VaultObject): { removals: number; rekeyed: number } {
	const row = vault.storage.sql.exec<{ removals: number; rekeyed: number }>(
		"SELECT removals, rekeyed FROM vault_meta WHERE id = 1").toArray()[0]!;
	return { removals: row.removals, rekeyed: row.rekeyed };
}

const notices = (socket: FakeSocket) => socket.all("VAULT_REKEY").map(({ removals, rekeyed }) => ({ removals, rekeyed }));

s.test("Revoke pairing: + 1 removal in the revoke's turn; every remaining socket hears VAULT_REKEY, the victim does not", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const lost = await pairStore(world, cookie, vaultId, "lost-device-00001", "Lost laptop");
		const kept = await pairStore(world, cookie, vaultId, "kept-device-00001", "Phone");
		const keptSocket = connect(vault, kept.store.deviceId);
		assert.deepEqual(keptSocket.last("VAULT_READY")?.rekey, { removals: 0, rekeyed: 0 }, "VAULT_READY carries the signal");
		const lostSocket = connect(vault, lost.store.deviceId);

		resetRows(world);
		const response = await world.fetch(`/operator/vaults/${vaultId}/grants/${lost.grantId}`, { method: "DELETE", cookie });
		assert.equal(response.status, 200);
		assert.equal(lostSocket.closed?.code, 4403);
		assert.deepEqual(notices(lostSocket), [], "the removed device is closed before the notice");
		assert.deepEqual(notices(keptSocket), [{ removals: 1, rekeyed: 0 }], "event-driven: one notice at the removal");
		assert.deepEqual(signal(vault), { removals: 1, rekeyed: 0 });
		assert.deepEqual([...vault.model.totals.byTable].find(([table]) => table === "vault_meta"), ["vault_meta", 1]);

		// A device that was offline learns it at its next connect, from VAULT_READY; a new runtime reads it back.
		vault.restart();
		const later = connect(vault, kept.store.deviceId);
		assert.deepEqual(later.last("VAULT_READY")?.rekey, { removals: 1, rekeyed: 0 });
		// Idempotent: revoking the revoked pairing again counts nothing and says nothing.
		await world.fetch(`/operator/vaults/${vaultId}/grants/${lost.grantId}`, { method: "DELETE", cookie });
		assert.deepEqual(signal(vault), { removals: 1, rekeyed: 0 });
		assert.deepEqual(notices(later), []);
	});
});

s.test("Revoke of a device enrolled without a grant counts; a store removed under a live grant, a leave and a self-retire do not", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault, pairingCode } = await claim(world);
		const old = newDevice("old-enroll-device1");
		await enrollVia(world, pairingCode, old);
		const phone = await pairStore(world, cookie, vaultId, "phone-device-0001", "Phone");
		const tidy = await pairStore(world, cookie, vaultId, "tidy-device-00001", "Mac");
		const leaving = await pairStore(world, cookie, vaultId, "leave-device-0001", "Tablet");
		const selfRetire = await pairStore(world, cookie, vaultId, "self-device-00001", "Desk");
		const socket = connect(vault, phone.store.deviceId);

		// "Remove device" of a store whose install is still paired: it comes back as a new store (§3.4), no roll is due.
		assert.equal((await world.fetch(`/operator/vaults/${vaultId}/devices/${tidy.store.deviceId}`, { method: "DELETE", cookie })).status, 200);
		// The holder's own leave and self-retire: the install chose to go.
		assert.equal((await vaultFetch(world, vaultId, "auth/grant", { method: "DELETE", headers: grantAuth(leaving.secret) })).status, 200);
		assert.equal((await deviceFetch(world, vaultId, selfRetire.store, "auth/device", { method: "DELETE" })).status, 200);
		assert.deepEqual(signal(vault), { removals: 0, rekeyed: 0 });
		assert.deepEqual(notices(socket), []);

		// "Revoke" of an old enroll: it can never come back, so the removal blocks it.
		assert.equal((await world.fetch(`/operator/vaults/${vaultId}/devices/${old.deviceId}`, { method: "DELETE", cookie })).status, 200);
		assert.deepEqual(signal(vault), { removals: 1, rekeyed: 0 });
		assert.deepEqual(notices(socket), [{ removals: 1, rekeyed: 0 }]);
	});
});

s.test("VAULT_REKEYED covers removals up to its count: one row and one notice to every socket; late, repeated or bogus acks do nothing", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const a = await pairStore(world, cookie, vaultId, "device-a-00000001", "A");
		const b = await pairStore(world, cookie, vaultId, "device-b-00000001", "B");
		const gone1 = await pairStore(world, cookie, vaultId, "gone-device-00001", "Gone 1");
		const gone2 = await pairStore(world, cookie, vaultId, "gone-device-00002", "Gone 2");
		const socketA = connect(vault, a.store.deviceId);
		const socketB = connect(vault, b.store.deviceId);
		for (const gone of [gone1, gone2]) {
			assert.equal((await world.fetch(`/operator/vaults/${vaultId}/grants/${gone.grantId}`, { method: "DELETE", cookie })).status, 200);
		}
		assert.deepEqual(signal(vault), { removals: 2, rekeyed: 0 });

		for (const bogus of [0, -1, 3, 1.5, "1", null]) rekeyed(vault, socketA, bogus);
		assert.deepEqual(signal(vault), { removals: 2, rekeyed: 0 }, "a count the vault never had, or not a count");
		assert.equal(socketA.closed, null, "a bogus ack is ignored, not a protocol error");

		// A rolled the key after it had seen the first removal only: the second stays due.
		resetRows(world);
		rekeyed(vault, socketA, 1);
		assert.equal(vault.model.totals.cf, 1, "one meta row");
		assert.deepEqual(signal(vault), { removals: 2, rekeyed: 1 });
		assert.deepEqual(notices(socketB).at(-1), { removals: 2, rekeyed: 1 });
		assert.deepEqual(notices(socketA).at(-1), { removals: 2, rekeyed: 1 }, "the acking device hears it too");

		const before = [notices(socketA).length, notices(socketB).length];
		resetRows(world);
		rekeyed(vault, socketB, 1);
		assert.equal(vault.model.totals.cf, 0, "a repeated ack writes nothing");
		assert.deepEqual([notices(socketA).length, notices(socketB).length], before, "and says nothing");

		rekeyed(vault, socketB, 2);
		assert.deepEqual(signal(vault), { removals: 2, rekeyed: 2 });
		assert.deepEqual(notices(socketA).at(-1), { removals: 2, rekeyed: 2 }, "nothing is due any more");
		rekeyed(vault, socketA, 1);
		assert.deepEqual(signal(vault), { removals: 2, rekeyed: 2 }, "never backwards");

		vault.restart();
		assert.deepEqual(connect(vault, a.store.deviceId).last("VAULT_READY")?.rekey, { removals: 2, rekeyed: 2 });
	});
});

s.test("a removed device cannot ack: its socket is closed 4403 and its later messages are dropped", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const kept = await pairStore(world, cookie, vaultId, "kept-device-00001", "Phone");
		const lost = await pairStore(world, cookie, vaultId, "lost-device-00001", "Lost");
		connect(vault, kept.store.deviceId);
		const lostSocket = connect(vault, lost.store.deviceId);
		await world.fetch(`/operator/vaults/${vaultId}/grants/${lost.grantId}`, { method: "DELETE", cookie });
		rekeyed(vault, lostSocket, 1);
		assert.deepEqual(signal(vault), { removals: 1, rekeyed: 0 });
	});
});

s.test("D8b: a restore to a point before the removal keeps the removal and its ack state (authority, not content)", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const kept = await pairStore(world, cookie, vaultId, "kept-device-00001", "Phone");
		const lost = await pairStore(world, cookie, vaultId, "lost-device-00001", "Lost");
		const gone = await pairStore(world, cookie, vaultId, "gone-device-00001", "Gone");
		const advance = (ms: number) => {
			world.config.clock.now += ms;
			for (const object of world.cluster.objects.values()) object.timers.advance(ms);
		};
		advance(1000);
		const at = world.config.clock.now;
		vault.pitr!.capture(at);
		advance(10_000);
		for (const grant of [lost, gone]) {
			assert.equal((await world.fetch(`/operator/vaults/${vaultId}/grants/${grant.grantId}`, { method: "DELETE", cookie })).status, 200);
		}
		rekeyed(vault, connect(vault, kept.store.deviceId), 1);
		assert.deepEqual(signal(vault), { removals: 2, rekeyed: 1 });
		advance(1000);

		const restored = await world.fetch(`/operator/vaults/${vaultId}/restore`,
			{ method: "POST", cookie, json: { at: new Date(at).toISOString() } });
		assert.equal(restored.status, 200, "restore");
		assert.deepEqual(signal(vault), { removals: 2, rekeyed: 1 }, "the rewound meta row takes the pre-restore counts");
		assert.deepEqual(connect(vault, kept.store.deviceId).last("VAULT_READY")?.rekey, { removals: 2, rekeyed: 1 });
	}, { pitr: true });
});

await s.done();
