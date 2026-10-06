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

export interface EnrollRequest {
	/** The secret half of the code (the Worker routed by the vaultId half). */
	vaultId: string;
	secret: string;
	enrollmentRequestId: string;
	deviceId: string;
	deviceToken: string;
	deviceName: string;
}

const PAIRING_CODE_PATTERN = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{32})$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

/**
 * The enroll body, with legacy field rules (removed routes/enroll.ts:30-40). `"code"`: the pairing code is
 * malformed (the Worker already refused those; kept so the DO never trusts its caller); `"request"`: the other
 * fields are, which is legacy's `400 "invalid enrollment request"`.
 */
export function parseEnrollRequest(body: unknown): EnrollRequest | "code" | "request" {
	const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
	const code = typeof record.pairingCode === "string" ? PAIRING_CODE_PATTERN.exec(record.pairingCode.trim()) : null;
	if (!code) return "code";
	const { enrollmentRequestId, deviceId, deviceToken } = record;
	if (typeof enrollmentRequestId !== "string" || !REQUEST_ID_PATTERN.test(enrollmentRequestId)
		|| typeof deviceId !== "string" || !REQUEST_ID_PATTERN.test(deviceId)
		|| typeof deviceToken !== "string" || !DEVICE_TOKEN_PATTERN.test(deviceToken)) return "request";
	return { vaultId: code[1]!, secret: code[2]!, enrollmentRequestId, deviceId, deviceToken,
		deviceName: normalizeDeviceName(record.deviceName) };
}
