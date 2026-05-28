/**
 * WebSocket ticket auth tests.
 *
 * Covers the full ticket lifecycle:
 *   - createTicket / verifyTicket round-trip
 *   - verifyTicket rejects expired, wrong vaultId, tampered payload, tampered sig
 *   - handleTicketRoute HTTP handler (success + auth failure)
 *   - authenticateSocketRequest pure helper (all branches)
 *   - Legacy disable switch rejects ?token= connections
 *   - Warning emitted on legacy token use
 *   - isTicketEndpointUnsupported classifies 404/405/501 vs other errors
 *   - WebSocket route: ticket accepted before DO wake
 *   - WebSocket route: expired/tampered/wrong-vault ticket rejected before DO wake
 *   - WebSocket route: legacy ?token= still accepted (migration path)
 *   - WebSocket route: neither ticket nor token → rejected
 *   - Capabilities endpoint advertises socketTicketAuth: true
 *   - DO namespace never woken for any rejection path
 */

import { createTicket, verifyTicket, handleTicketRoute, TICKET_TTL_MS } from "../server/src/routes/ticket";
import { authenticateSocketRequest } from "../server/src/routes/syncSocket";
import { getCapabilities } from "../server/src/routes/auth";
import worker from "../server/src/index";
import { handleSyncSocketRoute } from "../server/src/routes/syncSocket";
import { json } from "../server/src/routes/http";
import { isTicketEndpointUnsupported, SocketTicketHttpError, patchTicketInUrl } from "../src/sync/socketTicket";
import type { AuthState, Env } from "../server/src/routes/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
	assert(
		actual === expected,
		`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
	);
}

/** Auth state for env-token mode. */
const ENV_AUTH: AuthState = { mode: "env", claimed: true, envToken: "test-secret-token" };
/** Auth state for claim mode (tokenHash is sha256 of "test-secret-token", pre-computed as dummy hex). */
const CLAIM_AUTH: AuthState = { mode: "claim", claimed: true, tokenHash: "a".repeat(64) };
const VAULT_ID = "test-vault-abc";
const OTHER_VAULT_ID = "other-vault-xyz";

/**
 * Trap env: YAOS_SYNC and YAOS_CONFIG throw if any method is called.
 * Used to prove the DO is never woken on rejection paths.
 */
function makeTrapEnv(extra: Partial<Env> = {}): Env {
	const trap = new Proxy({}, {
		get(_: object, prop: string) {
			return () => { throw new Error(`Durable Object namespace accessed before auth: ${prop}`); };
		},
	});
	return {
		SYNC_TOKEN: ENV_AUTH.envToken,
		YAOS_SYNC: trap as unknown as Env["YAOS_SYNC"],
		YAOS_CONFIG: trap as unknown as Env["YAOS_CONFIG"],
		...extra,
	};
}

// ---------------------------------------------------------------------------
// createTicket / verifyTicket round-trip
// ---------------------------------------------------------------------------

console.log("\n--- createTicket / verifyTicket: round-trip (env mode) ---");
{
	const { ticket, expiresAt } = await createTicket(ENV_AUTH, VAULT_ID);

	assert(typeof ticket === "string" && ticket.includes("."), "ticket is a dot-separated string");
	assert(expiresAt > Date.now(), "expiresAt is in the future");
	assert(expiresAt <= Date.now() + TICKET_TTL_MS + 1000, "expiresAt within TTL");

	const valid = await verifyTicket(ticket, ENV_AUTH, VAULT_ID);
	assert(valid, "valid ticket verifies correctly");
}

console.log("\n--- createTicket / verifyTicket: round-trip (claim mode) ---");
{
	const { ticket } = await createTicket(CLAIM_AUTH, VAULT_ID);
	const valid = await verifyTicket(ticket, CLAIM_AUTH, VAULT_ID);
	assert(valid, "claim-mode ticket verifies correctly");
}

console.log("\n--- verifyTicket: expired ticket is rejected ---");
{
	// Create a ticket that expires immediately.
	const { ticket } = await createTicket(ENV_AUTH, VAULT_ID, -1);
	const valid = await verifyTicket(ticket, ENV_AUTH, VAULT_ID);
	assert(!valid, "expired ticket (ttlMs=-1) is rejected");
}

console.log("\n--- verifyTicket: wrong vaultId is rejected ---");
{
	const { ticket } = await createTicket(ENV_AUTH, VAULT_ID);
	const valid = await verifyTicket(ticket, ENV_AUTH, OTHER_VAULT_ID);
	assert(!valid, "ticket for VAULT_ID does not validate for OTHER_VAULT_ID");
}

console.log("\n--- verifyTicket: tampered payload is rejected ---");
{
	const { ticket } = await createTicket(ENV_AUTH, VAULT_ID);
	const [payload, sig] = ticket.split(".");
	// Flip the last char of the payload.
	const tamperedPayload = payload!.slice(0, -1) + (payload!.endsWith("a") ? "b" : "a");
	const tampered = `${tamperedPayload}.${sig}`;
	const valid = await verifyTicket(tampered, ENV_AUTH, VAULT_ID);
	assert(!valid, "tampered payload is rejected");
}

console.log("\n--- verifyTicket: tampered signature is rejected ---");
{
	const { ticket } = await createTicket(ENV_AUTH, VAULT_ID);
	const [payload, sig] = ticket.split(".");
	// Flip a char at index 5 — well within the non-padding zone of a
	// 43-char HMAC-SHA256 base64url signature.  Flipping the *last* char
	// can land in the 2-bit padding zone where two distinct chars decode to
	// identical bytes, causing a false pass.
	const idx = 5;
	const tamperedSig = sig!.slice(0, idx) + (sig![idx] === "a" ? "b" : "a") + sig!.slice(idx + 1);
	const tampered = `${payload}.${tamperedSig}`;
	const valid = await verifyTicket(tampered, ENV_AUTH, VAULT_ID);
	assert(!valid, "tampered signature is rejected");
}

console.log("\n--- verifyTicket: wrong auth secret is rejected ---");
{
	const { ticket } = await createTicket(ENV_AUTH, VAULT_ID);
	const wrongAuth: AuthState = { mode: "env", claimed: true, envToken: "different-secret" };
	const valid = await verifyTicket(ticket, wrongAuth, VAULT_ID);
	assert(!valid, "ticket signed with one secret does not verify under a different secret");
}

console.log("\n--- verifyTicket: malformed ticket strings are rejected ---");
{
	const cases: [string, string][] = [
		["", "empty string"],
		["nodot", "no dot separator"],
		[".nosuffix", "empty payload"],
		["noprefix.", "empty signature"],
		["!invalid.chars", "invalid base64url chars in payload"],
	];
	for (const [input, label] of cases) {
		const valid = await verifyTicket(input, ENV_AUTH, VAULT_ID);
		assert(!valid, `${label} → rejected`);
	}
}

// ---------------------------------------------------------------------------
// handleTicketRoute HTTP handler
// ---------------------------------------------------------------------------

console.log("\n--- handleTicketRoute: issues ticket for authenticated caller ---");
{
	const req = new Request("https://example.test/vault/test-vault/auth/ticket", {
		method: "POST",
	});
	const res = await handleTicketRoute(req, ENV_AUTH, VAULT_ID, json);
	assertEqual(res.status, 200, "ticket route returns 200");
	const body = await res.json() as { ticket?: unknown; expiresAt?: unknown; ttlMs?: unknown };
	assert(typeof body.ticket === "string", "response includes ticket string");
	assert(typeof body.expiresAt === "number", "response includes expiresAt number");
	assert(typeof body.ttlMs === "number", "response includes ttlMs number");
	// Verify the issued ticket is actually valid.
	const valid = await verifyTicket(body.ticket as string, ENV_AUTH, VAULT_ID);
	assert(valid, "issued ticket verifies correctly");
}

// ---------------------------------------------------------------------------
// WebSocket route: ticket path (pre-DO-wake invariant)
// ---------------------------------------------------------------------------

console.log("\n--- WS route: valid ticket passes auth gate (does not produce 401/503) ---");
{
	// The test harness mocks partyserver.getServerByName to throw with
	// "INV-SEC-01 violation" on any DO access.  For a *valid* ticket, auth
	// passes and the route proceeds to the schema probe and final DO step —
	// both of which hit getServerByName.  We call handleSyncSocketRoute
	// directly, catch the expected harness throw, and confirm the route did
	// NOT reject at the auth gate.
	const env: Env = {
		SYNC_TOKEN: ENV_AUTH.envToken,
		YAOS_SYNC: {} as unknown as Env["YAOS_SYNC"],
		YAOS_CONFIG: {} as unknown as Env["YAOS_CONFIG"],
	};

	const { ticket } = await createTicket(ENV_AUTH, VAULT_ID);
	const wsUrl = `https://example.test/vault/sync/${VAULT_ID}?ticket=${encodeURIComponent(ticket)}&schemaVersion=2`;
	const req = new Request(wsUrl, {
		headers: { Upgrade: "websocket", Connection: "Upgrade" },
	});

	let authGateRejected = false;
	try {
		const res = await handleSyncSocketRoute(req, env, ENV_AUTH, VAULT_ID);
		// If we get a response, it must not be a pre-auth rejection.
		authGateRejected = res.status === 401 || res.status === 503;
	} catch (err) {
		// Expected: partyserver mock throws when DO is accessed post-auth.
		// Any throw here means auth PASSED (we got past the auth gate).
		const msg = String(err);
		if (!msg.includes("INV-SEC-01") && !msg.includes("Durable Object namespace")) {
			throw err; // genuinely unexpected — re-throw
		}
	}
	assert(!authGateRejected, "valid ticket is not rejected at the auth gate");
}

