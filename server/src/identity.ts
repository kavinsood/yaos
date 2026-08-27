import { randomBase64Url } from "./base64url";
import { sha256Hex } from "./hex";

export const CONFIG_FORMAT = 1 as const;
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1_000;
export const OPERATOR_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEVICE_TOKEN_BYTES = 32;
export const PAIRING_CODE_BYTES = 24;
export const SESSION_TOKEN_BYTES = 32;
export const SIGNING_KEY_BYTES = 32;
export const OPERATOR_COOKIE = "yaos_op";

export type PairingPurpose = "device" | "invite";

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

export type VaultRecord = {
	vaultId: string;
	name: string;
	createdAt: number;
};

export type OperatorSessionRecord = {
	sessionHash: string;
	exp: number;
	createdAt: number;
};

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
