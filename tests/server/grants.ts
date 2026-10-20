// Identity-per-store phase 1 (docs/client-remake/identity-per-store.md §3, §6, §10) through the real Router and vault
// hosts on Node SQLite: the grant enroll and its D3 replay, register (distinct ids, idempotency, device_exists, the
// grant name), the per-grant limits (20 a UTC day, 50 live, the D3 failure limiter for wrong secrets), tombstones
// (self-retire, retire by key, operator remove: never back through register or the old enroll, refused at auth, at the
// socket upgrade and on append), grant revocation (leave and "Revoke pairing": the grant's devices are retired at once,
// other grants untouched, register and pairing codes answer `401 grant_revoked`), pairing codes minted with the grant
// secret, `last_seen_day` (one write a device a UTC day), the operator listing (no secret material), zero config-DO
// calls on the new device routes, and a D8b restore that keeps a revoked grant and a tombstone. Row counts are the CF
// model's (helpers/cfRowModel.ts).
import assert from "node:assert/strict";

import { randomBase64Url } from "../../server/src/base64url";
import { sha256Hex } from "../../server/src/hex";
import { encodeAppendFrame } from "../../server/src/streams/protocol";
import { DAY_MS, GRANT_LIVE_DEVICE_LIMIT, GRANT_REGISTRATIONS_PER_DAY, ENROLL_FAILURE_LIMIT } from "../../server/src/vault/pairing";
import { suite } from "../harness.ts";
import { newDevice, type DeviceSeed, type VaultObject } from "./helpers/workerHarness.ts";
import {
	ORIGIN,
	claim,
	deviceFeed,
	deviceFetch,
	enrollVia,
	json,
	ownerCode,
	resetRows,
	withWorld,
	type World,
} from "./helpers/operatorWorld.ts";

const s = suite("grants");

const GRANT_ENROLL_FIELDS = ["grantId", "grantName", "grantSecret", "host", "vaultGeneration", "vaultId"];

/** A store's identity as the phase-2 worker will mint it: deviceId, token and retire key (with its SHA-256). */
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

function grantEnroll(world: World, pairingCode: string, grantSecret: string, grantName = "Mac",
	enrollmentRequestId = `grant-request-${grantSecret.slice(0, 8)}`): Promise<Response> {
	return world.fetch("/enroll", { method: "POST", origin: null,
		json: { pairingCode, enrollmentRequestId, grantSecret, grantName } });
}

/** A grant enroll that must succeed: the grant's id. */
async function pair(world: World, cookie: string, vaultId: string, grantSecret: string, grantName = "Mac"): Promise<string> {
	const code = (await json(await ownerCode(world, cookie, vaultId, "device"))).pairingCode as string;
	const response = await grantEnroll(world, code, grantSecret, grantName);
	assert.equal(response.status, 200, "grant enroll");
	return (await json(response)).grantId as string;
}

