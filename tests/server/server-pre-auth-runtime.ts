/**
 * FU-4 — Pre-auth runtime test.
 *
 * A fake Env whose YAOS_SYNC and YAOS_CONFIG namespaces throw on any access
 * is passed into the rejection paths. If pre-auth code touches either
 * namespace, the suite fails with an INV-SEC-01 error. Structured Worker
 * warnings are captured separately so observability does not depend on room
 * storage.
 *
 * Covered paths:
 *   rejectUnauthorizedVaultRequest (HTTP vault route handler, index.ts):
 *     - unclaimed           → 503 { error: "unclaimed" }
 *     - server_misconfigured → 503 { error: "server_misconfigured" }
 *     - unauthorized        → 401 { error: "unauthorized" }
 *     - authorized          → null (no rejection), DO still not touched
 *
 *   handleSyncSocketRoute (WebSocket/HTTP sync route, syncSocket.ts):
 *     - unclaimed           → 503 JSON (non-WS request)
 *     - server_misconfigured → 503 JSON (non-WS request)
 *     - unauthorized        → 401 JSON (non-WS request)
 *     All three: fake DO env is in scope and throws if accessed.
 *
 * WebSocket path note: WebSocketPair is a Cloudflare Workers API unavailable
 * in Node.js. The pre-auth auth logic is identical for WS and non-WS requests
 * — only the response format differs. Auth gate correctness is tested via
 * non-WS requests; WS response format is not testable in this environment.
 *
 * Dependency mock: partyserver → tests/mocks/partyserver.ts
 * The mock's getServerByName() throws, so any post-auth DO access in the
 * tested call paths would also make these tests fail loudly.
 */