console.log("\n--- WS route: expired ticket rejected before DO wake ---");
{
	const trapEnv = makeTrapEnv();
	const { ticket } = await createTicket(ENV_AUTH, VAULT_ID, -1);
	// Send as plain HTTP (no Upgrade header) — avoids WebSocketPair which is
	// unavailable in Node.js.  The auth gate fires before any WS-specific code.
	const req = new Request(
		`https://example.test/vault/sync/${VAULT_ID}?ticket=${encodeURIComponent(ticket)}&schemaVersion=2`,
	);

	let doTouched = false;
	try {
		const res = await worker.fetch(req, trapEnv);
		assertEqual(res.status, 401, "expired ticket returns 401");
	} catch (err) {
		doTouched = true;
		assert(false, `DO was touched before auth (threw: ${String(err)})`);
	}
	assert(!doTouched, "expired ticket: DO namespace not touched");
}

console.log("\n--- WS route: tampered ticket rejected before DO wake ---");
{
	const trapEnv = makeTrapEnv();
	const { ticket } = await createTicket(ENV_AUTH, VAULT_ID);
	const [payload, sig] = ticket.split(".");
	const idx = 5;
	const tampered = `${payload}.${sig!.slice(0, idx)}${sig![idx] === "a" ? "b" : "a"}${sig!.slice(idx + 1)}`;
	const req = new Request(
		`https://example.test/vault/sync/${VAULT_ID}?ticket=${encodeURIComponent(tampered)}&schemaVersion=2`,
	);

	let doTouched = false;
	try {
		const res = await worker.fetch(req, trapEnv);
		assertEqual(res.status, 401, "tampered ticket returns 401");
	} catch {
		doTouched = true;
		assert(false, "DO was touched for tampered ticket");
	}
	assert(!doTouched, "tampered ticket: DO namespace not touched");
}

