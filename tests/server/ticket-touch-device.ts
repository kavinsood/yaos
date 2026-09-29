import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityDigestForRole, COLLABORATION_POLICY_VERSION, type VaultActorContext } from "../../server/src/collaboration";
import { ControlPlaneRuntime } from "../../server/src/config";
import { DEVICE_LAST_SEEN_RESOLUTION_MS } from "../../server/src/contracts";
import { SqlControlPlaneStorage, type ControlPlaneSqlHost } from "../../server/src/controlPlaneSql";
import type { DeviceRecord } from "../../server/src/identity";
import type { ControlPlaneStoragePort, ControlPlaneTransactionPort } from "../../server/src/platformPorts";
import { handleTicketRoute } from "../../server/src/routes/ticket";
import type { AuthState } from "../../server/src/routes/types";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { makeConfigNamespace, makeEnv } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

// Every socket open and ticket refresh mints a ticket. The device `lastSeenAt`
// touch rides along as best-effort presence metadata on the singleton control
// plane; it must neither delay the ticket nor write once per ticket.

const s = suite("ticket-touch-device");
const AUTH: AuthState = {
	mode: "claim",
	claimed: true,
	operatorRecoveryHash: "operator-recovery-hash",
	ticketSigningKey: "ticket-signing-key-for-tests",
};
const json = (body: unknown, status = 200) => Response.json(body, { status });

// The coalescing map is isolate-wide, so each case uses its own device.
let deviceSequence = 0;
async function actor(vaultId = "touch-vault-0001"): Promise<VaultActorContext> {
	deviceSequence++;
	return {
		vaultId, vaultGeneration: "touch-generation-0001", principalId: "touch-principal-0001",
		membershipRevision: 1, deviceId: `touch-device-${String(deviceSequence).padStart(4, "0")}`,
		deviceCredentialRevision: 1, role: "member", policyVersion: COLLABORATION_POLICY_VERSION,
		capabilityDigest: await capabilityDigestForRole("member"),
	};
}

function ticketRequest(): Request {
	return new Request("https://example.test/vault/touch-vault-0001/auth/ticket", {
		method: "POST", body: JSON.stringify({ purpose: "root", documentId: "root", rootEpoch: 1 }),
	});
}

interface Deferred { promise: Promise<Response>; resolve(response: Response): void; reject(error: unknown): void }
function deferred(): Deferred {
	let resolve!: (response: Response) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<Response>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

/** Config actor whose touch-device calls stay pending until the test settles them. */
function pendingTouches() {
	const touches: Array<{ body: unknown; reply: Deferred }> = [];
	const namespace = makeConfigNamespace(async (request) => {
		assert.equal(new URL(request.url).pathname, "/__yaos/touch-device");
		const reply = deferred();
		touches.push({ body: await request.json(), reply });
		return await reply.promise;
	});
	const background: Promise<unknown>[] = [];
	const env = makeEnv({ YAOS_CONFIG: namespace, execution: { waitUntil: (task) => { background.push(task); } } });
	return { env, namespace, touches, background };
}

/** Fails instead of hanging when the route awaits the still-pending touch. */
async function withinDeadline<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("ticket response waited on touch-device")), 2_000);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

s.test("the ticket response does not wait for touch-device, which is handed to waitUntil", async () => {
	const { env, touches, background } = pendingTouches();
	const device = await actor();
	const response = await withinDeadline(handleTicketRoute(ticketRequest(), AUTH, device, json, env));
	assert.equal(response.status, 200);
	assert.equal(typeof (await response.json() as { ticket?: unknown }).ticket, "string");
	await flush();
	assert.equal(touches.length, 1, "touch-device is still issued");
	assert.deepEqual(touches[0]!.body, { deviceId: device.deviceId, vaultId: device.vaultId });
	assert.equal(background.length, 1, "the pending touch is kept alive past the response");
	touches[0]!.reply.resolve(Response.json({ ok: true }));
	await background[0];
});

s.test("touches are coalesced per device within the lastSeen resolution", async () => {
	const { env, namespace, touches } = pendingTouches();
	const device = await actor();
	const responses = await withinDeadline(Promise.all(Array.from({ length: 32 },
		() => handleTicketRoute(ticketRequest(), AUTH, device, json, env))));
	assert.deepEqual(responses.map((response) => response.status), Array(32).fill(200));
	await flush();
	assert.equal(namespace.calls, 1, "32 parallel tickets for one device touch once");
	touches[0]!.reply.resolve(Response.json({ ok: true }));
	await flush();
	await handleTicketRoute(ticketRequest(), AUTH, device, json, env);
	await flush();
	assert.equal(namespace.calls, 1, "a later ticket inside the window does not touch again");
	await handleTicketRoute(ticketRequest(), AUTH, await actor(), json, env);
	await flush();
	assert.equal(namespace.calls, 2, "another device is touched independently");
	touches[1]!.reply.resolve(Response.json({ ok: true }));

	const realNow = Date.now;
	const start = realNow();
	try {
		Date.now = () => start + DEVICE_LAST_SEEN_RESOLUTION_MS + 1;
		await handleTicketRoute(ticketRequest(), AUTH, device, json, env);
		await flush();
		assert.equal(namespace.calls, 3, "the device is touched again once the window has passed");
		touches[2]!.reply.resolve(Response.json({ ok: true }));
	} finally {
		Date.now = realNow;
	}
});

