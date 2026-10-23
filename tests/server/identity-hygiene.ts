// Identity-per-store phase 5 (docs/client-remake/identity-per-store.md §3.4, §6.2; DECISIONS §10.1) through the real
// Router and vault hosts on Node SQLite:
// - inactivity retirement: a device whose last_seen_day is more than 90 UTC days old is retired (D7 + tombstone) by
//   the lazy sweep that registration, device status and the operator listing run; at most once a day per runtime, at
//   most INACTIVITY_RETIRE_BATCH devices a sweep, never a device with an open socket; the threshold's env override;
// - grant rotation: the operator's "Rotate secret" kills the old secret at once (every grant route 401), a live device
//   of the grant fetches the new one with its token (`GET /vault/:id/auth/grant`), the secret is kept only wrapped,
//   and survives a runtime restart and a D8b restore.
// Row counts are the CF model's (helpers/cfRowModel.ts).
import assert from "node:assert/strict";

import { randomBase64Url } from "../../server/src/base64url";
import { sha256Hex } from "../../server/src/hex";
import {
	DAY_MS,
	GRANT_REGISTRATIONS_PER_DAY,
	GRANT_SECRET_PATTERN,
	INACTIVITY_RETIRE_BATCH,
	INACTIVITY_RETIRE_DAYS,
	readInactivityRetireDays,
} from "../../server/src/vault/pairing";
import { suite } from "../harness.ts";
import { newDevice, type DeviceSeed, type VaultObject } from "./helpers/workerHarness.ts";
import { ORIGIN, claim, deviceFeed, deviceFetch, enrollVia, json, ownerCode, resetRows, withWorld, type World } from "./helpers/operatorWorld.ts";

const s = suite("identity-hygiene");

interface Store extends DeviceSeed {
	retireKey: string;
	retireKeyHash: string;
}

async function newStore(deviceId: string): Promise<Store> {
	const retireKey = randomBase64Url(32);
	return { ...newDevice(deviceId), retireKey, retireKeyHash: await sha256Hex(new TextEncoder().encode(retireKey)) };
}

function grantAuth(secret: string): Record<string, string> {
	return { Authorization: `Grant ${secret}` };
}

async function pair(world: World, cookie: string, vaultId: string, grantSecret: string, grantName = "Mac"): Promise<string> {
	const code = (await json(await ownerCode(world, cookie, vaultId, "device"))).pairingCode as string;
	const response = await world.fetch("/enroll", { method: "POST", origin: null,
		json: { pairingCode: code, enrollmentRequestId: `grant-request-${grantSecret.slice(0, 8)}`, grantSecret, grantName } });
	assert.equal(response.status, 200, "grant enroll");
	return (await json(response)).grantId as string;
}

