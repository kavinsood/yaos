import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "../../sim/clock";
import { SimDevice } from "../../sim/device";
import { SimNet } from "../../sim/net";
import { HIDDEN_CLOSE_MS, type VaultRuntime } from "./vaultRuntime";

async function world(mobileA: boolean, blobs = true): Promise<{ clock: VirtualClock; net: SimNet; a: SimDevice; b: SimDevice }> {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	net.blobsAvailable = blobs;
	const a = new SimDevice({ name: "A", clock, net, mobile: mobileA });
	const b = new SimDevice({ name: "B", clock, net });
	void a.start();
	void b.start();
	await clock.advance(5_000);
	return { clock, net, a, b };
}

function vrt(d: SimDevice): VaultRuntime {
	assert.ok(d.vrt, "vault runtime running");
	return d.vrt;
}
const connected = (net: SimNet, d: SimDevice): boolean => net.relay.sessions().some((s) => s.deviceId === d.deviceId);
const phases = (d: SimDevice, from: number): string[] => d.ui.statuses.slice(from).map((s) => s.phase);

test("phone hidden: lanes 3-4 pause at once, the socket closes (1000) after 30 s without offline or backoff; visible reconnects and catches up", async () => {
	const { clock, net, a, b } = await world(true);
	assert.equal(connected(net, a), true);
	const seen = a.ui.statuses.length;
	a.platform.emit("hidden");
	b.vault.userWrite("from-b.md", "while hidden\n");
	await clock.advance(HIDDEN_CLOSE_MS - 1_000);
	assert.equal(connected(net, a), true, "socket kept for 30 s");
	assert.equal(a.vault.textOf("from-b.md"), null, "materialization (lane 3) waits while hidden");
	await clock.advance(2_000);
	assert.equal(connected(net, a), false, "socket closed after 30 s hidden");
	const closes = vrt(a).log.c.lastCloseCode;
	assert.equal(closes, 1000);
	await clock.advance(120_000);
	assert.equal(connected(net, a), false, "no reconnect while backgrounded");
	assert.equal(vrt(a).log.c.sess.reconnectAtMono, null, "no backoff armed");
	assert.ok(!phases(a, seen).some((p) => p === "offline" || p === "error"), `phases: ${phases(a, seen).join(",")}`);
	a.platform.emit("visible");
	await clock.advance(3_000);
	assert.equal(connected(net, a), true, "visible reconnects at once");
	assert.equal(a.vault.textOf("from-b.md"), "while hidden\n", "feed + full pass after visible");
});

test("desktop hidden keeps the socket and keeps syncing to disk; pagehide closes at once; visible reconnects", async () => {
	const { clock, net, a, b } = await world(false);
	a.platform.emit("hidden");
	b.vault.userWrite("d.md", "desk\n");
	await clock.advance(HIDDEN_CLOSE_MS * 3);
	assert.equal(connected(net, a), true);
	assert.equal(a.vault.textOf("d.md"), "desk\n", "an occluded desktop window still syncs");
	const seen = a.ui.statuses.length;
	a.platform.emit("pagehide");
	await clock.advance(100);
	assert.equal(connected(net, a), false, "pagehide closes the socket at once");
	await clock.advance(60_000);
	assert.equal(connected(net, a), false);
	assert.ok(!phases(a, seen).some((p) => p === "offline" || p === "error"), `phases: ${phases(a, seen).join(",")}`);
	a.platform.emit("visible");
	await clock.advance(1_000);
	assert.equal(connected(net, a), true);
});

test("offline stops reconnect attempts while the outbox grows; online connects at once", async () => {
	const { clock, net, a, b } = await world(false);
	a.setOnline(false);
	await clock.advance(1_000);
	const failures = vrt(a).log.c.sess.stats.connectFailures;
	a.vault.userWrite("off.md", "queued\n");
	await clock.advance(300_000);
	assert.equal(vrt(a).log.c.sess.stats.connectFailures, failures, "no attempts while offline");
	assert.equal(vrt(a).log.c.sess.reconnectAtMono, null);
	assert.ok(vrt(a).log.status().counts.outboxFrames > 0, "outbox keeps accumulating");
	assert.equal(b.vault.textOf("off.md"), null);
	a.platform.emit("visible");
	await clock.advance(60_000);
	assert.equal(vrt(a).log.c.sess.stats.connectFailures, failures + 1, "visible tries once even while offline (a missed online event)");
	assert.equal(vrt(a).log.c.sess.reconnectAtMono, null, "and arms no backoff");
	a.setOnline(true);
	await clock.advance(1_500);
	assert.equal(connected(net, a), true, "online connects without waiting for backoff");
	await clock.advance(3_000);
	assert.equal(b.vault.textOf("off.md"), "queued\n");
});

test("the user's pause wins over visible and online", async () => {
	const { clock, net, a } = await world(false);
	vrt(a).setPaused(true);
	await clock.advance(1_000);
	assert.equal(connected(net, a), false);
	a.platform.emit("visible");
	a.platform.emit("online");
	await clock.advance(10_000);
	assert.equal(connected(net, a), false, "still paused");
	assert.equal(vrt(a).status().phase, "paused");
	vrt(a).setPaused(false);
	await clock.advance(1_000);
	assert.equal(connected(net, a), true);
});

test("status reports the blob store's attachment limit (0 without a store) and the host receives it", async () => {
	const { a, net } = await world(false);
	assert.equal(vrt(a).status().maxBlobBytes, net.blobs.maxBlobBytes);
	assert.equal(vrt(a).status().maxBlobBytes, vrt(a).blobs.maxBlobBytes);
	assert.equal(a.ui.statuses.at(-1)?.maxBlobBytes, net.blobs.maxBlobBytes, "posted to the host");
	const none = await world(false, false);
	assert.equal(vrt(none.a).status().maxBlobBytes, 0);
	assert.equal(none.a.ui.statuses.at(-1)?.maxBlobBytes, 0, "posted to the host");
});
