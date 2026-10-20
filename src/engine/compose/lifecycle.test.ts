import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "../../sim/clock";
import { SIM_SETTINGS, SimDevice } from "../../sim/device";
import { SimNet } from "../../sim/net";
import type { SimRelaySession } from "../../sim/a-relay-session";
import { RESUME_PROBE_TIMEOUT_MS } from "../../core/limits";
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

test("phone hidden: background work pauses at once, the socket closes (1000) after 30 s without offline or backoff; visible reconnects and catches up", async () => {
	const { clock, net, a, b } = await world(true);
	assert.equal(connected(net, a), true);
	const seen = a.ui.statuses.length;
	a.platform.emit("hidden");
	b.vault.userWrite("from-b.md", "while hidden\n");
	await clock.advance(HIDDEN_CLOSE_MS - 1_000);
	assert.equal(connected(net, a), true, "socket kept for 30 s");
	assert.equal(a.vault.textOf("from-b.md"), null, "materialization waits while hidden");
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
	assert.equal(a.ui.statuses[a.ui.statuses.length - 1]?.maxBlobBytes, net.blobs.maxBlobBytes, "posted to the host");
	const none = await world(false, false);
	assert.equal(vrt(none.a).status().maxBlobBytes, 0);
	assert.equal(none.a.ui.statuses[none.a.ui.statuses.length - 1]?.maxBlobBytes, 0, "posted to the host");
});

const c0 = (d: SimDevice) => vrt(d).log.c;

/** A's open session (the sim relay's object), or null. */
function sessionOf(net: SimNet, d: SimDevice): SimRelaySession | null {
	const info = net.relay.sessions().filter((s) => s.deviceId === d.deviceId).at(-1); // newest: a dead one may linger
	return info ? net.relay.session(info.id) : null;
}

test("visible with a socket that died silently while suspended: one probe ping, no pong in 5 s, reconnect at once (F6)", async () => {
	const { clock, net, a, b } = await world(false);
	const dead = sessionOf(net, a);
	assert.ok(dead);
	// iOS drops a suspended app's socket without a close: nothing it sends or would receive arrives.
	dead.link = { uplinkMs: 1e12, downlinkMs: 1e12 };
	a.platform.emit("visible");
	await clock.advance(RESUME_PROBE_TIMEOUT_MS - 500);
	assert.equal(sessionOf(net, a)?.id, dead.id, "a healthy-looking session is kept until the probe times out");
	await clock.advance(3_000);
	const fresh = sessionOf(net, a);
	assert.ok(fresh && fresh.id !== dead.id, "reconnected after the probe timed out");
	assert.equal(vrt(a).log.c.lastCloseCode, 4000, "closed as dead (liveness)");
	b.vault.userWrite("after.md", "resumed\n");
	await clock.advance(5_000);
	assert.equal(a.vault.textOf("after.md"), "resumed\n");
});

test("visible with a healthy socket keeps it (the probe's pong arrives)", async () => {
	const { clock, net, a } = await world(false);
	const s = sessionOf(net, a);
	a.platform.emit("visible");
	await clock.advance(RESUME_PROBE_TIMEOUT_MS * 3);
	assert.equal(sessionOf(net, a)?.id, s?.id);
});

test("a relay that drops the socket right after live backs off instead of retrying at 0-1 s; a session that stayed up resets it (F11)", async () => {
	const { clock, net, a } = await world(false);
	let drops = 0;
	for (let t = 0; t < 120_000; t += 100) {
		if (sessionOf(net, a) && vrt(a).log.c.livePhase() === a.ui.statuses.at(-1)?.phase) {
			net.relay.dropSession(a.deviceId);
			drops++;
		}
		await clock.advance(100);
	}
	// Without carrying the backoff over a short session: a reconnect every ~0.5-1 s, ~100+ drops in 2 min.
	assert.ok(drops >= 3 && drops <= 15, `drops in 2 min: ${drops}`);
	await clock.advance(6 * 60_000); // reconnects (backoff <= 5 min) and stays up past SESSION_STABLE_MS
	assert.ok(sessionOf(net, a), "connected again");
	const before = c0(a).sess.stats.sessions;
	net.relay.dropSession(a.deviceId);
	await clock.advance(1_500);
	assert.equal(c0(a).sess.stats.sessions, before + 1, "a stable session's close retries on a fresh backoff (< 1 s)");
});

test("an attachment upload backing off while the store is unreachable retries at once on online, not after its backoff (F7)", async () => {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const settings = () => ({ ...SIM_SETTINGS, syncAttachments: true, maxAttachmentBytes: 8 * 1024 * 1024 });
	const a = new SimDevice({ name: "A", clock, net, settings });
	const b = new SimDevice({ name: "B", clock, net, settings });
	void a.start();
	void b.start();
	await clock.advance(5_000);
	let down = true;
	net.blobs.hooks = { fail: (route) => (down && (route === "has" || route === "put") ? new Error("sim: network unreachable") : null) };
	const pic = Uint8Array.from({ length: 4_000 }, (_, i) => (i * 7 + 3) & 0xff);
	a.vault.externalWrite("img/x.png", pic);
	// 2 + 4 + ... + 64 s: the 7th failure waits 128 s.
	await clock.advance(140_000);
	const up = vrt(a).blobs.queued().find((t) => t.direction === "up");
	assert.ok(up && up.attempts >= 6, `backing off: ${JSON.stringify(up)}`);
	assert.ok(vrt(a).blobs.nextDueInMs()! > 30_000, `next retry far out: ${vrt(a).blobs.nextDueInMs()}`);
	a.setOnline(false);
	await clock.advance(1_000);
	down = false;
	a.setOnline(true);
	await clock.advance(5_000);
	assert.equal(vrt(a).blobs.queued().length, 0, "uploaded on the network-back wake");
	await clock.advance(5_000);
	assert.deepEqual(b.vault.bytesOf("img/x.png"), pic, "and reached B");
});
