import { base64UrlToBytes, bytesToBase64Url, randomBase64Url } from "../base64url";
import type { VaultActorContext } from "../collaboration";
import { sha256Hex } from "../hex";
import type { AuthState, Env } from "./types";
import {
	parseSemanticEpoch,
	semanticEpochOf,
	type SemanticEpoch,
	type SemanticEpochScope,
} from "../shared/semanticEpoch";

const TICKET_VERSION = 4;
const TICKET_AUDIENCE = "yaos-vault-ws";
export const TICKET_TTL_MS = 5 * 60 * 1_000;
const MAX_TICKET_TTL_MS = 24 * 60 * 60 * 1_000;

interface TicketPayloadFields extends VaultActorContext {
	v: 4;
	aud: "yaos-vault-ws";
	deploymentId: string;
	iat: number;
	exp: number;
	nonce: string;
}

/** The signed ticket binds one actor to one CRDT identity lineage. */
type TicketEpochScope = SemanticEpochScope
	| { purpose: "semantic"; documentId: string; bodyEpoch: SemanticEpoch };

export type TicketPayload = TicketPayloadFields & TicketEpochScope;

export interface ExpectedTicketScope {
	vaultId: string;
	vaultGeneration?: string;
	purpose?: "root" | "body" | "semantic";
	documentId?: string;
	rootEpoch?: number;
	bodyEpoch?: number;
}

function readTicketTtlMs(raw: string | undefined): number {
	if (!raw) return TICKET_TTL_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? Math.min(MAX_TICKET_TTL_MS, Math.max(1_000, Math.floor(parsed))) : TICKET_TTL_MS;
}

