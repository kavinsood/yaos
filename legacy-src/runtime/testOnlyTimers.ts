/**
 * TEST-ONLY CLIENT TIMER OVERRIDES. INERT UNLESS EXPLICITLY INSTALLED.
 *
 * Deployed verification rounds otherwise wait on production timers (60 s
 * socket liveness idle, 60 s awareness renewal, 15 min CLI safety poll, ...)
 * to observe a single cycle. This module holds one process-wide, frozen set of
 * overrides. Nothing installs it by default, so every accessor returns the
 * production value passed in by the caller.
 *
 * Installation path (requires the master flag
 * `YAOS_TEST_ONLY_FAST_TIMERS=true`):
 * - Plugin: only a bundle built with the esbuild define
 *   `__YAOS_TEST_ONLY_TIMERS__` (a JSON object of the same variables) honors
 *   anything. The shipped production build never defines it, so no setting,
 *   data.json field or global can switch it on for a normal user.
 *
 * Values are clamped to `[floor, production]`: an override can only make a
 * timer faster, never slower, and never below a sane floor.
 */

export interface ClientTimerOverrides {
	/** Socket liveness idle before a VAULT_PING (server descriptor: 60 s). */
	readonly livenessIdleMs?: number;
	/** Socket liveness probe/ready timeout (server descriptor: 15 s). */
	readonly livenessTimeoutMs?: number;
	/** Ticket refresh buffer before expiry (socketTicket.ts: 30 s). */
	readonly ticketRefreshBufferMs?: number;
	/** Own awareness renewal (ownAwarenessProvider.ts: 60 s). */
	readonly awarenessRenewMs?: number;
	/** Remote awareness expiry (ownAwarenessProvider.ts: 150 s). */
	readonly awarenessRemoteTimeoutMs?: number;
	/** Awareness check interval (ownAwarenessProvider.ts: 15 s). */
	readonly awarenessCheckMs?: number;
	/** Body candidate debounce (vaultSync.ts: 250 ms). */
	readonly candidateDebounceMs?: number;
	/** Body candidate max wait (vaultSync.ts: 2 s). */
	readonly candidateMaxWaitMs?: number;
	/** CLI remote safety poll spacing (remotePoll.ts: 15 reconcile periods). */
	readonly remoteSafetyPollMs?: number;
}

export type ClientTimerName = keyof ClientTimerOverrides;

export const TEST_ONLY_FAST_TIMERS_FLAG = "YAOS_TEST_ONLY_FAST_TIMERS";

/** Environment variable, floor and production ceiling of every knob. */
export const CLIENT_TIMER_KNOBS: Readonly<Record<ClientTimerName, { env: string; floor: number; production: number }>> = Object.freeze({
	livenessIdleMs: { env: "YAOS_TEST_ONLY_LIVENESS_IDLE_MS", floor: 1_000, production: 60_000 },
	livenessTimeoutMs: { env: "YAOS_TEST_ONLY_LIVENESS_TIMEOUT_MS", floor: 1_000, production: 15_000 },
	ticketRefreshBufferMs: { env: "YAOS_TEST_ONLY_TICKET_REFRESH_BUFFER_MS", floor: 1_000, production: 30_000 },
	awarenessRenewMs: { env: "YAOS_TEST_ONLY_AWARENESS_RENEW_MS", floor: 1_000, production: 60_000 },
	awarenessRemoteTimeoutMs: { env: "YAOS_TEST_ONLY_AWARENESS_REMOTE_TIMEOUT_MS", floor: 2_000, production: 150_000 },
	awarenessCheckMs: { env: "YAOS_TEST_ONLY_AWARENESS_CHECK_MS", floor: 250, production: 15_000 },
	candidateDebounceMs: { env: "YAOS_TEST_ONLY_CANDIDATE_DEBOUNCE_MS", floor: 10, production: 250 },
	candidateMaxWaitMs: { env: "YAOS_TEST_ONLY_CANDIDATE_MAX_WAIT_MS", floor: 50, production: 2_000 },
	remoteSafetyPollMs: { env: "YAOS_TEST_ONLY_REMOTE_SAFETY_POLL_MS", floor: 1_000, production: 15 * 60_000 },
});

export interface ParsedClientTimers {
	readonly overrides: ClientTimerOverrides;
	/** Knobs present but unusable (non-numeric), or present without the master flag. */
	readonly rejected: readonly string[];
}

/**
 * Parses knob variables. Without `YAOS_TEST_ONLY_FAST_TIMERS=true` every knob
 * is ignored (and reported in `rejected`), so the result is empty.
 */
export function parseClientTimerEnv(env: Readonly<Record<string, string | undefined>>): ParsedClientTimers {
	const enabled = (env[TEST_ONLY_FAST_TIMERS_FLAG] ?? "").trim() === "true";
	const overrides: Record<string, number> = {};
	const rejected: string[] = [];
	for (const [name, knob] of Object.entries(CLIENT_TIMER_KNOBS)) {
		const raw = (env[knob.env] ?? "").trim();
		if (!raw) continue;
		if (!enabled) { rejected.push(`${knob.env} (ignored without ${TEST_ONLY_FAST_TIMERS_FLAG}=true)`); continue; }
		const value = Number(raw);
		if (!Number.isFinite(value)) { rejected.push(`${knob.env} (not a number)`); continue; }
		overrides[name] = Math.min(knob.production, Math.max(knob.floor, Math.floor(value)));
	}
	return { overrides: Object.freeze(overrides) as ClientTimerOverrides, rejected: Object.freeze(rejected) };
}

let installed: ClientTimerOverrides = Object.freeze({});

/** Installs overrides process-wide. Only test entry points call this. */
export function installClientTimerOverrides(overrides: ClientTimerOverrides): void {
	installed = Object.freeze({ ...overrides });
}

/** Tests only: back to production values. */
export function resetClientTimerOverrides(): void {
	installed = Object.freeze({});
}

export function clientTimerOverrides(): ClientTimerOverrides {
	return installed;
}

/** The installed override for `name`, or the caller's production value. */
export function clientTimer(name: ClientTimerName, production: number): number {
	return installed[name] ?? production;
}
