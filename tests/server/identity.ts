// P2 identity in the vault DO (server/src/vault/host.ts) on Node SQLite: D3 pairing codes and enroll with replay, the
// D3 limiter, T-PAIR-NOWRITE, D4 tickets and the ticket upgrade, D7 revoke in one synchronous turn (GATE, BUFFER,
// SILENCE, 4403, 401), revoke races at every await, O3 at the wake, and the D5 vault delete. Row counts are the CF
// model's (tests/server/helpers/cfRowModel.ts) against DECISIONS §6.2.
import assert from "node:assert/strict";

import { sha256Hex } from "../../server/src/hex";
import { decodeServerFrame, encodeAppendFrame } from "../../server/src/streams/protocol";
import { ORIGIN_HEADER } from "../../server/src/vault/host";
import { PAIRING_CODE_RETENTION_MS, PAIRING_CODE_TTL_MS } from "../../server/src/vault/pairing";
import { TICKET_TTL_MS, readTicketTtlMs } from "../../server/src/vault/ticket";
import { suite } from "../harness.ts";
import {
	VaultCluster,
	bearer,
	newDevice,
	newVaultId,
	type DeviceSeed,
	type FakeSocket,
	type VaultObject,
} from "./helpers/workerHarness.ts";

const s = suite("identity");

const INTERNAL = "https://vault.internal";
const PUBLIC = "https://yaos.test";
const ENROLLED_FIELDS = ["deviceId", "deviceName", "deviceToken", "host", "vaultGeneration", "vaultId"];

async function withCluster(check: (cluster: VaultCluster) => Promise<void>): Promise<void> {
	const cluster = new VaultCluster();
	try {
		await check(cluster);
	} finally {
		cluster.close();
	}
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return await response.json() as Record<string, unknown>;
}

async function mint(object: VaultObject, purpose: "owner-bootstrap" | "owner-recovery" | "device" = "owner-bootstrap"):
	Promise<string> {
	const minted = await object.host.mintOwnerCode(purpose);
	assert.ok(minted, "mintOwnerCode");
	return minted.pairingCode;
}

interface EnrollBody {
	pairingCode: string;
	enrollmentRequestId: string;
	deviceId: string;
	deviceToken: string;
	deviceName: string;
}

function enrollBody(pairingCode: string, device: DeviceSeed, enrollmentRequestId = `enroll-${device.deviceId}`): EnrollBody {
	return { pairingCode, enrollmentRequestId, deviceId: device.deviceId, deviceToken: device.token, deviceName: device.deviceName };
}

function enroll(object: VaultObject, body: unknown): Promise<Response> {
	return object.host.fetch(new Request(`${INTERNAL}/enroll`, {
		method: "POST", headers: { "Content-Type": "application/json", [ORIGIN_HEADER]: PUBLIC }, body: JSON.stringify(body),
	}));
}

function post(object: VaultObject, path: string, device: DeviceSeed, body: unknown = {}): Promise<Response> {
	return object.host.fetch(new Request(`${INTERNAL}/${path}`, {
		method: "POST", headers: { ...bearer(device), [ORIGIN_HEADER]: PUBLIC }, body: JSON.stringify(body),
	}));
}

function feed(object: VaultObject, device: DeviceSeed): Promise<Response> {
	return object.host.fetch(new Request(`${INTERNAL}/streams/feed`, { headers: bearer(device) }));
}

async function ticketOf(object: VaultObject, device: DeviceSeed): Promise<string> {
	const response = await post(object, "auth/ticket", device, { purpose: "streams" });
	assert.equal(response.status, 200, "ticket");
	return (await json(response)).ticket as string;
}

function upgrade(object: VaultObject, ticket: string, headers: Record<string, string> = { Upgrade: "websocket" }):
	Promise<Response> {
	return object.host.fetch(new Request(`${INTERNAL}/ws/streams?streamsVersion=1&ticket=${encodeURIComponent(ticket)}`,
		{ headers }));
}

/** Opens a streams socket through the D4 ticket path. */
async function connect(object: VaultObject, device: DeviceSeed): Promise<FakeSocket> {
	const response = await upgrade(object, await ticketOf(object, device));
	assert.equal(response.headers.get("X-Test-Upgrade"), "accepted", `${device.deviceId}: socket admitted`);
	const socket = object.registry.lastClient!;
	object.registry.lastClient = null;
	return socket;
}

