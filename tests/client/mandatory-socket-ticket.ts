import { strict as assert } from "node:assert";
import { createSocketTicketCache, patchTicketInUrl, SocketTicketHttpError } from "../../src/sync/socketTicket";
import { readSource, suite } from "../harness.ts";

const s = suite("mandatory-socket-ticket");

s.section("Provider credentials");
{
	const vaultSync = readSource("src/sync/vaultSync.ts");
	s.check(vaultSync.includes("this.options.getSocketTicket({ purpose: input.kind, documentId: input.documentId })"), "provider fetches an exact-scope ticket before connecting");
	s.check(vaultSync.includes("schemaVersion: String(SCHEMA_VERSION)") && vaultSync.includes("ticket: ticket.value"), "provider params contain schema version and ticket");
	s.check(!vaultSync.includes("token: this.options.token"), "provider has no device-token fallback query path");
	s.check(
		vaultSync.includes("const baseWebSocket =")
			&& vaultSync.includes("this.options.webSocket ?? WebSocket")
			&& vaultSync.includes("WebSocketPolyfill: fencedWebSocketConstructor(baseWebSocket, input.onClose)"),
		"default provider accepts a caller-supplied WebSocket implementation",
	);
	const ticketClient = readSource("src/sync/socketTicket.ts");
	s.check(ticketClient.includes("scope: SocketTicketScope"), "ticket cache requires exact document scope");
}

s.section("Ticket refresh strips stale credential params");
{
	const patched = new URL(patchTicketInUrl("wss://sync.example/room?schemaVersion=3&token=old", "ticket-2"));
	s.check(patched.searchParams.get("ticket") === "ticket-2", "fresh ticket replaces the provider ticket");
	s.check(!patched.searchParams.has("token"), "refresh never retains a token query parameter");
}

s.test("ticket cache uses the injected requester without changing cache policy", async () => {
	const requests: Array<{ url: string; headers?: Record<string, string>; body?: string | ArrayBuffer }> = [];
	const cache = createSocketTicketCache(async (request) => {
		requests.push({ url: request.url, headers: request.headers, body: request.body });
		return {
			status: 200,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			json: {
				ticket: "node-ticket",
				expiresAt: Date.now() + 120_000,
				ttlMs: 120_000,
			},
			text: "",
		};
	});

	const scope = { purpose: "root" as const, documentId: "root" };
	const first = await cache.get("https://sync.example/", "device-token", "vault/id", scope);
	const second = await cache.get("https://sync.example/", "device-token", "vault/id", scope);
	assert.strictEqual(second, first);
	assert.equal(first.value, "node-ticket");
	assert.equal(requests.length, 1);
	assert.equal(
		requests[0]?.url,
		"https://sync.example/vault/vault%2Fid/auth/ticket",
	);
	assert.equal(requests[0]?.headers?.Authorization, "Bearer device-token");
	assert.deepEqual(JSON.parse(String(requests[0]?.body)), scope);
});

s.test("concurrent cache misses are single-flight and invalidation fences late cache population", async () => {
	let requests = 0;
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => { release = resolve; });
	const cache = createSocketTicketCache(async () => {
		requests++;
		const ticket = `ticket-${requests}`;
		if (requests === 1) await barrier;
		return {
			status: 200,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			json: { ticket, expiresAt: Date.now() + 120_000, ttlMs: 120_000 },
			text: "",
		};
	});
	const scope = { purpose: "body" as const, documentId: "body-1" };
	const first = cache.get("https://sync.example", "device", "vault", scope);
	const shared = cache.get("https://sync.example", "device", "vault", scope);
	cache.invalidate();
	release();
	assert.equal((await first).value, "ticket-1");
	assert.equal((await shared).value, "ticket-1");
	assert.equal((await cache.get("https://sync.example", "device", "vault", scope)).value, "ticket-2");
	assert.equal(requests, 2);
});

s.test("ticket rate limits retain bounded retry-after metadata", async () => {
	const cache = createSocketTicketCache(async () => ({
		status: 429,
		headers: { "retry-after": "3" },
		arrayBuffer: new ArrayBuffer(0),
		json: {},
		text: "",
	}));
	await assert.rejects(
		cache.get("https://sync.example", "device", "vault", { purpose: "root", documentId: "root" }),
		(error: unknown) => error instanceof SocketTicketHttpError
			&& error.status === 429
			&& error.retryAfterMs === 3_000,
	);
});

s.test("ticket cache never reuses a ticket across document scopes", async () => {
	let requests = 0;
	const cache = createSocketTicketCache(async () => ({
		status: 200,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
		json: { ticket: `ticket-${++requests}`, expiresAt: Date.now() + 120_000, ttlMs: 120_000 },
		text: "",
	}));
	const root = await cache.get("https://sync.example", "device", "vault", { purpose: "root", documentId: "root" });
	const body = await cache.get("https://sync.example", "device", "vault", { purpose: "body", documentId: "body-1" });
	assert.equal(root.value, "ticket-1");
	assert.equal(body.value, "ticket-2");
	assert.equal(requests, 2);
});

await s.done();
