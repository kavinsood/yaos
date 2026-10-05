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
	| "internal";

export interface ProtocolError {
	readonly code: ProtocolErrorCode;
	/** Human text. Must never contain credentials or file contents. */
	readonly message: string;
	readonly retryable: boolean;
}

/** Codes after which the host must not retry automatically. */
export const TERMINAL_ERROR_CODES: readonly ProtocolErrorCode[] = ["version-mismatch", "revoked"];
