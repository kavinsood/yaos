import { capabilitiesForRole, authorizeVaultAction } from "../../server/src/collaboration";
import {
	MAX_AUTHORIZATION_CHANGES,
	MAX_VAULT_GOVERNANCE_REQUESTS,
	type AuthorizationChangeRecord,
	type VaultGovernanceRequestRecord,
} from "../../server/src/collaborationIdentity";
import { ControlPlaneRuntime } from "../../server/src/config";
import type { ControlPlaneStoragePort, ControlPlaneTransactionPort } from "../../server/src/platformPorts";
import { suite } from "../harness.ts";

const s = suite("collaboration-control-plane");

function memoryRuntime(data = new Map<string, unknown>()): ControlPlaneRuntime {
	const transaction: ControlPlaneTransactionPort = {
		get: async <T = unknown>(key: string) => data.get(key) as T | undefined,
		put: async (key, value) => { data.set(key, value); },
		delete: async (key) => data.delete(key),
	};
	const storage: ControlPlaneStoragePort = {
		...transaction,
		transaction: async <T>(closure: (txn: ControlPlaneTransactionPort) => Promise<T>) => closure(transaction),
	};
	return new ControlPlaneRuntime(storage);
}

function post(path: string, body: unknown): Request {
	return new Request(`https://internal${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function provisionOwner(runtime: ControlPlaneRuntime) {
	const vaultId = "collab-vault";
	const pairingCodeHash = "a".repeat(64);
	const claim = await runtime.fetch(post("/__yaos/claim", {
		operatorRecoveryHash: "b".repeat(64),
		ticketSigningKey: "ticket-key",
		vaultId,
		vaultName: "Collaboration",
		pairingCodeHash,
		pairingPurpose: "origin",
	}));
	const claimed = await claim.json() as { vaultGeneration: string };
	await runtime.fetch(post("/__yaos/activate-vault", {
		vaultId,
		vaultGeneration: claimed.vaultGeneration,
		pairingCodeHash,
		pairingPurpose: "origin",
	}));
	const enrolled = await runtime.fetch(post("/__yaos/enroll", {
		enrollmentRequestId: "owner-enrollment-request",
		pairingCodeHash,
		deviceId: "owner-device",
		deviceTokenHash: "c".repeat(64),
		deviceName: "Owner",
	}));
	const owner = await enrolled.json() as {
		principalId: string;
		change: { changeId: string; vaultId: string; vaultGeneration: string };
	};
	await runtime.fetch(post("/__yaos/collaboration/complete-change", owner.change));
	return { vaultId, vaultGeneration: claimed.vaultGeneration, ownerPrincipalId: owner.principalId };
}

s.section("fixed owner/member policy is narrow and deny-by-default");
{
	const member = capabilitiesForRole("member");
	const owner = capabilitiesForRole("owner");
	s.check(member.includes("vault.content.write") && owner.includes("vault.content.write"), "owner and member share full content authority");
	s.check(!member.includes("vault.members.invite") && owner.includes("vault.members.invite"), "only owner receives governance authority");
	s.check(!owner.includes("vault.leave") && member.includes("vault.leave"), "owner cannot use ordinary leave");
	s.check(!authorizeVaultAction({ principalId: "member", role: "member", policyVersion: 1 }, "vault.members.manage").allowed, "member governance is denied");
	s.check(!authorizeVaultAction({ principalId: "member", role: "member", policyVersion: 1 }, "vault.recovery.manage").allowed, "member recovery is denied");
	s.check(!authorizeVaultAction({ principalId: "a", role: "member", policyVersion: 1 }, "vault.settings.personal.sync", "b").allowed, "personal settings remain principal-scoped");
}

s.section("expired terminal authorization changes are reclaimed before admission");
{
	const data = new Map<string, unknown>();
	const runtime = memoryRuntime(data);
	const seeded = await provisionOwner(runtime);
	const sample = (data.get("authorizationChanges") as AuthorizationChangeRecord[])[0]!;
	data.set("authorizationChanges", Array.from({ length: MAX_AUTHORIZATION_CHANGES }, (_, index): AuthorizationChangeRecord => ({
		...sample,
		changeId: `expired-change-${index}`,
		requestId: `expired-request-${index}`,
		state: "complete",
		createdAt: 1,
		completedAt: 1,
	})));
	const renamed = await runtime.fetch(post("/__yaos/collaboration/rename-principal", {
		vaultId: seeded.vaultId,
		principalId: seeded.ownerPrincipalId,
		deviceId: "owner-device",
		targetPrincipalId: seeded.ownerPrincipalId,
		displayName: "Owner after pruning",
		requestId: "rename-after-change-pruning",
	}));
	const retained = data.get("authorizationChanges") as AuthorizationChangeRecord[];
	s.check(renamed.status === 202 && retained.length === 1 && retained[0]?.state === "pending",
		"expired completed changes cannot permanently wedge new authorization fences");
}

s.section("authorization capacity rejection does not partially mutate authority");
{
	const data = new Map<string, unknown>();
	const runtime = memoryRuntime(data);
	const seeded = await provisionOwner(runtime);
	const sample = (data.get("authorizationChanges") as AuthorizationChangeRecord[])[0]!;
	const now = Date.now();
	data.set("authorizationChanges", Array.from({ length: MAX_AUTHORIZATION_CHANGES }, (_, index): AuthorizationChangeRecord => ({
		...sample,
		changeId: `recent-change-${index}`,
		requestId: `recent-request-${index}`,
		state: "complete",
		createdAt: now,
		completedAt: now,
	})));
	const rejected = await runtime.fetch(post("/__yaos/collaboration/rename-principal", {
		vaultId: seeded.vaultId,
		principalId: seeded.ownerPrincipalId,
		deviceId: "owner-device",
		targetPrincipalId: seeded.ownerPrincipalId,
		displayName: "Must not persist",
		requestId: "rename-at-change-capacity",
	}));
	const membership = (data.get("vaultMemberships") as Array<{ principalId: string; state: string; revision: number }>)
		.find((record) => record.principalId === seeded.ownerPrincipalId);
	const principal = (data.get("principals") as Array<{ principalId: string; displayName: string }>)
		.find((record) => record.principalId === seeded.ownerPrincipalId);
	s.check(rejected.status === 503 && membership?.state === "active" && membership.revision === 1
		&& principal?.displayName === "Owner", "capacity failure leaves principal and membership authority unchanged");
}

s.section("expired terminal governance requests are reclaimed before rename");
{
	const data = new Map<string, unknown>();
	const runtime = memoryRuntime(data);
	const seeded = await provisionOwner(runtime);
	data.set("vaultGovernanceRequests", Array.from({ length: MAX_VAULT_GOVERNANCE_REQUESTS }, (_, index): VaultGovernanceRequestRecord => ({
		governanceRequestId: `expired-governance-${index}`,
		requestId: `expired-governance-request-${index}`,
		requestDigest: "a".repeat(64),
		vaultId: seeded.vaultId,
		vaultGeneration: seeded.vaultGeneration,
		kind: "vault-rename",
		state: "complete",
		requestedByPrincipalId: seeded.ownerPrincipalId,
		requestedByDeviceId: "owner-device",
		requestedByMembershipRevision: 1,
		requestedName: "Old name",
		emergencyReason: null,
		createdAt: 1,
		confirmedAt: 1,
		completedAt: 1,
		lastError: null,
	})));
	const renamed = await runtime.fetch(post("/__yaos/collaboration/rename-vault", {
		vaultId: seeded.vaultId,
		principalId: seeded.ownerPrincipalId,
		deviceId: "owner-device",
		name: "Renamed after pruning",
		requestId: "vault-rename-after-governance-pruning",
	}));
	const retained = data.get("vaultGovernanceRequests") as VaultGovernanceRequestRecord[];
	s.check(renamed.status === 200 && retained.length === 1 && retained[0]?.requestedName === "Renamed after pruning",
		"expired terminal governance requests cannot permanently wedge owner governance");
}

s.section("owner invitation creates a distinct member while device links retain principal");
{
	const runtime = memoryRuntime();
	const seeded = await provisionOwner(runtime);
	const ownerActor = { vaultId: seeded.vaultId, principalId: seeded.ownerPrincipalId, deviceId: "owner-device" };
	const inviteHash = "d".repeat(64);
	const invitation = await runtime.fetch(post("/__yaos/collaboration/create-code", { ...ownerActor, purpose: "member-invitation", codeHash: inviteHash }));
	s.check(invitation.status === 200, "owner can create a person invitation");
	const memberEnroll = await runtime.fetch(post("/__yaos/enroll", {
		enrollmentRequestId: "member-enrollment-req",
		pairingCodeHash: inviteHash,
		deviceId: "member-device",
		deviceTokenHash: "e".repeat(64),
		deviceName: "Collaborator",
	}));
	const member = await memberEnroll.json() as { principalId: string; role: string; change: { changeId: string; vaultId: string; vaultGeneration: string } };
	s.check(memberEnroll.status === 200 && member.role === "member" && member.principalId !== seeded.ownerPrincipalId, "invitation creates a distinct member principal");
	await runtime.fetch(post("/__yaos/collaboration/complete-change", member.change));
	const memberActor = { vaultId: seeded.vaultId, principalId: member.principalId, deviceId: "member-device" };
	const forbiddenInvite = await runtime.fetch(post("/__yaos/collaboration/create-code", { ...memberActor, purpose: "member-invitation", codeHash: "f".repeat(64) }));
	s.check(forbiddenInvite.status === 403, "member cannot invite another person");
	const linkHash = "1".repeat(64);
	const deviceLink = await runtime.fetch(post("/__yaos/collaboration/create-code", { ...memberActor, purpose: "device-link", codeHash: linkHash }));
	s.check(deviceLink.status === 200, "member can create a link for their own device");
	const linkedEnroll = await runtime.fetch(post("/__yaos/enroll", {
		enrollmentRequestId: "linked-device-request",
		pairingCodeHash: linkHash,
		deviceId: "member-phone",
		deviceTokenHash: "2".repeat(64),
		deviceName: "Phone",
	}));
	const linked = await linkedEnroll.json() as { principalId: string; change: { changeId: string; vaultId: string; vaultGeneration: string } };
	s.check(linked.principalId === member.principalId, "device link retains the creator principal");
	await runtime.fetch(post("/__yaos/collaboration/complete-change", linked.change));
	const roster = await (await runtime.fetch(post("/__yaos/collaboration/members", ownerActor))).json() as { members: Array<{ principalId: string; deviceCount: number }> };
	s.check(roster.members.find((item) => item.principalId === member.principalId)?.deviceCount === 2, "member summary aggregates devices without exposing them");
}

s.section("accepted ownership transfer is one compound durable fence");
{
	const runtime = memoryRuntime();
	const seeded = await provisionOwner(runtime);
	const ownerActor = { vaultId: seeded.vaultId, principalId: seeded.ownerPrincipalId, deviceId: "owner-device" };
	const inviteHash = "3".repeat(64);
	await runtime.fetch(post("/__yaos/collaboration/create-code", { ...ownerActor, purpose: "member-invitation", codeHash: inviteHash }));
	const enrolled = await runtime.fetch(post("/__yaos/enroll", { enrollmentRequestId: "transfer-target-enroll", pairingCodeHash: inviteHash, deviceId: "target-device", deviceTokenHash: "4".repeat(64), deviceName: "Target" }));
	const target = await enrolled.json() as { principalId: string; change: { changeId: string; vaultId: string; vaultGeneration: string } };
	await runtime.fetch(post("/__yaos/collaboration/complete-change", target.change));
	const offered = await runtime.fetch(post("/__yaos/collaboration/create-transfer", { ...ownerActor, targetPrincipalId: target.principalId }));
	const offer = await offered.json() as { transfer: { transferId: string } };
	const accepted = await runtime.fetch(post("/__yaos/collaboration/accept-transfer", { vaultId: seeded.vaultId, principalId: target.principalId, deviceId: "target-device", transferId: offer.transfer.transferId, requestId: "accept-transfer-request" }));
	const acceptance = await accepted.json() as { change: { changeId: string; vaultId: string; vaultGeneration: string; subjects: unknown[] } };
	s.check(accepted.status === 202 && acceptance.change.subjects.length === 2, "acceptance creates one two-membership fence");
	const oldOwnerBeforeFence = await runtime.fetch(post("/__yaos/collaboration/me", ownerActor));
	s.check(oldOwnerBeforeFence.status === 401, "both changed authorities stop admission before fence completion");
	await runtime.fetch(post("/__yaos/collaboration/complete-change", acceptance.change));
	const previous = await (await runtime.fetch(post("/__yaos/collaboration/me", ownerActor))).json() as { principal: { role: string } };
	const next = await (await runtime.fetch(post("/__yaos/collaboration/me", { vaultId: seeded.vaultId, principalId: target.principalId, deviceId: "target-device" }))).json() as { principal: { role: string } };
	s.check(previous.principal.role === "member" && next.principal.role === "owner", "fence completion exposes exactly one new owner");
}

s.section("last-device and exact actor rules fail closed");
{
	const runtime = memoryRuntime();
	const seeded = await provisionOwner(runtime);
	const ownerActor = { vaultId: seeded.vaultId, principalId: seeded.ownerPrincipalId, deviceId: "owner-device" };
	const ownerLastDevice = await runtime.fetch(post("/__yaos/collaboration/revoke-device", { ...ownerActor, targetDeviceId: "owner-device", requestId: "owner-last-device-request" }));
	s.check(ownerLastDevice.status === 409, "owner last device requires operator recovery rather than ordinary revocation");
	const authorized = await runtime.fetch(post("/__yaos/authorize-device", { tokenHash: "c".repeat(64), vaultId: seeded.vaultId }));
	const auth = await authorized.json() as { actor: Record<string, unknown> };
	const exact = await runtime.fetch(post("/__yaos/verify-actor", auth.actor));
	s.check(exact.status === 200, "exact active actor verifies");
	const stale = await runtime.fetch(post("/__yaos/verify-actor", { ...auth.actor, membershipRevision: 999 }));
	s.check(stale.status === 401, "stale actor revision is rejected");
}

s.test("revoked credentials retain only bounded committed-outcome identity", async () => {
	const runtime = memoryRuntime();
	const seeded = await provisionOwner(runtime);
	const ownerActor = { vaultId: seeded.vaultId, principalId: seeded.ownerPrincipalId, deviceId: "owner-device" };
	const inviteHash = "6".repeat(64);
	await runtime.fetch(post("/__yaos/collaboration/create-code", { ...ownerActor, purpose: "member-invitation", codeHash: inviteHash }));
	const enrolled = await runtime.fetch(post("/__yaos/enroll", {
		enrollmentRequestId: "outcome-member-enroll", pairingCodeHash: inviteHash,
		deviceId: "outcome-device", deviceTokenHash: "7".repeat(64), deviceName: "Outcome member",
	}));
	const member = await enrolled.json() as { principalId: string; change: { changeId: string; vaultId: string; vaultGeneration: string } };
	await runtime.fetch(post("/__yaos/collaboration/complete-change", member.change));
	const revoked = await runtime.fetch(post("/__yaos/collaboration/revoke-member", {
		...ownerActor, targetPrincipalId: member.principalId, requestId: "revoke-outcome-member",
	}));
	const revocation = await revoked.json() as { change: { changeId: string; vaultId: string; vaultGeneration: string } };
	await runtime.fetch(post("/__yaos/collaboration/complete-change", revocation.change));
	const ordinary = await runtime.fetch(post("/__yaos/collaboration/authorize", { tokenHash: "7".repeat(64), vaultId: seeded.vaultId }));
	const outcome = await runtime.fetch(post("/__yaos/collaboration/authorize-outcome", { tokenHash: "7".repeat(64), vaultId: seeded.vaultId }));
	const claim = await outcome.json() as { actor?: { principalId?: string; deviceId?: string } };
	s.check(ordinary.status === 401, "revoked credential cannot regain ordinary vault authority");
	s.check(outcome.status === 200 && claim.actor?.principalId === member.principalId && claim.actor.deviceId === "outcome-device",
		"revoked credential retains its exact principal and device identity for receipt lookup");
});

s.test("owner governance is fixed, replayable, and operator-confirmed", async () => {
	const runtime = memoryRuntime();
	const seeded = await provisionOwner(runtime);
	const ownerActor = { vaultId: seeded.vaultId, principalId: seeded.ownerPrincipalId, deviceId: "owner-device" };
	const renamed = await runtime.fetch(post("/__yaos/collaboration/rename-vault", {
		...ownerActor, name: "Shared research", requestId: "rename-vault-request",
	}));
	const renamedBody = await renamed.json() as { governanceRequest: { governanceRequestId: string } };
	s.check(renamed.status === 200 && !!renamedBody.governanceRequest.governanceRequestId, "owner can rename shared vault metadata");
	const replay = await runtime.fetch(post("/__yaos/collaboration/rename-vault", {
		...ownerActor, name: "Shared research", requestId: "rename-vault-request",
	}));
	const replayBody = await replay.json() as typeof renamedBody;
	s.check(replay.status === 200 && replayBody.governanceRequest.governanceRequestId === renamedBody.governanceRequest.governanceRequestId,
		"exact rename retry returns its durable outcome");
	const conflict = await runtime.fetch(post("/__yaos/collaboration/rename-vault", {
		...ownerActor, name: "Different name", requestId: "rename-vault-request",
	}));
	s.check(conflict.status === 409, "request identity cannot be reused with a different rename");

	const inviteHash = "8".repeat(64);
	await runtime.fetch(post("/__yaos/collaboration/create-code", { ...ownerActor, purpose: "member-invitation", codeHash: inviteHash }));
	const enrolled = await runtime.fetch(post("/__yaos/enroll", {
		enrollmentRequestId: "governance-member-enroll", pairingCodeHash: inviteHash,
		deviceId: "governance-member-device", deviceTokenHash: "9".repeat(64), deviceName: "Member",
	}));
	const member = await enrolled.json() as { principalId: string; change: { changeId: string; vaultId: string; vaultGeneration: string } };
	await runtime.fetch(post("/__yaos/collaboration/complete-change", member.change));
	const memberActor = { vaultId: seeded.vaultId, principalId: member.principalId, deviceId: "governance-member-device" };
	s.check((await runtime.fetch(post("/__yaos/collaboration/rename-vault", { ...memberActor, name: "No", requestId: "member-rename-request" }))).status === 403,
		"member cannot rename shared vault metadata");
	s.check((await runtime.fetch(post("/__yaos/collaboration/request-destroy", { ...memberActor, requestId: "member-destroy-request" }))).status === 403,
		"member cannot request vault destruction");

	const requested = await runtime.fetch(post("/__yaos/collaboration/request-destroy", { ...ownerActor, requestId: "owner-destroy-request" }));
	const requestBody = await requested.json() as { governanceRequest: { governanceRequestId: string } };
	s.check(requested.status === 202, "owner creates a durable destruction request without deleting immediately");
	const unconfirmed = await runtime.fetch(post("/__yaos/destroy-vault", {
		vaultId: seeded.vaultId, governanceRequestId: requestBody.governanceRequest.governanceRequestId,
	}));
	s.check(unconfirmed.status === 409, "purge registry refuses an unconfirmed owner request");
	const confirmed = await runtime.fetch(post("/__yaos/collaboration/operator-confirm-destroy", {
		vaultId: seeded.vaultId, governanceRequestId: requestBody.governanceRequest.governanceRequestId,
	}));
	s.check(confirmed.status === 200, "operator independently confirms the exact durable owner request");
	const admitted = await runtime.fetch(post("/__yaos/destroy-vault", {
		vaultId: seeded.vaultId, governanceRequestId: requestBody.governanceRequest.governanceRequestId,
	}));
	s.check(admitted.status === 200, "confirmed request admits the existing purge-first deletion workflow");
});

s.test("legacy collaboration migration RPC is absent", async () => {
	const response = await memoryRuntime().fetch(post("/__yaos/collaboration/migrate", {
		vaultId: "legacy-vault",
		ownerDeviceIds: ["legacy-device"],
	}));
	s.check(response.status === 404, "schema-6 identity migration cannot be invoked through the control plane");
});

await s.done();
