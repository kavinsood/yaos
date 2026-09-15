import { authorizeVaultAction } from "../collaboration";
import { openExcalidrawShareRoute, openExcalidrawShareSession, sealExcalidrawShareRoute,
	sealExcalidrawShareSession } from "../excalidrawShareEnvelope";
import { sha256Hex } from "../hex";
import { BoundedBodyError, readBoundedBytes } from "../readBoundedBytes";
import { MAX_EXCALIDRAW_INBOUND_RESOURCE_BYTES,
	type ExcalidrawShareRouteEnvelope } from "../shared/excalidrawShareProtocol";
import { isExcalidrawIdentity } from "../shared/excalidrawProtocol";
import { actorHeaders, stripActorHeaders } from "../vaultAuthority";
import { authorizeVaultActor, getHttpAuthToken } from "./auth";
import type { AuthState, Env } from "./types";
import { readVault } from "./vault";

const SESSION_COOKIE = "yaos_excalidraw_share";

export async function handleExcalidrawShareOwnerRoute(request: Request, env: Env, auth: AuthState,
	vaultId: string, drawingId: string, shareId?: string): Promise<Response> {
	if (env.YAOS_EXCALIDRAW_PUBLIC_READ !== "true") return secureJson({ error: "not_found" }, 404);
	const authorized = await authorizeVaultActor(env, getHttpAuthToken(request), vaultId);
	if (!authorized) return secureJson({ error: "unauthorized" }, 401);
	const decision = authorizeVaultAction(authorized.actor, "vault.excalidraw.shares.manage");
	if (!decision.allowed) return secureJson({ error: decision.reason }, 403);
	const vault = await readVault(env, vaultId).catch(() => null);
	if (!vault || vault.state !== "active" || vault.vaultGeneration !== authorized.actor.vaultGeneration) {
		return secureJson({ error: "vault_unavailable" }, 409);
	}
	if (!env.YAOS_EXCALIDRAW || !isExcalidrawIdentity(drawingId)
		|| (shareId !== undefined && !isExcalidrawIdentity(shareId))) return secureJson({ error: "not_found" }, 404);
	const headers = new Headers(request.headers);
	headers.delete("authorization");
	stripActorHeaders(headers);
	actorHeaders(authorized.actor).forEach((value, name) => headers.set(name, value));
	headers.set("x-yaos-vault-id", vaultId);
	headers.set("x-yaos-vault-generation", vault.vaultGeneration);
	headers.set("x-yaos-drawing-id", drawingId);
	const body = request.body && request.method !== "GET" ? await readBoundedBytes(request, 1024 * 1024) : null;
	const response = await env.YAOS_EXCALIDRAW.call(`${vault.vaultGeneration}:${drawingId}`,
		new Request(`https://internal/${shareId ? `shares/${encodeURIComponent(shareId)}` : "shares"}`,
			{ method: request.method, headers, ...(body ? { body: body.slice().buffer } : {}) }));
	const payload: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
	if (!response.ok || request.method !== "POST" || shareId !== undefined) return secureJson(payload, response.status);
	if (!isExcalidrawIdentity(payload.shareId) || !isExcalidrawIdentity(payload.publicDrawingId)
		|| !Number.isSafeInteger(payload.drawingEpoch)) {
		return secureJson({ error: "excalidraw_share_authority_mismatch" }, 502);
	}
	const route: ExcalidrawShareRouteEnvelope = { v: 1, vaultId, vaultGeneration: vault.vaultGeneration,
		drawingId, drawingEpoch: payload.drawingEpoch as number, shareId: payload.shareId,
		publicDrawingId: payload.publicDrawingId };
	return secureJson({ ...payload, routeEnvelope: await sealExcalidrawShareRoute(auth, route) }, response.status);
}

export async function handleExcalidrawSharePublicRoute(request: Request, env: Env, auth: AuthState,
	action: "session" | "snapshot" | "replay" | "batch" | "ws" | "resource" | "resources",
	publicResourceId?: string): Promise<Response> {
	if (env.YAOS_EXCALIDRAW_PUBLIC_READ !== "true") return secureJson({ error: "not_found" }, 404);
	if ((action === "batch" || action === "resources") && env.YAOS_EXCALIDRAW_PUBLIC_WRITE !== "true") {
		return secureJson({ error: "not_found" }, 404);
	}
	if (auth.mode !== "claim" || !env.YAOS_EXCALIDRAW) return secureJson({ error: "not_found" }, 404);
	if ((request.method !== "GET" || action === "ws") && request.headers.get("origin") !== new URL(request.url).origin) {
		return secureJson({ error: "excalidraw_share_origin_rejected" }, 403);
	}
	if (action === "session") return createPublicSession(request, env, auth);
	const sealed = readCookie(request, SESSION_COOKIE);
	const session = sealed ? await openExcalidrawShareSession(auth, sealed) : null;
	if (!session || session.expiresAt <= Date.now()) return secureJson({ error: "excalidraw_share_session_invalid" }, 401);
	const vault = await readVault(env, session.vaultId).catch(() => null);
	if (!vault || vault.state !== "active" || vault.vaultGeneration !== session.vaultGeneration) {
		return secureJson({ error: "excalidraw_share_unavailable" }, 404);
	}
	const headers = trustedPublicHeaders(request, session, await sha256Hex(new TextEncoder().encode(session.sessionToken)));
	let roomPath = `/__yaos/public/${action}`;
	if (action === "resource") {
		if (!isExcalidrawIdentity(publicResourceId)) return secureJson({ error: "invalid_excalidraw_share_resource" }, 400);
		roomPath = `/__yaos/public/resources/${encodeURIComponent(publicResourceId)}`;
	} else if (action === "resources") {
		const requestedId = request.headers.get("x-yaos-public-resource-id");
		if (!isExcalidrawIdentity(requestedId)) return secureJson({ error: "invalid_excalidraw_share_resource" }, 400);
		roomPath = `/__yaos/public/resources/${encodeURIComponent(requestedId)}`;
	}
	const url = new URL(request.url);
	url.pathname = roomPath;
	let body: Uint8Array | null = null;
	if (request.body && request.method !== "GET" && request.method !== "HEAD") {
		try { body = await readBoundedBytes(request, action === "resources" ? MAX_EXCALIDRAW_INBOUND_RESOURCE_BYTES : 1024 * 1024); }
		catch (error) { return secureJson({ error: error instanceof BoundedBodyError ? error.kind : "body_read_failed" }, 413); }
	}
	const response = await env.YAOS_EXCALIDRAW.call(`${session.vaultGeneration}:${session.drawingId}`,
		new Request(url, { method: request.method, headers, ...(body ? { body: body.slice().buffer } : {}) }));
	return action === "ws" ? response : secureResponse(response);
}

