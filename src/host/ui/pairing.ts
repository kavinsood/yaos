/**
 * Pairing HTTP calls against the streams relay (docs/client-remake/relay-wire.md §2).
 * Ported from legacy-src/onboarding/provisioningClient.ts and legacy-src/runtime/setupLinkController.ts.
 *
 * Pure: every network call goes through an injected `request` function, randomness through an
 * injected `randomBytes`, waiting through an injected `sleep`. No obsidian runtime import.
 *
 * SECRETS: deviceToken and pairing codes never appear in thrown messages or progress text.
 */

import type { PairedIdentity } from "./api";
import { errorMessage } from "./format";

// ---------------------------------------------------------------------------
// Injected I/O
// ---------------------------------------------------------------------------

export interface HttpRequest {
	readonly url: string;
	readonly method: "GET" | "POST";
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
}

export interface HttpResponse {
	readonly status: number;
	/** Parsed JSON body, or null/undefined when the body was not JSON. */
	readonly json: unknown;
}

export type RequestFn = (req: HttpRequest) => Promise<HttpResponse>;
export type RandomBytesFn = (length: number) => Uint8Array;
export type SleepFn = (ms: number) => Promise<void>;

export interface PairingDeps {
	readonly request: RequestFn;
	readonly randomBytes?: RandomBytesFn;
	readonly sleep?: SleepFn;
	/** Progress text for the UI (never contains secrets). */
	readonly onProgress?: (text: string) => void;
}

export const defaultRandomBytes: RandomBytesFn = (length) => {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
};

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A pairing failure whose message is safe to show to the user. */
export class PairingError extends Error {
	constructor(
		message: string,
		/** Stable machine code, e.g. "expired_code", "network", "bad_host". */
		readonly code: string,
		/** HTTP status when the failure came from a response. */
		readonly status: number | null = null,
	) {
		super(message);
		this.name = "PairingError";
	}
}

// ---------------------------------------------------------------------------
// Ids (relay-wire §2.4)
// ---------------------------------------------------------------------------

export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;
export const ENROLLMENT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
/** Server rule: trimmed pairing code is 8..512 chars. We also require printable ASCII without spaces. */
const PAIRING_CODE_RE = /^[\x21-\x7e]{8,512}$/;
const MAX_DEVICE_NAME_CHARS = 50;

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url of `bytes`. */
export function base64Url(bytes: Uint8Array): string {
	let out = "";
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
		out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
	}
	const rest = bytes.length - i;
	if (rest === 1) {
		const n = bytes[i]! << 16;
		out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
	} else if (rest === 2) {
		const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
		out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
	}
	return out;
}

/** 16 random bytes -> 22 chars (DESIGN §m.1: ids are 16-byte base64url). */
export function generateDeviceId(random: RandomBytesFn = defaultRandomBytes): string {
	return base64Url(random(16));
}

/** 32 random bytes -> 43 chars (relay-wire §2.4: at least 32 random bytes, base64url). */
export function generateDeviceToken(random: RandomBytesFn = defaultRandomBytes): string {
	return base64Url(random(32));
}

export function generateEnrollmentRequestId(random: RandomBytesFn = defaultRandomBytes): string {
	return base64Url(random(16));
}

// ---------------------------------------------------------------------------
// Host + pairing code normalization
// ---------------------------------------------------------------------------

function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/**
 * Normalize a user-entered server address to an origin: "https://sync.example.com" (no trailing
 * slash, no path). A missing scheme means https. Plain http is accepted only for loopback hosts
 * (local relay development). Throws PairingError("bad_host").
 */
export function normalizeHost(input: string): string {
	let raw = input.trim();
	if (!raw) throw new PairingError("Enter the server address.", "bad_host");
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new PairingError("That server address is not a valid URL.", "bad_host");
	}
	if (url.username || url.password) throw new PairingError("The server address must not contain a user name or password.", "bad_host");
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
		throw new PairingError("The server address must start with https://.", "bad_host");
	}
	if (!url.hostname) throw new PairingError("That server address has no host name.", "bad_host");
	return url.origin;
}