console.log("\n--- WS route: ticket for wrong vaultId rejected before DO wake ---");
{
	const trapEnv = makeTrapEnv();
	const { ticket } = await createTicket(ENV_AUTH, OTHER_VAULT_ID);
	const req = new Request(
		`https://example.test/vault/sync/${VAULT_ID}?ticket=${encodeURIComponent(ticket)}&schemaVersion=2`,
	);

	let doTouched = false;
	try {
		const res = await worker.fetch(req, trapEnv);
		assertEqual(res.status, 401, "wrong-vault ticket returns 401");
	} catch {
		doTouched = true;
		assert(false, "DO was touched for wrong-vault ticket");
	}
	assert(!doTouched, "wrong-vault ticket: DO namespace not touched");
}

console.log("\n--- WS route: legacy ?token= still accepted (migration path) ---");
{
	// Same harness constraint: partyserver throws post-auth.  Call
	// handleSyncSocketRoute directly and catch the expected throw.
	const env: Env = {
		SYNC_TOKEN: ENV_AUTH.envToken,
		YAOS_SYNC: {} as unknown as Env["YAOS_SYNC"],
		YAOS_CONFIG: {} as unknown as Env["YAOS_CONFIG"],
	};

	const wsUrl = `https://example.test/vault/sync/${VAULT_ID}?token=${encodeURIComponent(ENV_AUTH.envToken)}&schemaVersion=2`;
	const req = new Request(wsUrl, {
		headers: { Upgrade: "websocket", Connection: "Upgrade" },
	});

	let authGateRejected = false;
	try {
		const res = await handleSyncSocketRoute(req, env, ENV_AUTH, VAULT_ID);
		authGateRejected = res.status === 401 || res.status === 503;
	} catch (err) {
		const msg = String(err);
		if (!msg.includes("INV-SEC-01") && !msg.includes("Durable Object namespace")) {
			throw err;
		}
	}
	assert(!authGateRejected, "legacy ?token= passes auth gate (migration path)");
}

