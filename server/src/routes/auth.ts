import { randomBase64Url } from "../base64url";
import type { ConsoleState, StoredServerConfig } from "../config";
import type { VaultRecord } from "../identity";
import { MAX_BLOB_UPLOAD_BYTES } from "../contracts";
import {
	CONFIG_FORMAT,
	OPERATOR_COOKIE,
	OPERATOR_SESSION_TTL_MS,
	PAIRING_CODE_BYTES,
	SESSION_TOKEN_BYTES,
	SIGNING_KEY_BYTES,
	type DevicePublic,
	hashSecret,
	randomSecret,
} from "../identity";
import { buildMobileSetupUrl, renderSetupQrDataUrl } from "../setupQr";
import {
	SERVER_PROTOCOL_VERSION,
	SERVER_SCHEMA_VERSION,
	SERVER_SETTINGS_FORMAT_VERSION,
	SERVER_SNAPSHOT_FORMAT_VERSION,
	SERVER_STORAGE_FORMAT_VERSION,
	SERVER_VERSION,
} from "../version";
import { json } from "./http";
import { provisionReservedVault } from "./provisioning";
import type { AuthState, AuthStateCached, Env, UpdateProvider } from "./types";

export function getHttpAuthToken(req: Request): string | null {
	const authorization = req.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) return null;
	const token = authorization.slice("Bearer ".length).trim();
	return token || null;
}

export function supportsBuckets(env: Env): boolean {
	return env.YAOS_BUCKET !== undefined;
}

export async function getStoredServerConfig(env: Env): Promise<StoredServerConfig> {
	const response = await env.YAOS_CONFIG.call("global-config", new Request("https://internal/__yaos/config"));
	if (!response.ok) throw new Error(`config fetch failed (${response.status})`);
	return response.json();
}

const AUTH_CONFIG_CACHE_TTL_MS = 60_000;
let cachedConfig: { value: StoredServerConfig; expiresAt: number } | null = null;
let configInflight: Promise<StoredServerConfig> | null = null;

export function invalidateStoredServerConfigCache(): void {
	cachedConfig = null;
	configInflight = null;
}

export async function getStoredServerConfigCached(env: Env): Promise<StoredServerConfig> {
	const now = Date.now();
	if (cachedConfig && cachedConfig.expiresAt > now) return cachedConfig.value;
	if (configInflight) return configInflight;
	configInflight = getStoredServerConfig(env)
		.then((config) => {
			cachedConfig = { value: config, expiresAt: Date.now() + AUTH_CONFIG_CACHE_TTL_MS };
			return config;
		})
		.finally(() => {
			configInflight = null;
		});
	return configInflight;
}

export async function configFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
	return env.YAOS_CONFIG.call("global-config", new Request(`https://internal${path}`, init));
}

function authStateFromConfig(config: StoredServerConfig): AuthStateCached {
	if (config.claimed && config.configFormat !== CONFIG_FORMAT) {
		return { mode: "unsupported", claimed: true, config };
	}
	if (
		config.claimed
		&& config.configFormat === CONFIG_FORMAT
		&& typeof config.operatorRecoveryHash === "string"
		&& config.operatorRecoveryHash.length > 0
		&& typeof config.ticketSigningKey === "string"
		&& config.ticketSigningKey.length > 0
	) {
		return {
			mode: "claim",
			claimed: true,
			operatorRecoveryHash: config.operatorRecoveryHash,
			ticketSigningKey: config.ticketSigningKey,
			config,
		};
	}
	if (config.claimed) return { mode: "unsupported", claimed: true, config };
	return { mode: "unclaimed", claimed: false, config };
}

export async function getAuthStateCached(env: Env): Promise<AuthStateCached> {
	return authStateFromConfig(await getStoredServerConfigCached(env));
}

export type PreAuthRejectionReason =
	| "unclaimed"
	| "server_format_unsupported"
	| "server_misconfigured"
	| "unauthorized";