/** Returns the trimmed code or throws PairingError("bad_code"). */
export function normalizePairingCode(input: string): string {
	const code = input.trim();
	if (!code) throw new PairingError("Enter the pairing code.", "bad_code");
	if (!PAIRING_CODE_RE.test(code)) throw new PairingError("That pairing code looks incomplete. Copy it again.", "bad_code");
	return code;
}

export function normalizeDeviceName(input: string): string {
	return input.replace(/\s+/g, " ").trim().slice(0, MAX_DEVICE_NAME_CHARS).trim();
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorCodeOf(json: unknown): string {
	const e = asRecord(json).error;
	return typeof e === "string" && /^[A-Za-z0-9_ .-]{1,64}$/.test(e) ? e : "";
}

function jsonHeaders(token?: string): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token !== undefined) headers.Authorization = `Bearer ${token}`;
	return headers;
}

/** Replace every occurrence of a secret with a placeholder (defense in depth for error text). */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const s of secrets) if (s.length >= 4) out = out.split(s).join("[redacted]");
	return out;
}

async function send(deps: PairingDeps, req: HttpRequest, secrets: readonly string[]): Promise<HttpResponse> {
	try {
		return await deps.request(req);
	} catch (err) {
		throw new PairingError(`Could not reach the server: ${scrubSecrets(errorMessage(err), secrets)}`, "network");
	}
}

/** Mapping shared by all routes for statuses that are not route-specific. */
function genericHttpError(status: number, json: unknown, action: string): PairingError {
	const code = errorCodeOf(json);
	if (status === 503 && code === "cf_daily_limit") {
		return new PairingError("The server reached its daily free-plan limit. Try again after 00:00 UTC.", code, status);
	}
	if (status === 429) return new PairingError("Too many attempts. Wait a minute and try again.", code || "rate_limited", status);
	if (status >= 500) return new PairingError(`The server could not ${action} right now (HTTP ${status}). Try again shortly.`, code || "server_error", status);
	return new PairingError(`The server refused to ${action} (HTTP ${status}${code ? `, ${code}` : ""}).`, code || "http_error", status);
}

// ---------------------------------------------------------------------------
// §2.1 Capabilities
// ---------------------------------------------------------------------------

export interface ServerCapabilities {
	readonly claimed: boolean;
	readonly streams: number | null;
	readonly attachments: boolean;
	readonly maxBlobUploadBytes: number | null;
	readonly serverVersion: string | null;
}

/** GET /api/capabilities. Throws PairingError unless the server is a claimed streams relay (streams === 1). */
export async function fetchCapabilities(host: string, deps: PairingDeps): Promise<ServerCapabilities> {
	const origin = normalizeHost(host);
	const res = await send(deps, { url: `${origin}/api/capabilities`, method: "GET" }, []);
	if (res.status === 404) throw new PairingError("No YAOS server answered at this address.", "not_found", 404);
	if (res.status !== 200) throw genericHttpError(res.status, res.json, "describe itself");
	const r = asRecord(res.json);
	const caps: ServerCapabilities = {
		claimed: r.claimed === true,
		streams: typeof r.streams === "number" ? r.streams : null,
		attachments: r.attachments === true,
		maxBlobUploadBytes: Number.isSafeInteger(r.maxBlobUploadBytes) ? r.maxBlobUploadBytes as number : null,
		serverVersion: typeof r.serverVersion === "string" ? r.serverVersion.slice(0, 64) : null,
	};
	if (caps.streams !== 1) {
		throw new PairingError("This server does not support this version of YAOS (streams sync is not enabled). Update the server.", "no_streams");
	}
	if (!caps.claimed) {
		throw new PairingError("This server has not been set up yet. Open it in a browser to claim it first.", "unclaimed");
	}
	return caps;
}

// ---------------------------------------------------------------------------
// §2.4 Enroll
// ---------------------------------------------------------------------------

