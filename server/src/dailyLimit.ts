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
 * covered without touching each catch block. While the limit is latched, every
 * VAULT_ERROR frame and every failed HTTP request is answered with the typed
 * code `cf_daily_limit` plus `resetAt` (next 00:00 UTC).
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

/**
 * Per-runtime record that the limit was hit. It stays set until the next
 * 00:00 UTC, or until a row write succeeds again (`noteWriteSucceeded`: the
 * account moved to Workers Paid mid-day, or the reset happened earlier than
 * this isolate's clock says).
 */
export class DailyLimitLatch {
	private until = 0;
	private kind: DailyLimitKind = "rows-written";
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
	 * Typed form of a VAULT_ERROR control frame while the limit is latched (or
	 * when the frame's own message is the limit error); other frames unchanged.
	 */
	decorateControl(value: unknown): unknown {
		if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "VAULT_ERROR") return value;
		const frame = value as { type: "VAULT_ERROR"; code?: string; message?: string };
		if (!this.active() && !this.note(frame.message)) return value;
		const body = this.body();
		if (!body) return value;
		return { ...frame, code: DAILY_LIMIT_ERROR_CODE, kind: body.kind, resetAt: body.resetAt,
			message: body.message, ...(frame.code ? { cause: frame.code } : {}) };
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
 *   caller gates it behind YAOS_TEST_ONLY_DEBUG_ROUTES).
 * Reads are never blocked by the simulation.
 */
export function instrumentStorageForDailyLimit<T extends object>(
	storage: T,
	latch: DailyLimitLatch,
	simulate: () => boolean = () => false,
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

/** Outcome of {@link armAlarmUnderDailyLimit}: `kept` = an earlier-or-equal alarm already stands; `failed` = setAlarm hit the limit. */
export type DailyLimitAlarmOutcome = "armed" | "kept" | "failed";

/**
 * The one D8 alarm policy, shared by the vault runtime (`setAlarmGuarded`) and
 * the RecoveryJob alarm port (`dailyLimitGuardedAlarms`). While the latch is
 * active no alarm is armed before the 00:00 UTC reset (each `setAlarm` is a
 * billed row write, and the work it schedules would fail on the same limit). An
 * alarm already due at or before the target is kept. A `setAlarm` that itself
 * fails on the limit is noted and dropped. `earliest` keeps an earlier standing
 * alarm even when not latched (the vault alarm is shared by several subsystems).
 * `held` reports whether the latch shaped this decision (vault diagnostics).
 */
export async function armAlarmUnderDailyLimit(
	alarms: { setAlarm(scheduledTime: number): Promise<void>; getAlarm?(): Promise<number | null> },
	latch: DailyLimitLatch,
	scheduledTime: number,
	earliest: boolean,
	label: string,
): Promise<{ outcome: DailyLimitAlarmOutcome; held: boolean }> {
	const resetAt = latch.body()?.resetAt ?? null;
	const held = resetAt !== null;
	const at = resetAt === null ? scheduledTime : Math.max(scheduledTime, resetAt);
	if (earliest || held) {
		const current = await alarms.getAlarm?.();
		if (current !== undefined && current !== null && current <= at) return { outcome: "kept", held };
	}
	try {
		await alarms.setAlarm(at);
		return { outcome: "armed", held };
	} catch (error) {
		if (latch.note(error)) {
			console.warn(`[${label}] alarm not armed: Cloudflare daily row limit`);
			return { outcome: "failed", held };
		}
		throw error;
	}
}
