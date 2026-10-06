/**
 * Daily-limit popup (legacy sync/dailyLimit.ts). The relay refuses writes or
 * connects with `cf_daily_limit` once the Cloudflare free-tier rows limit is
 * hit; the engine holds sends until the reset and the host shows one popup
 * per reset window. The window ends at the relay's reset when it said when
 * (retryAfterMs), else at the next 00:00 UTC by this clock.
 */

const MINUTE_MS = 60_000;

export function nextUtcMidnight(nowMs: number): number {
	const d = new Date(nowMs);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** "HH:MM" UTC, rounded to the minute (retryAfterMs is measured a few ms before nowMs). */
function utcClock(atMs: number): string {
	const d = new Date(Math.round(atMs / MINUTE_MS) * MINUTE_MS);
	return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function dailyLimitMessage(resetAtMs: number | null): string {
	const until = resetAtMs === null ? "the daily reset (00:00 UTC)" : `${utcClock(resetAtMs)} UTC`;
	return `YAOS: Cloudflare's daily free limit was reached. Sync is paused until ${until}; local edits are kept and sync then. The $5/month Workers Paid plan removes this limit.`;
}

/** Notice-once gate: a popup on the first trip of a window, again only after the window passed. */
export class DailyLimitNoticeGate {
	private activeUntil = 0;

	/** Records a trip at wall time nowMs; returns the popup text when it opens a new window, else null. */
	trip(nowMs: number, retryAfterMs: number | null): string | null {
		const resetAt = retryAfterMs === null ? null : nowMs + retryAfterMs;
		const fresh = nowMs >= this.activeUntil;
		this.activeUntil = Math.max(this.activeUntil, resetAt ?? nextUtcMidnight(nowMs));
		return fresh ? dailyLimitMessage(resetAt) : null;
	}
}
