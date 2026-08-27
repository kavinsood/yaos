import { ServerConfig } from "./config";
import { VaultSyncServer } from "./server";
import { renderMobileSetupPage, renderOperatorConsole, renderOperatorLogin, renderSetupPage } from "./setupPage";
import {
	authorizeAnyDevice,
	authorizeDevice,
	getAuthStateCached,
	getCapabilities,
	getHttpAuthToken,
	handleClaimRoute,
	handleUpdateMetadataRoute,
	rejectUnauthorizedVaultRequest,
	supportsBuckets,
	verifyOperatorSession,
} from "./routes/auth";
import { handleBlobRoute } from "./routes/blobs";
import {
	handleEnrollRoute,
	handleVaultDeviceLeaveRoute,
	handleVaultDeviceRoute,
	handleVaultDevicesListRoute,
	handleVaultPairingCodeRoute,
} from "./routes/enroll";
import { corsPreflight, html, json, safeDecodeUriComponent, withCors } from "./routes/http";
import {
	handleOperatorCreateVault,
	handleOperatorDestroyVault,
	handleOperatorLogin,
	handleOperatorLogout,
	handleOperatorPairingCode,
	handleOperatorRenameVault,
	handleOperatorRevokeDevice,
	handleOperatorRevokePairing,
	handleOperatorState,
} from "./routes/operator";
import { handleSnapshotRoute } from "./routes/snapshots";
import { handleSyncSocketRoute, parseSyncPath } from "./routes/syncSocket";
import { handleTicketRoute } from "./routes/ticket";
import { compactVault, fetchVaultDebug, fetchVaultDocument, recordVaultTrace } from "./routes/trace";
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
// Vault resource whitelist: only the five known resources can proceed to auth.
// /vault/:id/<anything-else> is classified as not-found here, before any
// YAOS_CONFIG or YAOS_SYNC access, so vault-shaped scanner traffic (/vault/foo/
// probe, /vault/foo/wp-login.php) is as cheap as a plain unknown path.

type WorkerRoute =
	| { kind: "cors-preflight" }
	| { kind: "home" }
	| { kind: "mobile-setup" }
	| { kind: "capabilities" }
	| { kind: "claim" }
	| { kind: "enroll" }
	| { kind: "operator-login" }
	| { kind: "operator-logout" }
	| { kind: "operator-state" }
	| { kind: "operator-pairing" }
	| { kind: "operator-vaults" }
	| { kind: "operator-vault-patch"; vaultId: string }
	| { kind: "operator-vault-destroy"; vaultId: string }
	| { kind: "operator-pairing-revoke"; codeId: string }
	| { kind: "operator-revoke"; deviceId: string }
	| { kind: "update-metadata" }
	| { kind: "sync-socket"; vaultId: string }
	| { kind: "vault"; vaultId: string; resource: string; rest: string[] }
	| { kind: "not-found" };

/**
 * The complete set of vault sub-resources the server actually handles.
 * Anything outside this set returns not-found before auth — zero DO access.
 */
const VALID_VAULT_RESOURCES: Record<string, true> = {
	auth: true,
	debug: true,
	blobs: true,
	snapshots: true,
	devices: true,
};

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
//   4. Add a trap-env test to tests/server/server-route-classification-runtime.ts
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
			if (rest.length !== 1) return false;
			if (method === "POST") {
				return rest[0] === "ticket" || rest[0] === "pairing-code" || rest[0] === "device";
			}
			return method === "DELETE" && rest[0] === "device";

		case "devices":
			return method === "GET" && rest.length === 0;
		case "debug":
			if (method === "GET" && rest.length === 1 && rest[0] === "recent") return true;
			if (method === "POST" && rest.length === 1 && rest[0] === "compact") return true;
			return false;

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
	const vaultId = safeDecodeUriComponent(parts[1]!);
	if (!vaultId) return null;
	const rest: string[] = [];
	for (const part of parts.slice(3)) {
		const decoded = safeDecodeUriComponent(part);
		if (decoded === null) return null;
		rest.push(decoded);
	}
	return {
		vaultId,
		resource: parts[2] ?? null,
		rest,
	};
}