function appendBytes(stream: string, clientFrameId: string, payload = new Uint8Array([1])): ArrayBuffer {
	const frame = encodeAppendFrame({ stream, clientFrameId, payload });
	return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer;
}

function receipts(socket: FakeSocket): Array<{ clientFrameId: string; seq: number }> {
	return socket.controls.filter((control) => control.type === "STREAM_RECEIPTS")
		.flatMap((control) => control.receipts as Array<{ clientFrameId: string; seq: number }>);
}

function serverFrames(socket: FakeSocket) {
	return socket.binary.map((bytes) => decodeServerFrame(bytes));
}

function writes(object: VaultObject): string[] {
	return object.statements.filter((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql));
}

/**
 * Runs `action` synchronously when the host makes its `nth` call to `crypto.subtle[method]`, i.e. while the
 * handler is suspended on that await. Proves a handler re-checks the device map after each crypto await.
 */
async function duringCrypto<T>(method: "digest" | "sign" | "verify", nth: number, action: () => void,
	run: () => Promise<T>): Promise<T> {
	const subtle = crypto.subtle;
	const original: unknown = Reflect.get(subtle, method);
	if (typeof original !== "function") throw new Error(`crypto.subtle.${method} is not a function`);
	let calls = 0;
	let fired = false;
	Object.defineProperty(subtle, method, {
		configurable: true,
		writable: true,
		value: (...args: unknown[]) => {
			if (++calls === nth) { fired = true; action(); }
			return Reflect.apply(original, subtle, args);
		},
	});
	try {
		const result = await run();
		assert.ok(fired, `the hook ran at ${method} #${nth}`);
		return result;
	} finally {
		Reflect.deleteProperty(subtle, method);
	}
}

// ---- D3 enroll -------------------------------------------------------------------------------------------------

s.test("D3 enroll: 200 with exactly the six fields, 2 CF rows (UPDATE code + INSERT device), admitted at once", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const object = await cluster.seed(vaultId);
		const code = await mint(object);
		const laptop = newDevice("laptop-device-0001", "Laptop");
		object.model.reset();
		object.statements.length = 0;
		const response = await enroll(object, enrollBody(code, laptop));
		assert.equal(response.status, 200);
		const body = await json(response);
		assert.deepEqual(Object.keys(body).sort(), ENROLLED_FIELDS);
		assert.deepEqual(body, { host: PUBLIC, deviceToken: laptop.token, vaultId, deviceId: laptop.deviceId,
			deviceName: "Laptop", vaultGeneration: object.host.load()!.meta.vaultGeneration });
		assert.equal(object.model.totals.cf, 2, "§6.2 enroll = 2 rows");
		assert.deepEqual([...object.model.totals.byTable], [["pairing_code", 1], ["device", 1]]);
		assert.equal((await feed(object, laptop)).status, 200, "the new bearer works in the same runtime");
		object.restart();
		assert.equal((await feed(object, laptop)).status, 200, "and after a restart (the row is durable)");

		type DeviceRow = { token_hash: ArrayBuffer; device_name: string; enrollment_request_id: string };
		const row = object.storage.sql.exec<DeviceRow>("SELECT token_hash, device_name, enrollment_request_id FROM device")
			.toArray()[0]!;
		assert.equal(Buffer.from(row.token_hash).toString("hex"), await sha256Hex(new TextEncoder().encode(laptop.token)),
			"§6.1: only SHA-256(token) is stored");
		assert.equal(row.enrollment_request_id, `enroll-${laptop.deviceId}`);
		const stored = JSON.stringify(object.storage.sql.exec("SELECT purpose, expires_at, used_at, used_request_id,"
			+ " used_device_id FROM pairing_code").toArray());
		assert.ok(!stored.includes(code.split(".")[1]!), "the code secret is not stored");

		const second = newDevice("second-device-0001", "Laptop");
		const named = await json(await enroll(object, enrollBody(await mint(object), second)));
		assert.equal(named.deviceName, "Laptop 2", "legacy unique names");
		const blank = newDevice("blank-name-device1");
		const unnamed = await json(await enroll(object, { ...enrollBody(await mint(object), blank), deviceName: "  " }));
		assert.equal(unnamed.deviceName, "unnamed-device");
	});
});

