/** PlatformPort: device facts and lifecycle. DESIGN §i.4. */

import type { Unsubscribe } from "./common";

export type PlatformOs = "ios" | "android" | "macos" | "windows" | "linux" | "unknown";

export interface PlatformInfo {
	readonly os: PlatformOs;
	readonly isMobile: boolean;
	readonly isTablet: boolean;
	readonly hardwareConcurrency: number;
	/** navigator.deviceMemory when exposed, else null. */
	readonly deviceMemoryGiB: number | null;
	/** Blob-URL dedicated workers construct and run (probed, not assumed). */
	readonly workerSupported: boolean;
}

export type LifecycleEvent =
	| "visible"
	| "hidden"
	| "pagehide"
	| "freeze"
	| "resume"
	| "online"
	| "offline"
	| "memory-pressure";

export interface PlatformPort {
	readonly info: PlatformInfo;
	isVisible(): boolean;
	isOnline(): boolean;
	onLifecycle(listener: (event: LifecycleEvent) => void): Unsubscribe;
}
