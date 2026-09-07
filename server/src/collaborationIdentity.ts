import type { VaultRole } from "./collaboration";
import { CorruptIdentityStateError, MAX_ID_LENGTH, isUsableVaultId } from "./identity";

export const MAX_PRINCIPALS_PER_VAULT = 256;
export const MAX_COLLABORATION_CODES = 4_096;
export const MAX_OWNERSHIP_TRANSFERS = 256;
export const MAX_AUTHORIZATION_CHANGES = 4_096;
export const MAX_SECURITY_AUDIT_EVENTS = 10_000;
export const MAX_VAULT_GOVERNANCE_REQUESTS = 1_024;
export const COLLABORATION_CODE_TTL_MS = 15 * 60 * 1_000;

export type MembershipState = "active" | "changing" | "revoking" | "revoked";

export interface PrincipalRecord {
	principalId: string;
	vaultId: string;
	displayName: string;
	colorSeed: string;
	createdAt: number;
	updatedAt: number;
}

export interface VaultMembershipRecord {
	vaultId: string;
	principalId: string;
	role: VaultRole;
	state: MembershipState;
	revision: number;
	invitedByPrincipalId: string | null;
	joinedAt: number;
	updatedAt: number;
	revokedAt: number | null;
}

export type CollaborationCodePurpose = "member-invitation" | "device-link" | "owner-bootstrap" | "owner-recovery";

export interface CollaborationCodeRecord {
	codeId: string;
	codeHash: string;
	purpose: CollaborationCodePurpose;
	vaultId: string;
	principalId: string | null;
	issuerPrincipalId: string | null;
	issuerMembershipRevision: number | null;
	creatorDeviceId: string | null;
	creatorDeviceCredentialRevision: number | null;
	expiresAt: number;
	createdAt: number;
	consumedAt: number | null;
}

export interface OwnershipTransferRecord {
	transferId: string;
	vaultId: string;
	fromPrincipalId: string;
	fromMembershipRevision: number;
	toPrincipalId: string;
	toMembershipRevision: number;
	state: "offered" | "fencing" | "complete" | "cancelled" | "expired";
	createdAt: number;
	expiresAt: number;
	acceptedAt: number | null;
	authorizationChangeId: string | null;
}

export interface AuthorizationChangeSubject {
	kind: "membership" | "device";
	principalId: string;
	deviceId: string | null;
	previousRevision: number;
	targetRevision: number;
	targetRole: VaultRole | null;
	targetState: "active" | "revoked";
	displayName?: string;
	colorSeed?: string;
}

export interface AuthorizationChangeRecord {
	changeId: string;
	vaultId: string;
	vaultGeneration: string;
	kind: "authority-install" | "profile-update" | "device-revocation" | "membership-revocation" | "ownership-transfer";
	requestedByPrincipalId: string | null;
	requestId: string;
	requestDigest: string;
	subjectDigest: string;
	subjects: AuthorizationChangeSubject[];
	state: "pending" | "complete" | "failed";
	createdAt: number;
	completedAt: number | null;
	lastError: string | null;
}

export interface SecurityAuditEvent {
	eventId: string;
	vaultId: string;
	kind: string;
	actorPrincipalId: string | null;
	actorDeviceId: string | null;
	targetPrincipalId: string | null;
	targetDeviceId: string | null;
	createdAt: number;
	detail: string | null;
}

export interface VaultGovernanceRequestRecord {
	governanceRequestId: string;
	requestId: string;
	requestDigest: string;
	vaultId: string;
	vaultGeneration: string;
	kind: "vault-rename" | "vault-destroy" | "emergency-vault-destroy";
	state: "complete" | "awaiting-operator-confirmation" | "confirmed" | "executing" | "failed";
	requestedByPrincipalId: string | null;
	requestedByDeviceId: string | null;
	requestedByMembershipRevision: number | null;
	requestedName: string | null;
	emergencyReason: string | null;
	createdAt: number;
	confirmedAt: number | null;
	completedAt: number | null;
	lastError: string | null;
}

type Collection = "principals" | "vaultMemberships" | "collaborationCodes" | "ownershipTransfers" | "authorizationChanges" | "securityAuditEvents" | "vaultGovernanceRequests";

function records(value: unknown, collection: Collection, maximum: number): Record<string, unknown>[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > maximum) throw new CorruptIdentityStateError(collection, "invalid collection");
	return value.map((item, index) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new CorruptIdentityStateError(collection, `record ${index} is not an object`);
		}
		return item as Record<string, unknown>;
	});
}

function string(value: unknown, field: string, collection: Collection, maximum = MAX_ID_LENGTH): string {
	if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value) {
		throw new CorruptIdentityStateError(collection, `invalid ${field}`);
	}
	return value;
}