s.test("D3 replay: same code + request id + deviceId + token → the same 200, 0 rows; deviceName is not part of the key", async () => {
	await withCluster(async (cluster) => {
		const object = await cluster.seed(newVaultId());
		const code = await mint(object);
		const laptop = newDevice("laptop-device-0001", "Laptop");
		const request = enrollBody(code, laptop);
		const first = await json(await enroll(object, request));
		object.model.reset();
		object.statements.length = 0;

		const again = await enroll(object, request);
		assert.equal(again.status, 200);
		assert.deepEqual(await json(again), first);
		const renamed = await enroll(object, { ...request, deviceName: "Renamed" });
		assert.equal(renamed.status, 200);
		assert.deepEqual(await json(renamed), first, "the stored name is returned");
		object.timers.now += PAIRING_CODE_TTL_MS + 1;
		const late = await enroll(object, request);
		assert.equal(late.status, 200, "DECISIONS-GAP: a replay after the code's expiry is still answered");

		const conflicts: Array<[string, EnrollBody]> = [
			["another deviceId", { ...request, deviceId: "other-device-00001" }],
			["another token", { ...request, deviceToken: newDevice("x").token }],
		];
		for (const [label, body] of conflicts) {
			const response = await enroll(object, body);
			assert.equal(response.status, 409, label);
			assert.deepEqual(await json(response), { error: "enrollment_request_conflict" }, label);
		}
		const other = await enroll(object, { ...request, enrollmentRequestId: "another-request-001" });
		assert.equal(other.status, 409);
		assert.deepEqual(await json(other), { error: "used_code" }, "a used code with another request id");
		assert.equal(object.model.totals.cf, 0, "§6.2 replay = 0 rows; conflicts write nothing");
		assert.deepEqual(writes(object), []);

		object.host.revokeDevice(laptop.deviceId);
		object.model.reset();
		const revoked = await enroll(object, request);
		assert.equal(revoked.status, 409);
		assert.deepEqual(await json(revoked), { error: "used_code" }, "D3: the replay of a revoked device is used_code");
		assert.equal(object.model.totals.cf, 0);
		assert.equal((await feed(object, laptop)).status, 401, "the replay did not restore the device");

		// Re-enrolled under a new code: the old code's replay still refers to the revoked enrollment.
		const back = await enroll(object, enrollBody(await mint(object), laptop, "enroll-request-again"));
		assert.equal(back.status, 200);
		const stale = await enroll(object, request);
		assert.equal(stale.status, 409);
		assert.deepEqual(await json(stale), { error: "used_code" });
	});
});

s.test("T-PAIR-NOWRITE: unknown, expired, used, another vault's or malformed code and device_exists write 0 rows", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001");
		const object = await cluster.seed(vaultId, [owner]);
		const other = await cluster.seed(newVaultId());
		const laptop = newDevice("laptop-device-0001");
		const code = await mint(object);
		const expiring = await mint(object);
		const foreign = await mint(other);
		const used = await mint(object);
		assert.equal((await enroll(object, enrollBody(used, newDevice("used-by-device-001")))).status, 200);
		object.model.reset();
		other.model.reset();
		object.statements.length = 0;
		object.timers.now += PAIRING_CODE_TTL_MS - 1;
		const secret = code.split(".")[1]!;
		const flipped = `${vaultId}.${secret[0] === "A" ? "B" : "A"}${secret.slice(1)}`;
		const cases: Array<[string, unknown, number, unknown]> = [
			["unknown secret", enrollBody(flipped, laptop), 404, { error: "invalid_code" }],
			["another vault's code", enrollBody(foreign, laptop), 404, { error: "invalid_code" }],
			["used by another request", enrollBody(used, laptop), 409, { error: "used_code" }],
			["owner deviceId exists", enrollBody(code, { ...laptop, deviceId: owner.deviceId }), 409, { error: "device_exists" }],
			["owner token exists", enrollBody(code, { ...laptop, token: owner.token }), 409, { error: "device_exists" }],
			["malformed code", { ...enrollBody(code, laptop), pairingCode: "nope" }, 400, { error: "invalid_code" }],
			["short request id", { ...enrollBody(code, laptop), enrollmentRequestId: "short" }, 400,
				{ error: "invalid enrollment request" }],
			["short token", { ...enrollBody(code, laptop), deviceToken: "short" }, 400, { error: "invalid enrollment request" }],
			["bad deviceId", { ...enrollBody(code, laptop), deviceId: "has space in it 0001" }, 400,
				{ error: "invalid enrollment request" }],
			["not an object", [], 400, { error: "invalid_code" }],
		];
		for (const [label, body, status, expected] of cases) {
			const response = await enroll(object, body);
			assert.equal(response.status, status, label);
			assert.deepEqual(await json(response), expected, label);
		}
		object.timers.now += 1;
		const expired = await enroll(object, enrollBody(expiring, laptop));
		assert.equal(expired.status, 410, "D3: TTL 15 min");
		assert.deepEqual(await json(expired), { error: "expired_code" });
		assert.equal(object.model.totals.cf, 0, "T-PAIR-NOWRITE: zero rows");
		assert.deepEqual(writes(object), [], "T-PAIR-NOWRITE: no write statement ran");
		assert.equal(other.model.totals.cf, 0, "another vault's code does not touch that vault");
		const ok = await enroll(object, enrollBody(code, laptop));
		assert.equal(ok.status, 410, "the first code expired too");
	});
});