function vaultFetch(world: World, vaultId: string, path: string, init: RequestInit & { json?: unknown } = {}):
	Promise<Response> {
	const { json: body, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (body !== undefined) headers.set("Content-Type", "application/json");
	return world.router.fetch(new Request(`${ORIGIN}/vault/${vaultId}/${path}`,
		{ ...rest, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), world.env);
}

function register(world: World, vaultId: string, auth: Record<string, string>, store: Store,
	body: Record<string, unknown> = {}): Promise<Response> {
	return vaultFetch(world, vaultId, "auth/device", { method: "POST", headers: auth,
		json: { deviceId: store.deviceId, deviceToken: store.token, retireKeyHash: store.retireKeyHash, ...body } });
}

async function registered(world: World, vaultId: string, auth: Record<string, string>, store: Store):
	Promise<Record<string, unknown>> {
	const response = await register(world, vaultId, auth, store);
	assert.equal(response.status, 200, `register ${store.deviceId}`);
	return await json(response);
}

function ticket(world: World, vaultId: string, device: DeviceSeed): Promise<Response> {
	return deviceFetch(world, vaultId, device, "auth/ticket",
		{ method: "POST", body: JSON.stringify({ purpose: "streams" }), headers: { "Content-Type": "application/json" } });
}

function appendBytes(stream: string, clientFrameId: string): ArrayBuffer {
	const frame = encodeAppendFrame({ stream, clientFrameId, payload: new Uint8Array([1]) });
	return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer;
}

function rawCount(vault: VaultObject, table: string): number {
	return vault.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
}

function listing(world: World, cookie: string, vaultId: string): Promise<Response> {
	return world.fetch(`/operator/vaults/${vaultId}/devices`, { cookie });
}

// ---- grant enroll ---------------------------------------------------------------------------------------------------

s.test("§3.2 grant enroll: 200 {host, vaultId, grantId, grantSecret, grantName, vaultGeneration}, 2 rows, hash only; the D3 replay", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const code = (await json(await ownerCode(world, cookie, vaultId, "device"))).pairingCode as string;
		const secret = randomBase64Url(32);
		resetRows(world);
		const response = await grantEnroll(world, code, secret, "  Mac  ", "grant-request-0001");
		assert.equal(response.status, 200);
		const body = await json(response);
		assert.deepEqual(Object.keys(body).sort(), GRANT_ENROLL_FIELDS);
		assert.match(body.grantId as string, /^[A-Za-z0-9_-]{22}$/, "server-minted base64url(16 B)");
		assert.deepEqual({ ...body, grantId: "" }, { host: ORIGIN, vaultId, grantId: "", grantSecret: secret, grantName: "Mac",
			vaultGeneration: vault.host.load()!.meta.vaultGeneration });
		assert.equal(vault.model.totals.cf, 2, "UPDATE pairing_code + INSERT pairing_grant");
		assert.deepEqual([...vault.model.totals.byTable], [["pairing_code", 1], ["pairing_grant", 1]]);
		assert.equal(rawCount(vault, "device"), 0, "no device is registered by the enroll");
		const stored = JSON.stringify(vault.storage.sql.exec("SELECT grant_id, grant_name, enrollment_request_id FROM pairing_grant").toArray())
			+ Buffer.from(vault.storage.sql.exec<{ secret_hash: ArrayBuffer }>("SELECT secret_hash FROM pairing_grant").one().secret_hash).toString("hex");
		assert.ok(!stored.includes(secret), "only SHA-256(grantSecret) is stored");
		assert.ok(stored.includes(await sha256Hex(new TextEncoder().encode(secret))));

		// D3 replay: the same code + request id + secret → the same 200, 0 rows; another secret → conflict.
		resetRows(world);
		const again = await grantEnroll(world, code, secret, "Renamed", "grant-request-0001");
		assert.deepEqual([again.status, await json(again)], [200, body], "replay (the name is not part of the key)");
		const conflict = await grantEnroll(world, code, randomBase64Url(32), "Mac", "grant-request-0001");
		assert.deepEqual([conflict.status, await json(conflict)], [409, { error: "enrollment_request_conflict" }]);
		const oldShape = await world.fetch("/enroll", { method: "POST", origin: null, json: { pairingCode: code,
			enrollmentRequestId: "grant-request-0001", deviceId: "device-under-id-01", deviceToken: newDevice("x").token } });
		assert.deepEqual([oldShape.status, await json(oldShape)], [409, { error: "enrollment_request_conflict" }],
			"the old body under the grant enroll's request id");
		const otherRequest = await grantEnroll(world, code, secret, "Mac", "grant-request-0002");
		assert.deepEqual([otherRequest.status, await json(otherRequest)], [409, { error: "used_code" }]);
		assert.equal(vault.model.totals.cf, 0, "replays and conflicts write nothing");

		// A second pairing named alike gets the legacy unique name; a secret already used is refused.
		const second = await grantEnroll(world, (await json(await ownerCode(world, cookie, vaultId, "device"))).pairingCode as string,
			randomBase64Url(32), "Mac");
		assert.equal((await json(second)).grantName, "Mac 2");
		const reused = await grantEnroll(world, (await json(await ownerCode(world, cookie, vaultId, "device"))).pairingCode as string,
			secret, "Mac");
		assert.deepEqual([reused.status, await json(reused)], [409, { error: "grant_exists" }]);

		// Malformed: a short secret, both bodies at once.
		const fresh = (await json(await ownerCode(world, cookie, vaultId, "device"))).pairingCode as string;
		for (const bad of [{ grantSecret: "short" }, { grantSecret: randomBase64Url(32), deviceId: "device-under-id-01" },
			{ grantSecret: 42 }]) {
			const refused = await world.fetch("/enroll", { method: "POST", origin: null,
				json: { pairingCode: fresh, enrollmentRequestId: "grant-request-0009", ...bad } });
			assert.deepEqual([refused.status, await json(refused)], [400, { error: "invalid enrollment request" }]);
		}

		// The replay of a revoked grant is used_code (a replay never resurrects a pairing).
		await vaultFetch(world, vaultId, "auth/grant", { method: "DELETE", headers: grantAuth(secret) });
		const revoked = await grantEnroll(world, code, secret, "Mac", "grant-request-0001");
		assert.deepEqual([revoked.status, await json(revoked)], [409, { error: "used_code" }]);
	});
});

