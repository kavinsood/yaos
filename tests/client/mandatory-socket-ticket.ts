import { patchTicketInUrl } from "../../src/sync/socketTicket";
import { readSource, suite } from "../harness.ts";

const s = suite("mandatory-socket-ticket");

s.section("Provider credentials");
{
	const vaultSync = readSource("src/sync/vaultSync.ts");
	s.check(vaultSync.includes("const ticket = await this._getSocketTicket()"), "provider fetches a ticket before connecting");
	s.check(vaultSync.includes("schemaVersion: String(SCHEMA_VERSION)") && vaultSync.includes("ticket: ticket.value"), "provider params contain schema version and ticket");
	s.check(!vaultSync.includes("p.token") && !vaultSync.includes("longLivedToken"), "provider has no device-token fallback query path");
	const ticketClient = readSource("src/sync/socketTicket.ts");
	s.check(ticketClient.includes("get(host: string, deviceToken: string, vaultId: string)"), "ticket cache requires device credentials and vault scope");
}

s.section("Ticket refresh strips stale credential params");
{
	const patched = new URL(patchTicketInUrl("wss://sync.example/room?schemaVersion=3&token=old", "ticket-2"));
	s.check(patched.searchParams.get("ticket") === "ticket-2", "fresh ticket replaces the provider ticket");
	s.check(!patched.searchParams.has("token"), "refresh never retains a token query parameter");
}

await s.done();