s.test("D3 limiter: 20 code failures a minute → 429 + Retry-After; malformed bodies do not count; the window resets", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const object = await cluster.seed(vaultId);
		const code = await mint(object);
		const laptop = newDevice("laptop-device-0001");
		for (let attempt = 0; attempt < 30; attempt++) {
			assert.equal((await enroll(object, { ...enrollBody(code, laptop), deviceToken: "x" })).status, 400);
		}
		const unknown = `${vaultId}.${"Z".repeat(32)}`;
		for (let attempt = 0; attempt < 20; attempt++) {
			assert.equal((await enroll(object, enrollBody(unknown, laptop))).status, 404, `failure ${attempt + 1}`);
		}
		object.model.reset();
		const blocked = await enroll(object, enrollBody(code, laptop));
		assert.equal(blocked.status, 429, "a valid code is refused while the limiter is closed");
		assert.deepEqual(await json(blocked), { error: "too_many_attempts" });
		assert.equal(blocked.headers.get("Retry-After"), "60");
		assert.equal(object.model.totals.cf, 0);
		object.timers.now += 59_000;
		assert.equal((await enroll(object, enrollBody(code, laptop))).headers.get("Retry-After"), "1");
		object.timers.now += 1_000;
		assert.equal((await enroll(object, enrollBody(code, laptop))).status, 200, "a new window");
	});
});

// ---- D3 pairing codes ----------------------------------------------------------------------------------------------

