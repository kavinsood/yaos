export interface LiveIdentity {
	readonly host: string;
	readonly deviceToken: string;
	readonly vaultId: string;
	readonly deviceId: string;
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

export function requireLiveIdentity(): LiveIdentity {
	return {
		host: requireEnv("YAOS_TEST_HOST").replace(/\/$/, ""),
		deviceToken: requireEnv("YAOS_TEST_DEVICE_TOKEN"),
		vaultId: requireEnv("YAOS_TEST_VAULT_ID"),
		deviceId: requireEnv("YAOS_TEST_DEVICE_ID"),
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
): Promise<SocketTicket> {
	const response = await fetch(
		`${identity.host}/vault/${encodeURIComponent(vaultId)}/auth/ticket`,
		{ method: "POST", headers: deviceBearerHeaders(identity) },
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
