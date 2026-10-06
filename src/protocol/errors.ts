/** Protocol error codes. DESIGN §g.4. */

export type ProtocolErrorCode =
	| "bad-request"
	| "version-mismatch"
	| "not-ready"
	| "unknown-doc"
	| "not-bindable"
	| "storage-lost"
	| "storage-quota"
	| "vault-io"
	| "relay-unavailable"
	| "epoch-changed"
	| "superseded"
	| "revoked"
	| "aborted"
	| "timeout"
	/** A snapshot failed restore verification (DESIGN §j.4); the message names the snapshot and the failed check. */
	| "content_corrupt"
	| "internal";

export interface ProtocolError {
	readonly code: ProtocolErrorCode;
	/** Human text. Must never contain credentials or file contents. */
	readonly message: string;
	readonly retryable: boolean;
}

/** Codes after which the host must not retry automatically. */
export const TERMINAL_ERROR_CODES: readonly ProtocolErrorCode[] = ["version-mismatch", "revoked"];

/**
 * Thrown on the engine side to answer a request with this exact error (code and message) instead of the
 * generic `internal` one.
 */
export class ProtocolFailure extends Error {
	constructor(readonly error: ProtocolError) {
		super(error.message);
		this.name = "ProtocolFailure";
	}
}

export function badRequest(message: string): ProtocolFailure {
	return new ProtocolFailure({ code: "bad-request", message, retryable: false });
}