s.test("D3 pairing-code: 1 row (+1 per row expired > 24 h ago), purpose device only, the §5 fields, one use", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001");
		const object = await cluster.seed(vaultId, [owner]);
		object.model.reset();
		const response = await post(object, "auth/pairing-code", owner);
		assert.equal(response.status, 200);
		const body = await json(response);
		assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "mobileSetupUrl", "obsidianUrl", "pairingCode", "purpose"]);
		const code = body.pairingCode as string;
		assert.match(code, new RegExp(`^${vaultId}\\.[A-Za-z0-9_-]{32}$`), "D3: <vaultId>.<base64url(24 B)>");
		assert.equal(body.purpose, "device");
		assert.equal(body.expiresAt, object.timers.now + PAIRING_CODE_TTL_MS);
		assert.equal(body.mobileSetupUrl, `${PUBLIC}/mobile-setup#${new URLSearchParams({ host: PUBLIC, pairingCode: code })}`);
		assert.equal(body.obsidianUrl,
			`obsidian://yaos?${new URLSearchParams({ action: "setup", host: PUBLIC, pairingCode: code })}`);
		assert.equal(object.model.totals.cf, 1, "§6.2 pairing code = 1 row");

		assert.equal((await post(object, "auth/pairing-code", owner, { purpose: "device" })).status, 200);
		for (const purpose of ["owner-bootstrap", "owner-recovery", "other", 1]) {
			const refused = await post(object, "auth/pairing-code", owner, { purpose });
			assert.equal(refused.status, 400, String(purpose));
			assert.deepEqual(await json(refused), { error: "invalid_purpose" });
		}
		assert.equal(object.model.totals.cf, 2, "a refused purpose writes nothing");

		const laptop = newDevice("laptop-device-0001");
		assert.equal((await enroll(object, enrollBody(code, laptop))).status, 200, "a device code enrolls");
		const reuse = await enroll(object, enrollBody(code, newDevice("third-device-00001")));
		assert.deepEqual(await json(reuse), { error: "used_code" });

		// Prune: the three rows expire at t+15 min; a mint more than 24 h after that deletes them.
		object.timers.now += PAIRING_CODE_TTL_MS + PAIRING_CODE_RETENTION_MS + 1;
		object.model.reset();
		const minted = await object.host.mintOwnerCode("owner-recovery");
		assert.equal(minted?.purpose, "owner-recovery");
		assert.deepEqual([...object.model.totals.byTable], [["pairing_code", 3]], "2 pruned + 1 inserted");
		assert.equal(object.model.totals.cf, 3);
		assert.equal(object.storage.sql.exec("SELECT code_hash FROM pairing_code").toArray().length, 1);
		object.timers.now += 1000;
		object.model.reset();
		await object.host.mintOwnerCode("owner-bootstrap");
		assert.equal(object.model.totals.cf, 1, "nothing left to prune");
	});
});

// ---- D4 tickets --------------------------------------------------------------------------------------------------

s.test("D4 ticket: 0 rows; purpose streams only; the ticket opens a socket; bad, expired, cross-vault tickets → 1008", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001", "Owner");
		const object = await cluster.seed(vaultId, [owner]);
		const twin = await cluster.seed(newVaultId(), [owner]);
		object.model.reset();
		const issued = await post(object, "auth/ticket", owner, { purpose: "streams" });
		assert.equal(issued.status, 200);
		const body = await json(issued);
		assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "ticket", "ttlMs"]);
		assert.equal(body.ttlMs, TICKET_TTL_MS);
		assert.equal(body.expiresAt, object.timers.now + TICKET_TTL_MS);
		assert.equal((await post(object, "auth/ticket", owner, { purpose: "streams", documentId: "streams" })).status, 200);
		for (const scope of [{}, { purpose: "body" }, { purpose: "streams", documentId: "root" },
			{ purpose: "streams", rootEpoch: "r" }, { purpose: "streams", bodyEpoch: "b" }]) {
			const refused = await post(object, "auth/ticket", owner, scope);
			assert.equal(refused.status, 400, JSON.stringify(scope));
			assert.deepEqual(await json(refused), { error: "invalid_ticket_scope" });
		}
		const ticket = body.ticket as string;
		const accepted = await upgrade(object, ticket);
		assert.equal(accepted.headers.get("X-Test-Upgrade"), "accepted");
		const ready = object.registry.lastClient!.last("VAULT_READY")!;
		assert.deepEqual([ready.vaultId, ready.deviceId, ready.principalId, ready.role], [vaultId, owner.deviceId,
			`owner:${vaultId}`, "owner"]);
		assert.equal(object.model.totals.cf, 0, "§6.2 ticket = 0 rows; the socket accept writes nothing");

		const notUpgrade = await upgrade(object, ticket, {});
		assert.equal(notUpgrade.status, 426, "DECISIONS-GAP: a valid ticket without the upgrade header");
		const [encoded, signature] = ticket.split(".") as [string, string];
		const flip = (text: string) => `${text.slice(0, -2)}${text.at(-2) === "A" ? "B" : "A"}${text.at(-1)}`;
		const crossVault = await ticketOf(twin, owner);
		const bad = ["", "garbage", `${encoded}.`, `.${signature}`, `${encoded}.${flip(signature)}`, `${flip(encoded)}.${signature}`,
			`${encoded}.${signature}.x`, crossVault];
		for (const candidate of bad) {
			object.upgrades.rejected.length = 0;
			const refused = await upgrade(object, candidate);
			assert.equal(refused.headers.get("X-Test-Upgrade"), "rejected", candidate.slice(0, 12));
			assert.deepEqual(object.upgrades.rejected.map((entry) => [entry.frame, entry.code]),
				[[{ type: "error", code: "unauthorized" }, 1008]]);
		}
		const plain = await upgrade(object, "garbage", {});
		assert.equal(plain.status, 401, "a refused ticket without the upgrade header is a plain 401");
		object.timers.now += TICKET_TTL_MS;
		object.upgrades.rejected.length = 0;
		await upgrade(object, ticket);
		assert.equal(object.upgrades.rejected.length, 1, "D4: TTL 5 min (exp <= now is refused)");
	});
	assert.equal(readTicketTtlMs(undefined), TICKET_TTL_MS);
	assert.equal(readTicketTtlMs("abc"), TICKET_TTL_MS);
	assert.equal(readTicketTtlMs("5"), 1000);
	assert.equal(readTicketTtlMs("90000"), 90_000);
	assert.equal(readTicketTtlMs(String(48 * 3600 * 1000)), 24 * 3600 * 1000);
});

