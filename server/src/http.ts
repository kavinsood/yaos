// HTTP helpers shared by the Worker and the vault DO. The JSON, HTML and CORS shapes are the legacy ones
// (removed server/src/routes/http.ts), so headers stay identical on the wire.
import type { UpgradeRejectPort } from "./ports";

const CORS_ALLOW_HEADERS = "Authorization, Content-Type";
const CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}

export function html(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
	});
}

export function notFound(): Response {
	return json({ error: "not_found" }, 404);
}

/** Adds the static CORS headers; keeps a WebSocket handoff attached. */
export function withCors(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
	headers.set("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
	const webSocket = (response as { webSocket?: WebSocket | null }).webSocket ?? null;
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
		...(webSocket ? { webSocket } : {}),
	});
}

export function corsPreflight(): Response {
	return withCors(new Response(null, { status: 204 }));
}

/** `Authorization: Bearer <token>`; anything else is no credential. */
export function bearerToken(request: Request): string | null {
	const authorization = request.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) return null;
	return authorization.slice("Bearer ".length).trim() || null;
}

export function isWebSocketUpgrade(request: Request): boolean {
	return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

/**
 * A refused streams socket (relay-wire §3.1). An upgrade gets the `error` frame and close 1008; a plain request gets
 * the same code as JSON (401 `unauthorized`, 426 `update_required`).
 */
export function rejectSocket(
	request: Request,
	upgrades: UpgradeRejectPort,
	code: "unauthorized" | "update_required",
	details: Record<string, unknown> = {},
): Response {
	if (!isWebSocketUpgrade(request)) {
		return Response.json({ error: code, ...details }, { status: code === "unauthorized" ? 401 : 426 });
	}
	const frame = `__YPS:${JSON.stringify({ type: "error", code, ...details })}`;
	return upgrades.reject(frame, 1008, code === "update_required" ? "update required" : code);
}

/**
 * Drains a request body nobody read. A response sent while the client body is still pending made workerd throw
 * "Can't read from request stream after response has been sent" and could fail the next request on the connection.
 */
export async function releaseUnreadBody(request: Request): Promise<void> {
	const body = request.body;
	if (!body || request.bodyUsed || body.locked) return;
	const reader = body.getReader();
	try {
		for (;;) {
			const { done } = await reader.read();
			if (done) return;
		}
	} catch {
		// The client went away mid-body; nothing is left to read.
	} finally {
		reader.releaseLock();
	}
}