s.test("phase 1 is additive: the old /enroll body still enrolls a device beside grants, as the current client sends it", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, pairingCode } = await claim(world);
		const laptop = newDevice("laptop-device-0001", "Laptop");
		const body = await enrollVia(world, pairingCode, laptop);
		assert.deepEqual(Object.keys(body).sort(), ["deviceId", "deviceName", "deviceToken", "host", "vaultGeneration", "vaultId"]);
		await pair(world, cookie, vaultId, randomBase64Url(32), "Laptop");
		assert.equal((await deviceFeed(world, vaultId, laptop)).status, 200);
		const list = await json(await listing(world, cookie, vaultId));
		assert.deepEqual((list.grants as Array<{ name: string }>).map((grant) => grant.name), ["Laptop 2"],
			"grant names avoid the names of devices enrolled without a grant");
		// The old device has no grant: it cannot register stores, but it still mints codes and self-retires.
		const store = await newStore("store-device-0001");
		const refused = await register(world, vaultId, { Authorization: `Bearer ${laptop.token}` }, store);
		assert.deepEqual([refused.status, await json(refused)], [403, { error: "grant_required" }]);
		const code = await deviceFetch(world, vaultId, laptop, "auth/pairing-code", { method: "POST", body: "{}" });
		assert.equal(code.status, 200);
		const retired = await deviceFetch(world, vaultId, laptop, "auth/device", { method: "DELETE" });
		assert.deepEqual([retired.status, await json(retired)], [200, { ok: true, deviceId: laptop.deviceId, retired: true }],
			"the route the current client's retireDeviceEnrollment calls");
		const twice = await deviceFetch(world, vaultId, laptop, "auth/device", { method: "DELETE" });
		assert.equal(twice.status, 401, "the client counts 401 as done");
	});
});

// ---- register -------------------------------------------------------------------------------------------------------

s.test("§3.2 register: one grant mints distinct device ids (two clones), 2 rows, idempotent; device_exists; the grant's name", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const secret = randomBase64Url(32);
		const grantId = await pair(world, cookie, vaultId, secret, "Mac");
		const a = await newStore("store-device-000a");
		const b = await newStore("store-device-000b");
		resetRows(world);
		const first = await registered(world, vaultId, grantAuth(secret), a);
		assert.deepEqual(first, { vaultId, deviceId: a.deviceId, deviceName: "Mac", grantId,
			vaultGeneration: vault.host.load()!.meta.vaultGeneration }, "no token material in the answer");
		assert.equal(vault.model.totals.cf, 2, "INSERT device + UPDATE the grant's day counter");
		assert.deepEqual([...vault.model.totals.byTable], [["device", 1], ["pairing_grant", 1]]);
		// The same data.json on another install (a clone): its own store, its own id, both live.
		await registered(world, vaultId, grantAuth(secret), b);
		for (const store of [a, b]) assert.equal((await deviceFeed(world, vaultId, store)).status, 200, store.deviceId);
		assert.notEqual(a.deviceId, b.deviceId);

		resetRows(world);
		assert.deepEqual(await registered(world, vaultId, grantAuth(secret), a), first, "idempotent retry");
		assert.equal(vault.model.totals.cf, 0, "a retry writes nothing (and does not count against the day)");
		for (const [label, store] of [["the id with another token", { ...a, token: randomBase64Url(32) }],
			["the id with another retire key", { ...a, retireKeyHash: "0".repeat(64) }],
			["another id with a's token", { ...(await newStore("store-device-000c")), token: a.token }]] as const) {
			const response = await register(world, vaultId, grantAuth(secret), store);
			assert.deepEqual([response.status, await json(response)], [409, { error: "device_exists" }], label);
		}
		// A live store of the grant registers its successor with its bearer (the epoch migration's path, §4).
		const c = await newStore("store-device-000d");
		assert.equal((await registered(world, vaultId, { Authorization: `Bearer ${a.token}` }, c)).grantId, grantId);
		assert.equal(vault.host.load()!.devices.byId(c.deviceId)!.grantId, grantId);

		// Credentials and bodies.
		const d = await newStore("store-device-000e");
		for (const [label, auth, status, error] of [
			["no credential", {}, 401, "unauthorized"],
			["a wrong grant secret", grantAuth(randomBase64Url(32)), 401, "unauthorized"],
			["the grant secret as a bearer", { Authorization: `Bearer ${secret}` }, 401, "unauthorized"],
			["an unknown bearer", { Authorization: `Bearer ${randomBase64Url(32)}` }, 401, "unauthorized"],
		] as const) {
			const response = await register(world, vaultId, auth, d);
			assert.deepEqual([response.status, await json(response)], [status, { error }], label);
		}
		for (const bad of [{ deviceId: "short" }, { deviceToken: "x" }, { retireKeyHash: "A".repeat(64) }, { retireKeyHash: undefined }]) {
			const response = await register(world, vaultId, grantAuth(secret), d, bad);
			assert.deepEqual([response.status, await json(response)], [400, { error: "invalid_request" }], JSON.stringify(bad));
		}
		const unknownVault = await register(world, "AAAAAAAAAAAAAAAAAAAAAA", grantAuth(secret), d);
		assert.deepEqual([unknownVault.status, await json(unknownVault)], [401, { error: "unauthorized" }], "§2.2: no oracle");
	});
});