import { rejectUnauthorizedVaultRequest } from "../../server/src/routes/auth";
import { handleSyncSocketRoute } from "../../server/src/routes/syncSocket";
import type { AuthState, Env } from "../../server/src/routes/types";
import { makeEnv, makeTrapNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("server-pre-auth-runtime");

// ── Fake Env — DO access throws ───────────────────────────────────────────────

const DO_TOUCHED = "Durable Object namespace accessed before authentication (INV-SEC-01)";

const fakeEnv: Env = makeEnv({
	YAOS_SYNC: makeTrapNamespace(DO_TOUCHED),
	YAOS_CONFIG: makeTrapNamespace(DO_TOUCHED),
	SYNC_TOKEN: undefined,
});

// ── Auth state fixtures ───────────────────────────────────────────────────────

const unclaimed: AuthState = { mode: "unclaimed", claimed: false };
const misconfigured: AuthState = { mode: "env", claimed: true, envToken: "" };
const envAuth: AuthState = { mode: "env", claimed: true, envToken: "correct-secret" };

function httpReq(auth?: string): Request {
	const headers: HeadersInit = {};
	if (auth) (headers as Record<string, string>)["Authorization"] = `Bearer ${auth}`;
	return new Request("https://example.com/vault/test-vault/debug/recent", { headers });
}

function syncHttpReq(auth?: string): Request {
	const headers: HeadersInit = {};
	if (auth) (headers as Record<string, string>)["Authorization"] = `Bearer ${auth}`;
	// Non-WebSocket request to the sync route
	return new Request("https://example.com/vault/sync/test-vault", { headers });
}

async function parseJsonBody(resp: Response): Promise<unknown> {
	try { return await resp.json(); } catch { return null; }
}

// ── Test 1: rejectUnauthorizedVaultRequest — unclaimed ────────────────────────

s.section("Test 1: rejectUnauthorizedVaultRequest — unclaimed");
{
	const rejection = await rejectUnauthorizedVaultRequest(httpReq(), fakeEnv, unclaimed, "test-vault");
	s.check(rejection !== null, "unclaimed: rejection returned (not null)");
	s.check(rejection?.reason === "unclaimed", "unclaimed: typed reason is 'unclaimed'");
	s.check(rejection?.response.status === 503, "unclaimed: HTTP 503");
	const body = await parseJsonBody(rejection!.response);
	s.check((body as { error?: string })?.error === "unclaimed", "unclaimed: body has error=unclaimed");
}

// ── Test 2: rejectUnauthorizedVaultRequest — server_misconfigured ─────────────

s.section("Test 2: rejectUnauthorizedVaultRequest — server_misconfigured");
{
	const rejection = await rejectUnauthorizedVaultRequest(httpReq(), fakeEnv, misconfigured, "test-vault");
	s.check(rejection !== null, "misconfigured: rejection returned");
	s.check(rejection?.reason === "server_misconfigured", "misconfigured: typed reason is 'server_misconfigured'");
	s.check(rejection?.response.status === 503, "misconfigured: HTTP 503");
	const body = await parseJsonBody(rejection!.response);
	s.check((body as { error?: string })?.error === "server_misconfigured", "misconfigured: body has error=server_misconfigured");
}

// ── Test 3: rejectUnauthorizedVaultRequest — unauthorized ─────────────────────

s.section("Test 3: rejectUnauthorizedVaultRequest — unauthorized (wrong token)");
{
	const rejection = await rejectUnauthorizedVaultRequest(httpReq("wrong-token"), fakeEnv, envAuth, "test-vault");
	s.check(rejection !== null, "unauthorized: rejection returned");
	s.check(rejection?.reason === "unauthorized", "unauthorized: typed reason is 'unauthorized'");
	s.check(rejection?.response.status === 401, "unauthorized: HTTP 401");
	const body = await parseJsonBody(rejection!.response);
	s.check((body as { error?: string })?.error === "unauthorized", "unauthorized: body has error=unauthorized");
}

// ── Test 4: rejectUnauthorizedVaultRequest — authorized (no rejection) ────────

s.section("Test 4: rejectUnauthorizedVaultRequest — authorized returns null");
{
	const rejection = await rejectUnauthorizedVaultRequest(httpReq("correct-secret"), fakeEnv, envAuth, "test-vault");
	s.check(rejection === null, "authorized: returns null (request proceeds to handler)");
	// fakeEnv DO traps were never triggered — if they had been, the test would have thrown
	s.check(true, "authorized: DO namespace was not touched");
}

// ── Test 5: handleSyncSocketRoute — unclaimed (non-WS) ───────────────────────

s.section("Test 5: handleSyncSocketRoute — unclaimed (HTTP, no WebSocket upgrade)");
{
	const resp = await handleSyncSocketRoute(syncHttpReq(), fakeEnv, unclaimed, "test-vault");
	s.check(resp.status === 503, "unclaimed socket route: HTTP 503");
	const body = await parseJsonBody(resp);
	s.check((body as { error?: string })?.error === "unclaimed", "unclaimed socket route: body has error=unclaimed");
}

// ── Test 6: handleSyncSocketRoute — server_misconfigured (non-WS) ────────────

s.section("Test 6: handleSyncSocketRoute — server_misconfigured (HTTP)");
{
	const resp = await handleSyncSocketRoute(syncHttpReq(), fakeEnv, misconfigured, "test-vault");
	s.check(resp.status === 503, "misconfigured socket route: HTTP 503");
	const body = await parseJsonBody(resp);
	s.check((body as { error?: string })?.error === "server_misconfigured", "misconfigured socket route: body has error=server_misconfigured");
}

// ── Test 7: handleSyncSocketRoute — unauthorized (non-WS) ────────────────────

s.section("Test 7: handleSyncSocketRoute — unauthorized (HTTP, wrong token)");
{
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...values: unknown[]) => {
		warnings.push(values.map(String).join(" "));
	};
	let resp: Response | null = null;
	try {
		resp = await handleSyncSocketRoute(syncHttpReq("wrong-token"), fakeEnv, envAuth, "test-vault");
	} finally {
		console.warn = originalWarn;
	}
	s.check(resp?.status === 401, "unauthorized socket route: HTTP 401");
	const body = resp ? await parseJsonBody(resp) : null;
	const errorCode =
		body && typeof body === "object" && "error" in body
			? body.error
			: undefined;
	s.check(errorCode === "unauthorized", "unauthorized socket route: body has error=unauthorized");
	s.check(
		warnings.some((warning) =>
			warning.includes("ws rejected pre-auth")
			&& warning.includes('"reason":"unauthorized"')
		),
		"unauthorized socket rejection emits a structured Worker warning",
	);
}

// ── Test 8: DO trap never fired in any of the above ───────────────────────────

s.section("Test 8: DO trap summary — none of the above rejection paths touched the namespace");
{
	// If any of tests 1-7 had called DO methods, they would have thrown and
	// the process would have exited with an unhandled error before reaching here.
	// Reaching this point proves all seven rejection paths respected INV-SEC-01.
	s.check(true, "all pre-auth rejections completed without touching YAOS_SYNC or YAOS_CONFIG");
}
await s.done();
