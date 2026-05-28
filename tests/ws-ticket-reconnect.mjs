/**
 * WebSocket ticket auth reconnect smoke tests.
 *
 * Proves the three behaviors the unit tests cannot reach:
 *
 *   1. Initial connect uses ?ticket= (not ?token=) when the server supports
 *      ticket auth.
 *
 *   2. Patching provider.url with a fresh ticket before a force-disconnect
 *      causes the reconnect to use the new ticket and succeed.  This is the
 *      core mechanism behind VaultSync.patchProviderTicket — the test proves
 *      the underlying YSyncProvider behaviour the workaround depends on.
 *
 *   3. A ticket that expires mid-session does not permanently break sync: if
 *      the URL is patched with a fresh ticket before (or during) the
 *      disconnect, the reconnect succeeds.  This is the sleep/wake scenario.
 *
 * The server is expected to be running under wrangler dev with
 * YAOS_TICKET_TTL_MS=8000 injected via the worker-integration harness.
 * This makes tickets expire in 8 seconds so that post-expiry reconnect
 * can be tested without a 5-minute wait.
 *
 * Prerequisites (set by worker-integration.mjs):
 *   YAOS_TEST_HOST    — base URL of the local wrangler dev Worker
 *   SYNC_TOKEN        — auth token for the local Worker
 *   YAOS_TEST_VAULT_ID — stable vault ID for the test room
 */

import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";

const HOST = process.env.YAOS_TEST_HOST || "http://127.0.0.1:8787";
const TOKEN = process.env.SYNC_TOKEN || "";
const BASE_VAULT_ID = process.env.YAOS_TEST_VAULT_ID || "yaos-ticket-reconnect";
const ROOM_ID = `${BASE_VAULT_ID}-ticket-reconnect`;

