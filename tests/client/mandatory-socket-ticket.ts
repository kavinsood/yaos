import { strict as assert } from "node:assert";
import { createSocketTicketCache, patchTicketInUrl } from "../../src/sync/socketTicket";
import { readSource, suite } from "../harness.ts";

const s = suite("mandatory-socket-ticket");

s.section("Provider credentials");
{
	const vaultSync = readSource("src/sync/vaultSync.ts");
	s.check(vaultSync.includes("const ticket = await this.options.getSocketTicket()"), "provider fetches a ticket before connecting");
	s.check(vaultSync.includes("schemaVersion: String(SCHEMA_VERSION)") && vaultSync.includes("ticket: ticket.value"), "provider params contain schema version and ticket");
	s.check(!vaultSync.includes("token: this.options.token"), "provider has no device-token fallback query path");
	s.check(
		vaultSync.includes("WebSocketPolyfill: this.options.webSocket"),
		"default provider accepts a caller-supplied WebSocket implementation",
	);
	const ticketClient = readSource("src/sync/socketTicket.ts");
	s.check(ticketClient.includes("get(host: string, deviceToken: string, vaultId: string)"), "ticket cache requires device credentials and vault scope");
}

s.section("Ticket refresh strips stale credential params");
{
	const patched = new URL(patchTicketInUrl("wss://sync.example/room?schemaVersion=3&token=old", "ticket-2"));
	s.check(patched.searchParams.get("ticket") === "ticket-2", "fresh ticket replaces the provider ticket");
	s.check(!patched.searchParams.has("token"), "refresh never retains a token query parameter");
}

s.test("ticket cache uses the injected requester without changing cache policy", async () => {
	const requests: Array<{ url: string; headers?: Record<string, string> }> = [];
	const cache = createSocketTicketCache(async (request) => {
		requests.push({ url: request.url, headers: request.headers });
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

	const first = await cache.get("https://sync.example/", "device-token", "vault/id");
	const second = await cache.get("https://sync.example/", "device-token", "vault/id");
	assert.strictEqual(second, first);
	assert.equal(first.value, "node-ticket");
	assert.equal(requests.length, 1);
	assert.equal(
		requests[0]?.url,
		"https://sync.example/vault/vault%2Fid/auth/ticket",
	);
	assert.equal(requests[0]?.headers?.Authorization, "Bearer device-token");
});

await s.done();
