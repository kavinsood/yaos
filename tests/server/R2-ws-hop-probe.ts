import { strict as assert } from "node:assert";
import { createTicket } from "../../server/src/routes/ticket";
import { handleVaultSocketRoute } from "../../server/src/routes/vault";
import { capabilityDigestForRole, COLLABORATION_POLICY_VERSION, type VaultActorContext } from "../../server/src/collaboration";
import type { AuthState } from "../../server/src/routes/types";
import { SERVER_SCHEMA_VERSION, SERVER_PROTOCOL_VERSION } from "../../server/src/version";
import { makeConfigNamespace, makeEnv, makeVaultSyncNamespace } from "../mocks/workerEnv";
import { suite } from "../harness";

const tests = suite("R2-ws-hop-probe");
const auth: AuthState = { mode: "claim", claimed: true, operatorRecoveryHash: "probe-operator", ticketSigningKey: "probe-signing-key" };
const before = process.env.YAOS_R2_BEFORE === "1";

for (const purpose of ["root", "body"] as const) {
	tests.test(`${purpose} Worker connect drops two singleton hops without weakening forwarded ticket scope`, async () => {
		const actor: VaultActorContext = { vaultId: "r2-probe-vault", vaultGeneration: "r2-probe-generation", principalId: "r2-probe-principal",
			membershipRevision: 1, deviceId: "r2-probe-device", deviceCredentialRevision: 1, role: "member",
			policyVersion: COLLABORATION_POLICY_VERSION, capabilityDigest: await capabilityDigestForRole("member") };
		const scope = purpose === "root" ? { purpose, documentId: "root" as const, rootEpoch: 3 }
			: { purpose, documentId: "r2-probe-body", bodyEpoch: 7 };
		const ticket = (await createTicket(auth, actor, scope)).ticket;
		const calls: string[] = [];
		const forwarded: Request[] = [];
		const env = makeEnv({
			YAOS_CONFIG: makeConfigNamespace(async (request) => {
				const path = new URL(request.url).pathname;
				calls.push(path);
				if (path === "/__yaos/verify-device") return Response.json({ ok: true });
				if (path === "/__yaos/vault") return Response.json({ vault: { vaultId: actor.vaultId, vaultGeneration: actor.vaultGeneration, state: "active" } });
				throw new Error(`unexpected singleton call: ${path}`);
			}),
			YAOS_SYNC: makeVaultSyncNamespace(async (request) => { forwarded.push(request); return new Response(null, { status: 204 }); }),
		});
		const path = purpose === "root" ? "/ws/root" : "/ws/body/r2-probe-body";
		const response = await handleVaultSocketRoute(new Request(`https://example.test/vault/${actor.vaultId}${path}?ticket=${encodeURIComponent(ticket)}&schemaVersion=${SERVER_SCHEMA_VERSION}&protocolVersion=${SERVER_PROTOCOL_VERSION}`,
			{ headers: { upgrade: "websocket", "x-yaos-principal-id": "spoof-owner", "x-yaos-outcome-claim": "1",
				"x-yaos-root-epoch": "999", "x-yaos-body-epoch": "999", authorization: "Bearer spoof" } }), env, auth, actor.vaultId, path);
		assert.equal(response.status, 204);
		assert.deepEqual(calls, before ? ["/__yaos/verify-device", "/__yaos/vault"] : []);
		assert.equal(forwarded.length, 1);
		assert.equal(forwarded[0]!.headers.get("x-yaos-principal-id"), actor.principalId);
		assert.equal(forwarded[0]!.headers.get("x-yaos-outcome-claim"), null);
		assert.equal(forwarded[0]!.headers.get("authorization"), null);
		assert.equal(forwarded[0]!.headers.get("x-yaos-root-epoch"), purpose === "root" ? "3" : null);
		assert.equal(forwarded[0]!.headers.get("x-yaos-body-epoch"), purpose === "body" ? "7" : null);
	});
}

await tests.done();