console.log("\n--- WS route: no ticket and no token → rejected before DO wake ---");
{
	const trapEnv = makeTrapEnv();
	const req = new Request(
		`https://example.test/vault/sync/${VAULT_ID}?schemaVersion=2`,
	);

	let doTouched = false;
	try {
		const res = await worker.fetch(req, trapEnv);
		assertEqual(res.status, 401, "no auth → 401");
	} catch {
		doTouched = true;
		assert(false, "DO was touched for unauthenticated request");
	}
	assert(!doTouched, "no auth: DO namespace not touched");
}

// ---------------------------------------------------------------------------
// authenticateSocketRequest — pure auth helper
// ---------------------------------------------------------------------------

console.log("\n--- authenticateSocketRequest: valid ticket → ok, method: ticket ---");
{
	const { ticket } = await createTicket(ENV_AUTH, VAULT_ID);
	const result = await authenticateSocketRequest(ticket, null, ENV_AUTH, VAULT_ID, false);
	assert(result.ok, "valid ticket → ok");
	assert(result.ok && result.method === "ticket", "valid ticket → method is ticket");
}

console.log("\n--- authenticateSocketRequest: invalid ticket → not ok, unauthorized ---");
{
	const result = await authenticateSocketRequest("bad.ticket", null, ENV_AUTH, VAULT_ID, false);
	assert(!result.ok, "bad ticket → not ok");
	assert(!result.ok && result.reason === "unauthorized", "bad ticket → reason unauthorized");
}

console.log("\n--- authenticateSocketRequest: no ticket, valid token → ok, method: legacy-token ---");
{
	const result = await authenticateSocketRequest(null, ENV_AUTH.envToken, ENV_AUTH, VAULT_ID, false);
	assert(result.ok, "valid token → ok");
	assert(result.ok && result.method === "legacy-token", "valid token → method is legacy-token");
}

console.log("\n--- authenticateSocketRequest: no ticket, invalid token → not ok ---");
{
	const result = await authenticateSocketRequest(null, "wrong-token", ENV_AUTH, VAULT_ID, false);
	assert(!result.ok, "wrong token → not ok");
}

console.log("\n--- authenticateSocketRequest: no ticket, valid token, legacy disabled → not ok ---");
{
	const result = await authenticateSocketRequest(null, ENV_AUTH.envToken, ENV_AUTH, VAULT_ID, true);
	assert(!result.ok, "legacy disabled → not ok even with valid token");
	assert(!result.ok && result.reason === "unauthorized", "legacy disabled → reason unauthorized");
}

console.log("\n--- authenticateSocketRequest: unclaimed server → not ok, unclaimed ---");
{
	const unclaimed: AuthState = { mode: "unclaimed", claimed: false };
	const result = await authenticateSocketRequest(null, "token", unclaimed, VAULT_ID, false);
	assert(!result.ok && result.reason === "unclaimed", "unclaimed server → reason unclaimed");
}

console.log("\n--- authenticateSocketRequest: server_misconfigured → not ok ---");
{
	const misconfigured: AuthState = { mode: "env", claimed: true, envToken: "" };
	const result = await authenticateSocketRequest(null, "token", misconfigured, VAULT_ID, false);
	assert(!result.ok && result.reason === "server_misconfigured", "empty envToken → server_misconfigured");
}

// ---------------------------------------------------------------------------
// Legacy disable switch (YAOS_DISABLE_LEGACY_WS_TOKEN)
// ---------------------------------------------------------------------------

