import { getServerByName } from "partyserver";
import { SERVER_SCHEMA_VERSION } from "../version";
import { configFetch } from "./auth";
import { json, safeDecodeUriComponent, withCors } from "./http";
import { inspectTicket } from "./ticket";
import { fetchVaultSchemaVersion } from "./trace";
import type { AuthState, Env, FatalAuthCode } from "./types";

export function parseSyncPath(pathname: string): { vaultId: string } | null {
	const match = pathname.match(/^\/vault\/sync\/([^/]+)$/);
	if (!match?.[1]) return null;
	const vaultId = safeDecodeUriComponent(match[1]);
	return vaultId === null ? null : { vaultId };
}

function parseClientSchemaVersion(url: URL): number | null {
	const raw = url.searchParams.get("schemaVersion");
	if (raw === null || raw.trim() === "") return null;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
function describeInvalidSchema(raw: string | null): {
	present: boolean;
	length: number;
	lengthCapped: boolean;
	classification: "missing" | "blank" | "unsigned_integer" | "negative_integer" | "other";
} {
	const actualLength = raw?.length ?? 0;
	let classification: "missing" | "blank" | "unsigned_integer" | "negative_integer" | "other";
	if (raw === null) {
		classification = "missing";
	} else if (raw.trim() === "") {
		classification = "blank";
	} else if (/^[0-9]+$/.test(raw)) {
		classification = "unsigned_integer";
	} else if (/^-[0-9]+$/.test(raw)) {
		classification = "negative_integer";
	} else {
		classification = "other";
	}
	return {
		present: raw !== null,
		length: Math.min(actualLength, 256),
		lengthCapped: actualLength > 256,
		classification,
	};
}


function isWebSocketRequest(req: Request): boolean {
	return (req.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
}

function rejectSocket(req: Request, code: FatalAuthCode, details: Record<string, unknown> = {}): Response {
	if (!isWebSocketRequest(req)) {
		return json(
			{ error: code, ...details },
			code === "unauthorized" ? 401 : code === "update_required" ? 426 : 503,
		);
	}
	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];
	server.accept();
	const payload = JSON.stringify({ type: "error", code, ...details });
	server.send(payload);
	server.send(`__YPS:${payload}`);
	server.close(
		1008,
		code === "unauthorized"
			? "unauthorized"
			: code === "update_required"
				? "update required"
				: code === "unclaimed"
					? "server unclaimed"
					: code === "server_format_unsupported"
						? "server format unsupported"
						: "server misconfigured",
	);
	return new Response(null, { status: 101, webSocket: client });
}

function returnSocketResponse(req: Request, response: Response): Response {
	return isWebSocketRequest(req) ? response : withCors(response);
}

function logSocketRejection(vaultId: string, reason: string): void {
	console.warn(
		"[yaos-sync:worker] ws rejected pre-auth: "
		+ JSON.stringify({ vaultIdHint: vaultId.slice(0, 8), reason }),
	);
}

export type SocketAuthResult =
	| { ok: true; method: "ticket"; deviceId: string }
	| { ok: false; reason: "unclaimed" | "server_format_unsupported" | "server_misconfigured" | "unauthorized" };

export async function authenticateSocketRequest(
	ticket: string | null,
	authState: AuthState,
	vaultId: string,
): Promise<SocketAuthResult> {
	if (authState.mode === "unsupported") return { ok: false, reason: "server_format_unsupported" };
	if (!authState.claimed) return { ok: false, reason: "unclaimed" };
	if (authState.mode !== "claim") return { ok: false, reason: "server_misconfigured" };
	if (ticket === null) return { ok: false, reason: "unauthorized" };
	const payload = await inspectTicket(ticket, authState, vaultId);
	return payload
		? { ok: true, method: "ticket", deviceId: payload.deviceId }
		: { ok: false, reason: "unauthorized" };
}

export async function handleSyncSocketRoute(
	req: Request,
	env: Env,
	authState: AuthState,
	vaultId: string,
): Promise<Response> {
	const url = new URL(req.url);
	const authResult = await authenticateSocketRequest(url.searchParams.get("ticket"), authState, vaultId);
	if (!authResult.ok) {
		logSocketRejection(vaultId, authResult.reason);
		return returnSocketResponse(req, rejectSocket(req, authResult.reason));
	}

	// Signature and expiry are insufficient: membership is rechecked on every
	// handshake so revocation invalidates an otherwise-live ticket immediately.
	const membership = await configFetch(env, "/__yaos/verify-device", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ deviceId: authResult.deviceId, vaultId }),
	});
	if (!membership.ok) {
		logSocketRejection(vaultId, "unauthorized");
		return returnSocketResponse(req, rejectSocket(req, "unauthorized"));
	}
	try {
		await configFetch(env, "/__yaos/touch-device", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ deviceId: authResult.deviceId, vaultId }),
		});
	} catch {
		// lastSeenAt is best-effort.
	}

	const rawSchema = url.searchParams.get("schemaVersion");
	const clientSchemaVersion = parseClientSchemaVersion(url);
	if (clientSchemaVersion === null) {
		console.warn("[yaos-sync:worker] ws rejected (update_required): " + JSON.stringify({
			vaultIdHint: vaultId.slice(0, 8),
			reason: "invalid_client_schema",
			schemaQuery: describeInvalidSchema(rawSchema),
		}));
		return returnSocketResponse(req, rejectSocket(req, "update_required", {
			reason: "invalid_client_schema",
			clientSchemaVersion: null,
			roomSchemaVersion: null,
		}));
	}
	if (clientSchemaVersion !== SERVER_SCHEMA_VERSION) {
		return returnSocketResponse(req, rejectSocket(req, "update_required", {
			reason: "client_schema_unsupported",
			clientSchemaVersion,
			roomSchemaVersion: null,
			serverSchemaVersion: SERVER_SCHEMA_VERSION,
		}));
	}
	const roomSchemaVersion = await fetchVaultSchemaVersion(env, vaultId);
	if (roomSchemaVersion !== null && roomSchemaVersion !== clientSchemaVersion) {
		const reason = clientSchemaVersion < roomSchemaVersion
			? "client_schema_older_than_room"
			: "client_schema_newer_than_room";
		return returnSocketResponse(req, rejectSocket(req, "update_required", {
			reason,
			clientSchemaVersion,
			roomSchemaVersion,
		}));
	}
	console.debug("[yaos-sync:worker] ws connected: " + JSON.stringify({
		vaultIdHint: vaultId.slice(0, 8),
		clientSchemaVersion,
		roomSchemaVersion,
		authMethod: authResult.method,
		cfRay: req.headers.get("cf-ray") ?? undefined,
	}));
	const stub = await getServerByName(env.YAOS_SYNC, vaultId);
	return stub.fetch(req);
}
