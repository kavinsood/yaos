/**
 * Transport between host and engine. DESIGN §g.1, §g.5.
 *
 * Implementations (WP-D): WorkerTransport (postMessage + transfer lists), the
 * plugin's only carrier; InlineTransport (same-thread pair: structuredClone,
 * delivery on a macrotask, FIFO), for tests, the simulation and harnesses.
 */

import type { Unsubscribe } from "../ports/common";
import type { EngineToMain, MainToEngine } from "./messages";

export interface Transport<Out, In> {
	readonly kind: "worker" | "inline";
	/** FIFO. `transfer` lists buffers the receiver takes ownership of. */
	post(message: Out, transfer?: readonly ArrayBuffer[]): void;
	onMessage(listener: (message: In) => void): Unsubscribe;
	/** Worker crashed / was terminated; on the in-process pair, its kill() test hook (inlineTransport.ts). */
	onFailure(listener: (reason: string) => void): Unsubscribe;
	close(): void;
}

export type HostTransport = Transport<MainToEngine, EngineToMain>;
export type EngineTransport = Transport<EngineToMain, MainToEngine>;

/**
 * Liveness: host pings after PING_INTERVAL_MS without a message from the engine (up to PING_IDLE_MAX_MS while
 * idle); a ping with no pong within PING_TIMEOUT_MS is retried at once, and PING_MISSES_FATAL misses in a row =>
 * the engine is dead, the host stops (engineHost.ts).
 */
export const PING_INTERVAL_MS = 10_000;
export const PING_TIMEOUT_MS = 15_000;
export const PING_MISSES_FATAL = 2;
/**
 * Idle liveness: each answered ping with no other traffic in between doubles the interval up to this; any message
 * from the engine counts as a pong, and anything main sends it returns to PING_INTERVAL_MS (engineHost.ts). A hung
 * engine is found within PING_IDLE_MAX_MS + PING_MISSES_FATAL * PING_TIMEOUT_MS while idle, and within
 * PING_INTERVAL_MS + PING_MISSES_FATAL * PING_TIMEOUT_MS once main uses it.
 */
export const PING_IDLE_MAX_MS = 60_000;
