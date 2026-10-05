import { test } from "node:test";
import assert from "node:assert/strict";
import type { StreamName } from "../core/types";
import { VirtualClock } from "./clock";
import { SimRelay } from "./relay";
import { connectPeer, frame, pump, trace } from "./a-relay-testkit";

const ns = "ns" as StreamName;
const DAY = 86_400_000;

test("relay restart: buffer lost unacked, STREAM_RESEND{head} to every socket, held provisionals cleared; resends append", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const a = await connectPeer(relay, clock, "A");
	const b = await connectPeer(relay, clock, "B");
	a.session.append(frame("b:x", "p1", "v"));
	a.session.append(frame("ns", "n1", "op"));
	await clock.advance(10);
	assert.equal(relay.pendingCount(), 2);
	relay.restart();
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events), ["resend 0"]);
	assert.deepEqual(trace(b.events), ["provisional p1", "resend 0"]);
	assert.equal(relay.head(), 0);
	assert.deepEqual([relay.counters().droppedPending, relay.counters().wakeNotices], [2, 2]);
	a.session.append(frame("b:x", "p1", "v"));
	a.session.append(frame("ns", "n1", "op"));
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events).slice(1), ["receipt p1@1", "receipt n1@2", "head 2"]);
	assert.deepEqual(trace(b.events).slice(2), ["provisional p1", "committed p1@1", "committed n1@2"]);
	assert.ok(relay.quiescent());
});

test("relay faults: restart-after writes rows without fan-out — resends dedupe to the original seq, peers recover via feed; hook picks per commit", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const a = await connectPeer(relay, clock, "A");
	const b = await connectPeer(relay, clock, "B");
	const faults = ["restart-before", "commit", "restart-after"] as const;
	const seen: string[] = [];
	relay.setCommitHook(({ index, reason, frames }) => {
		seen.push(`${index}:${reason}:${frames}`);
		return faults[index] ?? "commit";
	});
	a.session.append(frame("ns", "n1", "op"));
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events), ["resend 0"]);
	a.session.append(frame("ns", "n1", "op"));
	await clock.runUntilIdle();
	a.session.append(frame("ns", "n2", "op2"));
	await clock.runUntilIdle();
	assert.equal(relay.head(), 2);
	assert.deepEqual(trace(a.events).slice(1), ["receipt n1@1", "head 1", "resend 2"]);
	assert.deepEqual(trace(b.events), ["resend 0", "committed n1@1", "resend 2"]);
	a.session.append(frame("ns", "n2", "op2"));
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events).slice(4), ["receipt n2@2 dedup", "head 2"]);
	assert.equal(b.events.length, 3, "deduped commit-only frame: not re-delivered");
	const page = await pump(clock, b.session.feed(1));
	assert.deepEqual(page.entries, [{ stream: ns, lastSeq: 2 }]);
	assert.deepEqual(seen, ["0:idle:1", "1:idle:1", "2:idle:1", "3:idle:1"]);
	relay.setCommitHook(null);
});

test("relay faults: durability failure refuses every frame of the commit (one VAULT_ERROR per socket+stream), holders drop; later commits fine", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const a = await connectPeer(relay, clock, "A");
	const b = await connectPeer(relay, clock, "B");
	a.session.append(frame("b:x", "p1", "v"));
	a.session.append(frame("ns", "n1", "op"));
	a.session.append(frame("ns", "n2", "op"));
	relay.failNextCommit("durability");
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events), ["refused p1 durability", "refused n1 durability", "refused n2 durability"]);
	assert.deepEqual(a.of("refused").map((e) => e.retryAfterMs), [null, null, null]);
	assert.deepEqual(trace(b.events), ["provisional p1", "dropped p1"]);
	assert.equal(relay.head(), 0);
	a.session.append(frame("ns", "n1", "op"));
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events).slice(3), ["receipt n1@1", "head 1"]);
	assert.deepEqual([relay.counters().commitFailures, relay.counters().commits], [1, 1]);
});

