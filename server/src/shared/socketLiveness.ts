export const SOCKET_LIVENESS_VERSION = 1;
export const SOCKET_LIVENESS_IDLE_MS = 60_000;
export const SOCKET_LIVENESS_TIMEOUT_MS = 15_000;

const MAX_PROBE_ID_LENGTH = 128;

export interface SocketLivenessDescriptor {
	version: typeof SOCKET_LIVENESS_VERSION;
	idleMs: number;
	timeoutMs: number;
}

export interface VaultPingFrame {
	type: "VAULT_PING";
	probeId: string;
}

export interface VaultPongFrame {
	type: "VAULT_PONG";
	probeId: string;
	documentId: string;
	vaultGeneration: string;
	runtimeEpoch: string;
}

export const SOCKET_LIVENESS_DESCRIPTOR: Readonly<SocketLivenessDescriptor> = Object.freeze({
	version: SOCKET_LIVENESS_VERSION,
	idleMs: SOCKET_LIVENESS_IDLE_MS,
	timeoutMs: SOCKET_LIVENESS_TIMEOUT_MS,
});

function isProbeId(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROBE_ID_LENGTH) return false;
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

export function parseVaultPingFrame(value: unknown): VaultPingFrame | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	return record.type === "VAULT_PING" && isProbeId(record.probeId)
		? { type: "VAULT_PING", probeId: record.probeId }
		: null;
}

export function parseSocketLivenessDescriptor(value: unknown): SocketLivenessDescriptor | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.version !== SOCKET_LIVENESS_VERSION
		|| !Number.isSafeInteger(record.idleMs)
		|| !Number.isSafeInteger(record.timeoutMs)
		|| record.idleMs !== SOCKET_LIVENESS_IDLE_MS
		|| record.timeoutMs !== SOCKET_LIVENESS_TIMEOUT_MS) return null;
	return {
		version: SOCKET_LIVENESS_VERSION,
		idleMs: SOCKET_LIVENESS_IDLE_MS,
		timeoutMs: SOCKET_LIVENESS_TIMEOUT_MS,
	};
}

export function parseVaultPongFrame(value: unknown): VaultPongFrame | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type !== "VAULT_PONG"
		|| !isProbeId(record.probeId)
		|| typeof record.documentId !== "string" || !record.documentId
		|| typeof record.vaultGeneration !== "string" || !record.vaultGeneration
		|| typeof record.runtimeEpoch !== "string" || !record.runtimeEpoch) return null;
	return {
		type: "VAULT_PONG",
		probeId: record.probeId,
		documentId: record.documentId,
		vaultGeneration: record.vaultGeneration,
		runtimeEpoch: record.runtimeEpoch,
	};
}
