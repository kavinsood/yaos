// YAOS spike: worker entry. Bundled by scripts/build-spike.mjs (pass 1) as an
// IIFE string and started from a Blob URL by main.ts. Reads the worker's
// globals defensively and hands them to the testable handler.
import { installSpikeWorker, type SpikeScopeLike } from "./spikeWorkerHandler";

function readIndexedDB(): IDBFactory | undefined {
	// typeof never throws; the property read itself may (SecurityError in opaque origins).
	return typeof indexedDB === "undefined" ? undefined : indexedDB;
}

function tryGet<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

const g: typeof globalThis & SpikeScopeLike = globalThis as typeof globalThis & SpikeScopeLike;
const nav = tryGet(() => (typeof navigator === "undefined" ? undefined : navigator));

installSpikeWorker(
	{
		postMessage: (m, t) => g.postMessage(m, t),
		addEventListener: (type, l) => g.addEventListener(type, l),
	},
	{
		getIndexedDB: readIndexedDB,
		subtle: tryGet(() => (typeof crypto !== "undefined" && crypto.subtle ? crypto.subtle : undefined)),
		typeofWebSocket: typeof WebSocket,
		typeofStructuredClone: typeof structuredClone,
		typeofFetch: typeof fetch,
		storage: tryGet(() => (nav && nav.storage ? nav.storage : undefined)),
		userAgent: tryGet(() => nav?.userAgent),
		hardwareConcurrency: tryGet(() => nav?.hardwareConcurrency),
		location: tryGet(() => (typeof location === "undefined" ? undefined : String(location.href).slice(0, 120))),
	},
);