s.test("§3.3 limits: 20 registrations a UTC day (429 + Retry-After to midnight), 50 live devices, wrong secrets hit the D3 limiter", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const secret = randomBase64Url(32);
		await pair(world, cookie, vaultId, secret);
		// Start at a known instant: 6 h before a UTC midnight.
		vault.timers.now = (Math.floor(vault.timers.now / DAY_MS) + 1) * DAY_MS - 6 * 3600_000;
		const stores: Store[] = [];
		let next = 0;
		const fresh = async () => newStore(`limit-device-${String(next++).padStart(4, "0")}`);
		for (let i = 0; i < GRANT_REGISTRATIONS_PER_DAY; i++) {
			const store = await fresh();
			await registered(world, vaultId, grantAuth(secret), store);
			stores.push(store);
		}
		resetRows(world);
		const over = await register(world, vaultId, grantAuth(secret), await fresh());
		assert.deepEqual([over.status, await json(over)], [429, { error: "registration_limit" }]);
		assert.equal(over.headers.get("Retry-After"), String(6 * 3600), "until the next UTC midnight");
		assert.equal(vault.model.totals.cf, 0);
		assert.equal((await register(world, vaultId, grantAuth(secret), stores[0]!)).status, 200, "an idempotent retry still answers");
		// Another grant has its own day.
		const other = randomBase64Url(32);
		await pair(world, cookie, vaultId, other, "Phone");
		assert.equal((await register(world, vaultId, grantAuth(other), await fresh())).status, 200);
		// The next UTC day: 20 more; then the live cap.
		while (stores.length < GRANT_LIVE_DEVICE_LIMIT) {
			vault.timers.now += DAY_MS;
			for (let i = 0; i < GRANT_REGISTRATIONS_PER_DAY && stores.length < GRANT_LIVE_DEVICE_LIMIT; i++) {
				const store = await fresh();
				await registered(world, vaultId, grantAuth(secret), store);
				stores.push(store);
			}
		}
		const capped = await register(world, vaultId, grantAuth(secret), await fresh());
		assert.deepEqual([capped.status, await json(capped)], [409, { error: "device_limit" }], "50 live devices");
		// Retiring one frees a slot.
		const retired = await deviceFetch(world, vaultId, stores[0]!, "auth/device", { method: "DELETE" });
		assert.equal(retired.status, 200);
		assert.equal((await register(world, vaultId, grantAuth(secret), await fresh())).status, 200);

		// D3 limiter: wrong grant secrets are failures; the 21st attempt in the minute is 429 even with the right one.
		for (let i = 0; i < ENROLL_FAILURE_LIMIT; i++) {
			assert.equal((await register(world, vaultId, grantAuth(randomBase64Url(32)), await fresh())).status, 401);
		}
		const limited = await register(world, vaultId, grantAuth(other), await fresh());
		assert.deepEqual([limited.status, await json(limited)], [429, { error: "too_many_attempts" }]);
		assert.ok(Number(limited.headers.get("Retry-After")) >= 1);
		vault.timers.now += 60_000;
		assert.equal((await register(world, vaultId, grantAuth(other), await fresh())).status, 200, "the window resets");
	});
});

// ---- tombstones -----------------------------------------------------------------------------------------------------