export interface EnrollInput {
	readonly host: string;
	readonly pairingCode: string;
	readonly deviceName: string;
}

/**
 * One enrollment attempt with its client-generated ids. Re-running the same attempt is idempotent
 * on the server (same enrollmentRequestId), so the UI keeps it across retries of the same code.
 * Contains SECRETS (pairingCode, deviceToken): keep in memory only.
 */
export interface EnrollmentAttempt {
	readonly host: string;
	readonly pairingCode: string;
	readonly deviceName: string;
	readonly enrollmentRequestId: string;
	readonly deviceId: string;
	readonly deviceToken: string;
}

export function prepareEnrollment(input: EnrollInput, random: RandomBytesFn = defaultRandomBytes): EnrollmentAttempt {
	return {
		host: normalizeHost(input.host),
		pairingCode: normalizePairingCode(input.pairingCode),
		deviceName: normalizeDeviceName(input.deviceName),
		enrollmentRequestId: generateEnrollmentRequestId(random),
		deviceId: generateDeviceId(random),
		deviceToken: generateDeviceToken(random),
	};
}

/** True when `attempt` was prepared for exactly this input (so its ids may be reused). */
export function attemptMatches(attempt: EnrollmentAttempt | null, input: EnrollInput): attempt is EnrollmentAttempt {
	if (!attempt) return false;
	try {
		return attempt.host === normalizeHost(input.host)
			&& attempt.pairingCode === normalizePairingCode(input.pairingCode)
			&& attempt.deviceName === normalizeDeviceName(input.deviceName);
	} catch {
		return false;
	}
}

/** Waits before retry n (0-based) of a 202 authorization_fence_pending: 1 s, 2 s, 4 s, 4 s, ... */
export const FENCE_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 4000, 4000];
/** Retries after a network failure (same body, so idempotent). */
export const NETWORK_RETRY_DELAYS_MS: readonly number[] = [1000, 2000];

function enrollHttpError(status: number, json: unknown): PairingError {
	const code = errorCodeOf(json);
	switch (code) {
		case "expired_code": return new PairingError("This pairing code has expired. Ask for a new one.", code, status);
		case "used_code": return new PairingError("This pairing code was already used. Ask for a new one.", code, status);
		case "unknown_code":
		case "invalid_code": return new PairingError("This pairing code is not recognized. Check that it was copied completely.", code, status);
		case "invalid enrollment request": return new PairingError("The server rejected the pairing request. Check the pairing code and try again.", "invalid_request", status);
		default: break;
	}
	if (status === 404) return new PairingError("No YAOS enrollment endpoint at this address. Check the server address.", code || "not_found", status);
	if (status === 401 || status === 403) return new PairingError("The server refused this pairing code.", code || "forbidden", status);
	return genericHttpError(status, json, "pair this device");
}

/**
 * POST /enroll with the attempt's ids. 202 authorization_fence_pending is retried with the identical
 * body (backoff FENCE_RETRY_DELAYS_MS). Returns the identity to store in plugin data.
 */
