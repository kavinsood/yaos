import { strict as assert } from "node:assert";
import { createTicket, handleTicketRoute, inspectTicket, TICKET_TTL_MS, verifyTicket } from "../../server/src/routes/ticket";
import { handleVaultSocketRoute } from "../../server/src/routes/vault";
import type { AuthState } from "../../server/src/routes/types";
import { capabilityDigestForRole, COLLABORATION_POLICY_VERSION, type VaultActorContext } from "../../server/src/collaboration";
import { makeConfigNamespace, makeEnv, makeTrapNamespace, makeVaultSyncNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("ws-ticket-auth");
const VAULT_ID = "ticket-vault-0001";
const DEVICE_ID = "device-ticket-0001";
const GENERATION = "generation-ticket-0001";
const AUTH: AuthState = {
	mode: "claim",
	claimed: true,
	operatorRecoveryHash: "operator-recovery-hash",
	ticketSigningKey: "ticket-signing-key-for-tests",
};
const ACTOR: VaultActorContext = {
	vaultId: VAULT_ID, vaultGeneration: GENERATION, principalId: "principal-ticket-0001",
	membershipRevision: 1, deviceId: DEVICE_ID, deviceCredentialRevision: 1,
	deviceName: "Ticket laptop",
	role: "member", policyVersion: COLLABORATION_POLICY_VERSION, capabilityDigest: "pending",
};

async function actor(): Promise<VaultActorContext> {
	return { ...ACTOR, capabilityDigest: await capabilityDigestForRole("member") };
}

s.test("ticket integrity, vault scope, device identity, and expiry fail closed", async () => {
	const issued = await createTicket(AUTH, await actor(), "root", "root");
	assert.equal(issued.ttlMs, TICKET_TTL_MS);
	assert.equal(await verifyTicket(issued.ticket, AUTH, VAULT_ID), true);
	assert.equal((await inspectTicket(issued.ticket, AUTH, VAULT_ID))?.deviceId, DEVICE_ID);
	assert.equal((await inspectTicket(issued.ticket, AUTH, VAULT_ID))?.deviceName, "Ticket laptop");
	const separator = issued.ticket.indexOf(".");
	const signature = issued.ticket.slice(separator + 1);
	const tampered = `${issued.ticket.slice(0, separator + 1)}${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
	assert.equal(await verifyTicket(tampered, AUTH, VAULT_ID), false, "tampering invalidates HMAC");
	assert.equal(await verifyTicket(issued.ticket, AUTH, "other-vault-0001"), false, "ticket is vault-bound");
	assert.equal(await verifyTicket((await createTicket(AUTH, await actor(), "root", "root", -1)).ticket, AUTH, VAULT_ID), false, "expired ticket is rejected");
});

s.test("ticket HTTP handler signs the authorized device identity", async () => {
	const response = await handleTicketRoute(
		new Request(`https://example.test/vault/${VAULT_ID}/auth/ticket`, { method: "POST", body: JSON.stringify({ purpose: "root", documentId: "root" }) }),
		AUTH,
		await actor(),
		(body, status = 200) => Response.json(body, { status }),
	);
	assert.equal(response.status, 200);
	const body = await response.json() as { ticket: string; ttlMs: number };
	assert.equal(body.ttlMs, TICKET_TTL_MS);
	assert.equal((await inspectTicket(body.ticket, AUTH, VAULT_ID))?.deviceId, DEVICE_ID);
});

s.test("revoked membership rejects both root and body sockets before vault allocation", async () => {
	const rootTicket = (await createTicket(AUTH, await actor(), "root", "root")).ticket;
	const bodyTicket = (await createTicket(AUTH, await actor(), "body", "body-ticket-0001")).ticket;
	let membershipChecks = 0;
	const syncTrap = makeTrapNamespace("revoked socket touched YAOS_SYNC");
	const env = makeEnv({
		YAOS_SYNC: syncTrap,
		YAOS_CONFIG: makeConfigNamespace(async (request) => {
			if (new URL(request.url).pathname === "/__yaos/verify-device") membershipChecks++;
			return Response.json({ error: "device_not_enrolled" }, { status: 404 });
		}),
	});
	for (const [runtimePath, ticket] of [["/ws/root", rootTicket], ["/ws/body/body-ticket-0001", bodyTicket]] as const) {
		const response = await handleVaultSocketRoute(
			new Request(`https://example.test/vault/${VAULT_ID}${runtimePath}?ticket=${encodeURIComponent(ticket)}&schemaVersion=7&protocolVersion=4`),
			env,
			AUTH,
			VAULT_ID,
			runtimePath,
		);
		assert.equal(response.status, 401);
	}
	assert.equal(membershipChecks, 2);
	assert.deepEqual(syncTrap.touched, []);
});

s.test("live membership forwards exact device identity to root and body runtime sockets", async () => {
	const rootTicket = (await createTicket(AUTH, await actor(), "root", "root")).ticket;
	const bodyTicket = (await createTicket(AUTH, await actor(), "body", "body-ticket-0001")).ticket;
	const forwarded: Array<{ path: string; deviceId: string | null; principalId: string | null }> = [];
	const syncNamespace = makeVaultSyncNamespace(async (request) => {
		forwarded.push({ path: new URL(request.url).pathname, deviceId: request.headers.get("x-yaos-device-id"), principalId: request.headers.get("x-yaos-principal-id") });
		return new Response(null, { status: 204 });
	});
	const env = makeEnv({
		YAOS_SYNC: syncNamespace,
		YAOS_CONFIG: makeConfigNamespace(async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/__yaos/verify-device") return Response.json({ ok: true });
			if (path === "/__yaos/vault") return Response.json({ vault: { vaultId: VAULT_ID, vaultGeneration: GENERATION, state: "active" } });
			return Response.json({ error: "not_found" }, { status: 404 });
		}),
	});
	for (const [runtimePath, ticket] of [["/ws/root", rootTicket], ["/ws/body/body-ticket-0001", bodyTicket]] as const) {
		const response = await handleVaultSocketRoute(
			new Request(`https://example.test/vault/${VAULT_ID}${runtimePath}?ticket=${encodeURIComponent(ticket)}&schemaVersion=7&protocolVersion=4`),
			env,
			AUTH,
			VAULT_ID,
			runtimePath,
		);
		assert.equal(response.status, 204);
	}
	assert.deepEqual(forwarded, [
		{ path: "/ws/root", deviceId: DEVICE_ID, principalId: ACTOR.principalId },
		{ path: "/ws/body/body-ticket-0001", deviceId: DEVICE_ID, principalId: ACTOR.principalId },
	]);
});

await s.done();