function vaultFetch(world: World, vaultId: string, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
	const { json: body, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (body !== undefined) headers.set("Content-Type", "application/json");
	return world.router.fetch(new Request(`${ORIGIN}/vault/${vaultId}/${path}`,
		{ ...rest, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), world.env);
}

function register(world: World, vaultId: string, auth: Record<string, string>, store: Store): Promise<Response> {
	return vaultFetch(world, vaultId, "auth/device", { method: "POST", headers: auth,
		json: { deviceId: store.deviceId, deviceToken: store.token, retireKeyHash: store.retireKeyHash } });
}

async function registered(world: World, vaultId: string, auth: Record<string, string>, store: Store): Promise<void> {
	const response = await register(world, vaultId, auth, store);
	assert.equal(response.status, 200, `register ${store.deviceId}: ${await response.clone().text()}`);
}

function ticket(world: World, vaultId: string, device: DeviceSeed): Promise<Response> {
	return deviceFetch(world, vaultId, device, "auth/ticket",
		{ method: "POST", body: JSON.stringify({ purpose: "streams" }), headers: { "Content-Type": "application/json" } });
}

async function status(world: World, vaultId: string, asker: DeviceSeed, ids: string[]): Promise<Record<string, string>> {
	const response = await deviceFetch(world, vaultId, asker, "auth/device/status",
		{ method: "POST", body: JSON.stringify({ deviceIds: ids }), headers: { "Content-Type": "application/json" } });
	assert.equal(response.status, 200, "device status");
	const body = await json(response) as { devices: Array<{ deviceId: string; state: string }> };
	return Object.fromEntries(body.devices.map((d) => [d.deviceId, d.state]));
}

function listing(world: World, cookie: string, vaultId: string): Promise<Response> {
	return world.fetch(`/operator/vaults/${vaultId}/devices`, { cookie });
}

async function listedIds(world: World, cookie: string, vaultId: string): Promise<string[]> {
	const body = await json(await listing(world, cookie, vaultId)) as { devices: Array<{ deviceId: string }> };
	return body.devices.map((d) => d.deviceId).sort();
}

function rawCount(vault: VaultObject, table: string): number {
	return vault.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
}

function rotate(world: World, cookie: string, vaultId: string, grantId: string): Promise<Response> {
	return world.fetch(`/operator/vaults/${vaultId}/grants/${grantId}/rotate`, { method: "POST", cookie, json: {} });
}

function fetchGrant(world: World, vaultId: string, device: DeviceSeed): Promise<Response> {
	return deviceFetch(world, vaultId, device, "auth/grant");
}

// ---- inactivity retirement ------------------------------------------------------------------------------------------

s.test("§6.2 inactivity: not seen for more than 90 days → retired (D7 + tombstone) at the next device status; a connected one is kept and marked seen", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const secret = randomBase64Url(32);
		const grantId = await pair(world, cookie, vaultId, secret);
		// The creator of a body-less doc whose store was abandoned (a deleted clone, a wiped profile with no successor).
		const abandoned = await newStore("abandoned-store-01");
		const asker = await newStore("asking-store-00001");
		const connected = await newStore("connected-store-01");
		for (const store of [abandoned, asker, connected]) await registered(world, vaultId, grantAuth(secret), store);
		// An old enroll (no grant) never ticketed: its enroll day counts as seen.
		const legacy = newDevice("legacy-device-0001");
		await enrollVia(world, (await json(await ownerCode(world, cookie, vaultId, "device"))).pairingCode as string, legacy);
		assert.equal(vault.host.acceptStreams(connected.deviceId).status, 200, "connected keeps a socket open throughout");

		vault.timers.now += INACTIVITY_RETIRE_DAYS * DAY_MS;
		assert.equal((await ticket(world, vaultId, asker)).status, 200);
		resetRows(world);
		assert.deepEqual(await status(world, vaultId, asker, [abandoned.deviceId]), { [abandoned.deviceId]: "live" },
			"exactly 90 days: still live");
		assert.equal(vault.model.totals.cf, 0, "nothing stale, nothing written");

		vault.timers.now += DAY_MS;
		assert.equal((await ticket(world, vaultId, asker)).status, 200);
		resetRows(world);
		assert.deepEqual(await status(world, vaultId, asker, [abandoned.deviceId, connected.deviceId, legacy.deviceId]),
			{ [abandoned.deviceId]: "retired", [connected.deviceId]: "live", [legacy.deviceId]: "retired" },
			"91 days: the abandoned store and the old enroll are retired before the answer");
		assert.deepEqual([...vault.model.totals.byTable].sort(), [["device", 3], ["retired_device", 2]],
			"2 DELETE device + 2 tombstones, and the connected device's last_seen_day (1 UPDATE)");
		const tombstone = vault.storage.sql.exec<{ grant_id: string | null }>(
			"SELECT grant_id FROM retired_device WHERE device_id = ?", abandoned.deviceId).one();
		assert.equal(tombstone.grant_id, grantId);

		// Retired like every other retire path: bearer 401, never registers again.
		assert.equal((await deviceFeed(world, vaultId, abandoned)).status, 401);
		const back = await register(world, vaultId, grantAuth(secret), abandoned);
		assert.deepEqual([back.status, await json(back)], [409, { error: "device_retired" }]);
		assert.deepEqual(await listedIds(world, cookie, vaultId), [asker.deviceId, connected.deviceId].sort());

		// Once a day per runtime: a second status writes nothing.
		resetRows(world);
		await status(world, vaultId, asker, [abandoned.deviceId]);
		assert.equal(vault.model.totals.cf, 0, "swept today");

		// The connected device was marked seen at the sweep: it is not retired after its socket closes.
		vault.registry.list.length = 0;
		vault.timers.now += DAY_MS;
		assert.deepEqual(await status(world, vaultId, asker, [connected.deviceId]), { [connected.deviceId]: "live" });
	});
});

