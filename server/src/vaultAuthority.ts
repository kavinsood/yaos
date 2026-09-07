import {
	COLLABORATION_POLICY_VERSION,
	authorizeVaultAction,
	type VaultActorContext,
	type VaultCapability,
	type VaultRole,
} from "./collaboration";
import type { VaultStore } from "./vaultStore";

export const ACTOR_PRINCIPAL_HEADER = "x-yaos-principal-id";
export const ACTOR_MEMBERSHIP_REVISION_HEADER = "x-yaos-membership-revision";
export const ACTOR_DEVICE_HEADER = "x-yaos-device-id";
export const ACTOR_DEVICE_NAME_HEADER = "x-yaos-device-name";
export const ACTOR_DEVICE_REVISION_HEADER = "x-yaos-device-credential-revision";
export const ACTOR_ROLE_HEADER = "x-yaos-vault-role";
export const ACTOR_POLICY_VERSION_HEADER = "x-yaos-policy-version";
export const ACTOR_CAPABILITY_DIGEST_HEADER = "x-yaos-capability-digest";
export const OUTCOME_CLAIM_HEADER = "x-yaos-outcome-claim";

const MAX_IDENTITY_LENGTH = 256;

function validIdentity(value: string | null): value is string {
	return value !== null && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH
		&& ![...value].some((character) => {
			const code = character.codePointAt(0)!;
			return code < 0x20 || code === 0x7f;
		});
}

function positiveRevision(value: string | null): number | null {
	if (value === null || !/^\d+$/.test(value)) return null;
	const revision = Number(value);
	return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

export function actorHeaders(actor: VaultActorContext): Headers {
	const headers = new Headers({
		[ACTOR_PRINCIPAL_HEADER]: actor.principalId,
		[ACTOR_MEMBERSHIP_REVISION_HEADER]: String(actor.membershipRevision),
		[ACTOR_DEVICE_HEADER]: actor.deviceId,
		[ACTOR_DEVICE_REVISION_HEADER]: String(actor.deviceCredentialRevision),
		[ACTOR_ROLE_HEADER]: actor.role,
		[ACTOR_POLICY_VERSION_HEADER]: String(actor.policyVersion),
		[ACTOR_CAPABILITY_DIGEST_HEADER]: actor.capabilityDigest,
	});
	if (actor.deviceName) headers.set(ACTOR_DEVICE_NAME_HEADER, actor.deviceName);
	return headers;
}

export function stripActorHeaders(headers: Headers): void {
	for (const name of [ACTOR_PRINCIPAL_HEADER, ACTOR_MEMBERSHIP_REVISION_HEADER,
		ACTOR_DEVICE_HEADER, ACTOR_DEVICE_NAME_HEADER, ACTOR_DEVICE_REVISION_HEADER, ACTOR_ROLE_HEADER,
		ACTOR_POLICY_VERSION_HEADER, ACTOR_CAPABILITY_DIGEST_HEADER]) headers.delete(name);
	headers.delete(OUTCOME_CLAIM_HEADER);
}

export function parseVaultActor(request: Request, vaultId: string, vaultGeneration: string): VaultActorContext | null {
	const principalId = request.headers.get(ACTOR_PRINCIPAL_HEADER);
	const deviceId = request.headers.get(ACTOR_DEVICE_HEADER);
	const deviceName = request.headers.get(ACTOR_DEVICE_NAME_HEADER);
	const role = request.headers.get(ACTOR_ROLE_HEADER);
	const membershipRevision = positiveRevision(request.headers.get(ACTOR_MEMBERSHIP_REVISION_HEADER));
	const deviceCredentialRevision = positiveRevision(request.headers.get(ACTOR_DEVICE_REVISION_HEADER));
	const policyVersion = positiveRevision(request.headers.get(ACTOR_POLICY_VERSION_HEADER));
	const capabilityDigest = request.headers.get(ACTOR_CAPABILITY_DIGEST_HEADER);
	if (!validIdentity(principalId) || !validIdentity(deviceId)
		|| (role !== "owner" && role !== "member")
		|| membershipRevision === null || deviceCredentialRevision === null
		|| policyVersion === null || !validIdentity(capabilityDigest)) return null;
	return { vaultId, vaultGeneration, principalId, membershipRevision, deviceId,
		deviceCredentialRevision, role: role as VaultRole, policyVersion, capabilityDigest,
		...(validIdentity(deviceName) ? { deviceName } : {}) };
}

export function authorizeRuntimeActor(
	store: VaultStore,
	actor: VaultActorContext | null,
	capability: VaultCapability,
	targetPrincipalId?: string,
): { allowed: true; actor: VaultActorContext } | { allowed: false; response: Response } {
	if (!actor) return { allowed: false, response: Response.json({ error: "missing_trusted_actor" }, { status: 401 }) };
	if (actor.policyVersion !== COLLABORATION_POLICY_VERSION || store.validateActor(actor) !== "allowed") {
		return { allowed: false, response: Response.json({ error: "authority_superseded" }, { status: 409 }) };
	}
	const decision = authorizeVaultAction(actor, capability, targetPrincipalId);
	return decision.allowed
		? { allowed: true, actor }
		: { allowed: false, response: Response.json({ error: decision.reason }, { status: 403 }) };
}

export function mutationAuthority(actor: VaultActorContext): Pick<VaultActorContext,
	"principalId" | "membershipRevision" | "deviceId" | "deviceCredentialRevision"> {
	return {
		principalId: actor.principalId,
		membershipRevision: actor.membershipRevision,
		deviceId: actor.deviceId,
		deviceCredentialRevision: actor.deviceCredentialRevision,
	};
}
