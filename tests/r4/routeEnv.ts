import type { ObjectStorePort } from "../../server/src/platformPorts";
import type { Env } from "../../server/src/routes/types";
import { COLLABORATION_POLICY_VERSION, capabilityDigestForRole } from "../../server/src/collaboration";

export const VAULT_ID = "vault-r4-streamed";
export const GENERATION = "generation-r4-streamed";

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function routeEnv(bucket: ObjectStorePort): Promise<Env> {
	const capabilityDigest = await capabilityDigestForRole("member");
	return {
		YAOS_BUCKET: bucket,
		YAOS_CONFIG: { call: async (_actorName: string, request: Request) => {
			const url = new URL(request.url);
			if (url.pathname === "/__yaos/collaboration/authorize") return json({
				ok: true,
				device: { deviceId: "device-r4", vaultId: VAULT_ID, name: "Uploader" },
				principal: { principalId: "principal-r4", vaultId: VAULT_ID },
				membership: { principalId: "principal-r4", vaultId: VAULT_ID, role: "member", state: "active", revision: 1 },
				actor: { vaultId: VAULT_ID, vaultGeneration: GENERATION, principalId: "principal-r4", membershipRevision: 1,
					deviceId: "device-r4", deviceCredentialRevision: 1, role: "member", policyVersion: COLLABORATION_POLICY_VERSION, capabilityDigest },
			});
			if (url.pathname === "/__yaos/vault") return json({ vault: {
				vaultId: VAULT_ID, vaultGeneration: GENERATION, name: "R4", state: "active", createdAt: 1, provisionedAt: 1,
			}, provisioningError: null });
			throw new Error(`unexpected authority route: ${url.pathname}`);
		} },
	} as Env;
}