export interface AuthRejection {
	response: Response;
	reason: PreAuthRejectionReason;
}

export async function authorizeDevice(
	env: Env,
	token: string | null,
	vaultId: string,
): Promise<DevicePublic | null> {
	if (!token) return null;
	const tokenHash = await hashSecret(token);
	const response = await configFetch(env, "/__yaos/authorize-device", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ tokenHash, vaultId }),
	});
	if (!response.ok) return null;
	const body: { device?: DevicePublic } = await response.json();
	return body.device ?? null;
}

export async function authorizeAnyDevice(env: Env, token: string | null): Promise<boolean> {
	if (!token) return false;
	const tokenHash = await hashSecret(token);
	const response = await configFetch(env, "/__yaos/authorize-device", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ tokenHash }),
	});
	return response.ok;
}

export async function readConsoleState(env: Env): Promise<ConsoleState | null> {
	const response = await configFetch(env, "/__yaos/console");
	return response.ok ? response.json() : null;
}

export async function rejectUnauthorizedVaultRequest(
	req: Request,
	env: Env,
	authState: AuthState,
	vaultId: string,
): Promise<AuthRejection | null> {
	if (authState.mode === "unsupported") {
		return { response: json({ error: "server_format_unsupported" }, 503), reason: "server_format_unsupported" };
	}
	if (!authState.claimed) {
		return { response: json({ error: "unclaimed" }, 503), reason: "unclaimed" };
	}
	if (authState.mode !== "claim" || !authState.ticketSigningKey) {
		return { response: json({ error: "server_misconfigured" }, 503), reason: "server_misconfigured" };
	}
	if (!(await authorizeDevice(env, getHttpAuthToken(req), vaultId))) {
		return { response: json({ error: "unauthorized" }, 401), reason: "unauthorized" };
	}
	return null;
}

export function readOperatorSessionToken(req: Request): string | null {
	const cookie = req.headers.get("Cookie");
	if (!cookie) return null;
	for (const part of cookie.split(";")) {
		const trimmed = part.trim();
		if (trimmed.startsWith(`${OPERATOR_COOKIE}=`)) {
			const value = trimmed.slice(OPERATOR_COOKIE.length + 1).trim();
			return value || null;
		}
	}
	return null;
}

export function operatorCookieHeader(sessionToken: string, reqUrl: string, maxAgeSec: number): string {
	const secure = new URL(reqUrl).protocol === "https:" ? "; Secure" : "";
	return `${OPERATOR_COOKIE}=${sessionToken}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`;
}

export function clearOperatorCookieHeader(reqUrl: string): string {
	const secure = new URL(reqUrl).protocol === "https:" ? "; Secure" : "";
	return `${OPERATOR_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

export async function verifyOperatorSession(env: Env, req: Request): Promise<boolean> {
	const token = readOperatorSessionToken(req);
	if (!token) return false;
	const sessionHash = await hashSecret(token);
	const response = await configFetch(env, "/__yaos/verify-session", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sessionHash }),
	});
	return response.ok;
}

export async function createOperatorSession(env: Env, reqUrl: string): Promise<{ token: string; header: string }> {
	const token = randomSecret(SESSION_TOKEN_BYTES);
	const sessionHash = await hashSecret(token);
	const exp = Date.now() + OPERATOR_SESSION_TTL_MS;
	const response = await configFetch(env, "/__yaos/create-session", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sessionHash, exp }),
	});
	if (!response.ok) throw new Error("session create failed");
	return {
		token,
		header: operatorCookieHeader(token, reqUrl, Math.floor(OPERATOR_SESSION_TTL_MS / 1_000)),
	};
}

export function buildObsidianPairingUrl(host: string, pairingCode: string): string {
	return `obsidian://yaos?${new URLSearchParams({ action: "setup", host, pairingCode }).toString()}`;
}

