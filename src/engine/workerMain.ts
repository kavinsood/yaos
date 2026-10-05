/**
 * Worker entry (DESIGN §g.1, §k.1). Bundled separately as an IIFE string and
 * exposed to the host as `virtual:yaos-engine-worker`; the host starts it from
 * a Blob URL.
 *
 * STAND-IN: runs the protocol-complete stand-in engine (local only, no relay,
 * no IndexedDB store).
 * INTEGRATION: replace the body of startWorkerEngine with
 *   createEngine(transport, { carrier: "worker", makePorts })  (engine/runtime/engine.ts)
 * where makePorts builds the IndexedDB/WebSocket/WebCrypto adapters and an
 * IndexedDB open failure in init answers `storage-lost` (OR-1 -> inline).
 */

import { createWorkerEngineTransport, type WorkerScopeLike } from "../protocol/workerTransport";
import { createStandinEngine } from "./__standins__/engine";
import { webClock, webHashPort } from "./__standins__/webPorts";

export function startWorkerEngine(scope: WorkerScopeLike): { dispose(): void } {
	const transport = createWorkerEngineTransport(scope);
	const handle = createStandinEngine(transport, { carrier: "worker", clock: webClock(), hash: webHashPort(), hub: null, store: null });
	return { dispose: () => handle.dispose() };
}

// Autostart only inside a dedicated worker (classic Blob-URL workers expose importScripts).
const g = globalThis as unknown as { importScripts?: unknown };
if (typeof g.importScripts === "function") startWorkerEngine(globalThis as unknown as WorkerScopeLike);