function timestamp(value: unknown, field: string, collection: Collection): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new CorruptIdentityStateError(collection, `invalid ${field}`);
	return value as number;
}

function nullableTimestamp(value: unknown, field: string, collection: Collection): number | null {
	return value === null ? null : timestamp(value, field, collection);
}

function revision(value: unknown, field: string, collection: Collection): number {
	const parsed = timestamp(value, field, collection);
	if (parsed < 1) throw new CorruptIdentityStateError(collection, `invalid ${field}`);
	return parsed;
}

function nullableString(value: unknown, field: string, collection: Collection): string | null {
	return value === null ? null : string(value, field, collection);
}

function unique(items: readonly string[], collection: Collection, field: string): void {
	if (new Set(items).size !== items.length) throw new CorruptIdentityStateError(collection, `duplicate ${field}`);
}

export function parsePrincipalRecords(value: unknown): PrincipalRecord[] {
	const collection = "principals";
	const result = records(value, collection, MAX_PRINCIPALS_PER_VAULT * 256).map((record) => {
		const vaultId = string(record.vaultId, "vaultId", collection);
		if (!isUsableVaultId(vaultId)) throw new CorruptIdentityStateError(collection, "invalid vaultId");
		const createdAt = timestamp(record.createdAt, "createdAt", collection);
		const updatedAt = timestamp(record.updatedAt, "updatedAt", collection);
		if (updatedAt < createdAt) throw new CorruptIdentityStateError(collection, "updatedAt predates createdAt");
		return {
			principalId: string(record.principalId, "principalId", collection),
			vaultId,
			displayName: string(record.displayName, "displayName", collection, 80),
			colorSeed: string(record.colorSeed, "colorSeed", collection, 128),
			createdAt,
			updatedAt,
		};
	});
	unique(result.map((record) => record.principalId), collection, "principalId");
	return result;
}

export function parseMembershipRecords(value: unknown): VaultMembershipRecord[] {
	const collection = "vaultMemberships";
	const result = records(value, collection, MAX_PRINCIPALS_PER_VAULT * 256).map((record) => {
		if (record.role !== "owner" && record.role !== "member") throw new CorruptIdentityStateError(collection, "invalid role");
		if (record.state !== "active" && record.state !== "changing" && record.state !== "revoking" && record.state !== "revoked") {
			throw new CorruptIdentityStateError(collection, "invalid state");
		}
		const joinedAt = timestamp(record.joinedAt, "joinedAt", collection);
		const updatedAt = timestamp(record.updatedAt, "updatedAt", collection);
		const revokedAt = nullableTimestamp(record.revokedAt, "revokedAt", collection);
		if ((record.state === "revoked") !== (revokedAt !== null)) throw new CorruptIdentityStateError(collection, "inconsistent revokedAt");
		return {
			vaultId: string(record.vaultId, "vaultId", collection),
			principalId: string(record.principalId, "principalId", collection),
			role: record.role as VaultRole,
			state: record.state as MembershipState,
			revision: revision(record.revision, "revision", collection),
			invitedByPrincipalId: nullableString(record.invitedByPrincipalId, "invitedByPrincipalId", collection),
			joinedAt,
			updatedAt,
			revokedAt,
		};
	});
	unique(result.map((record) => `${record.vaultId}:${record.principalId}`), collection, "membership");
	for (const vaultId of new Set(result.map((record) => record.vaultId))) {
		if (result.filter((record) => record.vaultId === vaultId && record.role === "owner" && record.state !== "revoked").length > 1) {
			throw new CorruptIdentityStateError(collection, "multiple owners");
		}
	}
	return result;
}

export function parseCollaborationCodeRecords(value: unknown): CollaborationCodeRecord[] {
	const collection = "collaborationCodes";
	const purposes: CollaborationCodePurpose[] = ["member-invitation", "device-link", "owner-bootstrap", "owner-recovery"];
	const result = records(value, collection, MAX_COLLABORATION_CODES).map((record) => {
		if (!purposes.includes(record.purpose as CollaborationCodePurpose)) throw new CorruptIdentityStateError(collection, "invalid purpose");
		return {
			codeId: string(record.codeId, "codeId", collection),
			codeHash: string(record.codeHash, "codeHash", collection, 256),
			purpose: record.purpose as CollaborationCodePurpose,
			vaultId: string(record.vaultId, "vaultId", collection),
			principalId: nullableString(record.principalId, "principalId", collection),
			issuerPrincipalId: nullableString(record.issuerPrincipalId, "issuerPrincipalId", collection),
			issuerMembershipRevision: record.issuerMembershipRevision === null ? null : revision(record.issuerMembershipRevision, "issuerMembershipRevision", collection),
			creatorDeviceId: nullableString(record.creatorDeviceId, "creatorDeviceId", collection),
			creatorDeviceCredentialRevision: record.creatorDeviceCredentialRevision === null ? null : revision(record.creatorDeviceCredentialRevision, "creatorDeviceCredentialRevision", collection),
			expiresAt: timestamp(record.expiresAt, "expiresAt", collection),
			createdAt: timestamp(record.createdAt, "createdAt", collection),
			consumedAt: nullableTimestamp(record.consumedAt, "consumedAt", collection),
		};
	});
	unique(result.map((record) => record.codeId), collection, "codeId");
	unique(result.map((record) => record.codeHash), collection, "codeHash");
	return result;
}

