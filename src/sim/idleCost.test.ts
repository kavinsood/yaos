/**
 * Idle cost (src/sim/idleCost.ts) with production timers: a desktop and a phone sync a note, settle, then sit for a
 * virtual hour with nothing changing, visible and then with the phone backgrounded (`hidden`). The counts are the
 * wakeups and the work an idle vault costs; the bounds keep them from creeping back up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "./clock";
import { SimDevice } from "./device";
import { measureIdle, productionTuning, type IdleCost } from "./idleCost";
import { SimNet } from "./net";

const HOUR = 60 * 60_000;

async function idleWorld(): Promise<{ clock: VirtualClock; net: SimNet; devs: SimDevice[] }> {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const tuning = productionTuning();
	const devs = [new SimDevice({ name: "desk", clock, net, tuning }), new SimDevice({ name: "phone", clock, net, tuning, mobile: true })];
	devs[0]!.vault.userWrite("notes/a.md", "hello\n");
	for (const d of devs) void d.start();
	await clock.advance(30_000);
	devs[0]!.vault.userWrite("notes/a.md", "hello\nworld\n");
	// Settle every deferred job: settle checkpoints (2 min), the fallback (10-20 min), unbind expiry (10 min).
	await clock.advance(30 * 60_000);
	assert.equal(devs[1]!.vault.textOf("notes/a.md"), "hello\nworld\n", "synced before the idle hour");
	return { clock, net, devs };
}

function report(t: { diagnostic(m: string): void }, label: string, c: IdleCost): void {
	t.diagnostic(`${label}: ${JSON.stringify(c)}`);
}

test("idle cost: an idle hour (desktop + phone, visible, then phone hidden) does no sync work and few wakeups", async (t) => {
	const { clock, net, devs } = await idleWorld();
	const visible = await measureIdle(clock, devs, net, HOUR);
	report(t, "visible hour", visible);
	devs[1]!.platform.visible = false;
	devs[1]!.platform.emit("hidden");
	await clock.advance(60_000);
	const hidden = await measureIdle(clock, devs, net, HOUR);
	report(t, "phone hidden hour", hidden);
	for (const [label, c] of [["visible", visible], ["hidden", hidden]] as const) {
		assert.equal(c.appends, 0, `${label}: nothing appended`);
		assert.equal(c.commits, 0, `${label}: no IndexedDB commit`);
		assert.equal(c.sideWrites, 0, `${label}: no mirror write`);
		// Baseline before the idle backoff and the status dedupe: ~23.9k timers, 7200 ticks, 7200 statuses an hour.
		// Now maintenance ticks every MAINTENANCE_IDLE_MAX_MS (30 s) per device and only changed statuses reach main;
		// the main<->worker ping backs off to PING_IDLE_MAX_MS (60 s). Before those two: ~2,750 timers.
		assert.ok(c.ticks <= 2 * (HOUR / 30_000) + 10, `${label}: ${c.ticks} maintenance ticks`);
		assert.ok(c.statuses <= 40, `${label}: ${c.statuses} status posts`);
		assert.ok(c.timers <= 1_100, `${label}: ${c.timers} timers fired`);
		// The periodic scan lists the vault; it backs off (to an hour) while the listing is unchanged. Before: 18.
		assert.ok(c.lists <= 6, `${label}: ${c.lists} vault listings`);
	}
});

test("idle cost: a runtime that cannot start (fresh device, offline) retries with backoff, and at once when back online", async () => {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	let failures = 0;
	const log = (line: string): void => {
		if (line.includes("runtime start failed")) failures++;
	};
	const d = new SimDevice({ name: "fresh", clock, net, tuning: productionTuning(), log });
	net.setOnline(d.deviceId, false);
	void d.start();
	await clock.advance(HOUR);
	// startRetryMs 1 s (SimDevice) doubling to 5 min: ~9 tries in the first ~8.5 min, then one per 5 min.
	assert.ok(failures >= 5 && failures <= 25, `start attempts in an hour: ${failures} (without the backoff: 3600)`);
	net.setOnline(d.deviceId, true);
	d.platform.online = true;
	d.platform.emit("online");
	await clock.advance(5_000);
	assert.equal(d.ui.statuses.at(-1)?.phase, "live", "started at once when the network came back");
});


test("idle cost: the periodic scan backs off while the vault is unchanged, and a vault event brings it back to base", async () => {
	const { clock, devs } = await idleWorld();
	const desk = devs[0]!;
	await clock.advance(3 * HOUR);
	const listed = (): number => desk.vault.calls.list;
	const before = listed();
	await clock.advance(30 * 60_000);
	assert.ok(listed() - before <= 1, `backed off: ${listed() - before} listings in 30 min (base: 6)`);
	desk.vault.userWrite("notes/b.md", "new\n");
	await clock.advance(1_000);
	const after = listed();
	await clock.advance(5 * 60_000 + 1_000);
	assert.ok(listed() > after, "a scan within the 5 min base interval after the event");
	assert.equal(devs[1]!.vault.textOf("notes/b.md"), "new\n");
});
