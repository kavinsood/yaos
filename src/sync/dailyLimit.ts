/**
 * Client side of the Cloudflare free-tier daily-limit UX (write-budget spike, D8).
 *
 * The server answers with a typed signal once a Durable Object write fails on
 * the free-tier rows limit (server/src/dailyLimit.ts):
 * - HTTP: 503 `{ error: "cf_daily_limit", kind, resetAt, message }` + Retry-After
 * - socket: `VAULT_ERROR` frame with `code: "cf_daily_limit"` and `resetAt`
 *
 * The client turns either into one notice per reset window, a status-bar
 * state, and a long back-off (no retry loop against a server that cannot
 * write until 00:00 UTC; probes back off 2 min doubling to hourly, and the
 * first successful write clears the state at once). There is no queue or next-day scheduler: local
 * edits stay in the local CRDT and sync normally when the limit resets.
 */
import type { HttpRequester } from "../utils/http";

export const DAILY_LIMIT_ERROR_CODE = "cf_daily_limit";

export const DAILY_LIMIT_NOTICE =
	"Cloudflare's daily free limit was reached. Sync resumes at 00:00 UTC. The $5/month Workers Paid plan removes this limit.";

export const DAILY_LIMIT_STATUS_LABEL = "Daily free limit reached";

/**
 * Longest single back-off before one probe. The limit is account-wide and
 * resets at 00:00 UTC, but an operator may upgrade to Workers Paid mid-day;
 * an hourly probe costs at most a handful of rows read.
 */
export const DAILY_LIMIT_MAX_BACKOFF_MS = 60 * 60 * 1000;

export interface DailyLimitInfo {
	/** Unix ms of the next 00:00 UTC (server-provided, else computed locally). */
	resetAt: number;
	kind: string;
}

export function nextUtcMidnight(now: number): number {
	const date = new Date(now);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function sanitizeResetAt(value: unknown, now: number): number {
	// Accept the server's value only when it is within the next ~25 hours;
	// a skewed or hostile value must not park the client for days.
	if (typeof value === "number" && Number.isFinite(value) && value > now && value <= now + 25 * 3_600_000) {
		return value;
	}
	return nextUtcMidnight(now);
}

/** Parses a typed daily-limit body or control frame; null when it is not one. */
export function parseDailyLimitSignal(value: unknown, now: number): DailyLimitInfo | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (record.error !== DAILY_LIMIT_ERROR_CODE && record.code !== DAILY_LIMIT_ERROR_CODE) return null;
	return {
		resetAt: sanitizeResetAt(record.resetAt, now),
		kind: typeof record.kind === "string" ? record.kind : "rows-written",
	};
}

/**
 * First probe after a trip (b3-clientblob A4). The probe interval doubles per
 * consecutive limited probe up to {@link DAILY_LIMIT_MAX_BACKOFF_MS}: 2, 4, 8,
 * 16, 32, then 60 min. A limit lifted mid-day (Workers Paid, or a reset this
 * clock did not expect) is noticed within one interval instead of up to an
 * hour later; while still limited it costs five extra probes before the
 * hourly cadence, each a rejected request (rows read, no rows written).
 */
export const DAILY_LIMIT_FIRST_PROBE_MS = 2 * 60 * 1000;

/** Probe interval after `probeIndex` consecutive limited probes (0 = first trip). */
export function dailyLimitProbeIntervalMs(probeIndex: number, firstProbeMs = DAILY_LIMIT_FIRST_PROBE_MS): number {
	const exponent = Math.min(Math.max(0, Math.floor(probeIndex)), 20);
	return Math.min(DAILY_LIMIT_MAX_BACKOFF_MS, firstProbeMs * 2 ** exponent);
}

/**
 * Back-off target for one trip: the reset or the next probe, whichever is
 * first. Without `probeIndex` the probe is the hourly one.
 */
export function dailyLimitBackoffUntil(
	info: DailyLimitInfo,
	now: number,
	probeIndex?: number,
	firstProbeMs = DAILY_LIMIT_FIRST_PROBE_MS,
): number {
	const interval = probeIndex === undefined ? DAILY_LIMIT_MAX_BACKOFF_MS : dailyLimitProbeIntervalMs(probeIndex, firstProbeMs);
	return Math.min(info.resetAt, now + interval);
}

/**
 * Wraps an HTTP requester so every typed 503/429 daily-limit answer is
 * reported. The response is returned unchanged; callers keep their own
 * status handling (they throw on non-2xx, which feeds normal retry, now
 * bounded by the back-off the trip installs).
 */
export function detectDailyLimitResponses(
	request: HttpRequester,
	onDailyLimit: (info: DailyLimitInfo) => void,
	now: () => number,
): HttpRequester {
	return async (input) => {
		const response = await request(input);
		if (response.status === 503 || response.status === 429) {
			let body: unknown = null;
			try {
				body = response.json;
			} catch {
				body = null;
			}
			const info = parseDailyLimitSignal(body, now());
			if (info) onDailyLimit(info);
		}
		return response;
	};
}

/**
 * Notice-once gate: the notice fires on the first trip of a reset window and
 * again only after that window has passed and the limit is hit anew.
 */
export class DailyLimitNoticeGate {
	private activeUntil = 0;

	constructor(private readonly now: () => number = Date.now) {}

	/** Records a trip; returns true when the notice should be shown. */
	trip(info: DailyLimitInfo): boolean {
		const fresh = this.now() >= this.activeUntil;
		this.activeUntil = Math.max(this.activeUntil, info.resetAt);
		return fresh;
	}

	active(): boolean {
		return this.now() < this.activeUntil;
	}

	resetAt(): number | null {
		return this.active() ? this.activeUntil : null;
	}
}
