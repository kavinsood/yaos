import { getServerByName } from "partyserver";
import { getSocketAuthToken, isAuthorized } from "./auth";
import { json, withCors } from "./http";
import { fetchVaultSchemaVersion } from "./trace";
import { verifyTicket } from "./ticket";
import type { AuthState, Env, FatalAuthCode } from "./types";

const LEGACY_CLIENT_SCHEMA_VERSION = 1;

export function parseSyncPath(pathname: string): { vaultId: string } | null {
	const directMatch = pathname.match(/^\/vault\/sync\/([^/]+)$/);
	if (directMatch) {
		const [, vaultId] = directMatch;
		if (vaultId) {
			return { vaultId: decodeURIComponent(vaultId) };
		}
	}
	return null;
}

function parseClientSchemaVersion(url: URL): { version: number; source: "query" | "legacy-default" } | null {
	const raw = url.searchParams.get("schemaVersion") ?? url.searchParams.get("schema");
	if (raw === null || raw.trim() === "") {
		return { version: LEGACY_CLIENT_SCHEMA_VERSION, source: "legacy-default" };
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) return null;
	return { version: parsed, source: "query" };
}

function isWebSocketRequest(req: Request): boolean {
	return (req.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
}

function rejectSocket(
	req: Request,
	code: FatalAuthCode,
	details: Record<string, unknown> = {},
): Response {
	if (!isWebSocketRequest(req)) {
		return json(
			{ error: code },
			code === "unauthorized"
				? 401
				: code === "update_required"
					? 426
					: 503,
		);
	}

	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];
	server.accept();
	const payload = JSON.stringify({ type: "error", code, ...details });
	// Send a plain JSON frame first for generic websocket clients/tests.
	server.send(payload);
	// y-partyserver clients consume string control messages via "__YPS:".
	// Send fatal auth payload through that channel so plugins can fail loudly.
	server.send(`__YPS:${payload}`);
	server.close(
		1008,
		code === "unauthorized"
			? "unauthorized"
			: code === "update_required"
				? "update required"
			: code === "unclaimed"
				? "server unclaimed"
				: "server misconfigured",
	);
	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}

function returnSocketResponse(req: Request, response: Response): Response {
	return isWebSocketRequest(req) ? response : withCors(response);
}

/**
 * Pre-auth rejection telemetry MUST NOT touch Durable Object storage
 * (INV-SEC-01, INV-OBS-02). See server/src/index.ts for the long-form
 * comment and root-cause history (issue #40).
 */
function logSocketRejection(
	vaultId: string,
	reason: "unclaimed" | "server_misconfigured" | "unauthorized",
): void {
	// Truncate vaultId so it cannot become a correlation handle in exported
	// worker logs.
	const vaultIdHint = vaultId.slice(0, 8);
	console.warn(
		`[yaos-sync:worker] ws rejected pre-auth: ` +
		JSON.stringify({ vaultIdHint, reason }),
	);
}

// ---------------------------------------------------------------------------
// Pure socket auth decision
// ---------------------------------------------------------------------------

export type SocketAuthResult =
	| { ok: true; method: "ticket" | "legacy-token" }
	| { ok: false; reason: "unclaimed" | "server_misconfigured" | "unauthorized" };

/**
 * Decide whether a WebSocket connection request is authenticated.
 *
 * Pure function: takes no Request object, touches no Durable Objects, emits
 * no telemetry.  The route calls this then acts on the result.
 *
 * Auth rules:
 *   1. Ticket present → verify exclusively.  A bad ticket rejects hard and
 *      does NOT fall back to the token path.
 *   2. No ticket, legacy NOT disabled → verify long-lived token.
 *   3. No ticket, legacy IS disabled → reject unauthorised.  The server
 *      operator has opted out of the migration window.
 */
