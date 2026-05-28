/**
 * Short-lived WebSocket connection tickets.
 *
 * # Why
 * The browser WebSocket() constructor does not accept custom headers, so auth
 * tokens cannot be passed via Authorization: Bearer during the WS handshake.
 * Putting the long-lived token in a query parameter exposes it in server logs
 * and browser devtools.
 *
 * A short-lived ticket fixes this: the long-lived token is sent only in a
 * normal HTTP POST (Authorization header, TLS-encrypted, not logged in URL
 * access logs), and the resulting ticket — valid for 5 minutes — is placed in
 * the WebSocket URL.  Even if logged, a stale ticket is useless.
 *
 * # Ticket format
 * Two base64url-encoded segments separated by ".":
 *
 *   base64url(JSON(payload)) "." base64url(HMAC-SHA256(signingKey, base64url(JSON(payload))))
 *
 * The payload is a small JSON object:
 *   { v: 1, aud: "yaos-ws", vaultId: "...", iat: ms, exp: ms, nonce: "..." }
 *
 * # Signing key
 * Derived from the existing auth secret so no new deployment secret is needed:
 *   env-token mode  → raw bytes of SYNC_TOKEN
 *   claim mode      → raw bytes of the stored tokenHash (hex string)
 *
 * The invariant is preserved: no Durable Object is woken before the ticket is
 * verified at the Worker edge (INV-SEC-01).
 */

import { base64UrlToBytes, bytesToBase64Url, randomBase64Url } from "../base64url";
import { json } from "./http";
import type { AuthState, Env } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TICKET_VERSION = 1;
const TICKET_AUD = "yaos-ws";
/** Default TTL.  Long enough for slow mobile reconnects; short enough to
 *  limit the damage from a logged value. */
export const TICKET_TTL_MS = 5 * 60 * 1_000; // 5 minutes
const MAX_REASONABLE_TICKET_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours

function readTicketTtlMs(raw: string | undefined): number {
	if (!raw) return TICKET_TTL_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return TICKET_TTL_MS;
	return Math.min(MAX_REASONABLE_TICKET_TTL_MS, Math.max(1_000, Math.floor(parsed)));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TicketPayload {
	v: number;
	aud: string;
	vaultId: string;
	iat: number;
	exp: number;
	nonce: string;
}

// ---------------------------------------------------------------------------
// Signing key derivation
// ---------------------------------------------------------------------------

/**
 * Import the HMAC-SHA256 signing key from the server's auth secret.
 *
 * env mode  → SYNC_TOKEN (the raw token string)
 * claim mode → tokenHash  (the stored SHA-256 hex of the token)
 *
 * Returns null if the auth state is unclaimed (no key material available).
 */
async function deriveSigningKey(authState: AuthState): Promise<CryptoKey | null> {
	let keyMaterial: string;
	if (authState.mode === "env") {
		keyMaterial = authState.envToken;
	} else if (authState.mode === "claim") {
		keyMaterial = authState.tokenHash;
	} else {
		return null;
	}
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(keyMaterial),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

// ---------------------------------------------------------------------------
// Ticket creation
// ---------------------------------------------------------------------------

export async function createTicket(
	authState: AuthState,
	vaultId: string,
	ttlMs = TICKET_TTL_MS,
): Promise<{ ticket: string; expiresAt: number; ttlMs: number }> {
	const key = await deriveSigningKey(authState);
	if (!key) throw new Error("cannot sign ticket: server is unclaimed");

	const now = Date.now();
	const exp = now + ttlMs;

	const payload: TicketPayload = {
		v: TICKET_VERSION,
		aud: TICKET_AUD,
		vaultId,
		iat: now,
		exp,
		nonce: randomBase64Url(16),
	};

	const encodedPayload = bytesToBase64Url(
		new TextEncoder().encode(JSON.stringify(payload)),
	);
	const sigBytes = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(encodedPayload),
	);
	const encodedSig = bytesToBase64Url(new Uint8Array(sigBytes));

	return {
		ticket: `${encodedPayload}.${encodedSig}`,
		expiresAt: exp,
		ttlMs,
	};
}

// ---------------------------------------------------------------------------
// Ticket verification
// ---------------------------------------------------------------------------

/**
 * Verify a ticket string.  Returns `true` only when:
 *   - The ticket is structurally valid (two base64url segments separated by ".")
 *   - The HMAC-SHA256 signature is correct for the current auth secret
 *   - The ticket has not expired
 *   - The `aud` and `v` fields match expected constants
 *   - The embedded `vaultId` matches `expectedVaultId`
 *
 * Any failure returns `false` without throwing — invalid tickets are treated
 * as unauthorized, not as errors.
 */
export async function verifyTicket(
	ticket: string,
	authState: AuthState,
	expectedVaultId: string,
): Promise<boolean> {
	const dot = ticket.indexOf(".");
	if (dot <= 0 || dot === ticket.length - 1) return false;

	const encodedPayload = ticket.slice(0, dot);
	const encodedSig = ticket.slice(dot + 1);

	const key = await deriveSigningKey(authState);
	if (!key) return false;

	let sigBytes: Uint8Array;
	let payloadBytes: Uint8Array;
	try {
		sigBytes = base64UrlToBytes(encodedSig);
		payloadBytes = base64UrlToBytes(encodedPayload);
	} catch {
		return false;
	}

	// Verify HMAC over the encoded payload string (not the decoded bytes).
	const valid = await crypto.subtle.verify(
		"HMAC",
		key,
		sigBytes,
		new TextEncoder().encode(encodedPayload),
	);
	if (!valid) return false;

	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(payloadBytes));
	} catch {
		return false;
	}

	if (!isTicketPayload(payload)) return false;
	if (payload.v !== TICKET_VERSION) return false;
	if (payload.aud !== TICKET_AUD) return false;
	if (payload.vaultId !== expectedVaultId) return false;
	if (payload.exp <= Date.now()) return false;

	return true;
}

function isTicketPayload(value: unknown): value is TicketPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	return (
		typeof p.v === "number" &&
		typeof p.aud === "string" &&
		typeof p.vaultId === "string" &&
		typeof p.iat === "number" &&
		typeof p.exp === "number" &&
		typeof p.nonce === "string"
	);
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/**
 * POST /vault/:vaultId/auth/ticket
 *
 * Called by the plugin before opening a WebSocket connection.  The caller
 * must already be authenticated (Bearer token validated upstream by the
 * rejectAndLogUnauthorizedVaultRequest gate in index.ts).
 *
 * Returns { ticket: string, expiresAt: number }.
 */
export async function handleTicketRoute(
	_req: Request,
	authState: AuthState,
	vaultId: string,
	json: (body: unknown, status?: number) => Response,
	env?: Env,
): Promise<Response> {
		try {
			// Allow a short test TTL override so the integration harness can exercise
			// the proactive refresh path without waiting 5 minutes.
			const ttlMs = readTicketTtlMs(env?.YAOS_TICKET_TTL_MS);
			const result = await createTicket(authState, vaultId, ttlMs);
			return json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : "ticket creation failed";
		console.error("[yaos-sync:worker] ticket creation error:", message);
		return json({ error: message }, 500);
	}
}