s.test("§6.2 inactivity: registration and the operator listing sweep too; a registered identity never used (a crash after an epoch mint) goes after 90 days", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const secret = randomBase64Url(32);
		await pair(world, cookie, vaultId, secret);
		// Registered, never ticketed: the pending identity of an epoch mint whose store was never created.
		const leftover = await newStore("leftover-store-001");
		await registered(world, vaultId, grantAuth(secret), leftover);
		vault.timers.now += (INACTIVITY_RETIRE_DAYS + 1) * DAY_MS;
		resetRows(world);
		await registered(world, vaultId, grantAuth(secret), await newStore("next-store-000001"));
		assert.deepEqual([...vault.model.totals.byTable].sort(), [["device", 2], ["pairing_grant", 1], ["retired_device", 1]],
			"the sweep's DELETE + tombstone, then the registration's INSERT + day counter");
		assert.equal(rawCount(vault, "retired_device"), 1);

		const listed = await newStore("listed-store-0001");
		await registered(world, vaultId, grantAuth(secret), listed);
		vault.timers.now += (INACTIVITY_RETIRE_DAYS + 1) * DAY_MS;
		assert.deepEqual(await listedIds(world, cookie, vaultId), [], "the listing retires stale stores before listing them");
		assert.equal(rawCount(vault, "retired_device"), 3);
	});
});

s.test("§6.2 inactivity: at most INACTIVITY_RETIRE_BATCH a sweep; the next trigger the same day goes on", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const total = INACTIVITY_RETIRE_BATCH + 10;
		const grants = Math.ceil(total / GRANT_REGISTRATIONS_PER_DAY);
		let n = 0;
		for (let g = 0; g < grants; g++) {
			const secret = randomBase64Url(32);
			await pair(world, cookie, vaultId, secret, `Device ${g}`);
			for (let i = 0; i < GRANT_REGISTRATIONS_PER_DAY && n < total; i++, n++) {
				await registered(world, vaultId, grantAuth(secret), await newStore(`batch-store-${String(n).padStart(5, "0")}`));
			}
		}
		vault.timers.now += (INACTIVITY_RETIRE_DAYS + 1) * DAY_MS;
		resetRows(world);
		assert.equal((await listedIds(world, cookie, vaultId)).length, 10, "one batch retired");
		assert.deepEqual([...vault.model.totals.byTable].sort(), [["device", INACTIVITY_RETIRE_BATCH], ["retired_device", INACTIVITY_RETIRE_BATCH]]);
		assert.equal(vault.transactions.count > 0, true);
		assert.deepEqual(await listedIds(world, cookie, vaultId), [], "the rest at the next trigger");
		assert.equal(rawCount(vault, "retired_device"), total);
	});
});

s.test("§6.2 inactivity: skipped while the daily limit is latched; the threshold override (VaultHostOptions, YAOS_INACTIVITY_RETIRE_DAYS)", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const secret = randomBase64Url(32);
		await pair(world, cookie, vaultId, secret);
		const stale = await newStore("stale-store-00001");
		const asker = await newStore("asker-store-00001");
		await registered(world, vaultId, grantAuth(secret), stale);
		await registered(world, vaultId, grantAuth(secret), asker);
		vault.timers.now += DAY_MS;
		assert.deepEqual(await status(world, vaultId, asker, [stale.deviceId]), { [stale.deviceId]: "live" }, "1 day: not more than 1");
		vault.timers.now += DAY_MS;
		assert.equal((await ticket(world, vaultId, asker)).status, 200);
		vault.host.latch.simulate(true);
		assert.deepEqual(await status(world, vaultId, asker, [stale.deviceId]), { [stale.deviceId]: "live" }, "latched: no sweep");
		vault.host.latch.simulate(false);
		assert.deepEqual(await status(world, vaultId, asker, [stale.deviceId]), { [stale.deviceId]: "retired" }, "a 1-day threshold");
	}, { inactivityRetireDays: 1 });
	assert.equal(readInactivityRetireDays(undefined), INACTIVITY_RETIRE_DAYS);
	assert.equal(INACTIVITY_RETIRE_DAYS, 90, "owner decision 4");
	assert.equal(readInactivityRetireDays(""), 90);
	assert.equal(readInactivityRetireDays("soon"), 90);
	assert.equal(readInactivityRetireDays("0"), 1);
	assert.equal(readInactivityRetireDays("7.9"), 7);
	assert.equal(readInactivityRetireDays("999999"), 3650);
});

