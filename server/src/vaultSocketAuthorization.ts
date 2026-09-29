import type { VaultActorContext } from "./collaboration";
import type { ActorCallPort } from "./platformPorts";

export type SocketAuthorityRejection = "vault_not_provisioned" | "vault_identity_mismatch"
	| "vault_generation_mismatch" | "vault_deleting" | "vault_draining" | "missing_trusted_actor"
	| "authority_superseded" | "authority_unavailable" | "mirror_uninitialized";

export function rejectSocketAuthority(reason: SocketAuthorityRejection): Response {
	return Response.json({ error: "unauthorized", reason }, { status: 401 });
}

export async function readVaultAdmissionState(controlPlane: ActorCallPort | undefined, actor: VaultActorContext): Promise<"active" | "inactive" | "unavailable"> {
	if (!controlPlane) return "unavailable";
	try {
		const response = await controlPlane.call("global-config", new Request(
			`https://internal/__yaos/vault?vaultId=${encodeURIComponent(actor.vaultId)}`));
		if (response.status === 404) return "inactive";
		if (!response.ok) return "unavailable";
		const payload = await response.json<{ vault?: { vaultId?: string; vaultGeneration?: string; state?: string } }>();
		return payload.vault?.vaultId === actor.vaultId && payload.vault.vaultGeneration === actor.vaultGeneration
			&& payload.vault.state === "active" ? "active" : "inactive";
	} catch { return "unavailable"; }
}

export async function readFallbackSocketAuthority(controlPlane: ActorCallPort | undefined, actor: VaultActorContext): Promise<Response | null> {
	if (!controlPlane) return null;
	try {
		const membership = await controlPlane.call("global-config", new Request("https://internal/__yaos/verify-device", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ vaultId: actor.vaultId, deviceId: actor.deviceId }),
		}));
		if (!membership.ok) return null;
		const vaultResponse = await controlPlane.call("global-config", new Request(
			`https://internal/__yaos/vault?vaultId=${encodeURIComponent(actor.vaultId)}`));
		if (!vaultResponse.ok) return null;
		const payload = await vaultResponse.json<{ vault?: { vaultId?: string; vaultGeneration?: string; state?: string } }>();
		if (payload.vault?.vaultId !== actor.vaultId || payload.vault.vaultGeneration !== actor.vaultGeneration
			|| payload.vault.state !== "active") return null;
		const authority = await controlPlane.call("global-config", new Request("https://internal/__yaos/collaboration/socket-authority", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(actor),
		}));
		return authority.ok ? authority : null;
	} catch {
		return null;
	}
}
