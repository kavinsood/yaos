import type { HttpRequester } from "../utils/http";
import { obsidianRequest } from "../utils/http";
import {
	readVaultAuthoritySnapshot,
	type VaultAuthoritySnapshot,
	type VaultRole,
} from "./authority";

export interface CollaborationPrincipalSummary {
	readonly principalId: string;
	readonly displayName: string;
	readonly colorSeed: string;
	readonly role: VaultRole;
	readonly state: "active" | "changing" | "revoking" | "revoked";
	readonly joinedAt: number;
	readonly deviceCount: number;
	readonly lastSeenAt: number | null;
}

export interface CollaborationDeviceSummary {
	readonly deviceId: string;
	readonly principalId: string;
	readonly name: string;
	readonly state: "active" | "revoking" | "revoked";
	readonly enrolledAt: number;
	readonly lastSeenAt: number | null;
}

export interface CollaborationMe {
	readonly authority: VaultAuthoritySnapshot;
	readonly displayName: string;
	readonly colorSeed: string;
	readonly deviceName: string;
	readonly ownershipTransfers: readonly CollaborationOwnershipTransfer[];
}

export interface CollaborationOwnershipTransfer {
	readonly transferId: string;
	readonly fromPrincipalId: string;
	readonly toPrincipalId: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export interface SecurityAuditEvent {
	readonly eventId: string;
	readonly vaultId: string;
	readonly kind: string;
	readonly actorPrincipalId: string | null;
	readonly actorDeviceId: string | null;
	readonly targetPrincipalId: string | null;
	readonly targetDeviceId: string | null;
	readonly createdAt: number;
	readonly detail: string | null;
}

export interface CommittedOperationOutcome {
	readonly operationId: string;
	readonly requestDigest: string;
	readonly vaultSequence: number;
	readonly committed: true;
}

export interface CollaborationCode {
	readonly codeId: string;
	readonly pairingCode: string;
	readonly expiresAt: number;
	readonly obsidianUrl: string;
	readonly mobileSetupUrl: string;
}

export interface VaultGovernanceRequest {
	readonly governanceRequestId: string;
	readonly kind: "vault-rename" | "vault-destroy";
	readonly state: "complete" | "awaiting-operator-confirmation" | "confirmed" | "executing" | "failed";
	readonly createdAt: number;
}

export class CollaborationClient {
	private readonly base: string;

	constructor(
		host: string,
		private readonly vaultId: string,
		private readonly deviceToken: string,
		private readonly request: HttpRequester = obsidianRequest,
	) {
		this.base = host.trim().replace(/\/$/, "");
	}

	async getMe(): Promise<CollaborationMe> {
		const value = await this.get("me");
		if (!value || typeof value !== "object") throw new Error("membership response is malformed");
		const record = value as Record<string, unknown>;
		const actor = record.actor && typeof record.actor === "object" ? record.actor as Record<string, unknown> : record;
		const authorityValue = {
			...actor,
			capabilities: record.capabilities ?? actor.capabilities,
		};
		const principal = record.principal && typeof record.principal === "object"
			? record.principal as Record<string, unknown>
			: record;
		const device = record.device && typeof record.device === "object"
			? record.device as Record<string, unknown>
			: record;
		return Object.freeze({
			authority: readVaultAuthoritySnapshot(authorityValue),
			displayName: requiredString(principal.displayName, "displayName"),
			colorSeed: requiredString(principal.colorSeed, "colorSeed"),
			deviceName: requiredString(device.name ?? record.deviceName, "deviceName"),
			ownershipTransfers: Object.freeze(readOwnershipTransfers(record.ownershipTransfers)),
		});
	}

	async listMembers(): Promise<readonly CollaborationPrincipalSummary[]> {
		const value = await this.get("members");
		const items = value && typeof value === "object" && "members" in value ? value.members : null;
		if (!Array.isArray(items)) throw new Error("member roster response is malformed");
		return Object.freeze(items.map(readPrincipalSummary));
	}

	async listDevices(principalId: string): Promise<readonly CollaborationDeviceSummary[]> {
		const value = await this.get(`principals/${encodeURIComponent(principalId)}/devices`);
		const items = value && typeof value === "object" && "devices" in value ? value.devices : null;
		if (!Array.isArray(items)) throw new Error("device roster response is malformed");
		return Object.freeze(items.map(readDeviceSummary));
	}

	async createDeviceLink(): Promise<CollaborationCode> {
		return readCollaborationCode(await this.post("device-links", {}));
	}

	async createInvitation(displayName: string): Promise<CollaborationCode> {
		return readCollaborationCode(await this.post("invitations", { displayName: displayName.trim() }));
	}

	async revokeDevice(deviceId: string, requestId: string): Promise<void> {
		await this.mutate(`devices/${encodeURIComponent(deviceId)}`, "DELETE", { requestId });
	}

	async removeMember(principalId: string, requestId: string): Promise<void> {
		await this.mutate(`principals/${encodeURIComponent(principalId)}`, "DELETE", { requestId });
	}

