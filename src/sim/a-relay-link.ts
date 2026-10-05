/**
 * FIFO timed queue: one socket direction of a simulated link. Items are
 * delivered at max(previous due, now + delay) + serialization time, so a
 * per-message jitter never reorders. One timer per queue.
 */

import type { ClockPort, TimerHandle } from "../ports/clock";

export class TimedQueue<T> {
	private items: { readonly at: number; readonly value: T }[] = [];
	private head = 0;
	private timer: TimerHandle | null = null;
	private lastAt = Number.NEGATIVE_INFINITY;
	private generation = 0;

	constructor(private readonly clock: ClockPort, private readonly deliver: (value: T) => void) {}

	get size(): number {
		return this.items.length - this.head;
	}

	/** A delivery timer is armed. */
	get busy(): boolean {
		return this.timer !== null;
	}

	push(delayMs: number, value: T, serializeMs = 0): void {
		const at = Math.max(this.lastAt, this.clock.monotonic() + Math.max(0, delayMs)) + Math.max(0, serializeMs);
		this.lastAt = at;
		this.items.push({ at, value });
		this.arm();
	}

	/** Drops everything not yet delivered; returns it (oldest first). */
	clear(): T[] {
		const dropped = this.items.slice(this.head).map((item) => item.value);
		this.items = [];
		this.head = 0;
		this.generation++;
		if (this.timer !== null) this.clock.clearTimer(this.timer);
		this.timer = null;
		return dropped;
	}

	private arm(): void {
		if (this.timer !== null || this.head >= this.items.length) return;
		const next = this.items[this.head]!;
		this.timer = this.clock.setTimer(Math.max(0, next.at - this.clock.monotonic()), () => this.fire());
	}

	private fire(): void {
		this.timer = null;
		const generation = this.generation;
		const now = this.clock.monotonic();
		while (this.head < this.items.length) {
			const item = this.items[this.head]!;
			if (item.at > now) break;
			this.head++;
			this.deliver(item.value);
			if (generation !== this.generation) return; // cleared (and maybe refilled) during delivery
		}
		if (this.head > 64 && this.head * 2 > this.items.length) {
			this.items = this.items.slice(this.head);
			this.head = 0;
		}
		this.arm();
	}
}
