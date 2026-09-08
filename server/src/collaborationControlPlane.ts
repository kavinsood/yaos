import { randomBase64Url } from "./base64url";
import {
	COLLABORATION_POLICY_VERSION,
	authorizeVaultAction,
	capabilitiesForRole,
	capabilityDigestForRole,
	type VaultActorContext,
	type VaultCapability,
} from "./collaboration";
import {
	COLLABORATION_CODE_TTL_MS,
	MAX_AUTHORIZATION_CHANGES,
	MAX_COLLABORATION_CODES,
	MAX_OWNERSHIP_TRANSFERS,
	MAX_PRINCIPALS_PER_VAULT,
	MAX_SECURITY_AUDIT_EVENTS,
	MAX_VAULT_GOVERNANCE_REQUESTS,
	parseAuthorizationChangeRecords,
	parseCollaborationCodeRecords,
	parseMembershipRecords,
	parseOwnershipTransferRecords,
	parsePrincipalRecords,
	parseSecurityAuditEvents,
	parseVaultGovernanceRequestRecords,
	type AuthorizationChangeRecord,
	type CollaborationCodePurpose,
	type CollaborationCodeRecord,
	type PrincipalRecord,
	type SecurityAuditEvent,
	type VaultMembershipRecord,
	type VaultGovernanceRequestRecord,
} from "./collaborationIdentity";
import { sha256Hex } from "./hex";
import {
	MAX_DEVICE_RECORDS,
	findHashedRecord,
	parseDeviceRecords,
	parseVaultRecords,
	toDevicePublic,
	type DeviceRecord,
} from "./identity";
import type { ControlPlaneRecordFilter, ControlPlaneStoragePort, ControlPlaneTransactionPort } from "./platformPorts";
import { json } from "./routes/http";

export const PRINCIPALS_KEY = "principals";
export const MEMBERSHIPS_KEY = "vaultMemberships";
export const COLLABORATION_CODES_KEY = "collaborationCodes";
export const OWNERSHIP_TRANSFERS_KEY = "ownershipTransfers";
export const AUTHORIZATION_CHANGES_KEY = "authorizationChanges";
export const SECURITY_AUDIT_EVENTS_KEY = "securityAuditEvents";
export const VAULT_GOVERNANCE_REQUESTS_KEY = "vaultGovernanceRequests";
const DEVICES_KEY = "devices";
const VAULTS_KEY = "vaults";

const TRANSFER_TTL_MS = 15 * 60 * 1_000;
const TERMINAL_RECORD_RETENTION_MS = 24 * 60 * 60 * 1_000;

interface ActorInput {
	vaultId?: unknown;
	principalId?: unknown;
	deviceId?: unknown;
}

interface CollaborationState {
	principals: PrincipalRecord[];
	memberships: VaultMembershipRecord[];
	devices: DeviceRecord[];
}

function retainAuthorizationChanges(records: AuthorizationChangeRecord[], now: number): AuthorizationChangeRecord[] {
	return records.filter((record) => record.state !== "complete"
		|| record.completedAt === null
		|| record.completedAt > now - TERMINAL_RECORD_RETENTION_MS);
}

function retainGovernanceRequests(records: VaultGovernanceRequestRecord[], now: number): VaultGovernanceRequestRecord[] {
	return records.filter((record) => (record.state !== "complete" && record.state !== "failed")
		|| (record.completedAt ?? record.createdAt) > now - TERMINAL_RECORD_RETENTION_MS);
}

async function authorizationChangesForAdmission(
	txn: ControlPlaneTransactionPort,
	now: number,
): Promise<AuthorizationChangeRecord[] | null> {
	if (txn.records) {
		await txn.records.deleteWhere(AUTHORIZATION_CHANGES_KEY, {
			state: "complete",
			completedAtOrBefore: now - TERMINAL_RECORD_RETENTION_MS,
		});
		return await txn.records.count(AUTHORIZATION_CHANGES_KEY) < MAX_AUTHORIZATION_CHANGES ? [] : null;
	}
	const stored = parseAuthorizationChangeRecords(await txn.get(AUTHORIZATION_CHANGES_KEY));
	const retained = retainAuthorizationChanges(stored, now);
	if (retained.length !== stored.length) await txn.put(AUTHORIZATION_CHANGES_KEY, retained);
	return retained.length < MAX_AUTHORIZATION_CHANGES ? retained : null;
}

async function governanceAdmissionAvailable(txn: ControlPlaneTransactionPort, now: number): Promise<boolean> {
	if (txn.records) {
		const cutoff = now - TERMINAL_RECORD_RETENTION_MS;
		await txn.records.deleteWhere(VAULT_GOVERNANCE_REQUESTS_KEY, {
			state: "complete", completedAtOrBefore: cutoff,
		});
		await txn.records.deleteWhere(VAULT_GOVERNANCE_REQUESTS_KEY, {
			state: "failed", createdBefore: cutoff,
		});
		return await txn.records.count(VAULT_GOVERNANCE_REQUESTS_KEY) < MAX_VAULT_GOVERNANCE_REQUESTS;
	}
	const stored = parseVaultGovernanceRequestRecords(await txn.get(VAULT_GOVERNANCE_REQUESTS_KEY));
	const retained = retainGovernanceRequests(stored, now);
	if (retained.length !== stored.length) await txn.put(VAULT_GOVERNANCE_REQUESTS_KEY, retained);
	return retained.length < MAX_VAULT_GOVERNANCE_REQUESTS;
}

async function pendingDestroyGovernance(txn: ControlPlaneTransactionPort, vaultId: string): Promise<VaultGovernanceRequestRecord | undefined> {
	if (!txn.records) {
		return parseVaultGovernanceRequestRecords(await txn.get(VAULT_GOVERNANCE_REQUESTS_KEY))
			.find((record) => record.vaultId === vaultId && record.kind !== "vault-rename"
				&& record.state !== "complete" && record.state !== "failed");
	}
	for (const state of ["awaiting-operator-confirmation", "confirmed", "executing"] as const) {
		const record = await oneRecord(txn, VAULT_GOVERNANCE_REQUESTS_KEY, { vaultId, state }, parseVaultGovernanceRequestRecords);
		if (record && record.kind !== "vault-rename") return record;
	}
	return undefined;
}

export async function initializeCollaborationStorage(txn: ControlPlaneTransactionPort): Promise<void> {
	await txn.put(PRINCIPALS_KEY, []);
	await txn.put(MEMBERSHIPS_KEY, []);
	await txn.put(COLLABORATION_CODES_KEY, []);
	await txn.put(OWNERSHIP_TRANSFERS_KEY, []);
	await txn.put(AUTHORIZATION_CHANGES_KEY, []);
	await txn.put(SECURITY_AUDIT_EVENTS_KEY, []);
	await txn.put(VAULT_GOVERNANCE_REQUESTS_KEY, []);
}

function boundedName(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : fallback;
}

