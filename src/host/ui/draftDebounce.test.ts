import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftDebounce, type DraftTimers } from "./draftDebounce";

function fakeTimers(): DraftTimers & { advance(ms: number): void } {
	let now = 0;
	let next = 1;
	const due = new Map<number, { at: number; fn: () => void }>();
	return {
		now: () => now,
		set: (ms, fn) => (due.set(next, { at: now + ms, fn }), next++),
		clear: (h) => void due.delete(h),
		advance(ms) {
			const end = now + ms;
			for (;;) {
				const [h, t] = [...due.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0] ?? [];
				if (h === undefined || !t) break;
				due.delete(h);
				now = t.at;
				t.fn();
			}
			now = end;
		},
	};
}

test("draftDebounce: saves delayMs after the last keystroke", () => {
	const t = fakeTimers();
	let saves = 0;
	const d = new DraftDebounce(t, 600, 3_000, () => saves++);
	d.touch();
	t.advance(500);
	d.touch();
	t.advance(599);
	assert.equal(saves, 0);
	t.advance(1);
	assert.equal(saves, 1);
	assert.equal(d.pending, false);
});

test("draftDebounce: continuous typing still saves within maxWaitMs of the first unsaved keystroke", () => {
	const t = fakeTimers();
	const at: number[] = [];
	const d = new DraftDebounce(t, 600, 3_000, () => at.push(t.now()));
	for (let i = 0; i < 40; i++) {
		d.touch();
		t.advance(200); // a keystroke every 200 ms: the 600 ms debounce alone would never fire
	}
	assert.ok(at.length >= 2, `saves while typing for 8 s: ${at.join(",")}`);
	assert.equal(at[0], 3_000);
});

test("draftDebounce: flushNow saves a pending draft at once and is a no-op without one", () => {
	const t = fakeTimers();
	let saves = 0;
	const d = new DraftDebounce(t, 600, 3_000, () => saves++);
	d.flushNow();
	assert.equal(saves, 0);
	d.touch();
	d.flushNow();
	assert.equal(saves, 1);
	t.advance(10_000);
	assert.equal(saves, 1, "the timer was dropped");
});
