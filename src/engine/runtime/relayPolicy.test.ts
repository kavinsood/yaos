/** Relay condition -> reaction table (DESIGN §i.6) and full-jitter backoff bounds. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, RELAY_CLOSE, SUPERSEDED_RETRY_MS } from "../../core/limits";
import {
	BACKPRESSURE_RECONNECT_MS, DAILY_LIMIT_DEFAULT_MS, UNCLAIMED_RETRY_MS, backoffMs, connectFailure, newReconnectState, sessionClosed,
} from "./relayPolicy";

const r0 = () => 0;
const r1 = () => 0.999999;

test("backoffMs: full jitter within [floor, min(max, base*2^n)), floored, capped, clamped attempt", () => {
	for (let n = 0; n < 12; n++) {
		const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** n);
		assert.equal(backoffMs(n, r0), 100, "floor min(100, base)");
		const hi = backoffMs(n, r1);
		assert.ok(hi < cap && hi >= cap - 1, `n=${n} hi=${hi} cap=${cap}`);
		assert.equal(backoffMs(n, () => 0.5), Math.max(100, Math.floor(cap / 2)));
	}
	assert.ok(backoffMs(1_000, r1) < RECONNECT_MAX_MS, "huge attempt stays capped (no Infinity/NaN)");
	assert.equal(backoffMs(-5, r1), Math.floor(0.999999 * RECONNECT_BASE_MS), "negative attempt = 0");
	assert.equal(backoffMs(0, r0, 20, 1000), 20, "floor is min(100, base)");
	assert.equal(backoffMs(10, r1, 20, 1000), 999);
	let seed = 7;
	const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
	for (let i = 0; i < 2000; i++) {
		const n = i % 15;
		const v = backoffMs(n, rnd);
		assert.ok(v >= 100 && v < Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** n) + 100);
	}
});

test("connectFailure: terminal, hourly, daily-limit and backoff outcomes", () => {
	const st = newReconnectState();
	assert.deepEqual(connectFailure("unauthorized", null, st, r0), { phase: "revoked", retryMs: null, notice: "device-revoked" });
	assert.deepEqual(connectFailure("update-required", 5, st, r0), { phase: "upgrade-required", retryMs: null, notice: "upgrade-required" });
	assert.deepEqual(connectFailure("unclaimed", null, st, r0), { phase: "error", retryMs: UNCLAIMED_RETRY_MS, notice: "vault-unclaimed" });
	assert.deepEqual(connectFailure("not-found", null, st, r0), { phase: "error", retryMs: UNCLAIMED_RETRY_MS, notice: "vault-not-found" });
	assert.deepEqual(connectFailure("daily-limit", null, st, r0), { phase: "daily-limit", retryMs: DAILY_LIMIT_DEFAULT_MS, notice: "daily-limit" });
	assert.equal(connectFailure("daily-limit", 42_000, st, r0).retryMs, 42_000);
	assert.equal(connectFailure("daily-limit", 10, st, r0).retryMs, 1_000, "floored at 1 s");
	assert.equal(st.attempts, 0, "none of these count as backoff attempts");

	const d1 = connectFailure("unavailable", null, st, r1);
	assert.equal(st.attempts, 1);
	assert.equal(d1.phase, "offline");
	assert.equal(d1.notice, null);
	assert.ok(d1.retryMs! < RECONNECT_BASE_MS);
	const d2 = connectFailure("unavailable", null, st, r1);
	assert.ok(d2.retryMs! >= RECONNECT_BASE_MS && d2.retryMs! < 2 * RECONNECT_BASE_MS, "grows with attempts");
	assert.equal(connectFailure("unavailable", 90_000, st, r0).retryMs, 90_000, "Retry-After wins when longer");
	assert.equal(st.attempts, 3);
});

test("connectFailure / sessionClosed: superseded re-tickets once, then waits SUPERSEDED_RETRY_MS", () => {
	const st = newReconnectState();
	assert.deepEqual(connectFailure("superseded", null, st, r0), { phase: "offline", retryMs: 0, notice: null });
	assert.deepEqual(connectFailure("superseded", null, st, r0), { phase: "superseded", retryMs: SUPERSEDED_RETRY_MS, notice: "superseded" });
	const st2 = newReconnectState();
	assert.equal(sessionClosed(RELAY_CLOSE.superseded, null, false, st2, r0).retryMs, 0);
	assert.equal(sessionClosed(1000, "authority_superseded", false, st2, r0).phase, "superseded");
	assert.equal(st2.attempts, 0);
});

test("sessionClosed: error codes, epoch close, rate/backpressure floor, generic backoff", () => {
	const st = newReconnectState();
	assert.deepEqual(sessionClosed(RELAY_CLOSE.policy, "unauthorized", false, st, r0), { phase: "revoked", retryMs: null, notice: "device-revoked" });
	assert.deepEqual(sessionClosed(1000, "update_required", false, st, r0), { phase: "upgrade-required", retryMs: null, notice: "upgrade-required" });
	assert.deepEqual(sessionClosed(RELAY_CLOSE.epoch, null, false, st, r0), { phase: "epoch-migrating", retryMs: null, notice: "epoch-changed" });
	assert.equal(st.attempts, 0);
	const rate = sessionClosed(RELAY_CLOSE.rate, null, false, st, r0);
	assert.deepEqual(rate, { phase: "offline", retryMs: BACKPRESSURE_RECONNECT_MS, notice: null });
	assert.equal(sessionClosed(RELAY_CLOSE.abnormal, null, true, st, r0).retryMs, BACKPRESSURE_RECONNECT_MS, "backpressure flag also floors");
	assert.equal(st.attempts, 2);
	const g = sessionClosed(RELAY_CLOSE.abnormal, null, false, st, r1);
	assert.equal(g.phase, "offline");
	assert.ok(g.retryMs! >= 3 * RECONNECT_BASE_MS && g.retryMs! < 4 * RECONNECT_BASE_MS, `attempt 3 -> [2^2 s cap) got ${g.retryMs}`);
	const big = newReconnectState();
	big.attempts = 40;
	assert.ok(sessionClosed(RELAY_CLOSE.rate, null, false, big, r1).retryMs! <= RECONNECT_MAX_MS);
});
