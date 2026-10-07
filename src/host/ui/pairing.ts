/**
 * Pairing HTTP calls against the streams relay (docs/client-remake/relay-wire.md §2).
 * Ported from the old client (adfa7a7:src/onboarding/provisioningClient.ts and adfa7a7:src/runtime/setupLinkController.ts).
 *
 * Pure: every network call goes through an injected `request` function, randomness through an
 * injected `randomBytes`, waiting through an injected `sleep`. No obsidian runtime import.
 *
 * Every call ends: at PAIRING_CALL_DEADLINE_MS it fails "Could not reach the server: no answer within 15 s"
 * (code "network": an enrollment retries it, a pending one is kept for the next load). Obsidian's requestUrl takes
 * no signal and no timeout, so the wait is raced (core/deadline.ts) and the request itself left to finish unread.
 *
 * SECRETS: deviceToken, pairing codes, the operator recovery key, the operator session cookie and the vault key of a
 * setup or re-key link never appear in thrown messages or progress text.
 */

import { base64urlDecode, isVaultId } from "../../core/codec/ids";
import { bytesToHex, Reader, Writer } from "../../core/codec/lib0";
import { bounded, relayHttpDeadlineMs, RELAY_REPLY_BYTES } from "../../core/deadline";
import type { ClockPort } from "../../ports/clock";
import { browserClock } from "../platform";
import type { PairedIdentity } from "./api";
import { errorMessage } from "./format";

// ---------------------------------------------------------------------------
// Injected I/O
// ---------------------------------------------------------------------------

export interface HttpRequest {
	readonly url: string;
	readonly method: "GET" | "POST" | "DELETE";
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
}

export interface HttpResponse {
	readonly status: number;
	/** Parsed JSON body, or null/undefined when the body was not JSON. */
	readonly json: unknown;
	/**
	 * Response headers by lower-cased name, when the RequestFn supplies them (obsidianEnv.ts does). Only the
	 * operator login reads one: its `set-cookie` (an array on Electron, IncomingMessage.headers).
	 */
	readonly headers?: Readonly<Record<string, string | readonly string[]>>;
}

export type RequestFn = (req: HttpRequest) => Promise<HttpResponse>;
export type RandomBytesFn = (length: number) => Uint8Array;
export type SleepFn = (ms: number) => Promise<void>;

