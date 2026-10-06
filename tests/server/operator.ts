// P2 operator routes (DECISIONS D5, D7, D8b seam) through the real Router (server/src/router.ts) with the real config
// host (server/src/config/host.ts) and vault hosts on Node SQLite: claim, login and its limiter, logout, sessions,
// state, create vault, owner code, devices, revoke, delete vault with the R2 purge, the D5 CSRF checks, the restore
// seam (409 restore_in_progress) and T-ROWS-WB (the §6.2 row counts of every operator operation).
import assert from "node:assert/strict";

import { SESSION_TTL_MS } from "../../server/src/config/host";
import { PAIRING_CODE_TTL_MS } from "../../server/src/vault/pairing";
import { MAX_PURGE_BATCHES, Router, type WorkerEnv } from "../../server/src/router";
import { suite } from "../harness.ts";
import {
	RecordingUpgrades,
	VaultCluster,
	bearer,
	newDevice,
	recordingConfigNamespace,
	type DeviceSeed,
	type VaultObject,
} from "./helpers/workerHarness.ts";

const s = suite("operator");

const ORIGIN = "https://yaos.test";
const RECOVERY_KEY = `recovery-${"k".repeat(40)}`;
const COOKIE_PATTERN = /^yaos_op=([A-Za-z0-9_-]{43}); HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=604800$/;
const CLEAR_COOKIE = "yaos_op=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";

/** R2 as the purge uses it: `list({prefix, limit})` and `delete(keys)`. `stuck` keeps every listing truncated. */
class FakeBucket {
	readonly keys = new Set<string>();
	stuck = false;
	lists = 0;
	list(options: { prefix?: string; limit?: number }) {
		this.lists++;
		const matching = [...this.keys].filter((key) => key.startsWith(options.prefix ?? "")).sort();
		const objects = matching.slice(0, options.limit ?? 1000).map((key) => ({ key }));
		return Promise.resolve({ objects, truncated: this.stuck || matching.length > objects.length });
	}
	delete(keys: string | string[]) {
		for (const key of typeof keys === "string" ? [keys] : keys) this.keys.delete(key);
		return Promise.resolve();
	}
}

interface World {
	cluster: VaultCluster;
	config: ReturnType<VaultCluster["config"]>;
	accesses: string[];
	env: WorkerEnv;
	bucket: FakeBucket;
	router: Router;
	fetch(path: string, init?: RequestInit & { cookie?: string; origin?: string | null; json?: unknown }): Promise<Response>;
}