console.log("\n--- WS route: legacy ?token= rejected when YAOS_DISABLE_LEGACY_WS_TOKEN is set ---");
{
	const trapEnv = makeTrapEnv({ YAOS_DISABLE_LEGACY_WS_TOKEN: "true" });
	const req = new Request(
		`https://example.test/vault/sync/${VAULT_ID}?token=${encodeURIComponent(ENV_AUTH.envToken)}&schemaVersion=2`,
	);

	let doTouched = false;
	try {
		const res = await worker.fetch(req, trapEnv);
		assertEqual(res.status, 401, "legacy token rejected when disable flag is set");
	} catch {
		doTouched = true;
		assert(false, "DO touched when legacy token disabled");
	}
	assert(!doTouched, "legacy-disabled rejection: DO not touched");
}

console.log("\n--- WS route: legacy warning logged on successful legacy auth ---");
{
	// Call handleSyncSocketRoute directly with a valid legacy token.
	// The warning fires inside the route after auth succeeds.
	// The partyserver mock throws post-auth (expected); we catch it.
	const env: Env = {
		SYNC_TOKEN: ENV_AUTH.envToken,
		YAOS_SYNC: {} as unknown as Env["YAOS_SYNC"],
		YAOS_CONFIG: {} as unknown as Env["YAOS_CONFIG"],
	};
	const req = new Request(
		`https://example.test/vault/sync/${VAULT_ID}?token=${encodeURIComponent(ENV_AUTH.envToken)}&schemaVersion=2`,
	);

	const warnMessages: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnMessages.push(args.map(String).join(" "));
		originalWarn(...args);
	};

	try {
		await handleSyncSocketRoute(req, env, ENV_AUTH, VAULT_ID);
	} catch (err) {
		const msg = String(err);
		if (!msg.includes("INV-SEC-01") && !msg.includes("Durable Object namespace")) {
			console.warn = originalWarn;
			throw err;
		}
	} finally {
		console.warn = originalWarn;
	}

	assert(
		warnMessages.some((m) => m.includes("legacy") && m.includes("?token=")),
		"route emits legacy ?token= warning on successful legacy auth",
	);
	assert(
		!warnMessages.some((m) => m.includes(ENV_AUTH.envToken)),
		"legacy warning does not leak the actual token value",
	);
}

// ---------------------------------------------------------------------------
// isTicketEndpointUnsupported — classifies errors correctly
// ---------------------------------------------------------------------------

console.log("\n--- isTicketEndpointUnsupported: 404/405/501 → true ---");
{
	assert(isTicketEndpointUnsupported(new SocketTicketHttpError(404)), "404 → unsupported");
	assert(isTicketEndpointUnsupported(new SocketTicketHttpError(405)), "405 → unsupported");
	assert(isTicketEndpointUnsupported(new SocketTicketHttpError(501)), "501 → unsupported");
}

console.log("\n--- isTicketEndpointUnsupported: 401/403/500/network → false ---");
{
	assert(!isTicketEndpointUnsupported(new SocketTicketHttpError(401)), "401 → not unsupported (auth failure)");
	assert(!isTicketEndpointUnsupported(new SocketTicketHttpError(403)), "403 → not unsupported");
	assert(!isTicketEndpointUnsupported(new SocketTicketHttpError(500)), "500 → not unsupported (server error)");
	assert(!isTicketEndpointUnsupported(new Error("fetch failed")), "plain Error → not unsupported");
	assert(!isTicketEndpointUnsupported(new Error("socket ticket response malformed")), "malformed response → not unsupported");
	// Crucially: a plain Error with '(404)' in the message is NOT matched —
	// only SocketTicketHttpError instances are treated as typed signals.
	assert(!isTicketEndpointUnsupported(new Error("socket ticket request failed (404)")), "plain Error with (404) → not unsupported (must be typed)");
}

// ---------------------------------------------------------------------------
// patchTicketInUrl — URL manipulation for proactive refresh
// ---------------------------------------------------------------------------

console.log("\n--- patchTicketInUrl: replaces ticket, removes token, preserves other params ---");
{
	const original = "wss://example.test/vault/sync/vaultA?_pk=abc123&ticket=OLD_TICKET&schemaVersion=2&device=mydevice";
	const patched = patchTicketInUrl(original, "NEW_TICKET");
	const u = new URL(patched);

	assertEqual(u.searchParams.get("ticket"), "NEW_TICKET", "ticket param updated to new value");
	assert(!u.searchParams.has("token"), "token param absent after patch");
	assertEqual(u.searchParams.get("schemaVersion"), "2", "schemaVersion preserved");
	assertEqual(u.searchParams.get("device"), "mydevice", "device param preserved");
	assertEqual(u.searchParams.get("_pk"), "abc123", "connection id _pk preserved");
}

