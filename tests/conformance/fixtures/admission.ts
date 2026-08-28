import { strict as assert } from "node:assert";
import { jsonRequest, pass, rejectedSocket, socketTicket, vaultUrl } from "../client.ts";
import { PROTOCOL_VERSION, SCHEMA_VERSION, targetFromEnv } from "../target.ts";

const target = targetFromEnv();
const noBearer = await jsonRequest(vaultUrl(target.deviceA, "auth/ticket"), { method: "POST" });
assert.equal(noBearer.response.status, 401);
pass("socket tickets require a device bearer");
const ticket = await socketTicket(target.deviceA);
assert.ok(ticket.expiresAt > Date.now());
assert.ok(ticket.ttlMs > 0 && ticket.ttlMs <= 5 * 60_000);
pass("socket tickets are short-lived and explicitly bounded");

const unauthenticated = await rejectedSocket(target.deviceA, { ticket: null, schemaVersion: SCHEMA_VERSION - 1, protocolVersion: PROTOCOL_VERSION - 1 });
assert.deepEqual(unauthenticated, { type: "error", code: "unauthorized" });
pass("socket authentication runs before schema or protocol disclosure");
const schema = await rejectedSocket(target.deviceA, { ticket: ticket.ticket, schemaVersion: SCHEMA_VERSION - 1, protocolVersion: PROTOCOL_VERSION });
assert.equal(schema.code, "update_required");
assert.equal(schema.reason, "schema_mismatch");
assert.equal(schema.clientSchemaVersion, SCHEMA_VERSION - 1);
assert.equal(schema.serverSchemaVersion, SCHEMA_VERSION);
pass("authenticated sockets enforce schema 4");
const protocol = await rejectedSocket(target.deviceA, { ticket: ticket.ticket, schemaVersion: SCHEMA_VERSION, protocolVersion: PROTOCOL_VERSION + 1 });
assert.equal(protocol.code, "update_required");
assert.equal(protocol.reason, "protocol_mismatch");
assert.equal(protocol.serverProtocolVersion, PROTOCOL_VERSION);
pass("authenticated sockets enforce protocol 1");

const wrongVault = await jsonRequest(`${target.baseUrl}/vault/${encodeURIComponent(`${target.deviceA.vaultId}x`)}/auth/ticket`, {
	method: "POST", headers: { authorization: `Bearer ${target.deviceA.deviceToken}` },
});
assert.equal(wrongVault.response.status, 401);
pass("ticket minting verifies vault membership");
