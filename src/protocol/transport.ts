/**
 * Transport between host and engine. DESIGN §g.1, §g.5.
 *
 * Implementations (WP-D): WorkerTransport (postMessage + transfer lists),
 * InlineTransport (same-thread pair: structuredClone, delivery on a macrotask,
 * FIFO), used as the fallback when the worker cannot start and in Node.
 */

import type { Unsubscribe } from "../ports/common";
import type { EngineToMain, MainToEngine } from "./messages";

export interface Transport<Out, In> {
	readonly kind: "worker" | "inline";
	/** FIFO. `transfer` lists buffers the receiver takes ownership of. */
	post(message: Out, transfer?: readonly ArrayBuffer[]): void;
	onMessage(listener: (message: In) => void): Unsubscribe;
	/** Worker crashed / was terminated (worker transport only). */
	onFailure(listener: (reason: string) => void): Unsubscribe;
	close(): void;
}

export type HostTransport = Transport<MainToEngine, EngineToMain>;
export type EngineTransport = Transport<EngineToMain, MainToEngine>;

/** Liveness: host pings every PING_INTERVAL_MS; no pong within PING_TIMEOUT_MS => restart engine. */
export const PING_INTERVAL_MS = 10_000;
export const PING_TIMEOUT_MS = 15_000;
/** Max consecutive engine restarts before falling back to inline. */
export const MAX_WORKER_RESTARTS = 3;
/** Engine->main request timeouts (disk I/O can be slow on mobile). */
export const DISK_REQUEST_TIMEOUT_MS = 60_000;
export const SIDE_FILE_TIMEOUT_MS = 30_000;
