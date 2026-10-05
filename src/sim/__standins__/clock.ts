/**
 * STAND-IN virtual clock (WP-A owns src/sim/clock.ts). INTEGRATION: switch the
 * simulation to WP-A's clock if its API covers run/advance; otherwise keep
 * this one (it only implements the frozen ClockPort plus a run loop).
 *
 * Determinism: timers fire in (dueAt, insertion order). Between timers the
 * loop drains the real microtask queue with one real macrotask (setImmediate
 * or MessageChannel), so promise chains settle before virtual time moves.
 */

import type { ClockPort, TimerHandle } from "../../ports/clock";
import type { Schedule } from "../../protocol/inlineTransport";

interface Timer {
	readonly id: number;
	readonly at: number;
	readonly seq: number;
	readonly fn: () => void;
	readonly label: string;
}

type ImmediateFn = (fn: () => void) => void;

function realMacrotask(): () => Promise<void> {
	const g = globalThis as unknown as { setImmediate?: ImmediateFn };
	if (typeof g.setImmediate === "function") {
		const si = g.setImmediate;
		return () => new Promise<void>((resolve) => si(resolve));
	}
	return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export class VirtualClock implements ClockPort {
	private mono = 0;
	private wallBase: number;
	private wallSkew = 0;
	private seq = 0;
	private nextId = 1;
	private readonly timers = new Map<number, Timer>();
	private heap: Timer[] = [];
	private readonly settle = realMacrotask();
	/** Called on every timer throw; the sim records it as a failure. */
	onError: (error: unknown, label: string) => void = (error) => {
		throw error;
	};

	constructor(wallStartMs = Date.UTC(2026, 0, 1)) {
		this.wallBase = wallStartMs;
	}

	now(): number {
		return this.wallBase + this.mono + this.wallSkew;
	}

	monotonic(): number {
		return this.mono;
	}

	/** Wall clock jump (fault): monotonic is untouched. */
	skewWall(deltaMs: number): void {
		this.wallSkew += deltaMs;
	}

	setTimer(delayMs: number, fn: () => void, label = "timer"): TimerHandle {
		const id = this.nextId++;
		const t: Timer = { id, at: this.mono + Math.max(0, delayMs), seq: this.seq++, fn, label };
		this.timers.set(id, t);
		this.push(t);
		return id;
	}

	clearTimer(handle: TimerHandle): void {
		this.timers.delete(handle);
	}

	yieldNow(): Promise<void> {
		return new Promise<void>((resolve) => this.setTimer(0, resolve, "yield"));
	}

	/** Inline-transport delivery on virtual time (0 ms, FIFO). */
	readonly schedule: Schedule = (fn) => {
		this.setTimer(0, fn, "deliver");
	};

	pendingTimers(): number {
		return this.timers.size;
	}

	nextDueAt(): number | null {
		this.prune();
		const top = this.heap[0];
		return top ? top.at : null;
	}

	/** Let every promise chain settle (real macrotask). */
	async settleMicrotasks(): Promise<void> {
		await this.settle();
	}

	/**
	 * Fire the next timer (advancing virtual time to it). Returns false if none
	 * is due at or before `limit`.
	 */
	async step(limit = Number.POSITIVE_INFINITY): Promise<boolean> {
		await this.settle();
		this.prune();
		const top = this.heap[0];
		if (!top || top.at > limit) return false;
		this.pop();
		this.timers.delete(top.id);
		if (top.at > this.mono) this.mono = top.at;
		try {
			top.fn();
		} catch (error) {
			this.onError(error, top.label);
		}
		return true;
	}

	/** Run timers until virtual time passes `ms` from now (timers at exactly the end fire). */
	async advance(ms: number, maxSteps = 5_000_000): Promise<void> {
		const end = this.mono + ms;
		let steps = 0;
		while (await this.step(end)) {
			if (++steps > maxSteps) throw new Error(`VirtualClock.advance: more than ${maxSteps} steps`);
		}
		await this.settle();
		if (this.mono < end) this.mono = end;
	}

	/** Run until `done()` holds (checked after every step) or `horizonMs` of virtual time passes. */
	async runUntil(done: () => boolean, horizonMs: number, maxSteps = 5_000_000): Promise<boolean> {
		const end = this.mono + horizonMs;
		let steps = 0;
		for (;;) {
			await this.settle();
			if (done()) return true;
			if (!(await this.step(end))) {
				await this.settle();
				if (done()) return true;
				if (this.mono < end) this.mono = end;
				return done();
			}
			if (++steps > maxSteps) throw new Error(`VirtualClock.runUntil: more than ${maxSteps} steps`);
		}
	}

	// --- binary heap on (at, seq) -------------------------------------------

	private less(a: Timer, b: Timer): boolean {
		return a.at < b.at || (a.at === b.at && a.seq < b.seq);
	}

	private push(t: Timer): void {
		const h = this.heap;
		h.push(t);
		let i = h.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (!this.less(h[i] as Timer, h[p] as Timer)) break;
			[h[i], h[p]] = [h[p] as Timer, h[i] as Timer];
			i = p;
		}
	}

	private pop(): void {
		const h = this.heap;
		const last = h.pop();
		if (!last || h.length === 0) return;
		h[0] = last;
		let i = 0;
		for (;;) {
			const l = 2 * i + 1;
			const r = l + 1;
			let m = i;
			if (l < h.length && this.less(h[l] as Timer, h[m] as Timer)) m = l;
			if (r < h.length && this.less(h[r] as Timer, h[m] as Timer)) m = r;
			if (m === i) break;
			[h[i], h[m]] = [h[m] as Timer, h[i] as Timer];
			i = m;
		}
	}

	private prune(): void {
		while (this.heap.length > 0 && !this.timers.has((this.heap[0] as Timer).id)) this.pop();
	}
}
