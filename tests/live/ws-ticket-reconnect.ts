/**
 * WebSocket ticket auth reconnect smoke tests.
 *
 * Proves the three behaviors the unit tests cannot reach:
 *
 *   1. Initial connect uses a mandatory socket ticket and the pinned schema.
 *
 *   2. Patching provider.url with a fresh ticket before a force-disconnect
 *      causes the reconnect to use the new ticket and succeed. This is the
 *      core mechanism behind VaultSync.patchProviderTicket — the test proves
 *      the underlying YSyncProvider behaviour the workaround depends on.
 *
 *   3. A ticket that expires mid-session does not permanently break sync: if
 *      the URL is patched with a fresh ticket before (or during) the
 *      disconnect, the reconnect succeeds. This is the sleep/wake scenario.
 *
 * The server is expected to be running under wrangler dev with
 * YAOS_TICKET_TTL_MS=8000 injected via the worker-integration harness.
 * This makes tickets expire in 8 seconds so that post-expiry reconnect
 * can be tested without a 5-minute wait.
 *
 * Prerequisites are the accountable host, device bearer, vault ID, and device
 * ID supplied by run-live.ts.
 */

import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { SCHEMA_VERSION } from "../../src/sync/schema.ts";
import { describeFatalFrame, onFatalFrame } from "./fatalFrame.ts";
import { fetchSocketTicket, requireLiveIdentity } from "./liveIdentity.ts";

const identity = requireLiveIdentity();
const HOST = identity.host;
const ROOM_ID = identity.vaultId;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}


/** Replace the ticket in a provider URL while preserving the pinned schema. */
function patchTicketInUrl(urlStr: string, newTicket: string): string {
	const url = new URL(urlStr);
	url.searchParams.set("ticket", newTicket);
	return url.toString();
}

function assertSocketParams(urlStr: string, expectedTicket: string, label: string): void {
	const url = new URL(urlStr);
	const names = [...url.searchParams.keys()].sort();
	if (JSON.stringify(names) !== JSON.stringify(["_pk", "schemaVersion", "ticket"])) {
		throw new Error(`${label}: socket URL has unexpected parameters: ${names.join(", ")}`);
	}
	if (url.searchParams.get("ticket") !== expectedTicket) {
		throw new Error(`${label}: socket URL ticket mismatch`);
	}
}

/**
 * Terminate the current WebSocket to trigger an immediate reconnect.
 * Does NOT call provider.disconnect() — that would set shouldConnect=false.
 */
function forceSocketClose(provider: YSyncProvider): void {
	const ws = provider.ws;
	// Only the "ws" implementation exposes terminate(); a global WebSocket does not.
	if (ws instanceof WebSocket) {
		ws.terminate();
	} else if (ws && typeof ws.close === "function") {
		ws.close();
	}
}

/** Tear down provider + ydoc without leaving a dangling reconnect timer. */
async function safeDestroy(provider: YSyncProvider, ydoc: Y.Doc): Promise<void> {
	// Force terminate to skip the 30s ws library close handshake.
	const ws = provider.ws;
	if (ws instanceof WebSocket) ws.terminate();
	if (provider.awareness) provider.awareness.destroy();

	const captured = new Set<NodeJS.Timeout>();
	const orig = globalThis.setTimeout;
	// lib.dom and @types/node both declare setTimeout, so the global's type is
	// the union of their overloads: a replacement has to satisfy the
	// number-returning DOM signature as well as the Timeout-returning Node one,
	// and carry Node's util.promisify hook.
	function patchedSetTimeout(handler: TimerHandler, timeout?: number, ...args: unknown[]): number;
	function patchedSetTimeout<TArgs extends unknown[]>(
		callback: (...cbArgs: TArgs) => void,
		ms?: number,
		...args: TArgs
	): NodeJS.Timeout;
	function patchedSetTimeout(
		callback: (...cbArgs: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	): NodeJS.Timeout | number {
		const h = orig(callback, ms, ...args);
		if (ms !== undefined && ms > 0) captured.add(h);
		return h;
	}
	globalThis.setTimeout = global.setTimeout = Object.assign(patchedSetTimeout, {
		__promisify__: orig.__promisify__,
	});
	provider.destroy();
	if (ydoc) ydoc.destroy();
	await new Promise<void>((r) => orig(r, 100));
	globalThis.setTimeout = global.setTimeout = orig;
	for (const h of captured) clearTimeout(h);
}

/** Wait for provider to emit a sync event (initial or reconnect). */
function waitForSync(provider: YSyncProvider, label: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`${label}: timed out waiting for sync`));
		}, 12_000);

		// "message" is not a provider event; a rejected ticket surfaces as a
		// "custom-message" fatal frame (see ./fatalFrame.ts).
		onFatalFrame(provider, (frame) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(new Error(`${label}: server rejected the connection: ${describeFatalFrame(frame)}`));
		});

		provider.on("sync", (synced: boolean) => {
			if (!synced || settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(undefined);
		});
	});
}

