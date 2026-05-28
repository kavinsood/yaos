import { ServerConfig, type StoredServerConfig } from "./config";
import { VaultSyncServer } from "./server";
import { renderMobileSetupPage, renderRunningPage, renderSetupPage } from "./setupPage";
import {
	canonicalRepoForSetup,
	getAuthStateCached,
	getCapabilities,
	getHttpAuthToken,
	getStoredServerConfigCached,
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
import { handleTicketRoute } from "./routes/ticket";
import { fetchVaultDebug, fetchVaultDocument, recordVaultTrace } from "./routes/trace";
import type { AuthState, AuthStateCached, Env } from "./routes/types";

const LOG_PREFIX = "[yaos-sync:worker]";

// ── Route classification ──────────────────────────────────────────────────────
//
// INVARIANT (issue #40): unknown routes MUST return 404 before any Durable
// Object namespace is touched.  classifyWorkerRoute() is a pure function that
// inspects only the request method and pathname.  getAuthStateCached() — which
// contacts YAOS_CONFIG — is only called for routes that classifyWorkerRoute
// recognises as valid YAOS routes.  Junk paths (/wp-login.php, /favicon.ico,
// /random-garbage) never reach the DO.
//
// Vault resource whitelist: only the four known resources can proceed to auth.
// /vault/:id/<anything-else> is classified as not-found here, before any
// YAOS_CONFIG or YAOS_SYNC access, so vault-shaped scanner traffic (/vault/foo/
// probe, /vault/foo/wp-login.php) is as cheap as a plain unknown path.

type WorkerRoute =
	| { kind: "cors-preflight" }
	| { kind: "home" }
	| { kind: "mobile-setup" }
	| { kind: "capabilities" }
	| { kind: "claim" }
	| { kind: "update-metadata" }
	| { kind: "sync-socket"; vaultId: string }
	| { kind: "vault"; vaultId: string; resource: string; rest: string[] }
	| { kind: "not-found" };

/**
 * The complete set of vault sub-resources the server actually handles.
 * Anything outside this set returns not-found before auth — zero DO access.
 */
const VALID_VAULT_RESOURCES = new Set(["auth", "debug", "blobs", "snapshots"]);

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY / BILLING INVARIANT — route classifier duplication is intentional
//
// isKnownVaultRouteShape() and isKnownSnapshotRouteShape() intentionally
// duplicate the route table already encoded in routes/blobs.ts,
// routes/snapshots.ts, etc.  The duplication exists so structurally invalid
// requests (wrong method, unknown subpath) can be rejected here — before any
// auth check or Durable Object access — rather than reaching a handler that
// would 404 after paying the YAOS_CONFIG round-trip.
//
// Consequence: any new /vault/:id/* handler route MUST also be added here,
// with a corresponding trap-env regression test proving the invalid shape
// still does not touch YAOS_CONFIG or YAOS_SYNC.  Forgetting this step causes
// a "security gate forgot the new endpoint" bug: the new route works fine in
// handler unit tests but gets pre-auth 404'd in production by the classifier.
//
// To add a new vault resource or subpath:
//   1. Add the handler in server/src/routes/<resource>.ts
//   2. Add the resource to VALID_VAULT_RESOURCES below (if it's new)
//   3. Add the route shape to isKnownVaultRouteShape / isKnownSnapshotRouteShape
//   4. Add a trap-env test to tests/server-route-classification-runtime.ts
//      asserting that the valid shape reaches auth and the invalid shapes
//      (wrong method, unknown subpath) still return 404 without DO access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full route-shape validation for the snapshots resource.
 *
 * Valid shapes derived from handleSnapshotRoute in routes/snapshots.ts:
 *   POST   /snapshots          → create snapshot from live doc
 *   POST   /snapshots/maybe    → daily snapshot (idempotent)
 *   POST   /snapshots/prune    → apply retention
 *   GET    /snapshots          → list snapshots
 *   GET    /snapshots/status   → storage status
 *   GET    /snapshots/:id      → fetch snapshot payload (any non-empty segment)
 *
 * Note: GET /snapshots/:id does not validate the ID format here.  A garbage ID
 * will pass the shape check, reach auth, and return 404 from R2 — that is
 * intentional.  Validating IDs in the classifier would move business logic
 * into the gatekeeper and create a maintenance trap.
 */
function isKnownSnapshotRouteShape(method: string, rest: string[]): boolean {
	if (rest.length === 0) {
		return method === "POST" || method === "GET";
	}
	if (rest.length === 1) {
		const sub = rest[0]!;
		if (method === "POST") return sub === "maybe" || sub === "prune";
		// GET /snapshots/status and GET /snapshots/:snapshotId are both valid
		if (method === "GET") return sub.length > 0;
	}
	return false;
}

/**
 * Validates that a vault route has a known method+resource+subpath combination.
 * Routes that fail this check return not-found immediately, before any auth or
 * Durable Object access.
 *
 * Valid shapes are derived directly from the route handlers in routes/:
 *   auth:      POST /auth/ticket
 *   debug:     GET  /debug/recent
 *   blobs:     GET|PUT /blobs/:hash,  POST /blobs/exists
 *              (GET|PUT /blobs/exists are structurally valid — the blob handler
 *               treats "exists" as a hash and rejects/misses it after auth,
 *               without touching YAOS_SYNC or hydrating the room)
 *   snapshots: see isKnownSnapshotRouteShape above
 *
 * See the SECURITY/BILLING INVARIANT comment above before adding new shapes.
 */
function isKnownVaultRouteShape(method: string, resource: string, rest: string[]): boolean {
	switch (resource) {
		case "auth":
			return method === "POST" && rest.length === 1 && rest[0] === "ticket";

		case "debug":
			return method === "GET" && rest.length === 1 && rest[0] === "recent";

		case "blobs": {
			if (rest.length !== 1) return false;
			if (method === "POST") return rest[0] === "exists";
			return method === "GET" || method === "PUT";
		}

		case "snapshots":
			return isKnownSnapshotRouteShape(method, rest);

		default:
			return false;
	}
}

function parseVaultPath(pathname: string): { vaultId: string; resource: string | null; rest: string[] } | null {
	const parts = pathname.split("/").filter(Boolean);
	if (parts.length < 2 || parts[0] !== "vault") return null;
	const vaultId = parts[1];
	if (!vaultId) return null;
	return {
		vaultId: decodeURIComponent(vaultId),
		resource: parts[2] ?? null,
		rest: parts.slice(3),
	};
}

function classifyWorkerRoute(req: Request, url: URL): WorkerRoute {
	if (
		req.method === "OPTIONS"
		&& (url.pathname.startsWith("/vault/") || url.pathname.startsWith("/api/"))
	) {
		return { kind: "cors-preflight" };
	}

	if (req.method === "GET" && url.pathname === "/") {
		return { kind: "home" };
	}

	if (req.method === "GET" && url.pathname === "/mobile-setup") {
		return { kind: "mobile-setup" };
	}

	if (req.method === "GET" && url.pathname === "/api/capabilities") {
		return { kind: "capabilities" };
	}

	if (req.method === "POST" && url.pathname === "/claim") {
		return { kind: "claim" };
	}

	if (req.method === "POST" && url.pathname === "/api/update-metadata") {
		return { kind: "update-metadata" };
	}

	// parseSyncPath MUST run before parseVaultPath.  /vault/sync/:vaultId
	// would otherwise be misread as vaultId="sync", resource=:vaultId and then
	// rejected by the resource whitelist as not-found.
	const syncRoute = parseSyncPath(url.pathname);
	if (syncRoute) {
		return { kind: "sync-socket", vaultId: syncRoute.vaultId };
	}

	const vaultRoute = parseVaultPath(url.pathname);
	if (vaultRoute && vaultRoute.resource !== null) {
		// Resource whitelist: unknown resources 404 before auth.
		if (!VALID_VAULT_RESOURCES.has(vaultRoute.resource)) {
			return { kind: "not-found" };
		}
		// Full shape validation: wrong method or unknown subpath also 404 before
		// auth.  POST /debug/recent, GET /debug/evil, GET /auth/random, etc. are
		// structurally invalid and must not touch YAOS_CONFIG or YAOS_SYNC.
		if (!isKnownVaultRouteShape(req.method, vaultRoute.resource, vaultRoute.rest)) {
			return { kind: "not-found" };
		}
		return {
			kind: "vault",
			vaultId: vaultRoute.vaultId,
			resource: vaultRoute.resource,
			rest: vaultRoute.rest,
		};
	}

	return { kind: "not-found" };
}

// ── Route-bucket logging ──────────────────────────────────────────────────────
//
// One structured log line per Worker request.  Normalised path buckets only —
// never raw vault IDs, tokens, or query strings.

function routeBucket(route: WorkerRoute): string {
	switch (route.kind) {
		case "home": return "home";
		case "mobile-setup": return "mobile_setup";
		case "capabilities": return "api_capabilities";
		case "claim": return "claim";
		case "update-metadata": return "api_update_metadata";
		case "sync-socket": return "vault_sync";
		case "vault": return `vault_${route.resource}`;
		case "not-found": return "not_found";
		case "cors-preflight": return "cors_preflight";
	}
}

function logWorkerRequest(args: {
	route: WorkerRoute;
	method: string;
	status: number;
	durationMs: number;
	auth: "skipped" | "env" | "claim" | "unclaimed";
	isWebSocket: boolean;
	cfRay: string | null;
}): void {
	// Sample not_found at 1% — scanner/probe traffic is high-volume and
	// an always-on access log for 404s turns into dashboard noise fast.
	// All recognised YAOS routes are always logged for triage.
	if (args.route.kind === "not-found" && Math.random() >= 0.01) {
		return;
	}
	console.info(
		"[yaos-worker] request " + JSON.stringify({
			route: routeBucket(args.route),
			method: args.method,
			status: args.status,
			durationMs: args.durationMs,
			auth: args.auth,
			isWebSocket: args.isWebSocket,
			cfRay: args.cfRay ?? undefined,
		}),
	);
}

// ── Pre-auth rejection helpers ────────────────────────────────────────────────
//
// Pre-auth rejection telemetry MUST NOT touch Durable Object storage
// (INV-SEC-01, INV-OBS-02). Calls to recordVaultTrace from this path
// would create or wake the DO and write a storage entry per unauthorized
// request — the documented root cause of issue #40 (DO request explosion).
//
// Rejections are logged via console.warn so Cloudflare worker logs still
// capture them, but no per-room state is mutated before authentication
// succeeds.
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

// ── Capabilities ──────────────────────────────────────────────────────────────

/**
 * Extract the StoredServerConfig carried in the AuthState (claim/unclaimed
 * modes only — env mode has no config).  Returns null for env mode or when
 * the config was not populated (e.g. old uncached getAuthState callers).
 *
 * When called with AuthStateCached (the return of getAuthStateCached), config
 * is always present for claim/unclaimed modes — no ?? null needed.
 */
function getConfigFromAuthState(authState: AuthStateCached): StoredServerConfig | null {
	if (authState.mode === "claim" || authState.mode === "unclaimed") {
		return authState.config;
	}
	return null;
}

async function handleCapabilities(req: Request, env: Env, authState: AuthStateCached): Promise<Response> {
	// Prefer the config already carried in the AuthState (populated by
	// getAuthStateCached in claim/unclaimed modes — zero extra DO calls).
	let config = getConfigFromAuthState(authState);

	if (!config) {
		// env mode: getAuthStateCached returns early without fetching config,
		// so we fetch it here with the same cached path.
		try {
			config = await getStoredServerConfigCached(env);
		} catch (err) {
			console.warn(`${LOG_PREFIX} config fetch failed for capabilities:`, err);
		}
	}

	const includePrivateUpdateMetadata = authState.claimed
		&& await isAuthorized(authState, getHttpAuthToken(req));
	return json(getCapabilities(authState, env, config, { includePrivateUpdateMetadata }));
}

// ── Worker ────────────────────────────────────────────────────────────────────

const worker = {
	async fetch(req: Request, env: Env): Promise<Response> {
		const start = Date.now();
		const url = new URL(req.url);
		const route = classifyWorkerRoute(req, url);
		const isWebSocket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
		const cfRay = req.headers.get("cf-ray");

		// Unknown routes 404 immediately — no YAOS_CONFIG, no YAOS_SYNC.
		// This is the primary fix for issue #40: scanner/probe traffic no longer
		// wakes Durable Objects.
		if (route.kind === "cors-preflight") {
			const response = corsPreflight();
			logWorkerRequest({ route, method: req.method, status: response.status, durationMs: Date.now() - start, auth: "skipped", isWebSocket, cfRay });
			return response;
		}

		if (route.kind === "not-found") {
			const response = withCors(json({ error: "not found" }, 404));
			logWorkerRequest({ route, method: req.method, status: 404, durationMs: Date.now() - start, auth: "skipped", isWebSocket, cfRay });
			return response;
		}

		// Only recognised routes reach this point.
		const authState = await getAuthStateCached(env);
		let response: Response;

		if (route.kind === "home") {
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
			response = html(body);
		} else if (route.kind === "mobile-setup") {
			response = html(
				renderMobileSetupPage({
					host: url.origin,
					deployRepo: canonicalRepoForSetup(env),
				}),
			);
		} else if (route.kind === "capabilities") {
			response = withCors(await handleCapabilities(req, env, authState));
		} else if (route.kind === "claim") {
			response = await handleClaimRoute(req, env, authState);
		} else if (route.kind === "update-metadata") {
			response = withCors(await handleUpdateMetadataRoute(req, env, authState));
		} else if (route.kind === "sync-socket") {
			response = await handleSyncSocketRoute(req, env, authState, route.vaultId);
		} else {
			// route.kind === "vault"
			const { vaultId, resource, rest } = route;

			const authFailure = await rejectAndLogUnauthorizedVaultRequest(req, env, authState, vaultId);
			if (authFailure) {
				response = withCors(authFailure);
			} else if (resource === "debug" && req.method === "GET" && rest[0] === "recent") {
				response = withCors(await fetchVaultDebug(env, vaultId));
			} else if (resource === "auth" && rest[0] === "ticket" && req.method === "POST") {
				response = withCors(await handleTicketRoute(req, authState, vaultId, json, env));
			} else if (resource === "blobs") {
				response = withCors(await handleBlobRoute(env, vaultId, req, rest, json));
			} else if (resource === "snapshots") {
				response = withCors(await handleSnapshotRoute(env, vaultId, req, rest, json, {
					fetchVaultDocument,
					recordVaultTrace,
				}));
			} else {
				response = withCors(json({ error: "not found" }, 404));
			}
		}

		logWorkerRequest({
			route,
			method: req.method,
			status: response.status,
			durationMs: Date.now() - start,
			auth: authState.mode,
			isWebSocket,
			cfRay,
		});
		return response;
	},
};

export default worker;
export { ServerConfig, VaultSyncServer };