s.test("§3.3 tombstones: a self-retired, key-retired or operator-removed id is refused at auth, upgrade and append, and never registers or enrolls again", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const secret = randomBase64Url(32);
		await pair(world, cookie, vaultId, secret);
		const peer = await newStore("peer-device-00001");
		const self = await newStore("self-device-00001");
		const fenced = await newStore("fenced-device-001");
		const removed = await newStore("removed-device-01");
		for (const store of [peer, self, fenced, removed]) await registered(world, vaultId, grantAuth(secret), store);
		const peerTicket = (await json(await ticket(world, vaultId, peer))).ticket as string;
		assert.ok(peerTicket);
		const selfTicket = (await json(await ticket(world, vaultId, self))).ticket as string;
		assert.equal(vault.host.acceptStreams(self.deviceId).status, 200);
		const socket = vault.registry.lastClient!;

		// Self-retire: 2 rows (row + tombstone), the socket 4403 before the answer.
		resetRows(world);
		const retired = await deviceFetch(world, vaultId, self, "auth/device", { method: "DELETE" });
		assert.deepEqual([retired.status, await json(retired)], [200, { ok: true, deviceId: self.deviceId, retired: true }]);
		assert.deepEqual([...vault.model.totals.byTable], [["device", 1], ["retired_device", 1]]);
		assert.equal(socket.closed?.code, 4403);
		// A frame the runtime still delivers from that socket is refused before buffering (validateActor).
		vault.host.webSocketMessage(socket, appendBytes("ns", "late-frame"));
		assert.equal(vault.host.relay.pendingFrames(), 0, "append refused");
		vault.upgrades.rejected.length = 0;
		const upgrade = await vaultFetch(world, vaultId, `ws/streams?streamsVersion=1&ticket=${encodeURIComponent(selfTicket)}`,
			{ headers: { Upgrade: "websocket" } });
		assert.equal(upgrade.headers.get("X-Test-Upgrade"), "rejected", "an unexpired ticket of a retired id opens nothing");
		assert.throws(() => vault.host.acceptStreams(self.deviceId), /unknown vault or device/);
		for (const path of ["streams/feed", "streams/read?stream=ns"]) {
			assert.equal((await deviceFetch(world, vaultId, self, path)).status, 401, path);
		}
		assert.equal((await ticket(world, vaultId, self)).status, 401);

		// Retire by key (the successor fence): wrong key 401, right key 200, again 200 retired:false.
		const wrong = await vaultFetch(world, vaultId, "auth/device/retire", { method: "POST",
			json: { deviceId: fenced.deviceId, retireKey: randomBase64Url(32) } });
		assert.deepEqual([wrong.status, await json(wrong)], [401, { error: "unauthorized" }]);
		const bearerKey = await vaultFetch(world, vaultId, "auth/device/retire", { method: "POST",
			json: { deviceId: fenced.deviceId, retireKey: fenced.token } });
		assert.equal(bearerKey.status, 401, "the device token is not its retire key");
		resetRows(world);
		const fence = await vaultFetch(world, vaultId, "auth/device/retire", { method: "POST",
			json: { deviceId: fenced.deviceId, retireKey: fenced.retireKey } });
		assert.deepEqual([fence.status, await json(fence)], [200, { ok: true, deviceId: fenced.deviceId, retired: true }]);
		assert.equal(vault.model.totals.cf, 2);
		for (const deviceId of [fenced.deviceId, "never-registered-01"]) {
			const gone = await vaultFetch(world, vaultId, "auth/device/retire", { method: "POST",
				json: { deviceId, retireKey: fenced.retireKey } });
			assert.deepEqual([gone.status, await json(gone)], [200, { ok: true, deviceId, retired: false }], "already gone = done");
		}
		const malformed = await vaultFetch(world, vaultId, "auth/device/retire", { method: "POST", json: { deviceId: fenced.deviceId } });
		assert.deepEqual([malformed.status, await json(malformed)], [400, { error: "invalid_request" }]);
		assert.equal((await deviceFeed(world, vaultId, fenced)).status, 401);

		// Operator "Remove device": tombstoned too; the install's grant registers a new store (§3.4).
		const remove = await world.fetch(`/operator/vaults/${vaultId}/devices/${removed.deviceId}`, { method: "DELETE", cookie });
		assert.deepEqual(await json(remove), { ok: true, deviceId: removed.deviceId, revoked: true });
		assert.equal((await registered(world, vaultId, grantAuth(secret), await newStore("removed-device-02"))).deviceId,
			"removed-device-02");

		// Never again: register (same or new token), the old enroll, after a restart too.
		vault.restart();
		for (const store of [self, fenced, removed]) {
			for (const candidate of [store, { ...store, token: randomBase64Url(32) }]) {
				const response = await register(world, vaultId, grantAuth(secret), candidate);
				assert.deepEqual([response.status, await json(response)], [409, { error: "device_retired" }], store.deviceId);
			}
			const code = (await json(await ownerCode(world, cookie, vaultId, "device"))).pairingCode as string;
			const enroll = await world.fetch("/enroll", { method: "POST", origin: null, json: { pairingCode: code,
				enrollmentRequestId: `enroll-${store.deviceId}`, deviceId: store.deviceId, deviceToken: randomBase64Url(32) } });
			assert.deepEqual([enroll.status, await json(enroll)], [409, { error: "device_retired" }], `old enroll ${store.deviceId}`);
		}
		assert.equal(rawCount(vault, "retired_device"), 3);
		assert.equal((await deviceFeed(world, vaultId, peer)).status, 200, "the peer is untouched");
	});
});