console.log("\n--- patchTicketInUrl: removes legacy ?token= when patching to ticket auth ---");
{
	// Simulate a URL that was built with the legacy token (old server, then upgraded).
	const withToken = "wss://example.test/vault/sync/vaultA?_pk=xyz&token=MY_SECRET_TOKEN&schemaVersion=2";
	const patched = patchTicketInUrl(withToken, "FRESH_TICKET");
	const u = new URL(patched);

	assertEqual(u.searchParams.get("ticket"), "FRESH_TICKET", "ticket inserted");
	assert(!u.searchParams.has("token"), "token stripped when ticket applied");
	assertEqual(u.searchParams.get("schemaVersion"), "2", "schemaVersion preserved");
}

console.log("\n--- patchTicketInUrl: handles URL with no prior ticket ---");
{
	const bare = "wss://example.test/vault/sync/vaultA?_pk=001&schemaVersion=2";
	const patched = patchTicketInUrl(bare, "FIRST_TICKET");
	const u = new URL(patched);

	assertEqual(u.searchParams.get("ticket"), "FIRST_TICKET", "ticket added to URL with no prior ticket");
	assert(!u.searchParams.has("token"), "no token in result");
}

// ---------------------------------------------------------------------------
// 500 ticket endpoint → no token fallback
// ---------------------------------------------------------------------------

console.log("\n--- 500 from ticket endpoint: isTicketEndpointUnsupported is false → error propagates ---");
{
	// The safety property: a 500 from the ticket endpoint must NOT be treated
	// as "server doesn't support tickets" and must NOT cause silent fallback to
	// the long-lived ?token=.  The rule is enforced by isTicketEndpointUnsupported
	// returning false for 5xx, which causes the error to propagate (throw) rather
	// than triggering markUnsupported() + return null.
	//
	// Code path in main.ts:
	//   catch (err) {
	//     if (socketTicketAuth === undefined && isTicketEndpointUnsupported(err)) {
	//       markUnsupported(); return null;  // ← 500 does NOT reach here
	//     }
	//     throw err;                         // ← 500 propagates here
	//   }

	const err500 = new SocketTicketHttpError(500);
	assert(!isTicketEndpointUnsupported(err500), "500 → not unsupported (must not trigger token fallback)");

	// Verify the classification table is exhaustive for all 5xx codes that
	// could plausibly appear.
	for (const status of [500, 502, 503, 504]) {
		assert(
			!isTicketEndpointUnsupported(new SocketTicketHttpError(status)),
			`${status} → not unsupported (server error, propagates)`,
		);
	}

	// Confirm that the only codes that DO trigger fallback are the
	// "endpoint missing" signals: 404, 405, 501.
	for (const status of [404, 405, 501]) {
		assert(
			isTicketEndpointUnsupported(new SocketTicketHttpError(status)),
			`${status} → unsupported (endpoint missing, fallback allowed)`,
		);
	}

	// Auth failures must also propagate (not fall back).
	for (const status of [401, 403]) {
		assert(
			!isTicketEndpointUnsupported(new SocketTicketHttpError(status)),
			`${status} → not unsupported (auth failure, propagates)`,
		);
	}
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

console.log("\n--- capabilities: socketTicketAuth: true is advertised ---");
{
	const env = { YAOS_BUCKET: {} } as unknown as Env;
	const auth: AuthState = { mode: "env", claimed: true, envToken: "token" };
	const caps = getCapabilities(auth, env);
	assertEqual(caps.socketTicketAuth, true, "capabilities include socketTicketAuth: true");
}

console.log("\n--- capabilities route: socketTicketAuth visible unauthenticated ---");
{
	const env: Env = {
		SYNC_TOKEN: "correct-token",
		YAOS_SYNC: {} as unknown as Env["YAOS_SYNC"],
		YAOS_CONFIG: {
			idFromName: () => "id",
			get: () => ({
				fetch: async () => new Response(JSON.stringify({
					claimed: true,
					tokenHash: "hash",
				}), { status: 200 }),
			}),
		} as unknown as Env["YAOS_CONFIG"],
	};
	const res = await worker.fetch(new Request("https://example.test/api/capabilities"), env);
	const caps = await res.json() as Record<string, unknown>;
	assertEqual(caps.socketTicketAuth, true, "public capabilities include socketTicketAuth");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
