/**
 * Socket ticket fetch and cache for the plugin.
 *
 * Fetches a short-lived WebSocket connection ticket from the server and caches
 * it until it has less than TICKET_REFRESH_BUFFER_MS of life remaining.
 *
 * Usage in VaultSync:
 *
 *   const ticketCache = createSocketTicketCache();
 *   const getSocketTicket = (force?: boolean) => {
 *     if (force) ticketCache.invalidate();
 *     return ticketCache.get(settings.host, settings.token, settings.vaultId);
 *   };
 *
 * The cache is intentionally simple: one ticket per VaultSync instance.
 * VaultSync is recreated on settings changes (host/token/vaultId), so the
 * cache is automatically invalidated in those cases.
 *
 * VaultSync schedules a proactive provider URL refresh timer based on the
 * returned expiresAt so that reconnects always find a live ticket in
 * provider.url — y-partyserver's internal reconnect loop reuses provider.url
 * directly without re-calling params().
 */

import { obsidianRequest } from "../utils/http";

// ---------------------------------------------------------------------------
// Typed HTTP error
// ---------------------------------------------------------------------------

/**
 * Thrown by fetchSocketTicket when the server responds with a non-200 status.
 * Using a typed error instead of parsing the status code out of a string lets
 * callers branch on `err.status` rather than regexing an English message.
 */
export class SocketTicketHttpError extends Error {
	constructor(readonly status: number) {
		super(`socket ticket request failed (${status})`);
		this.name = "SocketTicketHttpError";
	}
}

/**
 * Returns true when the ticket endpoint does not exist on this server —
 * clean "old server" signals only:
 *   404 Not Found          — endpoint was never deployed
 *   405 Method Not Allowed — endpoint exists but rejects POST
 *   501 Not Implemented    — explicit unsupported signal
 *
 * Auth failures (401, 403), server errors (500), and network failures are NOT
 * treated as unsupported.  They indicate real problems and must propagate.
 */
export function isTicketEndpointUnsupported(err: unknown): boolean {
	return (
		err instanceof SocketTicketHttpError &&
		(err.status === 404 || err.status === 405 || err.status === 501)
	);
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

export interface SocketTicketCache {
	/**
	 * Return a usable ticket, fetching a fresh one if the cache is empty or
	 * close to expiry.  Returns the full CachedSocketTicket so callers can
	 * schedule a proactive refresh timer based on expiresAt.
	 *
	 * Throws `SocketTicketHttpError` for HTTP failures and a plain `Error` for
	 * network/parse failures.  Callers must NOT fall back to the long-lived
	 * token on failure — let the connection attempt fail and retry normally.
	 *
	 * Throws immediately if the server has already been confirmed unsupported
	 * (see `markUnsupported`).
	 */
	get(host: string, token: string, vaultId: string): Promise<CachedSocketTicket>;
	/** Discard the cached ticket, forcing a fresh fetch on the next get(). */
	invalidate(): void;
	/**
	 * Mark this server as confirmed-unsupported for ticket auth (i.e. the
	 * endpoint returned 404/405/501).  Subsequent `get()` calls return
	 * immediately without network I/O so old servers are not re-probed on
	 * every reconnect.
	 */
	markUnsupported(): void;
	/** True once `markUnsupported()` has been called. */
	isUnsupported(): boolean;
}

export function createSocketTicketCache(): SocketTicketCache {
	let cached: CachedSocketTicket | null = null;
	let unsupported = false;

	return {
		async get(host: string, token: string, vaultId: string): Promise<CachedSocketTicket> {
			if (unsupported) {
				throw new SocketTicketHttpError(404); // already confirmed missing
			}
			const now = Date.now();
			if (cached && cached.localExpiresAt - now > TICKET_REFRESH_BUFFER_MS) {
				return cached;
			}
			const fresh = await fetchSocketTicket(host, token, vaultId);
			cached = fresh;
			return fresh;
		},
		invalidate() {
			cached = null;
		},
		markUnsupported() {
			unsupported = true;
			cached = null;
		},
		isUnsupported() {
			return unsupported;
		},
	};
}

// ---------------------------------------------------------------------------
// URL patching
// ---------------------------------------------------------------------------

/**
 * Return a copy of `url` with `ticket` replaced by `ticketValue` and `token`
 * removed.  Other query parameters (schemaVersion, _pk, device, trace, boot,
 * etc.) are preserved untouched.
 *
 * Used by VaultSync.patchProviderTicket to keep provider.url current between
 * reconnects — y-partyserver's reconnect loop reads provider.url directly
 * without re-calling the async params() callback.
 */
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
	token: string,
	vaultId: string,
): Promise<CachedSocketTicket> {
	const base = host.replace(/\/$/, "");
	const res = await obsidianRequest({
		url: `${base}/vault/${encodeURIComponent(vaultId)}/auth/ticket`,
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
	});

	if (res.status !== 200) {
		throw new SocketTicketHttpError(res.status);
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
