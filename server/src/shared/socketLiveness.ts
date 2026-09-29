export const SOCKET_LIVENESS_VERSION = 1;
export const SOCKET_LIVENESS_IDLE_MS = 60_000;
export const SOCKET_LIVENESS_TIMEOUT_MS = 15_000;
export const SOCKET_CLIENT_CAPABILITY_AUTO_RESPONSE = "livenessAutoResponse";
export const SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST = '__YPS:{"type":"VAULT_PING_AR","v":1}';
export const SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE = '__YPS:{"type":"VAULT_PONG_AR","v":1}';
export const SOCKET_LIVENESS_AUTO_RESPONSE = Object.freeze({
	version: 1 as const,
	request: SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST,
	response: SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE,
});

const MAX_PROBE_ID_LENGTH = 128;

export interface SocketLivenessDescriptor {
	version: typeof SOCKET_LIVENESS_VERSION;
	idleMs: number;
	timeoutMs: number;
	autoResponse?: typeof SOCKET_LIVENESS_AUTO_RESPONSE;
}

export interface VaultPingFrame {
	type: "VAULT_PING";
	probeId: string;
}

export const SOCKET_CURRENTNESS_VERSION = 2;
export const MAX_SOCKET_CURRENTNESS_BODIES = 100;

export interface SocketControlCapabilities {
	readonly currentnessQuery: typeof SOCKET_CURRENTNESS_VERSION;
	readonly committedHead: typeof SOCKET_CURRENTNESS_VERSION;
}

export const SOCKET_CONTROL_CAPABILITIES: Readonly<SocketControlCapabilities> = Object.freeze({
	currentnessQuery: SOCKET_CURRENTNESS_VERSION,
	committedHead: SOCKET_CURRENTNESS_VERSION,
});

/**
 * Client socket capabilities are advertised in the WebSocket upgrade query as
 * a comma-separated `caps` parameter and recorded in the socket attachment.
 * They are additive: a client that advertises nothing gets the behaviour of
 * the pinned protocol version, so old clients stay compatible.
 */
export const SOCKET_CLIENT_CAPABILITIES_PARAM = "caps";
/**
 * The client understands {@link BodyChangedHintFrame}. A socket that outlived
 * the runtime that admitted it (hibernation wake) then receives that hint
 * instead of being closed when a body commits.
 */
export const SOCKET_CLIENT_CAPABILITY_CATCH_UP_HINT = "catchupHint";
const MAX_SOCKET_CLIENT_CAPABILITIES = 16;

/**
 * Runtime-independent "a body changed" notice. It carries durable catalog
 * coordinates only and deliberately no runtime epoch, content hash or size:
 * it is never a receipt for frames the socket sent, nor proof that a local
 * document matches a durable generation. Clients may only use it as a reason
 * to schedule catch-up or a currentness query for that body.
 */
export interface BodyChangedHintFrame {
	type: "BODY_CHANGED_HINT";
	bodyId: string;
	bodyEpoch: SemanticEpoch;
	vaultGeneration: string;
	durableGeneration: number;
	vaultSequence: number;
}

export function parseSocketClientCapabilities(raw: string | null | undefined): ReadonlySet<string> {
	const capabilities = new Set<string>();
	if (!raw || raw.length > 512) return capabilities;
	for (const entry of raw.split(",").slice(0, MAX_SOCKET_CLIENT_CAPABILITIES)) {
		const capability = entry.trim();
		if (/^[A-Za-z0-9_-]{1,64}$/.test(capability)) capabilities.add(capability);
	}
	return capabilities;
}

export function parseBodyChangedHintFrame(value: unknown): BodyChangedHintFrame | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type !== "BODY_CHANGED_HINT"
		|| typeof record.bodyId !== "string" || !record.bodyId || record.bodyId.length > 256
		|| !/^[A-Za-z0-9_-]+$/.test(record.bodyId)
		|| !Number.isSafeInteger(record.bodyEpoch) || (record.bodyEpoch as number) < 1
		|| typeof record.vaultGeneration !== "string" || !record.vaultGeneration
		|| !Number.isSafeInteger(record.durableGeneration) || (record.durableGeneration as number) < 0
		|| !Number.isSafeInteger(record.vaultSequence) || (record.vaultSequence as number) < 0) return null;
	return {
		type: "BODY_CHANGED_HINT",
		bodyId: record.bodyId,
		bodyEpoch: parseSemanticEpoch(record.bodyEpoch, "body changed hint epoch"),
		vaultGeneration: record.vaultGeneration,
		durableGeneration: record.durableGeneration as number,
		vaultSequence: record.vaultSequence as number,
	};
}

