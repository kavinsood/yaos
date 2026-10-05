/** ClockPort. DESIGN §h. Virtual in simulation. */

export type TimerHandle = number;

export interface ClockPort {
	/**
	 * Wall-clock ms since epoch. May skew or jump. Used ONLY for conflict-copy
	 * names, diagnostics, daily budgets and retention of local files — never for
	 * ordering or fold decisions.
	 */
	now(): number;
	/** Monotonic ms within this process; never decreases. Timers, backoff, racy-git windows. */
	monotonic(): number;
	setTimer(delayMs: number, fn: () => void): TimerHandle;
	clearTimer(handle: TimerHandle): void;
	/** Yield to the event loop (macrotask). Cooperative slicing in long jobs. */
	yieldNow(): Promise<void>;
}