// ---- D7 revoke -------------------------------------------------------------------------------------------------

s.test("T-REVOKE-GATE/-BUFFER/-SILENCE/-4403/-401: revoke is one synchronous turn; dropped frames never commit", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001");
		const victim = newDevice("victim-device-0001");
		const object = await cluster.seed(vaultId, [owner, victim]);
		const ownerSocket = await connect(object, owner);
		const victimSockets = [await connect(object, victim), await connect(object, victim)];
		const victimTicket = await ticketOf(object, victim);
		object.host.webSocketMessage(victimSockets[0]!, appendBytes("b:doc", "victim-provisional"));
		object.host.webSocketMessage(victimSockets[1]!, appendBytes("ns", "victim-ns"));
		object.host.webSocketMessage(ownerSocket, appendBytes("ns", "owner-ns"));
		assert.deepEqual(serverFrames(ownerSocket).map((frame) => [frame.kind, frame.clientFrameId]),
			[["provisional", "victim-provisional"]], "the owner holds the victim's PROVISIONAL");
		assert.equal(object.host.relay.pendingFrames(), 3);
		assert.equal(object.host.relay.head(), 0);
		object.model.reset();
		object.statements.length = 0;

		const result = object.host.revokeDevice(victim.deviceId);
		assert.ok(!(result instanceof Promise) && typeof (result as { then?: unknown }).then !== "function",
			"the RPC body returns a value, not a promise: the whole revoke ran before it returned");
		assert.equal(object.host.revokeDevice.constructor.name, "Function", "revokeDevice is not an async function");
		assert.deepEqual(result, { revoked: true, droppedFrames: 2, closedSockets: 2 });

		// Everything below was already true when revokeDevice returned (no timer or microtask has run).
		assert.equal(object.model.totals.cf, 1, "§6.2 revoke = 1 row");
		assert.deepEqual(writes(object), ["DELETE FROM device WHERE device_id = ?"], "no flush: no stream row was written");
		assert.equal(object.host.admits(victim.deviceId), false, "GATE: the device map entry is gone");
		for (const socket of victimSockets) {
			assert.deepEqual(socket.last("error"),
				{ type: "error", code: "authority_superseded", reason: "socket authority superseded" });
			assert.equal(socket.closed?.code, 4403, "4403");
		}
		assert.deepEqual(ownerSocket.last("STREAM_PROVISIONAL_DROPPED"), { type: "STREAM_PROVISIONAL_DROPPED",
			stream: "b:doc", deviceId: victim.deviceId, clientFrameId: "victim-provisional", reason: "commit_failed" });
		assert.equal(object.host.relay.pendingFrames(), 1, "BUFFER: only the owner's frame is left");
		assert.equal(object.host.relay.head(), 0, "nothing was committed by the revoke");

		// A message the runtime still delivers from a victim socket is refused before buffering or fanout.
		object.host.webSocketMessage(victimSockets[0]!, appendBytes("b:doc", "victim-late"));
		assert.equal(object.host.relay.pendingFrames(), 1);
		assert.equal(serverFrames(ownerSocket).length, 1, "SILENCE: no PROVISIONAL of the late frame");

		object.timers.advance(10_000);
		assert.equal(object.host.relay.head(), 1, "the normal group commit wrote the owner's frame only");
		assert.deepEqual(receipts(ownerSocket).map((receipt) => receipt.clientFrameId), ["owner-ns"]);
		for (const socket of victimSockets) assert.deepEqual(receipts(socket), [], "BUFFER: no receipt for a dropped frame");
		assert.deepEqual(serverFrames(ownerSocket).map((frame) => frame.kind), ["provisional"],
			"SILENCE: the owner never sees a COMMITTED of the victim's frames");
		const rows = await json(await object.host.fetch(new Request(`${INTERNAL}/streams/read?stream=ns&after=0`,
			{ headers: bearer(owner) })));
		assert.deepEqual((rows.rows as Array<{ deviceId: string }>).map((row) => row.deviceId), [owner.deviceId]);

		// -401 on every device route; the unexpired ticket no longer opens a socket.
		const routes: Array<[string, string, string?]> = [["GET", "streams/feed"], ["GET", "streams/read?stream=ns"],
			["PUT", "streams/checkpoint?stream=ns&coversSeq=1&expectedCoversSeq=0", "x"], ["POST", "auth/ticket", "{\"purpose\":\"streams\"}"],
			["POST", "auth/pairing-code", "{}"]];
		object.model.reset();
		for (const [method, path, body] of routes) {
			const response = await object.host.fetch(new Request(`${INTERNAL}/${path}`,
				{ method, headers: { ...bearer(victim), [ORIGIN_HEADER]: PUBLIC }, ...(body ? { body } : {}) }));
			assert.equal(response.status, 401, `T-REVOKE-401: ${method} ${path}`);
			assert.deepEqual(await json(response), { error: "unauthorized" });
		}
		object.upgrades.rejected.length = 0;
		await upgrade(object, victimTicket);
		assert.deepEqual(object.upgrades.rejected.map((entry) => entry.frame), [{ type: "error", code: "unauthorized" }],
			"the ticket upgrade re-checks the device map");
		assert.equal(object.model.totals.cf, 0);
		assert.equal((await feed(object, owner)).status, 200, "the owner is unaffected");
		assert.equal(ownerSocket.closed, null);
		assert.deepEqual(object.host.listDevices().devices.map((device) => device.deviceId), [owner.deviceId]);
		object.restart();
		assert.equal((await feed(object, victim)).status, 401, "the row is gone after a restart too");

		object.model.reset();
		assert.deepEqual(object.host.revokeDevice(victim.deviceId), { revoked: false, droppedFrames: 0, closedSockets: 0 },
			"idempotent, 0 rows");
		assert.equal(object.model.totals.cf, 0);
	});
});