export async function runEnrollment(attempt: EnrollmentAttempt, deps: PairingDeps): Promise<PairedIdentity> {
	const sleep = deps.sleep ?? defaultSleep;
	const body = JSON.stringify({
		pairingCode: attempt.pairingCode,
		enrollmentRequestId: attempt.enrollmentRequestId,
		deviceId: attempt.deviceId,
		deviceToken: attempt.deviceToken,
		...(attempt.deviceName ? { deviceName: attempt.deviceName } : {}),
	});
	const req: HttpRequest = { url: `${attempt.host}/enroll`, method: "POST", headers: jsonHeaders(), body };
	let fenceRetries = 0;
	let networkRetries = 0;
	let drainRetries = 0;
	deps.onProgress?.("Pairing with the server…");
	for (;;) {
		let res: HttpResponse;
		try {
			res = await send(deps, req, [attempt.pairingCode, attempt.deviceToken]);
		} catch (err) {
			const delay = NETWORK_RETRY_DELAYS_MS[networkRetries];
			if (delay === undefined) throw err;
			networkRetries++;
			deps.onProgress?.("Server unreachable, retrying…");
			await sleep(delay);
			continue;
		}
		if (res.status === 200) return readEnrollment(attempt, res.json);
		if (res.status === 202) {
			const delay = FENCE_RETRY_DELAYS_MS[fenceRetries];
			if (delay === undefined) {
				throw new PairingError(
					"The server accepted this device but has not finished authorizing it. Press Pair again in a few seconds (the same code still works for this attempt).",
					"authorization_fence_pending",
					202,
				);
			}
			fenceRetries++;
			deps.onProgress?.("Waiting for the server to authorize this device…");
			await sleep(delay);
			continue;
		}
		if (res.status === 503 && errorCodeOf(res.json) === "vault_draining") {
			const delay = FENCE_RETRY_DELAYS_MS[drainRetries];
			if (delay !== undefined) {
				drainRetries++;
				deps.onProgress?.("Server busy, retrying…");
				await sleep(delay);
				continue;
			}
		}
		throw enrollHttpError(res.status, res.json);
	}
}

function readEnrollment(attempt: EnrollmentAttempt, json: unknown): PairedIdentity {
	const r = asRecord(json);
	const incomplete = (): PairingError => new PairingError("The server returned incomplete pairing details.", "enroll_response_invalid", 200);
	if (typeof r.vaultId !== "string" || !r.vaultId.trim() || r.vaultId.length > 256) throw incomplete();
	if (r.deviceId !== undefined && r.deviceId !== attempt.deviceId) throw incomplete();
	// The server echoes the token it hashed; a different value means a broken or hostile response.
	if (r.deviceToken !== undefined && r.deviceToken !== attempt.deviceToken) throw incomplete();
	if (typeof r.host === "string" && r.host.trim()) {
		let returned: string;
		try {
			returned = normalizeHost(r.host);
		} catch {
			throw incomplete();
		}
		if (returned !== attempt.host) throw new PairingError("The server returned pairing details for a different address.", "host_mismatch", 200);
	}
	const deviceName = typeof r.deviceName === "string" && r.deviceName.trim() ? normalizeDeviceName(r.deviceName) : attempt.deviceName;
	const vaultGeneration = typeof r.vaultGeneration === "string" && r.vaultGeneration.trim() ? r.vaultGeneration : null;
	return {
		host: attempt.host,
		vaultId: r.vaultId.trim(),
		deviceId: attempt.deviceId,
		deviceToken: attempt.deviceToken,
		deviceName,
		vaultGeneration,
	};
}

/** Convenience: prepare + run. Use prepareEnrollment/runEnrollment to keep ids across retries. */
export async function enroll(input: EnrollInput, deps: PairingDeps): Promise<PairedIdentity> {
	return runEnrollment(prepareEnrollment(input, deps.randomBytes), deps);
}

/** Capabilities check, then enrollment. */
export async function pairDevice(attempt: EnrollmentAttempt, deps: PairingDeps): Promise<PairedIdentity> {
	deps.onProgress?.("Checking the server…");
	await fetchCapabilities(attempt.host, deps);
	return runEnrollment(attempt, deps);
}

// ---------------------------------------------------------------------------
// §2.5 Pair another device
// ---------------------------------------------------------------------------

export interface PairingCodeGrant {
	/** SECRET-ish: one-shot code shown to the user, never logged. */
	readonly pairingCode: string;
	/** Unix ms. */
	readonly expiresAt: number;
	/** obsidian://yaos?action=setup&host=...&pairingCode=... */
	readonly setupLink: string;
	/** Browser page for phones (from the server), if it returned one. */
	readonly mobileSetupUrl: string | null;
}

/** Fallback when the server omits expiresAt (relay-wire §11.1: pairing code TTL 15 min). */
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

