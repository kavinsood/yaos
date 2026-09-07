import { randomBase64Url } from "./base64url";
import {
	CONFIG_FORMAT,
	MAX_DEVICE_RECORDS,
	MAX_HASH_LENGTH,
	MAX_OPERATOR_SESSION_RECORDS,
	MAX_PAIRING_CODE_RECORDS,
	MAX_VAULT_RECORDS,
	PAIRING_CODE_TTL_MS,
	CorruptIdentityStateError,
	type DevicePublic,
	type DeviceRecord,
	type PairingCodePublic,
	type PairingPurpose,
	type VaultRecord,
	findHashedRecord,
	hashSecret,
	isUsableVaultId,
	parseDeviceRecords,
	parseOperatorSessionRecords,
	parsePairingCodeRecords,
	parseVaultRecords,
	toDevicePublic,
	toPairingPublic,
	uniqueDeviceName,
} from "./identity";
import { json } from "./routes/http";
import type { ControlPlaneStoragePort, ControlPlaneTransactionPort } from "./platformPorts";
import { SqlControlPlaneStorage, type ControlPlaneSqlHost } from "./controlPlaneSql";
import {
	CollaborationControlPlane,
	buildActorContext,
	initializeCollaborationStorage,
	installEnrollmentIdentity,
} from "./collaborationControlPlane";
import { capabilitiesForRole } from "./collaboration";
import { parseAuthorizationChangeRecords, parseCollaborationCodeRecords, parseMembershipRecords, parseOwnershipTransferRecords, parsePrincipalRecords, parseSecurityAuditEvents, parseVaultGovernanceRequestRecords, type AuthorizationChangeRecord, type VaultGovernanceRequestRecord } from "./collaborationIdentity";

const CONFIG_FORMAT_KEY = "configFormat";
const CLAIMED_KEY = "claimed";
const OPERATOR_RECOVERY_HASH_KEY = "operatorRecoveryHash";
const TICKET_SIGNING_KEY = "ticketSigningKey";
const UPDATE_PROVIDER_KEY = "updateProvider";
const UPDATE_REPO_URL_KEY = "updateRepoUrl";
const UPDATE_REPO_BRANCH_KEY = "updateRepoBranch";
const DEVICES_KEY = "devices";
const PAIRING_CODES_KEY = "pairingCodes";
const VAULTS_KEY = "vaults";
const SESSIONS_KEY = "operatorSessions";
const PENDING_DESTROYS_KEY = "pendingVaultDestroys";
const PENDING_DEVICE_REVOCATIONS_KEY = "pendingDeviceRevocations";
const ENROLLMENT_REPLAYS_KEY = "enrollmentReplays";
const PROVISIONING_ERROR_KEY_PREFIX = "vaultProvisioningError:";
export const MAX_PENDING_DESTROYS = 256;
const MAX_PENDING_DESTROY_ERROR_LENGTH = 512;
export const MAX_PENDING_DEVICE_REVOCATIONS = MAX_DEVICE_RECORDS;
export const MAX_ENROLLMENT_REPLAY_RECORDS = MAX_DEVICE_RECORDS;
export const ENROLLMENT_REPLAY_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_PENDING_REVOCATION_ERROR_LENGTH = 512;

export interface PendingDestroyRecord {
	vaultId: string;
	vaultGeneration: string;
	deletionId: string;
	purgeJobId: string;
	requestedAt: number;
	roomComplete: boolean;
	r2Complete: boolean;
	purgeState: "pending" | "queued" | "purging" | "retrying" | "complete" | "failed";
	capabilityHash: string | null;
	capabilityExpiresAt: number | null;
	deletedObjects: number;
	deletedBytes: number;
	lastError: string | null;
}

export interface PendingDeviceRevocationRecord {
	vaultId: string;
	vaultGeneration: string;
	deviceId: string;
	requestedAt: number;
	lastError: string | null;
}

export interface EnrollmentReplayRecord {
	enrollmentRequestId: string;
	pairingCodeHash: string;
	deviceId: string;
	deviceTokenHash: string;
	vaultId: string;
	vaultGeneration: string;
	deviceName: string;
	originImport: boolean;
	createdAt: number;
	expiresAt: number;
}

type UpdateProvider = "github" | "gitlab" | "unknown";

export interface StoredServerConfig {
	configFormat: number | null;
	claimed: boolean;
	operatorRecoveryHash: string | null;
	ticketSigningKey: string | null;
	updateProvider: UpdateProvider | null;
	updateRepoUrl: string | null;
	updateRepoBranch: string | null;
}

export interface ConsoleState {
	vaults: VaultRecord[];
	devices: DevicePublic[];
	pairingCodes: PairingCodePublic[];
	pendingDestroys: PendingDestroyRecord[];
	pendingDeviceRevocations: PendingDeviceRevocationRecord[];
	principals: ReturnType<typeof parsePrincipalRecords>;
	memberships: ReturnType<typeof parseMembershipRecords>;
	authorizationChanges: AuthorizationChangeRecord[];
	vaultGovernanceRequests: VaultGovernanceRequestRecord[];
}

function normalizeUpdateProvider(value: unknown): UpdateProvider | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error("invalid updateProvider");
	const raw = value.trim().toLowerCase();
	if (!raw) return null;
	if (raw === "github" || raw === "gitlab" || raw === "unknown") return raw;
	throw new Error("invalid updateProvider");
}

function normalizeUpdateRepoUrl(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error("invalid updateRepoUrl");
	const raw = value.trim();
	if (!raw) return null;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("invalid updateRepoUrl");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("invalid updateRepoUrl");
	}
	if (parsed.pathname.split("/").filter(Boolean).length < 2) {
		throw new Error("invalid updateRepoUrl");
	}
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/, "").replace(/\.git$/i, "");
}

function normalizeUpdateRepoBranch(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error("invalid updateRepoBranch");
	const raw = value.trim();
	if (!raw) return null;
	if (raw.length > 120 || !/^[A-Za-z0-9._/-]+$/.test(raw) || raw.includes("..")) {
		throw new Error("invalid updateRepoBranch");
	}
	return raw;
}


function boundedDestroyError(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, MAX_PENDING_DESTROY_ERROR_LENGTH) : null;
}

function boundedRevocationError(value: unknown): string {
	const trimmed = typeof value === "string" ? value.trim() : "";
	return (trimmed || "vault runtime revocation fence failed").slice(0, MAX_PENDING_REVOCATION_ERROR_LENGTH);
}

export function parsePendingDeviceRevocationRecords(value: unknown): PendingDeviceRevocationRecord[] {
	const collection = "pendingDeviceRevocations";
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new CorruptIdentityStateError(collection, "expected an array");
	if (value.length > MAX_PENDING_DEVICE_REVOCATIONS) {
		throw new CorruptIdentityStateError(collection, "collection exceeds capacity");
	}
	const deviceIds = new Set<string>();
	return value.map((item, index) => {
		if (!Object.prototype.hasOwnProperty.call(value, index)) {
			throw new CorruptIdentityStateError(collection, `record ${index} is missing`);
		}
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new CorruptIdentityStateError(collection, `record ${index} is not an object`);
		}
		const record = item as Record<string, unknown>;
		const expectedKeys = ["vaultId", "vaultGeneration", "deviceId", "requestedAt", "lastError"];
		const keys = Object.keys(record);
		if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
			throw new CorruptIdentityStateError(collection, `record ${index} has invalid shape`);
		}
		if (
			typeof record.vaultId !== "string" || record.vaultId.trim() !== record.vaultId
			|| !isUsableVaultId(record.vaultId)
			|| typeof record.vaultGeneration !== "string"
			|| record.vaultGeneration.trim() !== record.vaultGeneration
			|| !isUsableVaultId(record.vaultGeneration)
			|| typeof record.deviceId !== "string"
			|| !/^[A-Za-z0-9_-]{1,128}$/.test(record.deviceId)
			|| !Number.isSafeInteger(record.requestedAt) || (record.requestedAt as number) < 0
		) {
			throw new CorruptIdentityStateError(collection, `record ${index} has invalid identity`);
		}
		if (record.lastError !== null && (
			typeof record.lastError !== "string"
			|| record.lastError.length < 1
			|| record.lastError.length > MAX_PENDING_REVOCATION_ERROR_LENGTH
			|| record.lastError.trim() !== record.lastError
		)) {
			throw new CorruptIdentityStateError(collection, `record ${index} has invalid lastError`);
		}
		if (deviceIds.has(record.deviceId)) {
			throw new CorruptIdentityStateError(collection, "duplicate deviceId");
		}
		deviceIds.add(record.deviceId);
		return {
			vaultId: record.vaultId,
			vaultGeneration: record.vaultGeneration,
			deviceId: record.deviceId,
			requestedAt: record.requestedAt as number,
			lastError: record.lastError,
		};
	});
}

export function parseEnrollmentReplayRecords(value: unknown): EnrollmentReplayRecord[] {
	const collection = "enrollmentReplays";
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new CorruptIdentityStateError(collection, "expected an array");
	if (value.length > MAX_ENROLLMENT_REPLAY_RECORDS) {
		throw new CorruptIdentityStateError(collection, "collection exceeds capacity");
	}
	const requestIds = new Set<string>();
	const deviceIds = new Set<string>();
	const tokenHashes = new Set<string>();
	const codeHashes = new Set<string>();
	return value.map((item, index) => {
		if (!Object.prototype.hasOwnProperty.call(value, index)) {
			throw new CorruptIdentityStateError(collection, `record ${index} is missing`);
		}
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new CorruptIdentityStateError(collection, `record ${index} is not an object`);
		}
		const record = item as Record<string, unknown>;
		const expectedKeys = [
			"enrollmentRequestId", "pairingCodeHash", "deviceId", "deviceTokenHash", "vaultId",
			"vaultGeneration", "deviceName", "originImport", "createdAt", "expiresAt",
		];
		const keys = Object.keys(record);
		if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
			throw new CorruptIdentityStateError(collection, `record ${index} has invalid shape`);
		}
		if (
			typeof record.enrollmentRequestId !== "string"
			|| !/^[A-Za-z0-9_-]{16,128}$/.test(record.enrollmentRequestId)
			|| typeof record.deviceId !== "string"
			|| !/^[A-Za-z0-9_-]{1,128}$/.test(record.deviceId)
			|| typeof record.pairingCodeHash !== "string" || !/^[a-f0-9]{64}$/.test(record.pairingCodeHash)
			|| typeof record.deviceTokenHash !== "string" || !/^[a-f0-9]{64}$/.test(record.deviceTokenHash)
			|| typeof record.vaultId !== "string" || record.vaultId.trim() !== record.vaultId
			|| !isUsableVaultId(record.vaultId)
			|| typeof record.vaultGeneration !== "string"
			|| record.vaultGeneration.trim() !== record.vaultGeneration
			|| !isUsableVaultId(record.vaultGeneration)
			|| typeof record.deviceName !== "string" || record.deviceName.length < 1
			|| record.deviceName.length > 80 || record.deviceName.trim() !== record.deviceName
			|| typeof record.originImport !== "boolean"
			|| !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0
			|| !Number.isSafeInteger(record.expiresAt)
			|| (record.expiresAt as number) <= (record.createdAt as number)
		) {
			throw new CorruptIdentityStateError(collection, `record ${index} has invalid enrollment replay`);
		}
		for (const [values, field, candidate] of [
			[requestIds, "enrollmentRequestId", record.enrollmentRequestId],
			[deviceIds, "deviceId", record.deviceId],
			[tokenHashes, "deviceTokenHash", record.deviceTokenHash],
			[codeHashes, "pairingCodeHash", record.pairingCodeHash],
		] as Array<[Set<string>, string, string]>) {
			if (values.has(candidate)) throw new CorruptIdentityStateError(collection, `duplicate ${field}`);
			values.add(candidate);
		}
		return {
			enrollmentRequestId: record.enrollmentRequestId,
			pairingCodeHash: record.pairingCodeHash,
			deviceId: record.deviceId,
			deviceTokenHash: record.deviceTokenHash,
			vaultId: record.vaultId,
			vaultGeneration: record.vaultGeneration,
			deviceName: record.deviceName,
			originImport: record.originImport,
			createdAt: record.createdAt as number,
			expiresAt: record.expiresAt as number,
		};
	});
}