export interface PairingDeps {
	readonly request: RequestFn;
	readonly randomBytes?: RandomBytesFn;
	readonly sleep?: SleepFn;
	/** The calls' deadline timers; default setTimeout. */
	readonly clock?: Pick<ClockPort, "setTimer" | "clearTimer">;
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

/**
 * The deadline of every pairing, claim and operator call: each is one JSON request and reply of a few hundred bytes
 * (under RELAY_REPLY_BYTES) to the relay, so the relay's deadline for that size (core/deadline.ts: 15 s for the
 * request, covering a cold Durable Object and a congested link many times over, plus the bytes at 64 KiB/s).
 */
export const PAIRING_CALL_DEADLINE_MS = relayHttpDeadlineMs(RELAY_REPLY_BYTES);

/** `req`, rejecting PairingError "network" when no reply arrived within PAIRING_CALL_DEADLINE_MS. */
function call(deps: Pick<PairingDeps, "request" | "clock">, req: HttpRequest): Promise<HttpResponse> {
	return bounded(PAIRING_CALL_DEADLINE_MS, undefined, deps.clock ?? browserClock(), () => deps.request(req), () => new PairingError(
		`Could not reach the server: no answer within ${Math.round(PAIRING_CALL_DEADLINE_MS / 1000)} s.`, "network",
	));
}

async function send(deps: PairingDeps, req: HttpRequest, secrets: readonly string[]): Promise<HttpResponse> {
	try {
		return await call(deps, req);
	} catch (err) {
		if (err instanceof PairingError) throw err;
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

/**
 * GET /api/capabilities. Throws PairingError unless the server is a streams relay (streams === 1) and, unless
 * `allowUnclaimed` (only "Create a new vault" passes it: it claims an unclaimed server itself), claimed.
 */
export async function fetchCapabilities(host: string, deps: PairingDeps, options: { readonly allowUnclaimed?: boolean } = {}): Promise<ServerCapabilities> {
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
	if (!caps.claimed && options.allowUnclaimed !== true) {
		throw new PairingError("This server has not been set up yet. Run \"Create a new vault\" in YAOS to set it up.", "unclaimed");
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
	// Exactly a vaultId (22-char canonical base64url, server DECISIONS §2.1); the server's word is not enough.
	if (typeof r.vaultId !== "string" || !isVaultId(r.vaultId)) throw incomplete();
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
		vaultId: r.vaultId,
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

/**
 * The server's `mobileSetupUrl` is not kept: it is a server-drawn page, so it can carry only a key-less join, which
 * is blocked (e2ee-design §12.1). The pair modal builds its own link with buildSetupLink.
 */
export interface PairingCodeGrant {
	/** SECRET-ish: one-shot code shown to the user, never logged. */
	readonly pairingCode: string;
	/** Unix ms. */
	readonly expiresAt: number;
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
	// D3: the code names its vault. One for another vault would pair the other device elsewhere.
	if (pairingCodeVaultId(r.pairingCode) !== identity.vaultId) {
		throw new PairingError("The server returned a pairing code for a different vault.", "code_response_invalid", 200);
	}
	return { pairingCode: r.pairingCode, expiresAt };
}

// ---------------------------------------------------------------------------
// Retiring a replaced enrollment (DELETE /vault/:id/auth/device)
// ---------------------------------------------------------------------------

export const RETIRE_FAILED_MESSAGE = "Could not remove the old server membership. Remove it from the old server console.";

/**
 * Revokes an enrollment that a new pairing has replaced, authenticated by that enrollment's own
 * token: the server revokes the device the token belongs to (relay2 server/src/routes/enroll.ts:391-399).
 * Same request and outcome rule as the old client (adfa7a7:src/main.ts:3439-3473): 200 (revoked) and
 * 401 (the token is already dead) count as done. Anything else, including 202
 * authorization_fence_pending, and network errors throw PairingError(RETIRE_FAILED_MESSAGE); the
 * token never appears in it.
 */
export async function retireDeviceEnrollment(identity: PairedIdentity, deps: Pick<PairingDeps, "request" | "clock">): Promise<void> {
	let res: HttpResponse;
	try {
		res = await call(deps, {
			url: `${normalizeHost(identity.host)}/vault/${encodeURIComponent(identity.vaultId)}/auth/device`,
			method: "DELETE",
			headers: { Authorization: `Bearer ${identity.deviceToken}` },
		});
	} catch (err) {
		throw new PairingError(RETIRE_FAILED_MESSAGE, err instanceof PairingError ? err.code : "network");
	}
	if (res.status === 200 || res.status === 401) return;
	throw new PairingError(RETIRE_FAILED_MESSAGE, errorCodeOf(res.json) || "http_error", res.status);
}

// ---------------------------------------------------------------------------
// Claim and operator routes: "Create a new vault" only (relay-wire §2.2, e2ee-design §15.1)
// ---------------------------------------------------------------------------

/** D5 operator session cookie name (server/src/router.ts:97). */
const OPERATOR_COOKIE = "yaos_op";
/** server/src/config/host.ts:26. */
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** server/src/router.ts:188-191: the trimmed operator recovery key is at least 32 characters. */
const MIN_OPERATOR_KEY_CHARS = 32;
/** server/src/router.ts:103. */
export const MAX_VAULT_NAME_CHARS = 80;

/**
 * SECRET: an operator session (the `yaos_op` cookie value), held in memory for one creation flow and ended with
 * operatorLogout. Never stored, never logged.
 */
export interface OperatorSession {
	readonly host: string;
	readonly token: string;
}

/** What step 1 of the creation path returns: the new vault and its owner code. The code is a SECRET. */
export interface CreatedVault {
	readonly host: string;
	readonly vaultId: string;
	readonly pairingCode: string;
}

/**
 * `/claim` and the operator routes need JSON and `Origin` equal to the server's origin (server/src/router.ts:153-158,
 * DECISIONS D5). Obsidian's requestUrl is not a browser fetch, so the header is sent explicitly. The session token
 * goes in `Cookie`: requestUrl keeps no cookie jar.
 */
function operatorHeaders(origin: string, session?: OperatorSession): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
	if (session) headers.Cookie = `${OPERATOR_COOKIE}=${session.token}`;
	return headers;
}

function headerValues(res: HttpResponse, name: string): string[] {
	const out: string[] = [];
	for (const [key, value] of Object.entries(res.headers ?? {})) {
		if (key.toLowerCase() !== name) continue;
		if (typeof value === "string") out.push(value);
		else for (const v of value) if (typeof v === "string") out.push(v);
	}
	return out;
}

/** The `yaos_op` token from a response's Set-Cookie (an array, or one joined string), or null. */
function sessionTokenOf(res: HttpResponse): string | null {
	const re = new RegExp(`(?:^|[\\s,;])${OPERATOR_COOKIE}=([A-Za-z0-9_-]*)`, "g");
	for (const value of headerValues(res, "set-cookie")) {
		for (const m of value.matchAll(re)) {
			const token = m[1] ?? "";
			if (SESSION_TOKEN_RE.test(token)) return token;
		}
	}
	return null;
}

function retryAfterSeconds(res: HttpResponse): number | null {
	const raw = headerValues(res, "retry-after")[0];
	const n = raw === undefined ? NaN : Number(raw.trim());
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Normalizes the operator recovery key as the server does (trimmed), or throws PairingError("bad_operator_key"). */
export function normalizeOperatorKey(input: string): string {
	const key = input.trim();
	if (key.length < MIN_OPERATOR_KEY_CHARS) throw new PairingError(`The operator key is at least ${MIN_OPERATOR_KEY_CHARS} characters. Paste all of it.`, "bad_operator_key");
	return key;
}

/** A new operator recovery key, as the console makes one (server/src/console/console.ts:248-250): 32 random bytes, hex. */
export function generateOperatorKey(random: RandomBytesFn = defaultRandomBytes): string {
	const bytes = random(32);
	try {
		return bytesToHex(bytes);
	} finally {
		bytes.fill(0);
	}
}

/** Mapping for the claim and operator routes; `action` completes "The server refused to ...". */
function operatorHttpError(res: HttpResponse, action: string): PairingError {
	const code = errorCodeOf(res.json);
	const status = res.status;
	switch (code) {
		case "forbidden_origin":
			return new PairingError("The server refused this request because it did not carry the server's own Origin header, so YAOS cannot create a vault on this server from this device.", code, status);
		case "unsupported_media_type":
			return new PairingError("The server refused the request format. Update YAOS or the server.", code, status);
		case "unauthorized":
			return new PairingError("The server did not accept the operator key.", code, status);
		case "already_claimed":
			return new PairingError("Someone set up this server meanwhile. Run \"Create a new vault\" again and enter its operator key.", code, status);
		case "claim_incomplete":
			return new PairingError("The server was set up, but it could not finish its first vault. Run \"Create a new vault\" again with the operator key you saved.", code, status);
		case "invalid operatorRecoveryKey":
			return new PairingError(`The server refused the operator key: it is at least ${MIN_OPERATOR_KEY_CHARS} characters.`, "bad_operator_key", status);
		case "invalid_name":
			return new PairingError(`The vault name is too long (at most ${MAX_VAULT_NAME_CHARS} characters).`, code, status);
		case "unknown_vault":
			return new PairingError("The server lost the new vault before it gave out a pairing code. Try again.", code, status);
		case "restore_in_progress":
			return new PairingError("The server is restoring this vault. Try again when the restore has finished.", code, status);
		case "too_many_attempts": {
			const wait = retryAfterSeconds(res);
			return new PairingError(`Too many operator key attempts. Wait ${wait !== null ? `${wait} s` : "a minute"} and try again.`, code, status);
		}
		default: break;
	}
	if (status === 401) return new PairingError("The server did not accept the operator key.", code || "unauthorized", status);
	return genericHttpError(status, res.json, action);
}

function createdVaultOf(origin: string, json: unknown, vaultId: unknown, codeField: "pairingCode"): CreatedVault {
	const r = asRecord(json);
	const code = r[codeField];
	if (typeof vaultId !== "string" || !isVaultId(vaultId) || typeof code !== "string" || !PAIRING_CODE_RE.test(code)) {
		throw new PairingError("The server returned incomplete vault details.", "create_response_invalid", 200);
	}
	return { host: origin, vaultId, pairingCode: code };
}

/**
 * `POST /claim` on an unclaimed server (server/src/router.ts:293-336): makes the first vault and returns its owner
 * code. The response's `obsidianUrl` is ignored: the code is used in memory only (§15.1 step 2). The session cookie
 * it sets is not needed and is ended with operatorLogout.
 */
export async function claimServer(host: string, operatorKey: string, deps: PairingDeps): Promise<{ readonly vault: CreatedVault; readonly session: OperatorSession | null }> {
	const origin = normalizeHost(host);
	const key = normalizeOperatorKey(operatorKey);
	const res = await send(deps, { url: `${origin}/claim`, method: "POST", headers: operatorHeaders(origin), body: JSON.stringify({ operatorRecoveryKey: key }) }, [key]);
	const token = sessionTokenOf(res);
	const session = token ? { host: origin, token } : null;
	if (res.status !== 200) {
		if (session) await operatorLogout(session, deps);
		throw operatorHttpError(res, "set up this server");
	}
	const r = asRecord(res.json);
	if (r.ok !== true) throw new PairingError("The server returned incomplete vault details.", "create_response_invalid", 200);
	return { vault: createdVaultOf(origin, res.json, r.vaultId, "pairingCode"), session };
}

/** `POST /operator/login` (server/src/router.ts:339-352). */
export async function operatorLogin(host: string, operatorKey: string, deps: PairingDeps): Promise<OperatorSession> {
	const origin = normalizeHost(host);
	const key = normalizeOperatorKey(operatorKey);
	const res = await send(deps, { url: `${origin}/operator/login`, method: "POST", headers: operatorHeaders(origin), body: JSON.stringify({ operatorRecoveryKey: key }) }, [key]);
	if (res.status !== 200) throw operatorHttpError(res, "log in");
	const token = sessionTokenOf(res);
	if (!token) {
		throw new PairingError("The server accepted the operator key, but Obsidian did not pass on its session cookie, so YAOS cannot create a vault on this server from this device.", "no_session", 200);
	}
	return { host: origin, token };
}

/** `POST /operator/vaults {name}` then `POST /operator/vaults/:id/owner-code` (server/src/router.ts:373-392, :470-488). */
export async function operatorCreateVault(session: OperatorSession, name: string, deps: PairingDeps): Promise<CreatedVault> {
	const origin = session.host;
	const created = await send(deps, {
		url: `${origin}/operator/vaults`,
		method: "POST",
		headers: operatorHeaders(origin, session),
		body: JSON.stringify({ name: name.replace(/\s+/g, " ").trim() }),
	}, [session.token]);
	if (created.status !== 200) throw operatorHttpError(created, "create a vault");
	const vault = asRecord(asRecord(created.json).vault);
	const vaultId = vault.vaultId;
	if (typeof vaultId !== "string" || !isVaultId(vaultId)) throw new PairingError("The server returned incomplete vault details.", "create_response_invalid", 200);
	const minted = await send(deps, {
		url: `${origin}/operator/vaults/${encodeURIComponent(vaultId)}/owner-code`,
		method: "POST",
		headers: operatorHeaders(origin, session),
		body: JSON.stringify({ purpose: "owner-bootstrap" }),
	}, [session.token]);
	if (minted.status !== 200) throw operatorHttpError(minted, "create a pairing code for the new vault");
	return createdVaultOf(origin, minted.json, vaultId, "pairingCode");
}

/** `POST /operator/logout` (server/src/router.ts:355-361). Best effort: it never throws, and ends at the deadline. */
export async function operatorLogout(session: OperatorSession, deps: Pick<PairingDeps, "request" | "clock">): Promise<void> {
	try {
		await call(deps, { url: `${session.host}/operator/logout`, method: "POST", headers: operatorHeaders(session.host, session), body: "{}" });
	} catch {
		// The session expires on its own (7 days, server/src/config/host.ts:24, router.ts:125-127).
	}
}

// ---------------------------------------------------------------------------
// Setup links (obsidian://yaos?...), e2ee-design §12.1, §12.4, §14.2 step 3
// ---------------------------------------------------------------------------

/**
 * SECRET: a vault key as a setup or re-key link carries it, `key=<b64url(u8 1 ‖ varuint e ‖ K_e)>` (§12.1). Callers
 * zero-fill `k` once it is handed on. Never logged, never in a notice, status or diagnostics.
 */
export interface LinkKey {
	/** Key epoch, >= 1. */
	readonly e: number;
	/** K_e, 32 bytes. */
	readonly k: Uint8Array;
}

/** The encryption part of a setup link: a key (suite 1, source (i)) or `suite=0` (source (ii)). */
export type LinkE2ee = { readonly suite: 0 } | { readonly suite: 1; readonly key: LinkKey };

const LINK_KEY_VERSION = 1;
const LINK_KEY_BYTES = 32;
/** 1 + varuint(2^53 - 1) (8 bytes) + 32 bytes, as base64url. */
const MAX_KEY_PARAM_CHARS = 56;

/** The `key` parameter for `key`. Throws (with no key material in the message) on a bad epoch or key length. */
export function encodeKeyParam(key: LinkKey): string {
	if (!Number.isSafeInteger(key.e) || key.e < 1) throw new PairingError("The vault key has an invalid epoch.", "bad_key");
	if (key.k.length !== LINK_KEY_BYTES) throw new PairingError("The vault key has the wrong length.", "bad_key");
	const epoch = new Writer(16).varuint(key.e).finish();
	const bytes = new Uint8Array(1 + epoch.length + LINK_KEY_BYTES);
	bytes[0] = LINK_KEY_VERSION;
	bytes.set(epoch, 1);
	bytes.set(key.k, 1 + epoch.length);
	try {
		return base64Url(bytes);
	} finally {
		bytes.fill(0);
	}
}

/**
 * Strict decode of a `key` parameter: version 1, epoch >= 1 (minimal varuint), exactly 32 key bytes, nothing after
 * them, and canonical base64url (it re-encodes to the same text). Null when anything is off; the caller's message
 * never echoes the parameter.
 */
export function decodeKeyParam(raw: string): LinkKey | null {
	if (raw.length === 0 || raw.length > MAX_KEY_PARAM_CHARS) return null;
	let bytes: Uint8Array;
	try {
		bytes = base64urlDecode(raw);
	} catch {
		return null;
	}
	try {
		if (base64Url(bytes) !== raw) return null;
		const r = new Reader(bytes);
		if (r.u8() !== LINK_KEY_VERSION) return null;
		const e = r.varuint();
		if (e < 1 || r.remaining !== LINK_KEY_BYTES) return null;
		return { e, k: r.copy(LINK_KEY_BYTES) };
	} catch {
		return null;
	} finally {
		bytes.fill(0);
	}
}

/** The vaultId half of a server pairing code `<vaultId>.<secret>` (DECISIONS D3), or null when it has none. */
export function pairingCodeVaultId(pairingCode: string): string | null {
	const code = pairingCode.trim();
	const dot = code.indexOf(".");
	if (dot <= 0) return null;
	const id = code.slice(0, dot);
	return isVaultId(id) ? id : null;
}

/**
 * Same shape as the server's buildObsidianPairingUrl (server/src/setupQr.ts:12), plus the client-only `key` or
 * `suite=0` (§12.1). With e2ee the result is a SECRET: show it only on an explicit click, never log it.
 */
export function buildSetupLink(host: string, pairingCode: string, e2ee: LinkE2ee | null = null): string {
	const fields: Record<string, string> = { action: "setup", host: normalizeHost(host), pairingCode };
	if (e2ee?.suite === 1) fields.key = encodeKeyParam(e2ee.key);
	else if (e2ee?.suite === 0) fields.suite = "0";
	return `obsidian://yaos?${new URLSearchParams(fields).toString()}`;
}

/** SECRET: the re-key link of §14.2 step 3. No pairing code: the devices it is for are already enrolled. */
export function buildRekeyLink(key: LinkKey): string {
	return `obsidian://yaos?action=rekey&key=${encodeKeyParam(key)}`;
}

export type SetupLinkParse =
	| {
		readonly ok: true;
		readonly kind: "setup";
		readonly host: string;
		readonly pairingCode: string;
		/** Null: a key-less link (the console's, a claim response's obsidianUrl, a code-only link), §12.4. */
		readonly e2ee: LinkE2ee | null;
	}
	| { readonly ok: true; readonly kind: "rekey"; readonly key: LinkKey }
	| { readonly ok: false; readonly reason: string };

/** Keys a setup link may carry. `vault` is Obsidian's own vault selector. */
const SETUP_LINK_KEYS = new Set(["action", "host", "pairingCode", "vault", "key", "suite"]);

/**
 * Parse the params Obsidian hands to registerObsidianProtocolHandler("yaos", ...). A setup link carries a server
 * address and a pairing code, and at most one of `key` and `suite=0` (§12.4: never both, no other suite value). A
 * re-key link carries only `key`. Anything else (credentials, vault ids, unknown fields) is rejected so a link can
 * never inject an identity. No reason ever contains the code or the key.
 */
export function parseSetupLink(params: Readonly<Record<string, string>>): SetupLinkParse {
	for (const key of Object.keys(params)) {
		if (!SETUP_LINK_KEYS.has(key)) return { ok: false, reason: "This YAOS link contains unexpected fields and was ignored." };
	}
	const field = (name: string): string | null => (typeof params[name] === "string" ? params[name] : null);
	const action = (field("action") ?? "").trim();
	// Obsidian may report either the protocol action ("yaos") or the query's action ("setup", "rekey").
	if (action !== "" && action !== "yaos" && action !== "setup" && action !== "rekey") {
		return { ok: false, reason: "This YAOS link is not a setup link." };
	}
	const rawKey = field("key");
	const rawSuite = field("suite");
	if (rawKey !== null && rawSuite !== null) {
		return { ok: false, reason: "This YAOS link carries both a vault key and suite=0, which never happens, so it was ignored." };
	}
	if (rawSuite !== null && rawSuite !== "0") return { ok: false, reason: "This YAOS link names an encryption suite YAOS does not accept, so it was ignored." };
	const rawHost = field("host") ?? "";
	const rawCode = field("pairingCode") ?? "";
	let key: LinkKey | null = null;
	if (rawKey !== null) {
		key = decodeKeyParam(rawKey);
		if (!key) return { ok: false, reason: "The vault key in this YAOS link is damaged. Copy or scan the link again." };
	}
	if (action === "rekey" || (action !== "setup" && key && !rawHost.trim() && !rawCode.trim())) {
		if (!key || rawHost !== "" || rawCode !== "" || rawSuite !== null) {
			key?.k.fill(0);
			return { ok: false, reason: "This YAOS re-key link is invalid. Show the re-key QR on your other device again." };
		}
		return { ok: true, kind: "rekey", key };
	}
	if (!rawHost.trim() || !rawCode.trim()) {
		key?.k.fill(0);
		return { ok: false, reason: "This YAOS setup link is missing the server address or the pairing code." };
	}
	try {
		const host = normalizeHost(rawHost);
		const pairingCode = normalizePairingCode(rawCode);
		const e2ee: LinkE2ee | null = key ? { suite: 1, key } : rawSuite === "0" ? { suite: 0 } : null;
		return { ok: true, kind: "setup", host, pairingCode, e2ee };
	} catch (err) {
		key?.k.fill(0);
		return { ok: false, reason: `This YAOS setup link is invalid: ${errorMessage(err)}` };
	}
}