export function getCapabilities(
	auth: AuthState,
	env: Env,
	config: StoredServerConfig | null = null,
	options: { includePrivateUpdateMetadata?: boolean } = {},
): {
	claimed: boolean;
	attachments: boolean;
	snapshots: boolean;
	recoveryJobs: boolean;
	settingsSync: boolean;
	maxBlobUploadBytes: number;
	serverVersion: string;
	schemaVersion: number;
	storageFormatVersion: number;
	protocolVersion: number;
	snapshotFormatVersion: number;
	settingsFormatVersion: number;
	updateProvider: UpdateProvider | null;
	updateRepoUrl: string | null;
	updateRepoBranch: string | null;
} {
	const bucketEnabled = supportsBuckets(env);
	const recoveryJobs = bucketEnabled && Boolean(env.YAOS_RECOVERY_JOBS);
	return {
		claimed: auth.claimed,
		attachments: bucketEnabled,
		snapshots: recoveryJobs,
		recoveryJobs,
		settingsSync: true,
		maxBlobUploadBytes: MAX_BLOB_UPLOAD_BYTES,
		serverVersion: SERVER_VERSION,
		schemaVersion: SERVER_SCHEMA_VERSION,
		storageFormatVersion: SERVER_STORAGE_FORMAT_VERSION,
		protocolVersion: SERVER_PROTOCOL_VERSION,
		snapshotFormatVersion: SERVER_SNAPSHOT_FORMAT_VERSION,
		settingsFormatVersion: SERVER_SETTINGS_FORMAT_VERSION,
		updateProvider: options.includePrivateUpdateMetadata ? (config?.updateProvider ?? null) : null,
		updateRepoUrl: options.includePrivateUpdateMetadata ? (config?.updateRepoUrl ?? null) : null,
		updateRepoBranch: options.includePrivateUpdateMetadata ? (config?.updateRepoBranch ?? null) : null,
	};
}

export async function handleClaimRoute(req: Request, env: Env, authState: AuthState): Promise<Response> {
	const url = new URL(req.url);
	if (authState.mode === "unsupported") return json({ error: "server_format_unsupported" }, 409);
	// A claimed server may still have a retryable reserved vault; config owns
	// the idempotent decision and rejects the ordinary already-active case.
	let body: { operatorRecoveryKey?: string };
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}
	const operatorRecoveryKey = typeof body.operatorRecoveryKey === "string" ? body.operatorRecoveryKey.trim() : "";
	if (operatorRecoveryKey.length < 32) return json({ error: "invalid operatorRecoveryKey" }, 400);

	const operatorRecoveryHash = await hashSecret(operatorRecoveryKey);
	const ticketSigningKey = randomSecret(SIGNING_KEY_BYTES);
	const vaultId = randomBase64Url(16);
	const pairingCode = randomSecret(PAIRING_CODE_BYTES);
	const pairingCodeHash = await hashSecret(pairingCode);
	let mobileSetupQrDataUrl: string;
	try {
		mobileSetupQrDataUrl = await renderSetupQrDataUrl(buildMobileSetupUrl(url.origin, pairingCode));
	} catch {
		return json({ error: "setup QR generation failed" }, 500);
	}
	const claimed = await configFetch(env, "/__yaos/claim", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operatorRecoveryHash, ticketSigningKey, vaultId, vaultName: "Personal", pairingCodeHash, pairingPurpose: "origin" }),
	});
	if (!claimed.ok) {
		const errorBody = await claimed.json().catch(() => null) as { error?: string } | null;
		return json({ error: errorBody?.error ?? "already_claimed" }, claimed.status);
	}
	const claimPayload = await claimed.json().catch(() => null) as {
		vaultId?: string;
		vaultGeneration?: string;
		vaultName?: string;
	} | null;
	if (
		typeof claimPayload?.vaultId !== "string"
		|| typeof claimPayload.vaultGeneration !== "string"
		|| typeof claimPayload.vaultName !== "string"
	) {
		return json({ error: "claim_response_invalid" }, 502);
	}
	const reservedVault: VaultRecord = {
		vaultId: claimPayload.vaultId,
		vaultGeneration: claimPayload.vaultGeneration,
		name: claimPayload.vaultName,
		state: "provisioning",
		createdAt: 0,
		provisionedAt: null,
	};
	const provisioned = await provisionReservedVault(env, reservedVault, {
		codeHash: pairingCodeHash,
		purpose: "origin",
	});
	if (!provisioned.ok) return provisioned;
	const activation = await provisioned.json().catch(() => null) as {
		pairingExp?: number;
		vault?: VaultRecord;
	} | null;
	if (typeof activation?.pairingExp !== "number" || activation.vault?.state !== "active") {
		return json({ error: "claim_activation_invalid" }, 502);
	}
	invalidateStoredServerConfigCache();
	let sessionHeader: string | undefined;
	try {
		sessionHeader = (await createOperatorSession(env, req.url)).header;
	} catch (error) {
		console.warn("[yaos-sync:worker] operator session create failed after claim:", error);
	}
	let claimedConfig: StoredServerConfig | null = null;
	try {
		claimedConfig = await getStoredServerConfig(env);
	} catch (error) {
		console.warn("[yaos-sync:worker] config fetch failed after claim:", error);
	}
	const response = json({
		ok: true,
		host: url.origin,
		vaultId: activation.vault.vaultId,
		vaultName: activation.vault.name,
		pairingCode,
		pairingExpiresAt: activation.pairingExp,
		obsidianUrl: buildObsidianPairingUrl(url.origin, pairingCode),
		mobileSetupQrDataUrl,
		capabilities: getCapabilities(
			{
				mode: "claim",
				claimed: true,
				operatorRecoveryHash,
				ticketSigningKey: claimedConfig?.ticketSigningKey ?? ticketSigningKey,
			},
			env,
			claimedConfig,
			{ includePrivateUpdateMetadata: true },
		),
	});
	if (!sessionHeader) return response;
	const headers = new Headers(response.headers);
	headers.append("Set-Cookie", sessionHeader);
	return new Response(response.body, { status: response.status, headers });
}