export function parsePendingDestroyRecords(
	value: unknown,
	activeVaultIds?: ReadonlySet<string>,
): PendingDestroyRecord[] {
	const collection = "pendingVaultDestroys";
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new CorruptIdentityStateError(collection, "expected an array");
	if (value.length > MAX_PENDING_DESTROYS) {
		throw new CorruptIdentityStateError(collection, "collection exceeds capacity");
	}
	for (let index = 0; index < value.length; index++) {
		if (!Object.prototype.hasOwnProperty.call(value, index)) {
			throw new CorruptIdentityStateError(collection, `record ${index} is missing`);
		}
	}
	const vaultIds = new Set<string>();
	return value.map((item, index) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new CorruptIdentityStateError(collection, `record ${index} is not an object`);
		}
		const record = item as Record<string, unknown>;
		const keys = Object.keys(record);
		const expectedKeys = [
			"vaultId", "vaultGeneration", "deletionId", "purgeJobId", "requestedAt", "roomComplete",
			"r2Complete", "purgeState", "capabilityHash", "capabilityExpiresAt", "deletedObjects",
			"deletedBytes", "lastError",
		];
		if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
			throw new CorruptIdentityStateError(collection, `record ${index} has invalid shape`);
		}
		if (
			typeof record.vaultId !== "string"
			|| record.vaultId.trim() !== record.vaultId
			|| !isUsableVaultId(record.vaultId)
		) {
			throw new CorruptIdentityStateError(collection, `record ${index} has invalid vaultId`);
		}
		if (typeof record.vaultGeneration !== "string" || !isUsableVaultId(record.vaultGeneration)
			|| record.vaultGeneration.trim() !== record.vaultGeneration) {
			throw new CorruptIdentityStateError(collection, `record ${index} has invalid vaultGeneration`);
		}
		if (typeof record.deletionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.deletionId)
			|| record.purgeJobId !== `purge:${record.vaultId}:${record.vaultGeneration}`) {
			throw new CorruptIdentityStateError(collection, `record ${index} has invalid purge identity`);
		}
		if (!Number.isSafeInteger(record.requestedAt) || (record.requestedAt as number) < 0) {
			throw new CorruptIdentityStateError(collection, `record ${index} has invalid requestedAt`);
		}
		if (typeof record.roomComplete !== "boolean" || typeof record.r2Complete !== "boolean") {
			throw new CorruptIdentityStateError(collection, `record ${index} has invalid completion state`);
		}
		if (record.roomComplete && record.r2Complete) {
			throw new CorruptIdentityStateError(collection, `record ${index} is already complete`);
		}
		if (record.purgeState !== "pending" && record.purgeState !== "queued" && record.purgeState !== "purging"
			&& record.purgeState !== "retrying" && record.purgeState !== "complete" && record.purgeState !== "failed") {
			throw new CorruptIdentityStateError(collection, `record ${index} has invalid purge state`);
		}
		if ((record.capabilityHash !== null && (typeof record.capabilityHash !== "string" || !/^[a-f0-9]{64}$/.test(record.capabilityHash)))
			|| (record.capabilityExpiresAt !== null && (!Number.isSafeInteger(record.capabilityExpiresAt) || (record.capabilityExpiresAt as number) < 0))
			|| !Number.isSafeInteger(record.deletedObjects) || (record.deletedObjects as number) < 0
			|| !Number.isSafeInteger(record.deletedBytes) || (record.deletedBytes as number) < 0) {
			throw new CorruptIdentityStateError(collection, `record ${index} has invalid purge progress`);
		}
		let lastError: string | null;
		if (record.lastError === null) {
			lastError = null;
		} else {
			if (
				typeof record.lastError !== "string"
				|| record.lastError.length < 1
				|| record.lastError.length > MAX_PENDING_DESTROY_ERROR_LENGTH
				|| record.lastError.trim() !== record.lastError
			) {
				throw new CorruptIdentityStateError(collection, `record ${index} has invalid lastError`);
			}
			lastError = record.lastError;
		}
		if (vaultIds.has(record.vaultId)) {
			throw new CorruptIdentityStateError(collection, "duplicate vaultId");
		}
		if (activeVaultIds?.has(record.vaultId)) {
			throw new CorruptIdentityStateError(collection, `record ${index} conflicts with an active vaultId`);
		}
		vaultIds.add(record.vaultId);
		return {
			vaultId: record.vaultId,
			vaultGeneration: record.vaultGeneration,
			deletionId: record.deletionId,
			purgeJobId: record.purgeJobId,
			requestedAt: record.requestedAt as number,
			roomComplete: record.roomComplete,
			r2Complete: record.r2Complete,
			purgeState: record.purgeState,
			capabilityHash: record.capabilityHash,
			capabilityExpiresAt: record.capabilityExpiresAt as number | null,
			deletedObjects: record.deletedObjects as number,
			deletedBytes: record.deletedBytes as number,
			lastError,
		};
	});
}

/** Runtime-independent owner of server claim, enrollment, identity, and vault control-plane policy. */
export class ControlPlaneRuntime {
	private readonly collaboration: CollaborationControlPlane;

	constructor(private readonly storage: ControlPlaneStoragePort) {
		this.collaboration = new CollaborationControlPlane(storage);
	}

	async fetch(request: Request): Promise<Response> {
		try {
			return await this.dispatch(request);
		} catch (error) {
			if (error instanceof CorruptIdentityStateError) {
				return json({
					error: error.code,
					collection: error.collection,
					message: error.message,
				}, 500);
			}
			throw error;
		}
	}

