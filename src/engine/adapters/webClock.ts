/** ClockPort over Date.now / performance.now / setTimeout. */

import type { ClockPort, TimerHandle } from "../../ports/clock";

export function createWebClock(): ClockPort {
	const timers = new Map<TimerHandle, ReturnType<typeof setTimeout>>();
	let nextHandle = 1;
	const perf = typeof performance !== "undefined" && typeof performance.now === "function" ? performance : null;
	const origin = Date.now();
	let lastMonotonic = 0;
	const hasChannel = typeof MessageChannel !== "undefined";

	return {
		now: () => Date.now(),
		monotonic() {
			// performance.now never decreases; the Date fallback is clamped so it cannot either.
			const t = perf ? perf.now() : Date.now() - origin;
			lastMonotonic = Math.max(lastMonotonic, t);
			return lastMonotonic;
		},
		setTimer(delayMs, fn) {
			const handle = nextHandle++;
			const id = setTimeout(() => {
				timers.delete(handle);
				fn();
			}, Math.max(0, delayMs));
			timers.set(handle, id);
			return handle;
		},
		clearTimer(handle) {
			const id = timers.get(handle);
			if (id === undefined) return;
			clearTimeout(id);
			timers.delete(handle);
		},
		yieldNow() {
			// A MessageChannel message is a macrotask without setTimeout's nested 4 ms clamp. One
			// channel per yield, closed after use, so an idle port never keeps a Node process alive.
			return new Promise<void>((resolve) => {
				if (!hasChannel) {
					setTimeout(resolve, 0);
					return;
				}
				const channel = new MessageChannel();
				channel.port1.onmessage = () => {
					channel.port1.close();
					resolve();
				};
				channel.port2.postMessage(null);
			});
		},
	};
}
