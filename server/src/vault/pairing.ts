// D3 pairing codes and the enroll body. A code is `<vaultId>.<secret>`: base64url(16 B), ".", base64url(24 B). The
// vault DO stores SHA-256(secret) only; the code itself leaves the DO once, in the mint response.
import { randomBase64Url } from "../base64url";

/** D3: TTL 15 min. */
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;
/** §6.1: minting a code prunes rows expired more than 24 h ago. */
export const PAIRING_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** D3 limiter: 20 failed enrolls a minute per vault DO. */
export const ENROLL_FAILURE_LIMIT = 20;
export const ENROLL_FAILURE_WINDOW_MS = 60_000;
const SECRET_BYTES = 24;

export type PairingPurpose = "owner-bootstrap" | "owner-recovery" | "device";

export function isPairingPurpose(value: unknown): value is PairingPurpose {
	return value === "owner-bootstrap" || value === "owner-recovery" || value === "device";
}

export function mintPairingSecret(vaultId: string): { code: string; secret: string } {
	const secret = randomBase64Url(SECRET_BYTES);
	return { code: `${vaultId}.${secret}`, secret };
}

/** Legacy device-name rules (removed config.ts:736-738): trimmed, at most 50 characters, default "unnamed-device". */
export const MAX_DEVICE_NAME_LENGTH = 50;
export const DEFAULT_DEVICE_NAME = "unnamed-device";

export function normalizeDeviceName(raw: unknown): string {
	return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, MAX_DEVICE_NAME_LENGTH) : DEFAULT_DEVICE_NAME;
}

/** Legacy `uniqueDeviceName` (removed identity.ts:436-442): "name", then "name 2", "name 3", ... */
export function uniqueDeviceName(desired: string, existing: ReadonlySet<string>): string {
	if (!existing.has(desired)) return desired;
	for (let suffix = 2; ; suffix++) {
		const candidate = `${desired} ${suffix}`;
		if (!existing.has(candidate)) return candidate;
	}
}

/**
 * Identity-per-store §3.3 limits, per pairing grant (owner decision 4, 2026-10-21): at most 20 registrations a UTC day
 * and 50 live devices. Inactivity retirement (90 days) is phase 5; phase 1 only records `last_seen_day`.
 */
export const GRANT_REGISTRATIONS_PER_DAY = 20;
export const GRANT_LIVE_DEVICE_LIMIT = 50;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC day number of `ms` (the `last_seen_day` and registration-counter unit). */
export function utcDay(ms: number): number {
	return Math.floor(ms / DAY_MS);
}