export async function handleUpdateMetadataRoute(req: Request, env: Env, authState: AuthState): Promise<Response> {
	if (authState.mode === "unsupported") return json({ error: "server_format_unsupported" }, 503);
	if (!authState.claimed) return json({ error: "unclaimed" }, 503);
	if (!(await verifyOperatorSession(env, req))) return json({ error: "unauthorized" }, 401);
	let body: { updateProvider?: unknown; updateRepoUrl?: unknown; updateRepoBranch?: unknown };
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}
	const response = await configFetch(env, "/__yaos/update-metadata", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const errorBody = await response.json().catch(() => null) as { error?: string } | null;
		return json({ error: errorBody?.error ?? "metadata write failed" }, response.status);
	}
	const payload: { config?: StoredServerConfig } = await response.json();
	invalidateStoredServerConfigCache();
	return json({ ok: true, capabilities: getCapabilities(authState, env, payload.config ?? null, { includePrivateUpdateMetadata: true }) });
}

export async function mintPairingCode(
	env: Env,
	vaultId: string,
	purpose: "device" | "invite",
): Promise<{ pairingCode: string; exp: number } | { error: string; status: number }> {
	const pairingCode = randomSecret(PAIRING_CODE_BYTES);
	const codeHash = await hashSecret(pairingCode);
	const response = await configFetch(env, "/__yaos/create-pairing-code", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ vaultId, codeHash, purpose }),
	});
	if (!response.ok) {
		const errorBody = await response.json().catch(() => null) as { error?: string } | null;
		return { error: errorBody?.error ?? "pairing create failed", status: response.status };
	}
	const payload = await response.json().catch(() => null) as { exp?: number } | null;
	return typeof payload?.exp === "number"
		? { pairingCode, exp: payload.exp }
		: { error: "pairing create response invalid", status: 502 };
}
