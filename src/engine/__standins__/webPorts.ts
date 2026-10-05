/**
 * STAND-IN engine-side runtime ports for the pre-integration worker/inline
 * engine: a setTimeout clock and a WebCrypto HashPort.
 * INTEGRATION: WP-C's engine/adapters (clock, hash) replace these.
 */

import type { ClockPort, TimerHandle } from "../../ports/clock";
import type { HashPort } from "../../ports/crypto";

export function webClock(): ClockPort {
	const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
	let lastMono = 0;
	const timers = new Map<TimerHandle, ReturnType<typeof setTimeout>>();
	let next = 1;
	return {
		now: () => Date.now(),
		monotonic: () => {
			const v = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
			lastMono = Math.max(lastMono, v);
			return lastMono;
		},
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
		yieldNow: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
	};
}

export function webHashPort(): HashPort {
	return {
		async sha256(bytes) {
			const copy = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
			return new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
		},
	};
}