async function withWorld(check: (world: World) => Promise<void>): Promise<void> {
	const cluster = new VaultCluster();
	try {
		const config = cluster.config();
		const recording = recordingConfigNamespace(config.host);
		const bucket = new FakeBucket();
		const env = { YAOS_VAULT: cluster.namespace(), YAOS_CONFIG: recording.namespace,
			YAOS_BUCKET: bucket as unknown as R2Bucket } as WorkerEnv;
		const world: World = {
			cluster, config, accesses: recording.accesses, env, bucket,
			router: new Router({ upgrades: new RecordingUpgrades() }),
			fetch(path, init = {}) {
				const { cookie, origin = ORIGIN, json: body, ...rest } = init;
				const headers = new Headers(rest.headers);
				if (origin !== null && (rest.method ?? "GET") !== "GET") headers.set("Origin", origin);
				if (cookie) headers.set("Cookie", `yaos_op=${cookie}`);
				if (body !== undefined) headers.set("Content-Type", "application/json");
				return world.router.fetch(new Request(`${ORIGIN}${path}`,
					{ ...rest, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
			},
		};
		await check(world);
	} finally {
		cluster.close();
	}
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return await response.json() as Record<string, unknown>;
}

function sessionOf(response: Response): string {
	const match = COOKIE_PATTERN.exec(response.headers.get("Set-Cookie") ?? "");
	assert.ok(match, "a D5 session cookie");
	return match[1]!;
}

interface Claimed {
	cookie: string;
	vaultId: string;
	pairingCode: string;
	vault: VaultObject;
}

async function claim(world: World): Promise<Claimed> {
	const response = await world.fetch("/claim", { method: "POST", json: { operatorRecoveryKey: RECOVERY_KEY } });
	assert.equal(response.status, 200, "claim");
	const body = await json(response);
	const vaultId = body.vaultId as string;
	return { cookie: sessionOf(response), vaultId, pairingCode: body.pairingCode as string,
		vault: world.cluster.objects.get(vaultId)! };
}

async function enrollVia(world: World, pairingCode: string, device: DeviceSeed): Promise<Record<string, unknown>> {
	const response = await world.fetch("/enroll", { method: "POST", origin: null, json: {
		pairingCode, enrollmentRequestId: `enroll-${device.deviceId}`, deviceId: device.deviceId,
		deviceToken: device.token, deviceName: device.deviceName } });
	assert.equal(response.status, 200, "enroll");
	return await json(response);
}

async function ownerCode(world: World, cookie: string, vaultId: string, purpose?: string): Promise<Response> {
	return await world.fetch(`/operator/vaults/${vaultId}/owner-code`,
		{ method: "POST", cookie, json: purpose === undefined ? {} : { purpose } });
}

function deviceFeed(world: World, vaultId: string, device: DeviceSeed): Promise<Response> {
	return world.router.fetch(new Request(`${ORIGIN}/vault/${vaultId}/streams/feed`, { headers: bearer(device) }), world.env);
}

function rows(world: World, vault?: VaultObject): { config: number; vault?: number } {
	return { config: world.config.model.totals.cf, ...(vault ? { vault: vault.model.totals.cf } : {}) };
}

function resetRows(world: World): void {
	world.config.model.reset();
	for (const object of world.cluster.objects.values()) object.model.reset();
}

// ---- D5 claim -----------------------------------------------------------------------------------------------------

s.test("D5 claim: §5 body, the session cookie, a code that enrolls on this host; a second claim is 409", async () => {
	await withWorld(async (world) => {
		assert.equal((await world.fetch("/claim", { method: "POST", body: "{", headers: { "Content-Type": "application/json" } }))
			.status, 400);
		const short = await world.fetch("/claim", { method: "POST", json: { operatorRecoveryKey: "x".repeat(31) } });
		assert.deepEqual([short.status, await json(short)], [400, { error: "invalid operatorRecoveryKey" }]);
		const notObject = await world.fetch("/claim", { method: "POST", json: [] });
		assert.deepEqual([notObject.status, await json(notObject)], [400, { error: "invalid json" }]);
		assert.equal(world.cluster.rpcs.length, 0, "nothing was initialized");

		const response = await world.fetch("/claim", { method: "POST", json: { operatorRecoveryKey: `  ${RECOVERY_KEY}  ` } });
		assert.equal(response.status, 200);
		assert.match(response.headers.get("Set-Cookie") ?? "", COOKIE_PATTERN);
		const body = await json(response);
		assert.deepEqual(Object.keys(body).sort(), ["capabilities", "host", "mobileSetupQrDataUrl", "obsidianUrl", "ok",
			"pairingCode", "pairingExpiresAt", "vaultId", "vaultName"]);
		const vaultId = body.vaultId as string;
		assert.match(vaultId, /^[A-Za-z0-9_-]{22}$/);
		assert.equal(body.ok, true);
		assert.equal(body.host, ORIGIN);
		assert.equal(body.vaultName, "Personal");
		assert.match(body.pairingCode as string, new RegExp(`^${vaultId}\\.[A-Za-z0-9_-]{32}$`));
		const vault = world.cluster.objects.get(vaultId)!;
		assert.equal(body.pairingExpiresAt, vault.timers.now + PAIRING_CODE_TTL_MS);
		assert.equal(body.obsidianUrl,
			`obsidian://yaos?${new URLSearchParams({ action: "setup", host: ORIGIN, pairingCode: body.pairingCode as string })}`);
		assert.match(body.mobileSetupQrDataUrl as string, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/);
		assert.equal((body.capabilities as { claimed: unknown }).claimed, true);
		assert.deepEqual(world.cluster.rpcs.map((rpc) => rpc.method), ["init", "mintOwnerCode"]);

		const laptop = newDevice("laptop-device-0001", "Laptop");
		const enrolled = await enrollVia(world, body.pairingCode as string, laptop);
		assert.equal(enrolled.host, ORIGIN, "the enrolled host is the public origin the Worker forwarded");
		assert.equal(enrolled.vaultId, vaultId);
		assert.equal((await deviceFeed(world, vaultId, laptop)).status, 200);
		const recovery = await json(await ownerCode(world, sessionOf(response), vaultId, "owner-recovery"));
		assert.equal(recovery.purpose, "owner-recovery");

		const rpcs = world.cluster.rpcs.length;
		for (const router of [world.router, new Router({ upgrades: new RecordingUpgrades() })]) {
			world.router = router;
			const again = await world.fetch("/claim", { method: "POST", json: { operatorRecoveryKey: RECOVERY_KEY } });
			assert.deepEqual([again.status, await json(again)], [409, { error: "already_claimed" }]);
			assert.equal(again.headers.get("Set-Cookie"), null);
		}
		assert.equal(world.cluster.rpcs.length, rpcs, "a refused claim initializes no vault");
	});
});

s.test("D5 CSRF: claim, login, logout, create, owner-code and delete need Origin and JSON; revoke needs Origin", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId } = await claim(world);
		const device = "laptop-device-0001";
		const routes: Array<[string, string, boolean]> = [["POST", "/claim", true], ["POST", "/operator/login", true],
			["POST", "/operator/logout", true], ["POST", "/operator/vaults", true],
			["POST", `/operator/vaults/${vaultId}/owner-code`, true], ["DELETE", `/operator/vaults/${vaultId}`, true],
			["DELETE", `/operator/vaults/${vaultId}/devices/${device}`, false]];
		const accesses = world.accesses.length;
		const rpcs = world.cluster.rpcs.length;
		for (const [method, path, needsJson] of routes) {
			for (const origin of [null, "https://evil.test", "null", `${ORIGIN}/`]) {
				const response = await world.fetch(path, { method, cookie, origin, json: {} });
				assert.deepEqual([response.status, await json(response)], [403, { error: "forbidden_origin" }],
					`${method} ${path} Origin ${origin}`);
			}
			const plain = await world.fetch(path, { method, cookie, body: "{}", headers: { "Content-Type": "text/plain" } });
			if (needsJson) {
				assert.deepEqual([plain.status, await json(plain)], [415, { error: "unsupported_media_type" }], `${method} ${path}`);
			} else {
				assert.equal(plain.status, 200, "revoke takes no body, so no media type");
			}
		}
		assert.deepEqual(world.accesses.slice(accesses).filter((access) => access !== "namespace.idFromName"
			&& access !== "namespace.get" && access !== "stub.authorize"), [], "refusals reach no config method");
		assert.deepEqual(world.cluster.rpcs.slice(rpcs).map((rpc) => rpc.method), ["revokeDevice"],
			"only the accepted revoke reached the vault");
		const charset = await world.fetch(`/operator/vaults/${vaultId}/owner-code`,
			{ method: "POST", cookie, body: "{}", headers: { "Content-Type": "Application/JSON; charset=utf-8" } });
		assert.equal(charset.status, 200, "media type parameters and case are ignored");
		const get = await world.fetch("/operator/state", { cookie, headers: { Origin: "https://evil.test" } });
		assert.equal(get.status, 200, "GETs carry no CSRF check");
	});
});

