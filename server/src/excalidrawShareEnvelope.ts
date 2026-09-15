import { base64UrlToBytes, bytesToBase64Url } from "./base64url";
import type { AuthState } from "./routes/types";
import type { ExcalidrawShareRouteEnvelope, ExcalidrawShareSessionEnvelope } from "./shared/excalidrawShareProtocol";
import { isExcalidrawIdentity } from "./shared/excalidrawProtocol";

const ROUTE_PURPOSE = "yaos-excalidraw-share-route-v1";
const SESSION_PURPOSE = "yaos-excalidraw-share-session-v1";

export async function sealExcalidrawShareRoute(auth: AuthState, value: ExcalidrawShareRouteEnvelope): Promise<string> {
	return seal(auth, ROUTE_PURPOSE, value);
}

export async function openExcalidrawShareRoute(auth: AuthState, value: string): Promise<ExcalidrawShareRouteEnvelope | null> {
	const opened = await open(auth, ROUTE_PURPOSE, value);
	return validRoute(opened) ? opened : null;
}

export async function sealExcalidrawShareSession(auth: AuthState, value: ExcalidrawShareSessionEnvelope): Promise<string> {
	return seal(auth, SESSION_PURPOSE, value);
}

export async function openExcalidrawShareSession(auth: AuthState, value: string): Promise<ExcalidrawShareSessionEnvelope | null> {
	const opened = await open(auth, SESSION_PURPOSE, value);
	return validSession(opened) ? opened : null;
}

async function seal(auth: AuthState, purpose: string, value: unknown): Promise<string> {
	if (auth.mode !== "claim") throw new Error("share_envelope_unavailable");
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = new TextEncoder().encode(JSON.stringify(value));
	const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) },
		await key(auth.ticketSigningKey, purpose), plaintext);
	return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

async function open(auth: AuthState, purpose: string, value: string): Promise<unknown> {
	if (auth.mode !== "claim" || value.length > 4_096) return null;
	const dot = value.indexOf(".");
	if (dot < 1 || dot !== value.lastIndexOf(".")) return null;
	try {
		const iv = base64UrlToBytes(value.slice(0, dot));
		const ciphertext = base64UrlToBytes(value.slice(dot + 1));
		if (iv.byteLength !== 12 || ciphertext.byteLength < 17) return null;
		const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv,
			additionalData: new TextEncoder().encode(purpose) }, await key(auth.ticketSigningKey, purpose), ciphertext);
		return JSON.parse(new TextDecoder().decode(plaintext));
	} catch { return null; }
}

async function key(secret: string, purpose: string): Promise<CryptoKey> {
	const input = new TextEncoder().encode(`${purpose}\0${secret}`);
	const digest = await crypto.subtle.digest("SHA-256", input);
	return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function validRoute(value: unknown): value is ExcalidrawShareRouteEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const input = value as Record<string, unknown>;
	return input.v === 1 && isExcalidrawIdentity(input.vaultId) && isExcalidrawIdentity(input.vaultGeneration)
		&& isExcalidrawIdentity(input.drawingId) && isExcalidrawIdentity(input.shareId)
		&& Number.isSafeInteger(input.drawingEpoch) && (input.drawingEpoch as number) >= 1
		&& isExcalidrawIdentity(input.publicDrawingId);
}

function validSession(value: unknown): value is ExcalidrawShareSessionEnvelope {
	if (!validRoute(value)) return false;
	const input = value as unknown as Record<string, unknown>;
	return isExcalidrawIdentity(input.sessionId) && typeof input.sessionToken === "string"
		&& input.sessionToken.length >= 32 && Number.isSafeInteger(input.expiresAt);
}
