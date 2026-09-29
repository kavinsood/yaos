import { strict as assert } from "node:assert";

import { RemoteCatchUpSchedule, REMOTE_SAFETY_POLL_PERIODS } from "../../packages/cli/src/remotePoll";
import { suite } from "../harness.ts";

// The headless daemon reconciles disk every period, but only polls the
// server's change feed (which wakes the vault Durable Object) when the live
// root socket cannot be trusted to have delivered remote change.

const s = suite("cli-remote-poll");
const PERIOD_MS = 60_000;
const SAFETY_MS = PERIOD_MS * REMOTE_SAFETY_POLL_PERIODS;
const healthy = { rootHealthy: true, outstandingBodies: 0 };

function clock(start = 1_000_000) {
	let now = start;
	return { now: () => now, advance: (ms: number) => { now += ms; } };
}

s.test("a healthy root socket suppresses the per-period poll until the safety interval", () => {
	const time = clock();
	const schedule = new RemoteCatchUpSchedule(SAFETY_MS, time.now, () => 0.5);
	let polls = 0;
	for (let period = 1; period < REMOTE_SAFETY_POLL_PERIODS; period++) {
		time.advance(PERIOD_MS);
		if (schedule.due(healthy) !== null) polls++;
	}
	assert.equal(polls, 0, "no feed poll while the socket is live and nothing is owed");
	time.advance(PERIOD_MS);
	assert.equal(schedule.due(healthy), "safety-interval");
	schedule.recordSuccess();
	assert.equal(schedule.due(healthy), null, "a completed catch-up pushes the safety poll back");
});

s.test("any successful catch-up, e.g. one a live notification triggered, defers the safety poll", () => {
	const time = clock();
	const schedule = new RemoteCatchUpSchedule(SAFETY_MS, time.now, () => 0.5);
	time.advance(SAFETY_MS - PERIOD_MS);
	schedule.recordSuccess();
	time.advance(2 * PERIOD_MS);
	assert.equal(schedule.due(healthy), null);
	time.advance(SAFETY_MS);
	assert.equal(schedule.due(healthy), "safety-interval");
});

s.test("an unhealthy root socket falls back to polling every period", () => {
	const time = clock();
	const schedule = new RemoteCatchUpSchedule(SAFETY_MS, time.now, () => 0.5);
	for (let period = 0; period < 3; period++) {
		time.advance(PERIOD_MS);
		assert.equal(schedule.due({ rootHealthy: false, outstandingBodies: 0 }), "root-socket-unhealthy");
		schedule.recordSuccess();
	}
});

s.test("a failed catch-up or outstanding bodies keep polling until repaired", () => {
	const time = clock();
	const schedule = new RemoteCatchUpSchedule(SAFETY_MS, time.now, () => 0.5);
	schedule.recordFailure();
	time.advance(PERIOD_MS);
	assert.equal(schedule.due(healthy), "catch-up-failed");
	time.advance(PERIOD_MS);
	assert.equal(schedule.due(healthy), "catch-up-failed", "failure persists until a catch-up succeeds");
	schedule.recordSuccess();
	assert.equal(schedule.due(healthy), null);
	assert.equal(schedule.due({ rootHealthy: true, outstandingBodies: 2 }), "outstanding-bodies");
});

s.test("safety deadlines are jittered within ±20% so daemons do not poll in step", () => {
	for (const [random, expected] of [[0, SAFETY_MS * 0.8], [0.5, SAFETY_MS], [0.999_999, SAFETY_MS * 1.2]] as const) {
		const time = clock();
		const schedule = new RemoteCatchUpSchedule(SAFETY_MS, time.now, () => random);
		time.advance(Math.round(expected) - 1_000);
		assert.equal(schedule.due(healthy), null, `random=${random}: not due before the jittered deadline`);
		time.advance(2_000);
		assert.equal(schedule.due(healthy), "safety-interval", `random=${random}: due after the jittered deadline`);
	}
});

await s.done();