// ---- revocation -----------------------------------------------------------------------------------------------------

s.test("§3.4 revocation: leave and Revoke pairing retire the grant's devices at once; register and codes → 401 grant_revoked; other grants untouched", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const lost = randomBase64Url(32);
		const kept = randomBase64Url(32);
		const lostId = await pair(world, cookie, vaultId, lost, "Lost laptop");
		await pair(world, cookie, vaultId, kept, "Phone");
		const thief = [await newStore("thief-device-0001"), await newStore("thief-device-0002")];
		for (const store of thief) await registered(world, vaultId, grantAuth(lost), store);
		const phone = await newStore("phone-device-0001");
		await registered(world, vaultId, grantAuth(kept), phone);
		assert.equal(vault.host.acceptStreams(thief[0]!.deviceId).status, 200);
		const socket = vault.registry.lastClient!;
		vault.host.webSocketMessage(socket, appendBytes("ns", "buffered-thief-frame"));
		assert.equal(vault.host.relay.pendingFrames(), 1);

		// Operator "Revoke pairing" through the Worker: one turn, 1 + 2·D rows, sockets closed before the answer.
		resetRows(world);
		const response = await world.fetch(`/operator/vaults/${vaultId}/grants/${lostId}`, { method: "DELETE", cookie });
		assert.deepEqual([response.status, await json(response)],
			[200, { ok: true, grantId: lostId, revoked: true, retiredDevices: 2 }]);
		assert.equal(vault.model.totals.cf, 1 + 2 * 2);
		assert.deepEqual([...vault.model.totals.byTable], [["pairing_grant", 1], ["device", 2], ["retired_device", 2]]);
		assert.equal(socket.closed?.code, 4403);
		assert.equal(vault.host.relay.pendingFrames(), 0, "its buffered frames are dropped, never committed");
		for (const store of thief) assert.equal((await deviceFeed(world, vaultId, store)).status, 401, store.deviceId);
		const again = await register(world, vaultId, grantAuth(lost), await newStore("thief-device-0003"));
		assert.deepEqual([again.status, await json(again)], [401, { error: "grant_revoked" }], "the install falls back to unpaired");
		const code = await vaultFetch(world, vaultId, "auth/pairing-code", { method: "POST", headers: grantAuth(lost), json: {} });
		assert.deepEqual([code.status, await json(code)], [401, { error: "grant_revoked" }]);
		const idempotent = await world.fetch(`/operator/vaults/${vaultId}/grants/${lostId}`, { method: "DELETE", cookie });
		assert.deepEqual(await json(idempotent), { ok: true, grantId: lostId, revoked: false, retiredDevices: 0 });
		const unknown = await world.fetch(`/operator/vaults/${vaultId}/grants/${"Z".repeat(22)}`, { method: "DELETE", cookie });
		assert.deepEqual(await json(unknown), { ok: true, grantId: "Z".repeat(22), revoked: false, retiredDevices: 0 });
		assert.equal((await world.fetch(`/operator/vaults/${vaultId}/grants/short`, { method: "DELETE", cookie })).status, 404);
		assert.equal((await world.fetch(`/operator/vaults/${vaultId}/grants/${lostId}`, { method: "DELETE" })).status, 401,
			"no session");
		assert.equal((await world.fetch(`/operator/vaults/${vaultId}/grants/${lostId}`,
			{ method: "DELETE", cookie, origin: "https://evil.test" })).status, 403, "D5: the same-origin check");
		assert.equal((await deviceFeed(world, vaultId, phone)).status, 200, "another pairing is untouched");

		// Leave (the holder's own DELETE /auth/grant): the same cut.
		resetRows(world);
		const left = await vaultFetch(world, vaultId, "auth/grant", { method: "DELETE", headers: grantAuth(kept) });
		assert.deepEqual([left.status, (await json(left)).retiredDevices], [200, 1]);
		assert.equal((await deviceFeed(world, vaultId, phone)).status, 401);
		const leftAgain = await vaultFetch(world, vaultId, "auth/grant", { method: "DELETE", headers: grantAuth(kept) });
		assert.deepEqual([leftAgain.status, (await json(leftAgain)).revoked], [200, false], "a retry is a no-op");
		const stranger = await vaultFetch(world, vaultId, "auth/grant", { method: "DELETE", headers: grantAuth(randomBase64Url(32)) });
		assert.equal(stranger.status, 401);
		// Revoked grants stay listed (with revokedAt), with no live device.
		const list = await json(await listing(world, cookie, vaultId));
		assert.deepEqual((list.grants as Array<{ revokedAt: number | null; liveDevices: number }>)
			.map((grant) => [grant.revokedAt !== null, grant.liveDevices]), [[true, 0], [true, 0]]);
		assert.deepEqual(list.devices, []);
	});
});

