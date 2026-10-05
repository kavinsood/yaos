import { test } from "node:test";
import assert from "node:assert/strict";
import { SeededRandom } from "./random";

test("random: pinned sequences (identical to the WP-D stand-in; seeds must keep reproducing)", () => {
	const pins: [number, number[], number, string][] = [
		[0, [4205396811, 3543653536, 1222415357], 1033470986, "zdvg7z"],
		[1, [1828152527, 3394835397, 2967886022], 820763822, "s8714j"],
		[42, [1028872839, 2516511472, 400437680], 4076823954, "hq447q"],
		[0xdeadbeef, [2442117875, 788981206, 3066316946], 1391937072, "zl3vff"],
	];
	for (const [seed, first, forked, token] of pins) {
		const r = new SeededRandom(seed);
		assert.deepEqual([r.u32(), r.u32(), r.u32()], first);
		assert.equal(r.fork("x").u32(), forked);
		assert.equal(r.token(6), token);
	}
});

test("random: ranges, fork independence, shuffle/weighted/exponential sanity", () => {
	const r = new SeededRandom(99);
	const counts = new Array<number>(6).fill(0);
	for (let i = 0; i < 60_000; i++) {
		const f = r.float();
		assert.ok(f >= 0 && f < 1);
		const v = r.range(1, 6);
		counts[v - 1]!++;
	}
	for (const n of counts) assert.ok(n > 9000 && n < 11000, `die face count ${n}`);
	const b = r.bytes(1000);
	assert.equal(b.length, 1000);
	assert.ok(new Set(b).size > 200);
	// fork is a pure function of (seed, label): extra draws on the parent do not shift it
	const p1 = new SeededRandom(5);
	const p2 = new SeededRandom(5);
	p2.u32();
	p2.u32();
	assert.equal(p1.fork("dev-a").u32(), p2.fork("dev-a").u32());
	assert.notEqual(p1.fork("dev-a").u32(), p1.fork("dev-b").u32());
	const arr = Array.from({ length: 50 }, (_, i) => i);
	const sh = r.shuffle(arr.slice());
	assert.deepEqual([...sh].sort((x, y) => x - y), arr);
	assert.notDeepEqual(sh, arr);
	let heads = 0;
	for (let i = 0; i < 10_000; i++) if (r.weighted([["h", 3], ["t", 1], ["never", 0]] as const) === "h") heads++;
	assert.ok(heads > 7000 && heads < 8000);
	let sum = 0;
	for (let i = 0; i < 20_000; i++) sum += r.exponential(10);
	assert.ok(Math.abs(sum / 20_000 - 10) < 0.5);
	assert.throws(() => r.pick([]));
	assert.throws(() => r.weighted([["a", 0]]));
});
