/**
 * PlatformPort + real ClockPort for the main thread (DESIGN §i.2, §i.4).
 * Lifecycle: document visibilitychange -> visible/hidden, window pagehide,
 * document freeze/resume (Page Lifecycle, Chromium/Android), window
 * online/offline. Structural targets so node tests can drive it.
 */

import type { Unsubscribe } from "../ports/common";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { LifecycleEvent, PlatformInfo, PlatformOs, PlatformPort } from "../ports/platform";

/** Subset of Obsidian's `Platform` flags. */
export interface ObsidianPlatformFlags {
	readonly isMobile: boolean;
	readonly isTablet?: boolean;
	readonly isIosApp?: boolean;
	readonly isAndroidApp?: boolean;
	readonly isMacOS?: boolean;
	readonly isWin?: boolean;
	readonly isLinux?: boolean;
}

export interface NavigatorLike {
	readonly hardwareConcurrency?: number;
	readonly deviceMemory?: number;
	readonly onLine?: boolean;
}

export interface EventTargetLike {
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

export interface DocumentLike extends EventTargetLike {
	readonly visibilityState: string;
}

export function platformInfoFrom(flags: ObsidianPlatformFlags, nav: NavigatorLike, workerCtorPresent: boolean): PlatformInfo {
	const os: PlatformOs = flags.isIosApp ? "ios" : flags.isAndroidApp ? "android" : flags.isMacOS ? "macos" : flags.isWin ? "windows" : flags.isLinux ? "linux" : "unknown";
	return {
		os,
		isMobile: flags.isMobile,
		isTablet: flags.isTablet ?? false,
		hardwareConcurrency: typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : 4,
		deviceMemoryGiB: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
		// Constructor presence only; EngineHost probes a real Blob-URL worker before trusting it.
		workerSupported: workerCtorPresent,
	};
}

export class BrowserPlatform implements PlatformPort {
	private readonly listeners = new Set<(e: LifecycleEvent) => void>();
	private readonly offs: (() => void)[] = [];

	constructor(
		readonly info: PlatformInfo,
		private readonly doc: DocumentLike,
		private readonly win: EventTargetLike,
		private readonly nav: NavigatorLike,
	) {}

	isVisible(): boolean {
		return this.doc.visibilityState !== "hidden";
	}

	isOnline(): boolean {
		return this.nav.onLine !== false;
	}

	private emit(e: LifecycleEvent): void {
		for (const l of [...this.listeners]) l(e);
	}

	private listen(target: EventTargetLike, type: string, fn: () => void): void {
		target.addEventListener(type, fn);
		this.offs.push(() => target.removeEventListener(type, fn));
	}

	onLifecycle(listener: (event: LifecycleEvent) => void): Unsubscribe {
		if (this.listeners.size === 0) this.attach();
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) this.detach();
		};
	}

	private attach(): void {
		this.listen(this.doc, "visibilitychange", () => this.emit(this.isVisible() ? "visible" : "hidden"));
		this.listen(this.win, "pagehide", () => this.emit("pagehide"));
		this.listen(this.doc, "freeze", () => this.emit("freeze"));
		this.listen(this.doc, "resume", () => this.emit("resume"));
		this.listen(this.win, "online", () => this.emit("online"));
		this.listen(this.win, "offline", () => this.emit("offline"));
	}

	private detach(): void {
		for (const off of this.offs.splice(0)) off();
	}
}

/** setTimeout-backed ClockPort (main thread). */
export function browserClock(): ClockPort {
	const perf = typeof performance !== "undefined" ? performance : null;
	const t0 = perf ? perf.now() : Date.now();
	let last = 0;
	const timers = new Map<TimerHandle, ReturnType<typeof setTimeout>>();
	let next = 1;
	return {
		now: () => Date.now(),
		monotonic: () => (last = Math.max(last, (perf ? perf.now() : Date.now()) - t0)),
		setTimer(delayMs, fn) {
			const id = next++;
			timers.set(id, setTimeout(() => {
				timers.delete(id);
				fn();
			}, Math.max(0, delayMs)));
			return id;
		},
		clearTimer(handle) {
			const t = timers.get(handle);
			if (t !== undefined) clearTimeout(t);
			timers.delete(handle);
		},
		yieldNow: () => new Promise<void>((r) => setTimeout(r, 0)),
	};
}
