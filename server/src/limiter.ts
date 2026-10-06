// In-memory fixed-window limiter: D3 (20 failed enrolls a minute per vault DO), the config DO's login-failure limiter
// (DECISIONS §2.1) and the blob GC request limit (relay-wire §11.3). The caller records what counts (a failure, a
// request). Memory only: a new runtime starts with a fresh window, as all three accept.
import type { ClockPort } from "./ports";

export class WindowLimiter {
	private windowStart = Number.NEGATIVE_INFINITY;
	private count = 0;

	constructor(private readonly limit: number, private readonly windowMs: number, private readonly clock: ClockPort) {}

	/** Milliseconds until the next attempt may run; 0 when it may run now. */
	retryAfterMs(): number {
		this.roll();
		return this.count >= this.limit ? Math.max(1, this.windowStart + this.windowMs - this.clock.now()) : 0;
	}

	/** Counts one event against the current window. */
	record(): void {
		this.roll();
		this.count++;
	}

	private roll(): void {
		const now = this.clock.now();
		if (now >= this.windowStart + this.windowMs) {
			this.windowStart = now;
			this.count = 0;
		}
	}
}

/** The 429 body every limiter answers, with `Retry-After` in whole seconds. */
export function tooManyAttempts(retryAfterMs: number): Response {
	return new Response(JSON.stringify({ error: "too_many_attempts" }), {
		status: 429,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			"Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
		},
	});
}