// ---- D5 login, logout, sessions -----------------------------------------------------------------------------

s.test("D5 login and logout: 401 on a wrong key, 429 after 20 failures a minute, sessions expire in 7 days", async () => {
	await withWorld(async (world) => {
		const before = await world.fetch("/operator/login", { method: "POST", json: { operatorRecoveryKey: RECOVERY_KEY } });
		assert.deepEqual([before.status, await json(before)], [401, { error: "unauthorized" }], "not claimed yet");
		const { cookie: claimCookie } = await claim(world);
		const wrong = { operatorRecoveryKey: "w".repeat(40) };
		// The pre-claim 401 was failure 1; failures 2-19 follow.
		for (let attempt = 2; attempt < 20; attempt++) {
			assert.equal((await world.fetch("/operator/login", { method: "POST", json: wrong })).status, 401, `failure ${attempt}`);
		}
		const login = await world.fetch("/operator/login", { method: "POST", json: { operatorRecoveryKey: RECOVERY_KEY } });
		assert.deepEqual([login.status, await json(login)], [200, { ok: true }], "the 20th attempt is still a login");
		const cookie = sessionOf(login);
		assert.notEqual(cookie, claimCookie);
		assert.equal((await world.fetch("/operator/login", { method: "POST", json: wrong })).status, 401, "failure 20");
		const blocked = await world.fetch("/operator/login", { method: "POST", json: { operatorRecoveryKey: RECOVERY_KEY } });
		assert.deepEqual([blocked.status, await json(blocked)], [429, { error: "too_many_attempts" }]);
		assert.equal(blocked.headers.get("Retry-After"), "60");
		world.config.clock.now += 60_000;
		assert.equal((await world.fetch("/operator/login", { method: "POST", json: { operatorRecoveryKey: RECOVERY_KEY } }))
			.status, 200, "a new window");

		const logout = await world.fetch("/operator/logout", { method: "POST", cookie, json: {} });
		assert.deepEqual([logout.status, await json(logout)], [200, { ok: true }]);
		assert.equal(logout.headers.get("Set-Cookie"), CLEAR_COOKIE);
		assert.equal((await world.fetch("/operator/state", { cookie })).status, 401, "the session row is gone");
		assert.equal((await world.fetch("/operator/state", { cookie: claimCookie })).status, 200, "other sessions live on");
		const anonymous = await world.fetch("/operator/logout", { method: "POST", json: {} });
		assert.equal(anonymous.headers.get("Set-Cookie"), CLEAR_COOKIE);

		const accesses = world.accesses.length;
		for (const value of ["", "short", `${claimCookie}x`, "a".repeat(42) + "!"]) {
			assert.equal((await world.fetch("/operator/state", { cookie: value || "=" })).status, 401);
		}
		assert.equal(world.accesses.length, accesses, "a malformed cookie is refused without a config call");
		world.config.clock.now += SESSION_TTL_MS;
		assert.equal((await world.fetch("/operator/state", { cookie: claimCookie })).status, 401, "D5: 7-day sessions");
	});
});

