/**
 * Worker entry (DESIGN §g.1, §k.1). Bundled separately as an IIFE string and
 * exposed to the host as `virtual:yaos-engine-worker`; the host starts it from
 * a Blob URL. Runs the composed engine (log side + disk side) over the web
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

// Autostart only inside a dedicated worker (classic Blob-URL workers expose importScripts).
const g = globalThis as unknown as { importScripts?: unknown };
if (typeof g.importScripts === "function") startWorkerEngine(globalThis as unknown as WorkerScopeLike);
