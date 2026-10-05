import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceId, StreamName } from "../core/types";
import { VirtualClock } from "./clock";
import { SimRelay } from "./relay";
import { connectPeer, connectRaw, frame, pump, trace } from "./a-relay-testkit";

const ns = "ns" as StreamName;

test("relay close: payload > maxFrameBytes -> 1009; raw message > max+1024 -> 1009; invalid stream / frame id -> 1008", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, limits: { maxFrameBytes: 100 } });
	const cases: [string, string, number, number][] = [
		["ns", "big", 101, 1009], // passes the raw charge, fails the payload check
		["ns", "huge", 1200, 1009], // raw cap
		["", "f", 1, 1008],
		["x".repeat(257), "f", 1, 1008],
		["ns", "", 1, 1008],
		["ns", "y".repeat(129), 1, 1008],
	];
	for (const [stream, id, size, code] of cases) {
		const p = await connectPeer(relay, clock, "A");
		p.session.append(frame("ns", "ok", 100));
		p.session.append(frame(stream, id, size));
		p.session.append(frame("ns", "after", 1)); // the socket is closed: dropped
		await clock.runUntilIdle();
		assert.deepEqual(trace(p.events), [`closed ${code}`], `${stream.length}/${id.length}/${size}`);
	}
	assert.deepEqual(relay.rows(ns).map((r) => r.clientFrameId), ["ok"], "admitted frames still commit; the first dedupes the rest");
	const c = relay.counters();
	assert.deepEqual([c.oversizeCloses, c.policyCloses, c.storeDedupes, c.rawDrops], [2, 4, 5, 1]);
	assert.equal(relay.sessions().length, 0);
});

test("relay close: token bucket — refill at rate, overdraft -> backpressure + 1013; admitted frames commit, the rest is dropped", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, limits: { burstBytes: 100, appendBytesPerSec: 1000 } });
	const a = await connectPeer(relay, clock, "A");
	const b = await connectPeer(relay, clock, "B");
	// each message is 1 + 3 + 3 + 1 + 40 = 48 bytes
	a.session.append(frame("ns", "f1", 40));
	a.session.append(frame("ns", "f2", 40));
	await clock.advance(50); // +50 tokens: 4 + 50 = 54
	a.session.append(frame("ns", "f3", 40));
	await clock.advance(1);
	a.session.append(frame("ns", "f4", 40)); // 7 tokens: overdraft
	a.session.append(frame("ns", "f5", 1));
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events), ["backpressure", "closed 1013"]);
	assert.deepEqual(trace(b.events), ["committed f1@1", "committed f2@2", "committed f3@3"]);
	const c = relay.counters();
	assert.deepEqual([c.rateCloses, c.rawDrops], [1, 1]);
	relay.backpressure("B" as DeviceId);
	await clock.runUntilIdle();
	assert.deepEqual(trace(b.events).slice(3), ["backpressure", "closed 1013"]);
});

test("relay: read-only members get write_forbidden and checkpoint forbidden; setReadOnly applies to new sessions", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, readOnlyDevices: ["R" as DeviceId] });
	const r = await connectPeer(relay, clock, "R");
	assert.equal(r.session.canWrite, false);
	r.session.append(frame("ns", "w1", "x"));
	await clock.runUntilIdle();
	assert.deepEqual(trace(r.events), ["refused w1 forbidden"]);
	assert.deepEqual(await pump(clock, r.session.putCheckpoint(ns, 1, 0, new Uint8Array(1))), { t: "refused", reason: "forbidden", retryAfterMs: null });
	assert.equal(relay.counters().writeForbidden, 1);
	relay.setReadOnly("R" as DeviceId, false);
	const r2 = await connectPeer(relay, clock, "R");
	assert.equal(r2.session.canWrite, true);
	assert.deepEqual(relay.sessions().map((s) => [s.id, s.canWrite]), [[1, false], [2, true]]);
	relay.setReadOnly("W" as DeviceId, true);
	assert.equal((await connectPeer(relay, clock, "W")).session.canWrite, false);
});

test("relay: supersede commits first then 4403 authority_superseded; paused -> no commit; revoke -> unauthorized until unrevoke", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const a = await connectPeer(relay, clock, "A");
	const b = await connectPeer(relay, clock, "B");
	a.session.append(frame("ns", "n1", "x"));
	await clock.advance(10);
	relay.supersede("A" as DeviceId);
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events), ["receipt n1@1", "head 1", "closed 4403 authority_superseded"]);
	assert.deepEqual(trace(b.events), ["committed n1@1"]);

	const a2 = await connectPeer(relay, clock, "A");
	relay.pauseCommits();
	a2.session.append(frame("ns", "n2", "x"));
	await clock.advance(1000);
	relay.supersede(a2.session.id);
	await clock.runUntilIdle();
	assert.deepEqual(trace(a2.events), ["closed 4403 authority_superseded"]);
	assert.equal(relay.pendingCount(), 1);
	relay.resumeCommits();
	await clock.runUntilIdle();
	assert.deepEqual(trace(b.events), ["committed n1@1", "committed n2@2"]);

	relay.revoke("B" as DeviceId);
	await clock.runUntilIdle();
	assert.deepEqual(trace(b.events).slice(2), ["closed 4403 authority_superseded"]);
	assert.deepEqual(await connectRaw(relay, clock, "B"), { ok: false, reason: "unauthorized", retryAfterMs: null });
	relay.unrevoke("B" as DeviceId);
	assert.ok((await connectRaw(relay, clock, "B")).ok);
	assert.equal(relay.counters().authorityCloses, 3);
});

