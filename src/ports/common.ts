/** Shared port primitives. DESIGN §h. */

export type Unsubscribe = () => void;

/** Errors crossing a port carry a stable code; messages are for humans only. */
export interface PortError {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
}
