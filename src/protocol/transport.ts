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

/** Liveness: host pings every PING_INTERVAL_MS; no pong within PING_TIMEOUT_MS => the engine is dead, the host stops. */
export const PING_INTERVAL_MS = 10_000;
export const PING_TIMEOUT_MS = 15_000;
