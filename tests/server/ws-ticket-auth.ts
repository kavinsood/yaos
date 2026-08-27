import { SERVER_SCHEMA_VERSION } from "../../server/src/version";
import { inspectTicket, createTicket, verifyTicket } from "../../server/src/routes/ticket";
import { authenticateSocketRequest, handleSyncSocketRoute } from "../../server/src/routes/syncSocket";
import type { AuthState, Env } from "../../server/src/routes/types";
import { makeEnv, makeTrapNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("ws-ticket-auth");
const vaultId = "vault-ticket-one";
const deviceId = "device-ticket-one";
const auth: AuthState = {
	mode: "claim",
	claimed: true,
	operatorRecoveryHash: "operator-hash-not-signing-material",
	ticketSigningKey: "dedicated-ticket-signing-key-for-tests",
};

function decodeBase64Url(value: string): Uint8Array {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

s.section("ticket carries vault and device identity");
{
	const { ticket, expiresAt } = await createTicket(auth, vaultId, deviceId);
	const payload = await inspectTicket(ticket, auth, vaultId);
	s.check(expiresAt > Date.now(), "ticket expiry is in the future");
	s.check(payload?.vaultId === vaultId, "ticket is scoped to its vault");
	s.check(payload?.deviceId === deviceId, "ticket identifies the enrolled device");
}

s.section("ticket signature uses the dedicated signing key");
{
	const { ticket } = await createTicket(auth, vaultId, deviceId);
	const differentOperatorHash: AuthState = {
		...auth,
		operatorRecoveryHash: "different-operator-hash",
	};
	const differentSigningKey: AuthState = {
		...auth,
		ticketSigningKey: "different-dedicated-signing-key",
	};
	s.check(await verifyTicket(ticket, differentOperatorHash, vaultId), "operator hash is not ticket signing material");
	s.check(!(await verifyTicket(ticket, differentSigningKey, vaultId)), "a different signing key rejects the ticket");
}

s.section("expiry, tampering, and cross-vault use fail closed");
{
	const { ticket: expired } = await createTicket(auth, vaultId, deviceId, -1);
	s.check(!(await verifyTicket(expired, auth, vaultId)), "expired ticket is rejected");
	const { ticket } = await createTicket(auth, vaultId, deviceId);
	s.check(!(await verifyTicket(ticket, auth, "other-vault")), "ticket cannot cross vaults");
	const [payload, signature] = ticket.split(".");
	if (!payload || !signature) throw new Error("created ticket is not a payload/signature pair");
	const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
	const originalBytes = decodeBase64Url(signature);
	const tamperedBytes = decodeBase64Url(tamperedSignature);
	s.check(
		originalBytes.length > 0 && originalBytes[0] !== tamperedBytes[0],
		"tamper deterministically changes decoded signature bytes",
	);
	s.check(!(await verifyTicket(`${payload}.${tamperedSignature}`, auth, vaultId)), "tampered ticket is rejected");
}

s.section("socket authentication accepts tickets only");
{
	const { ticket } = await createTicket(auth, vaultId, deviceId);
	const accepted = await authenticateSocketRequest(ticket, auth, vaultId);
	s.check(accepted.ok && accepted.method === "ticket", "valid ticket authenticates");
	s.check(accepted.ok && accepted.deviceId === deviceId, "socket gate retains device identity for membership recheck");
	const missing = await authenticateSocketRequest(null, auth, vaultId);
	s.check(!missing.ok && missing.reason === "unauthorized", "missing ticket is unauthorized");
	const unsupported: AuthState = { mode: "unsupported", claimed: true };
	const oldConfig = await authenticateSocketRequest(ticket, unsupported, vaultId);
	s.check(!oldConfig.ok && oldConfig.reason === "server_format_unsupported", "unsupported server format is explicit");
}

s.section("legacy token query cannot authenticate or wake a room");
{
	const { ticket } = await createTicket(auth, vaultId, deviceId);
	const configTrap = makeTrapNamespace("legacy token query must not consult config");
	const roomTrap = makeTrapNamespace("legacy token query must not wake room");
	const env: Env = makeEnv({ YAOS_CONFIG: configTrap, YAOS_SYNC: roomTrap });
	const url = new URL(`https://example.test/vault/sync/${vaultId}`);
	url.searchParams.set("token", ticket);
	url.searchParams.set("schemaVersion", String(SERVER_SCHEMA_VERSION));
	const response = await handleSyncSocketRoute(new Request(url), env, auth, vaultId);
	s.check(response.status === 401, "token query is unauthorized even with the supported schema");
	s.check(configTrap.touched.length === 0, "token query is rejected before membership lookup");
	s.check(roomTrap.touched.length === 0, "token query does not wake the room");
}

await s.done();