/** A UTC day number as `YYYY-MM-DD` (the operator listing). */
export function utcDayString(day: number): string {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export interface EnrollRequest {
	/** The secret half of the code (the Worker routed by the vaultId half). */
	vaultId: string;
	secret: string;
	enrollmentRequestId: string;
	deviceId: string;
	deviceToken: string;
	deviceName: string;
}

/**
 * A grant enroll (identity-per-store §3.2): the code buys a pairing grant instead of a device. DECISIONS-GAP (G56):
 * the client mints the secret, as it mints a device token today, so the D3 replay can answer the same 200 without
 * the server keeping the secret: the row holds SHA-256(grantSecret) only.
 */
export interface GrantEnrollRequest {
	vaultId: string;
	secret: string;
	enrollmentRequestId: string;
	grantSecret: string;
	grantName: string;
}

/** `POST /auth/device`: a new store's identity under a grant. */
export interface RegisterRequest {
	deviceId: string;
	deviceToken: string;
	/** hex(SHA-256(retireKey)), 64 lowercase hex: the key the device (or its successor) retires it with. */
	retireHash: string;
}

/** `POST /auth/device/retire`. */
export interface RetireRequest {
	deviceId: string;
	retireKey: string;
}

const PAIRING_CODE_PATTERN = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{32})$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
/** A grant secret: at least 32 random bytes as base64url (43 characters). */
export const GRANT_SECRET_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;
/** A server-minted grantId: base64url(16 B). */
export const GRANT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function asRecord(body: unknown): Record<string, unknown> {
	return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

/**
 * The enroll body, with legacy field rules (removed routes/enroll.ts:30-40). `"code"`: the pairing code is
 * malformed (the Worker already refused those; kept so the DO never trusts its caller); `"request"`: the other
 * fields are, which is legacy's `400 "invalid enrollment request"`.
 */
export function parseEnrollRequest(body: unknown): EnrollRequest | GrantEnrollRequest | "code" | "request" {
	const record = asRecord(body);
	const code = typeof record.pairingCode === "string" ? PAIRING_CODE_PATTERN.exec(record.pairingCode.trim()) : null;
	if (!code) return "code";
	const { enrollmentRequestId, deviceId, deviceToken, grantSecret } = record;
	// Phase 1 keeps the old body (a device) working beside the grant body until the client switches (phase 2). A body
	// with both a grantSecret and a device is neither.
	if (grantSecret !== undefined) {
		if (deviceId !== undefined || deviceToken !== undefined || typeof enrollmentRequestId !== "string"
			|| !REQUEST_ID_PATTERN.test(enrollmentRequestId)
			|| typeof grantSecret !== "string" || !GRANT_SECRET_PATTERN.test(grantSecret)) return "request";
		return { vaultId: code[1]!, secret: code[2]!, enrollmentRequestId, grantSecret,
			grantName: normalizeDeviceName(record.grantName) };
	}
	if (typeof enrollmentRequestId !== "string" || !REQUEST_ID_PATTERN.test(enrollmentRequestId)
		|| typeof deviceId !== "string" || !REQUEST_ID_PATTERN.test(deviceId)
		|| typeof deviceToken !== "string" || !DEVICE_TOKEN_PATTERN.test(deviceToken)) return "request";
	return { vaultId: code[1]!, secret: code[2]!, enrollmentRequestId, deviceId, deviceToken,
		deviceName: normalizeDeviceName(record.deviceName) };
}

/** The register body; null when malformed (`400 invalid_request`). */
export function parseRegisterRequest(body: unknown): RegisterRequest | null {
	const { deviceId, deviceToken, retireKeyHash } = asRecord(body);
	if (typeof deviceId !== "string" || !REQUEST_ID_PATTERN.test(deviceId)
		|| typeof deviceToken !== "string" || !DEVICE_TOKEN_PATTERN.test(deviceToken)
		|| typeof retireKeyHash !== "string" || !SHA256_HEX_PATTERN.test(retireKeyHash)) return null;
	return { deviceId, deviceToken, retireHash: retireKeyHash };
}

/** The retire-by-key body; null when malformed (`400 invalid_request`). The key has a device token's format. */
/** `POST /auth/device/status`: at most this many ids per request. */
export const DEVICE_STATUS_MAX_IDS = 32;

/** `POST /auth/device/status {deviceIds}`: 1..32 distinct well-formed ids, or null. */
export function parseDeviceStatusRequest(body: unknown): string[] | null {
	const { deviceIds } = asRecord(body);
	if (!Array.isArray(deviceIds) || deviceIds.length === 0 || deviceIds.length > DEVICE_STATUS_MAX_IDS) return null;
	const out: string[] = [];
	for (const id of deviceIds) {
		if (typeof id !== "string" || !REQUEST_ID_PATTERN.test(id)) return null;
		if (!out.includes(id)) out.push(id);
	}
	return out;
}

export function parseRetireRequest(body: unknown): RetireRequest | null {
	const { deviceId, retireKey } = asRecord(body);
	if (typeof deviceId !== "string" || !REQUEST_ID_PATTERN.test(deviceId)
		|| typeof retireKey !== "string" || !DEVICE_TOKEN_PATTERN.test(retireKey)) return null;
	return { deviceId, retireKey };
}
