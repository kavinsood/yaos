import { strict as assert } from "node:assert";
import {
	CLIENT_TIMER_KNOBS,
	clientTimer,
	clientTimerOverrides,
	installClientTimerOverrides,
	parseClientTimerEnv,
	resetClientTimerOverrides,
	type ClientTimerName,
} from "../../src/runtime/testOnlyTimers";
import { SocketLivenessCoordinator } from "../../src/runtime/socketLivenessCoordinator";
import { SOCKET_LIVENESS_DESCRIPTOR, SOCKET_LIVENESS_IDLE_MS, SOCKET_LIVENESS_TIMEOUT_MS } from "../../server/src/shared/socketLiveness";
import { AWARENESS_CHECK_MS, AWARENESS_REMOTE_TIMEOUT_MS, AWARENESS_RENEW_MS } from "../../src/sync/ownAwarenessProvider";
import { TICKET_REFRESH_BUFFER_MS, ticketRefreshBufferMs } from "../../src/sync/socketTicket";
import { REMOTE_SAFETY_POLL_PERIODS } from "../../packages/cli/src/remotePoll";
import { ConfigError, resolveDaemonConfig } from "../../packages/cli/src/config";
import { suite } from "../harness.ts";

// Test-only client timers: production values unless explicitly installed, and
// knob variables do nothing without YAOS_TEST_ONLY_FAST_TIMERS=true.

const s = suite("test-only-timers");
const ALL_KNOBS = Object.fromEntries(Object.values(CLIENT_TIMER_KNOBS).map((knob) => [knob.env, "1500"]));
const DAEMON = { command: "daemon" as const, vaultPath: "/tmp/vault" };

s.test("knob ceilings are the real production constants", () => {
	assert.equal(CLIENT_TIMER_KNOBS.livenessIdleMs.production, SOCKET_LIVENESS_IDLE_MS);
	assert.equal(CLIENT_TIMER_KNOBS.livenessTimeoutMs.production, SOCKET_LIVENESS_TIMEOUT_MS);
	assert.equal(CLIENT_TIMER_KNOBS.ticketRefreshBufferMs.production, TICKET_REFRESH_BUFFER_MS);
	assert.equal(CLIENT_TIMER_KNOBS.awarenessRenewMs.production, AWARENESS_RENEW_MS);
	assert.equal(CLIENT_TIMER_KNOBS.awarenessRemoteTimeoutMs.production, AWARENESS_REMOTE_TIMEOUT_MS);
	assert.equal(CLIENT_TIMER_KNOBS.awarenessCheckMs.production, AWARENESS_CHECK_MS);
	assert.equal(CLIENT_TIMER_KNOBS.remoteSafetyPollMs.production, 60_000 * REMOTE_SAFETY_POLL_PERIODS);
	assert.equal(SOCKET_LIVENESS_IDLE_MS, 60_000);
	assert.equal(TICKET_REFRESH_BUFFER_MS, 30_000);
});

s.test("defaults are unchanged when nothing is installed", () => {
	resetClientTimerOverrides();
	assert.deepEqual(clientTimerOverrides(), {});
	for (const [name, knob] of Object.entries(CLIENT_TIMER_KNOBS)) {
		assert.equal(clientTimer(name as ClientTimerName, knob.production), knob.production, name);
	}
	assert.equal(ticketRefreshBufferMs(), TICKET_REFRESH_BUFFER_MS);
});

s.test("knobs are ignored without the exact master flag", () => {
	for (const flag of [undefined, "", "1", "TRUE", "yes", "false"]) {
		const env = { ...ALL_KNOBS, ...(flag === undefined ? {} : { YAOS_TEST_ONLY_FAST_TIMERS: flag }) };
		const parsed = parseClientTimerEnv(env);
		assert.deepEqual(parsed.overrides, {}, `flag ${String(flag)}`);
		assert.equal(parsed.rejected.length, Object.keys(CLIENT_TIMER_KNOBS).length);
	}
	assert.deepEqual(parseClientTimerEnv({}), { overrides: {}, rejected: [] });
	assert.deepEqual(parseClientTimerEnv({ YAOS_TEST_ONLY_FAST_TIMERS: "true" }), { overrides: {}, rejected: [] });
});

s.test("with the master flag, knobs are clamped to [floor, production]", () => {
	const parsed = parseClientTimerEnv({ YAOS_TEST_ONLY_FAST_TIMERS: "true",
		YAOS_TEST_ONLY_LIVENESS_IDLE_MS: "3000", YAOS_TEST_ONLY_LIVENESS_TIMEOUT_MS: "1",
		YAOS_TEST_ONLY_AWARENESS_RENEW_MS: "9999999", YAOS_TEST_ONLY_CANDIDATE_DEBOUNCE_MS: "x" });
	assert.deepEqual(parsed.overrides, { livenessIdleMs: 3_000, livenessTimeoutMs: 1_000, awarenessRenewMs: AWARENESS_RENEW_MS });
	assert.deepEqual(parsed.rejected, ["YAOS_TEST_ONLY_CANDIDATE_DEBOUNCE_MS (not a number)"]);
});

s.test("the CLI config carries no overrides by default and refuses stray knobs", () => {
	assert.deepEqual(resolveDaemonConfig(DAEMON, {}).testOnlyTimers, {});
	assert.equal(resolveDaemonConfig(DAEMON, {}).reconcileIntervalMs, 60_000);
	assert.throws(() => resolveDaemonConfig(DAEMON, { YAOS_TEST_ONLY_LIVENESS_IDLE_MS: "3000" }), ConfigError);
	assert.deepEqual(resolveDaemonConfig(DAEMON, { YAOS_TEST_ONLY_FAST_TIMERS: "true",
		YAOS_TEST_ONLY_LIVENESS_IDLE_MS: "3000", YAOS_TEST_ONLY_REMOTE_SAFETY_POLL_MS: "20000" }).testOnlyTimers,
	{ livenessIdleMs: 3_000, remoteSafetyPollMs: 20_000 });
});

s.test("an installed liveness override drives the probe timer; reset restores the descriptor", () => {
	const timers: Array<{ callback: () => void; delayMs: number }> = [];
	const clock = { now: () => 0, setTimer: (callback: () => void, delayMs: number) => { timers.push({ callback, delayMs }); return timers.length; }, clearTimer: () => {} };
	const run = () => {
		timers.length = 0;
		const coordinator = new SocketLivenessCoordinator(clock, () => "probe-1");
		coordinator.register({ id: "root", documentId: "root", isOpen: () => true, sendProbe: () => {}, onFailure: () => {} });
		coordinator.connected("root");
		coordinator.ready("root", SOCKET_LIVENESS_DESCRIPTOR, "runtime-1");
		return timers.map((timer) => timer.delayMs);
	};
	resetClientTimerOverrides();
	assert.deepEqual(run().slice(-1), [SOCKET_LIVENESS_IDLE_MS]);
	installClientTimerOverrides({ livenessIdleMs: 3_000 });
	assert.deepEqual(run().slice(-1), [3_000]);
	resetClientTimerOverrides();
	assert.deepEqual(run().slice(-1), [SOCKET_LIVENESS_IDLE_MS]);
});

await s.done();