// ---- state, vaults, owner code, devices --------------------------------------------------------------------------

s.test("D5 state, create vault, owner-code and devices: the console's shapes", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, pairingCode } = await claim(world);
		const claimedAt = world.config.clock.now;
		assert.equal((await world.fetch("/operator/state")).status, 401);
		const state = await world.fetch("/operator/state", { cookie });
		assert.deepEqual(await json(state), { vaults: [{ vaultId, name: "Personal", createdAt: claimedAt }], pendingRestores: [] });

		world.config.clock.now += 1000;
		const created = await json(await world.fetch("/operator/vaults", { method: "POST", cookie, json: {} }));
		const work = (created.vault as { vaultId: string }).vaultId;
		assert.deepEqual(created, { ok: true, vault: { vaultId: work, name: "Vault", createdAt: claimedAt + 1000 } });
		const trimmed = await json(await world.fetch("/operator/vaults", { method: "POST", cookie, json: { name: "  Work  " } }));
		assert.equal((trimmed.vault as { name: string }).name, "Work");
		const max = await world.fetch("/operator/vaults", { method: "POST", cookie, json: { name: "x".repeat(80) } });
		assert.equal(max.status, 200);
		const rpcs = world.cluster.rpcs.length;
		const long = await world.fetch("/operator/vaults", { method: "POST", cookie, json: { name: "x".repeat(81) } });
		assert.deepEqual([long.status, await json(long)], [400, { error: "invalid_name" }]);
		assert.equal((await world.fetch("/operator/vaults", { method: "POST", json: {} })).status, 401);
		assert.equal(world.cluster.rpcs.length, rpcs, "a refused create initializes nothing");
		const listed = (await json(await world.fetch("/operator/state", { cookie }))).vaults as Array<{ name: string }>;
		assert.equal(listed[0]!.name, "Personal", "ordered by createdAt (then vaultId)");
		assert.deepEqual(listed.map((vault) => vault.name).sort(), ["Personal", "Vault", "Work", "x".repeat(80)]);

		const code = await ownerCode(world, cookie, work);
		assert.equal(code.status, 200);
		const body = await json(code);
		assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "mobileSetupQrDataUrl", "mobileSetupUrl", "obsidianUrl", "ok",
			"pairingCode", "purpose"]);
		assert.equal(body.purpose, "owner-bootstrap", "the default purpose");
		assert.match(body.pairingCode as string, new RegExp(`^${work}\\.`));
		assert.equal(body.mobileSetupUrl, `${ORIGIN}/mobile-setup#${new URLSearchParams({ host: ORIGIN,
			pairingCode: body.pairingCode as string })}`);
		assert.match(body.mobileSetupQrDataUrl as string, /^data:image\/svg\+xml;base64,/);
		for (const purpose of ["owner-bootstrap", "owner-recovery", "device"]) {
			assert.equal((await json(await ownerCode(world, cookie, work, purpose))).purpose, purpose);
		}
		const bogus = await ownerCode(world, cookie, work, "bogus");
		assert.deepEqual([bogus.status, await json(bogus)], [400, { error: "invalid_purpose" }]);
		const notJson = await world.fetch(`/operator/vaults/${work}/owner-code`,
			{ method: "POST", cookie, body: "not json", headers: { "Content-Type": "application/json" } });
		assert.equal((await json(notJson)).purpose, "owner-bootstrap", "a body that is not JSON is {}");
		const unknownId = "u".repeat(22);
		const before = world.cluster.rpcs.length;
		for (const [method, path] of [["POST", "owner-code"], ["GET", "devices"], ["DELETE", "devices/laptop-device-0001"]]) {
			const response = await world.fetch(`/operator/vaults/${unknownId}/${path}`, { method, cookie,
				...(method === "POST" ? { json: {} } : {}) });
			assert.deepEqual([response.status, await json(response)], [404, { error: "unknown_vault" }], path);
		}
		assert.equal(world.cluster.rpcs.length, before, "an unregistered vault is never reached");

		const laptop = newDevice("laptop-device-0001", "Laptop");
		await enrollVia(world, pairingCode, laptop);
		const devices = await world.fetch(`/operator/vaults/${vaultId}/devices`, { cookie });
		assert.equal(devices.status, 200);
		const text = await devices.text();
		assert.deepEqual(JSON.parse(text), { devices: [{ deviceId: laptop.deviceId, deviceName: "Laptop",
			enrolledAt: world.cluster.objects.get(vaultId)!.timers.now }] });
		assert.ok(!text.includes(laptop.token), "no token material");
		assert.equal((await world.fetch(`/operator/vaults/${vaultId}/devices`)).status, 401);
		assert.equal((await world.fetch(`/operator/vaults/${vaultId}/devices/x`, { cookie })).status, 404, "unknown route");
	});
});

