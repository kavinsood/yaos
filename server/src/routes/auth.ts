import { sha256Hex } from "../hex";
import type { StoredServerConfig } from "../config";
import {
	SERVER_MAX_SCHEMA_VERSION,
	SERVER_MIGRATION_REQUIRED,
	SERVER_MIN_PLUGIN_VERSION,
	SERVER_MIN_SCHEMA_VERSION,
	SERVER_RECOMMENDED_PLUGIN_VERSION,
	SERVER_VERSION,
} from "../version";
import { json } from "./http";
import type { AuthState, Env, UpdateProvider } from "./types";

export function getHttpAuthToken(req: Request): string | null {
	const auth = req.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) return null;
	const token = auth.slice("Bearer ".length).trim();
	return token || null;
}

export function getSocketAuthToken(req: Request): string | null {
	const headerToken = getHttpAuthToken(req);
	if (headerToken) return headerToken;
	return new URL(req.url).searchParams.get("token");
}

async function hashToken(token: string): Promise<string> {
	const bytes = new TextEncoder().encode(token);
	return sha256Hex(bytes);
}

export function supportsBuckets(env: Env): boolean {
	return env.YAOS_BUCKET !== undefined;
}

export function canonicalRepoForSetup(env: Env): string | undefined {
	const raw = env.YAOS_CANONICAL_REPO?.trim();
	if (!raw) return undefined;
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? raw : undefined;
}

export async function getStoredServerConfig(env: Env): Promise<StoredServerConfig> {
	const id = env.YAOS_CONFIG.idFromName("global-config");
	const stub = env.YAOS_CONFIG.get(id);
	const res = await stub.fetch("https://internal/__yaos/config");
	if (!res.ok) {
		throw new Error(`config fetch failed (${res.status})`);
	}
	return await res.json();
}

async function claimServerConfig(env: Env, tokenHash: string): Promise<boolean> {
	const id = env.YAOS_CONFIG.idFromName("global-config");
	const stub = env.YAOS_CONFIG.get(id);
	const res = await stub.fetch("https://internal/__yaos/claim", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ tokenHash }),
	});
	return res.ok;
}

async function setServerUpdateMetadata(env: Env, metadata: {
	updateProvider?: unknown;
	updateRepoUrl?: unknown;
	updateRepoBranch?: unknown;
}): Promise<StoredServerConfig> {
	const id = env.YAOS_CONFIG.idFromName("global-config");
	const stub = env.YAOS_CONFIG.get(id);
	const res = await stub.fetch("https://internal/__yaos/update-metadata", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(metadata),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`update metadata write failed (${res.status})${body ? `: ${body}` : ""}`);
	}
	const payload: { config?: StoredServerConfig } = await res.json();
	if (!payload?.config) {
		throw new Error("update metadata write failed (missing config)");
	}
	return payload.config;
}

export async function getAuthState(env: Env): Promise<AuthState> {
	const envToken = env.SYNC_TOKEN?.trim();
	if (envToken) {
		return { mode: "env", claimed: true, envToken };
	}

	const config = await getStoredServerConfig(env);
	if (config.claimed && typeof config.tokenHash === "string" && config.tokenHash.length > 0) {
		return { mode: "claim", claimed: true, tokenHash: config.tokenHash };
	}

	return { mode: "unclaimed", claimed: false };
}

export async function isAuthorized(
	state: AuthState,
	token: string | null,
): Promise<boolean> {
	if (!token) return false;
	if (state.mode === "env") {
		return token === state.envToken;
	}
	if (state.mode === "claim") {
		return (await hashToken(token)) === state.tokenHash;
	}
	return false;
}

function buildObsidianSetupUrl(host: string, token: string, vaultId?: string): string {
	const params = new URLSearchParams({
		action: "setup",
		host,
		token,
	});
	if (vaultId) {
		params.set("vaultId", vaultId);
	}
	return `obsidian://yaos?${params.toString()}`;
}

