import { base64UrlToBytes, bytesToBase64Url, randomBase64Url } from "../base64url";
import type { AuthState, Env } from "./types";

const TICKET_VERSION = 1;
const TICKET_AUDIENCE = "yaos-ws";
export const TICKET_TTL_MS = 5 * 60 * 1_000;
const MAX_TICKET_TTL_MS = 24 * 60 * 60 * 1_000;

export interface TicketPayload {
	v: number;
	aud: string;
	vaultId: string;
	deviceId: string;
	iat: number;
	exp: number;
	nonce: string;
}

function readTicketTtlMs(raw: string | undefined): number {
	if (!raw) return TICKET_TTL_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed)
		? Math.min(MAX_TICKET_TTL_MS, Math.max(1_000, Math.floor(parsed)))
		: TICKET_TTL_MS;
}

async function importSigningKey(ticketSigningKey: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(ticketSigningKey),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function createTicket(
	authState: AuthState,
	vaultId: string,
	deviceId: string,
	ttlMs = TICKET_TTL_MS,
): Promise<{ ticket: string; expiresAt: number; ttlMs: number }> {
	if (authState.mode !== "claim") throw new Error("cannot sign ticket: server is unavailable");
	const now = Date.now();
	const exp = now + ttlMs;
	const payload: TicketPayload = {
		v: TICKET_VERSION,
		aud: TICKET_AUDIENCE,
		vaultId,
		deviceId,
		iat: now,
		exp,
		nonce: randomBase64Url(16),
	};
	const encodedPayload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
	const signature = await crypto.subtle.sign(
		"HMAC",
		await importSigningKey(authState.ticketSigningKey),
		new TextEncoder().encode(encodedPayload),
	);
	return {
		ticket: `${encodedPayload}.${bytesToBase64Url(new Uint8Array(signature))}`,
		expiresAt: exp,
		ttlMs,
	};
}

export async function inspectTicket(
	ticket: string,
	authState: AuthState,
	expectedVaultId: string,
): Promise<TicketPayload | null> {
	if (authState.mode !== "claim") return null;
	const dot = ticket.indexOf(".");
	if (dot <= 0 || dot !== ticket.lastIndexOf(".") || dot === ticket.length - 1) return null;
	const encodedPayload = ticket.slice(0, dot);
	let signature: Uint8Array;
	let payloadBytes: Uint8Array;
	try {
		signature = base64UrlToBytes(ticket.slice(dot + 1));
		payloadBytes = base64UrlToBytes(encodedPayload);
	} catch {
		return null;
	}
	const valid = await crypto.subtle.verify(
		"HMAC",
		await importSigningKey(authState.ticketSigningKey),
		signature,
		new TextEncoder().encode(encodedPayload),
	);
	if (!valid) return null;
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(payloadBytes));
	} catch {
		return null;
	}
	if (!isTicketPayload(payload)) return null;
	if (payload.v !== TICKET_VERSION || payload.aud !== TICKET_AUDIENCE) return null;
	if (payload.vaultId !== expectedVaultId || payload.exp <= Date.now()) return null;
	return payload;
}

export async function verifyTicket(
	ticket: string,
	authState: AuthState,
	expectedVaultId: string,
): Promise<boolean> {
	return (await inspectTicket(ticket, authState, expectedVaultId)) !== null;
}

function isTicketPayload(value: unknown): value is TicketPayload {
	if (!value || typeof value !== "object") return false;
	const payload = value as Record<string, unknown>;
	return typeof payload.v === "number"
		&& typeof payload.aud === "string"
		&& typeof payload.vaultId === "string"
		&& payload.vaultId.length > 0
		&& typeof payload.deviceId === "string"
		&& payload.deviceId.length > 0
		&& typeof payload.iat === "number"
		&& typeof payload.exp === "number"
		&& typeof payload.nonce === "string";
}

export async function handleTicketRoute(
	_req: Request,
	authState: AuthState,
	vaultId: string,
	deviceId: string,
	json: (body: unknown, status?: number) => Response,
	env?: Env,
): Promise<Response> {
	try {
		const result = await createTicket(authState, vaultId, deviceId, readTicketTtlMs(env?.YAOS_TICKET_TTL_MS));
		if (env) {
			try {
				await env.YAOS_CONFIG.call("global-config", new Request("https://internal/__yaos/touch-device", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ deviceId, vaultId }),
				}));
			} catch {
				// lastSeenAt is best-effort and never blocks a valid ticket.
			}
		}
		return json(result);
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : "ticket creation failed" }, 500);
	}
}