async function importSigningKey(ticketSigningKey: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", new TextEncoder().encode(ticketSigningKey),
		{ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function deploymentId(authState: AuthState): Promise<string> {
	if (authState.mode !== "claim") throw new Error("cannot derive deployment identity");
	return (await sha256Hex(new TextEncoder().encode(`yaos-deployment:${authState.ticketSigningKey}`))).slice(0, 32);
}

export async function createTicket(authState: AuthState, actor: VaultActorContext,
	scope: TicketEpochScope, ttlMs = TICKET_TTL_MS,
): Promise<{ ticket: string; expiresAt: number; ttlMs: number }> {
	if (authState.mode !== "claim") throw new Error("cannot sign ticket: server is unavailable");
	if (scope.purpose === "semantic") {
		if (!scope.documentId || scope.documentId === "root") throw new Error("invalid semantic epoch scope identity");
		parseSemanticEpoch(scope.bodyEpoch, "semantic document epoch");
	} else semanticEpochOf(scope);
	const now = Date.now();
	const exp = now + ttlMs;
	const payload: TicketPayload = { ...actor, v: TICKET_VERSION, aud: TICKET_AUDIENCE,
		deploymentId: await deploymentId(authState), ...scope,
		iat: now, exp, nonce: randomBase64Url(16) };
	const encodedPayload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
	const signature = await crypto.subtle.sign("HMAC", await importSigningKey(authState.ticketSigningKey),
		new TextEncoder().encode(encodedPayload));
	return { ticket: `${encodedPayload}.${bytesToBase64Url(new Uint8Array(signature))}`, expiresAt: exp, ttlMs };
}

export async function inspectTicket(ticket: string, authState: AuthState,
	expected: string | ExpectedTicketScope,
): Promise<TicketPayload | null> {
	if (authState.mode !== "claim") return null;
	const scope = typeof expected === "string" ? { vaultId: expected } : expected;
	const dot = ticket.indexOf(".");
	if (dot <= 0 || dot !== ticket.lastIndexOf(".") || dot === ticket.length - 1) return null;
	const encodedPayload = ticket.slice(0, dot);
	let signature: Uint8Array;
	let payloadBytes: Uint8Array;
	try { signature = base64UrlToBytes(ticket.slice(dot + 1)); payloadBytes = base64UrlToBytes(encodedPayload); }
	catch { return null; }
	if (!await crypto.subtle.verify("HMAC", await importSigningKey(authState.ticketSigningKey), signature,
		new TextEncoder().encode(encodedPayload))) return null;
	let payload: unknown;
	try { payload = JSON.parse(new TextDecoder().decode(payloadBytes)); } catch { return null; }
	if (!isTicketPayload(payload) || payload.deploymentId !== await deploymentId(authState)
		|| payload.vaultId !== scope.vaultId
		|| (scope.vaultGeneration !== undefined && payload.vaultGeneration !== scope.vaultGeneration)
		|| (scope.purpose !== undefined && payload.purpose !== scope.purpose)
		|| (scope.documentId !== undefined && payload.documentId !== scope.documentId)
		|| ("rootEpoch" in scope && scope.rootEpoch !== undefined
			&& (payload.purpose !== "root" || payload.rootEpoch !== scope.rootEpoch))
		|| ("bodyEpoch" in scope && scope.bodyEpoch !== undefined
			&& ((payload.purpose !== "body" && payload.purpose !== "semantic")
				|| payload.bodyEpoch !== scope.bodyEpoch))
		|| payload.exp <= Date.now() || payload.iat > Date.now() + 60_000) return null;
	return payload;
}

export async function verifyTicket(ticket: string, authState: AuthState, expectedVaultId: string): Promise<boolean> {
	return (await inspectTicket(ticket, authState, expectedVaultId)) !== null;
}

function isTicketPayload(value: unknown): value is TicketPayload {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	return payload.v === 4 && payload.aud === "yaos-vault-ws"
		&& typeof payload.deploymentId === "string" && payload.deploymentId.length > 0
		&& (payload.purpose === "root" || payload.purpose === "body" || payload.purpose === "semantic")
		&& typeof payload.documentId === "string" && payload.documentId.length > 0
		&& (payload.purpose === "root") === (payload.documentId === "root")
		&& (payload.purpose === "root"
			? Number.isSafeInteger(payload.rootEpoch) && (payload.rootEpoch as number) >= 1 && payload.bodyEpoch === undefined
			: Number.isSafeInteger(payload.bodyEpoch) && (payload.bodyEpoch as number) >= 1 && payload.rootEpoch === undefined)
		&& typeof payload.vaultId === "string" && payload.vaultId.length > 0
		&& typeof payload.vaultGeneration === "string" && payload.vaultGeneration.length > 0
		&& typeof payload.principalId === "string" && payload.principalId.length > 0
		&& Number.isSafeInteger(payload.membershipRevision) && (payload.membershipRevision as number) > 0
		&& typeof payload.deviceId === "string" && payload.deviceId.length > 0
		&& (payload.deviceName === undefined || (typeof payload.deviceName === "string" && payload.deviceName.length > 0 && payload.deviceName.length <= 256))
		&& Number.isSafeInteger(payload.deviceCredentialRevision) && (payload.deviceCredentialRevision as number) > 0
		&& (payload.role === "owner" || payload.role === "member")
		&& Number.isSafeInteger(payload.policyVersion) && (payload.policyVersion as number) > 0
		&& typeof payload.capabilityDigest === "string" && payload.capabilityDigest.length > 0
		&& Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp)
		&& typeof payload.nonce === "string" && payload.nonce.length > 0;
}

export async function handleTicketRoute(req: Request, authState: AuthState, actor: VaultActorContext,
	json: (body: unknown, status?: number) => Response, env?: Env,
): Promise<Response> {
	try {
		let input: { purpose?: unknown; documentId?: unknown; rootEpoch?: unknown; bodyEpoch?: unknown } = {};
		try { input = await req.json(); } catch { /* invalid below */ }
		if ((input.purpose !== "root" && input.purpose !== "body" && input.purpose !== "semantic")
			|| typeof input.documentId !== "string" || input.documentId.length === 0) return json({ error: "invalid_ticket_scope" }, 400);
		let scope: TicketEpochScope;
		try {
			scope = input.purpose === "root"
				? { purpose: "root", documentId: "root", rootEpoch: parseSemanticEpoch(input.rootEpoch, "root epoch") }
				: { purpose: input.purpose, documentId: input.documentId,
					bodyEpoch: parseSemanticEpoch(input.bodyEpoch, `${input.purpose} epoch`) };
			if (scope.purpose === "semantic") {
				if (scope.documentId === "root") throw new Error("invalid semantic ticket scope");
			} else semanticEpochOf(scope);
		} catch {
			return json({ error: "invalid_ticket_scope" }, 400);
		}
		const result = await createTicket(authState, actor, scope, readTicketTtlMs(env?.YAOS_TICKET_TTL_MS));
		if (env) try {
			await env.YAOS_CONFIG.call("global-config", new Request("https://internal/__yaos/touch-device", {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ deviceId: actor.deviceId, vaultId: actor.vaultId }),
			}));
		} catch { /* best effort */ }
		return json(result);
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : "ticket creation failed" }, 500);
	}
}
