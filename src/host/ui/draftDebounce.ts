/**
 * Debounce for settings text drafts (settingsTab.ts): `touch()` on every keystroke runs `flush` `delayMs` after the
 * last one, but never later than `maxWaitMs` after the first unsaved one, so a user who keeps typing still gets
 * saved. `flushNow()` (hide, background) runs it at once.
 */

export interface DraftTimers {
	set(ms: number, fn: () => void): number;
	clear(handle: number): void;
	now(): number;
}

export class DraftDebounce {
	private timer: number | null = null;
	/** When the oldest unsaved keystroke came (null = nothing pending). */
	private since: number | null = null;

	constructor(
		private readonly timers: DraftTimers,
		private readonly delayMs: number,
		private readonly maxWaitMs: number,
		private readonly flush: () => void,
	) {}

	get pending(): boolean {
		return this.since !== null;
	}

	touch(): void {
		const now = this.timers.now();
		this.since ??= now;
		if (this.timer !== null) this.timers.clear(this.timer);
		const ms = Math.max(0, Math.min(this.delayMs, this.since + this.maxWaitMs - now));
		this.timer = this.timers.set(ms, () => this.flushNow());
	}

	flushNow(): void {
		if (this.timer !== null) this.timers.clear(this.timer);
		this.timer = null;
		if (this.since === null) return;
		this.since = null;
		this.flush();
	}

	/** Drop the timer without flushing (dispose after a final flushNow). */
	cancel(): void {
		if (this.timer !== null) this.timers.clear(this.timer);
		this.timer = null;
		this.since = null;
	}
}
