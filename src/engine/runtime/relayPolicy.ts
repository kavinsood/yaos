/**
 * Relay condition -> engine reaction (DESIGN §i.6). Pure; the engine owns the timers.
 *
 *  unauthorized            -> revoked, no retry (re-pair)
 *  update-required         -> upgrade-required, no retry
 *  superseded              -> re-ticket at once; again -> phase superseded, retry after 60 s
 *  unclaimed / not-found   -> error, retry hourly
 *  daily-limit             -> daily-limit, retry after retryAfterMs (default 1 h)
 *  4409 epoch close        -> epoch-migrating, no retry (DESIGN §c.12, not implemented)
 *  1013 / backpressure     -> reconnect after >= 5 s
 *  anything else           -> full-jitter backoff RECONNECT_BASE_MS .. RECONNECT_MAX_MS
 */

import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, RELAY_CLOSE, SUPERSEDED_RETRY_MS } from "../../core/limits";
import type { RelayConnectResult } from "../../ports/relay";
import type { EnginePhase } from "../../protocol/status";

export const UNCLAIMED_RETRY_MS = 60 * 60_000;
export const DAILY_LIMIT_DEFAULT_MS = 60 * 60_000;
export const BACKPRESSURE_RECONNECT_MS = 5_000;

export interface ReconnectDecision {
	readonly phase: EnginePhase;
	/** null = do not reconnect automatically. */
	readonly retryMs: number | null;
	readonly notice: string | null;
}

export interface ReconnectState {
	/** Consecutive failed connects / sessions that never reached live. */
	attempts: number;
	/** Consecutive superseded outcomes. */
	supersededStreak: number;
}

export function newReconnectState(): ReconnectState {
	return { attempts: 0, supersededStreak: 0 };
}

/** Full jitter: uniform in [0, min(max, base * 2^attempt)), floored at min(100, base) ms. */
export function backoffMs(attempt: number, random: () => number, baseMs = RECONNECT_BASE_MS, maxMs = RECONNECT_MAX_MS): number {
	const cap = Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(0, attempt), 30));
	return Math.max(Math.min(100, baseMs), Math.floor(random() * cap));
}

function superseded(st: ReconnectState): ReconnectDecision {
	st.supersededStreak++;
	if (st.supersededStreak <= 1) return { phase: "offline", retryMs: 0, notice: null };
	return { phase: "superseded", retryMs: SUPERSEDED_RETRY_MS, notice: "superseded" };
}

export function connectFailure(
	reason: Extract<RelayConnectResult, { ok: false }>["reason"], retryAfterMs: number | null, st: ReconnectState, random: () => number, baseMs = RECONNECT_BASE_MS,
): ReconnectDecision {
	switch (reason) {
		case "unauthorized":
			return { phase: "revoked", retryMs: null, notice: "device-revoked" };
		case "update-required":
			return { phase: "upgrade-required", retryMs: null, notice: "upgrade-required" };
		case "superseded":
			return superseded(st);
		case "unclaimed":
		case "not-found":
			return { phase: "error", retryMs: UNCLAIMED_RETRY_MS, notice: `vault-${reason}` };
		case "daily-limit":
			return { phase: "daily-limit", retryMs: Math.max(1_000, retryAfterMs ?? DAILY_LIMIT_DEFAULT_MS), notice: "daily-limit" };
		case "unavailable":
			st.attempts++;
			return { phase: "offline", retryMs: Math.max(retryAfterMs ?? 0, backoffMs(st.attempts - 1, random, baseMs)), notice: null };
	}
}

export function sessionClosed(
	code: number, errorCode: string | null, backpressure: boolean, st: ReconnectState, random: () => number, baseMs = RECONNECT_BASE_MS,
): ReconnectDecision {
	if (errorCode === "unauthorized") return { phase: "revoked", retryMs: null, notice: "device-revoked" };
	if (errorCode === "update_required") return { phase: "upgrade-required", retryMs: null, notice: "upgrade-required" };
	if (code === RELAY_CLOSE.epoch) return { phase: "epoch-migrating", retryMs: null, notice: "epoch-changed" };
	if (code === RELAY_CLOSE.superseded || errorCode === "authority_superseded") return superseded(st);
	st.attempts++;
	const b = backoffMs(st.attempts - 1, random, baseMs);
	if (code === RELAY_CLOSE.rate || backpressure) return { phase: "offline", retryMs: Math.max(BACKPRESSURE_RECONNECT_MS, b), notice: null };
	return { phase: "offline", retryMs: b, notice: null };
}
