/**
 * Worker entry (DESIGN §g.1, §k.1). The Blob-URL worker runs main.js itself
 * (host/bundleSource.ts); host/entry.ts calls startWorkerEngine with the
 * worker's scope. Runs the composed engine (log side + disk side) over the web
 * adapters; an IndexedDB open failure in init answers `storage-lost` and the
 * host falls back to the inline carrier (OR-1).
 */

import { createWorkerEngineTransport, type WorkerScopeLike } from "../protocol/workerTransport";
import { createWebEngine } from "./adapters/webEngine";

export function startWorkerEngine(scope: WorkerScopeLike): { dispose(): void } {
	const transport = createWorkerEngineTransport(scope);
	const handle = createWebEngine(transport, "worker");
	return { dispose: () => handle.dispose() };
}
