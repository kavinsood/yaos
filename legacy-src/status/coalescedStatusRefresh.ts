/**
 * Coalesces repeated status-refresh requests received in one event-loop turn.
 * It owns no status facts; callers still read current state at render time.
 */
export class CoalescedStatusRefresh {
	private timer: number | null = null;

	constructor(private readonly refresh: () => void) {}

	request(): void {
		if (this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.refresh();
		}, 0);
	}

	cancel(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}
}