function isId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRequestId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
	try {
		const body: unknown = await request.json();
		return typeof body === "object" && body !== null && !Array.isArray(body)
			? body as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

async function readState(txn: ControlPlaneTransactionPort): Promise<CollaborationState> {
	const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
	return {
		principals: parsePrincipalRecords(await txn.get(PRINCIPALS_KEY)),
		memberships: parseMembershipRecords(await txn.get(MEMBERSHIPS_KEY)),
		devices: parseDeviceRecords(await txn.get(DEVICES_KEY), new Set(vaults.map((vault) => vault.vaultId))),
	};
}

async function readVaultState(txn: ControlPlaneTransactionPort, vaultId: string): Promise<CollaborationState> {
	if (!txn.records) return readState(txn);
	const [principalsRaw, membershipsRaw, devicesRaw] = await Promise.all([
		txn.records.list(PRINCIPALS_KEY, { vaultId, limit: MAX_PRINCIPALS_PER_VAULT }),
		txn.records.list(MEMBERSHIPS_KEY, { vaultId, limit: MAX_PRINCIPALS_PER_VAULT }),
		txn.records.list(DEVICES_KEY, { vaultId, limit: MAX_DEVICE_RECORDS }),
	]);
	return {
		principals: parsePrincipalRecords(principalsRaw),
		memberships: parseMembershipRecords(membershipsRaw),
		devices: parseDeviceRecords(devicesRaw, new Set([vaultId])),
	};
}

async function oneRecord<T>(
	txn: ControlPlaneTransactionPort,
	collection: string,
	filter: ControlPlaneRecordFilter,
	parser: (value: unknown) => T[],
): Promise<T | undefined> {
	if (!txn.records) throw new Error("indexed record lookup unavailable");
	const raw = await txn.records.get(collection, filter);
	return raw === undefined ? undefined : parser([raw])[0];
}

async function vaultRecord(txn: ControlPlaneTransactionPort, vaultId: string) {
	if (!txn.records) return parseVaultRecords(await txn.get(VAULTS_KEY)).find((record) => record.vaultId === vaultId);
	return oneRecord(txn, VAULTS_KEY, { recordKey: vaultId }, parseVaultRecords);
}

async function principalRecord(txn: ControlPlaneTransactionPort, vaultId: string, principalId: string) {
	if (!txn.records) return parsePrincipalRecords(await txn.get(PRINCIPALS_KEY)).find((record) => record.vaultId === vaultId && record.principalId === principalId);
	const value = await oneRecord(txn, PRINCIPALS_KEY, { recordKey: principalId }, parsePrincipalRecords);
	return value?.vaultId === vaultId ? value : undefined;
}

async function membershipRecord(txn: ControlPlaneTransactionPort, vaultId: string, principalId: string) {
	if (!txn.records) return parseMembershipRecords(await txn.get(MEMBERSHIPS_KEY)).find((record) => record.vaultId === vaultId && record.principalId === principalId);
	return oneRecord(txn, MEMBERSHIPS_KEY, { vaultId, principalId }, parseMembershipRecords);
}

async function deviceRecord(
	txn: ControlPlaneTransactionPort,
	filter: { recordKey?: string; tokenHash?: string },
	vaultId?: string,
) {
	if (!txn.records) {
		const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
		return parseDeviceRecords(await txn.get(DEVICES_KEY), new Set(vaults.map((vault) => vault.vaultId)))
			.find((record) => (filter.recordKey === undefined || record.deviceId === filter.recordKey)
				&& (filter.tokenHash === undefined || record.tokenHash === filter.tokenHash)
				&& (vaultId === undefined || record.vaultId === vaultId));
	}
	const raw = await txn.records.get<DeviceRecord>(DEVICES_KEY, { ...filter, ...(vaultId ? { vaultId } : {}) });
	if (!raw) return undefined;
	return parseDeviceRecords([raw], new Set([raw.vaultId]))[0];
}

async function upsertRecord(txn: ControlPlaneTransactionPort, collection: string, record: unknown): Promise<void> {
	if (!txn.records) throw new Error("indexed record mutation unavailable");
	await txn.records.upsert(collection, record);
}

async function persistRecords(
	txn: ControlPlaneTransactionPort,
	collection: string,
	records: readonly unknown[],
): Promise<void> {
	if (!txn.records) {
		await txn.put(collection, records);
		return;
	}
	for (const record of records) await txn.records.upsert(collection, record);
}

function resolveActor(state: CollaborationState, input: ActorInput): {
	principal: PrincipalRecord;
	membership: VaultMembershipRecord;
	device: DeviceRecord;
} | null {
	if (!isId(input.vaultId) || !isId(input.principalId) || !isId(input.deviceId)) return null;
	const principal = state.principals.find((record) => record.vaultId === input.vaultId && record.principalId === input.principalId);
	const membership = state.memberships.find((record) => record.vaultId === input.vaultId && record.principalId === input.principalId);
	const device = state.devices.find((record) => record.vaultId === input.vaultId && record.principalId === input.principalId && record.deviceId === input.deviceId);
	if (!principal || !membership || !device || membership.state !== "active" || device.state !== "active") return null;
	return { principal, membership, device };
}

function requireCapability(
	actor: NonNullable<ReturnType<typeof resolveActor>>,
	capability: VaultCapability,
	targetPrincipalId?: string,
): Response | null {
	const decision = authorizeVaultAction({
		principalId: actor.principal.principalId,
		role: actor.membership.role,
		policyVersion: COLLABORATION_POLICY_VERSION,
	}, capability, targetPrincipalId);
	return decision.allowed ? null : json({ error: decision.reason }, 403);
}

type AuditInput = Omit<SecurityAuditEvent, "eventId" | "createdAt">;

async function appendAudit(txn: ControlPlaneTransactionPort, input: AuditInput, now: number): Promise<void> {
	const event: SecurityAuditEvent = { eventId: randomBase64Url(16), createdAt: now, ...input };
	if (txn.records) {
		await txn.records.append(SECURITY_AUDIT_EVENTS_KEY, event, MAX_SECURITY_AUDIT_EVENTS);
		return;
	}
	const events = parseSecurityAuditEvents(await txn.get(SECURITY_AUDIT_EVENTS_KEY));
	events.push(event);
	if (events.length > MAX_SECURITY_AUDIT_EVENTS) events.splice(0, events.length - MAX_SECURITY_AUDIT_EVENTS);
	await txn.put(SECURITY_AUDIT_EVENTS_KEY, events);
}

async function recentAuditEvents(txn: ControlPlaneTransactionPort, vaultId: string): Promise<SecurityAuditEvent[]> {
	if (txn.records) {
		return txn.records.list<SecurityAuditEvent>(SECURITY_AUDIT_EVENTS_KEY, {
			vaultId,
			limit: 200,
			reverse: true,
		});
	}
	return parseSecurityAuditEvents(await txn.get(SECURITY_AUDIT_EVENTS_KEY))
		.filter((event) => event.vaultId === vaultId)
		.slice(-200)
		.reverse();
}

async function requestDigest(value: unknown): Promise<string> {
	return sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
}

function publicPrincipal(principal: PrincipalRecord, membership: VaultMembershipRecord) {
	return {
		principalId: principal.principalId,
		displayName: principal.displayName,
		colorSeed: principal.colorSeed,
		role: membership.role,
		state: membership.state,
		membershipRevision: membership.revision,
		joinedAt: membership.joinedAt,
	};
}

export async function buildActorContext(
	vaultGeneration: string,
	principal: PrincipalRecord,
	membership: VaultMembershipRecord,
	device: DeviceRecord,
): Promise<VaultActorContext> {
	return {
		vaultId: principal.vaultId,
		vaultGeneration,
		principalId: principal.principalId,
		membershipRevision: membership.revision,
		deviceId: device.deviceId,
		deviceCredentialRevision: device.credentialRevision ?? 1,
		role: membership.role,
		policyVersion: COLLABORATION_POLICY_VERSION,
		capabilityDigest: await capabilityDigestForRole(membership.role),
	};
}

export interface EnrollmentIdentityInput {
	vaultId: string;
	device: DeviceRecord;
	pairingPurpose: "origin" | "device" | "invite";
	pairingCodeHash: string;
	displayName: string;
	enrollmentRequestId: string;
	requestDigest: string;
}

export async function installEnrollmentIdentity(
	txn: ControlPlaneTransactionPort,
	input: EnrollmentIdentityInput,
): Promise<{ principal: PrincipalRecord; membership: VaultMembershipRecord; device: DeviceRecord; change: AuthorizationChangeRecord } | Response> {
	const now = Date.now();
	const state = await readVaultState(txn, input.vaultId);
	const changes = await authorizationChangesForAdmission(txn, now);
	if (!changes) return json({ error: "authorization_change_capacity" }, 503);
	const codes = txn.records ? [] : parseCollaborationCodeRecords(await txn.get(COLLABORATION_CODES_KEY));
	const code = txn.records
		? await oneRecord(txn, COLLABORATION_CODES_KEY, { codeHash: input.pairingCodeHash }, parseCollaborationCodeRecords)
		: findHashedRecord(codes, input.pairingCodeHash, (record) => record.codeHash);
	let principalId: string;
	let role: "owner" | "member";
	let invitedByPrincipalId: string | null = null;
	if (code) {
		if (code.consumedAt !== null) return json({ error: "invitation_consumed" }, 409);
		if (code.expiresAt <= now) return json({ error: "invitation_expired" }, 410);
		if (code.vaultId !== input.vaultId) return json({ error: "wrong_vault" }, 409);
		if (code.purpose === "device-link" || code.purpose === "owner-recovery") {
			if (!code.principalId) return json({ error: "invalid_code" }, 409);
			const membership = state.memberships.find((record) => record.vaultId === input.vaultId && record.principalId === code.principalId);
			if (!membership || (code.purpose === "device-link" && membership.state !== "active")) return json({ error: "membership_revoked" }, 409);
			if (code.issuerMembershipRevision !== null && membership.revision !== code.issuerMembershipRevision) return json({ error: "membership_revision_stale" }, 409);
			if (code.creatorDeviceId) {
				const creator = state.devices.find((record) => record.deviceId === code.creatorDeviceId);
				if (!creator || creator.state !== "active" || creator.credentialRevision !== code.creatorDeviceCredentialRevision) return json({ error: "device_credential_stale" }, 409);
			}
			principalId = membership.principalId;
			role = membership.role;
		} else {
			if (code.purpose === "member-invitation" && code.issuerPrincipalId) {
				const issuer = state.memberships.find((record) => record.vaultId === input.vaultId && record.principalId === code.issuerPrincipalId);
				if (!issuer || issuer.role !== "owner" || issuer.state !== "active" || issuer.revision !== code.issuerMembershipRevision) return json({ error: "authority_superseded" }, 409);
				invitedByPrincipalId = issuer.principalId;
			}
			principalId = randomBase64Url(16);
			role = code.purpose === "owner-bootstrap" ? "owner" : "member";
		}
		code.consumedAt = now;
		if (txn.records) await upsertRecord(txn, COLLABORATION_CODES_KEY, code);
		else await txn.put(COLLABORATION_CODES_KEY, codes);
	} else if (input.pairingPurpose === "origin") {
		principalId = randomBase64Url(16);
		role = "owner";
	} else if (input.pairingPurpose === "device") {
		const owner = state.memberships.find((record) => record.vaultId === input.vaultId && record.role === "owner" && record.state === "active");
		if (!owner && !state.memberships.some((record) => record.vaultId === input.vaultId)) {
			principalId = randomBase64Url(16);
			role = "owner";
		} else {
			if (!owner) return json({ error: "owner_invariant" }, 409);
			principalId = owner.principalId;
			role = owner.role;
		}
	} else {
		const owner = state.memberships.find((record) => record.vaultId === input.vaultId && record.role === "owner" && record.state === "active");
		if (!owner) return json({ error: "owner_invariant" }, 409);
		principalId = randomBase64Url(16);
		role = "member";
		invitedByPrincipalId = owner.principalId;
	}

	let principal = state.principals.find((record) => record.principalId === principalId);
	let membership = state.memberships.find((record) => record.principalId === principalId && record.vaultId === input.vaultId);
	const newPrincipal = !principal;
	if (!principal) {
		if (state.principals.filter((record) => record.vaultId === input.vaultId).length >= MAX_PRINCIPALS_PER_VAULT) return json({ error: "principal_capacity" }, 503);
		principal = { principalId, vaultId: input.vaultId, displayName: boundedName(input.displayName, "Member"), colorSeed: randomBase64Url(12), createdAt: now, updatedAt: now };
		membership = { vaultId: input.vaultId, principalId, role, state: "changing", revision: 1, invitedByPrincipalId, joinedAt: now, updatedAt: now, revokedAt: null };
		state.principals.push(principal);
		state.memberships.push(membership);
	}
	if (!membership || (!newPrincipal && membership.state !== "active")) return json({ error: "membership_revoked" }, 409);
	input.device.principalId = principalId;
	input.device.credentialRevision = 1;
	input.device.state = "changing";
	input.device.revokedAt = null;
	if (txn.records) {
		if (newPrincipal) {
			await upsertRecord(txn, PRINCIPALS_KEY, principal);
			await upsertRecord(txn, MEMBERSHIPS_KEY, membership);
		}
	} else {
		await persistRecords(txn, PRINCIPALS_KEY, state.principals);
		await persistRecords(txn, MEMBERSHIPS_KEY, state.memberships);
	}
	const vaults = txn.records ? [] : parseVaultRecords(await txn.get(VAULTS_KEY));
	const vault = txn.records ? await vaultRecord(txn, input.vaultId) : vaults.find((record) => record.vaultId === input.vaultId);
	if (vault && role === "owner") {
		vault.ownerPrincipalId = principalId;
		if (txn.records) await upsertRecord(txn, VAULTS_KEY, vault);
		else await txn.put(VAULTS_KEY, vaults);
	}
	if (!vault) return json({ error: "unknown_vault" }, 404);
	const subjects: AuthorizationChangeRecord["subjects"] = [];
	if (newPrincipal) subjects.push({ kind: "membership", principalId, deviceId: null, previousRevision: 1, targetRevision: 1, targetRole: role, targetState: "active", displayName: principal.displayName, colorSeed: principal.colorSeed });
	subjects.push({ kind: "device", principalId, deviceId: input.device.deviceId, previousRevision: 1, targetRevision: 1, targetRole: null, targetState: "active" });
	const change: AuthorizationChangeRecord = {
		changeId: randomBase64Url(16), vaultId: input.vaultId, vaultGeneration: vault.vaultGeneration,
		kind: "authority-install", requestedByPrincipalId: invitedByPrincipalId, requestId: input.enrollmentRequestId,
		requestDigest: input.requestDigest, subjectDigest: await requestDigest(subjects), subjects,
		state: "pending", createdAt: now, completedAt: null, lastError: null,
	};
	changes.push(change);
	if (txn.records) await upsertRecord(txn, AUTHORIZATION_CHANGES_KEY, change);
	else await txn.put(AUTHORIZATION_CHANGES_KEY, changes);
	await appendAudit(txn, { vaultId: input.vaultId, kind: role === "owner" ? "owner_enrolled" : "member_enrolled", actorPrincipalId: invitedByPrincipalId, actorDeviceId: null, targetPrincipalId: principalId, targetDeviceId: input.device.deviceId, detail: null }, now);
	return { principal, membership, device: input.device, change };
}

export class CollaborationControlPlane {
	constructor(private readonly storage: ControlPlaneStoragePort) {}

	async fetch(request: Request): Promise<Response | null> {
		const { pathname } = new URL(request.url);
		if (!pathname.startsWith("/__yaos/collaboration/")) return null;
		const body = request.method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : await readJson(request);
		if (!body) return json({ error: "invalid json" }, 400);
		switch (`${request.method} ${pathname}`) {
			case "POST /__yaos/collaboration/authorize": return this.authorize(body);
			case "POST /__yaos/collaboration/authorize-outcome": return this.authorizeOutcome(body);
			case "POST /__yaos/collaboration/verify-actor": return this.verifyActor(body);
			case "POST /__yaos/collaboration/me": return this.me(body);
			case "POST /__yaos/collaboration/members": return this.members(body);
			case "POST /__yaos/collaboration/audit": return this.audit(body);
			case "POST /__yaos/collaboration/codes": return this.codes(body);
			case "POST /__yaos/collaboration/devices": return this.devices(body);
			case "POST /__yaos/collaboration/create-code": return this.createCode(body);
			case "POST /__yaos/collaboration/revoke-code": return this.revokeCode(body);
			case "POST /__yaos/collaboration/rename-principal": return this.renamePrincipal(body);
			case "POST /__yaos/collaboration/rename-vault": return this.renameVault(body);
			case "POST /__yaos/collaboration/request-destroy": return this.requestDestroy(body);
			case "POST /__yaos/collaboration/rename-device": return this.renameDevice(body);
			case "POST /__yaos/collaboration/revoke-device": return this.revokeDevice(body);
			case "POST /__yaos/collaboration/revoke-member": return this.revokeMember(body);
			case "POST /__yaos/collaboration/create-transfer": return this.createTransfer(body);
			case "POST /__yaos/collaboration/accept-transfer": return this.acceptTransfer(body);
			case "POST /__yaos/collaboration/cancel-transfer": return this.cancelTransfer(body);
			case "POST /__yaos/collaboration/complete-change": return this.completeChange(body);
			case "POST /__yaos/collaboration/fail-change": return this.failChange(body);
			case "POST /__yaos/collaboration/pending-changes": return this.pendingChanges(body);
			case "POST /__yaos/collaboration/operator-code": return this.operatorCode(body);
			case "POST /__yaos/collaboration/operator-confirm-destroy": return this.operatorConfirmDestroy(body);
			case "POST /__yaos/collaboration/operator-emergency-destroy": return this.operatorEmergencyDestroy(body);
			case "POST /__yaos/collaboration/update-destroy": return this.updateDestroy(body);
			default: return json({ error: "not found" }, 404);
		}
	}

	private async authorize(body: Record<string, unknown>): Promise<Response> {
		if (!isHash(body.tokenHash)) return json({ error: "unauthorized" }, 401);
		const tokenHash = body.tokenHash;
		return this.storage.transaction(async (txn) => {
			if (!txn.records) {
				const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
				const state = await readState(txn);
				const device = findHashedRecord(state.devices, tokenHash, (record) => record.tokenHash);
				if (!device || device.state !== "active" || !device.principalId || (isId(body.vaultId) && body.vaultId !== device.vaultId)) return json({ error: "unauthorized" }, 401);
				const principal = state.principals.find((record) => record.principalId === device.principalId && record.vaultId === device.vaultId);
				const membership = state.memberships.find((record) => record.principalId === device.principalId && record.vaultId === device.vaultId);
				const vault = vaults.find((record) => record.vaultId === device.vaultId && record.state === "active");
				if (!principal || !membership || membership.state !== "active" || !vault) return json({ error: "unauthorized" }, 401);
				return json({ ok: true, device: toDevicePublic(device), principal, membership, actor: await buildActorContext(vault.vaultGeneration, principal, membership, device) });
			}
			const device = await deviceRecord(txn, { tokenHash });
			if (!device || device.state !== "active" || !device.principalId || (isId(body.vaultId) && body.vaultId !== device.vaultId)) return json({ error: "unauthorized" }, 401);
			const [principal, membership, vault] = await Promise.all([
				principalRecord(txn, device.vaultId, device.principalId),
				membershipRecord(txn, device.vaultId, device.principalId),
				vaultRecord(txn, device.vaultId),
			]);
			if (!principal || !membership || membership.state !== "active" || vault?.state !== "active") return json({ error: "unauthorized" }, 401);
			return json({ ok: true, device: toDevicePublic(device), principal, membership, actor: await buildActorContext(vault.vaultGeneration, principal, membership, device) });
		});
	}

	private async authorizeOutcome(body: Record<string, unknown>): Promise<Response> {
		if (!isHash(body.tokenHash) || !isId(body.vaultId)) return json({ error: "unauthorized" }, 401);
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const device = await deviceRecord(txn, { tokenHash: body.tokenHash as string }, body.vaultId as string);
				if (!device?.principalId) return json({ error: "unauthorized" }, 401);
				const [principal, membership, vault] = await Promise.all([
					principalRecord(txn, device.vaultId, device.principalId),
					membershipRecord(txn, device.vaultId, device.principalId),
					vaultRecord(txn, device.vaultId),
				]);
				if (!principal || !membership || vault?.state !== "active") return json({ error: "unauthorized" }, 401);
				return json({ ok: true, device: toDevicePublic(device), principal, membership,
					actor: await buildActorContext(vault.vaultGeneration, principal, membership, device) });
			}
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const state = await readState(txn);
			const device = findHashedRecord(state.devices, body.tokenHash as string, (record) => record.tokenHash);
			if (!device || device.vaultId !== body.vaultId || !device.principalId) return json({ error: "unauthorized" }, 401);
			const principal = state.principals.find((record) => record.principalId === device.principalId && record.vaultId === device.vaultId);
			const membership = state.memberships.find((record) => record.principalId === device.principalId && record.vaultId === device.vaultId);
			const vault = vaults.find((record) => record.vaultId === device.vaultId && record.state === "active");
			if (!principal || !membership || !vault) return json({ error: "unauthorized" }, 401);
			return json({ ok: true, device: toDevicePublic(device), principal, membership,
				actor: await buildActorContext(vault.vaultGeneration, principal, membership, device) });
		});
	}

	private async verifyActor(body: Record<string, unknown>): Promise<Response> {
		if (!isId(body.vaultId) || !isId(body.principalId) || !isId(body.deviceId)) return json({ error: "unauthorized" }, 401);
		return this.storage.transaction(async (txn) => {
			const state = await readVaultState(txn, body.vaultId as string);
			const resolved = resolveActor(state, body);
			const vault = await vaultRecord(txn, body.vaultId as string);
			if (!resolved || vault?.state !== "active"
			|| vault.vaultGeneration !== body.vaultGeneration
			|| resolved.membership.revision !== body.membershipRevision
			|| (resolved.device.credentialRevision ?? 1) !== body.deviceCredentialRevision
			|| resolved.membership.role !== body.role
			|| body.policyVersion !== COLLABORATION_POLICY_VERSION
			|| body.capabilityDigest !== await capabilityDigestForRole(resolved.membership.role)) {
				return json({ error: "authority_superseded" }, 401);
			}
			return json({ ok: true, actor: await buildActorContext(vault.vaultGeneration, resolved.principal, resolved.membership, resolved.device) });
		});
	}

	private async withActor<T>(body: Record<string, unknown>, fn: (txn: ControlPlaneTransactionPort, state: CollaborationState, actor: NonNullable<ReturnType<typeof resolveActor>>) => Promise<T>): Promise<T | Response> {
		return this.storage.transaction(async (txn) => {
			const state = isId(body.vaultId) ? await readVaultState(txn, body.vaultId) : await readState(txn);
			const actor = resolveActor(state, body);
			if (!actor) return json({ error: "unauthorized" }, 401);
			return fn(txn, state, actor);
		});
	}

	private me(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, _state, actor) => {
			const vault = await vaultRecord(txn, actor.principal.vaultId);
			if (!vault) return json({ error: "unknown_vault" }, 404);
			const now = Date.now();
			const transferRaw = txn.records
				? await txn.records.list(OWNERSHIP_TRANSFERS_KEY, {
					vaultId: actor.principal.vaultId, state: "offered", expiresAfter: now,
					limit: MAX_OWNERSHIP_TRANSFERS,
				})
				: await txn.get(OWNERSHIP_TRANSFERS_KEY);
			const ownershipTransfers = parseOwnershipTransferRecords(transferRaw)
				.filter((transfer) => transfer.vaultId === actor.principal.vaultId
					&& transfer.state === "offered" && transfer.expiresAt > now
					&& (transfer.fromPrincipalId === actor.principal.principalId
						|| transfer.toPrincipalId === actor.principal.principalId))
				.map((transfer) => ({
					transferId: transfer.transferId,
					fromPrincipalId: transfer.fromPrincipalId,
					toPrincipalId: transfer.toPrincipalId,
					createdAt: transfer.createdAt,
					expiresAt: transfer.expiresAt,
				}));
			return json({
				principal: publicPrincipal(actor.principal, actor.membership),
				device: toDevicePublic(actor.device),
				capabilities: capabilitiesForRole(actor.membership.role),
				actor: await buildActorContext(vault.vaultGeneration, actor.principal, actor.membership, actor.device),
				ownershipTransfers,
			});
		});
	}

	private members(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (_txn, state, actor) => {
			const denied = requireCapability(actor, "vault.members.read");
			if (denied) return denied;
			return json({ members: state.memberships.filter((membership) => membership.vaultId === actor.principal.vaultId && membership.state !== "revoked").map((membership) => {
				const principal = state.principals.find((record) => record.principalId === membership.principalId)!;
				const devices = state.devices.filter((record) => record.principalId === membership.principalId && record.state !== "revoked");
				return {
					...publicPrincipal(principal, membership),
					deviceCount: devices.length,
					lastSeenAt: devices.reduce<number | null>((latest, device) => device.lastSeenAt === undefined ? latest : Math.max(latest ?? 0, device.lastSeenAt), null),
				};
			}) });
		});
	}

	private audit(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, _state, actor) => {
			const denied = requireCapability(actor, "vault.audit.read");
			if (denied) return denied;
			return json({ events: await recentAuditEvents(txn, actor.principal.vaultId) });
		});
	}

	private codes(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, _state, actor) => {
			const codes = txn.records
				? parseCollaborationCodeRecords(await txn.records.list(COLLABORATION_CODES_KEY, {
					vaultId: actor.principal.vaultId, consumed: false, expiresAfter: Date.now(),
					limit: MAX_COLLABORATION_CODES,
				}))
				: parseCollaborationCodeRecords(await txn.get(COLLABORATION_CODES_KEY));
			const visible = codes.filter((record) => record.vaultId === actor.principal.vaultId && record.consumedAt === null && record.expiresAt > Date.now() && (
				(record.purpose === "member-invitation" && actor.membership.role === "owner")
				|| (record.purpose === "device-link" && record.principalId === actor.principal.principalId)
			));
			return json({ codes: visible.map(({ codeHash: _codeHash, ...record }) => record) });
		});
	}

	private devices(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (_txn, state, actor) => {
			if (!isId(body.targetPrincipalId)) return json({ error: "invalid principalId" }, 400);
			const own = body.targetPrincipalId === actor.principal.principalId;
			const denied = requireCapability(actor, own ? "vault.devices.manage_self" : "vault.devices.manage_all", actor.principal.principalId);
			if (denied) return denied;
			return json({ devices: state.devices.filter((record) => record.vaultId === actor.principal.vaultId && record.principalId === body.targetPrincipalId && record.state !== "revoked").map(toDevicePublic) });
		});
	}

	private createCode(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, _state, actor) => {
			if (!isHash(body.codeHash) || (body.purpose !== "member-invitation" && body.purpose !== "device-link")) return json({ error: "invalid code" }, 400);
			const purpose = body.purpose as CollaborationCodePurpose;
			const denied = requireCapability(actor, purpose === "member-invitation" ? "vault.members.invite" : "vault.devices.manage_self", actor.principal.principalId);
			if (denied) return denied;
			const now = Date.now();
			if (txn.records) {
				const existingRaw = await txn.records.get(COLLABORATION_CODES_KEY, { codeHash: body.codeHash });
				const existing = existingRaw ? parseCollaborationCodeRecords([existingRaw])[0] : undefined;
				if (existing && existing.expiresAt > now && existing.consumedAt === null) return json({ error: "code_exists" }, 409);
				await txn.records.deleteWhere(COLLABORATION_CODES_KEY, { expiresAtOrBefore: now, consumed: false });
				await txn.records.deleteWhere(COLLABORATION_CODES_KEY, { consumed: true });
				if (await txn.records.count(COLLABORATION_CODES_KEY) >= MAX_COLLABORATION_CODES) return json({ error: "code_capacity" }, 503);
				const code: CollaborationCodeRecord = {
					codeId: randomBase64Url(16), codeHash: body.codeHash, purpose, vaultId: actor.principal.vaultId,
					principalId: purpose === "device-link" ? actor.principal.principalId : null,
					issuerPrincipalId: actor.principal.principalId, issuerMembershipRevision: actor.membership.revision,
					creatorDeviceId: actor.device.deviceId, creatorDeviceCredentialRevision: actor.device.credentialRevision ?? 1,
					expiresAt: now + COLLABORATION_CODE_TTL_MS, createdAt: now, consumedAt: null,
				};
				await txn.records.upsert(COLLABORATION_CODES_KEY, code);
				return json({ code: { ...code, codeHash: undefined } });
			}
			const codes = parseCollaborationCodeRecords(await txn.get(COLLABORATION_CODES_KEY)).filter((record) => record.expiresAt > now && record.consumedAt === null);
			if (codes.length >= MAX_COLLABORATION_CODES) return json({ error: "code_capacity" }, 503);
			if (codes.some((record) => record.codeHash === body.codeHash)) return json({ error: "code_exists" }, 409);
			const code: CollaborationCodeRecord = {
				codeId: randomBase64Url(16), codeHash: body.codeHash, purpose, vaultId: actor.principal.vaultId,
				principalId: purpose === "device-link" ? actor.principal.principalId : null,
				issuerPrincipalId: actor.principal.principalId, issuerMembershipRevision: actor.membership.revision,
				creatorDeviceId: actor.device.deviceId, creatorDeviceCredentialRevision: actor.device.credentialRevision ?? 1,
				expiresAt: now + COLLABORATION_CODE_TTL_MS, createdAt: now, consumedAt: null,
			};
			codes.push(code);
			await txn.put(COLLABORATION_CODES_KEY, codes);
			return json({ code: { ...code, codeHash: undefined } });
		});
	}

	private revokeCode(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, _state, actor) => {
			if (!isId(body.codeId)) return json({ error: "invalid codeId" }, 400);
			const codes = txn.records ? [] : parseCollaborationCodeRecords(await txn.get(COLLABORATION_CODES_KEY));
			const code = txn.records
				? await oneRecord(txn, COLLABORATION_CODES_KEY, { recordKey: body.codeId }, parseCollaborationCodeRecords)
				: codes.find((record) => record.codeId === body.codeId && record.vaultId === actor.principal.vaultId);
			if (!code) return json({ error: "unknown_code" }, 404);
			if (code.vaultId !== actor.principal.vaultId) return json({ error: "unknown_code" }, 404);
			const capability = code.purpose === "device-link" && code.principalId === actor.principal.principalId ? "vault.devices.manage_self" : "vault.members.invite";
			const denied = requireCapability(actor, capability, actor.principal.principalId);
			if (denied) return denied;
			if (txn.records) await txn.records.delete(COLLABORATION_CODES_KEY, code.codeId);
			else await txn.put(COLLABORATION_CODES_KEY, codes.filter((record) => record !== code));
			return json({ ok: true });
		});
	}

	private renamePrincipal(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, state, actor) => {
			const denied = requireCapability(actor, "vault.profile.manage_self",
				typeof body.targetPrincipalId === "string" ? body.targetPrincipalId : "");
			if (denied) return denied;
			const name = boundedName(body.displayName, "");
			if (!name || !isRequestId(body.requestId)) return json({ error: "invalid request" }, 400);
			if (!await authorizationChangesForAdmission(txn, Date.now())) return json({ error: "authorization_change_capacity" }, 503);
			const previousRevision = actor.membership.revision;
			actor.principal.displayName = name;
			actor.principal.updatedAt = Date.now();
			actor.membership.revision++;
			actor.membership.state = "changing";
			actor.membership.updatedAt = Date.now();
			if (txn.records) {
				await txn.records.upsert(PRINCIPALS_KEY, actor.principal);
				await txn.records.upsert(MEMBERSHIPS_KEY, actor.membership);
			} else {
				await persistRecords(txn, PRINCIPALS_KEY, state.principals);
				await persistRecords(txn, MEMBERSHIPS_KEY, state.memberships);
			}
			const vault = await vaultRecord(txn, actor.principal.vaultId);
			if (!vault) return json({ error: "unknown_vault" }, 404);
			const now = Date.now();
			return this.startChange(txn, { changeId: randomBase64Url(16), vaultId: vault.vaultId, vaultGeneration: vault.vaultGeneration, kind: "profile-update", requestedByPrincipalId: actor.principal.principalId, requestId: body.requestId, requestDigest: await requestDigest({ displayName: name }), subjects: [{ kind: "membership", principalId: actor.principal.principalId, deviceId: null, previousRevision, targetRevision: actor.membership.revision, targetRole: actor.membership.role, targetState: "active", displayName: actor.principal.displayName, colorSeed: actor.principal.colorSeed }], state: "pending", createdAt: now, completedAt: null, lastError: null }, { vaultId: vault.vaultId, kind: "principal_renamed", actorPrincipalId: actor.principal.principalId, actorDeviceId: actor.device.deviceId, targetPrincipalId: actor.principal.principalId, targetDeviceId: null, detail: null }, now);
		});
	}

	private renameVault(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, _state, actor) => {
			const denied = requireCapability(actor, "vault.metadata.rename");
			if (denied) return denied;
			const name = boundedName(body.name, "");
			if (!name || !isRequestId(body.requestId)) return json({ error: "invalid request" }, 400);
			const digest = await requestDigest({ name });
			if (txn.records) {
				const replay = await oneRecord(txn, VAULT_GOVERNANCE_REQUESTS_KEY, {
					vaultId: actor.principal.vaultId, requestId: body.requestId,
				}, parseVaultGovernanceRequestRecords);
				if (replay) return replay.requestDigest === digest && replay.kind === "vault-rename"
					? json({ ok: true, governanceRequest: replay, replayed: true })
					: json({ error: "request_conflict" }, 409);
				const now = Date.now();
				if (!await governanceAdmissionAvailable(txn, now)) return json({ error: "governance_request_capacity" }, 503);
				const vault = await vaultRecord(txn, actor.principal.vaultId);
				if (vault?.state !== "active") return json({ error: "unknown_vault" }, 404);
				vault.name = name;
				const governanceRequest: VaultGovernanceRequestRecord = {
					governanceRequestId: randomBase64Url(16), requestId: body.requestId, requestDigest: digest,
					vaultId: vault.vaultId, vaultGeneration: vault.vaultGeneration, kind: "vault-rename", state: "complete",
					requestedByPrincipalId: actor.principal.principalId, requestedByDeviceId: actor.device.deviceId,
					requestedByMembershipRevision: actor.membership.revision, requestedName: name, emergencyReason: null,
					createdAt: now, confirmedAt: now, completedAt: now, lastError: null,
				};
				await appendAudit(txn, { vaultId: vault.vaultId, kind: "vault_renamed", actorPrincipalId: actor.principal.principalId, actorDeviceId: actor.device.deviceId, targetPrincipalId: null, targetDeviceId: null, detail: name }, now);
				await txn.records.upsert(VAULTS_KEY, vault);
				await txn.records.upsert(VAULT_GOVERNANCE_REQUESTS_KEY, governanceRequest);
				return json({ ok: true, vault, governanceRequest });
			}
			const storedRequests = parseVaultGovernanceRequestRecords(await txn.get(VAULT_GOVERNANCE_REQUESTS_KEY));
			const replay = storedRequests.find((record) => record.vaultId === actor.principal.vaultId && record.requestId === body.requestId);
			if (replay) return replay.requestDigest === digest && replay.kind === "vault-rename"
				? json({ ok: true, governanceRequest: replay, replayed: true })
				: json({ error: "request_conflict" }, 409);
			const now = Date.now();
			const requests = retainGovernanceRequests(storedRequests, now);
			if (requests.length !== storedRequests.length) await txn.put(VAULT_GOVERNANCE_REQUESTS_KEY, requests);
			if (requests.length >= MAX_VAULT_GOVERNANCE_REQUESTS) return json({ error: "governance_request_capacity" }, 503);
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const vault = vaults.find((record) => record.vaultId === actor.principal.vaultId && record.state === "active");
			if (!vault) return json({ error: "unknown_vault" }, 404);
			vault.name = name;
			const governanceRequest: VaultGovernanceRequestRecord = {
				governanceRequestId: randomBase64Url(16), requestId: body.requestId, requestDigest: digest,
				vaultId: vault.vaultId, vaultGeneration: vault.vaultGeneration, kind: "vault-rename", state: "complete",
				requestedByPrincipalId: actor.principal.principalId, requestedByDeviceId: actor.device.deviceId,
				requestedByMembershipRevision: actor.membership.revision, requestedName: name, emergencyReason: null,
				createdAt: now, confirmedAt: now, completedAt: now, lastError: null,
			};
			requests.push(governanceRequest);
			await appendAudit(txn, { vaultId: vault.vaultId, kind: "vault_renamed", actorPrincipalId: actor.principal.principalId, actorDeviceId: actor.device.deviceId, targetPrincipalId: null, targetDeviceId: null, detail: name }, now);
			await txn.put(VAULTS_KEY, vaults);
			await txn.put(VAULT_GOVERNANCE_REQUESTS_KEY, requests);
			return json({ ok: true, vault, governanceRequest });
		});
	}

	private requestDestroy(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, _state, actor) => {
			const denied = requireCapability(actor, "vault.destroy.request");
			if (denied) return denied;
			if (!isRequestId(body.requestId)) return json({ error: "invalid request" }, 400);
			const digest = await requestDigest({ kind: "vault-destroy" });
			if (txn.records) {
				const replay = await oneRecord(txn, VAULT_GOVERNANCE_REQUESTS_KEY, {
					vaultId: actor.principal.vaultId, requestId: body.requestId,
				}, parseVaultGovernanceRequestRecords);
				if (replay) return replay.requestDigest === digest && replay.kind === "vault-destroy"
					? json({ ok: true, governanceRequest: replay, replayed: true })
					: json({ error: "request_conflict" }, 409);
				const pending = await pendingDestroyGovernance(txn, actor.principal.vaultId);
				if (pending) return json({ error: "destroy_request_pending", governanceRequest: pending }, 409);
				const now = Date.now();
				if (!await governanceAdmissionAvailable(txn, now)) return json({ error: "governance_request_capacity" }, 503);
				const vault = await vaultRecord(txn, actor.principal.vaultId);
				if (vault?.state !== "active") return json({ error: "unknown_vault" }, 404);
				const governanceRequest: VaultGovernanceRequestRecord = {
					governanceRequestId: randomBase64Url(16), requestId: body.requestId, requestDigest: digest,
					vaultId: vault.vaultId, vaultGeneration: vault.vaultGeneration, kind: "vault-destroy", state: "awaiting-operator-confirmation",
					requestedByPrincipalId: actor.principal.principalId, requestedByDeviceId: actor.device.deviceId,
					requestedByMembershipRevision: actor.membership.revision, requestedName: null, emergencyReason: null,
					createdAt: now, confirmedAt: null, completedAt: null, lastError: null,
				};
				await appendAudit(txn, { vaultId: vault.vaultId, kind: "vault_destruction_requested", actorPrincipalId: actor.principal.principalId, actorDeviceId: actor.device.deviceId, targetPrincipalId: null, targetDeviceId: null, detail: governanceRequest.governanceRequestId }, now);
				await txn.records.upsert(VAULT_GOVERNANCE_REQUESTS_KEY, governanceRequest);
				return json({ ok: true, governanceRequest }, 202);
			}
			const storedRequests = parseVaultGovernanceRequestRecords(await txn.get(VAULT_GOVERNANCE_REQUESTS_KEY));
			const replay = storedRequests.find((record) => record.vaultId === actor.principal.vaultId && record.requestId === body.requestId);
			if (replay) return replay.requestDigest === digest && replay.kind === "vault-destroy"
				? json({ ok: true, governanceRequest: replay, replayed: true })
				: json({ error: "request_conflict" }, 409);
			const pending = storedRequests.find((record) => record.vaultId === actor.principal.vaultId && record.kind !== "vault-rename"
				&& record.state !== "complete" && record.state !== "failed");
			if (pending) return json({ error: "destroy_request_pending", governanceRequest: pending }, 409);
			const now = Date.now();
			const requests = retainGovernanceRequests(storedRequests, now);
			if (requests.length !== storedRequests.length) await txn.put(VAULT_GOVERNANCE_REQUESTS_KEY, requests);
			if (requests.length >= MAX_VAULT_GOVERNANCE_REQUESTS) return json({ error: "governance_request_capacity" }, 503);
			const vault = parseVaultRecords(await txn.get(VAULTS_KEY)).find((record) => record.vaultId === actor.principal.vaultId && record.state === "active");
			if (!vault) return json({ error: "unknown_vault" }, 404);
			const governanceRequest: VaultGovernanceRequestRecord = {
				governanceRequestId: randomBase64Url(16), requestId: body.requestId, requestDigest: digest,
				vaultId: vault.vaultId, vaultGeneration: vault.vaultGeneration, kind: "vault-destroy", state: "awaiting-operator-confirmation",
				requestedByPrincipalId: actor.principal.principalId, requestedByDeviceId: actor.device.deviceId,
				requestedByMembershipRevision: actor.membership.revision, requestedName: null, emergencyReason: null,
				createdAt: now, confirmedAt: null, completedAt: null, lastError: null,
			};
			requests.push(governanceRequest);
			await appendAudit(txn, { vaultId: vault.vaultId, kind: "vault_destruction_requested", actorPrincipalId: actor.principal.principalId, actorDeviceId: actor.device.deviceId, targetPrincipalId: null, targetDeviceId: null, detail: governanceRequest.governanceRequestId }, now);
			await txn.put(VAULT_GOVERNANCE_REQUESTS_KEY, requests);
			return json({ ok: true, governanceRequest }, 202);
		});
	}

	private async operatorConfirmDestroy(body: Record<string, unknown>): Promise<Response> {
		if (!isId(body.vaultId) || !isId(body.governanceRequestId)) return json({ error: "invalid request" }, 400);
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const record = await oneRecord(txn, VAULT_GOVERNANCE_REQUESTS_KEY, { recordKey: body.governanceRequestId as string }, parseVaultGovernanceRequestRecords);
				if (!record || record.vaultId !== body.vaultId || record.kind === "vault-rename") return json({ error: "destroy_request_missing" }, 404);
				if (record.state === "complete" || record.state === "confirmed" || record.state === "executing") return json({ ok: true, governanceRequest: record, replayed: true });
				if (record.state !== "awaiting-operator-confirmation") return json({ error: "destroy_request_not_confirmable" }, 409);
				const vault = await vaultRecord(txn, record.vaultId);
				if (!vault || vault.vaultGeneration !== record.vaultGeneration) return json({ error: "unknown_vault" }, 404);
				const membership = record.requestedByPrincipalId
					? await membershipRecord(txn, record.vaultId, record.requestedByPrincipalId) : undefined;
				if (!membership || membership.role !== "owner" || membership.state !== "active" || membership.revision !== record.requestedByMembershipRevision) {
					return json({ error: "authority_superseded" }, 409);
				}
				record.state = "confirmed";
				record.confirmedAt = Date.now();
				await appendAudit(txn, { vaultId: record.vaultId, kind: "vault_destruction_confirmed", actorPrincipalId: null, actorDeviceId: null, targetPrincipalId: record.requestedByPrincipalId, targetDeviceId: null, detail: record.governanceRequestId }, record.confirmedAt);
				await txn.records.upsert(VAULT_GOVERNANCE_REQUESTS_KEY, record);
				return json({ ok: true, governanceRequest: record });
			}
			const requests = parseVaultGovernanceRequestRecords(await txn.get(VAULT_GOVERNANCE_REQUESTS_KEY));
			const record = requests.find((item) => item.vaultId === body.vaultId && item.governanceRequestId === body.governanceRequestId && item.kind !== "vault-rename");
			if (!record) return json({ error: "destroy_request_missing" }, 404);
			if (record.state === "complete" || record.state === "confirmed" || record.state === "executing") return json({ ok: true, governanceRequest: record, replayed: true });
			if (record.state !== "awaiting-operator-confirmation") return json({ error: "destroy_request_not_confirmable" }, 409);
			const vault = parseVaultRecords(await txn.get(VAULTS_KEY)).find((item) => item.vaultId === record.vaultId && item.vaultGeneration === record.vaultGeneration);
			if (!vault) return json({ error: "unknown_vault" }, 404);
			const state = await readState(txn);
			const membership = state.memberships.find((item) => item.vaultId === record.vaultId && item.principalId === record.requestedByPrincipalId);
			if (!membership || membership.role !== "owner" || membership.state !== "active" || membership.revision !== record.requestedByMembershipRevision) {
				return json({ error: "authority_superseded" }, 409);
			}
			record.state = "confirmed";
			record.confirmedAt = Date.now();
			await appendAudit(txn, { vaultId: record.vaultId, kind: "vault_destruction_confirmed", actorPrincipalId: null, actorDeviceId: null, targetPrincipalId: record.requestedByPrincipalId, targetDeviceId: null, detail: record.governanceRequestId }, record.confirmedAt);
			await txn.put(VAULT_GOVERNANCE_REQUESTS_KEY, requests);
			return json({ ok: true, governanceRequest: record });
		});
	}

	private async operatorEmergencyDestroy(body: Record<string, unknown>): Promise<Response> {
		if (!isId(body.vaultId) || !isRequestId(body.requestId) || typeof body.reason !== "string" || body.reason.trim().length < 8) return json({ error: "invalid emergency destroy request" }, 400);
		const requestId = body.requestId;
		const reason = body.reason.trim().slice(0, 512);
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const digest = await requestDigest({ reason });
				const replay = await oneRecord(txn, VAULT_GOVERNANCE_REQUESTS_KEY, {
					vaultId: body.vaultId as string, requestId,
				}, parseVaultGovernanceRequestRecords);
				if (replay) return replay.kind === "emergency-vault-destroy" && replay.requestDigest === digest
					? json({ ok: true, governanceRequest: replay, replayed: true }) : json({ error: "request_conflict" }, 409);
				const pending = await pendingDestroyGovernance(txn, body.vaultId as string);
				if (pending) return json({ error: "destroy_request_pending", governanceRequest: pending }, 409);
				const now = Date.now();
				if (!await governanceAdmissionAvailable(txn, now)) return json({ error: "governance_request_capacity" }, 503);
				const vault = await vaultRecord(txn, body.vaultId as string);
				if (!vault) return json({ error: "unknown_vault" }, 404);
				const governanceRequest: VaultGovernanceRequestRecord = {
					governanceRequestId: randomBase64Url(16), requestId, requestDigest: digest,
					vaultId: vault.vaultId, vaultGeneration: vault.vaultGeneration, kind: "emergency-vault-destroy", state: "confirmed",
					requestedByPrincipalId: null, requestedByDeviceId: null, requestedByMembershipRevision: null,
					requestedName: null, emergencyReason: reason, createdAt: now, confirmedAt: now, completedAt: null, lastError: null,
				};
				await appendAudit(txn, { vaultId: vault.vaultId, kind: "emergency_vault_destruction_confirmed", actorPrincipalId: null, actorDeviceId: null, targetPrincipalId: vault.ownerPrincipalId ?? null, targetDeviceId: null, detail: reason }, now);
				await txn.records.upsert(VAULT_GOVERNANCE_REQUESTS_KEY, governanceRequest);
				return json({ ok: true, governanceRequest });
			}
			const storedRequests = parseVaultGovernanceRequestRecords(await txn.get(VAULT_GOVERNANCE_REQUESTS_KEY));
			const digest = await requestDigest({ reason });
			const replay = storedRequests.find((record) => record.vaultId === body.vaultId && record.requestId === body.requestId);
			if (replay) return replay.kind === "emergency-vault-destroy" && replay.requestDigest === digest
				? json({ ok: true, governanceRequest: replay, replayed: true }) : json({ error: "request_conflict" }, 409);
			const pending = storedRequests.find((record) => record.vaultId === body.vaultId && record.kind !== "vault-rename"
				&& record.state !== "complete" && record.state !== "failed");
			if (pending) return json({ error: "destroy_request_pending", governanceRequest: pending }, 409);
			const now = Date.now();
			const requests = retainGovernanceRequests(storedRequests, now);
			if (requests.length !== storedRequests.length) await txn.put(VAULT_GOVERNANCE_REQUESTS_KEY, requests);
			if (requests.length >= MAX_VAULT_GOVERNANCE_REQUESTS) return json({ error: "governance_request_capacity" }, 503);
			const vault = parseVaultRecords(await txn.get(VAULTS_KEY)).find((record) => record.vaultId === body.vaultId);
			if (!vault) return json({ error: "unknown_vault" }, 404);
			const governanceRequest: VaultGovernanceRequestRecord = {
				governanceRequestId: randomBase64Url(16), requestId, requestDigest: digest,
				vaultId: vault.vaultId, vaultGeneration: vault.vaultGeneration, kind: "emergency-vault-destroy", state: "confirmed",
				requestedByPrincipalId: null, requestedByDeviceId: null, requestedByMembershipRevision: null,
				requestedName: null, emergencyReason: reason, createdAt: now, confirmedAt: now, completedAt: null, lastError: null,
			};
			requests.push(governanceRequest);
			await appendAudit(txn, { vaultId: vault.vaultId, kind: "emergency_vault_destruction_confirmed", actorPrincipalId: null, actorDeviceId: null, targetPrincipalId: vault.ownerPrincipalId ?? null, targetDeviceId: null, detail: reason }, now);
			await txn.put(VAULT_GOVERNANCE_REQUESTS_KEY, requests);
			return json({ ok: true, governanceRequest });
		});
	}

	private async updateDestroy(body: Record<string, unknown>): Promise<Response> {
		if (!isId(body.vaultId) || !isId(body.governanceRequestId)
			|| (body.state !== "executing" && body.state !== "complete" && body.state !== "failed")) return json({ error: "invalid request" }, 400);
		const nextState = body.state;
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const record = await oneRecord(txn, VAULT_GOVERNANCE_REQUESTS_KEY, { recordKey: body.governanceRequestId as string }, parseVaultGovernanceRequestRecords);
				if (!record || record.vaultId !== body.vaultId || record.kind === "vault-rename") return json({ error: "destroy_request_missing" }, 404);
				if (body.state === "executing" && record.state !== "confirmed" && record.state !== "executing") return json({ error: "destroy_request_not_confirmed" }, 409);
				if (body.state === "complete" && record.state !== "executing" && record.state !== "complete") return json({ error: "destroy_request_not_executing" }, 409);
				record.state = nextState;
				record.completedAt = nextState === "complete" ? Date.now() : null;
				record.lastError = nextState === "failed" && typeof body.lastError === "string" ? body.lastError.slice(0, 512) : null;
				await txn.records.upsert(VAULT_GOVERNANCE_REQUESTS_KEY, record);
				return json({ ok: true, governanceRequest: record });
			}
			const requests = parseVaultGovernanceRequestRecords(await txn.get(VAULT_GOVERNANCE_REQUESTS_KEY));
			const record = requests.find((item) => item.vaultId === body.vaultId && item.governanceRequestId === body.governanceRequestId && item.kind !== "vault-rename");
			if (!record) return json({ error: "destroy_request_missing" }, 404);
			if (body.state === "executing" && record.state !== "confirmed" && record.state !== "executing") return json({ error: "destroy_request_not_confirmed" }, 409);
			if (body.state === "complete" && record.state !== "executing" && record.state !== "complete") return json({ error: "destroy_request_not_executing" }, 409);
			record.state = nextState;
			record.completedAt = nextState === "complete" ? Date.now() : null;
			record.lastError = nextState === "failed" && typeof body.lastError === "string" ? body.lastError.slice(0, 512) : null;
			await txn.put(VAULT_GOVERNANCE_REQUESTS_KEY, requests);
			return json({ ok: true, governanceRequest: record });
		});
	}

	private renameDevice(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, state, actor) => {
			if (!isId(body.targetDeviceId)) return json({ error: "invalid deviceId" }, 400);
			const target = state.devices.find((record) => record.deviceId === body.targetDeviceId && record.vaultId === actor.principal.vaultId);
			if (!target) return json({ error: "unknown_device" }, 404);
			const own = target.principalId === actor.principal.principalId;
			const denied = requireCapability(actor, own ? "vault.devices.manage_self" : "vault.devices.manage_all", actor.principal.principalId);
			if (denied) return denied;
			const name = boundedName(body.name, "");
			if (!name) return json({ error: "invalid name" }, 400);
			target.name = name;
			if (txn.records) await txn.records.upsert(DEVICES_KEY, target);
			else await persistRecords(txn, DEVICES_KEY, state.devices);
			return json({ device: toDevicePublic(target) });
		});
	}

	private async startChange(
		txn: ControlPlaneTransactionPort,
		input: Omit<AuthorizationChangeRecord, "subjectDigest">,
		audit: AuditInput,
		auditCreatedAt: number,
	): Promise<Response> {
		if (txn.records) {
			const change: AuthorizationChangeRecord = { ...input, subjectDigest: await requestDigest(input.subjects) };
			const existingRaw = await txn.records.get(AUTHORIZATION_CHANGES_KEY, {
				vaultId: change.vaultId, requestId: change.requestId,
			});
			const existing = existingRaw ? parseAuthorizationChangeRecords([existingRaw])[0] : undefined;
			if (existing) return existing.requestDigest === change.requestDigest
				? json({ change: existing }, 202) : json({ error: "request_conflict" }, 409);
			if (!await authorizationChangesForAdmission(txn, Date.now())) return json({ error: "authorization_change_capacity" }, 503);
			await txn.records.upsert(AUTHORIZATION_CHANGES_KEY, change);
			await appendAudit(txn, audit, auditCreatedAt);
			return json({ change }, 202);
		}
		const storedChanges = parseAuthorizationChangeRecords(await txn.get(AUTHORIZATION_CHANGES_KEY));
		const change: AuthorizationChangeRecord = {
			...input,
			subjectDigest: await requestDigest(input.subjects),
		};
		const existing = storedChanges.find((record) => record.vaultId === change.vaultId && record.requestId === change.requestId);
		if (existing) return existing.requestDigest === change.requestDigest ? json({ change: existing }, 202) : json({ error: "request_conflict" }, 409);
		const changes = retainAuthorizationChanges(storedChanges, Date.now());
		if (changes.length !== storedChanges.length) await txn.put(AUTHORIZATION_CHANGES_KEY, changes);
		if (changes.length >= MAX_AUTHORIZATION_CHANGES) return json({ error: "authorization_change_capacity" }, 503);
		changes.push(change);
		await txn.put(AUTHORIZATION_CHANGES_KEY, changes);
		await appendAudit(txn, audit, auditCreatedAt);
		return json({ change }, 202);
	}

	private revokeDevice(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, state, actor) => {
			if (!isId(body.targetDeviceId) || !isRequestId(body.requestId)) return json({ error: "invalid request" }, 400);
			const target = state.devices.find((record) => record.deviceId === body.targetDeviceId && record.vaultId === actor.principal.vaultId && record.state === "active");
			if (!target || !target.principalId) return json({ error: "unknown_device" }, 404);
			const membership = state.memberships.find((record) => record.principalId === target.principalId && record.vaultId === target.vaultId)!;
			const own = target.principalId === actor.principal.principalId;
			const denied = requireCapability(actor, own ? "vault.devices.manage_self" : "vault.devices.manage_all", actor.principal.principalId);
			if (denied) return denied;
			const activeDevices = state.devices.filter((record) => record.principalId === target.principalId && record.state === "active");
			if (activeDevices.length === 1) {
				if (membership.role === "owner") return json({ error: "owner_invariant" }, 409);
				return this.beginMembershipRevocation(txn, state, actor, membership, body.requestId, own ? "leave" : "member_removed");
			}
			if (!await authorizationChangesForAdmission(txn, Date.now())) return json({ error: "authorization_change_capacity" }, 503);
			const previousRevision = target.credentialRevision ?? 1;
			target.credentialRevision = previousRevision + 1;
			target.state = "revoking";
			if (txn.records) await txn.records.upsert(DEVICES_KEY, target);
			else await persistRecords(txn, DEVICES_KEY, state.devices);
			const vault = await vaultRecord(txn, target.vaultId);
			if (!vault) return json({ error: "unknown_vault" }, 404);
			const digest = await requestDigest({ targetDeviceId: target.deviceId });
			const now = Date.now();
			return this.startChange(txn, { changeId: randomBase64Url(16), vaultId: target.vaultId, vaultGeneration: vault.vaultGeneration, kind: "device-revocation", requestedByPrincipalId: actor.principal.principalId, requestId: body.requestId, requestDigest: digest, subjects: [{ kind: "device", principalId: target.principalId, deviceId: target.deviceId, previousRevision, targetRevision: previousRevision + 1, targetRole: null, targetState: "revoked" }], state: "pending", createdAt: now, completedAt: null, lastError: null }, { vaultId: target.vaultId, kind: "device_revocation_requested", actorPrincipalId: actor.principal.principalId, actorDeviceId: actor.device.deviceId, targetPrincipalId: target.principalId, targetDeviceId: target.deviceId, detail: null }, now);
		});
	}

	private async beginMembershipRevocation(txn: ControlPlaneTransactionPort, state: CollaborationState, actor: NonNullable<ReturnType<typeof resolveActor>>, membership: VaultMembershipRecord, requestId: string, auditKind: string): Promise<Response> {
		if (!await authorizationChangesForAdmission(txn, Date.now())) return json({ error: "authorization_change_capacity" }, 503);
		const previousRevision = membership.revision;
		membership.revision++;
		membership.state = "revoking";
		membership.updatedAt = Date.now();
		const subjects: AuthorizationChangeRecord["subjects"] = [{ kind: "membership", principalId: membership.principalId, deviceId: null, previousRevision, targetRevision: membership.revision, targetRole: membership.role, targetState: "revoked" }];
		for (const device of state.devices.filter((record) => record.principalId === membership.principalId && record.state === "active")) {
			const deviceRevision = device.credentialRevision ?? 1;
			device.credentialRevision = deviceRevision + 1;
			device.state = "revoking";
			subjects.push({ kind: "device", principalId: membership.principalId, deviceId: device.deviceId, previousRevision: deviceRevision, targetRevision: deviceRevision + 1, targetRole: null, targetState: "revoked" });
		}
		if (txn.records) {
			await txn.records.upsert(MEMBERSHIPS_KEY, membership);
			for (const device of state.devices.filter((record) => record.principalId === membership.principalId && record.state === "revoking")) {
				await txn.records.upsert(DEVICES_KEY, device);
			}
		} else {
			await persistRecords(txn, MEMBERSHIPS_KEY, state.memberships);
			await persistRecords(txn, DEVICES_KEY, state.devices);
		}
		const vault = await vaultRecord(txn, membership.vaultId);
		if (!vault) return json({ error: "unknown_vault" }, 404);
		const now = Date.now();
		return this.startChange(txn, { changeId: randomBase64Url(16), vaultId: membership.vaultId, vaultGeneration: vault.vaultGeneration, kind: "membership-revocation", requestedByPrincipalId: actor.principal.principalId, requestId, requestDigest: await requestDigest({ targetPrincipalId: membership.principalId }), subjects, state: "pending", createdAt: now, completedAt: null, lastError: null }, { vaultId: membership.vaultId, kind: auditKind, actorPrincipalId: actor.principal.principalId, actorDeviceId: actor.device.deviceId, targetPrincipalId: membership.principalId, targetDeviceId: null, detail: null }, now);
	}

	private revokeMember(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, state, actor) => {
			if (!isId(body.targetPrincipalId) || !isRequestId(body.requestId)) return json({ error: "invalid request" }, 400);
			const target = state.memberships.find((record) => record.vaultId === actor.principal.vaultId && record.principalId === body.targetPrincipalId && record.state === "active");
			if (!target) return json({ error: "membership_missing" }, 404);
			if (target.role === "owner") return json({ error: "owner_invariant" }, 409);
			const own = target.principalId === actor.principal.principalId;
			const denied = requireCapability(actor, own ? "vault.leave" : "vault.members.manage");
			if (denied) return denied;
			return this.beginMembershipRevocation(txn, state, actor, target, body.requestId, own ? "member_left" : "member_removed");
		});
	}

	private createTransfer(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, state, actor) => {
			const denied = requireCapability(actor, "vault.ownership.transfer");
			if (denied) return denied;
			if (!isId(body.targetPrincipalId)) return json({ error: "invalid principalId" }, 400);
			const target = state.memberships.find((record) => record.vaultId === actor.principal.vaultId && record.principalId === body.targetPrincipalId && record.role === "member" && record.state === "active");
			if (!target) return json({ error: "membership_missing" }, 404);
			const now = Date.now();
			if (txn.records) {
				await txn.records.deleteWhere(OWNERSHIP_TRANSFERS_KEY, { state: "offered", expiresAtOrBefore: now });
				if (await txn.records.get(OWNERSHIP_TRANSFERS_KEY, { vaultId: actor.principal.vaultId, state: "offered" })) return json({ error: "transfer_pending" }, 409);
				if (await txn.records.count(OWNERSHIP_TRANSFERS_KEY) >= MAX_OWNERSHIP_TRANSFERS) return json({ error: "transfer_capacity" }, 503);
				const transfer = { transferId: randomBase64Url(16), vaultId: actor.principal.vaultId, fromPrincipalId: actor.principal.principalId, fromMembershipRevision: actor.membership.revision, toPrincipalId: target.principalId, toMembershipRevision: target.revision, state: "offered" as const, createdAt: now, expiresAt: now + TRANSFER_TTL_MS, acceptedAt: null, authorizationChangeId: null };
				await txn.records.upsert(OWNERSHIP_TRANSFERS_KEY, transfer);
				return json({ transfer });
			}
			const transfers = parseOwnershipTransferRecords(await txn.get(OWNERSHIP_TRANSFERS_KEY)).filter((record) => record.state !== "offered" || record.expiresAt > now);
			if (transfers.some((record) => record.vaultId === actor.principal.vaultId && record.state === "offered")) return json({ error: "transfer_pending" }, 409);
			if (transfers.length >= MAX_OWNERSHIP_TRANSFERS) return json({ error: "transfer_capacity" }, 503);
			const transfer = { transferId: randomBase64Url(16), vaultId: actor.principal.vaultId, fromPrincipalId: actor.principal.principalId, fromMembershipRevision: actor.membership.revision, toPrincipalId: target.principalId, toMembershipRevision: target.revision, state: "offered" as const, createdAt: now, expiresAt: now + TRANSFER_TTL_MS, acceptedAt: null, authorizationChangeId: null };
			transfers.push(transfer);
			await txn.put(OWNERSHIP_TRANSFERS_KEY, transfers);
			return json({ transfer });
		});
	}

	private acceptTransfer(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, state, actor) => {
			if (!isId(body.transferId) || !isRequestId(body.requestId)) return json({ error: "invalid request" }, 400);
			const transfers = txn.records ? [] : parseOwnershipTransferRecords(await txn.get(OWNERSHIP_TRANSFERS_KEY));
			const transfer = txn.records
				? await oneRecord(txn, OWNERSHIP_TRANSFERS_KEY, { recordKey: body.transferId }, parseOwnershipTransferRecords)
				: transfers.find((record) => record.transferId === body.transferId && record.vaultId === actor.principal.vaultId);
			if (transfer?.vaultId !== actor.principal.vaultId) return json({ error: "transfer_missing" }, 404);
			if (!transfer || transfer.state !== "offered") return json({ error: "transfer_missing" }, 404);
			if (transfer.toPrincipalId !== actor.principal.principalId) return json({ error: "role_forbidden" }, 403);
			if (transfer.expiresAt <= Date.now()) {
				transfer.state = "expired";
				if (txn.records) await txn.records.upsert(OWNERSHIP_TRANSFERS_KEY, transfer);
				else await txn.put(OWNERSHIP_TRANSFERS_KEY, transfers);
				return json({ error: "transfer_expired" }, 410);
			}
			const from = state.memberships.find((record) => record.principalId === transfer.fromPrincipalId && record.vaultId === transfer.vaultId);
			const to = state.memberships.find((record) => record.principalId === transfer.toPrincipalId && record.vaultId === transfer.vaultId);
			if (!from || !to || from.role !== "owner" || to.role !== "member" || from.state !== "active" || to.state !== "active" || from.revision !== transfer.fromMembershipRevision || to.revision !== transfer.toMembershipRevision) return json({ error: "authority_superseded" }, 409);
			if (!await authorizationChangesForAdmission(txn, Date.now())) return json({ error: "authorization_change_capacity" }, 503);
			const fromPrevious = from.revision;
			const toPrevious = to.revision;
			from.role = "member"; from.state = "changing"; from.revision++; from.updatedAt = Date.now();
			to.role = "owner"; to.state = "changing"; to.revision++; to.updatedAt = Date.now();
			const vault = await vaultRecord(txn, transfer.vaultId);
			if (!vault) return json({ error: "unknown_vault" }, 404);
			vault.ownerPrincipalId = to.principalId;
			const changeId = randomBase64Url(16);
			transfer.state = "fencing"; transfer.acceptedAt = Date.now(); transfer.authorizationChangeId = changeId;
			if (txn.records) {
				await txn.records.upsert(MEMBERSHIPS_KEY, from);
				await txn.records.upsert(MEMBERSHIPS_KEY, to);
				await txn.records.upsert(VAULTS_KEY, vault);
				await txn.records.upsert(OWNERSHIP_TRANSFERS_KEY, transfer);
			} else {
				await persistRecords(txn, MEMBERSHIPS_KEY, state.memberships);
				const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
				const storedVault = vaults.find((record) => record.vaultId === vault.vaultId);
				if (storedVault) Object.assign(storedVault, vault);
				await txn.put(VAULTS_KEY, vaults);
				await txn.put(OWNERSHIP_TRANSFERS_KEY, transfers);
			}
			const now = Date.now();
			return this.startChange(txn, { changeId, vaultId: vault.vaultId, vaultGeneration: vault.vaultGeneration, kind: "ownership-transfer", requestedByPrincipalId: from.principalId, requestId: body.requestId, requestDigest: await requestDigest({ transferId: transfer.transferId }), subjects: [
				{ kind: "membership", principalId: from.principalId, deviceId: null, previousRevision: fromPrevious, targetRevision: from.revision, targetRole: "member", targetState: "active" },
				{ kind: "membership", principalId: to.principalId, deviceId: null, previousRevision: toPrevious, targetRevision: to.revision, targetRole: "owner", targetState: "active" },
			], state: "pending", createdAt: now, completedAt: null, lastError: null }, { vaultId: vault.vaultId, kind: "ownership_transfer_accepted", actorPrincipalId: to.principalId, actorDeviceId: actor.device.deviceId, targetPrincipalId: from.principalId, targetDeviceId: null, detail: null }, now);
		});
	}

	private cancelTransfer(body: Record<string, unknown>): Promise<Response> {
		return this.withActor(body, async (txn, _state, actor) => {
			const denied = requireCapability(actor, "vault.ownership.transfer");
			if (denied) return denied;
			if (!isId(body.transferId)) return json({ error: "invalid transferId" }, 400);
			const transfers = txn.records ? [] : parseOwnershipTransferRecords(await txn.get(OWNERSHIP_TRANSFERS_KEY));
			const candidate = txn.records
				? await oneRecord(txn, OWNERSHIP_TRANSFERS_KEY, { recordKey: body.transferId }, parseOwnershipTransferRecords)
				: transfers.find((record) => record.transferId === body.transferId);
			const transfer = candidate?.vaultId === actor.principal.vaultId
				&& candidate.fromPrincipalId === actor.principal.principalId && candidate.state === "offered" ? candidate : undefined;
			if (!transfer) return json({ error: "transfer_missing" }, 404);
			transfer.state = "cancelled";
			if (txn.records) await txn.records.upsert(OWNERSHIP_TRANSFERS_KEY, transfer);
			else await txn.put(OWNERSHIP_TRANSFERS_KEY, transfers);
			return json({ ok: true });
		});
	}

	private async completeChange(body: Record<string, unknown>): Promise<Response> {
		if (!isId(body.changeId) || !isId(body.vaultId) || !isId(body.vaultGeneration)) return json({ error: "invalid receipt" }, 400);
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const change = await oneRecord(txn, AUTHORIZATION_CHANGES_KEY, { recordKey: body.changeId as string }, parseAuthorizationChangeRecords);
				if (!change || change.vaultId !== body.vaultId || change.vaultGeneration !== body.vaultGeneration) {
					return json({ error: "unknown_authorization_change" }, 404);
				}
				if (change.state === "complete") return json({ change });
				const memberships: VaultMembershipRecord[] = [];
				const devices: DeviceRecord[] = [];
				for (const subject of change.subjects) {
					if (subject.kind === "membership") {
						const membership = await membershipRecord(txn, change.vaultId, subject.principalId);
						if (!membership || membership.revision !== subject.targetRevision) return json({ error: "authority_superseded" }, 409);
						membership.state = subject.targetState === "active" ? "active" : "revoked";
						membership.revokedAt = subject.targetState === "revoked" ? Date.now() : null;
						membership.updatedAt = Date.now();
						memberships.push(membership);
					} else {
						const device = subject.deviceId ? await deviceRecord(txn, { recordKey: subject.deviceId }, change.vaultId) : undefined;
						if (!device || device.principalId !== subject.principalId || device.credentialRevision !== subject.targetRevision) {
							return json({ error: "authority_superseded" }, 409);
						}
						device.state = subject.targetState === "active" ? "active" : "revoked";
						device.revokedAt = subject.targetState === "revoked" ? Date.now() : null;
						devices.push(device);
					}
				}
				change.state = "complete"; change.completedAt = Date.now(); change.lastError = null;
				if (change.kind === "ownership-transfer") {
					const transfer = await oneRecord(txn, OWNERSHIP_TRANSFERS_KEY, {
						authorizationChangeId: change.changeId,
					}, parseOwnershipTransferRecords);
					if (transfer) { transfer.state = "complete"; await txn.records.upsert(OWNERSHIP_TRANSFERS_KEY, transfer); }
				}
				if (change.kind === "authority-install"
					&& change.subjects.some((subject) => subject.kind === "membership" && subject.targetRole === "owner")) {
					const vault = await vaultRecord(txn, change.vaultId);
					if (vault?.state === "awaiting_owner") { vault.state = "active"; await txn.records.upsert(VAULTS_KEY, vault); }
				}
				for (const membership of memberships) await txn.records.upsert(MEMBERSHIPS_KEY, membership);
				for (const device of devices) await txn.records.upsert(DEVICES_KEY, device);
				await txn.records.upsert(AUTHORIZATION_CHANGES_KEY, change);
				return json({ change });
			}
			const changes = parseAuthorizationChangeRecords(await txn.get(AUTHORIZATION_CHANGES_KEY));
			const change = changes.find((record) => record.changeId === body.changeId && record.vaultId === body.vaultId && record.vaultGeneration === body.vaultGeneration);
			if (!change) return json({ error: "unknown_authorization_change" }, 404);
			if (change.state === "complete") return json({ change });
			const state = await readState(txn);
			for (const subject of change.subjects) {
				if (subject.kind === "membership") {
					const membership = state.memberships.find((record) => record.principalId === subject.principalId && record.vaultId === change.vaultId);
					if (!membership || membership.revision !== subject.targetRevision) return json({ error: "authority_superseded" }, 409);
					membership.state = subject.targetState === "active" ? "active" : "revoked";
					membership.revokedAt = subject.targetState === "revoked" ? Date.now() : null;
					membership.updatedAt = Date.now();
				} else {
					const device = state.devices.find((record) => record.deviceId === subject.deviceId && record.principalId === subject.principalId);
					if (!device || device.credentialRevision !== subject.targetRevision) return json({ error: "authority_superseded" }, 409);
					device.state = subject.targetState === "active" ? "active" : "revoked";
					device.revokedAt = subject.targetState === "revoked" ? Date.now() : null;
				}
			}
			change.state = "complete"; change.completedAt = Date.now(); change.lastError = null;
			if (change.kind === "ownership-transfer") {
				const transfers = parseOwnershipTransferRecords(await txn.get(OWNERSHIP_TRANSFERS_KEY));
				const transfer = transfers.find((record) => record.authorizationChangeId === change.changeId);
				if (transfer) transfer.state = "complete";
				await txn.put(OWNERSHIP_TRANSFERS_KEY, transfers);
			}
			if (change.kind === "authority-install") {
				const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
				const vault = vaults.find((record) => record.vaultId === change.vaultId);
				const ownerInstalled = change.subjects.some((subject) => subject.kind === "membership" && subject.targetRole === "owner");
				if (vault && ownerInstalled && vault.state === "awaiting_owner") {
					vault.state = "active";
					await txn.put(VAULTS_KEY, vaults);
				}
			}
			await persistRecords(txn, MEMBERSHIPS_KEY, state.memberships);
			await persistRecords(txn, DEVICES_KEY, state.devices);
			await txn.put(AUTHORIZATION_CHANGES_KEY, changes);
			return json({ change });
		});
	}

	private async failChange(body: Record<string, unknown>): Promise<Response> {
		if (!isId(body.changeId)) return json({ error: "invalid changeId" }, 400);
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const change = await oneRecord(txn, AUTHORIZATION_CHANGES_KEY, { recordKey: body.changeId as string }, parseAuthorizationChangeRecords);
				if (!change) return json({ error: "unknown_authorization_change" }, 404);
				change.state = "failed";
				change.lastError = boundedName(body.lastError, "vault authorization fence failed").slice(0, 512);
				await txn.records.upsert(AUTHORIZATION_CHANGES_KEY, change);
				return json({ change }, 202);
			}
			const changes = parseAuthorizationChangeRecords(await txn.get(AUTHORIZATION_CHANGES_KEY));
			const change = changes.find((record) => record.changeId === body.changeId);
			if (!change) return json({ error: "unknown_authorization_change" }, 404);
			change.state = "failed";
			change.lastError = boundedName(body.lastError, "vault authorization fence failed").slice(0, 512);
			await txn.put(AUTHORIZATION_CHANGES_KEY, changes);
			return json({ change }, 202);
		});
	}

	private async pendingChanges(body: Record<string, unknown>): Promise<Response> {
		if (!isId(body.vaultId)) return json({ error: "invalid vaultId" }, 400);
		const changes = await this.storage.transaction(async (txn) => txn.records
			? parseAuthorizationChangeRecords(await txn.records.list(AUTHORIZATION_CHANGES_KEY, {
				vaultId: body.vaultId as string, limit: MAX_AUTHORIZATION_CHANGES,
			}))
			: parseAuthorizationChangeRecords(await txn.get(AUTHORIZATION_CHANGES_KEY)));
		return json({ changes: changes.filter((record) => record.vaultId === body.vaultId && record.state !== "complete") });
	}

	private async operatorCode(body: Record<string, unknown>): Promise<Response> {
		if (!isId(body.vaultId) || !isHash(body.codeHash) || (body.purpose !== "owner-bootstrap" && body.purpose !== "owner-recovery")) return json({ error: "invalid operator code" }, 400);
		const purpose = body.purpose;
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const vault = await vaultRecord(txn, body.vaultId as string);
				if (!vault) return json({ error: "unknown_vault" }, 404);
				const ownerCandidate = await oneRecord(txn, MEMBERSHIPS_KEY, {
					vaultId: vault.vaultId, role: "owner",
				}, parseMembershipRecords);
				const owner = ownerCandidate?.state !== "revoked" ? ownerCandidate : undefined;
				if (purpose === "owner-bootstrap" && owner) return json({ error: "owner_invariant" }, 409);
				if (purpose === "owner-recovery" && !owner) return json({ error: "owner_invariant" }, 409);
				const now = Date.now();
				await txn.records.deleteWhere(COLLABORATION_CODES_KEY, { expiresAtOrBefore: now, consumed: false });
				await txn.records.deleteWhere(COLLABORATION_CODES_KEY, { consumed: true });
				if (await txn.records.count(COLLABORATION_CODES_KEY) >= MAX_COLLABORATION_CODES) {
					return json({ error: "code_capacity" }, 503);
				}
				const code: CollaborationCodeRecord = {
					codeId: randomBase64Url(16), codeHash: body.codeHash as string,
					purpose, vaultId: vault.vaultId,
					principalId: owner?.principalId ?? null, issuerPrincipalId: null,
					issuerMembershipRevision: owner?.revision ?? null, creatorDeviceId: null,
					creatorDeviceCredentialRevision: null, createdAt: now,
					expiresAt: now + COLLABORATION_CODE_TTL_MS, consumedAt: null,
				};
				await txn.records.upsert(COLLABORATION_CODES_KEY, code);
				await appendAudit(txn, { vaultId: vault.vaultId, kind: `${purpose}_issued`, actorPrincipalId: null, actorDeviceId: null, targetPrincipalId: owner?.principalId ?? null, targetDeviceId: null, detail: null }, now);
				return json({ code: { ...code, codeHash: undefined } });
			}
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const vault = vaults.find((record) => record.vaultId === body.vaultId);
			if (!vault) return json({ error: "unknown_vault" }, 404);
			const memberships = parseMembershipRecords(await txn.get(MEMBERSHIPS_KEY));
			const owner = memberships.find((record) => record.vaultId === vault.vaultId && record.role === "owner" && record.state !== "revoked");
			if (purpose === "owner-bootstrap" && owner) return json({ error: "owner_invariant" }, 409);
			if (purpose === "owner-recovery" && !owner) return json({ error: "owner_invariant" }, 409);
			const codes = parseCollaborationCodeRecords(await txn.get(COLLABORATION_CODES_KEY)).filter((record) => record.expiresAt > Date.now() && record.consumedAt === null);
			if (codes.length >= MAX_COLLABORATION_CODES) return json({ error: "code_capacity" }, 503);
			const now = Date.now();
			const code: CollaborationCodeRecord = { codeId: randomBase64Url(16), codeHash: body.codeHash as string, purpose, vaultId: vault.vaultId, principalId: owner?.principalId ?? null, issuerPrincipalId: null, issuerMembershipRevision: owner?.revision ?? null, creatorDeviceId: null, creatorDeviceCredentialRevision: null, createdAt: now, expiresAt: now + COLLABORATION_CODE_TTL_MS, consumedAt: null };
			codes.push(code);
			await txn.put(COLLABORATION_CODES_KEY, codes);
			await appendAudit(txn, { vaultId: vault.vaultId, kind: `${purpose}_issued`, actorPrincipalId: null, actorDeviceId: null, targetPrincipalId: owner?.principalId ?? null, targetDeviceId: null, detail: null }, now);
			return json({ code: { ...code, codeHash: undefined } });
		});
	}

}
