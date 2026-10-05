import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWebClock } from "./webClock";

describe("webClock", () => {
	it("now is wall time and monotonic never decreases", () => {
		const clock = createWebClock();
		assert.ok(Math.abs(clock.now() - Date.now()) < 1000);
		let last = clock.monotonic();
		for (let i = 0; i < 1000; i++) {
			const t = clock.monotonic();
			assert.ok(t >= last);
			last = t;
		}
	});

	it("setTimer fires once; clearTimer cancels", async () => {
		const clock = createWebClock();
		const fired: string[] = [];
		clock.setTimer(5, () => fired.push("a"));
		const b = clock.setTimer(5, () => fired.push("b"));
		clock.clearTimer(b);
		clock.clearTimer(9999);
		await new Promise((r) => setTimeout(r, 30));
		assert.deepEqual(fired, ["a"]);
	});

	it("yieldNow resolves after a macrotask", async () => {
		const clock = createWebClock();
		const order: string[] = [];
		const p = clock.yieldNow().then(() => order.push("yield"));
		void Promise.resolve().then(() => order.push("microtask"));
		await p;
		assert.deepEqual(order, ["microtask", "yield"]);
		for (let i = 0; i < 50; i++) await clock.yieldNow();
	});
});