// ---- grant rotation -------------------------------------------------------------------------------------------------

s.test("§3.4 rotate: the old secret is dead at once; a live device fetches the new one with its token; kept wrapped, 1 row", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const old = randomBase64Url(32);
		const grantId = await pair(world, cookie, vaultId, old, "Mac");
		const store = await newStore("rotating-store-01");
		await registered(world, vaultId, grantAuth(old), store);
		const never = await fetchGrant(world, vaultId, store);
		assert.deepEqual([never.status, await json(never)], [404, { error: "grant_secret_unavailable" }],
			"before a rotation the server holds only the hash of the client's secret");

		resetRows(world);
		const rotated = await rotate(world, cookie, vaultId, grantId);
		const rotatedText = await rotated.text();
		assert.deepEqual([rotated.status, JSON.parse(rotatedText)], [200, { ok: true, grantId, rotated: true }]);
		assert.deepEqual([...vault.model.totals.byTable], [["pairing_grant", 1]], "one UPDATE");

		// The old secret: unknown on every grant route (a copy of the old data.json registers nothing).
		const thief = await register(world, vaultId, grantAuth(old), await newStore("thief-store-00001"));
		assert.deepEqual([thief.status, await json(thief)], [401, { error: "unauthorized" }]);
		const code = await vaultFetch(world, vaultId, "auth/pairing-code", { method: "POST", headers: grantAuth(old), json: {} });
		assert.equal(code.status, 401);
		assert.equal((await vaultFetch(world, vaultId, "auth/grant", { method: "DELETE", headers: grantAuth(old) })).status, 401,
			"nor leave");

		// The live store: unaffected, and fetches the new secret.
		assert.equal((await ticket(world, vaultId, store)).status, 200);
		const fetched = await fetchGrant(world, vaultId, store);
		assert.equal(fetched.status, 200);
		const body = await json(fetched);
		assert.deepEqual(Object.keys(body).sort(), ["grantId", "grantName", "grantSecret"]);
		const fresh = body.grantSecret as string;
		assert.deepEqual([body.grantId, body.grantName], [grantId, "Mac"]);
		assert.match(fresh, GRANT_SECRET_PATTERN);
		assert.notEqual(fresh, old);
		assert.ok(!rotatedText.includes(fresh), "the operator answer never carries the secret");
		await registered(world, vaultId, grantAuth(fresh), await newStore("after-rotation-01"));
		assert.equal((await vaultFetch(world, vaultId, "auth/pairing-code", { method: "POST", headers: grantAuth(fresh), json: {} })).status, 200);

		// Stored: the new hash and a wrap that is not the secret; the listing carries neither.
		const row = vault.storage.sql.exec<{ secret_hash: ArrayBuffer; secret_wrap: ArrayBuffer }>(
			"SELECT secret_hash, secret_wrap FROM pairing_grant WHERE grant_id = ?", grantId).one();
		assert.equal(Buffer.from(row.secret_hash).toString("hex"), await sha256Hex(new TextEncoder().encode(fresh)));
		const wrap = Buffer.from(row.secret_wrap);
		assert.ok(!wrap.toString("latin1").includes(fresh) && !wrap.toString("hex").includes(Buffer.from(fresh).toString("hex")));
		const listed = await (await listing(world, cookie, vaultId)).text();
		assert.ok(!listed.includes(fresh) && !listed.includes(wrap.toString("hex")), "T-DEVICES-LIST");

		// Durable: a new runtime opens the wrap again.
		vault.restart();
		assert.equal((await json(await fetchGrant(world, vaultId, store))).grantSecret, fresh);
		// A second rotation: the first rotated secret dies too.
		await rotate(world, cookie, vaultId, grantId);
		const third = (await json(await fetchGrant(world, vaultId, store))).grantSecret as string;
		assert.notEqual(third, fresh);
		assert.equal((await register(world, vaultId, grantAuth(fresh), await newStore("stale-secret-0001"))).status, 401);
	});
});