// ---- D7 revoke through the operator route -----------------------------------------------------------------------

s.test("D7 operator revoke: the victim is closed 4403 before the response; its bearer is 401; idempotent", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, pairingCode, vault } = await claim(world);
		const laptop = newDevice("laptop-device-0001", "Laptop");
		await enrollVia(world, pairingCode, laptop);
		assert.equal(vault.host.acceptStreams(laptop.deviceId).status, 200);
		const socket = vault.registry.lastClient!;
		resetRows(world);
		const response = await world.fetch(`/operator/vaults/${vaultId}/devices/${laptop.deviceId}`,
			{ method: "DELETE", cookie });
		assert.equal(socket.closed?.code, 4403, "closed when the response arrived");
		assert.deepEqual(socket.last("error")?.code, "authority_superseded");
		assert.deepEqual([response.status, await json(response)],
			[200, { ok: true, deviceId: laptop.deviceId, revoked: true }]);
		assert.deepEqual(rows(world, vault), { config: 0, vault: 1 }, "§6.2 revoke = 1 row; the config DO only reads");
		assert.equal((await deviceFeed(world, vaultId, laptop)).status, 401, "T-REVOKE-401 through the Worker");
		const again = await world.fetch(`/operator/vaults/${vaultId}/devices/${laptop.deviceId}`, { method: "DELETE", cookie });
		assert.deepEqual(await json(again), { ok: true, deviceId: laptop.deviceId, revoked: false });
		assert.deepEqual(await json(await world.fetch(`/operator/vaults/${vaultId}/devices`, { cookie })), { devices: [] });
		assert.equal((await world.fetch(`/operator/vaults/${vaultId}/devices/${laptop.deviceId}`, { method: "DELETE" })).status,
			401);
	});
});