s.test("touch failures are swallowed and let the next ticket retry", async () => {
	const { env, namespace, touches, background } = pendingTouches();
	const device = await actor();
	assert.equal((await handleTicketRoute(ticketRequest(), AUTH, device, json, env)).status, 200);
	await flush();
	touches[0]!.reply.reject(new Error("control plane unavailable"));
	await Promise.all(background);
	assert.equal((await handleTicketRoute(ticketRequest(), AUTH, device, json, env)).status, 200);
	await flush();
	assert.equal(namespace.calls, 2, "a rejected touch does not suppress the retry");
	touches[1]!.reply.resolve(json({ error: "internal" }, 500));
	await Promise.all(background);
	assert.equal((await handleTicketRoute(ticketRequest(), AUTH, device, json, env)).status, 200);
	await flush();
	assert.equal(namespace.calls, 3, "a non-ok touch does not suppress the retry");
	touches[2]!.reply.resolve(Response.json({ ok: true }));
	await Promise.all(background);
});

s.test("hosts without an execution port still answer before the touch settles", async () => {
	const { namespace, touches } = pendingTouches();
	const env = makeEnv({ YAOS_CONFIG: namespace });
	const response = await withinDeadline(handleTicketRoute(ticketRequest(), AUTH, await actor(), json, env));
	assert.equal(response.status, 200);
	await flush();
	assert.equal(touches.length, 1);
	touches[0]!.reply.resolve(Response.json({ ok: true }));
});

function post(path: string, body: unknown): Request {
	return new Request(`https://internal${path}`, {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
	});
}

async function enrollDevice(runtime: ControlPlaneRuntime): Promise<{ vaultId: string; deviceId: string }> {
	const vaultId = "touch-control-vault";
	const pairingCodeHash = "a".repeat(64);
	const claim = await runtime.fetch(post("/__yaos/claim", {
		operatorRecoveryHash: "f".repeat(64), ticketSigningKey: "ticket-signing-key",
		vaultId, vaultName: "Touch Vault", pairingCodeHash, pairingPurpose: "origin",
	}));
	assert.equal(claim.status, 200);
	const { vaultGeneration } = await claim.json() as { vaultGeneration: string };
	assert.equal((await runtime.fetch(post("/__yaos/activate-vault", {
		vaultId, vaultGeneration, pairingCodeHash, pairingPurpose: "origin",
	}))).status, 200);
	const enrollment = await runtime.fetch(post("/__yaos/enroll", {
		enrollmentRequestId: "touch-enrollment-request", pairingCodeHash, deviceId: "touch-control-device",
		deviceTokenHash: "b".repeat(64), deviceName: "Touch Device",
	}));
	assert.equal(enrollment.status, 200, await enrollment.clone().text());
	return { vaultId, deviceId: "touch-control-device" };
}

async function assertRedundantTouchesSkipWrites(
	runtime: ControlPlaneRuntime,
	readLastSeen: (deviceId: string) => Promise<number | undefined>,
	writes: () => number,
): Promise<void> {
	const { vaultId, deviceId } = await enrollDevice(runtime);
	const touch = () => runtime.fetch(post("/__yaos/touch-device", { deviceId, vaultId }));
	const realNow = Date.now;
	const start = realNow();
	try {
		Date.now = () => start;
		let before = writes();
		assert.equal((await touch()).status, 200);
		assert.equal(await readLastSeen(deviceId), start);
		assert.equal(writes() - before, 1, "the first touch records lastSeenAt");
		Date.now = () => start + DEVICE_LAST_SEEN_RESOLUTION_MS - 1;
		before = writes();
		assert.equal((await touch()).status, 200);
		assert.equal(writes() - before, 0, "a touch inside the resolution does not write");
		assert.equal(await readLastSeen(deviceId), start);
		Date.now = () => start + DEVICE_LAST_SEEN_RESOLUTION_MS;
		before = writes();
		assert.equal((await touch()).status, 200);
		assert.equal(writes() - before, 1, "a stale lastSeenAt is refreshed");
		assert.equal(await readLastSeen(deviceId), start + DEVICE_LAST_SEEN_RESOLUTION_MS);
		assert.equal((await runtime.fetch(post("/__yaos/touch-device", { deviceId, vaultId: "other-vault" }))).status, 404,
			"the vault binding is still checked for fresh devices");
	} finally {
		Date.now = realNow;
	}
}