export interface BodyCurrentnessQueryFrame {
	type: "BODY_CURRENTNESS_QUERY";
	queryId: string;
	bodyIds: string[];
}

export interface BodyCurrentnessHead {
	bodyId: string;
	bodyEpoch: SemanticEpoch;
	lifecycle: "active" | "tombstoned" | "reaped";
	generation: number;
	contentHash: string | null;
	size: number | null;
}

export interface BodyCurrentnessResultFrame {
	type: "BODY_CURRENTNESS_RESULT";
	queryId: string;
	socketSessionId: string;
	vaultSequence: number;
	heads: BodyCurrentnessHead[];
	missingBodyIds: string[];
}

export interface VaultPongFrame {
	type: "VAULT_PONG";
	probeId: string;
	documentId: string;
	documentEpoch: SemanticEpoch;
	vaultGeneration: string;
	runtimeEpoch: string;
}

export const SOCKET_LIVENESS_DESCRIPTOR: Readonly<SocketLivenessDescriptor> = Object.freeze({
	version: SOCKET_LIVENESS_VERSION,
	idleMs: SOCKET_LIVENESS_IDLE_MS,
	timeoutMs: SOCKET_LIVENESS_TIMEOUT_MS,
});

export const SOCKET_LIVENESS_AUTO_RESPONSE_DESCRIPTOR: Readonly<SocketLivenessDescriptor> = Object.freeze({
	...SOCKET_LIVENESS_DESCRIPTOR,
	autoResponse: SOCKET_LIVENESS_AUTO_RESPONSE,
});

export function negotiateSocketLiveness(
	capabilities: ReadonlySet<string> | undefined,
	hostSupportsAutoResponse: boolean,
): Readonly<SocketLivenessDescriptor> {
	return hostSupportsAutoResponse && capabilities?.has(SOCKET_CLIENT_CAPABILITY_AUTO_RESPONSE)
		? SOCKET_LIVENESS_AUTO_RESPONSE_DESCRIPTOR : SOCKET_LIVENESS_DESCRIPTOR;
}

function isProbeId(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROBE_ID_LENGTH) return false;
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

export function parseSocketSessionId(value: unknown): string | null {
	return isProbeId(value) ? value : null;
}

export function parseVaultPingFrame(value: unknown): VaultPingFrame | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	return record.type === "VAULT_PING" && isProbeId(record.probeId)
		? { type: "VAULT_PING", probeId: record.probeId }
		: null;
}

export function parseBodyCurrentnessQueryFrame(value: unknown): BodyCurrentnessQueryFrame | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type !== "BODY_CURRENTNESS_QUERY" || !isProbeId(record.queryId)
		|| !Array.isArray(record.bodyIds) || record.bodyIds.length < 1
		|| record.bodyIds.length > MAX_SOCKET_CURRENTNESS_BODIES) return null;
	const bodyIds: string[] = [];
	for (const bodyId of record.bodyIds) {
		if (typeof bodyId !== "string" || !bodyId || bodyId.length > 256
			|| !/^[A-Za-z0-9_-]+$/.test(bodyId)) return null;
		bodyIds.push(bodyId);
	}
	if (new Set(bodyIds).size !== bodyIds.length) return null;
	return { type: "BODY_CURRENTNESS_QUERY", queryId: record.queryId, bodyIds };
}

export function parseSocketControlCapabilities(value: unknown): SocketControlCapabilities | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	return record.currentnessQuery === SOCKET_CURRENTNESS_VERSION
		&& record.committedHead === SOCKET_CURRENTNESS_VERSION
		? SOCKET_CONTROL_CAPABILITIES
		: null;
}