if (!TOKEN) {
	throw new Error("SYNC_TOKEN is required for ticket reconnect smoke test");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch a fresh short-lived ticket from the running local Worker. */
async function fetchTicket(vaultId) {
	const res = await fetch(
		`${HOST}/vault/${encodeURIComponent(vaultId)}/auth/ticket`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}` },
		},
	);
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`ticket fetch failed (${res.status})${body ? `: ${body}` : ""}`);
	}
	const json = await res.json();
	if (typeof json?.ticket !== "string" || typeof json?.expiresAt !== "number") {
		throw new Error(`malformed ticket response: ${JSON.stringify(json)}`);
	}
	return { ticket: json.ticket, expiresAt: json.expiresAt };
}

/**
 * Replace ?ticket= in a URL string with a new value, removing any ?token=.
 * Mirrors VaultSync.patchProviderTicket / patchTicketInUrl.
 */
function patchTicketInUrl(urlStr, newTicket) {
	const u = new URL(urlStr);
	u.searchParams.delete("token");
	u.searchParams.set("ticket", newTicket);
	return u.toString();
}

/**
 * Terminate the current WebSocket to trigger an immediate reconnect.
 * Does NOT call provider.disconnect() — that would set shouldConnect=false.
 */
function forceSocketClose(provider) {
	const ws = provider.ws;
	if (ws && typeof ws.terminate === "function") {
		ws.terminate();
	} else if (ws && typeof ws.close === "function") {
		ws.close();
	}
}

/** Tear down provider + ydoc without leaving a dangling reconnect timer. */
async function safeDestroy(provider, ydoc) {
	// Force terminate to skip the 30s ws library close handshake.
	const ws = provider.ws;
	if (ws && typeof ws.terminate === "function") ws.terminate();
	if (provider.awareness) provider.awareness.destroy();

	const captured = new Set();
	const orig = globalThis.setTimeout;
	globalThis.setTimeout = global.setTimeout = (fn, delay, ...args) => {
		const h = orig(fn, delay, ...args);
		if (delay > 0) captured.add(h);
		return h;
	};
	provider.destroy();
	if (ydoc) ydoc.destroy();
	await new Promise((r) => orig(r, 100));
	globalThis.setTimeout = global.setTimeout = orig;
	for (const h of captured) clearTimeout(h);
}

/** Wait for provider to emit a sync event (initial or reconnect). */
function waitForSync(provider, label) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`${label}: timed out waiting for sync`));
		}, 12_000);

		provider.on("message", (event) => {
			if (typeof event.data !== "string") return;
			try {
				const msg = JSON.parse(event.data);
				if (msg?.type === "error") {
					settled = true;
					clearTimeout(timeout);
					reject(new Error(`${label}: server error ${msg.code}`));
				}
			} catch { /* non-JSON Yjs frame */ }
		});

		provider.on("sync", (synced) => {
			if (!synced || settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(undefined);
		});
	});
}

/** Wait for the provider to re-connect after a force-close. Does NOT call connect(). */
function waitForReconnected(provider, label) {
	return new Promise((resolve, reject) => {
		if (provider.wsconnected) { resolve(); return; }
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`${label}: timed out waiting for reconnect`));
		}, 12_000);
		provider.on("status", (event) => {
			if (settled || event.status !== "connected") return;
			settled = true;
			clearTimeout(timeout);
			resolve(undefined);
		});
	});
}

// ---------------------------------------------------------------------------
// Test 1: Initial connect uses ?ticket=, not ?token=
// ---------------------------------------------------------------------------

console.log("\n=== Test 1: initial connect uses ?ticket= ===");
{
	const { ticket, expiresAt } = await fetchTicket(ROOM_ID);
	const ttlRemaining = expiresAt - Date.now();
	console.log(`  ticket fetched; TTL remaining: ${ttlRemaining}ms`);
	if (ttlRemaining < 500) throw new Error("Test 1: ticket expired immediately — check YAOS_TICKET_TTL_MS");

	const ydoc = new Y.Doc();
	const provider = new YSyncProvider(HOST, ROOM_ID, ydoc, {
		prefix: `/vault/sync/${encodeURIComponent(ROOM_ID)}`,
		params: async () => ({
			ticket,
			schemaVersion: "2",
		}),
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: false,
		maxBackoffTime: 500,
	});

	try {
		const syncPromise = waitForSync(provider, "Test 1");
		void provider.connect();
		await syncPromise;

		// provider.url is set by YProvider.connect() after the async params resolve.
		const urlStr = provider.url;
		const u = new URL(urlStr);

		if (!u.searchParams.has("ticket")) {
			throw new Error(`Test 1: provider.url does not contain 'ticket' param — got: ${urlStr}`);
		}
		if (u.searchParams.has("token")) {
			throw new Error(`Test 1: provider.url still contains legacy 'token' param — got: ${urlStr}`);
		}
		if (u.searchParams.get("ticket") !== ticket) {
			throw new Error(`Test 1: provider.url ticket mismatch`);
		}

		console.log("  PASS  initial connect: provider.url uses ?ticket=, not ?token=");
		console.log("  PASS  sync succeeded on ticket-authenticated connection");
	} finally {
		await safeDestroy(provider, ydoc);
	}
}

// ---------------------------------------------------------------------------
// Test 2: Patching provider.url before disconnect causes reconnect to use
//         the new ticket
// ---------------------------------------------------------------------------

console.log("\n=== Test 2: patched provider.url used on reconnect ===");
{
	const { ticket: ticketA } = await fetchTicket(ROOM_ID);

	const ydoc = new Y.Doc();
	const provider = new YSyncProvider(HOST, ROOM_ID, ydoc, {
		prefix: `/vault/sync/${encodeURIComponent(ROOM_ID)}`,
		params: async () => ({ ticket: ticketA, schemaVersion: "2" }),
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: false,
		maxBackoffTime: 500,
	});

	try {
		const syncPromise = waitForSync(provider, "Test 2 initial sync");
		void provider.connect();
		await syncPromise;

		const urlAfterConnect = provider.url;
		if (!new URL(urlAfterConnect).searchParams.has("ticket")) {
			throw new Error(`Test 2: initial URL missing ticket param: ${urlAfterConnect}`);
		}

		// Fetch a new ticket (simulating VaultSync.patchProviderTicket called by the
		// proactive refresh timer).
		const { ticket: ticketB } = await fetchTicket(ROOM_ID);
		if (ticketB === ticketA) throw new Error("Test 2: server returned the same ticket twice (nonce collision)");

		// Patch provider.url — this is exactly what VaultSync.patchProviderTicket does.
		provider.url = patchTicketInUrl(provider.url, ticketB);

		const urlAfterPatch = provider.url;
		const patchedTicketParam = new URL(urlAfterPatch).searchParams.get("ticket");
		if (patchedTicketParam !== ticketB) {
			throw new Error(`Test 2: URL patch did not take effect — got ${patchedTicketParam}`);
		}

		console.log("  provider.url patched with ticketB before disconnect");

		// Force close — y-partyserver will reconnect automatically using provider.url.
		const reconnectPromise = waitForReconnected(provider, "Test 2 reconnect");
		forceSocketClose(provider);
		await reconnectPromise;

		// After reconnect, the provider.url still has ticketB.
		const urlAfterReconnect = new URL(provider.url);
		if (urlAfterReconnect.searchParams.get("ticket") !== ticketB) {
			throw new Error(`Test 2: reconnect used wrong ticket`);
		}
		if (urlAfterReconnect.searchParams.has("token")) {
			throw new Error(`Test 2: reconnect URL contains legacy token param`);
		}

		console.log("  PASS  reconnect used patched ticket URL");
		console.log("  PASS  legacy token param absent after reconnect");
	} finally {
		await safeDestroy(provider, ydoc);
	}
}

// ---------------------------------------------------------------------------
// Test 3: Post-expiry reconnect — sleep/wake scenario
//
// With YAOS_TICKET_TTL_MS=8000 the ticket expires in 8 seconds.
// We wait past expiry, fetch a fresh ticket, patch the URL, then reconnect.
// This proves that an expired ticket does not permanently break sync when
// the URL is refreshed before the next reconnect attempt.
// ---------------------------------------------------------------------------

console.log("\n=== Test 3: post-expiry reconnect (sleep/wake simulation) ===");
{
	const { ticket: ticketA, expiresAt } = await fetchTicket(ROOM_ID);
	const ttl = expiresAt - Date.now();
	console.log(`  ticket TTL: ${ttl}ms — waiting for expiry...`);

	const ydoc = new Y.Doc();
	const provider = new YSyncProvider(HOST, ROOM_ID, ydoc, {
		prefix: `/vault/sync/${encodeURIComponent(ROOM_ID)}`,
		params: async () => ({ ticket: ticketA, schemaVersion: "2" }),
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: false,
		maxBackoffTime: 500,
	});

	try {
		const syncPromise = waitForSync(provider, "Test 3 initial sync");
		void provider.connect();
		await syncPromise;
		console.log("  connected with ticketA");

		// Wait until ticketA is expired (TTL + 500ms grace).
		await wait(ttl + 500);

		// Verify ticketA is now stale: the server should reject a new WS connection
		// with it.  We do a plain HTTP probe (no WebSocket upgrade) to the sync route.
		const staleProbe = await fetch(
			`${HOST}/vault/sync/${encodeURIComponent(ROOM_ID)}?ticket=${encodeURIComponent(ticketA)}&schemaVersion=2`,
		);
		if (staleProbe.status !== 401) {
			throw new Error(`Test 3: expected 401 for expired ticket, got ${staleProbe.status}`);
		}
		console.log(`  confirmed ticketA expired (server returned ${staleProbe.status})`);

		// Fetch a fresh ticket — this is what VaultSync's proactive timer +
		// disconnect best-effort handler do in production.
		const { ticket: ticketB } = await fetchTicket(ROOM_ID);
		provider.url = patchTicketInUrl(provider.url, ticketB);
		console.log("  patched provider.url with fresh ticketB");

		// Force close — y-partyserver reconnects using the patched URL.
		const reconnectPromise = waitForReconnected(provider, "Test 3 reconnect");
		forceSocketClose(provider);
		await reconnectPromise;

		const reconnectUrl = new URL(provider.url);
		if (reconnectUrl.searchParams.get("ticket") !== ticketB) {
			throw new Error(`Test 3: reconnect used wrong ticket`);
		}

		console.log("  PASS  reconnect succeeded after ticket expiry");
		console.log("  PASS  reconnect used fresh ticket, not expired one");
	} finally {
		await safeDestroy(provider, ydoc);
	}
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n✓ All ws-ticket-reconnect smoke tests passed");
process.exit(0);