s.test("D8b: Revoke pairing is frozen while a restore is pending, as device revoke is", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId } = await claim(world);
		const grantId = await pair(world, cookie, vaultId, randomBase64Url(32));
		world.config.storage.sql.exec("INSERT INTO restore_journal (vault_id, restore_id, at, bookmark, devices, created_at)"
			+ " VALUES (?, ?, ?, NULL, NULL, ?)", vaultId, "restore-0001", world.config.clock.now, world.config.clock.now);
		const frozen = await world.fetch(`/operator/vaults/${vaultId}/grants/${grantId}`, { method: "DELETE", cookie });
		assert.deepEqual([frozen.status, await json(frozen)], [409, { error: "restore_in_progress" }]);
	});
});

// ---- pairing code via the grant ---------------------------------------------------------------------------------------

s.test("owner decision 3: POST /auth/pairing-code with the grant secret mints a device code; the code pairs a new grant", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const secret = randomBase64Url(32);
		await pair(world, cookie, vaultId, secret);
		resetRows(world);
		const response = await vaultFetch(world, vaultId, "auth/pairing-code", { method: "POST", headers: grantAuth(secret),
			json: { purpose: "device" } });
		assert.equal(response.status, 200);
		const body = await json(response);
		assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "mobileSetupUrl", "obsidianUrl", "pairingCode", "purpose"]);
		assert.equal((body.pairingCode as string).split(".")[0], vaultId);
		assert.equal(body.purpose, "device");
		assert.equal(vault.model.totals.cf, 1, "§6.2 pairing code = 1 row");
		const enrolled = await grantEnroll(world, body.pairingCode as string, randomBase64Url(32), "Tablet");
		assert.equal(enrolled.status, 200);
		const badPurpose = await vaultFetch(world, vaultId, "auth/pairing-code", { method: "POST", headers: grantAuth(secret),
			json: { purpose: "owner-recovery" } });
		assert.deepEqual([badPurpose.status, await json(badPurpose)], [400, { error: "invalid_purpose" }]);
		const wrong = await vaultFetch(world, vaultId, "auth/pairing-code", { method: "POST", headers: grantAuth(randomBase64Url(32)),
			json: {} });
		assert.deepEqual([wrong.status, await json(wrong)], [401, { error: "unauthorized" }]);
		const asBearer = await vaultFetch(world, vaultId, "auth/pairing-code", { method: "POST",
			headers: { Authorization: `Bearer ${secret}` }, json: {} });
		assert.equal(asBearer.status, 401, "the schemes never mix");
	});
});

// ---- last_seen_day, listing, hot path ---------------------------------------------------------------------------------

s.test("§6.2 last_seen_day: ≤ 1 write a device a UTC day (at ticket); the listing shows it per device and per grant, with no secret material", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const secret = randomBase64Url(32);
		const grantId = await pair(world, cookie, vaultId, secret, "Mac");
		const store = await newStore("seen-device-00001");
		await registered(world, vaultId, grantAuth(secret), store);
		resetRows(world);
		for (let i = 0; i < 3; i++) assert.equal((await ticket(world, vaultId, store)).status, 200);
		assert.equal(vault.model.totals.cf, 0, "registering counts as seen today");
		vault.timers.now += DAY_MS;
		for (let i = 0; i < 3; i++) assert.equal((await ticket(world, vaultId, store)).status, 200);
		assert.equal(vault.model.totals.cf, 1, "the next day: one UPDATE");
		assert.deepEqual(vault.statements.filter((sql) => sql.startsWith("UPDATE device")),
			["UPDATE device SET last_seen_day = ? WHERE token_hash = ?"]);
		vault.restart();
		resetRows(world);
		assert.equal((await ticket(world, vaultId, store)).status, 200);
		assert.equal(vault.model.totals.cf, 0, "durable: a new runtime does not write it again");
		// The daily limit latched: no write, the ticket is still issued.
		vault.timers.now += DAY_MS;
		vault.host.latch.simulate(true);
		resetRows(world);
		assert.equal((await ticket(world, vaultId, store)).status, 200);
		assert.equal(vault.model.totals.cf, 0);
		vault.host.latch.simulate(false);

		const day = new Date(Math.floor((vault.timers.now - DAY_MS) / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
		const response = await listing(world, cookie, vaultId);
		const text = await response.text();
		const list = JSON.parse(text) as Record<string, unknown>;
		assert.deepEqual(list.devices, [{ deviceId: store.deviceId, deviceName: "Mac", enrolledAt: (list.devices as Array<{ enrolledAt: number }>)[0]!.enrolledAt,
			grantId, lastSeenDay: day }]);
		assert.deepEqual(list.grants, [{ grantId, name: "Mac", createdAt: (list.grants as Array<{ createdAt: number }>)[0]!.createdAt,
			revokedAt: null, liveDevices: 1, lastSeenDay: day }]);
		for (const secretText of [secret, store.token, store.retireKey, store.retireKeyHash,
			await sha256Hex(new TextEncoder().encode(secret)), await sha256Hex(new TextEncoder().encode(store.token))]) {
			assert.ok(!text.includes(secretText), "T-DEVICES-LIST: no token, secret or retire-key material");
		}
	});
});

