/**
 * What the engine's scope exposes, for the device check (compose/deviceCheck.ts): in the plugin, the Blob-URL
 * worker's WorkerNavigator and Performance, and whether the web APIs the engine's adapters use exist there. Read
 * each time the check runs; nothing is kept.
 */

import type { DeviceEnv } from "../../protocol/status";

interface NavigatorFacts {
	readonly userAgent?: unknown;
	readonly hardwareConcurrency?: unknown;
	readonly deviceMemory?: unknown;
}

interface PerformanceMemory {
	readonly usedJSHeapSize?: unknown;
	readonly totalJSHeapSize?: unknown;
	readonly jsHeapSizeLimit?: unknown;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export function webDeviceEnv(): DeviceEnv {
	const nav: NavigatorFacts | undefined = typeof navigator === "undefined" ? undefined : (navigator as NavigatorFacts);
	const mem = typeof performance === "undefined" ? undefined : (performance as { memory?: PerformanceMemory }).memory;
	const used = num(mem?.usedJSHeapSize);
	const total = num(mem?.totalJSHeapSize);
	const limit = num(mem?.jsHeapSizeLimit);
	const xhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
	return {
		userAgent: typeof nav?.userAgent === "string" ? nav.userAgent : null,
		hardwareConcurrency: num(nav?.hardwareConcurrency),
		deviceMemoryGiB: num(nav?.deviceMemory),
		jsHeap: used !== null && total !== null && limit !== null ? { usedBytes: used, totalBytes: total, limitBytes: limit } : null,
		apis: {
			xmlHttpRequest: typeof xhr === "function",
			webSocket: typeof WebSocket === "function",
			idb: typeof indexedDB === "object" && indexedDB !== null,
			subtleCrypto: typeof crypto === "object" && typeof crypto.subtle === "object" && crypto.subtle !== null,
		},
	};
}