function classifyWorkerRoute(req: Request, url: URL): WorkerRoute {
	if (
		req.method === "OPTIONS"
		&& (
			url.pathname.startsWith("/vault/")
			|| url.pathname.startsWith("/api/")
			|| url.pathname === "/enroll"
			|| url.pathname.startsWith("/operator/")
		)
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

	if (req.method === "POST" && url.pathname === "/enroll") return { kind: "enroll" };
	if (req.method === "POST" && url.pathname === "/operator/login") return { kind: "operator-login" };
	if (req.method === "POST" && url.pathname === "/operator/logout") return { kind: "operator-logout" };
	if (req.method === "GET" && url.pathname === "/operator/state") return { kind: "operator-state" };
	if (req.method === "POST" && url.pathname === "/operator/pairing-codes") return { kind: "operator-pairing" };
	if (req.method === "POST" && url.pathname === "/operator/vaults") return { kind: "operator-vaults" };
	const operatorVault = url.pathname.match(/^\/operator\/vaults\/([^/]+)$/);
	if (operatorVault?.[1] && (req.method === "PATCH" || req.method === "DELETE")) {
		const vaultId = safeDecodeUriComponent(operatorVault[1]);
		if (vaultId === null) return { kind: "not-found" };
		return req.method === "PATCH"
			? { kind: "operator-vault-patch", vaultId }
			: { kind: "operator-vault-destroy", vaultId };
	}
	if (req.method === "DELETE") {
		const device = url.pathname.match(/^\/operator\/devices\/([^/]+)$/);
		if (device?.[1]) {
			const deviceId = safeDecodeUriComponent(device[1]);
			return deviceId === null ? { kind: "not-found" } : { kind: "operator-revoke", deviceId };
		}
		const pairing = url.pathname.match(/^\/operator\/pairing-codes\/([^/]+)$/);
		if (pairing?.[1]) {
			const codeId = safeDecodeUriComponent(pairing[1]);
			return codeId === null ? { kind: "not-found" } : { kind: "operator-pairing-revoke", codeId };
		}
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
		if (!VALID_VAULT_RESOURCES[vaultRoute.resource]) {
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
		case "enroll": return "enroll";
		case "operator-login": return "operator_login";
		case "operator-logout": return "operator_logout";
		case "operator-state": return "operator_state";
		case "operator-pairing": return "operator_pairing";
		case "operator-vaults": return "operator_vaults";
		case "operator-vault-patch": return "operator_vault_patch";
		case "operator-vault-destroy": return "operator_vault_destroy";
		case "operator-pairing-revoke": return "operator_pairing_revoke";
		case "operator-revoke": return "operator_revoke";
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
	auth: "skipped" | "claim" | "unclaimed" | "unsupported";
	isWebSocket: boolean;
	cfRay: string | null;
}): void {
	// Sample not_found at 1% — scanner/probe traffic is high-volume and
	// an always-on access log for 404s turns into dashboard noise fast.
	// All recognised YAOS routes are always logged for triage.
	if (args.route.kind === "not-found" && Math.random() >= 0.01) {
		return;
	}
	console.debug(
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
	reason: "unclaimed" | "server_format_unsupported" | "server_misconfigured" | "unauthorized",
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

async function handleCapabilities(req: Request, env: Env, authState: AuthStateCached): Promise<Response> {
	const includePrivateUpdateMetadata = authState.mode === "claim" && (
		await verifyOperatorSession(env, req)
		|| await authorizeAnyDevice(env, getHttpAuthToken(req))
	);
	return json(getCapabilities(authState, env, authState.config, { includePrivateUpdateMetadata }));
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

		// Logout must clear the browser cookie even when config reads or session
		// revocation fail, so it cannot depend on the shared auth-state fetch.
		if (route.kind === "operator-logout") {
			const response = await handleOperatorLogout(req, env);
			logWorkerRequest({ route, method: req.method, status: response.status, durationMs: Date.now() - start, auth: "skipped", isWebSocket, cfRay });
			return response;
		}

		// Only recognised routes reach this point.
		const authState = await getAuthStateCached(env);
		let response: Response;

		if (route.kind === "home") {
			if (authState.mode === "unsupported") {
				response = html("<!doctype html><title>YAOS server format unsupported</title><h1>Server format unsupported</h1><p>This server uses an unsupported configuration format and cannot authenticate requests.</p>");
			} else if (!authState.claimed) {
				response = html(renderSetupPage({ host: url.origin }));
			} else if (await verifyOperatorSession(env, req)) {
				response = html(renderOperatorConsole({
					host: url.origin,
					attachments: supportsBuckets(env),
					snapshots: supportsBuckets(env),
				}));
			} else {
				response = html(renderOperatorLogin({ host: url.origin }));
			}
		} else if (route.kind === "mobile-setup") {
			response = html(renderMobileSetupPage({ host: url.origin }));
		} else if (route.kind === "capabilities") {
			response = withCors(await handleCapabilities(req, env, authState));
		} else if (route.kind === "claim") {
			response = await handleClaimRoute(req, env, authState);
		} else if (authState.mode === "unsupported") {
			response = withCors(json({ error: "server_format_unsupported" }, 503));
		} else if (route.kind === "enroll") {
			response = withCors(await handleEnrollRoute(req, env));
		} else if (route.kind === "operator-login") {
			response = await handleOperatorLogin(req, env);
		} else if (route.kind === "operator-state") {
			response = await handleOperatorState(req, env);
		} else if (route.kind === "operator-pairing") {
			response = await handleOperatorPairingCode(req, env);
		} else if (route.kind === "operator-vaults") {
			response = await handleOperatorCreateVault(req, env);
		} else if (route.kind === "operator-vault-patch") {
			response = withCors(await handleOperatorRenameVault(req, env, route.vaultId));
		} else if (route.kind === "operator-vault-destroy") {
			response = withCors(await handleOperatorDestroyVault(req, env, route.vaultId));
		} else if (route.kind === "operator-pairing-revoke") {
			response = withCors(await handleOperatorRevokePairing(req, env, route.codeId));
		} else if (route.kind === "operator-revoke") {
			response = await handleOperatorRevokeDevice(req, env, route.deviceId);
		} else if (route.kind === "update-metadata") {
			response = withCors(await handleUpdateMetadataRoute(req, env, authState));
		} else if (route.kind === "sync-socket") {
			response = await handleSyncSocketRoute(req, env, authState, route.vaultId);
		} else {
			const { vaultId, resource, rest } = route;
			if (resource === "debug" && req.method === "POST" && rest[0] === "compact") {
				if (!env.YAOS_ENABLE_ADMIN_ROUTES) {
					response = withCors(json({ error: "not found" }, 404));
				} else if (!(await verifyOperatorSession(env, req))) {
					response = withCors(json({ error: "unauthorized" }, 401));
				} else {
					response = withCors(await compactVault(env, vaultId));
				}
			} else {
				const authFailure = await rejectAndLogUnauthorizedVaultRequest(req, env, authState, vaultId);
				if (authFailure) {
					response = withCors(authFailure);
				} else if (resource === "debug" && req.method === "GET" && rest[0] === "recent") {
					const census = new URL(req.url).searchParams.get("census") === "1";
					response = withCors(await fetchVaultDebug(env, vaultId, census));
				} else if (resource === "auth" && rest[0] === "ticket" && req.method === "POST") {
					const device = await authorizeDevice(env, getHttpAuthToken(req), vaultId);
					response = device
						? withCors(await handleTicketRoute(req, authState, vaultId, device.deviceId, json, env))
						: withCors(json({ error: "unauthorized" }, 401));
				} else if (resource === "auth" && rest[0] === "pairing-code" && req.method === "POST") {
					response = withCors(await handleVaultPairingCodeRoute(req, env, vaultId));
				} else if (resource === "auth" && rest[0] === "device" && req.method === "POST") {
					response = withCors(await handleVaultDeviceRoute(req, env, vaultId));
				} else if (resource === "auth" && rest[0] === "device" && req.method === "DELETE") {
					response = withCors(await handleVaultDeviceLeaveRoute(req, env, vaultId));
				} else if (resource === "devices" && req.method === "GET") {
					response = withCors(await handleVaultDevicesListRoute(req, env, vaultId));
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