async function createPublicSession(request: Request, env: Env, auth: AuthState): Promise<Response> {
	let body: { routeEnvelope?: unknown; linkSecret?: unknown; displayName?: unknown };
	try { body = await request.json(); } catch { return secureJson({ error: "invalid_json" }, 400); }
	if (typeof body.routeEnvelope !== "string" || typeof body.linkSecret !== "string"
		|| body.routeEnvelope.length + body.linkSecret.length > 3_072
		|| body.linkSecret.length < 32 || body.linkSecret.length > 512
		|| (body.displayName !== undefined && typeof body.displayName !== "string")) {
		return secureJson({ error: "invalid_excalidraw_share_session" }, 400);
	}
	const route = await openExcalidrawShareRoute(auth, body.routeEnvelope);
	if (!route) return secureJson({ error: "excalidraw_share_unavailable" }, 404);
	const vault = await readVault(env, route.vaultId).catch(() => null);
	if (!vault || vault.state !== "active" || vault.vaultGeneration !== route.vaultGeneration) {
		return secureJson({ error: "excalidraw_share_unavailable" }, 404);
	}
	const headers = trustedRouteHeaders(request, route);
	headers.set("content-type", "application/json");
	const response = await env.YAOS_EXCALIDRAW!.call(`${route.vaultGeneration}:${route.drawingId}`,
		new Request("https://internal/__yaos/public/session", { method: "POST", headers,
			body: JSON.stringify({ linkSecretHash: await sha256Hex(new TextEncoder().encode(body.linkSecret)),
				displayName: body.displayName ?? "Guest" }) }));
	const payload: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
	if (!response.ok || !isExcalidrawIdentity(payload.sessionId) || typeof payload.sessionToken !== "string"
		|| !Number.isSafeInteger(payload.expiresAt)) return secureJson(response.ok
		? { error: "excalidraw_share_session_failed" } : payload, response.ok ? 502 : response.status);
	const sealed = await sealExcalidrawShareSession(auth, { ...route, sessionId: payload.sessionId,
		sessionToken: payload.sessionToken, expiresAt: payload.expiresAt as number });
	const { sessionId: _sessionId, sessionToken: _sessionToken, ...publicPayload } = payload;
	const result = secureJson({ ...publicPayload, drawingEpoch: route.drawingEpoch }, 201);
	result.headers.append("set-cookie", `${SESSION_COOKIE}=${sealed}; HttpOnly; Secure; SameSite=Strict; Path=/api/excalidraw/shares/session; Max-Age=${Math.max(1, Math.floor(((payload.expiresAt as number) - Date.now()) / 1000))}`);
	return result;
}

function trustedRouteHeaders(request: Request, route: ExcalidrawShareRouteEnvelope): Headers {
	const headers = new Headers();
	headers.set("x-yaos-vault-id", route.vaultId);
	headers.set("x-yaos-vault-generation", route.vaultGeneration);
	headers.set("x-yaos-drawing-id", route.drawingId);
	headers.set("x-yaos-drawing-epoch", String(route.drawingEpoch));
	headers.set("x-yaos-share-id", route.shareId);
	const origin = request.headers.get("origin");
	if (origin) headers.set("origin", origin);
	return headers;
}

function trustedPublicHeaders(request: Request, session: Awaited<ReturnType<typeof openExcalidrawShareSession>> & {}, tokenHash: string): Headers {
	const headers = trustedRouteHeaders(request, session);
	headers.set("x-yaos-share-session-id", session.sessionId);
	headers.set("x-yaos-share-session-token-hash", tokenHash);
	for (const name of ["content-type", "x-yaos-content-sha256", "upgrade", "connection", "sec-websocket-key",
		"sec-websocket-version", "sec-websocket-protocol"]) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	return headers;
}

function readCookie(request: Request, name: string): string | null {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=") || null;
	}
	return null;
}

function secureJson(value: unknown, status = 200): Response {
	return secureHeaders(Response.json(value, { status }));
}

async function secureResponse(response: Response): Promise<Response> {
	return secureHeaders(new Response(response.body, { status: response.status, statusText: response.statusText,
		headers: response.headers }));
}

function secureHeaders(response: Response): Response {
	response.headers.set("cache-control", "no-store");
	response.headers.set("referrer-policy", "no-referrer");
	response.headers.set("x-content-type-options", "nosniff");
	response.headers.set("cross-origin-resource-policy", "same-origin");
	return response;
}
