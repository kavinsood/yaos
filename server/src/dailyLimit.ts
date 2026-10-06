/**
 * Cloudflare Durable Objects free-tier daily limit (write-budget spike, D8).
 *
 * On the Workers Free plan a Durable Object account may write 100,000 SQLite
 * rows (and read 5,000,000) per day. "If you exceed any one of the free tier
 * limits, further operations of that type will fail with an error. Daily free
 * limits reset at 00:00 UTC."
 * https://developers.cloudflare.com/durable-objects/platform/pricing/
 *
 * Cloudflare does not document the error text. The observed message is
 * "Exceeded allowed rows written in Durable Objects free tier."
 * (https://www.answeroverflow.com/m/1361050750628794469). The classifier also
 * accepts the analogous rows-read message and D1's documented wording
 * ("...exceeded D1's free tier daily row write limit...",
 * https://developers.cloudflare.com/d1/observability/debug-d1/) so a small
 * wording change does not turn the clear notice back into a generic error.
 *
 * Classification is a pure function of the error; detection hooks the storage
 * port once (instrumentStorageForDailyLimit) so every code path that writes is
 * covered without touching each catch block. Errors are typed at the source
 * (H3): the streams relay builds `dailyLimitControl` frames for appends it
 * refuses or fails on the limit, and HTTP handlers answer `dailyLimitResponse`
 * (typed code `cf_daily_limit` plus `resetAt`, the next 00:00 UTC).
 */

export const DAILY_LIMIT_ERROR_CODE = "cf_daily_limit";
/** The exact message Cloudflare raises for the DO rows-written free-tier limit. */
export const CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE = "Exceeded allowed rows written in Durable Objects free tier.";

const DAILY_LIMIT_PATTERNS: readonly RegExp[] = [
	/exceeded allowed rows (?:written|read) in durable objects free tier/i,
	/free tier daily row (?:write|read) limit/i,
	/durable objects free tier.*(?:limit|exceeded)/i,
];

export type DailyLimitKind = "rows-written" | "rows-read" | "unknown";

function messagesOf(error: unknown, depth = 0): string[] {
	if (depth > 4 || error === null || error === undefined) return [];
	if (typeof error === "string") return [error];
	if (error instanceof Error) {
		return [error.message, ...messagesOf((error as Error & { cause?: unknown }).cause, depth + 1)];
	}
	if (typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
		return [(error as { message: string }).message];
	}
	return [];
}

/** Whether `error` is Cloudflare's free-tier daily row limit (written or read). */
export function isCloudflareDailyLimitError(error: unknown): boolean {
	return messagesOf(error).some((message) => DAILY_LIMIT_PATTERNS.some((pattern) => pattern.test(message)));
}

export function dailyLimitKind(error: unknown): DailyLimitKind {
	const text = messagesOf(error).join("\n");
	if (/rows read|row read limit/i.test(text)) return "rows-read";
	if (/rows written|row write limit/i.test(text)) return "rows-written";
	return "unknown";
}