test("relay: dropSession loses in-flight messages both ways (1006 unclean); drain commits then closes 1001", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, link: { uplinkMs: 50, downlinkMs: 50 } });
	const a = await connectPeer(relay, clock, "A");
	const b = await connectPeer(relay, clock, "B");
	a.session.append(frame("ns", "lost", "x"));
	await clock.advance(10);
	assert.ok(a.session.bufferedBytes() > 0);
	relay.dropSession("A" as DeviceId);
	assert.equal(a.session.bufferedBytes(), 0);
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events), ["closed 1006 unclean"]);
	assert.equal(relay.head(), 0);

	const c = await connectPeer(relay, clock, "C");
	c.session.append(frame("ns", "n1", "x"));
	await clock.runUntil(() => relay.head() === 1, 10_000); // committed; the broadcast to B is on the downlink
	relay.dropSession("B" as DeviceId, 4000);
	c.session.append(frame("ns", "n2", "y"));
	await clock.advance(60);
	relay.drain();
	await clock.runUntilIdle();
	assert.deepEqual(trace(b.events), ["closed 4000 unclean"]);
	assert.deepEqual(trace(c.events), ["receipt n1@1", "head 1", "receipt n2@2", "head 2", "closed 1001"]);
	assert.deepEqual(relay.sessions(), []);
});

test("relay connect: one-shot failures first, then the persistent one; maxSockets -> unavailable; resetEpoch wipes and closes 1001", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, maxSockets: 1, vaultEpoch: "e1" as never });
	relay.failNextConnect("superseded");
	relay.failNextConnect("update-required");
	relay.setConnectFailure("unavailable", 5000);
	const reasons = [];
	for (let i = 0; i < 3; i++) {
		const r = await connectRaw(relay, clock, "A");
		reasons.push(r.ok ? "ok" : `${r.reason}:${r.retryAfterMs}`);
	}
	relay.setConnectFailure(null);
	const a = await connectPeer(relay, clock, "A");
	reasons.push(`${(await connectRaw(relay, clock, "B")).ok}`);
	assert.deepEqual(reasons, ["superseded:null", "update-required:null", "unavailable:5000", "false"]);
	assert.equal(a.session.vaultEpoch, "e1");
	a.session.append(frame("ns", "n1", "x"));
	await clock.runUntilIdle();
	a.session.append(frame("ns", "n2", "x"));
	await clock.advance(10);
	relay.resetEpoch("e2" as never);
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events), ["receipt n1@1", "head 1", "closed 1001"]);
	assert.deepEqual([relay.head(), relay.pendingCount(), relay.streams().length, relay.vaultEpoch()], [0, 0, 0, "e2"]);
	const b = await connectPeer(relay, clock, "B");
	assert.deepEqual([b.session.vaultEpoch, b.session.headSeq], ["e2", 0]);
});

test("relay link: jitter keeps per-socket FIFO; uplinkBytesPerSec serializes (bufferedBytes drains); ping and inject", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, seed: 7, link: { uplinkMs: 10, downlinkMs: 10, jitterMs: 100 } });
	const a = await connectPeer(relay, clock, "A");
	const b = await connectPeer(relay, clock, "B");
	for (let i = 0; i < 20; i++) a.session.append(frame("ns", `f${i}`, "x"));
	await clock.runUntilIdle();
	assert.deepEqual(relay.rows(ns).map((r) => r.clientFrameId), Array.from({ length: 20 }, (_, i) => `f${i}`));
	assert.deepEqual(b.seqs(), Array.from({ length: 20 }, (_, i) => i + 1));

	relay.setLink("A" as DeviceId, { uplinkBytesPerSec: 1000 });
	const t = clock.monotonic();
	const commits: number[] = [];
	relay.onCommit(() => commits.push(clock.monotonic() - t));
	a.session.append(frame("ns", "u1", 92)); // 1 + 3 + 3 + 1 + 92 = 100 bytes
	a.session.append(frame("ns", "u2", 92));
	assert.equal(a.session.bufferedBytes(), 200);
	await clock.advance(100);
	assert.equal(a.session.bufferedBytes(), 100);
	await clock.advance(100);
	assert.equal(a.session.bufferedBytes(), 0);
	await clock.runUntilIdle();
	assert.deepEqual(commits, [500], "second frame arrived at +200, idle commit at +500");

	relay.ping(a.session.id);
	relay.inject("A" as DeviceId, { t: "backpressure" });
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events).slice(-2), ["head 22", "backpressure"]);
	assert.equal(relay.session(a.session.id), a.session);
});
