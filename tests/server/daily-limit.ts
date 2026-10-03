import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_COOKIE } from "../../server/src/identity";
import { handleWorkerRequest } from "../../server/src/index";
import { invalidateStoredServerConfigCache } from "../../server/src/routes/auth";
import {
	SIMULATE_DAILY_LIMIT_RUNTIME_PATH,
	VaultSyncServer,
	type CloudflareVaultEnvironment,
} from "../../server/src/server";
import {
	CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE,
	DAILY_LIMIT_ERROR_CODE,
	DailyLimitLatch,
	dailyLimitKind,
	dailyLimitResponse,
	instrumentStorageForDailyLimit,
	isCloudflareDailyLimitError,
	isWriteStatement,
	nextUtcMidnight,
} from "../../server/src/dailyLimit";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { FakeObjectStore, makeConfigNamespace, makeDurableObjectState, makeEnv, makeVaultSyncNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("daily-limit (D8 server)");

const NOW = Date.UTC(2026, 9, 2, 13, 45, 7);
const MIDNIGHT = Date.UTC(2026, 9, 3);

s.test("classifies Cloudflare's free-tier daily row limit errors and nothing else", () => {
	assert.equal(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE, "Exceeded allowed rows written in Durable Objects free tier.");
	for (const positive of [
		new Error(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE),
		new Error("Error: exceeded allowed rows written in durable objects free tier."),
		new Error("Exceeded allowed rows read in Durable Objects free tier."),
		new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue."),
		new Error("vault_runtime_failed", { cause: new Error(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE) }),
		CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE,
		{ message: CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE },
	]) assert.equal(isCloudflareDailyLimitError(positive), true, String(positive));
	for (const negative of [
		new Error("SQLITE_FULL: database or disk is full"),
		new Error("Durable Object storage operation exceeded timeout"),
		new Error("durability_failed"),
		new Error("Exceeded CPU time limit"),
		null, undefined, 42, {},
	]) assert.equal(isCloudflareDailyLimitError(negative), false, String(negative));
	assert.equal(dailyLimitKind(new Error(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE)), "rows-written");
	assert.equal(dailyLimitKind(new Error("Exceeded allowed rows read in Durable Objects free tier.")), "rows-read");
});

s.test("the limit resets at the next 00:00 UTC", () => {
	assert.equal(nextUtcMidnight(NOW), MIDNIGHT);
	assert.equal(nextUtcMidnight(Date.UTC(2026, 9, 2)), MIDNIGHT, "exactly midnight -> the next one");
	assert.equal(nextUtcMidnight(Date.UTC(2026, 11, 31, 23, 59, 59)), Date.UTC(2027, 0, 1));
});

s.test("HTTP answer is a typed 503 with Retry-After", async () => {
	const response = dailyLimitResponse(NOW);
	assert.equal(response.status, 503);
	assert.equal(response.headers.get("retry-after"), String(Math.ceil((MIDNIGHT - NOW) / 1000)));
	const body = await response.json() as Record<string, unknown>;
	assert.equal(body.error, DAILY_LIMIT_ERROR_CODE);
	assert.equal(body.resetAt, MIDNIGHT);
	assert.equal(body.kind, "rows-written");
	assert.equal(body.message, "Cloudflare's daily free limit was reached. Sync resumes at 00:00 UTC. The $5/month Workers Paid plan removes this limit.", "same wording as the client notice");
});

s.test("latched limit types every VAULT_ERROR frame and leaves other frames alone", () => {
	let now = NOW;
	const latch = new DailyLimitLatch(() => now);
	const plain = { type: "VAULT_ERROR", code: "durability_failed", message: "update was not committed; reconnect to resend" };
	assert.deepEqual(latch.decorateControl(plain), plain, "not latched: unchanged");
	assert.equal(latch.note(new Error("other")), false);
	assert.equal(latch.note(new Error(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE)), true);
	const typed = latch.decorateControl(plain) as Record<string, unknown>;
	assert.equal(typed.code, DAILY_LIMIT_ERROR_CODE);
	assert.equal(typed.cause, "durability_failed");
	assert.equal(typed.resetAt, MIDNIGHT);
	const ready = { type: "VAULT_READY" };
	assert.equal(latch.decorateControl(ready), ready);
	now = MIDNIGHT;
	assert.equal(latch.active(), false, "clears itself at 00:00 UTC");
	assert.deepEqual(latch.decorateControl(plain), plain);
	// A frame whose own message is the limit error is typed and latches.
	const direct = latch.decorateControl({ type: "VAULT_ERROR", message: CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE }) as Record<string, unknown>;
	assert.equal(direct.code, DAILY_LIMIT_ERROR_CODE);
	assert.equal(latch.active(), true);
});

s.test("write-statement detection used by the simulation", () => {
	for (const write of ["INSERT INTO t VALUES (1)", "  update t set a=1", "DELETE FROM t", "REPLACE INTO t VALUES (1)",
		"CREATE TABLE IF NOT EXISTS t (a)", "-- note\nINSERT INTO t VALUES (1)"]) assert.equal(isWriteStatement(write), true, write);
	for (const read of ["SELECT * FROM t", "  select 1", "PRAGMA table_info(t)", "WITH x AS (SELECT 1) SELECT * FROM x"]) {
		assert.equal(isWriteStatement(read), false, read);
	}
});

s.test("storage instrumentation: simulation blocks writes only, and real limit errors latch", async () => {
	const executed: string[] = [];
	let failNext: Error | null = null;
	const storage = {
		sql: {
			exec(query: string) {
				if (failNext) { const error = failNext; failNext = null; throw error; }
				executed.push(query);
				return { toArray: () => [] };
			},
			get databaseSize() { return 7; },
		},
		transactionSync<T>(run: () => T): T { return run(); },
		async setAlarm() { throw new Error(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE); },
	};
	let simulate = false;
	const latch = new DailyLimitLatch(() => NOW);
	const wrapped = instrumentStorageForDailyLimit(storage, latch, () => simulate);
	wrapped.sql.exec("INSERT INTO t VALUES (1)");
	assert.equal(wrapped.sql.databaseSize, 7, "other members pass through");
	assert.equal(wrapped.transactionSync(() => 3), 3);
	assert.equal(latch.active(), false);
	simulate = true;
	assert.throws(() => wrapped.transactionSync(() => wrapped.sql.exec("UPDATE t SET a = 2")), new RegExp(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE.replace(".", "\\.")));
	wrapped.sql.exec("SELECT * FROM t");
	assert.deepEqual(executed, ["INSERT INTO t VALUES (1)", "SELECT * FROM t"], "the blocked write never ran");
	assert.equal(latch.active(), true, "the simulated error latches like the real one");
	latch.clear();
	simulate = false;
	failNext = new Error(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE);
	assert.throws(() => wrapped.sql.exec("INSERT INTO t VALUES (3)"));
	assert.equal(latch.active(), true, "a real thrown limit error latches");
	latch.clear();
	await assert.rejects(wrapped.setAlarm());
	assert.equal(latch.active(), true, "async storage API rejections latch too");
	// b3: a successful row write clears the latch (Workers Paid mid-day); DDL does not.
	wrapped.sql.exec("CREATE TABLE IF NOT EXISTS t (a)");
	assert.equal(latch.active(), true, "an idempotent CREATE proves nothing");
	wrapped.sql.exec("INSERT INTO t VALUES (4)");
	assert.equal(latch.active(), false, "a row write succeeded: the limit no longer applies");
	// b3: KV/alarm writes are billed rows too and are blocked by the simulation.
	const kv = { async put() {}, async get() { return 1; } };
	const wrappedKv = instrumentStorageForDailyLimit(kv, latch, () => true);
	await assert.rejects(wrappedKv.put(), /free tier/);
	assert.equal(await wrappedKv.get(), 1, "KV reads pass");
});

// ---------------------------------------------------------------------------
// Durable Object: the simulation switch and the typed HTTP answer end to end.
// ---------------------------------------------------------------------------

const VAULT_ID = "vault-dlimit-0001";
const GENERATION = "generation-dlimit-0001";

interface AlarmLog { calls: number[]; current(): number | null }

async function withVaultObject(env: CloudflareVaultEnvironment,
	check: (server: VaultSyncServer, alarms: AlarmLog) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-daily-limit-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	let alarm: number | null = null;
	const log: AlarmLog = { calls: [], current: () => alarm };
	const base = makeDurableObjectState({ getWebSockets: () => [] });
	const storage = Object.assign(sqlite, {
		setAlarm: async (time: number) => { log.calls.push(time); alarm = time; },
		getAlarm: async () => alarm,
		deleteAlarm: async () => { alarm = null; },
		deleteAll: async () => {},
	});
	const state = { ...base, storage: storage as never } as DurableObjectState;
	try {
		await check(new VaultSyncServer(state, env), log);
	} finally {
		sqlite.database.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function internal(path: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	headers.set("x-yaos-vault-id", VAULT_ID);
	headers.set("x-yaos-vault-generation", GENERATION);
	return new Request(`https://internal${path}`, { ...init, headers });
}

const provisionRequest = () => internal("/__yaos/provision", { method: "POST",
	headers: { "content-type": "application/json" }, body: JSON.stringify({ vaultGeneration: GENERATION }) });
const writeRequest = () => internal("/__yaos/revoke-device-sockets", { method: "POST",
	headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: "device-dlimit-0001" }) });
const simulate = (enabled: boolean) => internal(SIMULATE_DAILY_LIMIT_RUNTIME_PATH, { method: "POST",
	headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });

s.test("the Durable Object answers 404 for the simulation path without the debug var", async () => {
	await withVaultObject({ YAOS_TEST_ONLY_SIMULATE_DAILY_LIMIT: "true" }, async (server) => {
		const provisioned = await server.fetch(provisionRequest());
		assert.ok(provisioned.ok, "the env switch alone is inert without YAOS_TEST_ONLY_DEBUG_ROUTES");
		assert.equal((await server.fetch(simulate(true))).status, 404);
		assert.equal((await server.fetch(writeRequest())).status, 200);
	});
});

s.test("simulated limit: writes answer a typed 503, reads still work, switching off restores writes", async () => {
	await withVaultObject({ YAOS_TEST_ONLY_DEBUG_ROUTES: "true" }, async (server) => {
		assert.ok((await server.fetch(provisionRequest())).ok);
		const on = await server.fetch(simulate(true));
		assert.deepEqual(await on.json(), { simulated: "daily-limit", enabled: true });
		const limited = await server.fetch(writeRequest());
		assert.equal(limited.status, 503);
		assert.ok(Number(limited.headers.get("retry-after")) > 0);
		const body = await limited.json() as Record<string, unknown>;
		assert.equal(body.error, DAILY_LIMIT_ERROR_CODE);
		assert.equal(body.resetAt, nextUtcMidnight(Date.now()));
		const health = await server.fetch(internal("/health"));
		assert.notEqual(health.status, 503, "read-only requests are not blocked by a rows-written limit");
		const off = await server.fetch(simulate(false));
		assert.deepEqual(await off.json(), { simulated: "daily-limit", enabled: false });
		assert.equal((await server.fetch(writeRequest())).status, 200);
	});
});

s.test("YAOS_TEST_ONLY_SIMULATE_DAILY_LIMIT starts the object limited (with the debug var)", async () => {
	await withVaultObject({ YAOS_TEST_ONLY_DEBUG_ROUTES: "true", YAOS_TEST_ONLY_SIMULATE_DAILY_LIMIT: "true" }, async (server) => {
		const response = await server.fetch(provisionRequest());
		assert.equal(response.status, 503);
		assert.equal((await response.json() as Record<string, unknown>).error, DAILY_LIMIT_ERROR_CODE);
	});
});

s.test("b3-clientblob: the simulated limit survives a cold restart of the object (hibernation/eviction)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-daily-limit-restart-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	const storage = Object.assign(sqlite, {
		setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {}, deleteAll: async () => {},
	});
	const state = { ...makeDurableObjectState({ getWebSockets: () => [] }), storage: storage as never } as DurableObjectState;
	const env = { YAOS_TEST_ONLY_DEBUG_ROUTES: "true" } as CloudflareVaultEnvironment;
	try {
		const first = new VaultSyncServer(state, env);
		assert.ok((await first.fetch(provisionRequest())).ok);
		assert.equal((await first.fetch(simulate(true))).status, 200);
		// A new object over the same storage = the constructor a hibernation wake or eviction runs.
		const woken = new VaultSyncServer(state, env);
		assert.equal((await woken.fetch(writeRequest())).status, 503, "the switch is still on after the wake");
		assert.equal((await woken.fetch(simulate(false))).status, 200, "a woken, simulated object can still be switched off");
		assert.equal((await woken.fetch(writeRequest())).status, 200);
		const again = new VaultSyncServer(state, env);
		assert.equal((await again.fetch(writeRequest())).status, 200, "switching off is persisted too");
		const plain = new VaultSyncServer(state, {} as CloudflareVaultEnvironment);
		assert.equal((await plain.fetch(writeRequest())).status, 200, "inert without the debug var");
	} finally {
		sqlite.database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Alarms (b3, relay3): every setAlarm is a billed row; none may loop while limited.
// ---------------------------------------------------------------------------

const RELAY_ENV = { YAOS_TEST_ONLY_DEBUG_ROUTES: "true", YAOS_RELAY_BODIES: "true", YAOS_RELAY_LEAN_ROWS: "true",
	YAOS_RELAY_GROUP_COMMIT: "1" } as CloudflareVaultEnvironment;

interface RuntimeInternals {
	runtime: {
		dailyLimit: DailyLimitLatch;
		relayCheckpointAlarmArmed: boolean;
		relay: { options: { armCheckpointAlarm(): void } };
		armAlarmEarliest(at: number): Promise<string>;
	};
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

s.test("latched: every alarm (catalog window, relay retry, alarm pass) is held to 00:00 UTC; repeated alarms arm at most once", async () => {
	await withVaultObject(RELAY_ENV, async (server, alarms) => {
		assert.ok((await server.fetch(provisionRequest())).ok);
		const runtime = (server as unknown as RuntimeInternals).runtime;
		runtime.dailyLimit.note(new Error(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE));
		const resetAt = nextUtcMidnight(Date.now());
		alarms.calls.length = 0;
		// The relay's windowed catalog/checkpoint alarm.
		runtime.relay.options.armCheckpointAlarm();
		await settle();
		assert.deepEqual(alarms.calls, [resetAt], "the catalog alarm is clamped to the reset");
		// A burst of +1 ms re-arm requests (the relay retry path) while limited: no new row.
		for (let index = 0; index < 50; index++) assert.equal(await runtime.armAlarmEarliest(Date.now() + 1), "kept");
		assert.deepEqual(alarms.calls, [resetAt]);
		const diagnostics = await (runtime as unknown as { diagnostics(): Response }).diagnostics().json() as
			{ dailyLimit: Record<string, unknown> };
		assert.equal(diagnostics.dailyLimit.active, true);
		assert.equal(diagnostics.dailyLimit.resetAt, resetAt);
	});
});

s.test("simulated limit: setAlarm itself fails -> noted, alarm() never throws, the catalog alarm re-arms after the reset", async () => {
	await withVaultObject(RELAY_ENV, async (server, alarms) => {
		assert.ok((await server.fetch(provisionRequest())).ok);
		const runtime = (server as unknown as RuntimeInternals).runtime;
		assert.ok((await server.fetch(simulate(true))).ok);
		alarms.calls.length = 0;
		runtime.relay.options.armCheckpointAlarm();
		await settle();
		assert.deepEqual(alarms.calls, [], "the simulated limit blocks the alarm write");
		assert.equal(runtime.dailyLimit.active(), true, "a limited setAlarm latches");
		assert.equal(runtime.relayCheckpointAlarmArmed, false, "not stuck as armed when nothing was armed");
		// Count attempted alarm writes at the (instrumented) port: none before the reset.
		const port = (runtime as unknown as { options: { alarms: { setAlarm(at: number): Promise<void> } } }).options.alarms;
		const original = port.setAlarm.bind(port);
		const attempts: number[] = [];
		port.setAlarm = (at) => { attempts.push(at); return original(at); };
		for (let index = 0; index < 20; index++) await server.alarm(); // must not throw
		assert.deepEqual(alarms.calls, []);
		const resetAt = nextUtcMidnight(Date.now());
		for (const at of attempts) assert.ok(at >= resetAt, `alarm attempted before the reset: ${at}`);
		assert.ok(attempts.length <= 20, `at most one attempt per alarm pass: ${attempts.length}`);
		port.setAlarm = original;
		assert.ok((await server.fetch(simulate(false))).ok);
		runtime.relay.options.armCheckpointAlarm();
		await settle();
		assert.equal(alarms.calls.length, 1, "after the reset the next commit arms the window alarm normally");
		assert.ok(alarms.calls[0]! < nextUtcMidnight(Date.now()));
	});
});

s.test("b3-int2: a persisted simulated limit reaches the cold object's alarm; the owed projection wake is held, then runs after the clear", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-daily-limit-wake-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	let alarm: number | null = null;
	const calls: number[] = [];
	const storage = Object.assign(sqlite, {
		setAlarm: async (time: number) => { calls.push(time); alarm = time; },
		getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null; }, deleteAll: async () => {},
	});
	const state = { ...makeDurableObjectState({ getWebSockets: () => [] }), storage: storage as never } as DurableObjectState;
	const env = { ...RELAY_ENV, YAOS_BUCKET: new FakeObjectStore() } as unknown as CloudflareVaultEnvironment;
	const wakeRows = () => sqlite.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM recovery_projection_wake").one().count;
	try {
		const first = new VaultSyncServer(state, env);
		assert.ok((await first.fetch(provisionRequest())).ok);
		(first as unknown as { runtime: { store: { oweProjectionWake(at: number): void } } }).runtime.store.oweProjectionWake(Date.now() - 1);
		assert.equal(wakeRows(), 1);
		assert.equal((await first.fetch(simulate(true))).status, 200);
		// Cold object (hibernation/eviction): only the persisted switch can reach its alarm.
		const woken = new VaultSyncServer(state, env);
		calls.length = 0;
		for (let index = 0; index < 20; index++) await woken.alarm(); // must not throw (no platform retry loop)
		assert.deepEqual(calls, [], "no alarm row is written while simulated");
		assert.equal(wakeRows(), 1, "the owed projection wake survives the held alarms");
		assert.equal((await woken.fetch(simulate(false))).status, 200);
		await woken.alarm();
		assert.equal(wakeRows(), 0, "after the clear the alarm runs the projection wake and settles it");
	} finally {
		sqlite.database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Worker gate: like simulate-restart (404 without the var, operator session).
// ---------------------------------------------------------------------------

const CLAIM = { configFormat: 3, claimed: true, operatorRecoveryHash: "a".repeat(64),
	ticketSigningKey: "ticket-signing-key-for-tests", updateProvider: null, updateRepoUrl: null, updateRepoBranch: null };
const ROUTE = `https://example.test/vault/${VAULT_ID}/debug/simulate-daily-limit`;

function gateEnv(extra: Record<string, string>, sessionValid: boolean) {
	const config = makeConfigNamespace(async (request) => {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/__yaos/config") return Response.json(CLAIM);
		if (pathname === "/__yaos/verify-session") return Response.json({ ok: sessionValid }, { status: sessionValid ? 200 : 401 });
		if (pathname === "/__yaos/vault") {
			return Response.json({ vault: { vaultId: VAULT_ID, name: "Limit", state: "active",
				vaultGeneration: GENERATION, createdAt: 1, provisionedAt: 2 } });
		}
		throw new Error(`unexpected config request: ${pathname}`);
	});
	const forwarded: string[] = [];
	const sync = makeVaultSyncNamespace(async (request) => {
		forwarded.push(new URL(request.url).pathname);
		return Response.json({ simulated: "daily-limit", enabled: true });
	});
	return { env: makeEnv({ YAOS_CONFIG: config, YAOS_SYNC: sync, ...extra }), sync, forwarded };
}

s.test("Worker route: 404 without YAOS_TEST_ONLY_DEBUG_ROUTES, 401 without operator session, forwards with one", async () => {
	invalidateStoredServerConfigCache();
	const closed = gateEnv({ YAOS_ENABLE_ADMIN_ROUTES: "true" }, true);
	const hidden = await handleWorkerRequest(new Request(ROUTE, { method: "POST",
		headers: { Cookie: `${OPERATOR_COOKIE}=operator-session` } }), closed.env);
	assert.equal(hidden.status, 404);
	assert.equal(closed.sync.calls, 0);
	invalidateStoredServerConfigCache();
	const denied = gateEnv({ YAOS_TEST_ONLY_DEBUG_ROUTES: "true" }, false);
	const device = await handleWorkerRequest(new Request(ROUTE, { method: "POST",
		headers: { Authorization: "Bearer device-token" } }), denied.env);
	assert.equal(device.status, 401, await device.clone().text());
	assert.equal(denied.sync.calls, 0);
	invalidateStoredServerConfigCache();
	const allowed = gateEnv({ YAOS_TEST_ONLY_DEBUG_ROUTES: "true" }, true);
	const response = await handleWorkerRequest(new Request(ROUTE, { method: "POST",
		headers: { Cookie: `${OPERATOR_COOKIE}=operator-session` }, body: JSON.stringify({ enabled: true }) }), allowed.env);
	assert.equal(response.status, 200);
	assert.deepEqual(allowed.forwarded, [SIMULATE_DAILY_LIMIT_RUNTIME_PATH]);
	invalidateStoredServerConfigCache();
});

await s.done();
