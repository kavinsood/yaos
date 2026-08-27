import { randomBase64Url } from "./base64url";
import { sha256Hex } from "./hex";

export const CONFIG_FORMAT = 2 as const;
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1_000;
export const OPERATOR_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEVICE_TOKEN_BYTES = 32;
export const PAIRING_CODE_BYTES = 24;
export const SESSION_TOKEN_BYTES = 32;
export const SIGNING_KEY_BYTES = 32;
export const OPERATOR_COOKIE = "yaos_op";

export type PairingPurpose = "origin" | "device" | "invite";

export const MAX_VAULT_RECORDS = 256;
export const MAX_DEVICE_RECORDS = 4_096;
export const MAX_PAIRING_CODE_RECORDS = 4_096;
export const MAX_OPERATOR_SESSION_RECORDS = 1_024;

export const MAX_ID_LENGTH = 128;
export const MAX_HASH_LENGTH = 256;
const MAX_VAULT_NAME_LENGTH = 80;
const MAX_DEVICE_NAME_LENGTH = 80;
const MAX_RECORD_COUNT = 1_000_000;
const MAX_CORRUPT_STATE_ERROR_LENGTH = 192;

type IdentityCollection =
	| "vaults"
	| "devices"
	| "pairingCodes"
	| "operatorSessions"
	| "pendingVaultDestroys"
	| "pendingDeviceRevocations"
	| "enrollmentReplays";

export class CorruptIdentityStateError extends Error {
	readonly code = "corrupt_identity_state";

	constructor(readonly collection: IdentityCollection, detail: string) {
		super(`corrupt identity state: ${collection}: ${detail}`.slice(0, MAX_CORRUPT_STATE_ERROR_LENGTH));
		this.name = "CorruptIdentityStateError";
	}
}

export type DeviceRecord = {
	deviceId: string;
	vaultId: string;
	tokenHash: string;
	name: string;
	enrolledAt: number;
	lastSeenAt?: number;
};

export type PairingCodeRecord = {
	codeId: string;
	codeHash: string;
	vaultId: string;
	exp: number;
	maxUses: number;
	uses: number;
	purpose: PairingPurpose;
	createdAt: number;
};

export type VaultState = "provisioning" | "active" | "deleting" | "delete_failed";

export type VaultRecord = {
	vaultId: string;
	name: string;
	state: VaultState;
	vaultGeneration: string;
	createdAt: number;
	provisionedAt: number | null;
};

export type OperatorSessionRecord = {
	sessionHash: string;
	exp: number;
	createdAt: number;
};

function corrupt(collection: IdentityCollection, detail: string): never {
	throw new CorruptIdentityStateError(collection, detail);
}

function readCollection(value: unknown, collection: IdentityCollection, maximum: number): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) corrupt(collection, "expected an array");
	if (value.length > maximum) corrupt(collection, "collection exceeds capacity");
	for (let index = 0; index < value.length; index++) {
		if (!Object.prototype.hasOwnProperty.call(value, index)) corrupt(collection, `record ${index} is missing`);
	}
	return value;
}

function readRecord(value: unknown, collection: IdentityCollection, index: number): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		corrupt(collection, `record ${index} is not an object`);
	}
	return value as Record<string, unknown>;
}

function requireExactKeys(
	record: Record<string, unknown>,
	keys: readonly string[],
	collection: IdentityCollection,
	index: number,
): void {
	const actual = Object.keys(record);
	if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
		corrupt(collection, `record ${index} has invalid shape`);
	}
}

function readString(
	value: unknown,
	maximum: number,
	collection: IdentityCollection,
	index: number,
	field: string,
): string {
	if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value) {
		corrupt(collection, `record ${index} has invalid ${field}`);
	}
	return value;
}

function readHash(
	value: unknown,
	collection: IdentityCollection,
	index: number,
	field: string,
): string {
	if (typeof value !== "string" || value.length < 1 || value.length > MAX_HASH_LENGTH) {
		corrupt(collection, `record ${index} has invalid ${field}`);
	}
	return value;
}

function readTimestamp(
	value: unknown,
	collection: IdentityCollection,
	index: number,
	field: string,
): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		corrupt(collection, `record ${index} has invalid ${field}`);
	}
	return value as number;
}

function readCount(
	value: unknown,
	collection: IdentityCollection,
	index: number,
	field: string,
	minimum = 0,
): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > MAX_RECORD_COUNT) {
		corrupt(collection, `record ${index} has invalid ${field}`);
	}
	return value as number;
}