test("relay daily limit (latch): commit fails until 00:00 UTC; later appends refused up front; checkpoint 503; feed/read work; clears at resetAt or restart", async () => {
	const clock = new VirtualClock(); // starts at 2026-01-01T00:00:00Z
	const relay = new SimRelay({ clock });
	const a = await connectPeer(relay, clock, "A");
	a.session.append(frame("ns", "n0", "ok"));
	await clock.runUntilIdle();
	const t0 = clock.now();
	a.session.append(frame("ns", "n1", "op"));
	relay.failNextCommit("daily-limit");
	await clock.runUntilIdle();
	const failedAt = clock.now();
	assert.equal(failedAt - t0, 300);
	assert.deepEqual(trace(a.events).slice(2), ["refused n1 daily-limit"]);
	assert.equal(a.of("refused")[0]!.retryAfterMs, DAY - (failedAt - Date.UTC(2026, 0, 1)));
	assert.ok(relay.dailyLimitActive());
	await clock.advance(1000);
	a.session.append(frame("ns", "n2", "op"));
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events).slice(3), ["refused n2 daily-limit"]);
	assert.equal(a.of("refused")[1]!.retryAfterMs, DAY - (clock.now() - Date.UTC(2026, 0, 1)));
	assert.equal(relay.counters().dailyLimitRejects, 1);
	assert.deepEqual(await pump(clock, a.session.putCheckpoint(ns, 1, 0, new Uint8Array(3))), { t: "refused", reason: "daily-limit", retryAfterMs: DAY - (clock.now() - Date.UTC(2026, 0, 1)) });
	assert.equal((await pump(clock, a.session.feed(0))).headSeq, 1);
	assert.equal((await pump(clock, a.session.read(ns, 0, false))).rows.length, 1);
	await clock.advance(Date.UTC(2026, 0, 2) - clock.now());
	assert.ok(!relay.dailyLimitActive());
	a.session.append(frame("ns", "n2", "op"));
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events).slice(-2), ["receipt n2@2", "head 2"]);

	relay.failNextCommit("daily-limit", 5000);
	a.session.append(frame("ns", "n3", "op"));
	await clock.runUntilIdle();
	assert.equal(a.of("refused")[2]!.retryAfterMs, 5000);
	relay.restart(); // the latch is per runtime
	assert.ok(!relay.dailyLimitActive());
	await clock.runUntilIdle();
	a.session.append(frame("ns", "n3", "op"));
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events).slice(-2), ["receipt n3@3", "head 3"]);
});

test("relay daily limit (env): setDailyLimit fails commits even after a restart cleared the latch; lifts at retryAfterMs; off clears", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const a = await connectPeer(relay, clock, "A");
	relay.setDailyLimit(true, 60_000);
	a.session.append(frame("ns", "n1", "op"));
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events), ["refused n1 daily-limit"]);
	assert.equal(a.of("refused")[0]!.retryAfterMs, 60_000);
	relay.restart();
	await clock.runUntilIdle();
	a.session.append(frame("ns", "n1", "op")); // admitted (latch gone), the commit hits the limit and re-latches
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events).slice(1), ["resend 0", "refused n1 daily-limit"]);
	assert.equal(a.of("refused")[1]!.retryAfterMs, 60_000 - 300);
	assert.equal(relay.counters().commitFailures, 1);
	await clock.advance(60_000);
	assert.ok(!relay.dailyLimitActive());
	a.session.append(frame("ns", "n1", "op"));
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events).slice(-2), ["receipt n1@1", "head 1"]);
	relay.setDailyLimit(true);
	assert.ok(relay.dailyLimitActive());
	relay.setDailyLimit(false);
	assert.ok(!relay.dailyLimitActive());
	assert.deepEqual(await pump(clock, a.session.putCheckpoint(ns, 1, 0, new Uint8Array(3))), { t: "ok" });
});
