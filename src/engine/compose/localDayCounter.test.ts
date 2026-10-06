import { test } from "node:test";
import assert from "node:assert/strict";
import { localDay, LocalDayCounter } from "./localDayCounter";

test("LocalDayCounter counts within a local day and restarts at local midnight, not UTC midnight", () => {
	const ist = 330; // UTC+5:30
	let now = Date.UTC(2026, 9, 6, 18, 0); // 23:30 local
	const c = new LocalDayCounter(() => localDay(now, ist));
	assert.equal(c.value, 0);
	c.add();
	c.add();
	assert.equal(c.value, 2);
	now = Date.UTC(2026, 9, 6, 18, 29, 59); // 23:59:59 local
	assert.equal(c.value, 2);
	now = Date.UTC(2026, 9, 6, 18, 30); // 00:00 local, still 6 Oct in UTC
	assert.equal(c.value, 0, "local midnight starts a new day");
	c.add();
	now = Date.UTC(2026, 9, 7, 0, 0); // UTC midnight, 05:30 local
	assert.equal(c.value, 1, "UTC midnight is not a boundary");
});

test("localDay: zones west of UTC roll later", () => {
	const t = Date.UTC(2026, 0, 2, 3, 0); // 22:00 on 1 Jan at UTC-5
	assert.equal(localDay(t, -300), localDay(Date.UTC(2026, 0, 1, 12, 0), 0));
	assert.equal(localDay(t, 0), localDay(Date.UTC(2026, 0, 2, 12, 0), 0));
});