function requireUnique(
	values: Set<string>,
	value: string,
	collection: IdentityCollection,
	field: string,
): void {
	if (values.has(value)) corrupt(collection, `duplicate ${field}`);
	values.add(value);
}

export function parseVaultRecords(value: unknown): VaultRecord[] {
	const collection = "vaults";
	const records = readCollection(value, collection, MAX_VAULT_RECORDS);
	const vaultIds = new Set<string>();
	const generations = new Set<string>();
	return records.map((item, index) => {
		const record = readRecord(item, collection, index);
		requireExactKeys(
			record,
			["vaultId", "name", "state", "vaultGeneration", "createdAt", "provisionedAt"],
			collection,
			index,
		);
		const vaultId = readString(record.vaultId, MAX_ID_LENGTH, collection, index, "vaultId");
		if (!isUsableVaultId(vaultId)) corrupt(collection, `record ${index} has invalid vaultId`);
		const vaultGeneration = readString(
			record.vaultGeneration,
			MAX_ID_LENGTH,
			collection,
			index,
			"vaultGeneration",
		);
		if (!isUsableVaultId(vaultGeneration)) {
			corrupt(collection, `record ${index} has invalid vaultGeneration`);
		}
		if (
			record.state !== "provisioning"
			&& record.state !== "active"
			&& record.state !== "deleting"
			&& record.state !== "delete_failed"
		) {
			corrupt(collection, `record ${index} has invalid state`);
		}
		const createdAt = readTimestamp(record.createdAt, collection, index, "createdAt");
		let provisionedAt: number | null = null;
		if (record.provisionedAt !== null) {
			provisionedAt = readTimestamp(record.provisionedAt, collection, index, "provisionedAt");
			if (provisionedAt < createdAt) corrupt(collection, `record ${index} has invalid provisionedAt`);
		}
		if ((record.state === "provisioning") !== (provisionedAt === null)) {
			corrupt(collection, `record ${index} has inconsistent provisioning state`);
		}
		requireUnique(vaultIds, vaultId, collection, "vaultId");
		requireUnique(generations, vaultGeneration, collection, "vaultGeneration");
		return {
			vaultId,
			name: readString(record.name, MAX_VAULT_NAME_LENGTH, collection, index, "name"),
			state: record.state,
			vaultGeneration,
			createdAt,
			provisionedAt,
		};
	});
}

export function parseDeviceRecords(value: unknown, knownVaultIds?: ReadonlySet<string>): DeviceRecord[] {
	const collection = "devices";
	const records = readCollection(value, collection, MAX_DEVICE_RECORDS);
	const deviceIds = new Set<string>();
	const tokenHashes = new Set<string>();
	return records.map((item, index) => {
		const record = readRecord(item, collection, index);
		const hasLastSeenAt = Object.prototype.hasOwnProperty.call(record, "lastSeenAt");
		requireExactKeys(
			record,
			hasLastSeenAt
				? ["deviceId", "vaultId", "tokenHash", "name", "enrolledAt", "lastSeenAt"]
				: ["deviceId", "vaultId", "tokenHash", "name", "enrolledAt"],
			collection,
			index,
		);
		const deviceId = readString(record.deviceId, MAX_ID_LENGTH, collection, index, "deviceId");
		const vaultId = readString(record.vaultId, MAX_ID_LENGTH, collection, index, "vaultId");
		if (!isUsableVaultId(vaultId) || vaultId.trim() !== vaultId) {
			corrupt(collection, `record ${index} has invalid vaultId`);
		}
		const tokenHash = readHash(record.tokenHash, collection, index, "tokenHash");
		const enrolledAt = readTimestamp(record.enrolledAt, collection, index, "enrolledAt");
		let lastSeenAt: number | undefined;
		if (hasLastSeenAt) {
			lastSeenAt = readTimestamp(record.lastSeenAt, collection, index, "lastSeenAt");
			if (lastSeenAt < enrolledAt) corrupt(collection, `record ${index} has invalid lastSeenAt`);
		}
		if (knownVaultIds && !knownVaultIds.has(vaultId)) {
			corrupt(collection, `record ${index} references an unknown vaultId`);
		}
		requireUnique(deviceIds, deviceId, collection, "deviceId");
		requireUnique(tokenHashes, tokenHash, collection, "tokenHash");
		return {
			deviceId,
			vaultId,
			tokenHash,
			name: readString(record.name, MAX_DEVICE_NAME_LENGTH, collection, index, "name"),
			enrolledAt,
			...(lastSeenAt === undefined ? {} : { lastSeenAt }),
		};
	});
}