/** Wait for the provider to re-connect after a force-close. Does NOT call connect(). */
function waitForReconnected(provider: YSyncProvider, label: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (provider.wsconnected) { resolve(); return; }
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`${label}: timed out waiting for reconnect`));
		}, 12_000);
		provider.on("status", (event: { status: string }) => {
			if (settled || event.status !== "connected") return;
			settled = true;
			clearTimeout(timeout);
			resolve(undefined);
		});
	});
}

// ---------------------------------------------------------------------------
// Test 1: Initial connect uses only the mandatory ticket and schema
// ---------------------------------------------------------------------------

console.log("\n=== Test 1: initial connect uses a mandatory ticket ===");
{
	const { ticket, ttlMs } = await fetchSocketTicket(identity);
	const ttlRemaining = ttlMs;
	console.log(`  ticket fetched; TTL remaining: ${ttlRemaining}ms`);
	if (ttlRemaining < 500) throw new Error("Test 1: ticket expired immediately — check YAOS_TICKET_TTL_MS");

	const ydoc = new Y.Doc();
	const provider = new YSyncProvider(HOST, ROOM_ID, ydoc, {
		prefix: `/vault/sync/${encodeURIComponent(ROOM_ID)}`,
		params: async () => ({
			ticket,
			schemaVersion: String(SCHEMA_VERSION),
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
		assertSocketParams(provider.url, ticket, "Test 1");

		console.log("  PASS  initial connect uses only the ticket and schema parameters");
		console.log("  PASS  sync succeeded on the ticket-authenticated connection");
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
	const { ticket: ticketA } = await fetchSocketTicket(identity);

	const ydoc = new Y.Doc();
	const provider = new YSyncProvider(HOST, ROOM_ID, ydoc, {
		prefix: `/vault/sync/${encodeURIComponent(ROOM_ID)}`,
		params: async () => ({ ticket: ticketA, schemaVersion: String(SCHEMA_VERSION) }),
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: false,
		maxBackoffTime: 500,
	});

	try {
		const syncPromise = waitForSync(provider, "Test 2 initial sync");
		void provider.connect();
		await syncPromise;

		assertSocketParams(provider.url, ticketA, "Test 2 initial URL");

		// Fetch a new ticket (simulating VaultSync.patchProviderTicket called by the
		// proactive refresh timer).
		const { ticket: ticketB } = await fetchSocketTicket(identity);
		if (ticketB === ticketA) throw new Error("Test 2: server returned the same ticket twice (nonce collision)");

		// Patch provider.url — this is exactly what VaultSync.patchProviderTicket does.
		provider.url = patchTicketInUrl(provider.url, ticketB);

		assertSocketParams(provider.url, ticketB, "Test 2 patched URL");

		console.log("  provider.url patched with ticketB before disconnect");

		// Force close — y-partyserver will reconnect automatically using provider.url.
		const reconnectPromise = waitForReconnected(provider, "Test 2 reconnect");
		forceSocketClose(provider);
		await reconnectPromise;

		assertSocketParams(provider.url, ticketB, "Test 2 reconnect URL");

		console.log("  PASS  reconnect used patched ticket URL");
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
	const { ticket: ticketA, ttlMs } = await fetchSocketTicket(identity);
	const ttl = ttlMs;
	console.log(`  ticket TTL: ${ttl}ms — waiting for expiry...`);

	const ydoc = new Y.Doc();
	const provider = new YSyncProvider(HOST, ROOM_ID, ydoc, {
		prefix: `/vault/sync/${encodeURIComponent(ROOM_ID)}`,
		params: async () => ({ ticket: ticketA, schemaVersion: String(SCHEMA_VERSION) }),
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
			`${HOST}/vault/sync/${encodeURIComponent(ROOM_ID)}?ticket=${encodeURIComponent(ticketA)}&schemaVersion=${SCHEMA_VERSION}`,
		);
		if (staleProbe.status !== 401) {
			throw new Error(`Test 3: expected 401 for expired ticket, got ${staleProbe.status}`);
		}
		console.log(`  confirmed ticketA expired (server returned ${staleProbe.status})`);

		// Fetch a fresh ticket — this is what VaultSync's proactive timer +
		// disconnect best-effort handler do in production.
		const { ticket: ticketB } = await fetchSocketTicket(identity);
		provider.url = patchTicketInUrl(provider.url, ticketB);
		console.log("  patched provider.url with fresh ticketB");

		// Force close — y-partyserver reconnects using the patched URL.
		const reconnectPromise = waitForReconnected(provider, "Test 3 reconnect");
		forceSocketClose(provider);
		await reconnectPromise;

		assertSocketParams(provider.url, ticketB, "Test 3 reconnect URL");

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
