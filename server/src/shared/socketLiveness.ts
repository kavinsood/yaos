// DECISIONS-GAP: §2.3 keeps socketLiveness (260 lines) but deletes shared/semanticEpoch, which the semantic-socket
// half of this file imports. The server keeps only what the streams relay uses (the liveness descriptor sent in
// VAULT_READY and the VAULT_PING parser); the full module moved to legacy-src/shared/socketLiveness.ts.
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
