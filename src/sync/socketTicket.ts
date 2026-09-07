/** Fetches and caches the mandatory short-lived WebSocket ticket. */

import { obsidianRequest, type HttpRequester } from "../utils/http";


/**
 * Thrown by fetchSocketTicket when the server responds with a non-200 status.
 * Using a typed error instead of parsing the status code out of a string lets
 * callers branch on `err.status` rather than regexing an English message.
 */
export class SocketTicketHttpError extends Error {
	constructor(
		readonly status: number,
		readonly retryAfterMs?: number,
	) {
		super(`socket ticket request failed (${status})`);
		this.name = "SocketTicketHttpError";
	}
}


// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Refresh when the cached ticket has less than 30 seconds remaining.
 * Also used by VaultSync to schedule the proactive provider URL refresh:
 * the timer fires at expiresAt - TICKET_REFRESH_BUFFER_MS so a fresh ticket
 * is in place before the current one becomes unusable.
 */
export const TICKET_REFRESH_BUFFER_MS = 30_000;
const MAX_REASONABLE_TICKET_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours

export interface CachedSocketTicket {
	value: string;
	expiresAt: number;
	localExpiresAt: number;
	ttlMs: number;
}

export interface SocketTicketScope {
	purpose: "root" | "body";
	documentId: string;
}

export interface SocketTicketCache {
	get(host: string, deviceToken: string, vaultId: string, scope: SocketTicketScope): Promise<CachedSocketTicket>;
	invalidate(): void;
}

export function createSocketTicketCache(request: HttpRequester = obsidianRequest): SocketTicketCache {
	let cached: CachedSocketTicket | null = null;
	let cachedKey: string | null = null;
	let inFlight: { key: string; revision: number; promise: Promise<CachedSocketTicket> } | null = null;
	let revision = 0;

	return {
		async get(host: string, deviceToken: string, vaultId: string, scope: SocketTicketScope): Promise<CachedSocketTicket> {
			const key = `${host.replace(/\/$/, "")}\0${deviceToken}\0${vaultId}\0${scope.purpose}\0${scope.documentId}`;
			const now = Date.now();
			if (cached && cachedKey === key && cached.localExpiresAt - now > TICKET_REFRESH_BUFFER_MS) {
				return cached;
			}
			if (inFlight?.key === key && inFlight.revision === revision) return inFlight.promise;
			const requestRevision = revision;
			const promise = fetchSocketTicket(host, deviceToken, vaultId, scope, request).then((fresh) => {
				if (revision === requestRevision) {
					cached = fresh;
					cachedKey = key;
				}
				return fresh;
			});
			inFlight = { key, revision: requestRevision, promise };
			try {
				return await promise;
			} finally {
				if (inFlight?.promise === promise) inFlight = null;
			}
		},
		invalidate() {
			revision++;
			cached = null;
			cachedKey = null;
		},
	};
}

// ---------------------------------------------------------------------------
// URL patching
// ---------------------------------------------------------------------------

/** Replace the ticket parameter while stripping any stale credential parameter. */
export function patchTicketInUrl(url: string, ticketValue: string): string {
	const u = new URL(url);
	u.searchParams.delete("token");
	u.searchParams.set("ticket", ticketValue);
	return u.toString();
}

// ---------------------------------------------------------------------------
// Network fetch
// ---------------------------------------------------------------------------

async function fetchSocketTicket(
	host: string,
	deviceToken: string,
	vaultId: string,
	scope: SocketTicketScope,
	request: HttpRequester,
): Promise<CachedSocketTicket> {
	const base = host.replace(/\/$/, "");
	const res = await request({
		url: `${base}/vault/${encodeURIComponent(vaultId)}/auth/ticket`,
		method: "POST",
		headers: { Authorization: `Bearer ${deviceToken}` },
		contentType: "application/json",
		body: JSON.stringify(scope),
	});

	if (res.status !== 200) {
		throw new SocketTicketHttpError(res.status, parseRetryAfterMs(res.headers));
	}

	const body = res.json as { ticket?: unknown; expiresAt?: unknown; ttlMs?: unknown };
	if (
		typeof body?.ticket !== "string" ||
		typeof body?.expiresAt !== "number" ||
		typeof body?.ttlMs !== "number" ||
		!Number.isFinite(body.ttlMs) ||
		body.ttlMs <= 0 ||
		body.ttlMs > MAX_REASONABLE_TICKET_TTL_MS
	) {
		throw new Error("socket ticket response malformed");
	}

	const receivedAt = Date.now();
	return {
		value: body.ticket,
		expiresAt: body.expiresAt,
		localExpiresAt: receivedAt + body.ttlMs,
		ttlMs: body.ttlMs,
	};
}

function parseRetryAfterMs(headers: Record<string, string>): number | undefined {
	const raw = headers["retry-after"] ?? headers["Retry-After"];
	if (!raw) return undefined;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
	const deadline = Date.parse(raw);
	if (!Number.isFinite(deadline)) return undefined;
	return Math.max(0, deadline - Date.now());
}