// ---- D5 delete vault ------------------------------------------------------------------------------------------

s.test("D5 delete vault: confirmation, wipe, the R2 prefix purge, then the registry; 503 purge_incomplete retries", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, pairingCode, vault } = await claim(world);
		const other = (await json(await world.fetch("/operator/vaults", { method: "POST", cookie, json: { name: "Other" } })))
			.vault as { vaultId: string };
		const laptop = newDevice("laptop-device-0001");
		await enrollVia(world, pairingCode, laptop);
		assert.equal(vault.host.acceptStreams(laptop.deviceId).status, 200);
		const socket = vault.registry.lastClient!;
		const ownKeys = Array.from({ length: 2500 }, (_, index) => `v/${vaultId}/blobs/${String(index).padStart(64, "0")}`);
		const kept = [`v/${other.vaultId}/blobs/${"a".repeat(64)}`, `v/${vaultId}x/blob`, `x/${vaultId}/blob`];
		for (const key of [...ownKeys, ...kept]) world.bucket.keys.add(key);

		for (const confirm of [undefined, other.vaultId, vaultId.toUpperCase()]) {
			const mismatch = await world.fetch(`/operator/vaults/${vaultId}`, { method: "DELETE", cookie,
				json: confirm === undefined ? {} : { confirmVaultId: confirm } });
			assert.deepEqual([mismatch.status, await json(mismatch)], [400, { error: "confirmation_mismatch" }]);
		}
		assert.equal(socket.closed, null, "a mismatch deletes nothing");

		world.bucket.stuck = true;
		resetRows(world);
		const stuck = await world.fetch(`/operator/vaults/${vaultId}`, { method: "DELETE", cookie, json: { confirmVaultId: vaultId } });
		assert.deepEqual([stuck.status, await json(stuck)], [503, { error: "purge_incomplete" }]);
		assert.equal(world.bucket.lists, MAX_PURGE_BATCHES, "the purge stops after MAX_PURGE_BATCHES listings");
		assert.deepEqual(socket.closed, { code: 1001, reason: "vault deleted" });
		assert.equal((await deviceFeed(world, vaultId, laptop)).status, 401, "the vault DO is already wiped");
		const listed = (await json(await world.fetch("/operator/state", { cookie }))).vaults as Array<{ vaultId: string }>;
		assert.ok(listed.some((entry) => entry.vaultId === vaultId), "the registry row stays until the purge completes");
		assert.equal(rows(world).config, 0);

		world.bucket.stuck = false;
		world.bucket.lists = 0;
		const deleted = await world.fetch(`/operator/vaults/${vaultId}`, { method: "DELETE", cookie, json: { confirmVaultId: vaultId } });
		assert.deepEqual([deleted.status, await json(deleted)], [200, { ok: true, vaultId }]);
		assert.deepEqual([...world.bucket.keys].sort(), [...kept].sort(), "only v/<vaultId>/ was purged");
		assert.equal(world.bucket.lists, 1, "the retry found nothing left to list past one batch");
		assert.deepEqual(rows(world), { config: 1 }, "§6.2 delete vault = 1 config row (+ deleteAll)");
		const after = await json(await world.fetch("/operator/state", { cookie }));
		assert.deepEqual((after.vaults as Array<{ vaultId: string }>).map((entry) => entry.vaultId), [other.vaultId]);
		const gone = await world.fetch(`/operator/vaults/${vaultId}/devices`, { cookie });
		assert.deepEqual([gone.status, await json(gone)], [404, { error: "unknown_vault" }]);
		const enroll = await world.fetch("/enroll", { method: "POST", origin: null, json: { pairingCode,
			enrollmentRequestId: "enroll-after-delete", deviceId: "after-delete-00001", deviceToken: newDevice("x").token } });
		assert.equal(enroll.status, 404);

		// Without a bucket binding there is nothing to purge.
		const bucketless = { ...world.env, YAOS_BUCKET: undefined } as WorkerEnv;
		const response = await world.router.fetch(new Request(`${ORIGIN}/operator/vaults/${other.vaultId}`, {
			method: "DELETE", headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: `yaos_op=${cookie}` },
			body: JSON.stringify({ confirmVaultId: other.vaultId }) }), bucketless);
		assert.equal(response.status, 200);
	});
});

