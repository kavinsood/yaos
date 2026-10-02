import { decodeBinaryEnvelope, encodeBinaryEnvelope } from "./binaryEnvelope";

/**
 * Recovery state object (snapshot format 4, b3 P2).
 *
 * The vault writes a body's stored CRDT bytes to R2 exactly as it holds them
 * (checkpoint fragments concatenated per checkpoint, journal rows, relay-tail
 * records) and never decodes them; the client applies `updates` to an empty
 * document and derives the plaintext (Markdown `body` text, or canonical Canvas
 * JSON), then verifies `size` and `contentHash`. Yjs updates commute, so update
 * order does not change the decoded state.
 */
export const RECOVERY_STATE_FORMAT = "yaos-recovery-state";
export const RECOVERY_STATE_VERSION = 1;
export const RECOVERY_STATE_CONTENT_TYPE = "application/vnd.yaos.recovery-state";

/** Upper bound on one stored state object (24 MiB of history plus envelope framing). */
export const MAX_RECOVERY_STATE_HISTORY_BYTES = 24 * 1024 * 1024;
export const MAX_RECOVERY_STATE_OBJECT_BYTES = MAX_RECOVERY_STATE_HISTORY_BYTES + 1024 * 1024;

export type RecoveryStateKind = "markdown" | "canvas";

export interface RecoveryStateObject {
	kind: RecoveryStateKind;
	contentHash: string;
	size: number;
	updates: Uint8Array[];
}

const HASH = /^[a-f0-9]{64}$/;

export function encodeRecoveryStateObject(value: RecoveryStateObject, maximumBytes = Number.MAX_SAFE_INTEGER): Uint8Array {
	if (!HASH.test(value.contentHash) || !Number.isSafeInteger(value.size) || value.size < 0) {
		throw new Error("invalid recovery state object");
	}
	return encodeBinaryEnvelope({
		format: RECOVERY_STATE_FORMAT,
		version: RECOVERY_STATE_VERSION,
		kind: value.kind,
		contentHash: value.contentHash,
		size: value.size,
		updates: value.updates,
	}, maximumBytes);
}

export function parseRecoveryStateObject(bytes: Uint8Array, maximumBytes = Number.MAX_SAFE_INTEGER): RecoveryStateObject {
	const value = decodeBinaryEnvelope(bytes, maximumBytes) as Record<string, unknown> | null;
	if (!value || typeof value !== "object" || value.format !== RECOVERY_STATE_FORMAT || value.version !== RECOVERY_STATE_VERSION
		|| (value.kind !== "markdown" && value.kind !== "canvas")
		|| typeof value.contentHash !== "string" || !HASH.test(value.contentHash)
		|| typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0
		|| !Array.isArray(value.updates)
		|| !value.updates.every((update) => update instanceof Uint8Array)) {
		throw new Error("invalid recovery state object");
	}
	return { kind: value.kind, contentHash: value.contentHash, size: value.size, updates: value.updates as Uint8Array[] };
}