export function getCapabilities(auth: AuthState, env: Env, config: StoredServerConfig | null = null): {
	claimed: boolean;
	authMode: "env" | "claim" | "unclaimed";
	attachments: boolean;
	snapshots: boolean;
	serverVersion: string;
	minPluginVersion: string | null;
	recommendedPluginVersion: string | null;
	minSchemaVersion: number | null;
	maxSchemaVersion: number | null;
	migrationRequired: boolean;
	updateProvider: UpdateProvider | null;
	updateRepoUrl: string | null;
	updateRepoBranch: string | null;
} {
	const bucketEnabled = supportsBuckets(env);
	return {
		claimed: auth.claimed,
		authMode: auth.mode,
		attachments: bucketEnabled,
		snapshots: bucketEnabled,
		serverVersion: SERVER_VERSION,
		minPluginVersion: SERVER_MIN_PLUGIN_VERSION,
		recommendedPluginVersion: SERVER_RECOMMENDED_PLUGIN_VERSION,
		minSchemaVersion: SERVER_MIN_SCHEMA_VERSION,
		maxSchemaVersion: SERVER_MAX_SCHEMA_VERSION,
		migrationRequired: SERVER_MIGRATION_REQUIRED,
		updateProvider: config?.updateProvider ?? null,
		updateRepoUrl: config?.updateRepoUrl ?? null,
		updateRepoBranch: config?.updateRepoBranch ?? null,
	};
}

export async function handleClaimRoute(req: Request, env: Env, authState: AuthState): Promise<Response> {
	const url = new URL(req.url);
	if (authState.claimed) {
		return json({ error: "already_claimed" }, 403);
	}

	let body: { token?: string; vaultId?: string } = {};
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}

	if (typeof body.token !== "string" || body.token.trim().length < 32) {
		return json({ error: "invalid token" }, 400);
	}
	if (body.vaultId !== undefined && (typeof body.vaultId !== "string" || body.vaultId.trim().length < 8)) {
		return json({ error: "invalid vaultId" }, 400);
	}

	const token = body.token.trim();
	const vaultId = typeof body.vaultId === "string" ? body.vaultId.trim() : "";
	const tokenHash = await hashToken(token);
	const claimed = await claimServerConfig(env, tokenHash);
	if (!claimed) {
		return json({ error: "already_claimed" }, 403);
	}

	let claimedConfig: StoredServerConfig | null = null;
	try {
		claimedConfig = await getStoredServerConfig(env);
	} catch (err) {
		console.warn("[yaos-sync:worker] config fetch failed after claim:", err);
	}

	return json({
		ok: true,
		host: url.origin,
		obsidianUrl: buildObsidianSetupUrl(url.origin, token, vaultId || undefined),
		capabilities: getCapabilities({ mode: "claim", claimed: true, tokenHash }, env, claimedConfig),
	});
}

export async function handleUpdateMetadataRoute(req: Request, env: Env, authState: AuthState): Promise<Response> {
	const token = getHttpAuthToken(req);
	if (!authState.claimed) {
		return json({ error: "unclaimed" }, 503);
	}
	if (authState.mode === "env" && !authState.envToken) {
		return json({ error: "server_misconfigured" }, 503);
	}
	if (!(await isAuthorized(authState, token))) {
		return json({ error: "unauthorized" }, 401);
	}

	let body: {
		updateProvider?: unknown;
		updateRepoUrl?: unknown;
		updateRepoBranch?: unknown;
	} = {};
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}

	let updatedConfig: StoredServerConfig;
	try {
		updatedConfig = await setServerUpdateMetadata(env, body);
	} catch (err) {
		const message = err instanceof Error ? err.message : "metadata write failed";
		const status = message.includes("(403)")
			? 403
			: message.includes("(400)")
				? 400
				: 500;
		return json({ error: message }, status);
	}

	return json({
		ok: true,
		capabilities: getCapabilities(authState, env, updatedConfig),
	});
}