// ---- D8b restore seam ----------------------------------------------------------------------------------------

s.test("D8b seam: a restore journal row freezes revoke, owner-code and reset (409); delete vault wins", async () => {
	await withWorld(async (world) => {
		const { cookie, vaultId, pairingCode } = await claim(world);
		const laptop = newDevice("laptop-device-0001");
		await enrollVia(world, pairingCode, laptop);
		const at = world.config.clock.now - 5000;
		world.config.storage.sql.exec("INSERT INTO restore_journal (vault_id, restore_id, at, bookmark, devices, created_at)"
			+ " VALUES (?, 'restore-1', ?, NULL, NULL, ?)", vaultId, at, world.config.clock.now);
		const rpcs = world.cluster.rpcs.length;
		const frozen: Array<[string, string]> = [["DELETE", `/operator/vaults/${vaultId}/devices/${laptop.deviceId}`],
			["POST", `/operator/vaults/${vaultId}/owner-code`]];
		for (const [method, path] of frozen) {
			const response = await world.fetch(path, { method, cookie, ...(method === "POST" ? { json: {} } : {}) });
			assert.deepEqual([response.status, await json(response)], [409, { error: "restore_in_progress" }], path);
		}
		assert.equal(world.cluster.rpcs.length, rpcs, "a frozen action never reaches the vault DO");
		assert.deepEqual(await world.config.host.authorize(cookie, vaultId, "reset"),
			{ ok: false, status: 409, error: "restore_in_progress" }, "the reset action is frozen too (P3 route)");
		assert.equal((await deviceFeed(world, vaultId, laptop)).status, 200, "the device was not revoked");
		assert.equal((await world.fetch(`/operator/vaults/${vaultId}/devices`, { cookie })).status, 200, "reads are not frozen");
		const created = await json(await world.fetch("/operator/vaults", { method: "POST", cookie, json: { name: "B" } }));
		const second = (created.vault as { vaultId: string }).vaultId;
		assert.equal((await ownerCode(world, cookie, second)).status, 200, "another vault is not frozen");
		assert.deepEqual((await json(await world.fetch("/operator/state", { cookie }))).pendingRestores, [{ vaultId, at }]);

		resetRows(world);
		const deleted = await world.fetch(`/operator/vaults/${vaultId}`, { method: "DELETE", cookie, json: { confirmVaultId: vaultId } });
		assert.equal(deleted.status, 200, "D8b: vault delete wins");
		assert.deepEqual([...world.config.model.totals.byTable].sort(), [["restore_journal", 1], ["vault", 1]]);
		assert.deepEqual((await json(await world.fetch("/operator/state", { cookie }))).pendingRestores, []);
	});
});

