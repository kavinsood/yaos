import WebSocket from "ws";

const nativeFetch = globalThis.fetch.bind(globalThis);
const accessClientId = process.env.YAOS_CF_ACCESS_CLIENT_ID?.trim() ?? "";
const accessClientSecret = process.env.YAOS_CF_ACCESS_CLIENT_SECRET?.trim() ?? "";

if ((accessClientId === "") !== (accessClientSecret === "")) {
	throw new Error("YAOS_CF_ACCESS_CLIENT_ID and YAOS_CF_ACCESS_CLIENT_SECRET must be supplied together");
}

function cloudflareAccessHeaders(): Record<string, string> {
	return accessClientId ? {
		"CF-Access-Client-Id": accessClientId,
		"CF-Access-Client-Secret": accessClientSecret,
	} : {};
}

/** Install strong service-token authentication without weakening the Access app. */
export function installLiveAccessTransport(): void {
	if (!accessClientId || (globalThis.fetch as { __yaosAccessWrapped?: boolean }).__yaosAccessWrapped) return;
	const wrapped = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		new Headers(init.headers).forEach((value, key) => headers.set(key, value));
		for (const [key, value] of Object.entries(cloudflareAccessHeaders())) headers.set(key, value);
		return nativeFetch(input, { ...init, headers });
	};
	(wrapped as { __yaosAccessWrapped?: boolean }).__yaosAccessWrapped = true;
	globalThis.fetch = wrapped as typeof globalThis.fetch;
}

/** `ws` transport which authenticates the HTTP upgrade with the same service token. */
export class LiveWebSocket extends WebSocket {
	constructor(address: string | URL, protocols?: string | string[]) {
		super(address, protocols, { headers: cloudflareAccessHeaders() });
	}
}

installLiveAccessTransport();

export interface LiveIdentity {
	readonly host: string;
	readonly deviceToken: string;
	readonly vaultId: string;
	readonly deviceId: string;
}

export interface LiveIdentityContext {
	readonly deviceA: LiveIdentity;
	readonly deviceB: LiveIdentity;
	readonly operatorRecoveryKey: string;
	readonly operatorCookie: string;
	readonly settingsConfigKey: string;
}

export interface SocketTicket {
	readonly ticket: string;
	readonly expiresAt: number;
	readonly ttlMs: number;
}

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required for live Worker tests`);
	return value;
}

function identityFromEnv(suffix: "A" | "B"): LiveIdentity {
	return {
		host: requireEnv("YAOS_TEST_HOST").replace(/\/$/, ""),
		deviceToken: requireEnv(`YAOS_TEST_DEVICE_${suffix}_TOKEN`),
		vaultId: requireEnv("YAOS_TEST_VAULT_ID"),
		deviceId: requireEnv(`YAOS_TEST_DEVICE_${suffix}_ID`),
	};
}

/** Device A is the default identity for one-device route checks. */
export function requireLiveIdentity(): LiveIdentity {
	return identityFromEnv("A");
}

export function requireLiveIdentityContext(): LiveIdentityContext {
	return {
		deviceA: identityFromEnv("A"),
		deviceB: identityFromEnv("B"),
		operatorRecoveryKey: requireEnv("YAOS_TEST_OPERATOR_RECOVERY_KEY"),
		operatorCookie: requireEnv("YAOS_TEST_OPERATOR_COOKIE"),
		settingsConfigKey: requireEnv("YAOS_TEST_SETTINGS_CONFIG_KEY"),
	};
}

export function deviceBearerHeaders(
	identity: LiveIdentity,
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		Authorization: `Bearer ${identity.deviceToken}`,
		...extra,
	};
}

export async function fetchSocketTicket(
	identity: LiveIdentity,
	vaultId = identity.vaultId,
	purpose: "root" | "body" = "root",
	documentId = "root",
	documentEpoch = 1,
): Promise<SocketTicket> {
	const response = await fetch(
		`${identity.host}/vault/${encodeURIComponent(vaultId)}/auth/ticket`,
		{
			method: "POST",
			headers: deviceBearerHeaders(identity, { "Content-Type": "application/json" }),
			body: JSON.stringify(purpose === "root"
				? { purpose, documentId, rootEpoch: documentEpoch }
				: { purpose, documentId, bodyEpoch: documentEpoch }),
		},
	);
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`ticket fetch failed (${response.status})${body ? `: ${body}` : ""}`);
	}
	const payload = (await response.json()) as Partial<SocketTicket> | null;
	if (
		typeof payload?.ticket !== "string"
		|| typeof payload.expiresAt !== "number"
		|| typeof payload.ttlMs !== "number"
	) {
		throw new Error(`malformed ticket response: ${JSON.stringify(payload)}`);
	}
	return {
		ticket: payload.ticket,
		expiresAt: payload.expiresAt,
		ttlMs: payload.ttlMs,
	};
}