/** Next 00:00 UTC strictly after `now` (Unix ms). */
export function nextUtcMidnight(now: number): number {
	const date = new Date(now);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export interface DailyLimitBody {
	error: typeof DAILY_LIMIT_ERROR_CODE;
	kind: DailyLimitKind;
	/** Unix ms of the next 00:00 UTC, when Cloudflare resets the free limits. */
	resetAt: number;
	message: string;
}

export function dailyLimitBody(now: number, kind: DailyLimitKind = "rows-written"): DailyLimitBody {
	return {
		error: DAILY_LIMIT_ERROR_CODE,
		kind,
		resetAt: nextUtcMidnight(now),
		message: "Cloudflare's daily free limit was reached. Sync resumes at 00:00 UTC. The $5/month Workers Paid plan removes this limit.",
	};
}

/** HTTP 503 with Retry-After for a request that failed on the daily limit. */
export function dailyLimitResponse(now: number, kind: DailyLimitKind = "rows-written"): Response {
	const body = dailyLimitBody(now, kind);
	return new Response(JSON.stringify(body), {
		status: 503,
		headers: {
			"content-type": "application/json",
			"retry-after": String(Math.max(1, Math.ceil((body.resetAt - now) / 1000))),
		},
	});
}

/** The `VAULT_ERROR cf_daily_limit` control frame (relay-wire §16) for appends refused or failed on the daily limit (H3). */
export function dailyLimitControl(now: number, kind: DailyLimitKind, stream: string, clientFrameIds: readonly string[]) {
	const body = dailyLimitBody(now, kind);
	return { type: "VAULT_ERROR" as const, code: DAILY_LIMIT_ERROR_CODE, cause: "durability_failed" as const, kind: body.kind,
		resetAt: body.resetAt, message: body.message, stream, clientFrameIds: [...clientFrameIds] };
}

/**
 * Per-runtime record that the limit was hit. It stays set until the next
 * 00:00 UTC, or until a row write succeeds again (`noteWriteSucceeded`: the
 * account moved to Workers Paid mid-day, or the reset happened earlier than
 * this isolate's clock says).
 */
export class DailyLimitLatch {
	private until = 0;
	private kind: DailyLimitKind = "rows-written";
	private simulated = false;
	constructor(private readonly now: () => number = Date.now) {}

	/** Records `error` if it is the daily limit; returns whether it was. */
	note(error: unknown): boolean {
		if (!isCloudflareDailyLimitError(error)) return false;
		const now = this.now();
		this.until = nextUtcMidnight(now);
		this.kind = dailyLimitKind(error);
		return true;
	}

	active(): boolean {
		return this.now() < this.until;
	}

	clear(): void {
		this.until = 0;
	}

	/** A row write succeeded: the rows-written limit no longer applies. */
	noteWriteSucceeded(): void {
		if (this.until !== 0 && this.kind !== "rows-read") this.until = 0;
	}

	body(): DailyLimitBody | null {
		return this.active() ? { ...dailyLimitBody(this.now(), this.kind), resetAt: this.until } : null;
	}

	/**
	 * TEST-ONLY (`POST /vault/:id/debug/simulate-daily-limit {"enabled"}`, only with YAOS_DEBUG_ROUTES=1). `true`
	 * latches rows-written now, and every write through `instrumentStorageForDailyLimit` throws Cloudflare's exact
	 * error (so the real classification paths run); `false` stops that and clears the latch. Memory only.
	 */
	simulate(enabled: boolean): void {
		this.simulated = enabled;
		if (enabled) this.note(new Error(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE));
		else this.clear();
	}

	/** Whether `simulate(true)` is in effect. */
	simulating(): boolean {
		return this.simulated;
	}
}

const WRITE_STATEMENT = /^\s*(?:insert|update|delete|replace|upsert|create|drop|alter)\b/i;

/** Whether a SQL statement writes rows (approximation used only for simulation). */
export function isWriteStatement(query: string): boolean {
	return WRITE_STATEMENT.test(query.replace(/^\s*(?:--[^\n]*\n\s*)*/, ""));
}

const ROW_WRITE_STATEMENT = /^\s*(?:insert|update|delete|replace|upsert)\b/i;

const SIMULATED_KV_WRITES = new Set(["put", "delete", "deleteAll", "setAlarm", "deleteAlarm"]);

interface SqlLike {
	exec(query: string, ...bindings: unknown[]): unknown;
}

/**
 * Wraps a Durable Object storage object so that
 * - every thrown daily-limit error is noted on `latch` (then rethrown),
 * - a successful row DML statement (INSERT/UPDATE/DELETE/REPLACE) clears a
 *   rows-written latch, and
 * - while `simulate()` is true, every write statement and every KV/alarm write
 *   (`put`, `delete`, `deleteAll`, `setAlarm`, `deleteAlarm`; each is a billed
 *   row write) throws Cloudflare's exact rows-written error (TEST-ONLY; the
 *   default reads `latch.simulating()`, which only the debug route sets).
 * Reads are never blocked by the simulation.
 */
export function instrumentStorageForDailyLimit<T extends object>(
	storage: T,
	latch: DailyLimitLatch,
	simulate: () => boolean = () => latch.simulating(),
): T {
	const observe = <R>(run: () => R): R => {
		try {
			const result = run();
			if (result && typeof (result as { then?: unknown }).then === "function") {
				return (result as unknown as Promise<unknown>).catch((error: unknown) => {
					latch.note(error);
					throw error;
				}) as R;
			}
			return result;
		} catch (error) {
			latch.note(error);
			throw error;
		}
	};
	const sqlTarget = (storage as { sql?: SqlLike }).sql;
	const sql = sqlTarget ? new Proxy(sqlTarget, {
		get(target, property) {
			if (property === "exec") {
				return (query: string, ...bindings: unknown[]) => observe(() => {
					const write = isWriteStatement(query);
					if (simulate() && write) throw new Error(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE);
					const result = target.exec(query, ...bindings);
					// Only row DML proves the limit lifted; `CREATE ... IF NOT EXISTS` on an
					// existing table writes no row and may succeed while limited.
					if (write && ROW_WRITE_STATEMENT.test(query.replace(/^\s*(?:--[^\n]*\n\s*)*/, ""))) latch.noteWriteSucceeded();
					return result;
				});
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	}) : undefined;
	return new Proxy(storage, {
		get(target, property) {
			if (property === "sql") return sql;
			const value = Reflect.get(target, property, target) as unknown;
			if (typeof value !== "function") return value;
			const simulatedWrite = typeof property === "string" && SIMULATED_KV_WRITES.has(property);
			return (...args: unknown[]) => observe(() => {
				if (simulatedWrite && simulate()) return Promise.reject(new Error(CF_DO_ROWS_WRITTEN_LIMIT_MESSAGE));
				return (value as (...inner: unknown[]) => unknown).apply(target, args);
			});
		},
	});
}