// ---- T-ROWS-WB ------------------------------------------------------------------------------------------------

s.test("T-ROWS-WB: claim 3+2, login 1 (+1 per pruned session), logout 1, create 1+1, owner code 1, enroll 2, replay 0", async () => {
	await withWorld(async (world) => {
		const response = await world.fetch("/claim", { method: "POST", json: { operatorRecoveryKey: RECOVERY_KEY } });
		const cookie = sessionOf(response);
		const { vaultId, pairingCode } = await json(response) as { vaultId: string; pairingCode: string };
		const vault = world.cluster.objects.get(vaultId)!;
		assert.deepEqual(rows(world, vault), { config: 3, vault: 2 }, "claim: operator+vault+session; vault init + owner code");
		assert.deepEqual([...world.config.model.totals.byTable], [["operator", 1], ["vault", 1], ["session", 1]]);

		const replayToken = newDevice("rows-device-00001").token;
		const steps: Array<[string, () => Promise<Response>, { config: number; vault?: number }]> = [
			["login", () => world.fetch("/operator/login", { method: "POST", json: { operatorRecoveryKey: RECOVERY_KEY } }),
				{ config: 1 }],
			["failed login", () => world.fetch("/operator/login", { method: "POST", json: { operatorRecoveryKey: "w".repeat(40) } }),
				{ config: 0 }],
			["state", () => world.fetch("/operator/state", { cookie }), { config: 0 }],
			["owner code", () => ownerCode(world, cookie, vaultId), { config: 0, vault: 1 }],
			["devices", () => world.fetch(`/operator/vaults/${vaultId}/devices`, { cookie }), { config: 0, vault: 0 }],
			["enroll", () => world.fetch("/enroll", { method: "POST", origin: null, json: { pairingCode,
				enrollmentRequestId: "enroll-rows-00001", deviceId: "rows-device-00001", deviceToken: replayToken } }),
			{ config: 0, vault: 2 }],
			["replay", () => world.fetch("/enroll", { method: "POST", origin: null, json: { pairingCode,
				enrollmentRequestId: "enroll-rows-00001", deviceId: "rows-device-00001", deviceToken: replayToken } }),
			{ config: 0, vault: 0 }],
		];
		for (const [label, run, expected] of steps) {
			resetRows(world);
			const result = await run();
			assert.ok(result.status === 200 || label === "failed login", `${label}: ${result.status}`);
			assert.deepEqual(rows(world, expected.vault === undefined ? undefined : vault), expected, label);
		}

		resetRows(world);
		const created = await json(await world.fetch("/operator/vaults", { method: "POST", cookie, json: { name: "Rows" } }));
		const fresh = world.cluster.objects.get((created.vault as { vaultId: string }).vaultId)!;
		assert.deepEqual(rows(world, fresh), { config: 1, vault: 1 }, "create vault: registry row; vault init");

		resetRows(world);
		const extra = sessionOf(await world.fetch("/operator/login", { method: "POST", json: { operatorRecoveryKey: RECOVERY_KEY } }));
		resetRows(world);
		await world.fetch("/operator/logout", { method: "POST", cookie: extra, json: {} });
		assert.deepEqual(rows(world), { config: 1 }, "logout: the session row");
		resetRows(world);
		await world.fetch("/operator/logout", { method: "POST", cookie: extra, json: {} });
		assert.deepEqual(rows(world), { config: 0 }, "a second logout deletes nothing");

		// Three live sessions (claim, the first login, nothing else): all expired 7 days on → 1 insert + 2 pruned.
		world.config.clock.now += SESSION_TTL_MS;
		resetRows(world);
		assert.equal((await world.fetch("/operator/login", { method: "POST", json: { operatorRecoveryKey: RECOVERY_KEY } }))
			.status, 200);
		assert.deepEqual([...world.config.model.totals.byTable], [["session", 3]], "login: 1 + 1 per pruned session");
	});
});

await s.done();