export function parsePairingCodeRecords(value: unknown, knownVaultIds?: ReadonlySet<string>): PairingCodeRecord[] {
	const collection = "pairingCodes";
	const records = readCollection(value, collection, MAX_PAIRING_CODE_RECORDS);
	const codeIds = new Set<string>();
	const codeHashes = new Set<string>();
	return records.map((item, index) => {
		const record = readRecord(item, collection, index);
		requireExactKeys(
			record,
			["codeId", "codeHash", "vaultId", "exp", "maxUses", "uses", "purpose", "createdAt"],
			collection,
			index,
		);
		const codeId = readString(record.codeId, MAX_ID_LENGTH, collection, index, "codeId");
		const codeHash = readHash(record.codeHash, collection, index, "codeHash");
		const vaultId = readString(record.vaultId, MAX_ID_LENGTH, collection, index, "vaultId");
		if (!isUsableVaultId(vaultId) || vaultId.trim() !== vaultId) {
			corrupt(collection, `record ${index} has invalid vaultId`);
		}
		const exp = readTimestamp(record.exp, collection, index, "exp");
		const maxUses = readCount(record.maxUses, collection, index, "maxUses", 1);
		const uses = readCount(record.uses, collection, index, "uses");
		const createdAt = readTimestamp(record.createdAt, collection, index, "createdAt");
		if (maxUses !== 1 || uses > maxUses) corrupt(collection, `record ${index} has invalid uses`);
		if (exp < createdAt) corrupt(collection, `record ${index} has invalid exp`);
		if (record.purpose !== "origin" && record.purpose !== "device" && record.purpose !== "invite") {
			corrupt(collection, `record ${index} has invalid purpose`);
		}
		if (knownVaultIds && !knownVaultIds.has(vaultId)) {
			corrupt(collection, `record ${index} references an unknown vaultId`);
		}
		requireUnique(codeIds, codeId, collection, "codeId");
		requireUnique(codeHashes, codeHash, collection, "codeHash");
		return {
			codeId,
			codeHash,
			vaultId,
			exp,
			maxUses,
			uses,
			purpose: record.purpose,
			createdAt,
		};
	});
}

export function parseOperatorSessionRecords(value: unknown): OperatorSessionRecord[] {
	const collection = "operatorSessions";
	const records = readCollection(value, collection, MAX_OPERATOR_SESSION_RECORDS);
	const sessionHashes = new Set<string>();
	return records.map((item, index) => {
		const record = readRecord(item, collection, index);
		requireExactKeys(record, ["sessionHash", "exp", "createdAt"], collection, index);
		const sessionHash = readHash(record.sessionHash, collection, index, "sessionHash");
		const exp = readTimestamp(record.exp, collection, index, "exp");
		const createdAt = readTimestamp(record.createdAt, collection, index, "createdAt");
		if (exp < createdAt) corrupt(collection, `record ${index} has invalid exp`);
		requireUnique(sessionHashes, sessionHash, collection, "sessionHash");
		return { sessionHash, exp, createdAt };
	});
}

export type DevicePublic = Omit<DeviceRecord, "tokenHash">;
export type PairingCodePublic = Omit<PairingCodeRecord, "codeHash">;

export async function hashSecret(secret: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(secret));
}

export function timingSafeEqualHex(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let mismatch = 0;
	for (let index = 0; index < left.length; index++) {
		mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return mismatch === 0;
}

export function findHashedRecord<T>(
	records: readonly T[],
	hash: string,
	readHash: (record: T) => string,
): T | null {
	let found: T | null = null;
	for (const record of records) {
		if (timingSafeEqualHex(readHash(record), hash)) found = record;
	}
	return found;
}

export function randomSecret(byteLength: number): string {
	return randomBase64Url(byteLength);
}

export function isUsableVaultId(id: string): boolean {
	const trimmed = id.trim();
	if (trimmed.length > 128) return false;
	if (trimmed.length < 8) return false;
	if (trimmed.includes("/") || trimmed.includes("\\")) return false;
	return trimmed.toLowerCase() !== "sync";
}

export function uniqueDeviceName(desired: string, existing: readonly string[]): string {
	if (!existing.includes(desired)) return desired;
	for (let suffix = 2; ; suffix++) {
		const candidate = `${desired} ${suffix}`;
		if (!existing.includes(candidate)) return candidate;
	}
}

export function toDevicePublic(device: DeviceRecord): DevicePublic {
	const { tokenHash: _tokenHash, ...publicDevice } = device;
	return publicDevice;
}

export function toPairingPublic(code: PairingCodeRecord): PairingCodePublic {
	const { codeHash: _codeHash, ...publicCode } = code;
	return publicCode;
}
