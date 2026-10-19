/**
 * SimRelay vs the real server relay (server/src/streams/relay.ts) and the real client adapter
 * (src/engine/adapters/wsRelay.ts, relayHttp.ts): one test per divergence the wrapper audit fixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seq, StreamName } from "../core/types";
import type { ReadRequest } from "../ports/relay";
import { READ_BATCH_MAX_QUERY_CHARS } from "../engine/adapters/relayHttp";
import { VirtualClock } from "./clock";
import { SimRelay, type SimCommitInfo } from "./relay";
import { connectPeer, frame, pump, trace } from "./a-relay-testkit";

test("parity: append() over maxFrameBytes throws RangeError like wsRelay (nothing sent), also on a closed session", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, limits: { maxFrameBytes: 100 } });
	const a = await connectPeer(relay, clock, "A");
	assert.throws(() => a.session.append(frame("ns", "big", 101)), RangeError);
	assert.equal(a.session.bufferedBytes(), 0);
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events), [], "the socket stays open: no 1009");
	assert.equal(relay.counters().oversizeCloses, 0);
	a.session.close(1000, "done");
	assert.throws(() => a.session.append(frame("ns", "big2", 101)), RangeError);
});

test("parity: the rate bucket is the device's, shared by its sockets (server H6 buckets by deviceId)", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, limits: { burstBytes: 100, appendBytesPerSec: 1000 } });
	const a1 = await connectPeer(relay, clock, "A");
	const a2 = await connectPeer(relay, clock, "A");
	const b = await connectPeer(relay, clock, "B");
	// each message is 48 bytes: two fit the 100-byte burst, a third from either socket of A overdraws it
	a1.session.append(frame("ns", "f1", 40));
	a2.session.append(frame("ns", "f2", 40));
	a2.session.append(frame("ns", "f3", 40));
	b.session.append(frame("ns", "g1", 40)); // B's own bucket
	await clock.runUntilIdle();
	assert.deepEqual(trace(a2.events).slice(-2), ["backpressure", "closed 1013"]);
	assert.ok(!trace(a1.events).includes("closed 1013"), "only the overdrawing socket closes");
	assert.deepEqual(relay.rows("ns" as StreamName).map((r) => r.clientFrameId), ["f1", "f2", "g1"]);
});

test("parity: text messages are charged in UTF-16 units (pings too); a text message over 64 KiB closes 1009", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, limits: { burstBytes: 60, appendBytesPerSec: 1000 } });
	const a = await connectPeer(relay, clock, "A");
	// VAULT_PING `__YPS:{"type":"VAULT_PING","probeId":"p1"}` is 42 units: the second one overdraws 60
	void a.session.ping().catch(() => undefined);
	void a.session.ping().catch(() => undefined);
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events), ["head 0", "backpressure", "closed 1013"]);

	const relay2 = new SimRelay({ clock });
	const b = await connectPeer(relay2, clock, "B");
	const huge = Array.from({ length: 128 }, (_, i) => `b:${String(i).padStart(3, "0")}${"x".repeat(600)}`); // ~77K units (invalid names, but the size check comes first)
	b.session.subscribe(huge as StreamName[]);
	await clock.runUntilIdle();
	assert.deepEqual(trace(b.events), ["closed 1009"]);
});

test("parity: a device at 4 sockets has its oldest closed 1001 on the next connect (MAX_STREAM_SOCKETS_PER_DEVICE)", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const peers = [];
	for (let i = 0; i < 5; i++) peers.push(await connectPeer(relay, clock, "A"));
	await connectPeer(relay, clock, "B");
	await clock.runUntilIdle();
	assert.deepEqual(trace(peers[0]!.events), ["closed 1001"]);
	for (const p of peers.slice(1)) assert.deepEqual(trace(p.events), []);
	assert.equal(relay.sessions().filter((s) => s.deviceId === "A").length, 4);
});

test("parity: readBatch sends only the requests that fit relayHttp's URL query budget (a prefix)", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const a = await connectPeer(relay, clock, "A");
	const streams = Array.from({ length: 100 }, (_, i) => `b:${String(i).padStart(3, "0")}${"q".repeat(80)}` as StreamName);
	for (const s of streams) a.session.append(frame(s, `f-${s.slice(2, 5)}`, 1));
	await pump(clock, relay.flush());
	const reqs: ReadRequest[] = streams.map((stream) => ({ stream, afterSeq: 0 as Seq, preferCheckpoint: false }));
	const pages = await pump(clock, a.session.readBatch(reqs));
	// relayHttp: `maxBytes=<n>` then `&r=<after>.<0|1>.<encoded stream>` while the query stays within the budget
	let q = `maxBytes=${relay.limits.readPageBytes}`.length;
	let fit = 0;
	for (const s of streams) {
		const entry = `r=0.0.${encodeURIComponent(s)}`.length + 1;
		if (fit > 0 && q + entry > READ_BATCH_MAX_QUERY_CHARS) break;
		q += entry;
		fit++;
	}
	assert.ok(fit < streams.length && fit < relay.limits.readBatchStreams);
	assert.equal(pages.length, fit);
	assert.deepEqual(pages.map((p) => p.rows[0]!.seq), streams.slice(0, pages.length).map((_, i) => i + 1));
});

test("parity: read pages travel through the binary read reply codec (payloads and cursors intact)", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, limits: { readPageBytes: 5 } });
	const a = await connectPeer(relay, clock, "A");
	for (let i = 0; i < 3; i++) a.session.append(frame("cfg", `c${i}`, [i, i, i]));
	await pump(clock, relay.flush());
	const p1 = await pump(clock, a.session.read("cfg" as StreamName, 0, false));
	assert.deepEqual([p1.rows.map((r) => Array.from(r.payload)), p1.more, p1.nextAfterSeq, p1.lastSeq], [[[0, 0, 0]], true, 1, 3]);
	const p2 = await pump(clock, a.session.read("cfg" as StreamName, p1.nextAfterSeq, false));
	assert.deepEqual([p2.rows.map((r) => r.clientFrameId), p2.more, p2.nextAfterSeq], [["c1"], true, 2]);
	const none = await pump(clock, a.session.read("nope" as StreamName, 7, false));
	assert.deepEqual([none.rows.length, none.lastSeq, none.nextAfterSeq, none.more], [0, 0, 7, false]);
});

test("parity: server group-commit leading edge and min interval (opt-in: leadMs 20, quietMs 1500, minIntervalMs 1000)", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, groupCommit: { minIntervalMs: 1000, leadMs: 20, quietMs: 1500 } });
	const commits: { at: number; info: SimCommitInfo }[] = [];
	relay.onCommit((info) => commits.push({ at: clock.monotonic(), info }));
	const a = await connectPeer(relay, clock, "A");
	const t0 = clock.monotonic();
	a.session.append(frame("ns", "l1", "x"));
	await clock.runUntilIdle();
	a.session.append(frame("ns", "l2", "x")); // inside quietMs: no lead; the idle window, held to 1000 ms after the last commit
	await clock.runUntilIdle();
	assert.deepEqual(commits.map((c) => [c.at - t0, c.info.reason]), [[20, "lead"], [1020, "idle"]]);
});
