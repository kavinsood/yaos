// SimRelay subscriptions (relay-wire §19, server/src/streams/relay.ts): STREAM_SUBSCRIBE, filtered fan-out with
// inline STREAM_SKIPPED runs, PROVISIONAL only where wanted, own-device rows always pushed, the set across restarts.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StreamName } from "../core/types";
import { VirtualClock } from "./clock";
import { SimRelay } from "./relay";
import { connectPeer, frame, trace } from "./a-relay-testkit";

const S = (s: string) => s as StreamName;

async function setup() {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const w = await connectPeer(relay, clock, "W");
	const r = await connectPeer(relay, clock, "R");
	return { clock, relay, w, r };
}

test("relay subscribe: unsubscribed b:/c: rows become inline skip runs in seq order, before the receipts; vault-global rows are pushed", async () => {
	const { clock, relay, w, r } = await setup();
	r.session.subscribe([S("b:open")]);
	await clock.runUntilIdle();
	relay.pauseCommits();
	w.session.append(frame("b:x", "f1", "a"));
	w.session.append(frame("b:y", "f2", "b"));
	w.session.append(frame("b:open", "f3", "c"));
	w.session.append(frame("b:x", "f4", "d"));
	w.session.append(frame("ns", "f5", "e"));
	await clock.runUntilIdle();
	relay.resumeCommits();
	await clock.runUntilIdle();
	assert.deepEqual(trace(r.events), [
		"provisional f3",
		"skipped b:x@1,b:y@2",
		"committed f3@3",
		"skipped b:x@4",
		"committed f5@5",
	]);
	assert.deepEqual(trace(w.events), ["receipt f1@1", "receipt f2@2", "receipt f3@3", "receipt f4@4", "receipt f5@5", "head 5"]);
	assert.deepEqual(relay.fanout(r.deviceId), { pushedRows: 1, skippedRows: 3 });
	const c = relay.counters();
	assert.deepEqual([c.skippedRows, c.skipFrames, c.subscribes], [3, 2, 1]);
});

test("relay subscribe: a skip run is flushed after the commit, before its receipts; the device's own other socket is never skipped", async () => {
	const { clock, relay, w, r } = await setup();
	const w2 = await connectPeer(relay, clock, "W");
	r.session.subscribe([]);
	w2.session.subscribe([]);
	await clock.runUntilIdle();
	w.session.append(frame("b:x", "f1", "a"));
	r.session.append(frame("b:z", "g1", "z"));
	await clock.runUntilIdle();
	assert.ok(trace(r.events).indexOf("skipped b:x@1") < trace(r.events).indexOf("receipt g1@2"), trace(r.events).join(" | "));
	assert.deepEqual(trace(w2.events), ["provisional f1", "committed f1@1", "skipped b:z@2"], "own device's rows always pushed (PROVISIONAL included)");
});

test("relay subscribe: invalid or too many names are rejected and the previous set kept; read-only sockets may subscribe", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, readOnlyDevices: ["R" as never] });
	const w = await connectPeer(relay, clock, "W");
	const r = await connectPeer(relay, clock, "R");
	r.session.subscribe([S("b:a")]);
	await clock.runUntilIdle();
	r.session.subscribe([S("")]);
	await clock.runUntilIdle();
	assert.deepEqual(relay.subscriptionsOf(r.deviceId), [["b:a"]]);
	assert.throws(() => r.session.subscribe(Array.from({ length: 129 }, (_, i) => S(`b:${i}`))), RangeError, "the adapter refuses over the limit");
	assert.equal(relay.counters().subscribeRejects, 1);
	w.session.append(frame("b:a", "f1", "x"));
	await clock.runUntilIdle();
	assert.deepEqual(trace(r.events), ["provisional f1", "committed f1@1"]);
});

test("relay subscribe: a restart restores a set that fit the attachment; a larger one is lost until STREAM_RESEND makes the client resend it", async () => {
	const { clock, relay, w, r } = await setup();
	const small = [S("b:a")];
	const large = Array.from({ length: 60 }, (_, i) => S(`b:${"x".repeat(20)}${i}`)); // > 1024 B of JSON
	r.session.subscribe(small);
	await clock.runUntilIdle();
	relay.restart();
	assert.deepEqual(relay.subscriptionsOf(r.deviceId), [["b:a"]], "restored from the attachment");
	await clock.runUntilIdle();

	r.session.subscribe(large);
	await clock.runUntilIdle();
	relay.restart();
	assert.deepEqual(relay.subscriptionsOf(r.deviceId), [null], "overflowed: every stream");
	w.session.append(frame("b:other", "f1", "x"));
	await clock.runUntilIdle();
	assert.equal(relay.subscriptionsOf(r.deviceId)[0]?.length, 60, "resent on STREAM_RESEND");
	w.session.append(frame("b:other", "f2", "y"));
	await clock.runUntilIdle();
	const live = trace(r.events).filter((e) => e.startsWith("skipped") || e.startsWith("committed") || e.startsWith("provisional"));
	assert.deepEqual(live.slice(-1), ["skipped b:other@2"], "filtered again after the resend");
});