s.test("§3.4 rotate: unknown or revoked grant → rotated:false, 0 rows; an old enroll's bearer gets 403; a revoked pairing's stores get 401", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const secret = randomBase64Url(32);
		const grantId = await pair(world, cookie, vaultId, secret);
		const store = await newStore("revoked-store-001");
		await registered(world, vaultId, grantAuth(secret), store);
		const legacy = newDevice("legacy-device-0002");
		await enrollVia(world, (await json(await ownerCode(world, cookie, vaultId, "device"))).pairingCode as string, legacy);
		const forbidden = await fetchGrant(world, vaultId, legacy);
		assert.deepEqual([forbidden.status, await json(forbidden)], [403, { error: "grant_required" }]);
		resetRows(world);
		const unknown = await rotate(world, cookie, vaultId, "UnknownGrantUnknown000");
		assert.deepEqual(await json(unknown), { ok: true, grantId: "UnknownGrantUnknown000", rotated: false });
		assert.equal((await world.fetch(`/operator/vaults/${vaultId}/grants/not-a-grant/rotate`, { method: "POST", cookie, json: {} })).status, 404);
		assert.equal((await world.fetch(`/operator/vaults/${vaultId}/grants/${grantId}/rotate`, { method: "POST", json: {} })).status, 401,
			"operator session required");
		assert.equal(vault.model.totals.cf, 0);
		assert.equal((await world.fetch(`/operator/vaults/${vaultId}/grants/${grantId}`, { method: "DELETE", cookie, json: {} })).status, 200);
		resetRows(world);
		assert.deepEqual(await json(await rotate(world, cookie, vaultId, grantId)), { ok: true, grantId, rotated: false });
		assert.equal(vault.model.totals.cf, 0);
		assert.equal((await fetchGrant(world, vaultId, store)).status, 401, "its stores are retired with the pairing");
		assert.deepEqual(world.cluster.rpcs.filter((r) => r.method === "rotateGrant").length, 2);
	});
});

s.test("§3.4 rotate × D8b: a rotation after T survives the restore (a restore never rewinds authority)", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const old = randomBase64Url(32);
		const grantId = await pair(world, cookie, vaultId, old);
		const store = await newStore("restore-store-0001");
		await registered(world, vaultId, grantAuth(old), store);
		const advance = (ms: number) => {
			world.config.clock.now += ms;
			for (const object of world.cluster.objects.values()) object.timers.advance(ms);
		};
		advance(1000);
		const at = world.config.clock.now;
		vault.pitr!.capture(at);
		advance(10_000);
		assert.equal((await rotate(world, cookie, vaultId, grantId)).status, 200);
		const fresh = (await json(await fetchGrant(world, vaultId, store))).grantSecret as string;
		advance(1000);
		const restored = await world.fetch(`/operator/vaults/${vaultId}/restore`, { method: "POST", cookie, json: { at: new Date(at).toISOString() } });
		assert.equal(restored.status, 200, "restore");
		assert.equal((await register(world, vaultId, grantAuth(old), await newStore("old-secret-store1"))).status, 401,
			"the old secret stays dead");
		assert.equal((await json(await fetchGrant(world, vaultId, store))).grantSecret, fresh, "the wrap crossed the rewind");
	}, { pitr: true });
});

s.test("T-HOTPATH: GET /vault/:id/auth/grant makes zero config-DO calls", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId } = await claim(world);
		const secret = randomBase64Url(32);
		await pair(world, cookie, vaultId, secret);
		const store = await newStore("hotpath-store-001");
		await registered(world, vaultId, grantAuth(secret), store);
		world.accesses.length = 0;
		assert.equal((await fetchGrant(world, vaultId, store)).status, 404);
		assert.deepEqual(world.accesses, []);
	});
});

await s.done();