	async renamePrincipal(principalId: string, displayName: string, requestId: string): Promise<{ pending: boolean }> {
		const value = await this.mutate(`principals/${encodeURIComponent(principalId)}`, "PATCH", { displayName, requestId });
		return { pending: readsPendingChange(value) };
	}

	async listSecurityAudit(): Promise<readonly SecurityAuditEvent[]> {
		const value = await this.get("audit");
		const items = value && typeof value === "object" && "events" in value ? value.events : null;
		if (!Array.isArray(items)) throw new Error("security audit response is malformed");
		return Object.freeze(items.map(readSecurityAuditEvent));
	}

	async getCommittedOperationOutcome(input: {
		operationId: string;
		requestDigest: string;
		membershipRevision: number;
		deviceCredentialRevision: number;
		deviceId: string;
	}): Promise<CommittedOperationOutcome | null> {
		const query = new URLSearchParams({
			requestDigest: input.requestDigest,
			membershipRevision: String(input.membershipRevision),
			deviceCredentialRevision: String(input.deviceCredentialRevision),
			deviceId: input.deviceId,
		});
		try {
			return readCommittedOperationOutcome(await this.get(`operations/${encodeURIComponent(input.operationId)}/outcome?${query}`));
		} catch (error) {
			if (error instanceof CollaborationRequestError && error.status === 404 && error.code === "operation_outcome_not_found") return null;
			throw error;
		}
	}

	async leave(requestId: string): Promise<{ pending: boolean }> {
		const value = await this.post("leave", { requestId });
		const pending = !!value && typeof value === "object" && "pending" in value && value.pending === true;
		return { pending };
	}

	async createOwnershipTransfer(targetPrincipalId: string): Promise<CollaborationOwnershipTransfer> {
		const value = await this.post("ownership/transfers", { targetPrincipalId });
		if (!value || typeof value !== "object" || !("transfer" in value)) {
			throw new Error("ownership transfer response is malformed");
		}
		return readOwnershipTransfer(value.transfer);
	}

	async acceptOwnershipTransfer(transferId: string, requestId: string): Promise<{ pending: boolean }> {
		const value = await this.post(`ownership/transfers/${encodeURIComponent(transferId)}`, { requestId });
		return { pending: !!value && typeof value === "object" && "pending" in value && value.pending === true };
	}

	async cancelOwnershipTransfer(transferId: string): Promise<void> {
		await this.mutate(`ownership/transfers/${encodeURIComponent(transferId)}`, "DELETE");
	}

	async renameVault(name: string, requestId: string): Promise<VaultGovernanceRequest> {
		return readVaultGovernanceRequest(await this.mutate("governance", "PATCH", { name: name.trim(), requestId }));
	}

	async requestVaultDestruction(requestId: string): Promise<VaultGovernanceRequest> {
		return readVaultGovernanceRequest(await this.mutate("governance", "DELETE", { requestId }));
	}

	private async get(resource: string): Promise<unknown> {
		return await this.mutate(resource, "GET");
	}

	private async post(resource: string, body: Record<string, unknown>): Promise<unknown> {
		return await this.mutate(resource, "POST", body);
	}