s.test("D7 races: a revoke while a handler awaits crypto or a body wins; nothing is issued or written", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001");
		const object = await cluster.seed(vaultId, [owner]);
		let victim = newDevice("victim-device-0001");
		let enrolled = 0;
		const reEnroll = async () => {
			victim = newDevice("victim-device-0001");
			const response = await enroll(object, enrollBody(await mint(object), victim, `enroll-request-${++enrolled}`.padEnd(16, "0")));
			assert.equal(response.status, 200);
		};
		const revoke = () => { object.host.revokeDevice(victim.deviceId); };

		// Bearer auth: the revoke lands while SHA-256(token) is pending.
		const auth = feed(object, victim);
		revoke();
		assert.equal((await auth).status, 401, "revoke during the bearer hash");

		await reEnroll();
		const ticket = await duringCrypto("sign", 1, revoke, () => post(object, "auth/ticket", victim, { purpose: "streams" }));
		assert.equal(ticket.status, 401, "revoke during the ticket HMAC: no ticket is returned");

		await reEnroll();
		const issued = await ticketOf(object, victim);
		object.upgrades.rejected.length = 0;
		await duringCrypto("verify", 1, revoke, () => upgrade(object, issued));
		assert.deepEqual(object.upgrades.rejected.map((entry) => entry.frame), [{ type: "error", code: "unauthorized" }],
			"revoke during the ticket verification: no socket");

		await reEnroll();
		object.model.reset();
		const code = await duringCrypto("digest", 2, revoke, () => post(object, "auth/pairing-code", victim));
		assert.equal(code.status, 401, "revoke during the code hash: no code is minted");
		assert.deepEqual([...object.model.totals.byTable], [["device", 1]], "only the revoke wrote");

		await reEnroll();
		object.model.reset();
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				revoke();
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.close();
			},
		}, { highWaterMark: 0 });
		const checkpoint = await object.host.fetch(new Request(
			`${INTERNAL}/streams/checkpoint?stream=ns&coversSeq=1&expectedCoversSeq=0`,
			{ method: "PUT", headers: bearer(victim), body, duplex: "half" } as RequestInit));
		assert.equal(checkpoint.status, 401, "revoke during the checkpoint body read");
		assert.deepEqual([...object.model.totals.byTable], [["device", 1]], "no checkpoint row");

		// Vault delete while an enroll hashes: the enroll answers like an unknown vault and writes nothing.
		const late = newDevice("late-device-00001");
		const pending = await mint(object);
		const deleted = await duringCrypto("digest", 1, () => { void object.host.deleteVault(); },
			() => enroll(object, enrollBody(pending, late)));
		assert.equal(deleted.status, 404);
		assert.deepEqual(await json(deleted), { error: "invalid_code" });
	});
});