	private async dispatch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "POST" && pathname === "/__yaos/verify-actor") {
			return (await this.collaboration.fetch(new Request("https://internal/__yaos/collaboration/verify-actor", request)))!;
		}
		const collaborationResponse = await this.collaboration.fetch(request);
		if (collaborationResponse) return collaborationResponse;
		if (request.method === "GET" && pathname === "/__yaos/config") return json(await this.readConfig());
		if (request.method === "GET" && pathname === "/__yaos/console") return json(await this.readConsole());
		if (request.method === "GET" && pathname === "/__yaos/vault") return this.handleReadVault(request);
		if (request.method !== "POST") return json({ error: "not found" }, 404);

		switch (pathname) {
			case "/__yaos/claim": return this.handleClaim(request);
			case "/__yaos/update-metadata": return this.handleUpdateMetadata(request);
			case "/__yaos/enroll": return this.handleEnroll(request);
			case "/__yaos/create-pairing-code": return this.handleCreatePairingCode(request);
			case "/__yaos/authorize-device": return this.handleAuthorizeDevice(request);
			case "/__yaos/create-session": return this.handleCreateSession(request);
			case "/__yaos/verify-session": return this.handleVerifySession(request);
			case "/__yaos/revoke-session": return this.handleRevokeSession(request);
			case "/__yaos/verify-operator": return this.handleVerifyOperator(request);
			case "/__yaos/revoke-device": return this.handleRevokeDevice(request);
			case "/__yaos/complete-device-revocation": return this.handleCompleteDeviceRevocation(request);
			case "/__yaos/fail-device-revocation": return this.handleFailDeviceRevocation(request);
			case "/__yaos/rename-device": return this.handleRenameDevice(request);
			case "/__yaos/verify-device": return this.handleVerifyDevice(request);
			case "/__yaos/create-vault": return this.handleCreateVault(request);
			case "/__yaos/activate-vault": return this.handleActivateVault(request);
			case "/__yaos/fail-vault-provisioning": return this.handleFailVaultProvisioning(request);
			case "/__yaos/touch-device": return this.handleTouchDevice(request);
			case "/__yaos/rename-vault": return this.handleRenameVault(request);
			case "/__yaos/destroy-vault": return this.handleDestroyVault(request);
			case "/__yaos/update-destroy-vault": return this.handleUpdateDestroyVault(request);
			case "/__yaos/deletion/progress": return this.handleDeletionProgress(request);
			case "/__yaos/revoke-pairing": return this.handleRevokePairing(request);
			default: return json({ error: "not found" }, 404);
		}
	}

	private async handleClaim(request: Request): Promise<Response> {
		let body: {
			operatorRecoveryHash?: string;
			ticketSigningKey?: string;
			vaultId?: string;
			vaultName?: string;
			pairingCodeHash?: string;
			pairingPurpose?: PairingPurpose;
		};
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (typeof body.operatorRecoveryHash !== "string" || !body.operatorRecoveryHash) {
			return json({ error: "missing operatorRecoveryHash" }, 400);
		}
		if (typeof body.ticketSigningKey !== "string" || !body.ticketSigningKey) {
			return json({ error: "missing ticketSigningKey" }, 400);
		}
		if (typeof body.vaultId !== "string" || !isUsableVaultId(body.vaultId)) {
			return json({ error: "invalid vaultId" }, 400);
		}
		if (
			typeof body.pairingCodeHash !== "string"
			|| body.pairingCodeHash.length < 1
			|| body.pairingCodeHash.length > MAX_HASH_LENGTH
		) {
			return json({ error: "missing pairingCodeHash" }, 400);
		}
		const now = Date.now();
		const vaultId = body.vaultId.trim();
		const vaultName = typeof body.vaultName === "string" && body.vaultName.trim()
			? body.vaultName.trim().slice(0, 80)
			: "Personal";

		return this.storage.transaction(async (txn) => {
			const claimed = await txn.get<boolean>(CLAIMED_KEY);
			const format = await txn.get<number>(CONFIG_FORMAT_KEY);
			if (claimed === true && format !== CONFIG_FORMAT) {
				return json({ error: "server_format_unsupported" }, 409);
			}
			if (claimed === true) {
				const storedHash = await txn.get<string>(OPERATOR_RECOVERY_HASH_KEY);
				const pending = txn.records
					? parseVaultRecords([await txn.records.get(VAULTS_KEY, { state: "provisioning" })].filter(Boolean))[0]
					: parseVaultRecords(await txn.get(VAULTS_KEY)).find((vault) => vault.state === "provisioning");
				if (storedHash === body.operatorRecoveryHash && pending) {
					return json({ ok: true, vaultId: pending.vaultId, vaultGeneration: pending.vaultGeneration, vaultName: pending.name, created: false });
				}
				return json({ error: "already_claimed" }, 403);
			}
			if (format !== undefined) return json({ error: "already_claimed" }, 403);
			const vault: VaultRecord = {
				vaultId,
				name: vaultName,
				state: "provisioning",
				vaultGeneration: randomBase64Url(16),
				createdAt: now,
				provisionedAt: null,
				ownerPrincipalId: null,
			};
			await txn.put(CONFIG_FORMAT_KEY, CONFIG_FORMAT);
			await txn.put(CLAIMED_KEY, true);
			await txn.put(OPERATOR_RECOVERY_HASH_KEY, body.operatorRecoveryHash!);
			await txn.put(TICKET_SIGNING_KEY, body.ticketSigningKey!);
			if (txn.records) await txn.records.upsert(VAULTS_KEY, vault);
			else {
				await txn.put(VAULTS_KEY, [vault]);
				await txn.put(DEVICES_KEY, []);
				await txn.put(PAIRING_CODES_KEY, []);
				await txn.put(SESSIONS_KEY, []);
				await txn.put(PENDING_DESTROYS_KEY, []);
				await txn.put(PENDING_DEVICE_REVOCATIONS_KEY, []);
				await txn.put(ENROLLMENT_REPLAYS_KEY, []);
			}
			await initializeCollaborationStorage(txn);
			return json({ ok: true, vaultId, vaultGeneration: vault.vaultGeneration, vaultName, created: true });
		});
	}

	private async handleReadVault(request: Request): Promise<Response> {
		const vaultId = new URL(request.url).searchParams.get("vaultId");
		if (!vaultId) return json({ error: "invalid vaultId" }, 400);
		const vault = await this.storage.transaction(async (txn) => txn.records
			? parseVaultRecords([await txn.records.get(VAULTS_KEY, { recordKey: vaultId })].filter(Boolean))[0]
			: parseVaultRecords(await txn.get(VAULTS_KEY)).find((record) => record.vaultId === vaultId));
		if (!vault) return json({ error: "unknown_vault" }, 404);
		const lastError = await this.storage.get<string>(`${PROVISIONING_ERROR_KEY_PREFIX}${vaultId}`);
		return json({ vault, provisioningError: typeof lastError === "string" ? lastError : null });
	}

	private async handleActivateVault(request: Request): Promise<Response> {
		let body: {
			vaultId?: string;
			vaultGeneration?: string;
			pairingCodeHash?: string;
			pairingPurpose?: PairingPurpose;
		};
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (!body.vaultId || !body.vaultGeneration) return json({ error: "invalid vault activation" }, 400);
		if (body.pairingCodeHash !== undefined && (
			body.pairingCodeHash.length < 1 || body.pairingCodeHash.length > MAX_HASH_LENGTH
		)) {
			return json({ error: "invalid pairingCodeHash" }, 400);
		}
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const vaultRaw = await txn.records.get<VaultRecord>(VAULTS_KEY, { recordKey: body.vaultId });
				const vault = vaultRaw ? parseVaultRecords([vaultRaw])[0] : undefined;
				if (!vault) return json({ error: "unknown_vault" }, 404);
				if (vault.vaultGeneration !== body.vaultGeneration) return json({ error: "vault_generation_mismatch" }, 409);
				if (vault.state === "deleting" || vault.state === "delete_failed") return json({ error: "vault_deleting" }, 409);
				const now = Date.now();
				if (vault.state === "provisioning") {
					vault.state = vault.ownerPrincipalId ? "active" : "awaiting_owner";
					vault.provisionedAt = now;
					await txn.records.upsert(VAULTS_KEY, vault);
				}
				let pairingExp: number | null = null;
				if (body.pairingCodeHash) {
					const existingRaw = await txn.records.get(PAIRING_CODES_KEY, { codeHash: body.pairingCodeHash });
					const existing = existingRaw ? parsePairingCodeRecords([existingRaw], new Set([vault.vaultId]))[0] : undefined;
					if (existing) pairingExp = existing.exp;
					else {
						pairingExp = now + PAIRING_CODE_TTL_MS;
						await txn.records.upsert(PAIRING_CODES_KEY, {
							codeId: randomBase64Url(12), codeHash: body.pairingCodeHash,
							vaultId: vault.vaultId, exp: pairingExp, maxUses: 1, uses: 0,
							purpose: body.pairingPurpose === "origin" ? "origin" : body.pairingPurpose === "invite" ? "invite" : "device",
							createdAt: now,
						});
					}
				}
				await txn.delete(`${PROVISIONING_ERROR_KEY_PREFIX}${vault.vaultId}`);
				return json({ ok: true, vault, pairingExp });
			}
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const vault = vaults.find((record) => record.vaultId === body.vaultId);
			if (!vault) return json({ error: "unknown_vault" }, 404);
			if (vault.vaultGeneration !== body.vaultGeneration) {
				return json({ error: "vault_generation_mismatch" }, 409);
			}
			if (vault.state === "deleting" || vault.state === "delete_failed") {
				return json({ error: "vault_deleting" }, 409);
			}
			const now = Date.now();
			if (vault.state === "provisioning") {
				vault.state = vault.ownerPrincipalId ? "active" : "awaiting_owner";
				vault.provisionedAt = now;
				await txn.put(VAULTS_KEY, vaults);
			}
			let pairingExp: number | null = null;
			if (body.pairingCodeHash) {
				const vaultIds = new Set(vaults.map((record) => record.vaultId));
				const codes = parsePairingCodeRecords(await txn.get(PAIRING_CODES_KEY), vaultIds)
					.filter((code) => code.exp > now && code.uses < 1);
				const existing = codes.find((code) => code.codeHash === body.pairingCodeHash);
				if (existing) {
					pairingExp = existing.exp;
				} else {
					pairingExp = now + PAIRING_CODE_TTL_MS;
					codes.push({
						codeId: randomBase64Url(12),
						codeHash: body.pairingCodeHash,
						vaultId: vault.vaultId,
						exp: pairingExp,
						maxUses: 1,
						uses: 0,
						purpose: body.pairingPurpose === "origin"
							? "origin"
							: body.pairingPurpose === "invite" ? "invite" : "device",
						createdAt: now,
					});
					await txn.put(PAIRING_CODES_KEY, codes);
				}
			}
			await txn.delete(`${PROVISIONING_ERROR_KEY_PREFIX}${vault.vaultId}`);
			return json({ ok: true, vault, pairingExp });
		});
	}

	private async handleFailVaultProvisioning(request: Request): Promise<Response> {
		let body: { vaultId?: string; vaultGeneration?: string; error?: unknown };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (!body.vaultId || !body.vaultGeneration) return json({ error: "invalid provisioning failure" }, 400);
		const vault = await this.storage.transaction(async (txn) => txn.records
			? parseVaultRecords([await txn.records.get(VAULTS_KEY, { recordKey: body.vaultId })].filter(Boolean))[0]
			: parseVaultRecords(await txn.get(VAULTS_KEY)).find((record) => record.vaultId === body.vaultId));
		if (!vault || vault.vaultGeneration !== body.vaultGeneration) {
			return json({ error: "unknown_vault_generation" }, 404);
		}
		const error = typeof body.error === "string" && body.error.trim()
			? body.error.trim().slice(0, 512)
			: "vault provisioning failed";
		await this.storage.put(`${PROVISIONING_ERROR_KEY_PREFIX}${vault.vaultId}`, error);
		return json({ ok: false, retryable: true, vault, error }, 202);
	}

	private async handleUpdateMetadata(request: Request): Promise<Response> {
		let body: { updateProvider?: unknown; updateRepoUrl?: unknown; updateRepoBranch?: unknown };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		let updateProvider: UpdateProvider | null;
		let updateRepoUrl: string | null;
		let updateRepoBranch: string | null;
		try {
			updateProvider = normalizeUpdateProvider(body.updateProvider);
			updateRepoUrl = normalizeUpdateRepoUrl(body.updateRepoUrl);
			updateRepoBranch = normalizeUpdateRepoBranch(body.updateRepoBranch);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "invalid metadata" }, 400);
		}
		await this.storage.transaction(async (txn) => {
			if (updateProvider !== null) await txn.put(UPDATE_PROVIDER_KEY, updateProvider);
			if (updateRepoUrl !== null) await txn.put(UPDATE_REPO_URL_KEY, updateRepoUrl);
			if (updateRepoBranch !== null) await txn.put(UPDATE_REPO_BRANCH_KEY, updateRepoBranch);
		});
		return json({ ok: true, config: await this.readConfig() });
	}

	private async handleEnroll(request: Request): Promise<Response> {
		let body: {
			enrollmentRequestId?: string;
			pairingCodeHash?: string;
			deviceId?: string;
			deviceTokenHash?: string;
			deviceName?: string;
		};
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (
			typeof body.enrollmentRequestId !== "string"
			|| !/^[A-Za-z0-9_-]{16,128}$/.test(body.enrollmentRequestId)
			|| typeof body.pairingCodeHash !== "string"
			|| !/^[a-f0-9]{64}$/.test(body.pairingCodeHash)
			|| typeof body.deviceId !== "string"
			|| !/^[A-Za-z0-9_-]{1,128}$/.test(body.deviceId)
			|| typeof body.deviceTokenHash !== "string"
			|| !/^[a-f0-9]{64}$/.test(body.deviceTokenHash)
		) {
			return json({ error: "invalid enroll" }, 400);
		}
		const enrollmentRequestId = body.enrollmentRequestId;
		const pairingCodeHash = body.pairingCodeHash;
		const deviceId = body.deviceId;
		const deviceTokenHash = body.deviceTokenHash;
		const desiredName = typeof body.deviceName === "string" && body.deviceName.trim()
			? body.deviceName.trim().slice(0, 50)
			: "unnamed-device";
		return this.storage.transaction(async (txn) => {
			if (txn.records) return this.handleIndexedEnroll(txn, {
				enrollmentRequestId, pairingCodeHash, deviceId, deviceTokenHash, desiredName,
			});
			const now = Date.now();
			const storedReplays = parseEnrollmentReplayRecords(await txn.get(ENROLLMENT_REPLAYS_KEY));
			const replays = storedReplays.filter((record) => record.expiresAt > now);
			if (replays.length !== storedReplays.length) await txn.put(ENROLLMENT_REPLAYS_KEY, replays);
			const replay = replays.find((record) => record.enrollmentRequestId === enrollmentRequestId);
			if (replay) {
				if (
					replay.pairingCodeHash !== pairingCodeHash
					|| replay.deviceId !== deviceId
					|| replay.deviceTokenHash !== deviceTokenHash
				) {
					return json({ error: "enrollment_request_conflict" }, 409);
				}
				const replayVaults = parseVaultRecords(await txn.get(VAULTS_KEY));
				const replayDevices = parseDeviceRecords(await txn.get(DEVICES_KEY), new Set(replayVaults.map((record) => record.vaultId)));
				const replayDevice = replayDevices.find((record) => record.deviceId === replay.deviceId);
				const replayPrincipal = replayDevice?.principalId
					? parsePrincipalRecords(await txn.get("principals")).find((record) => record.principalId === replayDevice.principalId)
					: undefined;
				const replayMembership = replayPrincipal
					? parseMembershipRecords(await txn.get("vaultMemberships")).find((record) => record.principalId === replayPrincipal.principalId && record.vaultId === replay.vaultId)
					: undefined;
				const replayChange = parseAuthorizationChangeRecords(await txn.get("authorizationChanges"))
					.find((record) => record.vaultId === replay.vaultId && record.requestId === enrollmentRequestId);
				return json({
					ok: true,
					vaultId: replay.vaultId,
					vaultGeneration: replay.vaultGeneration,
					deviceId: replay.deviceId,
					deviceName: replay.deviceName,
					originImport: replay.originImport,
					...(replayPrincipal && replayMembership && replayDevice ? {
						principalId: replayPrincipal.principalId,
						role: replayMembership.role,
						membershipRevision: replayMembership.revision,
						deviceCredentialRevision: replayDevice.credentialRevision,
					capabilities: capabilitiesForRole(replayMembership.role),
						change: replayChange,
						principal: replayPrincipal,
						actor: await buildActorContext(replay.vaultGeneration, replayPrincipal, replayMembership, replayDevice),
					} : {}),
					replayed: true,
				});
			}
			if (replays.some((record) => record.pairingCodeHash === pairingCodeHash)) {
				return json({ error: "used_code", message: "This pairing code was already used." }, 409);
			}

			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const vaultIds = new Set(vaults.map((vault) => vault.vaultId));
			const codes = parsePairingCodeRecords(await txn.get(PAIRING_CODES_KEY), vaultIds);
			const devices = parseDeviceRecords(await txn.get(DEVICES_KEY), vaultIds);
			const legacyMatch = findHashedRecord(codes, pairingCodeHash, (code) => code.codeHash);
			const collaborationMatch = findHashedRecord(
				parseCollaborationCodeRecords(await txn.get("collaborationCodes")),
				pairingCodeHash,
				(code) => code.codeHash,
			);
			const match = legacyMatch ?? (collaborationMatch ? {
				codeId: collaborationMatch.codeId,
				codeHash: collaborationMatch.codeHash,
				vaultId: collaborationMatch.vaultId,
				exp: collaborationMatch.expiresAt,
				maxUses: 1,
				uses: collaborationMatch.consumedAt === null ? 0 : 1,
				purpose: collaborationMatch.purpose === "member-invitation" ? "invite" as const
					: collaborationMatch.purpose === "owner-bootstrap" ? "origin" as const : "device" as const,
				createdAt: collaborationMatch.createdAt,
			} : null);
			if (!match) return json({ error: "unknown_code", message: "This pairing code is not recognized." }, 404);
			const vault = vaults.find((record) => record.vaultId === match.vaultId);
			if (!vault || (vault.state !== "active" && vault.state !== "awaiting_owner")) {
				return json({ error: "vault_not_active", message: "This vault is not ready for enrollment." }, 409);
			}
			if (match.exp <= now) return json({ error: "expired_code", message: "This pairing code has expired. Ask for a new one." }, 410);
			if (match.uses >= 1) return json({ error: "used_code", message: "This pairing code was already used." }, 409);
			if (devices.some((device) => device.deviceId === deviceId || device.tokenHash === deviceTokenHash)) {
				return json({ error: "device_exists" }, 409);
			}
			if (devices.length >= MAX_DEVICE_RECORDS) return json({ error: "device_capacity" }, 503);
			if (replays.length >= MAX_ENROLLMENT_REPLAY_RECORDS) return json({ error: "enrollment_replay_capacity" }, 503);
			const name = uniqueDeviceName(
				desiredName,
				devices.filter((device) => device.vaultId === match.vaultId).map((device) => device.name),
			);
			const device: DeviceRecord = {
				deviceId,
				vaultId: match.vaultId,
				principalId: "pending",
				tokenHash: deviceTokenHash,
				credentialRevision: 1,
				name,
				state: "active",
				enrolledAt: now,
				revokedAt: null,
			};
			const identity = await installEnrollmentIdentity(txn, {
				vaultId: match.vaultId,
				device,
				pairingPurpose: match.purpose,
				pairingCodeHash,
				displayName: desiredName,
				enrollmentRequestId,
				requestDigest: await hashSecret(JSON.stringify({ pairingCodeHash, deviceId, deviceTokenHash })),
			});
			if (identity instanceof Response) return identity;
			const replayRecord: EnrollmentReplayRecord = {
				enrollmentRequestId,
				pairingCodeHash,
				deviceId: device.deviceId,
				deviceTokenHash,
				vaultId: device.vaultId,
				vaultGeneration: vault.vaultGeneration,
				deviceName: name,
				originImport: legacyMatch?.purpose === "origin",
				createdAt: now,
				expiresAt: now + ENROLLMENT_REPLAY_TTL_MS,
			};
			devices.push(device);
			replays.push(replayRecord);
			await txn.put(DEVICES_KEY, devices);
			await txn.put(ENROLLMENT_REPLAYS_KEY, replays);
			await txn.put(PAIRING_CODES_KEY, codes.filter((code) => code !== match && code.exp > now && code.uses < 1));
			return json({
				ok: true,
				vaultId: replayRecord.vaultId,
				vaultGeneration: replayRecord.vaultGeneration,
				deviceId: replayRecord.deviceId,
				deviceName: replayRecord.deviceName,
				originImport: replayRecord.originImport,
				principalId: identity.principal.principalId,
				role: identity.membership.role,
				membershipRevision: identity.membership.revision,
				deviceCredentialRevision: identity.device.credentialRevision,
				capabilities: capabilitiesForRole(identity.membership.role),
				change: identity.change,
				principal: identity.principal,
				actor: await buildActorContext(vault.vaultGeneration, identity.principal, identity.membership, identity.device),
				replayed: false,
			});
		});
	}

	private async handleIndexedEnroll(txn: ControlPlaneTransactionPort, input: {
		enrollmentRequestId: string;
		pairingCodeHash: string;
		deviceId: string;
		deviceTokenHash: string;
		desiredName: string;
	}): Promise<Response> {
		const records = txn.records!;
		const now = Date.now();
		await records.deleteWhere(ENROLLMENT_REPLAYS_KEY, { expiresAtOrBefore: now });
		const replayRaw = await records.get<EnrollmentReplayRecord>(ENROLLMENT_REPLAYS_KEY, {
			recordKey: input.enrollmentRequestId,
		});
		const replay = replayRaw ? parseEnrollmentReplayRecords([replayRaw])[0] : undefined;
		if (replay) {
			if (replay.pairingCodeHash !== input.pairingCodeHash
				|| replay.deviceId !== input.deviceId
				|| replay.deviceTokenHash !== input.deviceTokenHash) {
				return json({ error: "enrollment_request_conflict" }, 409);
			}
			const replayDeviceRaw = await records.get<DeviceRecord>(DEVICES_KEY, { recordKey: replay.deviceId });
			const replayDevice = replayDeviceRaw
				? parseDeviceRecords([replayDeviceRaw], new Set([replay.vaultId]))[0]
				: undefined;
			const replayPrincipalRaw = replayDevice?.principalId
				? await records.get("principals", { recordKey: replayDevice.principalId })
				: undefined;
			const replayPrincipal = replayPrincipalRaw ? parsePrincipalRecords([replayPrincipalRaw])[0] : undefined;
			const replayMembershipRaw = replayPrincipal
				? await records.get("vaultMemberships", { vaultId: replay.vaultId, principalId: replayPrincipal.principalId })
				: undefined;
			const replayMembership = replayMembershipRaw ? parseMembershipRecords([replayMembershipRaw])[0] : undefined;
			const replayChangeRaw = await records.get("authorizationChanges", {
				vaultId: replay.vaultId, requestId: input.enrollmentRequestId,
			});
			const replayChange = replayChangeRaw ? parseAuthorizationChangeRecords([replayChangeRaw])[0] : undefined;
			return json({
				ok: true, vaultId: replay.vaultId, vaultGeneration: replay.vaultGeneration,
				deviceId: replay.deviceId, deviceName: replay.deviceName, originImport: replay.originImport,
				...(replayPrincipal && replayMembership && replayDevice ? {
					principalId: replayPrincipal.principalId,
					role: replayMembership.role,
					membershipRevision: replayMembership.revision,
					deviceCredentialRevision: replayDevice.credentialRevision,
					capabilities: capabilitiesForRole(replayMembership.role),
					change: replayChange,
					principal: replayPrincipal,
					actor: await buildActorContext(replay.vaultGeneration, replayPrincipal, replayMembership, replayDevice),
				} : {}),
				replayed: true,
			});
		}
		if (await records.get(ENROLLMENT_REPLAYS_KEY, { pairingCodeHash: input.pairingCodeHash })) {
			return json({ error: "used_code", message: "This pairing code was already used." }, 409);
		}

		const legacyRaw = await records.get(PAIRING_CODES_KEY, { codeHash: input.pairingCodeHash });
		const legacyMatch = legacyRaw ? parsePairingCodeRecords([legacyRaw], new Set([String((legacyRaw as { vaultId?: unknown }).vaultId)]))[0] : undefined;
		const collaborationRaw = await records.get("collaborationCodes", { codeHash: input.pairingCodeHash });
		const collaborationMatch = collaborationRaw ? parseCollaborationCodeRecords([collaborationRaw])[0] : undefined;
		const match = legacyMatch ?? (collaborationMatch ? {
			codeId: collaborationMatch.codeId, codeHash: collaborationMatch.codeHash,
			vaultId: collaborationMatch.vaultId, exp: collaborationMatch.expiresAt, maxUses: 1,
			uses: collaborationMatch.consumedAt === null ? 0 : 1,
			purpose: collaborationMatch.purpose === "member-invitation" ? "invite" as const
				: collaborationMatch.purpose === "owner-bootstrap" ? "origin" as const : "device" as const,
			createdAt: collaborationMatch.createdAt,
		} : null);
		if (!match) return json({ error: "unknown_code", message: "This pairing code is not recognized." }, 404);
		const vaultRaw = await records.get<VaultRecord>(VAULTS_KEY, { recordKey: match.vaultId });
		const vault = vaultRaw ? parseVaultRecords([vaultRaw])[0] : undefined;
		if (!vault || (vault.state !== "active" && vault.state !== "awaiting_owner")) {
			return json({ error: "vault_not_active", message: "This vault is not ready for enrollment." }, 409);
		}
		if (match.exp <= now) return json({ error: "expired_code", message: "This pairing code has expired. Ask for a new one." }, 410);
		if (match.uses >= 1) return json({ error: "used_code", message: "This pairing code was already used." }, 409);
		if (await records.get(DEVICES_KEY, { recordKey: input.deviceId })
			|| await records.get(DEVICES_KEY, { tokenHash: input.deviceTokenHash })) {
			return json({ error: "device_exists" }, 409);
		}
		if (await records.count(DEVICES_KEY) >= MAX_DEVICE_RECORDS) return json({ error: "device_capacity" }, 503);
		if (await records.count(ENROLLMENT_REPLAYS_KEY) >= MAX_ENROLLMENT_REPLAY_RECORDS) return json({ error: "enrollment_replay_capacity" }, 503);
		const vaultDeviceRaw = await records.list<DeviceRecord>(DEVICES_KEY, { vaultId: match.vaultId, limit: MAX_DEVICE_RECORDS });
		const vaultDevices = parseDeviceRecords(vaultDeviceRaw, new Set([match.vaultId]));
		const name = uniqueDeviceName(input.desiredName, vaultDevices.map((device) => device.name));
		const device: DeviceRecord = {
			deviceId: input.deviceId, vaultId: match.vaultId, principalId: "pending",
			tokenHash: input.deviceTokenHash, credentialRevision: 1, name,
			state: "active", enrolledAt: now, revokedAt: null,
		};
		const identity = await installEnrollmentIdentity(txn, {
			vaultId: match.vaultId, device, pairingPurpose: match.purpose,
			pairingCodeHash: input.pairingCodeHash, displayName: input.desiredName,
			enrollmentRequestId: input.enrollmentRequestId,
			requestDigest: await hashSecret(JSON.stringify({
				pairingCodeHash: input.pairingCodeHash, deviceId: input.deviceId,
				deviceTokenHash: input.deviceTokenHash,
			})),
		});
		if (identity instanceof Response) return identity;
		const replayRecord: EnrollmentReplayRecord = {
			enrollmentRequestId: input.enrollmentRequestId, pairingCodeHash: input.pairingCodeHash,
			deviceId: device.deviceId, deviceTokenHash: input.deviceTokenHash,
			vaultId: device.vaultId, vaultGeneration: vault.vaultGeneration,
			deviceName: name, originImport: legacyMatch?.purpose === "origin",
			createdAt: now, expiresAt: now + ENROLLMENT_REPLAY_TTL_MS,
		};
		await records.upsert(DEVICES_KEY, device);
		await records.upsert(ENROLLMENT_REPLAYS_KEY, replayRecord);
		if (legacyMatch) await records.delete(PAIRING_CODES_KEY, legacyMatch.codeId);
		return json({
			ok: true, vaultId: replayRecord.vaultId, vaultGeneration: replayRecord.vaultGeneration,
			deviceId: replayRecord.deviceId, deviceName: replayRecord.deviceName,
			originImport: replayRecord.originImport, principalId: identity.principal.principalId,
			role: identity.membership.role, membershipRevision: identity.membership.revision,
			deviceCredentialRevision: identity.device.credentialRevision,
			capabilities: capabilitiesForRole(identity.membership.role), change: identity.change,
			principal: identity.principal,
			actor: await buildActorContext(vault.vaultGeneration, identity.principal, identity.membership, identity.device),
			replayed: false,
		});
	}

	private async handleCreatePairingCode(request: Request): Promise<Response> {
		let body: { vaultId?: string; codeHash?: string; purpose?: PairingPurpose };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (
			typeof body.vaultId !== "string"
			|| typeof body.codeHash !== "string"
			|| body.codeHash.length < 1
			|| body.codeHash.length > MAX_HASH_LENGTH
		) {
			return json({ error: "invalid pairing code" }, 400);
		}
		const now = Date.now();
		const exp = now + PAIRING_CODE_TTL_MS;
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const vaultRaw = await txn.records.get<VaultRecord>(VAULTS_KEY, { recordKey: body.vaultId });
				const vault = vaultRaw ? parseVaultRecords([vaultRaw])[0] : undefined;
				if (!vault) return json({ error: "unknown_vault" }, 404);
				if (vault.state !== "active") return json({ error: "vault_not_active" }, 409);
				const existingRaw = await txn.records.get(PAIRING_CODES_KEY, { codeHash: body.codeHash });
				const existing = existingRaw ? parsePairingCodeRecords([existingRaw], new Set([vault.vaultId]))[0] : undefined;
				if (existing && existing.exp > now && existing.uses < 1) {
					return json({ error: "pairing_code_exists" }, 409);
				}
				await txn.records.deleteWhere(PAIRING_CODES_KEY, { expiresAtOrBefore: now });
				if (await txn.records.count(PAIRING_CODES_KEY) >= MAX_PAIRING_CODE_RECORDS) {
					return json({ error: "pairing_code_capacity" }, 503);
				}
				const codeId = randomBase64Url(12);
				if (await txn.records.get(PAIRING_CODES_KEY, { recordKey: codeId })) {
					return json({ error: "pairing_code_id_collision" }, 503);
				}
				await txn.records.upsert(PAIRING_CODES_KEY, {
					codeId, codeHash: body.codeHash, vaultId: body.vaultId, exp, maxUses: 1, uses: 0,
					purpose: body.purpose === "invite" ? "invite" : "device", createdAt: now,
				});
				return json({ ok: true, exp });
			}
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const vaultIds = new Set(vaults.map((vault) => vault.vaultId));
			const vault = vaults.find((record) => record.vaultId === body.vaultId);
			if (!vault) return json({ error: "unknown_vault" }, 404);
			if (vault.state !== "active") return json({ error: "vault_not_active" }, 409);
			const codes = parsePairingCodeRecords(await txn.get(PAIRING_CODES_KEY), vaultIds)
				.filter((code) => code.exp > now && code.uses < 1);
			if (codes.some((code) => code.codeHash === body.codeHash)) {
				return json({ error: "pairing_code_exists" }, 409);
			}
			if (codes.length >= MAX_PAIRING_CODE_RECORDS) return json({ error: "pairing_code_capacity" }, 503);
			const codeId = randomBase64Url(12);
			if (codes.some((code) => code.codeId === codeId)) {
				return json({ error: "pairing_code_id_collision" }, 503);
			}
			codes.push({
				codeId,
				codeHash: body.codeHash!,
				vaultId: body.vaultId!,
				exp,
				maxUses: 1,
				uses: 0,
				purpose: body.purpose === "invite" ? "invite" : "device",
				createdAt: now,
			});
			await txn.put(PAIRING_CODES_KEY, codes);
			return json({ ok: true, exp });
		});
	}

	private async handleAuthorizeDevice(request: Request): Promise<Response> {
		let body: { tokenHash?: string; vaultId?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "unauthorized" }, 401);
		}
		if (!body.tokenHash) return json({ error: "unauthorized" }, 401);
		const collaboration = await this.collaboration.fetch(new Request("https://internal/__yaos/collaboration/authorize", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}));
		if (collaboration?.ok) return collaboration;
		const { device, vault } = await this.storage.transaction(async (txn) => {
			if (txn.records) {
				const rawDevice = await txn.records.get<DeviceRecord>(DEVICES_KEY, { tokenHash: body.tokenHash });
				if (!rawDevice) return { device: undefined, vault: undefined };
				const parsedDevice = parseDeviceRecords([rawDevice], new Set([rawDevice.vaultId]))[0]!;
				const rawVault = await txn.records.get<VaultRecord>(VAULTS_KEY, { recordKey: parsedDevice.vaultId });
				return { device: parsedDevice, vault: rawVault ? parseVaultRecords([rawVault])[0] : undefined };
			}
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const devices = parseDeviceRecords(await txn.get(DEVICES_KEY), new Set(vaults.map((item) => item.vaultId)));
			const parsedDevice = findHashedRecord(devices, body.tokenHash!, (record) => record.tokenHash);
			return { device: parsedDevice, vault: parsedDevice ? vaults.find((item) => item.vaultId === parsedDevice.vaultId) : undefined };
		});
		if (!device || device.principalId || vault?.state !== "active" || (body.vaultId !== undefined && device.vaultId !== body.vaultId)) {
			return json({ error: "unauthorized" }, 401);
		}
		return json({ ok: true, device: toDevicePublic(device) });
	}

	private async handleCreateSession(request: Request): Promise<Response> {
		let body: { sessionHash?: string; exp?: number };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		const now = Date.now();
		if (
			typeof body.sessionHash !== "string"
			|| body.sessionHash.length < 1
			|| body.sessionHash.length > MAX_HASH_LENGTH
			|| !Number.isSafeInteger(body.exp)
			|| body.exp! <= now
		) {
			return json({ error: "invalid session" }, 400);
		}
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const existingRaw = await txn.records.get(SESSIONS_KEY, { recordKey: body.sessionHash });
				const existing = existingRaw ? parseOperatorSessionRecords([existingRaw])[0] : undefined;
				if (existing && existing.exp > now) {
					return json({ error: "session_exists" }, 409);
				}
				await txn.records.deleteWhere(SESSIONS_KEY, { expiresAtOrBefore: now });
				if (await txn.records.count(SESSIONS_KEY) >= MAX_OPERATOR_SESSION_RECORDS) {
					return json({ error: "session_capacity" }, 503);
				}
				await txn.records.upsert(SESSIONS_KEY, { sessionHash: body.sessionHash, exp: body.exp, createdAt: now });
				return json({ ok: true });
			}
			const sessions = parseOperatorSessionRecords(await txn.get(SESSIONS_KEY))
				.filter((session) => session.exp > now);
			if (sessions.some((session) => session.sessionHash === body.sessionHash)) {
				return json({ error: "session_exists" }, 409);
			}
			if (sessions.length >= MAX_OPERATOR_SESSION_RECORDS) return json({ error: "session_capacity" }, 503);
			sessions.push({ sessionHash: body.sessionHash!, exp: body.exp!, createdAt: now });
			await txn.put(SESSIONS_KEY, sessions);
			return json({ ok: true });
		});
	}

	private async handleVerifySession(request: Request): Promise<Response> {
		let body: { sessionHash?: string };
		try {
			body = await request.json();
		} catch {
			return json({ ok: false }, 401);
		}
		if (!body.sessionHash) return json({ ok: false }, 401);
		const match = await this.storage.transaction(async (txn) => {
			if (txn.records) {
				const raw = await txn.records.get(SESSIONS_KEY, { recordKey: body.sessionHash });
				return raw ? parseOperatorSessionRecords([raw])[0] : undefined;
			}
			return findHashedRecord(parseOperatorSessionRecords(await txn.get(SESSIONS_KEY)), body.sessionHash!, (session) => session.sessionHash);
		});
		return match && match.exp > Date.now() ? json({ ok: true }) : json({ ok: false }, 401);
	}
	private async handleRevokeSession(request: Request): Promise<Response> {
		let body: { sessionHash?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (!body.sessionHash) return json({ error: "invalid session" }, 400);
		const now = Date.now();
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				await txn.records.deleteWhere(SESSIONS_KEY, { expiresAtOrBefore: now });
				const match = await txn.records.get(SESSIONS_KEY, { recordKey: body.sessionHash });
				if (!match) return json({ error: "unknown_session" }, 404);
				await txn.records.delete(SESSIONS_KEY, body.sessionHash!);
				return json({ ok: true });
			}
			const sessions = parseOperatorSessionRecords(await txn.get(SESSIONS_KEY));
			const match = findHashedRecord(sessions, body.sessionHash!, (session) => session.sessionHash);
			const next = sessions.filter((session) => session.exp > now && session !== match);
			await txn.put(SESSIONS_KEY, next);
			return match ? json({ ok: true }) : json({ error: "unknown_session" }, 404);
		});
	}


	private async handleVerifyOperator(request: Request): Promise<Response> {
		let body: { operatorRecoveryHash?: string };
		try {
			body = await request.json();
		} catch {
			return json({ ok: false }, 401);
		}
		const stored = await this.storage.get<string>(OPERATOR_RECOVERY_HASH_KEY);
		if (
			typeof body.operatorRecoveryHash !== "string" || typeof stored !== "string"
			|| !findHashedRecord([{ hash: stored }], body.operatorRecoveryHash, (record) => record.hash)
		) {
			return json({ ok: false }, 401);
		}
		return json({ ok: true });
	}

	private async handleRevokeDevice(request: Request): Promise<Response> {
		let body: { deviceId?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (typeof body.deviceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.deviceId)) {
			return json({ error: "invalid deviceId" }, 400);
		}
		const deviceId = body.deviceId;
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const pendingRaw = await txn.records.get<PendingDeviceRevocationRecord>(PENDING_DEVICE_REVOCATIONS_KEY, { recordKey: deviceId });
				const existing = pendingRaw ? parsePendingDeviceRevocationRecords([pendingRaw])[0] : undefined;
				const deviceRaw = await txn.records.get<DeviceRecord>(DEVICES_KEY, { recordKey: deviceId });
				if (!deviceRaw) return existing
					? json({ ok: true, membershipRevoked: true, revocation: existing })
					: json({ error: "unknown_device" }, 404);
				const device = parseDeviceRecords([deviceRaw], new Set([deviceRaw.vaultId]))[0]!;
				if (device.principalId) return json({ error: "collaboration_authority_required" }, 409);
				const vaultRaw = await txn.records.get<VaultRecord>(VAULTS_KEY, { recordKey: device.vaultId });
				const vault = vaultRaw ? parseVaultRecords([vaultRaw])[0] : undefined;
				if (!vault) return json({ error: "unknown_vault" }, 409);
				if (!existing && await txn.records.count(PENDING_DEVICE_REVOCATIONS_KEY) >= MAX_PENDING_DEVICE_REVOCATIONS) {
					return json({ error: "pending_device_revocation_capacity" }, 503);
				}
				const revocation: PendingDeviceRevocationRecord = existing ?? {
					vaultId: device.vaultId, vaultGeneration: vault.vaultGeneration,
					deviceId: device.deviceId, requestedAt: Date.now(), lastError: null,
				};
				if (!existing) await txn.records.upsert(PENDING_DEVICE_REVOCATIONS_KEY, revocation);
				await txn.records.delete(DEVICES_KEY, device.deviceId);
				return json({ ok: true, membershipRevoked: true, device: toDevicePublic(device), revocation });
			}
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const devices = parseDeviceRecords(
				await txn.get(DEVICES_KEY),
				new Set(vaults.map((vault) => vault.vaultId)),
			);
			const pendingRevocations = parsePendingDeviceRevocationRecords(
				await txn.get(PENDING_DEVICE_REVOCATIONS_KEY),
			);
			const existing = pendingRevocations.find((record) => record.deviceId === deviceId);
			const device = devices.find((record) => record.deviceId === deviceId);
			if (!device) {
				return existing
					? json({ ok: true, membershipRevoked: true, revocation: existing })
					: json({ error: "unknown_device" }, 404);
			}
			if (device.principalId) return json({ error: "collaboration_authority_required" }, 409);
			const vault = vaults.find((record) => record.vaultId === device.vaultId);
			if (!vault) return json({ error: "unknown_vault" }, 409);
			if (pendingRevocations.length >= MAX_PENDING_DEVICE_REVOCATIONS && !existing) {
				return json({ error: "pending_device_revocation_capacity" }, 503);
			}
			const revocation: PendingDeviceRevocationRecord = existing ?? {
				vaultId: device.vaultId,
				vaultGeneration: vault.vaultGeneration,
				deviceId: device.deviceId,
				requestedAt: Date.now(),
				lastError: null,
			};
			if (!existing) pendingRevocations.push(revocation);
			await txn.put(PENDING_DEVICE_REVOCATIONS_KEY, pendingRevocations);
			await txn.put(DEVICES_KEY, devices.filter((record) => record !== device));
			return json({
				ok: true,
				membershipRevoked: true,
				device: toDevicePublic(device),
				revocation,
			});
		});
	}

	private async handleCompleteDeviceRevocation(request: Request): Promise<Response> {
		let body: { vaultId?: string; vaultGeneration?: string; deviceId?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (
			typeof body.vaultId !== "string" || !isUsableVaultId(body.vaultId) || body.vaultId.trim() !== body.vaultId
			|| typeof body.vaultGeneration !== "string" || !isUsableVaultId(body.vaultGeneration)
			|| body.vaultGeneration.trim() !== body.vaultGeneration
			|| typeof body.deviceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.deviceId)
		) {
			return json({ error: "invalid device revocation" }, 400);
		}
		const identity = {
			vaultId: body.vaultId,
			vaultGeneration: body.vaultGeneration,
			deviceId: body.deviceId,
		};
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const raw = await txn.records.get<PendingDeviceRevocationRecord>(PENDING_DEVICE_REVOCATIONS_KEY, { recordKey: identity.deviceId });
				const match = raw ? parsePendingDeviceRevocationRecords([raw])[0] : undefined;
				if (!match || match.vaultId !== identity.vaultId || match.vaultGeneration !== identity.vaultGeneration) {
					return json({ error: "unknown_device_revocation" }, 404);
				}
				await txn.records.delete(PENDING_DEVICE_REVOCATIONS_KEY, identity.deviceId);
				return json({ ok: true, completed: true });
			}
			const pending = parsePendingDeviceRevocationRecords(await txn.get(PENDING_DEVICE_REVOCATIONS_KEY));
			const match = pending.find((record) =>
				record.vaultId === identity.vaultId
				&& record.vaultGeneration === identity.vaultGeneration
				&& record.deviceId === identity.deviceId);
			if (!match) return json({ error: "unknown_device_revocation" }, 404);
			await txn.put(PENDING_DEVICE_REVOCATIONS_KEY, pending.filter((record) => record !== match));
			return json({ ok: true, completed: true });
		});
	}

	private async handleFailDeviceRevocation(request: Request): Promise<Response> {
		let body: { vaultId?: string; vaultGeneration?: string; deviceId?: string; lastError?: unknown };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (
			typeof body.vaultId !== "string" || !isUsableVaultId(body.vaultId) || body.vaultId.trim() !== body.vaultId
			|| typeof body.vaultGeneration !== "string" || !isUsableVaultId(body.vaultGeneration)
			|| body.vaultGeneration.trim() !== body.vaultGeneration
			|| typeof body.deviceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.deviceId)
		) {
			return json({ error: "invalid device revocation" }, 400);
		}
		const identity = {
			vaultId: body.vaultId,
			vaultGeneration: body.vaultGeneration,
			deviceId: body.deviceId,
		};
		const lastError = boundedRevocationError(body.lastError);
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const raw = await txn.records.get<PendingDeviceRevocationRecord>(PENDING_DEVICE_REVOCATIONS_KEY, { recordKey: identity.deviceId });
				const match = raw ? parsePendingDeviceRevocationRecords([raw])[0] : undefined;
				if (!match || match.vaultId !== identity.vaultId || match.vaultGeneration !== identity.vaultGeneration) {
					return json({ error: "unknown_device_revocation" }, 404);
				}
				match.lastError = lastError;
				await txn.records.upsert(PENDING_DEVICE_REVOCATIONS_KEY, match);
				return json({ ok: false, completed: false, revocation: match }, 202);
			}
			const pending = parsePendingDeviceRevocationRecords(await txn.get(PENDING_DEVICE_REVOCATIONS_KEY));
			const match = pending.find((record) =>
				record.vaultId === identity.vaultId
				&& record.vaultGeneration === identity.vaultGeneration
				&& record.deviceId === identity.deviceId);
			if (!match) return json({ error: "unknown_device_revocation" }, 404);
			match.lastError = lastError;
			await txn.put(PENDING_DEVICE_REVOCATIONS_KEY, pending);
			return json({ ok: false, completed: false, revocation: match }, 202);
		});
	}

	private async handleRenameDevice(request: Request): Promise<Response> {
		let body: { deviceId?: string; name?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!body.deviceId) return json({ error: "invalid deviceId" }, 400);
		if (name.length < 1 || name.length > 50) return json({ error: "invalid name" }, 400);
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const raw = await txn.records.get<DeviceRecord>(DEVICES_KEY, { recordKey: body.deviceId });
				const device = raw ? parseDeviceRecords([raw], new Set([raw.vaultId]))[0] : undefined;
				if (!device) return json({ error: "unknown_device" }, 404);
				const siblingRaw = await txn.records.list<DeviceRecord>(DEVICES_KEY, { vaultId: device.vaultId, limit: MAX_DEVICE_RECORDS });
				const siblings = parseDeviceRecords(siblingRaw, new Set([device.vaultId]));
				device.name = uniqueDeviceName(name, siblings.filter((record) => record.deviceId !== device.deviceId).map((record) => record.name));
				await txn.records.upsert(DEVICES_KEY, device);
				return json({ ok: true, device: toDevicePublic(device) });
			}
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const devices = parseDeviceRecords(
				await txn.get(DEVICES_KEY),
				new Set(vaults.map((vault) => vault.vaultId)),
			);
			const device = devices.find((record) => record.deviceId === body.deviceId);
			if (!device) return json({ error: "unknown_device" }, 404);
			device.name = uniqueDeviceName(
				name,
				devices.filter((record) => record.vaultId === device.vaultId && record !== device).map((record) => record.name),
			);
			await txn.put(DEVICES_KEY, devices);
			return json({ ok: true, device: toDevicePublic(device) });
		});
	}

	private async handleVerifyDevice(request: Request): Promise<Response> {
		let body: { deviceId?: string; vaultId?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "unauthorized" }, 401);
		}
		if (!body.deviceId || !body.vaultId) return json({ error: "unauthorized" }, 401);
		const authorized = await this.storage.transaction(async (txn) => {
			if (txn.records) {
				const vaultRaw = await txn.records.get<VaultRecord>(VAULTS_KEY, { recordKey: body.vaultId });
				const deviceRaw = await txn.records.get<DeviceRecord>(DEVICES_KEY, { recordKey: body.deviceId });
				return vaultRaw?.state === "active" && deviceRaw?.vaultId === body.vaultId;
			}
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const devices = parseDeviceRecords(await txn.get(DEVICES_KEY), new Set(vaults.map((vault) => vault.vaultId)));
			return vaults.some((record) => record.vaultId === body.vaultId && record.state === "active")
				&& devices.some((device) => device.deviceId === body.deviceId && device.vaultId === body.vaultId);
		});
		return authorized
			? json({ ok: true })
			: json({ error: "unauthorized" }, 401);
	}

	private async handleCreateVault(request: Request): Promise<Response> {
		let body: { vaultId?: string; name?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (typeof body.vaultId !== "string" || !isUsableVaultId(body.vaultId)) {
			return json({ error: "invalid vaultId" }, 400);
		}
		const vaultId = body.vaultId.trim();
		const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Vault";
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				if (await txn.records.get(PENDING_DESTROYS_KEY, { recordKey: vaultId })) return json({ error: "vault_destroy_pending" }, 409);
				if (await txn.records.get(VAULTS_KEY, { recordKey: vaultId })) return json({ error: "vault_exists" }, 409);
				if (await txn.records.count(VAULTS_KEY) >= MAX_VAULT_RECORDS) return json({ error: "vault_capacity" }, 503);
				const vault: VaultRecord = {
					vaultId, name, state: "provisioning", vaultGeneration: randomBase64Url(16),
					createdAt: Date.now(), provisionedAt: null, ownerPrincipalId: null,
				};
				await txn.records.upsert(VAULTS_KEY, vault);
				return json({ ok: true, vault });
			}
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const pendingDestroys = parsePendingDestroyRecords(
				await txn.get(PENDING_DESTROYS_KEY),
				new Set(vaults.filter((vault) => vault.state !== "deleting" && vault.state !== "delete_failed").map((vault) => vault.vaultId)),
			);
			if (pendingDestroys.some((record) => record.vaultId === vaultId)) {
				return json({ error: "vault_destroy_pending" }, 409);
			}
			if (vaults.some((vault) => vault.vaultId === vaultId)) return json({ error: "vault_exists" }, 409);
			if (vaults.length >= MAX_VAULT_RECORDS) return json({ error: "vault_capacity" }, 503);
			const vault: VaultRecord = {
				vaultId,
				name,
				state: "provisioning",
				vaultGeneration: randomBase64Url(16),
				createdAt: Date.now(),
				provisionedAt: null,
				ownerPrincipalId: null,
			};
			vaults.push(vault);
			await txn.put(VAULTS_KEY, vaults);
			return json({ ok: true, vault });
		});
	}

	private async handleTouchDevice(request: Request): Promise<Response> {
		let body: { deviceId?: string; vaultId?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (!body.deviceId || !body.vaultId) return json({ error: "invalid device" }, 400);
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const raw = await txn.records.get<DeviceRecord>(DEVICES_KEY, { recordKey: body.deviceId });
				const device = raw ? parseDeviceRecords([raw], new Set([raw.vaultId]))[0] : undefined;
				if (!device || device.vaultId !== body.vaultId) return json({ error: "unknown_device" }, 404);
				device.lastSeenAt = Date.now();
				await txn.records.upsert(DEVICES_KEY, device);
				return json({ ok: true });
			}
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const devices = parseDeviceRecords(
				await txn.get(DEVICES_KEY),
				new Set(vaults.map((vault) => vault.vaultId)),
			);
			const device = devices.find((record) => record.deviceId === body.deviceId && record.vaultId === body.vaultId);
			if (!device) return json({ error: "unknown_device" }, 404);
			device.lastSeenAt = Date.now();
			await txn.put(DEVICES_KEY, devices);
			return json({ ok: true });
		});
	}

	private async handleRenameVault(request: Request): Promise<Response> {
		let body: { vaultId?: string; name?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!body.vaultId) return json({ error: "invalid vaultId" }, 400);
		if (name.length < 1 || name.length > 80) return json({ error: "invalid name" }, 400);
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const raw = await txn.records.get<VaultRecord>(VAULTS_KEY, { recordKey: body.vaultId });
				const vault = raw ? parseVaultRecords([raw])[0] : undefined;
				if (!vault) return json({ error: "unknown_vault" }, 404);
				vault.name = name;
				await txn.records.upsert(VAULTS_KEY, vault);
				return json({ ok: true, vault });
			}
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const vault = vaults.find((record) => record.vaultId === body.vaultId);
			if (!vault) return json({ error: "unknown_vault" }, 404);
			vault.name = name;
			await txn.put(VAULTS_KEY, vaults);
			return json({ ok: true, vault });
		});
	}

	private async handleDestroyVault(request: Request): Promise<Response> {
		let body: { vaultId?: string; governanceRequestId?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (typeof body.vaultId !== "string" || !isUsableVaultId(body.vaultId)) {
			return json({ error: "invalid vaultId" }, 400);
		}
		if (typeof body.governanceRequestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.governanceRequestId)) {
			return json({ error: "destroy_confirmation_required" }, 409);
		}
		const vaultId = body.vaultId.trim();
		return this.storage.transaction(async (txn) => {
			if (txn.records) return this.handleIndexedDestroyVault(txn, vaultId, body.governanceRequestId!);
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const vaultIds = new Set(vaults.map((vault) => vault.vaultId));
			const nonDeletingVaultIds = new Set(
				vaults.filter((vault) => vault.state === "active" || vault.state === "provisioning").map((vault) => vault.vaultId),
			);
			const pendingDestroys = parsePendingDestroyRecords(await txn.get(PENDING_DESTROYS_KEY), nonDeletingVaultIds);
			const devices = parseDeviceRecords(await txn.get(DEVICES_KEY), vaultIds);
			const codes = parsePairingCodeRecords(await txn.get(PAIRING_CODES_KEY), vaultIds);
			const pendingRevocations = parsePendingDeviceRevocationRecords(
				await txn.get(PENDING_DEVICE_REVOCATIONS_KEY),
			);
			const enrollmentReplays = parseEnrollmentReplayRecords(await txn.get(ENROLLMENT_REPLAYS_KEY));
			const pending = pendingDestroys.find((record) => record.vaultId === vaultId);
			const governanceRequests = parseVaultGovernanceRequestRecords(await txn.get("vaultGovernanceRequests"));
			const governance = governanceRequests.find((record) => record.vaultId === vaultId
				&& record.governanceRequestId === body.governanceRequestId && record.kind !== "vault-rename");
			if (!governance || (governance.state !== "confirmed" && governance.state !== "executing")) {
				return json({ error: "destroy_confirmation_required" }, 409);
			}
			if (pending) return json({ ok: true, pending });

			const vault = vaults.find((record) => record.vaultId === vaultId);
			if (!vault) return json({ error: "unknown_vault" }, 404);
			if (pendingDestroys.length >= MAX_PENDING_DESTROYS) {
				return json({ error: "pending_destroy_capacity" }, 503);
			}

			const deletionId = randomBase64Url(16);
			const record: PendingDestroyRecord = {
				vaultId,
				vaultGeneration: vault.vaultGeneration,
				deletionId,
				purgeJobId: `purge:${vaultId}:${vault.vaultGeneration}`,
				requestedAt: Date.now(),
				roomComplete: false,
				r2Complete: false,
				purgeState: "pending",
				capabilityHash: null,
				capabilityExpiresAt: null,
				deletedObjects: 0,
				deletedBytes: 0,
				lastError: null,
			};
			vault.state = "deleting";
			governance.state = "executing";
			governance.lastError = null;
			const nextDevices = devices.filter((device) => device.vaultId !== vaultId);
			const nextCodes = codes.filter((code) => code.vaultId !== vaultId);
			await txn.put(PENDING_DESTROYS_KEY, [...pendingDestroys, record]);
			await txn.put(VAULTS_KEY, vaults);
			await txn.put(DEVICES_KEY, nextDevices);
			await txn.put(PAIRING_CODES_KEY, nextCodes);
			await txn.put(
				PENDING_DEVICE_REVOCATIONS_KEY,
				pendingRevocations.filter((revocation) => revocation.vaultId !== vaultId),
			);
			await txn.put(
				ENROLLMENT_REPLAYS_KEY,
				enrollmentReplays.filter((replay) => replay.vaultId !== vaultId),
			);
			await txn.put("vaultGovernanceRequests", governanceRequests);
			return json({ ok: true, pending: record });
		});
	}

	private async handleIndexedDestroyVault(
		txn: ControlPlaneTransactionPort,
		vaultId: string,
		governanceRequestId: string,
	): Promise<Response> {
		const records = txn.records!;
		const governanceRaw = await records.get("vaultGovernanceRequests", { recordKey: governanceRequestId });
		const governance = governanceRaw ? parseVaultGovernanceRequestRecords([governanceRaw])[0] : undefined;
		if (!governance || governance.vaultId !== vaultId || governance.kind === "vault-rename"
			|| (governance.state !== "confirmed" && governance.state !== "executing")) {
			return json({ error: "destroy_confirmation_required" }, 409);
		}
		const pendingRaw = await records.get<PendingDestroyRecord>(PENDING_DESTROYS_KEY, { recordKey: vaultId });
		if (pendingRaw) {
			const pending = parsePendingDestroyRecords([pendingRaw])[0];
			return json({ ok: true, pending });
		}
		const vaultRaw = await records.get<VaultRecord>(VAULTS_KEY, { recordKey: vaultId });
		const vault = vaultRaw ? parseVaultRecords([vaultRaw])[0] : undefined;
		if (!vault) return json({ error: "unknown_vault" }, 404);
		if (await records.count(PENDING_DESTROYS_KEY) >= MAX_PENDING_DESTROYS) {
			return json({ error: "pending_destroy_capacity" }, 503);
		}
		const record: PendingDestroyRecord = {
			vaultId, vaultGeneration: vault.vaultGeneration, deletionId: randomBase64Url(16),
			purgeJobId: `purge:${vaultId}:${vault.vaultGeneration}`, requestedAt: Date.now(),
			roomComplete: false, r2Complete: false, purgeState: "pending",
			capabilityHash: null, capabilityExpiresAt: null, deletedObjects: 0,
			deletedBytes: 0, lastError: null,
		};
		vault.state = "deleting";
		governance.state = "executing";
		governance.lastError = null;
		await records.upsert(PENDING_DESTROYS_KEY, record);
		await records.upsert(VAULTS_KEY, vault);
		await records.upsert("vaultGovernanceRequests", governance);
		await records.deleteWhere(DEVICES_KEY, { vaultId });
		await records.deleteWhere(PAIRING_CODES_KEY, { vaultId });
		await records.deleteWhere(PENDING_DEVICE_REVOCATIONS_KEY, { vaultId });
		await records.deleteWhere(ENROLLMENT_REPLAYS_KEY, { vaultId });
		return json({ ok: true, pending: record });
	}

	private async handleUpdateDestroyVault(request: Request): Promise<Response> {
		let body: {
			vaultId?: string;
			roomComplete?: boolean;
			r2Complete?: boolean;
			purgeState?: PendingDestroyRecord["purgeState"];
			capabilityHash?: string | null;
			capabilityExpiresAt?: number | null;
			deletedObjects?: number;
			deletedBytes?: number;
			lastError?: unknown;
		};
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (
			typeof body.vaultId !== "string"
			|| typeof body.roomComplete !== "boolean"
			|| typeof body.r2Complete !== "boolean"
			|| (body.purgeState !== undefined && body.purgeState !== "pending" && body.purgeState !== "queued"
				&& body.purgeState !== "purging" && body.purgeState !== "retrying"
				&& body.purgeState !== "complete" && body.purgeState !== "failed")
			|| (body.capabilityHash !== undefined && body.capabilityHash !== null
				&& !/^[a-f0-9]{64}$/.test(body.capabilityHash))
			|| (body.capabilityExpiresAt !== undefined && body.capabilityExpiresAt !== null
				&& (!Number.isSafeInteger(body.capabilityExpiresAt) || body.capabilityExpiresAt < 0))
			|| (body.deletedObjects !== undefined
				&& (!Number.isSafeInteger(body.deletedObjects) || body.deletedObjects < 0))
			|| (body.deletedBytes !== undefined
				&& (!Number.isSafeInteger(body.deletedBytes) || body.deletedBytes < 0))
		) {
			return json({ error: "invalid pending destroy update" }, 400);
		}
		return this.storage.transaction(async (txn) => {
			if (txn.records) return this.handleIndexedUpdateDestroyVault(txn, body as Required<Pick<typeof body, "vaultId" | "roomComplete" | "r2Complete">> & typeof body);
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const pendingDestroys = parsePendingDestroyRecords(
				await txn.get(PENDING_DESTROYS_KEY),
				new Set(vaults.filter((vault) => vault.state !== "deleting" && vault.state !== "delete_failed").map((vault) => vault.vaultId)),
			);
			const pending = pendingDestroys.find((record) => record.vaultId === body.vaultId);
			if (!pending) return json({ error: "unknown_pending_destroy" }, 404);
			const nextPurgeState = body.purgeState ?? pending.purgeState;
			const nextR2Complete = pending.r2Complete || body.r2Complete;
			if ((body.r2Complete && nextPurgeState !== "complete")
				|| (body.roomComplete && !nextR2Complete)) {
				return json({ error: "destroy ordering violation" }, 409);
			}

			pending.roomComplete ||= body.roomComplete!;
			pending.r2Complete ||= body.r2Complete!;
			if (body.purgeState !== undefined) pending.purgeState = body.purgeState;
			if (body.capabilityHash !== undefined) pending.capabilityHash = body.capabilityHash;
			if (body.capabilityExpiresAt !== undefined) pending.capabilityExpiresAt = body.capabilityExpiresAt;
			if (body.deletedObjects !== undefined) pending.deletedObjects = Math.max(pending.deletedObjects, body.deletedObjects);
			if (body.deletedBytes !== undefined) pending.deletedBytes = Math.max(pending.deletedBytes, body.deletedBytes);
			pending.lastError = boundedDestroyError(body.lastError);
			const vault = vaults.find((record) => record.vaultId === body.vaultId);
			if (pending.roomComplete && pending.r2Complete) {
				const governanceRequests = parseVaultGovernanceRequestRecords(await txn.get("vaultGovernanceRequests"));
				const governance = governanceRequests.find((record) => record.vaultId === body.vaultId
					&& record.vaultGeneration === pending.vaultGeneration && record.state === "executing");
				if (governance) {
					governance.state = "complete";
					governance.completedAt = Date.now();
					governance.lastError = null;
				}
				await txn.put(
					PENDING_DESTROYS_KEY,
					pendingDestroys.filter((record) => record !== pending),
				);
				await txn.put(VAULTS_KEY, vaults.filter((record) => record !== vault));
				await txn.put("principals", parsePrincipalRecords(await txn.get("principals")).filter((record) => record.vaultId !== body.vaultId));
				await txn.put("vaultMemberships", parseMembershipRecords(await txn.get("vaultMemberships")).filter((record) => record.vaultId !== body.vaultId));
				await txn.put("collaborationCodes", parseCollaborationCodeRecords(await txn.get("collaborationCodes")).filter((record) => record.vaultId !== body.vaultId));
				await txn.put("ownershipTransfers", parseOwnershipTransferRecords(await txn.get("ownershipTransfers")).filter((record) => record.vaultId !== body.vaultId));
				await txn.put("authorizationChanges", parseAuthorizationChangeRecords(await txn.get("authorizationChanges")).filter((record) => record.vaultId !== body.vaultId));
				await txn.put("securityAuditEvents", parseSecurityAuditEvents(await txn.get("securityAuditEvents")).filter((record) => record.vaultId !== body.vaultId));
				await txn.put("vaultGovernanceRequests", governanceRequests);
				return json({ ok: true, completed: true });
			}
			if (vault) {
				vault.state = pending.lastError ? "delete_failed" : "deleting";
				await txn.put(VAULTS_KEY, vaults);
			}
			if (pending.lastError) {
				const governanceRequests = parseVaultGovernanceRequestRecords(await txn.get("vaultGovernanceRequests"));
				const governance = governanceRequests.find((record) => record.vaultId === body.vaultId
					&& record.vaultGeneration === pending.vaultGeneration && record.state === "executing");
				if (governance) governance.lastError = pending.lastError;
				await txn.put("vaultGovernanceRequests", governanceRequests);
			}
			await txn.put(PENDING_DESTROYS_KEY, pendingDestroys);
			return json({ ok: false, completed: false, pending }, 202);
		});
	}

	private async handleIndexedUpdateDestroyVault(
		txn: ControlPlaneTransactionPort,
		body: {
			vaultId: string; roomComplete: boolean; r2Complete: boolean;
			purgeState?: PendingDestroyRecord["purgeState"];
			capabilityHash?: string | null; capabilityExpiresAt?: number | null;
			deletedObjects?: number; deletedBytes?: number; lastError?: unknown;
		},
	): Promise<Response> {
		const records = txn.records!;
		const pendingRaw = await records.get<PendingDestroyRecord>(PENDING_DESTROYS_KEY, { recordKey: body.vaultId });
		const pending = pendingRaw ? parsePendingDestroyRecords([pendingRaw])[0] : undefined;
		if (!pending) return json({ error: "unknown_pending_destroy" }, 404);
		const nextPurgeState = body.purgeState ?? pending.purgeState;
		const nextR2Complete = pending.r2Complete || body.r2Complete;
		if ((body.r2Complete && nextPurgeState !== "complete") || (body.roomComplete && !nextR2Complete)) {
			return json({ error: "destroy ordering violation" }, 409);
		}
		pending.roomComplete ||= body.roomComplete;
		pending.r2Complete ||= body.r2Complete;
		if (body.purgeState !== undefined) pending.purgeState = body.purgeState;
		if (body.capabilityHash !== undefined) pending.capabilityHash = body.capabilityHash;
		if (body.capabilityExpiresAt !== undefined) pending.capabilityExpiresAt = body.capabilityExpiresAt;
		if (body.deletedObjects !== undefined) pending.deletedObjects = Math.max(pending.deletedObjects, body.deletedObjects);
		if (body.deletedBytes !== undefined) pending.deletedBytes = Math.max(pending.deletedBytes, body.deletedBytes);
		pending.lastError = boundedDestroyError(body.lastError);

		const vaultRaw = await records.get<VaultRecord>(VAULTS_KEY, { recordKey: body.vaultId });
		const vault = vaultRaw ? parseVaultRecords([vaultRaw])[0] : undefined;
		const governanceRaw = await records.get("vaultGovernanceRequests", {
			vaultId: body.vaultId, vaultGeneration: pending.vaultGeneration, state: "executing",
		});
		const governance = governanceRaw ? parseVaultGovernanceRequestRecords([governanceRaw])[0] : undefined;
		const matchingGovernance = governance;
		if (pending.roomComplete && pending.r2Complete) {
			if (matchingGovernance) {
				matchingGovernance.state = "complete";
				matchingGovernance.completedAt = Date.now();
				matchingGovernance.lastError = null;
				await records.upsert("vaultGovernanceRequests", matchingGovernance);
			}
			await records.delete(PENDING_DESTROYS_KEY, body.vaultId);
			await records.delete(VAULTS_KEY, body.vaultId);
			for (const collection of [
				"principals", "vaultMemberships", "collaborationCodes", "ownershipTransfers",
				"authorizationChanges", "securityAuditEvents",
			] as const) await records.deleteWhere(collection, { vaultId: body.vaultId });
			return json({ ok: true, completed: true });
		}
		if (vault) {
			vault.state = pending.lastError ? "delete_failed" : "deleting";
			await records.upsert(VAULTS_KEY, vault);
		}
		if (matchingGovernance && pending.lastError) {
			matchingGovernance.lastError = pending.lastError;
			await records.upsert("vaultGovernanceRequests", matchingGovernance);
		}
		await records.upsert(PENDING_DESTROYS_KEY, pending);
		return json({ ok: false, completed: false, pending }, 202);
	}

	private async handleDeletionProgress(request: Request): Promise<Response> {
		let body: {
			deletionId?: unknown;
			vaultId?: unknown;
			vaultGeneration?: unknown;
			jobId?: unknown;
			capability?: unknown;
			state?: unknown;
			deletedObjects?: unknown;
			deletedBytes?: unknown;
			error?: unknown;
		};
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (typeof body.vaultId !== "string" || typeof body.vaultGeneration !== "string"
			|| typeof body.deletionId !== "string" || typeof body.jobId !== "string"
			|| typeof body.capability !== "string"
			|| (body.state !== "queued" && body.state !== "purging" && body.state !== "retrying"
				&& body.state !== "complete" && body.state !== "failed")
			|| !Number.isSafeInteger(body.deletedObjects) || (body.deletedObjects as number) < 0
			|| !Number.isSafeInteger(body.deletedBytes) || (body.deletedBytes as number) < 0) {
			return json({ error: "invalid deletion progress" }, 400);
		}
		const purgeState = body.state as PendingDestroyRecord["purgeState"];
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				const raw = await txn.records.get<PendingDestroyRecord>(PENDING_DESTROYS_KEY, { recordKey: body.vaultId as string });
				const pending = raw ? parsePendingDestroyRecords([raw])[0] : undefined;
				if (!pending || pending.vaultGeneration !== body.vaultGeneration
					|| pending.deletionId !== body.deletionId || pending.purgeJobId !== body.jobId
					|| pending.capabilityHash === null || pending.capabilityExpiresAt === null
					|| pending.capabilityExpiresAt <= Date.now()
					|| await hashSecret(body.capability as string) !== pending.capabilityHash) {
					return json({ error: "deletion progress unauthorized" }, 401);
				}
				pending.purgeState = purgeState;
				pending.r2Complete ||= purgeState === "complete";
				pending.deletedObjects = Math.max(pending.deletedObjects, body.deletedObjects as number);
				pending.deletedBytes = Math.max(pending.deletedBytes, body.deletedBytes as number);
				const error = body.error && typeof body.error === "object" && "code" in body.error ? String(body.error.code) : null;
				pending.lastError = purgeState === "failed" ? boundedDestroyError(error ?? "purge_failed") : null;
				await txn.records.upsert(PENDING_DESTROYS_KEY, pending);
				return json({ ok: true, pending });
			}
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const pendingDestroys = parsePendingDestroyRecords(
				await txn.get(PENDING_DESTROYS_KEY),
				new Set(vaults.filter((vault) => vault.state !== "deleting" && vault.state !== "delete_failed").map((vault) => vault.vaultId)),
			);
			const pending = pendingDestroys.find((record) => record.vaultId === body.vaultId);
			if (!pending || pending.vaultGeneration !== body.vaultGeneration
				|| pending.deletionId !== body.deletionId || pending.purgeJobId !== body.jobId
				|| pending.capabilityHash === null || pending.capabilityExpiresAt === null
				|| pending.capabilityExpiresAt <= Date.now()
				|| await hashSecret(body.capability as string) !== pending.capabilityHash) {
				return json({ error: "deletion progress unauthorized" }, 401);
			}
			pending.purgeState = purgeState;
			pending.r2Complete ||= purgeState === "complete";
			pending.deletedObjects = Math.max(pending.deletedObjects, body.deletedObjects as number);
			pending.deletedBytes = Math.max(pending.deletedBytes, body.deletedBytes as number);
			const error = body.error && typeof body.error === "object" && "code" in body.error
				? String(body.error.code)
				: null;
			pending.lastError = purgeState === "failed" ? boundedDestroyError(error ?? "purge_failed") : null;
			await txn.put(PENDING_DESTROYS_KEY, pendingDestroys);
			return json({ ok: true, pending });
		});
	}

	private async handleRevokePairing(request: Request): Promise<Response> {
		let body: { codeId?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "invalid json" }, 400);
		}
		if (!body.codeId) return json({ error: "invalid codeId" }, 400);
		return this.storage.transaction(async (txn) => {
			if (txn.records) {
				return await txn.records.delete(PAIRING_CODES_KEY, body.codeId!)
					? json({ ok: true }) : json({ error: "unknown_code" }, 404);
			}
			const vaults = parseVaultRecords(await txn.get(VAULTS_KEY));
			const codes = parsePairingCodeRecords(
				await txn.get(PAIRING_CODES_KEY),
				new Set(vaults.map((vault) => vault.vaultId)),
			);
			const next = codes.filter((code) => code.codeId !== body.codeId);
			if (next.length === codes.length) return json({ error: "unknown_code" }, 404);
			await txn.put(PAIRING_CODES_KEY, next);
			return json({ ok: true });
		});
	}

	private async readConsole(): Promise<ConsoleState> {
		const now = Date.now();
		const vaults = parseVaultRecords(await this.storage.get(VAULTS_KEY));
		const vaultIds = new Set(vaults.map((vault) => vault.vaultId));
		const devices = parseDeviceRecords(await this.storage.get(DEVICES_KEY), vaultIds);
		const codes = parsePairingCodeRecords(await this.storage.get(PAIRING_CODES_KEY), vaultIds);
		const pendingDestroys = parsePendingDestroyRecords(
			await this.storage.get(PENDING_DESTROYS_KEY),
			new Set(vaults.filter((vault) => vault.state !== "deleting" && vault.state !== "delete_failed").map((vault) => vault.vaultId)),
		);
		const pendingDeviceRevocations = parsePendingDeviceRevocationRecords(
			await this.storage.get(PENDING_DEVICE_REVOCATIONS_KEY),
		);
		return {
			vaults,
			devices: devices.map(toDevicePublic),
			pairingCodes: codes.filter((code) => code.uses < 1 && code.exp > now).map(toPairingPublic),
			pendingDestroys,
			pendingDeviceRevocations,
			principals: parsePrincipalRecords(await this.storage.get("principals")),
			memberships: parseMembershipRecords(await this.storage.get("vaultMemberships")),
			authorizationChanges: parseAuthorizationChangeRecords(await this.storage.get("authorizationChanges")),
			vaultGovernanceRequests: parseVaultGovernanceRequestRecords(await this.storage.get("vaultGovernanceRequests")),
		};
	}

	private async readConfig(): Promise<StoredServerConfig> {
		const configFormat = await this.storage.get<number>(CONFIG_FORMAT_KEY);
		const claimed = await this.storage.get<boolean>(CLAIMED_KEY);
		const operatorRecoveryHash = await this.storage.get<string>(OPERATOR_RECOVERY_HASH_KEY);
		const ticketSigningKey = await this.storage.get<string>(TICKET_SIGNING_KEY);
		const updateProvider = await this.storage.get<UpdateProvider>(UPDATE_PROVIDER_KEY);
		const updateRepoUrl = await this.storage.get<string>(UPDATE_REPO_URL_KEY);
		const updateRepoBranch = await this.storage.get<string>(UPDATE_REPO_BRANCH_KEY);
		const isCurrent = configFormat === CONFIG_FORMAT;
		return {
			configFormat: typeof configFormat === "number" ? configFormat : null,
			claimed: claimed === true,
			operatorRecoveryHash: isCurrent && typeof operatorRecoveryHash === "string" && operatorRecoveryHash.length > 0 ? operatorRecoveryHash : null,
			ticketSigningKey: isCurrent && typeof ticketSigningKey === "string" && ticketSigningKey.length > 0 ? ticketSigningKey : null,
			updateProvider: updateProvider === "github" || updateProvider === "gitlab" || updateProvider === "unknown" ? updateProvider : null,
			updateRepoUrl: typeof updateRepoUrl === "string" && updateRepoUrl.length > 0 ? updateRepoUrl : null,
			updateRepoBranch: typeof updateRepoBranch === "string" && updateRepoBranch.length > 0 ? updateRepoBranch : null,
		};
	}
}

/** Cloudflare transport/storage wrapper for the shared control-plane runtime. */
export class ServerConfig {
	private readonly runtime: ControlPlaneRuntime;

	constructor(state: DurableObjectState) {
		this.runtime = new ControlPlaneRuntime(new SqlControlPlaneStorage(
			state.storage as unknown as ControlPlaneSqlHost,
			"global-config",
		));
	}

	fetch(request: Request): Promise<Response> {
		return this.runtime.fetch(request);
	}
}

export default ServerConfig;
