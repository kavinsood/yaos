import { ServerConfig, type StoredServerConfig } from "./config";
import { VaultSyncServer } from "./server";
import { renderMobileSetupPage, renderRunningPage, renderSetupPage } from "./setupPage";
import {
	canonicalRepoForSetup,
	getAuthState,
	getCapabilities,
	getHttpAuthToken,
	getStoredServerConfig,
	handleClaimRoute,
	handleUpdateMetadataRoute,
	isAuthorized,
	rejectUnauthorizedVaultRequest,
	supportsBuckets,
} from "./routes/auth";
import { handleBlobRoute } from "./routes/blobs";
import { corsPreflight, html, json, withCors } from "./routes/http";
import { handleSnapshotRoute } from "./routes/snapshots";
import { handleSyncSocketRoute, parseSyncPath } from "./routes/syncSocket";
import { fetchVaultDebug, fetchVaultDocument, recordVaultTrace } from "./routes/trace";
import type { AuthState, Env } from "./routes/types";

const LOG_PREFIX = "[yaos-sync:worker]";

function parseVaultPath(pathname: string): { vaultId: string; rest: string[] } | null {
	const parts = pathname.split("/").filter(Boolean);
	if (parts.length < 2 || parts[0] !== "vault") return null;
	const vaultId = parts[1];
	if (!vaultId) return null;
	return {
		vaultId: decodeURIComponent(vaultId),
		rest: parts.slice(2),
	};
}

/**
 * Pre-auth rejection telemetry MUST NOT touch Durable Object storage
 * (INV-SEC-01, INV-OBS-02). Calls to recordVaultTrace from this path
 * would create or wake the DO and write a storage entry per unauthorized
 * request — the documented root cause of issue #40 (DO request explosion).
 *
 * Rejections are logged via console.warn so Cloudflare worker logs still
 * capture them, but no per-room state is mutated before authentication
 * succeeds.
 */
function logVaultRejection(
	req: Request,
	vaultId: string,
	reason: "unclaimed" | "server_misconfigured" | "unauthorized",
): void {
	// Truncate vaultId so it cannot become a correlation handle in exported
	// worker logs, while still being useful for debugging.
	const vaultIdHint = vaultId.slice(0, 8);
	console.warn(
		`${LOG_PREFIX} vault rejected pre-auth: ` +
		JSON.stringify({ vaultIdHint, reason, method: req.method }),
	);
}

async function rejectAndLogUnauthorizedVaultRequest(
	req: Request,
	env: Env,
	authState: AuthState,
	vaultId: string,
): Promise<Response | null> {
	const rejection = await rejectUnauthorizedVaultRequest(req, env, authState, vaultId);
	if (rejection) {
		logVaultRejection(req, vaultId, rejection.reason);
	}
	return rejection?.response ?? null;
}

async function handleCapabilities(req: Request, env: Env, authState: AuthState): Promise<Response> {
	let config: StoredServerConfig | null = null;
	try {
		config = await getStoredServerConfig(env);
	} catch (err) {
		console.warn(`${LOG_PREFIX} config fetch failed for capabilities:`, err);
	}
	const includePrivateUpdateMetadata = authState.claimed
		&& await isAuthorized(authState, getHttpAuthToken(req));
	return json(getCapabilities(authState, env, config, { includePrivateUpdateMetadata }));
}

const worker = {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		if (
			req.method === "OPTIONS"
			&& (url.pathname.startsWith("/vault/") || url.pathname.startsWith("/api/"))
		) {
			return corsPreflight();
		}

		const authState = await getAuthState(env);

		if (req.method === "GET" && url.pathname === "/") {
			const body = authState.claimed
				? renderRunningPage({
					host: url.origin,
					authMode: authState.mode,
					attachments: supportsBuckets(env),
					snapshots: supportsBuckets(env),
				})
				: renderSetupPage({
					host: url.origin,
					deployRepo: canonicalRepoForSetup(env),
				});
			return html(body);
		}

		if (req.method === "GET" && url.pathname === "/mobile-setup") {
			return html(
				renderMobileSetupPage({
					host: url.origin,
					deployRepo: canonicalRepoForSetup(env),
				}),
			);
		}

		if (req.method === "GET" && url.pathname === "/api/capabilities") {
			return withCors(await handleCapabilities(req, env, authState));
		}

		if (req.method === "POST" && url.pathname === "/claim") {
			return await handleClaimRoute(req, env, authState);
		}

		if (req.method === "POST" && url.pathname === "/api/update-metadata") {
			return withCors(await handleUpdateMetadataRoute(req, env, authState));
		}

		const syncRoute = parseSyncPath(url.pathname);
		if (syncRoute) {
			return await handleSyncSocketRoute(req, env, authState, syncRoute.vaultId);
		}

		const vaultRoute = parseVaultPath(url.pathname);
		if (!vaultRoute) {
			return withCors(json({ error: "not found" }, 404));
		}

		const authFailure = await rejectAndLogUnauthorizedVaultRequest(
			req,
			env,
			authState,
			vaultRoute.vaultId,
		);
		if (authFailure) {
			return withCors(authFailure);
		}

		const [resource, ...rest] = vaultRoute.rest;
		if (!resource) {
			return withCors(json({ error: "not found" }, 404));
		}

		if (resource === "debug" && req.method === "GET" && rest[0] === "recent") {
			return withCors(await fetchVaultDebug(env, vaultRoute.vaultId));
		}

		if (resource === "blobs") {
			return withCors(await handleBlobRoute(env, vaultRoute.vaultId, req, rest, json));
		}

		if (resource === "snapshots") {
			return withCors(await handleSnapshotRoute(env, vaultRoute.vaultId, req, rest, json, {
				fetchVaultDocument,
				recordVaultTrace,
			}));
		}

		return withCors(json({ error: "not found" }, 404));
	},
};

export default worker;
export { ServerConfig, VaultSyncServer };
