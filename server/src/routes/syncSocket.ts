import { getServerByName } from "partyserver";
import { getSocketAuthToken, isAuthorized } from "./auth";
import { json, withCors } from "./http";
import { fetchVaultSchemaVersion, recordVaultTrace } from "./trace";
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

export async function handleSyncSocketRoute(
	req: Request,
	env: Env,
	authState: AuthState,
	vaultId: string,
): Promise<Response> {
	const url = new URL(req.url);
	const token = getSocketAuthToken(req);
	const clientSchema = parseClientSchemaVersion(url);
	if (!authState.claimed) {
		logSocketRejection(vaultId, "unclaimed");
		return returnSocketResponse(req, rejectSocket(req, "unclaimed"));
	}
	if (authState.mode === "env" && !authState.envToken) {
		logSocketRejection(vaultId, "server_misconfigured");
		return returnSocketResponse(req, rejectSocket(req, "server_misconfigured"));
	}
	if (!(await isAuthorized(authState, token))) {
		logSocketRejection(vaultId, "unauthorized");
		return returnSocketResponse(req, rejectSocket(req, "unauthorized"));
	}
	if (!clientSchema) {
		await recordVaultTrace(env, vaultId, "ws-rejected", {
			reason: "update_required",
			detail: "invalid_client_schema",
			rawSchema: url.searchParams.get("schemaVersion") ?? url.searchParams.get("schema") ?? null,
		});
		return returnSocketResponse(req, rejectSocket(req, "update_required", {
			reason: "invalid_client_schema",
			clientSchemaVersion: null,
			roomSchemaVersion: null,
		}));
	}

	const roomSchemaVersion = await fetchVaultSchemaVersion(env, vaultId);
	if (roomSchemaVersion !== null && clientSchema.version < roomSchemaVersion) {
		await recordVaultTrace(env, vaultId, "ws-rejected", {
			reason: "update_required",
			detail: "client_schema_older_than_room",
			clientSchemaVersion: clientSchema.version,
			clientSchemaSource: clientSchema.source,
			roomSchemaVersion,
		});
		return returnSocketResponse(req, rejectSocket(req, "update_required", {
			reason: "client_schema_older_than_room",
			clientSchemaVersion: clientSchema.version,
			roomSchemaVersion,
		}));
	}

	await recordVaultTrace(env, vaultId, "ws-connected", {
		userAgent: req.headers.get("user-agent") ?? undefined,
		cfRay: req.headers.get("cf-ray") ?? undefined,
		clientSchemaVersion: clientSchema.version,
		clientSchemaSource: clientSchema.source,
		roomSchemaVersion,
	});

	const stub = await getServerByName(env.YAOS_SYNC, vaultId);
	return await stub.fetch(req);
}
