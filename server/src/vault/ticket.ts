// D4 streams tickets: HMAC-SHA-256 with the vault's 32-byte key from vault_meta. The wire is the legacy one (removed
// server/src/routes/ticket.ts): base64url(JSON payload) "." base64url(HMAC(key, encoded payload)), payload v 4,
// aud "yaos-vault-ws", purpose and documentId "streams", the actor's D6 fields, iat, exp, nonce. The legacy
// deploymentId is gone: the key is per vault, so a ticket cannot verify in another vault (T-TICKET-CROSS-VAULT).
import { base64UrlToBytes, bytesToBase64Url, randomBase64Url } from "../base64url";
import type { StreamActor } from "../streams/relay";

export const TICKET_VERSION = 4;
export const TICKET_AUDIENCE = "yaos-vault-ws";
/** D4: TTL 5 min unless `YAOS_TICKET_TTL_MS` says otherwise. */
export const TICKET_TTL_MS = 5 * 60 * 1000;
const MIN_TICKET_TTL_MS = 1000;
const MAX_TICKET_TTL_MS = 24 * 60 * 60 * 1000;
/** A ticket issued up to this far in the future (clock skew) still verifies, as in legacy. */
const MAX_ISSUED_AHEAD_MS = 60_000;

export interface TicketPayload extends StreamActor {
	v: typeof TICKET_VERSION;
	aud: typeof TICKET_AUDIENCE;
	purpose: "streams";
	documentId: "streams";
	iat: number;
	exp: number;
	nonce: string;
}

/** `YAOS_TICKET_TTL_MS`: unset or empty → 5 min; non-numeric → 5 min; else clamped to [1 s, 24 h] (legacy rules). */
export function readTicketTtlMs(raw: string | undefined): number {
	if (!raw) return TICKET_TTL_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed)
		? Math.min(MAX_TICKET_TTL_MS, Math.max(MIN_TICKET_TTL_MS, Math.floor(parsed)))
		: TICKET_TTL_MS;
}

/** The vault key as a non-extractable HMAC key (workers-types SubtleCrypto.importKey). */
export function importTicketKey(raw: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signTicket(key: CryptoKey, actor: StreamActor, now: number, ttlMs: number):
	Promise<{ ticket: string; expiresAt: number; ttlMs: number }> {
	const exp = now + ttlMs;
	const payload: TicketPayload = { ...actor, v: TICKET_VERSION, aud: TICKET_AUDIENCE, purpose: "streams",
		documentId: "streams", iat: now, exp, nonce: randomBase64Url(16) };
	const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded));
	return { ticket: `${encoded}.${bytesToBase64Url(new Uint8Array(signature))}`, expiresAt: exp, ttlMs };
}

/**
 * The verified payload, or null: exactly one dot with both parts non-empty, canonical base64url, a valid HMAC,
 * a well-formed payload for this vault and generation, `exp > now` and `iat <= now + 60 s`. The caller still checks
 * the device map (D7: an unexpired ticket of a revoked device stops working).
 */
export async function verifyTicket(key: CryptoKey, ticket: string, expected: { vaultId: string; vaultGeneration: string },
	now: number): Promise<TicketPayload | null> {
	const dot = ticket.indexOf(".");
	if (dot <= 0 || dot !== ticket.lastIndexOf(".") || dot === ticket.length - 1) return null;
	const encoded = ticket.slice(0, dot);
	let signature: Uint8Array;
	let payloadBytes: Uint8Array;
	try {
		signature = base64UrlToBytes(ticket.slice(dot + 1));
		payloadBytes = base64UrlToBytes(encoded);
	} catch {
		return null;
	}
	if (!await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(encoded))) return null;
	let payload: unknown;
	try { payload = JSON.parse(new TextDecoder().decode(payloadBytes)); } catch { return null; }
	if (!isTicketPayload(payload) || payload.vaultId !== expected.vaultId
		|| payload.vaultGeneration !== expected.vaultGeneration
		|| payload.exp <= now || payload.iat > now + MAX_ISSUED_AHEAD_MS) return null;
	return payload;
}

function isTicketPayload(value: unknown): value is TicketPayload {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	const positive = (field: unknown) => Number.isSafeInteger(field) && (field as number) > 0;
	const text = (field: unknown) => typeof field === "string" && field.length > 0;
	return payload.v === TICKET_VERSION && payload.aud === TICKET_AUDIENCE
		&& payload.purpose === "streams" && payload.documentId === "streams"
		&& text(payload.vaultId) && text(payload.vaultGeneration) && text(payload.principalId)
		&& positive(payload.membershipRevision) && text(payload.deviceId)
		&& (payload.deviceName === undefined || (text(payload.deviceName) && (payload.deviceName as string).length <= 256))
		&& positive(payload.deviceCredentialRevision) && (payload.role === "owner" || payload.role === "member")
		&& positive(payload.policyVersion) && text(payload.capabilityDigest)
		&& Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp) && text(payload.nonce);
}