s.test("O3: a socket whose device was removed while the DO hibernated is closed 4403 at the wake, not told to resend", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001");
		const laptop = newDevice("laptop-device-0001");
		const object = await cluster.seed(vaultId, [owner, laptop]);
		const ownerSocket = await connect(object, owner);
		const laptopSocket = await connect(object, laptop);
		object.storage.sql.exec("DELETE FROM device WHERE device_id = ?", laptop.deviceId);
		object.restart();
		object.host.webSocketMessage(ownerSocket, `__YPS:${JSON.stringify({ type: "VAULT_PING", probeId: "wake" })}`);
		assert.equal(ownerSocket.last("STREAM_RESEND")?.runtimeEpoch, object.host.runtimeEpoch);
		assert.equal(laptopSocket.last("STREAM_RESEND"), undefined, "the revoked socket is skipped");
		assert.equal(laptopSocket.last("error")?.code, "authority_superseded");
		assert.equal(laptopSocket.closed?.code, 4403, "closed by the wake rebuild, on another socket's message");
		assert.equal(ownerSocket.closed, null);
	});
});

// ---- D5 vault delete (the vault DO's part) -------------------------------------------------------------------------

s.test("D5 deleteVault: sockets close 1001, the buffer is dropped, deleteAll wipes the storage, every route is 401/404", async () => {
	await withCluster(async (cluster) => {
		const vaultId = newVaultId();
		const owner = newDevice("owner-device-0001");
		const object = await cluster.seed(vaultId, [owner]);
		const socket = await connect(object, owner);
		const code = await mint(object);
		object.host.webSocketMessage(socket, appendBytes("ns", "pending"));
		assert.equal(object.host.relay.pendingFrames(), 1);
		assert.deepEqual(await object.host.deleteVault(), { deleted: true });
		assert.deepEqual(socket.closed, { code: 1001, reason: "vault deleted" });
		assert.equal(object.host.relay.pendingFrames(), 0);
		object.timers.advance(10_000);
		assert.deepEqual(receipts(socket), [], "the dropped frame never commits");
		assert.deepEqual(object.storage.sql.exec("SELECT name FROM sqlite_master").toArray(), [], "deleteAll: nothing left");
		assert.equal((await feed(object, owner)).status, 401);
		assert.equal((await post(object, "auth/ticket", owner, { purpose: "streams" })).status, 401);
		const reEnroll = await enroll(object, enrollBody(code, newDevice("new-device-000001")));
		assert.equal(reEnroll.status, 404);
		assert.equal(await object.host.mintOwnerCode("owner-bootstrap"), null);
		assert.deepEqual(object.host.listDevices(), { devices: [] });
		assert.deepEqual(object.host.revokeDevice(owner.deviceId), { revoked: false, droppedFrames: 0, closedSockets: 0 });
		object.restart();
		assert.equal(object.host.load(), null, "a new runtime sees no vault");
		assert.deepEqual(await object.host.deleteVault(), { deleted: true }, "idempotent");
	});
});

await s.done();
