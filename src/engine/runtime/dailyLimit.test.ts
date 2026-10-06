import assert from "node:assert/strict";
import { test } from "node:test";
import type { VaultPath } from "../../core/types";
import { VirtualClock } from "../../sim/clock";
import { SimRelay } from "../../sim/relay";
import { DailyLimitNoticeGate, dailyLimitMessage, nextUtcMidnight } from "./dailyLimit";
import { drive, sleep, startTestEngine, until } from "./testHarness";

const T0 = Date.UTC(2026, 2, 10, 15, 20);

test("dailyLimitMessage: HH:MM UTC when the reset is known (rounded to the minute), the 00:00 UTC reset otherwise", () => {
	assert.match(dailyLimitMessage(Date.UTC(2026, 2, 11, 0, 0) - 4), /paused until 00:00 UTC;/);
	assert.match(dailyLimitMessage(Date.UTC(2026, 2, 10, 9, 5, 10)), /paused until 09:05 UTC;/);
	assert.match(dailyLimitMessage(null), /paused until the daily reset \(00:00 UTC\);/);
	assert.equal(nextUtcMidnight(T0), Date.UTC(2026, 2, 11));
});

test("DailyLimitNoticeGate: one popup per reset window; a later window pops again", () => {
	const g = new DailyLimitNoticeGate();
	const reset = 2 * 3_600_000;
	assert.match(g.trip(T0, reset) ?? "", /until 17:20 UTC/);
	assert.equal(g.trip(T0 + 60_000, reset - 60_000), null, "same window");
	assert.equal(g.trip(T0 + reset - 1, 1), null, "end of the window");
	assert.match(g.trip(T0 + reset, 1_000) ?? "", /until 17:20 UTC/, "window passed: new trip pops");
});

test("DailyLimitNoticeGate: unknown reset holds the window to the next 00:00 UTC", () => {
	const g = new DailyLimitNoticeGate();
	assert.match(g.trip(T0, null) ?? "", /daily reset/);
	assert.equal(g.trip(Date.UTC(2026, 2, 10, 23, 59), null), null);
	assert.notEqual(g.trip(Date.UTC(2026, 2, 11, 0, 0), null), null);
});

test("engine: refused appends raise one daily-limit host notice per window, with the relay's reset time", async () => {
	const clock = new VirtualClock(Date.UTC(2026, 0, 1, 12, 0));
	const relay = new SimRelay({ clock });
	const popups: string[] = [];
	const { engine: a } = await startTestEngine({
		relay, deviceId: "dev-a", clock,
		extra: { onHostNotice: (level, code, message) => popups.push(`${level}:${code}:${message}`) },
	});
	try {
		await until(() => a.status().phase === "live", 5_000, "live", clock);
		relay.setDailyLimit(true, 10 * 60_000);
		const id = await drive(a.createDoc("a.md" as VaultPath, "one"), clock);
		await until(() => a.status().phase === "daily-limit", 10_000, "daily-limit", clock);
		await drive(a.editDoc(id, (t) => t.insert(t.length, " two")), clock);
		await sleep(30_000, clock);
		assert.equal(popups.length, 1, popups.join("\n"));
		assert.match(popups[0] ?? "", /^warn:daily-limit:YAOS: Cloudflare's daily free limit was reached\. Sync is paused until 12:10 UTC;/);
		assert.ok(a.status().notices.some((n) => n.code === "daily-limit"), "status notice still recorded");
		relay.setDailyLimit(false);
		await sleep(10 * 60_000, clock);
		relay.setDailyLimit(true, 60 * 60_000);
		await drive(a.editDoc(id, (t) => t.insert(t.length, " three")), clock);
		await sleep(30_000, clock);
		assert.equal(popups.length, 2, "a new window pops again");
	} finally {
		await drive(a.stop(), clock);
	}
});
