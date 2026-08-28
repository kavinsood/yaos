import type { VaultRecord } from "../identity";
import type { Env } from "./types";

function configFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
	return env.YAOS_CONFIG.call("global-config", new Request(`https://internal${path}`, init));
}

/** Completes reserve -> DO provision -> config activation, recording retryable failure. */
export async function provisionReservedVault(
	env: Env,
	vault: VaultRecord,
	pairing?: { codeHash: string; purpose: "origin" | "device" | "invite" },
): Promise<Response> {
	if (vault.state === "active") return Response.json({ ok: true, vault });
	if (vault.state !== "provisioning") return Response.json({ error: "vault_not_provisionable" }, { status: 409 });
	try {
		const provision = await env.YAOS_SYNC.call(vault.vaultId, new Request("https://internal/__yaos/provision", {
			method: "POST",
			headers: { "content-type": "application/json", "x-yaos-vault-id": vault.vaultId },
			body: JSON.stringify({ vaultGeneration: vault.vaultGeneration }),
		}));
		if (!provision.ok) throw new Error(`vault provisioning failed (${provision.status})`);
		const activation = await configFetch(env, "/__yaos/activate-vault", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ vaultId: vault.vaultId, vaultGeneration: vault.vaultGeneration,
				pairingCodeHash: pairing?.codeHash, pairingPurpose: pairing?.purpose }),
		});
		if (!activation.ok) throw new Error(`vault activation failed (${activation.status})`);
		return activation;
	} catch (error) {
		const message = error instanceof Error ? error.message : "vault provisioning failed";
		await configFetch(env, "/__yaos/fail-vault-provisioning", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ vaultId: vault.vaultId, vaultGeneration: vault.vaultGeneration, error: message }),
		}).catch(() => undefined);
		return Response.json({ error: "vault_provisioning_failed", retryable: true, message }, { status: 503 });
	}
}