export function parseOwnershipTransferRecords(value: unknown): OwnershipTransferRecord[] {
	const collection = "ownershipTransfers";
	const states: OwnershipTransferRecord["state"][] = ["offered", "fencing", "complete", "cancelled", "expired"];
	const result = records(value, collection, MAX_OWNERSHIP_TRANSFERS).map((record) => {
		if (!states.includes(record.state as OwnershipTransferRecord["state"])) throw new CorruptIdentityStateError(collection, "invalid state");
		return {
			transferId: string(record.transferId, "transferId", collection),
			vaultId: string(record.vaultId, "vaultId", collection),
			fromPrincipalId: string(record.fromPrincipalId, "fromPrincipalId", collection),
			fromMembershipRevision: revision(record.fromMembershipRevision, "fromMembershipRevision", collection),
			toPrincipalId: string(record.toPrincipalId, "toPrincipalId", collection),
			toMembershipRevision: revision(record.toMembershipRevision, "toMembershipRevision", collection),
			state: record.state as OwnershipTransferRecord["state"],
			createdAt: timestamp(record.createdAt, "createdAt", collection),
			expiresAt: timestamp(record.expiresAt, "expiresAt", collection),
			acceptedAt: nullableTimestamp(record.acceptedAt, "acceptedAt", collection),
			authorizationChangeId: nullableString(record.authorizationChangeId, "authorizationChangeId", collection),
		};
	});
	unique(result.map((record) => record.transferId), collection, "transferId");
	return result;
}

export function parseAuthorizationChangeRecords(value: unknown): AuthorizationChangeRecord[] {
	const collection = "authorizationChanges";
	const result = records(value, collection, MAX_AUTHORIZATION_CHANGES).map((record) => {
		if (!Array.isArray(record.subjects) || record.subjects.length < 1 || record.subjects.length > 512) throw new CorruptIdentityStateError(collection, "invalid subjects");
		if (record.kind !== "authority-install" && record.kind !== "profile-update" && record.kind !== "device-revocation" && record.kind !== "membership-revocation" && record.kind !== "ownership-transfer") throw new CorruptIdentityStateError(collection, "invalid kind");
		if (record.state !== "pending" && record.state !== "complete" && record.state !== "failed") throw new CorruptIdentityStateError(collection, "invalid state");
		const subjects = record.subjects.map((item) => {
			if (typeof item !== "object" || item === null || Array.isArray(item)) throw new CorruptIdentityStateError(collection, "invalid subject");
			const subject = item as Record<string, unknown>;
			if (subject.kind !== "membership" && subject.kind !== "device") throw new CorruptIdentityStateError(collection, "invalid subject kind");
			if (subject.targetState !== "active" && subject.targetState !== "revoked") throw new CorruptIdentityStateError(collection, "invalid target state");
			if (subject.targetRole !== null && subject.targetRole !== "owner" && subject.targetRole !== "member") throw new CorruptIdentityStateError(collection, "invalid target role");
			return {
				kind: subject.kind as AuthorizationChangeSubject["kind"],
				principalId: string(subject.principalId, "principalId", collection),
				deviceId: nullableString(subject.deviceId, "deviceId", collection),
				previousRevision: revision(subject.previousRevision, "previousRevision", collection),
				targetRevision: revision(subject.targetRevision, "targetRevision", collection),
				targetRole: subject.targetRole as VaultRole | null,
				targetState: subject.targetState as AuthorizationChangeSubject["targetState"],
				...(subject.displayName === undefined ? {} : { displayName: string(subject.displayName, "displayName", collection, 80) }),
				...(subject.colorSeed === undefined ? {} : { colorSeed: string(subject.colorSeed, "colorSeed", collection, 128) }),
			};
		});
		return {
			changeId: string(record.changeId, "changeId", collection),
			vaultId: string(record.vaultId, "vaultId", collection),
			vaultGeneration: string(record.vaultGeneration, "vaultGeneration", collection),
			kind: record.kind as AuthorizationChangeRecord["kind"],
			requestedByPrincipalId: nullableString(record.requestedByPrincipalId, "requestedByPrincipalId", collection),
			requestId: string(record.requestId, "requestId", collection),
			requestDigest: string(record.requestDigest, "requestDigest", collection, 256),
			subjectDigest: string(record.subjectDigest, "subjectDigest", collection, 256),
			subjects,
			state: record.state as AuthorizationChangeRecord["state"],
			createdAt: timestamp(record.createdAt, "createdAt", collection),
			completedAt: nullableTimestamp(record.completedAt, "completedAt", collection),
			lastError: record.lastError === null ? null : string(record.lastError, "lastError", collection, 512),
		};
	});
	unique(result.map((record) => record.changeId), collection, "changeId");
	unique(result.map((record) => `${record.vaultId}:${record.requestId}`), collection, "requestId");
	return result;
}