s.test("T-HOTPATH: register, retire by key, self-retire, leave and the grant pairing code make zero config-DO calls", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId } = await claim(world);
		const secret = randomBase64Url(32);
		await pair(world, cookie, vaultId, secret);
		const a = await newStore("hot-device-00001");
		const b = await newStore("hot-device-00002");
		world.accesses.length = 0;
		await registered(world, vaultId, grantAuth(secret), a);
		await registered(world, vaultId, grantAuth(secret), b);
		assert.equal((await vaultFetch(world, vaultId, "auth/pairing-code", { method: "POST", headers: grantAuth(secret), json: {} })).status, 200);
		assert.equal((await vaultFetch(world, vaultId, "auth/device/retire", { method: "POST",
			json: { deviceId: a.deviceId, retireKey: a.retireKey } })).status, 200);
		assert.equal((await deviceFetch(world, vaultId, b, "auth/device", { method: "DELETE" })).status, 200);
		assert.equal((await vaultFetch(world, vaultId, "auth/grant", { method: "DELETE", headers: grantAuth(secret) })).status, 200);
		assert.deepEqual(world.accesses, []);
	});
});

// ---- D8b restore ------------------------------------------------------------------------------------------------------

s.test("D8b: a restore keeps a pairing revoked after T revoked and a tombstone written after T; a grant made after T survives", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, vault } = await claim(world);
		const lost = randomBase64Url(32);
		await pair(world, cookie, vaultId, lost, "Lost laptop");
		const thief = await newStore("thief-device-0001");
		const retiredStore = await newStore("retired-device-01");
		const keptSecret = randomBase64Url(32);
		await pair(world, cookie, vaultId, keptSecret, "Phone");
		await registered(world, vaultId, grantAuth(lost), thief);
		await registered(world, vaultId, grantAuth(keptSecret), retiredStore);
		const advance = (ms: number) => {
			world.config.clock.now += ms;
			for (const object of world.cluster.objects.values()) object.timers.advance(ms);
		};
		advance(1000);
		const at = world.config.clock.now;
		vault.pitr!.capture(at);
		advance(10_000);

		// After T: the pairing is revoked, a store retires itself, a new pairing is made with a store.
		assert.equal((await vaultFetch(world, vaultId, "auth/grant", { method: "DELETE", headers: grantAuth(lost) })).status, 200);
		assert.equal((await deviceFetch(world, vaultId, retiredStore, "auth/device", { method: "DELETE" })).status, 200);
		const late = randomBase64Url(32);
		await pair(world, cookie, vaultId, late, "Tablet");
		const tablet = await newStore("tablet-device-001");
		await registered(world, vaultId, grantAuth(late), tablet);
		advance(1000);
		const before = await json(await listing(world, cookie, vaultId));

		const restored = await world.fetch(`/operator/vaults/${vaultId}/restore`,
			{ method: "POST", cookie, json: { at: new Date(at).toISOString() } });
		assert.equal(restored.status, 200, "restore");
		assert.deepEqual(await json(await listing(world, cookie, vaultId)), before, "grants and devices == pre-restore");
		assert.equal((await deviceFeed(world, vaultId, thief)).status, 401, "the revoked pairing's store stays out");
		const thiefAgain = await register(world, vaultId, grantAuth(lost), await newStore("thief-device-0002"));
		assert.deepEqual([thiefAgain.status, await json(thiefAgain)], [401, { error: "grant_revoked" }],
			"a restore never brings back a revoked pairing");
		const back = await register(world, vaultId, grantAuth(keptSecret), retiredStore);
		assert.deepEqual([back.status, await json(back)], [409, { error: "device_retired" }], "nor a retired deviceId");
		assert.equal((await deviceFeed(world, vaultId, tablet)).status, 200, "a store registered after T keeps working");
		assert.equal(rawCount(vault, "retired_device"), 2);
	}, { pitr: true });
});

await s.done();
