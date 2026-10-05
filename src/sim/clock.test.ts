import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WALL_START_MS, VirtualClock } from "./clock";
import { SeededRandom } from "./random";

test("clock: timers fire in (dueAt, insertion) order; clearTimer; virtual time moves only on fire", async () => {
	const c = new VirtualClock();
	const log: string[] = [];
	c.setTimer(10, () => log.push("a10"));
	c.setTimer(5, () => log.push("b5"));
	const h = c.setTimer(5, () => log.push("cleared"));
	c.setTimer(5, () => log.push("c5"));
	c.setTimer(0, () => log.push("d0"));
	c.clearTimer(h);
	assert.equal(c.monotonic(), 0);
	assert.equal(c.now(), DEFAULT_WALL_START_MS);
	assert.equal(c.pendingTimers(), 4);
	assert.equal(c.nextDueAt(), 0);
	await c.advance(7);
	assert.deepEqual(log, ["d0", "b5", "c5"]);
	assert.equal(c.monotonic(), 7);
	await c.advance(3);
	assert.deepEqual(log, ["d0", "b5", "c5", "a10"]);
	assert.equal(c.monotonic(), 10);
	assert.equal(c.fired, 4);
});

test("clock: promise chains settle between timers; yieldNow / sleep; runUntil and runUntilIdle", async () => {
	const c = new VirtualClock(1000);
	const log: string[] = [];
	const worker = async () => {
		for (let i = 0; i < 3; i++) {
			await Promise.resolve();
			log.push(`w${i}@${c.monotonic()}`);
			await c.sleep(100);
		}
		await c.yieldNow();
		log.push(`done@${c.monotonic()}`);
	};
	void worker();
	c.setTimer(150, () => log.push("t150"));
	const ok = await c.runUntil(() => log.includes("done@300"), 10_000);
	assert.equal(ok, true);
	assert.deepEqual(log, ["w0@0", "w1@100", "t150", "w2@200", "done@300"]);
	assert.equal(c.now(), 1300);
	c.skewWall(-500);
	assert.equal(c.now(), 800);
	assert.equal(c.monotonic(), 300);
	// runUntil with a horizon that passes
	assert.equal(await c.runUntil(() => false, 50), false);
	assert.equal(c.monotonic(), 350);
	// runUntilIdle drains chains of timers
	let n = 0;
	const chain = () => {
		if (++n < 10) c.setTimer(7, chain);
	};
	c.setTimer(1, chain);
	assert.equal(await c.runUntilIdle(), 10);
	assert.equal(n, 10);
	assert.equal(c.pendingTimers(), 0);
	assert.equal(c.monotonic(), 350 + 1 + 9 * 7);
});

test("clock: timer errors go to onError; periodic timers stop at the horizon", async () => {
	const c = new VirtualClock();
	const errors: string[] = [];
	c.onError = (e, label) => errors.push(`${label}:${(e as Error).message}`);
	c.setTimer(1, () => {
		throw new Error("boom");
	}, "bad");
	let ticks = 0;
	const tick = () => {
		ticks++;
		c.setTimer(10, tick, "tick");
	};
	c.setTimer(0, tick, "tick");
	await c.runUntilIdle(95);
	assert.deepEqual(errors, ["bad:boom"]);
	assert.equal(ticks, 10);
	assert.deepEqual(c.pendingLabels(), ["tick@100"]);
});

test("clock: heap stays consistent under heavy set/clear churn (randomized)", async () => {
	const r = new SeededRandom(7);
	const c = new VirtualClock();
	const expected: { at: number; seq: number; id: number }[] = [];
	const fired: number[] = [];
	let seq = 0;
	const live = new Map<number, { at: number; seq: number; id: number }>();
	for (let i = 0; i < 5000; i++) {
		if (live.size > 0 && r.chance(0.4)) {
			const ids = [...live.keys()];
			const id = r.pick(ids);
			c.clearTimer(id);
			live.delete(id);
		} else {
			const at = r.int(1000);
			const s = seq++;
			const id = c.setTimer(at, () => fired.push(s));
			live.set(id, { at, seq: s, id });
		}
	}
	for (const t of live.values()) expected.push(t);
	expected.sort((a, b) => a.at - b.at || a.seq - b.seq);
	await c.runUntilIdle();
	assert.deepEqual(fired, expected.map((t) => t.seq));
});
