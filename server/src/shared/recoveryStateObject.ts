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

/**
 * Upper bound on one stored state object's history (plus envelope framing below).
 *
 * b3-int: 32 MiB, above the 24 MiB per-pass byte budget (`STATE_PROJECTION_LIMITS.maxBytes`):
 * a body whose stored history exceeds what is left of a pass is deferred and then
 * projected alone at the start of a fresh pass (a solo pass). The bound is set by
 * the 128 MB Durable Object memory limit, since the vault DO builds the object in
 * memory: peak = history read from SQLite (N; a checkpoint's fragments are
 * concatenated, transiently 2x that checkpoint) + the encoded object (N + framing)
 * while encoding, then the history is released and only the object (plus any
 * runtime copy made by the R2 put) is live during the put. At N = 32 MiB that is
 * about 64-66 MiB, leaving at least ~60 MB for the isolate baseline (wasm CRDT
 * engine, document cache). Above the bound the body is not projected and capture
 * records `missing_history`, as before. Streaming the put from the SQLite chunks
 * was not adopted: the object store port takes bytes, and the DO's input gate
 * opens during the R2 request, so a checkpoint/compaction could rewrite the rows
 * mid-stream under a content-addressed key.
 */
export const MAX_RECOVERY_STATE_HISTORY_BYTES = 32 * 1024 * 1024;
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