export async function requestPairingCode(
	identity: PairedIdentity,
	deps: PairingDeps & { readonly nowMs?: () => number },
): Promise<PairingCodeGrant> {
	const host = normalizeHost(identity.host);
	const res = await send(deps, {
		url: `${host}/vault/${encodeURIComponent(identity.vaultId)}/auth/pairing-code`,
		method: "POST",
		headers: jsonHeaders(identity.deviceToken),
		body: JSON.stringify({ purpose: "device" }),
	}, [identity.deviceToken]);
	if (res.status !== 200) {
		const code = errorCodeOf(res.json);
		if (res.status === 401) throw new PairingError("This device is no longer authorized on the server. Pair it again.", code || "unauthorized", 401);
		if (res.status === 403) throw new PairingError("Your vault role is not allowed to pair devices.", code || "forbidden", 403);
		if (res.status === 404) throw new PairingError("The server does not know this vault. Check the connection settings.", code || "not_found", 404);
		if (res.status === 409) throw new PairingError("The vault is not active right now. Try again later.", code || "conflict", 409);
		throw genericHttpError(res.status, res.json, "create a pairing code");
	}
	const r = asRecord(res.json);
	if (typeof r.pairingCode !== "string" || !PAIRING_CODE_RE.test(r.pairingCode)) {
		throw new PairingError("The server returned an invalid pairing code.", "code_response_invalid", 200);
	}
	const now = deps.nowMs ? deps.nowMs() : Date.now();
	const expiresAt = Number.isSafeInteger(r.expiresAt) && (r.expiresAt as number) > 0 ? r.expiresAt as number : now + PAIRING_CODE_TTL_MS;
	let mobileSetupUrl: string | null = null;
	if (typeof r.mobileSetupUrl === "string" && r.mobileSetupUrl.startsWith(`${host}/`)) mobileSetupUrl = r.mobileSetupUrl;
	return { pairingCode: r.pairingCode, expiresAt, setupLink: buildSetupLink(host, r.pairingCode), mobileSetupUrl };
}

// ---------------------------------------------------------------------------
// Setup links (obsidian://yaos?...)
// ---------------------------------------------------------------------------

/** Same shape as the server's buildObsidianPairingUrl (server/src/routes/auth.ts). */
export function buildSetupLink(host: string, pairingCode: string): string {
	return `obsidian://yaos?${new URLSearchParams({ action: "setup", host: normalizeHost(host), pairingCode }).toString()}`;
}

export type SetupLinkParse =
	| { readonly ok: true; readonly host: string; readonly pairingCode: string }
	| { readonly ok: false; readonly reason: string };

/** Keys a setup link may carry. `vault` is Obsidian's own vault selector. */
const SETUP_LINK_KEYS = new Set(["action", "host", "pairingCode", "vault"]);

/**
 * Parse the params Obsidian hands to registerObsidianProtocolHandler("yaos", ...). Accepts only a
 * server address and a pairing code; anything else (credentials, vault ids, unknown fields) is
 * rejected so a link can never inject an identity.
 */
export function parseSetupLink(params: Readonly<Record<string, string>>): SetupLinkParse {
	for (const key of Object.keys(params)) {
		if (!SETUP_LINK_KEYS.has(key)) return { ok: false, reason: "This YAOS link contains unexpected fields and was ignored." };
	}
	const action = typeof params.action === "string" ? params.action.trim() : "";
	// Obsidian may report either the protocol action ("yaos") or the query's action ("setup").
	if (action !== "" && action !== "yaos" && action !== "setup") {
		return { ok: false, reason: "This YAOS link is not a setup link." };
	}
	const rawHost = typeof params.host === "string" ? params.host : "";
	const rawCode = typeof params.pairingCode === "string" ? params.pairingCode : "";
	if (!rawHost.trim() || !rawCode.trim()) return { ok: false, reason: "This YAOS setup link is missing the server address or the pairing code." };
	try {
		return { ok: true, host: normalizeHost(rawHost), pairingCode: normalizePairingCode(rawCode) };
	} catch (err) {
		return { ok: false, reason: `This YAOS setup link is invalid: ${errorMessage(err)}` };
	}
}
