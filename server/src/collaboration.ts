import { sha256Hex } from "./hex";

export const COLLABORATION_POLICY_VERSION = 2 as const;

export type VaultRole = "owner" | "member";

export const VAULT_CAPABILITIES = [
	"vault.catalog.read",
	"vault.content.read",
	"vault.content.write",
	"vault.lifecycle.write",
	"vault.attachments.read",
	"vault.attachments.write",
	"vault.presence.use",
	"vault.members.read",
	"vault.profile.manage_self",
	"vault.devices.manage_self",
	"vault.settings.personal.sync",
	"vault.leave",
	"vault.operations.read_own_outcome",
	"vault.members.invite",
	"vault.members.manage",
	"vault.devices.manage_all",
	"vault.recovery.manage",
	"vault.audit.read",
	"vault.diagnostics.read",
	"vault.policy.manage",
	"vault.metadata.rename",
	"vault.ownership.transfer",
	"vault.destroy.request",
	"vault.excalidraw.shares.manage",
] as const;

export type VaultCapability = typeof VAULT_CAPABILITIES[number];

const MEMBER_CAPABILITIES = new Set<VaultCapability>([
	"vault.catalog.read",
	"vault.content.read",
	"vault.content.write",
	"vault.lifecycle.write",
	"vault.attachments.read",
	"vault.attachments.write",
	"vault.presence.use",
	"vault.members.read",
	"vault.profile.manage_self",
	"vault.devices.manage_self",
	"vault.settings.personal.sync",
	"vault.leave",
	"vault.operations.read_own_outcome",
]);

const OWNER_CAPABILITIES = new Set<VaultCapability>([
	...MEMBER_CAPABILITIES,
	"vault.members.invite",
	"vault.members.manage",
	"vault.devices.manage_all",
	"vault.recovery.manage",
	"vault.audit.read",
	"vault.diagnostics.read",
	"vault.policy.manage",
	"vault.metadata.rename",
	"vault.ownership.transfer",
	"vault.destroy.request",
	"vault.excalidraw.shares.manage",
]);
OWNER_CAPABILITIES.delete("vault.leave");

export interface VaultActorContext {
	vaultId: string;
	vaultGeneration: string;
	principalId: string;
	membershipRevision: number;
	deviceId: string;
	deviceName?: string;
	deviceCredentialRevision: number;
	role: VaultRole;
	policyVersion: number;
	capabilityDigest: string;
}

export type VaultAuthorizationDenyReason =
	| "capability_missing"
	| "principal_target_mismatch"
	| "policy_version_stale";

export type VaultAuthorizationDecision =
	| { allowed: true }
	| { allowed: false; reason: VaultAuthorizationDenyReason };

export function capabilitiesForRole(role: VaultRole): readonly VaultCapability[] {
	const capabilities = role === "owner" ? OWNER_CAPABILITIES : MEMBER_CAPABILITIES;
	return VAULT_CAPABILITIES.filter((capability) => capabilities.has(capability));
}

export async function capabilityDigestForRole(role: VaultRole): Promise<string> {
	return sha256Hex(new TextEncoder().encode(
		`${COLLABORATION_POLICY_VERSION}:${role}:${capabilitiesForRole(role).join(",")}`,
	));
}

export function authorizeVaultAction(
	actor: Pick<VaultActorContext, "principalId" | "role" | "policyVersion">,
	capability: VaultCapability,
	targetPrincipalId?: string,
): VaultAuthorizationDecision {
	if (actor.policyVersion !== COLLABORATION_POLICY_VERSION) {
		return { allowed: false, reason: "policy_version_stale" };
	}
	if (!capabilitiesForRole(actor.role).includes(capability)) {
		return { allowed: false, reason: "capability_missing" };
	}
	if (
		targetPrincipalId !== undefined
		&& (capability === "vault.profile.manage_self"
			|| capability === "vault.devices.manage_self"
			|| capability === "vault.settings.personal.sync")
		&& actor.principalId !== targetPrincipalId
	) {
		return { allowed: false, reason: "principal_target_mismatch" };
	}
	return { allowed: true };
}