export async function authenticateSocketRequest(
	ticket: string | null,
	token: string | null,
	authState: AuthState,
	vaultId: string,
	disableLegacyToken: boolean,
): Promise<SocketAuthResult> {
	if (!authState.claimed) {
		return { ok: false, reason: "unclaimed" };
	}
	if (authState.mode === "env" && !authState.envToken) {
		return { ok: false, reason: "server_misconfigured" };
	}

	if (ticket !== null) {
		const ticketValid = await verifyTicket(ticket, authState, vaultId);
		return ticketValid
			? { ok: true, method: "ticket" }
			: { ok: false, reason: "unauthorized" };
	}

	if (disableLegacyToken) {
		return { ok: false, reason: "unauthorized" };
	}

	const tokenValid = await isAuthorized(authState, token);
	return tokenValid
		? { ok: true, method: "legacy-token" }
		: { ok: false, reason: "unauthorized" };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleSyncSocketRoute(
	req: Request,
	env: Env,
	authState: AuthState,
	vaultId: string,
): Promise<Response> {
	const url = new URL(req.url);
	const token = getSocketAuthToken(req);
	const ticket = url.searchParams.get("ticket");
	const clientSchema = parseClientSchemaVersion(url);
	const disableLegacyToken = !!env.YAOS_DISABLE_LEGACY_WS_TOKEN;

	const authResult = await authenticateSocketRequest(
		ticket, token, authState, vaultId, disableLegacyToken,
	);

	if (!authResult.ok) {
		logSocketRejection(vaultId, authResult.reason);
		return returnSocketResponse(req, rejectSocket(req, authResult.reason));
	}

	// Warn on every legacy-token connection so operators can monitor adoption
	// before enabling YAOS_DISABLE_LEGACY_WS_TOKEN.
	if (authResult.method === "legacy-token") {
		console.warn(
			`[yaos-sync:worker] legacy ?token= WebSocket auth for vault ${vaultId.slice(0, 8)} — ` +
			`upgrade client to use short-lived tickets, or set YAOS_DISABLE_LEGACY_WS_TOKEN to enforce`,
		);
	}

	if (!clientSchema) {
		// WebSocket admission events must not write to YAOS_SYNC storage
		// (issue #40 — a schema-mismatch loop would hammer the DO on every
		// reconnect attempt).  Log only via console for worker-level visibility.
		console.warn(
			`[yaos-sync:worker] ws rejected (update_required): ` +
			JSON.stringify({
				vaultIdHint: vaultId.slice(0, 8),
				reason: "update_required",
				detail: "invalid_client_schema",
				rawSchema: url.searchParams.get("schemaVersion") ?? url.searchParams.get("schema") ?? null,
			}),
		);
		return returnSocketResponse(req, rejectSocket(req, "update_required", {
			reason: "invalid_client_schema",
			clientSchemaVersion: null,
			roomSchemaVersion: null,
		}));
	}

	const roomSchemaVersion = await fetchVaultSchemaVersion(env, vaultId);
	if (roomSchemaVersion !== null && clientSchema.version < roomSchemaVersion) {
		// Schema-skew rejection — console only, no YAOS_SYNC write (issue #40).
		// A retry loop here would otherwise fan out one DO subrequest per attempt.
		console.warn(
			`[yaos-sync:worker] ws rejected (update_required): ` +
			JSON.stringify({
				vaultIdHint: vaultId.slice(0, 8),
				reason: "update_required",
				detail: "client_schema_older_than_room",
				clientSchemaVersion: clientSchema.version,
				clientSchemaSource: clientSchema.source,
				roomSchemaVersion,
			}),
		);
		return returnSocketResponse(req, rejectSocket(req, "update_required", {
			reason: "client_schema_older_than_room",
			clientSchemaVersion: clientSchema.version,
			roomSchemaVersion,
		}));
	}

	// Successful connection — console only, no YAOS_SYNC trace write (issue #40).
	// A reconnect storm would otherwise produce:
	//   YAOS_CONFIG auth + YAOS_SYNC schema check + YAOS_SYNC trace write
	// on every connect, burning ~3 subrequests per socket open.
	console.info(
		`[yaos-sync:worker] ws connected: ` +
		JSON.stringify({
			vaultIdHint: vaultId.slice(0, 8),
			clientSchemaVersion: clientSchema.version,
			clientSchemaSource: clientSchema.source,
			roomSchemaVersion,
			authMethod: authResult.method,
			cfRay: req.headers.get("cf-ray") ?? undefined,
		}),
	);

	const stub = await getServerByName(env.YAOS_SYNC, vaultId);
	return await stub.fetch(req);
}

