import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_LAST_SEEN_RESOLUTION_MS } from "../../server/src/contracts";
import { CloudflareSocketRegistry } from "../../server/src/cloudflarePorts";
import {
	SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST,
	SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE,
} from "../../server/src/shared/socketLiveness";
import { OPERATOR_COOKIE } from "../../server/src/identity";
import { handleWorkerRequest } from "../../server/src/index";
import { invalidateStoredServerConfigCache } from "../../server/src/routes/auth";
import { SIMULATE_RESTART_RUNTIME_PATH, VaultSyncServer, type CloudflareVaultEnvironment } from "../../server/src/server";
import {
	PRODUCTION_PERSIST_DEBOUNCE_MS,
	PRODUCTION_SERVER_TIMERS,
	readServerTimers,
	testOnlyDebugRoutesEnabled,
} from "../../server/src/testOnlyTimers";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { makeConfigNamespace, makeDurableObjectState, makeEnv, makeVaultSyncNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

// Test-only server knobs must be inert on an ordinary deploy, and the
// restart-simulation route must be as unreachable as the admin routes.

const s = suite("test-only-fast-timers");

s.test("production server timers are unchanged when no knob is set", () => {
	assert.deepEqual(readServerTimers(undefined), PRODUCTION_SERVER_TIMERS);
	assert.deepEqual(readServerTimers({}), PRODUCTION_SERVER_TIMERS);
	assert.equal(PRODUCTION_SERVER_TIMERS.persistDebounceMs, 250);
	assert.equal(PRODUCTION_PERSIST_DEBOUNCE_MS, 250);
	assert.equal(PRODUCTION_SERVER_TIMERS.deviceLastSeenResolutionMs, DEVICE_LAST_SEEN_RESOLUTION_MS);
	assert.equal(DEVICE_LAST_SEEN_RESOLUTION_MS, 5 * 60 * 1_000);
});

s.test("knobs are ignored without the exact master flag", () => {
	const knobs = { YAOS_TEST_ONLY_PERSIST_DEBOUNCE_MS: "50", YAOS_TEST_ONLY_LAST_SEEN_RESOLUTION_MS: "5000" };
	assert.deepEqual(readServerTimers(knobs), PRODUCTION_SERVER_TIMERS);
	for (const flag of ["", "1", "TRUE", "yes", " true", "false"]) {
		assert.deepEqual(readServerTimers({ ...knobs, YAOS_TEST_ONLY_FAST_TIMERS: flag }), PRODUCTION_SERVER_TIMERS, `flag ${JSON.stringify(flag)}`);
	}
});

s.test("with the master flag, knobs apply and are clamped to [floor, production]", () => {
	assert.deepEqual(readServerTimers({ YAOS_TEST_ONLY_FAST_TIMERS: "true",
		YAOS_TEST_ONLY_PERSIST_DEBOUNCE_MS: "50", YAOS_TEST_ONLY_LAST_SEEN_RESOLUTION_MS: "5000" }),
	{ persistDebounceMs: 50, deviceLastSeenResolutionMs: 5_000 });
	assert.deepEqual(readServerTimers({ YAOS_TEST_ONLY_FAST_TIMERS: "true",
		YAOS_TEST_ONLY_PERSIST_DEBOUNCE_MS: "0", YAOS_TEST_ONLY_LAST_SEEN_RESOLUTION_MS: "1" }),
	{ persistDebounceMs: 25, deviceLastSeenResolutionMs: 1_000 }, "floors");
	assert.deepEqual(readServerTimers({ YAOS_TEST_ONLY_FAST_TIMERS: "true",
		YAOS_TEST_ONLY_PERSIST_DEBOUNCE_MS: "99999", YAOS_TEST_ONLY_LAST_SEEN_RESOLUTION_MS: "nope" }),
	PRODUCTION_SERVER_TIMERS, "never slower than production; non-numeric ignored");
	assert.deepEqual(readServerTimers({ YAOS_TEST_ONLY_FAST_TIMERS: "true" }), PRODUCTION_SERVER_TIMERS);
});

s.test("debug routes need their exact var", () => {
	assert.equal(testOnlyDebugRoutesEnabled(undefined), false);
	assert.equal(testOnlyDebugRoutesEnabled({}), false);
	assert.equal(testOnlyDebugRoutesEnabled({ YAOS_TEST_ONLY_DEBUG_ROUTES: "1" }), false);
	assert.equal(testOnlyDebugRoutesEnabled({ YAOS_TEST_ONLY_DEBUG_ROUTES: "true" }), true);
});

// ---------------------------------------------------------------------------
// Worker gate: 404 without the var (no DO allocated), operator session when enabled.
// ---------------------------------------------------------------------------

const CLAIM = { configFormat: 3, claimed: true, operatorRecoveryHash: "a".repeat(64),
	ticketSigningKey: "ticket-signing-key-for-tests", updateProvider: null, updateRepoUrl: null, updateRepoBranch: null };
const ROUTE = "https://example.test/vault/vault-restart-0001/debug/simulate-restart";

function gateEnv(extra: Record<string, string>, sessionValid: boolean) {
	const config = makeConfigNamespace(async (request) => {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/__yaos/config") return Response.json(CLAIM);
		if (pathname === "/__yaos/verify-session") return Response.json({ ok: sessionValid }, { status: sessionValid ? 200 : 401 });
		if (pathname === "/__yaos/vault") {
			return Response.json({ vault: { vaultId: "vault-restart-0001", name: "Restart", state: "active",
				vaultGeneration: "generation-restart-0001", createdAt: 1, provisionedAt: 2 } });
		}
		throw new Error(`unexpected config request: ${pathname}`);
	});
	const forwarded: string[] = [];
	const sync = makeVaultSyncNamespace(async (request) => {
		forwarded.push(new URL(request.url).pathname);
		return Response.json({ simulated: "restart" });
	});
	return { env: makeEnv({ YAOS_CONFIG: config, YAOS_SYNC: sync, ...extra }), sync, forwarded };
}

s.test("simulate-restart is 404 without YAOS_TEST_ONLY_DEBUG_ROUTES and never wakes the vault", async () => {
	for (const extra of [{}, { YAOS_ENABLE_ADMIN_ROUTES: "true" }, { YAOS_TEST_ONLY_FAST_TIMERS: "true" }] as Record<string, string>[]) {
		invalidateStoredServerConfigCache();
		const { env, sync } = gateEnv(extra, true);
		const response = await handleWorkerRequest(new Request(ROUTE, { method: "POST",
			headers: { Cookie: `${OPERATOR_COOKIE}=operator-session` } }), env);
		assert.equal(response.status, 404, JSON.stringify(extra));
		assert.equal(sync.calls, 0);
	}
	invalidateStoredServerConfigCache();
});

s.test("simulate-restart requires an operator session and forwards only the internal path", async () => {
	invalidateStoredServerConfigCache();
	const denied = gateEnv({ YAOS_TEST_ONLY_DEBUG_ROUTES: "true" }, false);
	const device = await handleWorkerRequest(new Request(ROUTE, { method: "POST",
		headers: { Authorization: "Bearer device-token" } }), denied.env);
	assert.equal(device.status, 401);
	assert.equal(denied.sync.calls, 0);
	invalidateStoredServerConfigCache();
	const allowed = gateEnv({ YAOS_TEST_ONLY_DEBUG_ROUTES: "true" }, true);
	const response = await handleWorkerRequest(new Request(ROUTE, { method: "POST",
		headers: { Cookie: `${OPERATOR_COOKIE}=operator-session` } }), allowed.env);
	assert.equal(response.status, 200);
	assert.deepEqual(allowed.forwarded, [SIMULATE_RESTART_RUNTIME_PATH]);
	const get = await handleWorkerRequest(new Request(ROUTE, { method: "GET",
		headers: { Cookie: `${OPERATOR_COOKIE}=operator-session` } }), allowed.env);
	assert.equal(get.status, 404, "only POST is routed");
	invalidateStoredServerConfigCache();
});

// ---------------------------------------------------------------------------
// Durable Object: fresh runtime (new epoch) over the same storage and sockets.
// ---------------------------------------------------------------------------

const VAULT_ID = "vault-restart-0001";
const GENERATION = "generation-restart-0001";

class FakeWebSocketRequestResponsePair implements WebSocketRequestResponsePair {
	constructor(private readonly requestText: string, private readonly responseText: string) {}
	get request(): string { return this.requestText; }
	get response(): string { return this.responseText; }
}

function makeNativeSocketState(options: Parameters<typeof makeDurableObjectState>[0] = {}) {
	let registeredPair: WebSocketRequestResponsePair | null = null;
	const timestamps = new WeakMap<WebSocket, Date>();
	const state = makeDurableObjectState(options);
	state.setWebSocketAutoResponse = (pair?: WebSocketRequestResponsePair) => { registeredPair = pair ?? null; };
	state.getWebSocketAutoResponse = () => registeredPair;
	state.getWebSocketAutoResponseTimestamp = (socket: WebSocket) => timestamps.get(socket) ?? null;
	return { state, timestamps };
}

s.test("the native auto-response state double preserves pair registration and Date/null timestamps", () => {
	const { state, timestamps } = makeNativeSocketState();
	const registry = new CloudflareSocketRegistry(state);
	const socket = { send: () => {}, close: () => {}, serializeAttachment: () => {}, deserializeAttachment: () => null };
	assert.equal(state.getWebSocketAutoResponse(), null);
	assert.equal(registry.supportsAutoResponse(), false);
	assert.equal(registry.getAutoResponseTimestamp(socket), null);
	const pair = new FakeWebSocketRequestResponsePair(SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST, SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE);
	state.setWebSocketAutoResponse(pair);
	assert.equal(state.getWebSocketAutoResponse(), pair);
	assert.equal(pair.request, SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST);
	assert.equal(pair.response, SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE);
	assert.equal(registry.supportsAutoResponse(), true);
	const timestamp = new Date(1_234);
	timestamps.set(socket as unknown as WebSocket, timestamp);
	assert.equal(state.getWebSocketAutoResponseTimestamp(socket as unknown as WebSocket), timestamp);
	assert.equal(registry.getAutoResponseTimestamp(socket), 1_234);
	state.setWebSocketAutoResponse(new FakeWebSocketRequestResponsePair(SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST, "wrong response"));
	assert.equal(registry.supportsAutoResponse(), false);
	state.setWebSocketAutoResponse();
	assert.equal(state.getWebSocketAutoResponse(), null);
	assert.equal(registry.supportsAutoResponse(), false);
});

s.test("native capability detection supports method-shaped pairs as well as pinned property getters", () => {
	const { state } = makeNativeSocketState();
	const registry = new CloudflareSocketRegistry(state);
	state.setWebSocketAutoResponse({
		getRequest: () => SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST,
		getResponse: () => SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE,
	} as unknown as WebSocketRequestResponsePair);
	assert.equal(registry.supportsAutoResponse(), true);
	state.setWebSocketAutoResponse({
		getRequest: () => SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST,
		getResponse: () => "wrong response",
	} as unknown as WebSocketRequestResponsePair);
	assert.equal(registry.supportsAutoResponse(), false);
});

async function withVaultObject(env: CloudflareVaultEnvironment,
	check: (server: VaultSyncServer, sockets: { closed: number }) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-restart-sim-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	let alarm: number | null = null;
	const socketState = { closed: 0 };
	const hibernated = {
		send: () => {},
		close: () => { socketState.closed++; },
		deserializeAttachment: () => null,
		serializeAttachment: () => {},
	};
	const { state: base } = makeNativeSocketState({ getWebSockets: () => [hibernated as never] });
	const storage = Object.assign(sqlite, {
		setAlarm: async (time: number) => { alarm = time; },
		getAlarm: async () => alarm,
		deleteAlarm: async () => { alarm = null; },
		deleteAll: async () => {},
	});
	const state = { ...base, storage: storage as never } as DurableObjectState;
	const previousConstructor = Object.getOwnPropertyDescriptor(globalThis, "WebSocketRequestResponsePair");
	Object.defineProperty(globalThis, "WebSocketRequestResponsePair", {
		value: FakeWebSocketRequestResponsePair, configurable: true, writable: true,
	});
	try {
		const server = new VaultSyncServer(state, env);
		const registeredPair = state.getWebSocketAutoResponse();
		assert.ok(registeredPair instanceof FakeWebSocketRequestResponsePair);
		assert.equal(registeredPair.request, SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST);
		assert.equal(registeredPair.response, SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE);
		assert.equal(new CloudflareSocketRegistry(state).supportsAutoResponse(), true);
		await check(server, socketState);
		assert.equal(state.getWebSocketAutoResponse(), registeredPair);
	} finally {
		if (previousConstructor) Object.defineProperty(globalThis, "WebSocketRequestResponsePair", previousConstructor);
		else Reflect.deleteProperty(globalThis, "WebSocketRequestResponsePair");
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

async function provision(server: VaultSyncServer): Promise<void> {
	const response = await server.fetch(internal("/__yaos/provision", { method: "POST",
		headers: { "content-type": "application/json" }, body: JSON.stringify({ vaultGeneration: GENERATION }) }));
	assert.ok(response.ok, `provision ${response.status} ${await response.clone().text()}`);
}

s.test("the Durable Object answers 404 for the internal path without the var", async () => {
	await withVaultObject({}, async (server) => {
		await provision(server);
		const response = await server.fetch(internal(SIMULATE_RESTART_RUNTIME_PATH, { method: "POST" }));
		assert.equal(response.status, 404);
	});
});

s.test("simulate-restart installs a new runtime epoch and keeps hibernated sockets attached", async () => {
	await withVaultObject({ YAOS_TEST_ONLY_DEBUG_ROUTES: "true" }, async (server, sockets) => {
		await provision(server);
		const first = await (await server.fetch(internal(SIMULATE_RESTART_RUNTIME_PATH, { method: "POST" }))).json() as Record<string, unknown>;
		assert.equal(first.simulated, "restart");
		assert.equal(typeof first.previousRuntimeEpoch, "string");
		assert.notEqual(first.runtimeEpoch, first.previousRuntimeEpoch);
		assert.equal(first.sockets, 1);
		assert.equal(sockets.closed, 0, "sockets are not closed, as across hibernation");
		const second = await (await server.fetch(internal(SIMULATE_RESTART_RUNTIME_PATH, { method: "POST" }))).json() as Record<string, unknown>;
		assert.equal(second.previousRuntimeEpoch, first.runtimeEpoch, "the swapped-in runtime is the live one");
		const mismatch = await server.fetch(new Request(`https://internal${SIMULATE_RESTART_RUNTIME_PATH}`, { method: "POST",
			headers: { "x-yaos-vault-id": VAULT_ID, "x-yaos-vault-generation": "generation-other-0001" } }));
		assert.equal(mismatch.status, 409, "vault generation is still validated");
		// Durable state survives: the vault is still provisioned in the new runtime.
		const again = await server.fetch(internal("/__yaos/provision", { method: "POST",
			headers: { "content-type": "application/json" }, body: JSON.stringify({ vaultGeneration: GENERATION }) }));
		assert.ok(again.ok);
	});
});

await s.done();
