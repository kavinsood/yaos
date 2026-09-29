import { DEVICE_LAST_SEEN_RESOLUTION_MS } from "./contracts";

/**
 * TEST-ONLY SERVER TIMER OVERRIDES. INERT UNLESS `YAOS_TEST_ONLY_FAST_TIMERS`
 * IS EXACTLY "true".
 *
 * Deployed verification rounds otherwise wait on production timers (a
 * five-minute `lastSeenAt` resolution, for example) to observe one cycle.
 * Each knob is a Worker `[vars]` string. A knob without the master flag, a
 * non-numeric value, or a value outside the clamp range is ignored or clamped:
 * the result can only ever be *faster* than production and never below a
 * floor that keeps the runtime sane. With the master flag absent every
 * value is the production constant, so an ordinary deploy that happens to
 * carry a stray knob still behaves exactly like production.
 *
 * Socket liveness (idle/timeout) and awareness renewal are client-driven, so
 * their knobs live in the client (`src/runtime/testOnlyTimers.ts`); the server
 * only answers pings. Ticket TTL keeps its long-standing operator knob
 * `YAOS_TICKET_TTL_MS` (routes/ticket.ts).
 */
export interface TestOnlyServerTimerEnv {
	YAOS_TEST_ONLY_FAST_TIMERS?: string;
	YAOS_TEST_ONLY_PERSIST_DEBOUNCE_MS?: string;
	YAOS_TEST_ONLY_LAST_SEEN_RESOLUTION_MS?: string;
}

export interface ServerTimers {
	/** Debounce between a socket update and its durable flush (server.ts). */
	readonly persistDebounceMs: number;
	/** `lastSeenAt` write resolution for tickets, root pings and the control plane. */
	readonly deviceLastSeenResolutionMs: number;
}

export const PRODUCTION_PERSIST_DEBOUNCE_MS = 250;

export const PRODUCTION_SERVER_TIMERS: ServerTimers = Object.freeze({
	persistDebounceMs: PRODUCTION_PERSIST_DEBOUNCE_MS,
	deviceLastSeenResolutionMs: DEVICE_LAST_SEEN_RESOLUTION_MS,
});

const FLOORS: ServerTimers = Object.freeze({
	persistDebounceMs: 25,
	deviceLastSeenResolutionMs: 1_000,
});

export function testOnlyFastTimersEnabled(env: TestOnlyServerTimerEnv | null | undefined): boolean {
	return env?.YAOS_TEST_ONLY_FAST_TIMERS === "true";
}

function clampKnob(raw: string | undefined, floor: number, production: number): number {
	if (raw === undefined || raw.trim() === "") return production;
	const value = Number(raw.trim());
	if (!Number.isFinite(value)) return production;
	return Math.min(production, Math.max(floor, Math.floor(value)));
}

export function readServerTimers(env: TestOnlyServerTimerEnv | null | undefined): ServerTimers {
	if (!testOnlyFastTimersEnabled(env)) return PRODUCTION_SERVER_TIMERS;
	return Object.freeze({
		persistDebounceMs: clampKnob(env!.YAOS_TEST_ONLY_PERSIST_DEBOUNCE_MS,
			FLOORS.persistDebounceMs, PRODUCTION_SERVER_TIMERS.persistDebounceMs),
		deviceLastSeenResolutionMs: clampKnob(env!.YAOS_TEST_ONLY_LAST_SEEN_RESOLUTION_MS,
			FLOORS.deviceLastSeenResolutionMs, PRODUCTION_SERVER_TIMERS.deviceLastSeenResolutionMs),
	});
}

/**
 * The experiment-only debug routes (`POST /vault/:id/debug/simulate-restart`)
 * need their own explicit var, mirroring `YAOS_ENABLE_ADMIN_ROUTES`: absent,
 * the route answers 404 without waking the vault Durable Object.
 */
export interface TestOnlyDebugRouteEnv {
	YAOS_TEST_ONLY_DEBUG_ROUTES?: string;
}

export function testOnlyDebugRoutesEnabled(env: TestOnlyDebugRouteEnv | null | undefined): boolean {
	return env?.YAOS_TEST_ONLY_DEBUG_ROUTES === "true";
}