function parseCurrentnessHead(value: unknown): BodyCurrentnessHead | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.bodyId !== "string" || !record.bodyId
		|| (record.lifecycle !== "active" && record.lifecycle !== "tombstoned" && record.lifecycle !== "reaped")
		|| !Number.isSafeInteger(record.generation) || (record.generation as number) < 0
		|| !Number.isSafeInteger(record.bodyEpoch) || (record.bodyEpoch as number) < 1
		|| (record.contentHash !== null && (typeof record.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(record.contentHash)))
		|| (record.size !== null && (!Number.isSafeInteger(record.size) || (record.size as number) < 0))) return null;
	return {
		bodyId: record.bodyId,
		bodyEpoch: parseSemanticEpoch(record.bodyEpoch, "currentness body epoch"),
		lifecycle: record.lifecycle,
		generation: record.generation as number,
		contentHash: record.contentHash,
		size: record.size as number | null,
	};
}

export function parseBodyCurrentnessResultFrame(value: unknown): BodyCurrentnessResultFrame | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type !== "BODY_CURRENTNESS_RESULT" || !isProbeId(record.queryId)
		|| !isProbeId(record.socketSessionId)
		|| !Number.isSafeInteger(record.vaultSequence) || (record.vaultSequence as number) < 0
		|| !Array.isArray(record.heads) || !Array.isArray(record.missingBodyIds)) return null;
	const heads: BodyCurrentnessHead[] = [];
	const identities = new Set<string>();
	for (const value of record.heads) {
		const head = parseCurrentnessHead(value);
		if (!head || identities.has(head.bodyId)) return null;
		identities.add(head.bodyId);
		heads.push(head);
	}
	const missingBodyIds: string[] = [];
	for (const bodyId of record.missingBodyIds) {
		if (typeof bodyId !== "string" || !bodyId || identities.has(bodyId)) return null;
		identities.add(bodyId);
		missingBodyIds.push(bodyId);
	}
	return {
		type: "BODY_CURRENTNESS_RESULT",
		queryId: record.queryId,
		socketSessionId: record.socketSessionId,
		vaultSequence: record.vaultSequence as number,
		heads,
		missingBodyIds,
	};
}

export function parseSocketLivenessDescriptor(value: unknown): SocketLivenessDescriptor | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.version !== SOCKET_LIVENESS_VERSION
		|| !Number.isSafeInteger(record.idleMs)
		|| !Number.isSafeInteger(record.timeoutMs)
		|| record.idleMs !== SOCKET_LIVENESS_IDLE_MS
		|| record.timeoutMs !== SOCKET_LIVENESS_TIMEOUT_MS) return null;
	const autoResponse = record.autoResponse;
	const supported = autoResponse && typeof autoResponse === "object" && !Array.isArray(autoResponse)
		&& "version" in autoResponse && autoResponse.version === SOCKET_LIVENESS_AUTO_RESPONSE.version
		&& "request" in autoResponse && autoResponse.request === SOCKET_LIVENESS_AUTO_RESPONSE_REQUEST
		&& "response" in autoResponse && autoResponse.response === SOCKET_LIVENESS_AUTO_RESPONSE_RESPONSE;
	return {
		version: SOCKET_LIVENESS_VERSION,
		idleMs: SOCKET_LIVENESS_IDLE_MS,
		timeoutMs: SOCKET_LIVENESS_TIMEOUT_MS,
		...(supported ? { autoResponse: SOCKET_LIVENESS_AUTO_RESPONSE } : {}),
	};
}

export function parseVaultPongFrame(value: unknown): VaultPongFrame | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type !== "VAULT_PONG"
		|| !isProbeId(record.probeId)
		|| typeof record.documentId !== "string" || !record.documentId
		|| !Number.isSafeInteger(record.documentEpoch) || (record.documentEpoch as number) < 1
		|| typeof record.vaultGeneration !== "string" || !record.vaultGeneration
		|| typeof record.runtimeEpoch !== "string" || !record.runtimeEpoch) return null;
	return {
		type: "VAULT_PONG",
		probeId: record.probeId,
		documentId: record.documentId,
		documentEpoch: parseSemanticEpoch(record.documentEpoch, "pong document epoch"),
		vaultGeneration: record.vaultGeneration,
		runtimeEpoch: record.runtimeEpoch,
	};
}
import { parseSemanticEpoch, type SemanticEpoch } from "./semanticEpoch";