	private async mutate(resource: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>): Promise<unknown> {
		const response = await this.request({
			url: `${this.base}/vault/${encodeURIComponent(this.vaultId)}/${resource}`,
			method,
			headers: {
				Authorization: `Bearer ${this.deviceToken}`,
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (response.status < 200 || response.status >= 300) {
			const value: unknown = response.json;
			const code = value && typeof value === "object" && "error" in value && typeof value.error === "string"
				? value.error
				: "request_failed";
			throw new CollaborationRequestError(response.status, code);
		}
		return response.json;
	}
}

export class CollaborationRequestError extends Error {
	constructor(readonly status: number, readonly code: string) {
		super(`collaboration request failed (${status}: ${code})`);
		this.name = "CollaborationRequestError";
	}
}

function readPrincipalSummary(value: unknown): CollaborationPrincipalSummary {
	if (!value || typeof value !== "object") throw new Error("member summary is malformed");
	const record = value as Record<string, unknown>;
	const role = record.role;
	const state = record.state;
	if (role !== "owner" && role !== "member") throw new Error("member summary role is malformed");
	if (state !== "active" && state !== "changing" && state !== "revoking" && state !== "revoked") {
		throw new Error("member summary state is malformed");
	}
	return Object.freeze({
		principalId: requiredString(record.principalId, "principalId"),
		displayName: requiredString(record.displayName, "displayName"),
		colorSeed: requiredString(record.colorSeed, "colorSeed"),
		role,
		state,
		joinedAt: requiredTimestamp(record.joinedAt, "joinedAt"),
		deviceCount: record.deviceCount === undefined ? 0 : requiredCount(record.deviceCount, "deviceCount"),
		lastSeenAt: optionalTimestamp(record.lastSeenAt, "lastSeenAt"),
	});
}

function readDeviceSummary(value: unknown): CollaborationDeviceSummary {
	if (!value || typeof value !== "object") throw new Error("device summary is malformed");
	const record = value as Record<string, unknown>;
	const state = record.state;
	if (state !== "active" && state !== "revoking" && state !== "revoked") {
		throw new Error("device summary state is malformed");
	}
	return Object.freeze({
		deviceId: requiredString(record.deviceId, "deviceId"),
		principalId: requiredString(record.principalId, "principalId"),
		name: requiredString(record.name, "name"),
		state,
		enrolledAt: requiredTimestamp(record.enrolledAt, "enrolledAt"),
		lastSeenAt: optionalTimestamp(record.lastSeenAt, "lastSeenAt"),
	});
}

function readCollaborationCode(value: unknown): CollaborationCode {
	if (!value || typeof value !== "object") throw new Error("collaboration code response is malformed");
	const record = value as Record<string, unknown>;
	return Object.freeze({
		codeId: requiredString(record.codeId ?? record.invitationId ?? record.deviceLinkId, "codeId"),
		pairingCode: requiredString(record.pairingCode, "pairingCode"),
		expiresAt: requiredTimestamp(record.expiresAt, "expiresAt"),
		obsidianUrl: requiredString(record.obsidianUrl, "obsidianUrl"),
		mobileSetupUrl: requiredString(record.mobileSetupUrl, "mobileSetupUrl"),
	});
}

function readOwnershipTransfers(value: unknown): CollaborationOwnershipTransfer[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("ownership transfer list is malformed");
	return value.map(readOwnershipTransfer);
}

function readOwnershipTransfer(value: unknown): CollaborationOwnershipTransfer {
	if (!value || typeof value !== "object") throw new Error("ownership transfer is malformed");
	const record = value as Record<string, unknown>;
	return Object.freeze({
		transferId: requiredString(record.transferId, "transferId"),
		fromPrincipalId: requiredString(record.fromPrincipalId, "fromPrincipalId"),
		toPrincipalId: requiredString(record.toPrincipalId, "toPrincipalId"),
		createdAt: requiredTimestamp(record.createdAt, "createdAt"),
		expiresAt: requiredTimestamp(record.expiresAt, "expiresAt"),
	});
}

function readVaultGovernanceRequest(value: unknown): VaultGovernanceRequest {
	if (!value || typeof value !== "object" || !("governanceRequest" in value) || !value.governanceRequest || typeof value.governanceRequest !== "object") {
		throw new Error("vault governance response is malformed");
	}
	const record = value.governanceRequest as Record<string, unknown>;
	if ((record.kind !== "vault-rename" && record.kind !== "vault-destroy")
		|| (record.state !== "complete" && record.state !== "awaiting-operator-confirmation"
			&& record.state !== "confirmed" && record.state !== "executing" && record.state !== "failed")) {
		throw new Error("vault governance response is malformed");
	}
	return Object.freeze({
		governanceRequestId: requiredString(record.governanceRequestId, "governanceRequestId"),
		kind: record.kind,
		state: record.state,
		createdAt: requiredTimestamp(record.createdAt, "createdAt"),
	});
}

function readSecurityAuditEvent(value: unknown): SecurityAuditEvent {
	if (!value || typeof value !== "object") throw new Error("security audit event is malformed");
	const record = value as Record<string, unknown>;
	return Object.freeze({
		eventId: requiredString(record.eventId, "eventId"),
		vaultId: requiredString(record.vaultId, "vaultId"),
		kind: requiredString(record.kind, "kind"),
		actorPrincipalId: optionalString(record.actorPrincipalId, "actorPrincipalId"),
		actorDeviceId: optionalString(record.actorDeviceId, "actorDeviceId"),
		targetPrincipalId: optionalString(record.targetPrincipalId, "targetPrincipalId"),
		targetDeviceId: optionalString(record.targetDeviceId, "targetDeviceId"),
		createdAt: requiredTimestamp(record.createdAt, "createdAt"),
		detail: optionalString(record.detail, "detail"),
	});
}

function readCommittedOperationOutcome(value: unknown): CommittedOperationOutcome {
	if (!value || typeof value !== "object") throw new Error("operation outcome response is malformed");
	const record = value as Record<string, unknown>;
	if (record.committed !== true) throw new Error("operation outcome response is malformed");
	return Object.freeze({
		operationId: requiredString(record.operationId, "operationId"),
		requestDigest: requiredString(record.requestDigest, "requestDigest"),
		vaultSequence: requiredTimestamp(record.vaultSequence, "vaultSequence"),
		committed: true,
	});
}

function readsPendingChange(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if ("pending" in value) return value.pending === true;
	const change = "change" in value && value.change && typeof value.change === "object"
		? value.change as Record<string, unknown>
		: null;
	return change?.state === "pending";
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new Error(`${field} is malformed`);
	return value;
}

function optionalString(value: unknown, field: string): string | null {
	return value === null || value === undefined ? null : requiredString(value, field);
}

function requiredTimestamp(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} is malformed`);
	return value as number;
}

function optionalTimestamp(value: unknown, field: string): number | null {
	return value === null || value === undefined ? null : requiredTimestamp(value, field);
}

function requiredCount(value: unknown, field: string): number {
	return requiredTimestamp(value, field);
}