export function parseSecurityAuditEvents(value: unknown): SecurityAuditEvent[] {
	const collection = "securityAuditEvents";
	const result = records(value, collection, MAX_SECURITY_AUDIT_EVENTS).map((record) => ({
		eventId: string(record.eventId, "eventId", collection),
		vaultId: string(record.vaultId, "vaultId", collection),
		kind: string(record.kind, "kind", collection, 80),
		actorPrincipalId: nullableString(record.actorPrincipalId, "actorPrincipalId", collection),
		actorDeviceId: nullableString(record.actorDeviceId, "actorDeviceId", collection),
		targetPrincipalId: nullableString(record.targetPrincipalId, "targetPrincipalId", collection),
		targetDeviceId: nullableString(record.targetDeviceId, "targetDeviceId", collection),
		createdAt: timestamp(record.createdAt, "createdAt", collection),
		detail: record.detail === null ? null : string(record.detail, "detail", collection, 512),
	}));
	unique(result.map((record) => record.eventId), collection, "eventId");
	return result;
}

export function parseVaultGovernanceRequestRecords(value: unknown): VaultGovernanceRequestRecord[] {
	const collection = "vaultGovernanceRequests";
	const kinds: VaultGovernanceRequestRecord["kind"][] = ["vault-rename", "vault-destroy", "emergency-vault-destroy"];
	const states: VaultGovernanceRequestRecord["state"][] = ["complete", "awaiting-operator-confirmation", "confirmed", "executing", "failed"];
	const result = records(value, collection, MAX_VAULT_GOVERNANCE_REQUESTS).map((record) => {
		if (!kinds.includes(record.kind as VaultGovernanceRequestRecord["kind"])) throw new CorruptIdentityStateError(collection, "invalid kind");
		if (!states.includes(record.state as VaultGovernanceRequestRecord["state"])) throw new CorruptIdentityStateError(collection, "invalid state");
		return {
			governanceRequestId: string(record.governanceRequestId, "governanceRequestId", collection),
			requestId: string(record.requestId, "requestId", collection),
			requestDigest: string(record.requestDigest, "requestDigest", collection, 256),
			vaultId: string(record.vaultId, "vaultId", collection),
			vaultGeneration: string(record.vaultGeneration, "vaultGeneration", collection),
			kind: record.kind as VaultGovernanceRequestRecord["kind"],
			state: record.state as VaultGovernanceRequestRecord["state"],
			requestedByPrincipalId: nullableString(record.requestedByPrincipalId, "requestedByPrincipalId", collection),
			requestedByDeviceId: nullableString(record.requestedByDeviceId, "requestedByDeviceId", collection),
			requestedByMembershipRevision: record.requestedByMembershipRevision === null ? null : revision(record.requestedByMembershipRevision, "requestedByMembershipRevision", collection),
			requestedName: record.requestedName === null ? null : string(record.requestedName, "requestedName", collection, 80),
			emergencyReason: record.emergencyReason === null ? null : string(record.emergencyReason, "emergencyReason", collection, 512),
			createdAt: timestamp(record.createdAt, "createdAt", collection),
			confirmedAt: nullableTimestamp(record.confirmedAt, "confirmedAt", collection),
			completedAt: nullableTimestamp(record.completedAt, "completedAt", collection),
			lastError: record.lastError === null ? null : string(record.lastError, "lastError", collection, 512),
		};
	});
	unique(result.map((record) => record.governanceRequestId), collection, "governanceRequestId");
	unique(result.map((record) => `${record.vaultId}:${record.requestId}`), collection, "requestId");
	return result;
}