s.test("the control plane skips redundant lastSeenAt writes (record storage)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-touch-device-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "control.sqlite"));
	let upserts = 0;
	try {
		const store = new SqlControlPlaneStorage(sqlite as unknown as ControlPlaneSqlHost, "touch-config");
		const storage: ControlPlaneStoragePort = {
			get: (key) => store.get(key),
			put: (key, value) => store.put(key, value),
			transaction: (closure) => store.transaction((txn) => closure({
				...txn,
				get: (key) => txn.get(key),
				put: (key, value) => txn.put(key, value),
				delete: (key) => txn.delete(key),
				records: txn.records && new Proxy(txn.records, {
					get(target, property, receiver) {
						const value = Reflect.get(target, property, receiver) as unknown;
						if (property === "upsert") {
							return (collection: string, record: unknown) => {
								if (collection === "devices") upserts++;
								return target.upsert(collection, record);
							};
						}
						return typeof value === "function" ? value.bind(target) : value;
					},
				}),
			})),
		};
		await assertRedundantTouchesSkipWrites(
			new ControlPlaneRuntime(storage),
			async (deviceId) => (await store.transaction((txn) =>
				txn.records!.get<DeviceRecord>("devices", { recordKey: deviceId })))?.lastSeenAt,
			() => upserts,
		);
	} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("the control plane skips redundant lastSeenAt writes (legacy key storage)", async () => {
	const data = new Map<string, unknown>();
	let devicePuts = 0;
	const transaction: ControlPlaneTransactionPort = {
		get: async <T = unknown>(key: string) => structuredClone(data.get(key)) as T | undefined,
		put: async (key, value) => {
			if (key === "devices") devicePuts++;
			data.set(key, structuredClone(value));
		},
		delete: async (key) => data.delete(key),
	};
	const storage: ControlPlaneStoragePort = {
		...transaction,
		transaction: async <T>(closure: (txn: ControlPlaneTransactionPort) => Promise<T>) => closure(transaction),
	};
	await assertRedundantTouchesSkipWrites(
		new ControlPlaneRuntime(storage),
		async (deviceId) => (data.get("devices") as DeviceRecord[]).find((device) => device.deviceId === deviceId)?.lastSeenAt,
		() => devicePuts,
	);
});

s.test("a lastSeenAt touch rewrites only the unindexed payload: one row, no index entries (N6)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-touch-rows-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "control.sqlite"));
	const mutations: Array<{ query: string; rowsWritten: number }> = [];
	let recording = false;
	const host: ControlPlaneSqlHost = {
		sql: {
			exec: (query, ...bindings) => {
				const cursor = sqlite.sql.exec(query, ...bindings);
				if (recording && !/^\s*SELECT/i.test(query)) {
					mutations.push({ query: query.replace(/\s+/g, " ").trim(), rowsWritten: cursor.rowsWritten });
				}
				return cursor as never;
			},
		},
		transactionSync: (closure) => sqlite.transactionSync(closure),
	};
	const realNow = Date.now;
	try {
		const store = new SqlControlPlaneStorage(host, "touch-rows");
		const runtime = new ControlPlaneRuntime(store);
		const { vaultId, deviceId } = await enrollDevice(runtime);
		const start = realNow() + DEVICE_LAST_SEEN_RESOLUTION_MS;
		Date.now = () => start;
		recording = true;
		assert.equal((await runtime.fetch(post("/__yaos/touch-device", { deviceId, vaultId }))).status, 200);
		recording = false;
		assert.equal(mutations.length, 1, `one statement: ${JSON.stringify(mutations)}`);
		assert.match(mutations[0]!.query, /^UPDATE control_plane_records SET payload_json = \? WHERE/,
			"no indexed column is in the SET list, so SQLite writes no index entry");
		assert.equal(mutations[0]!.rowsWritten, 1);
		const device = await store.transaction((txn) => txn.records!.get<DeviceRecord>("devices", { tokenHash: "b".repeat(64) }));
		assert.equal(device?.deviceId, deviceId, "indexed lookups still find the touched record");
		assert.equal(device?.lastSeenAt, start);
		// A change to an indexed column still goes through the full upsert.
		await store.transaction(async (txn) => {
			await txn.records!.upsert("devices", { ...device!, tokenHash: "c".repeat(64) });
		});
		assert.equal(await store.transaction((txn) => txn.records!.get("devices", { tokenHash: "b".repeat(64) })), undefined);
		assert.equal((await store.transaction((txn) =>
			txn.records!.get<DeviceRecord>("devices", { tokenHash: "c".repeat(64) })))?.deviceId, deviceId);
	} finally {
		Date.now = realNow;
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
});

await s.done();
