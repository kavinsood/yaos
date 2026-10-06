/**
 * Sender unit tests (DESIGN §d.4-§d.6, §i.1, §i.6) with a fake clock and session:
 * lane/outbox order, ns/cfg send window, inflight byte cap, buffered high water,
 * token bucket, refusals, probe mode, STREAM_RESEND, backpressure, pause.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { NS_SEND_WINDOW, RELAY_CLOSE } from "../../core/limits";
import { CFG_STREAM, NS_STREAM, type ClientFrameId, type StreamName } from "../../core/types";
import type { ClockPort, TimerHandle } from "../../ports/clock";
import type { AppendFrame, RelaySession } from "../../ports/relay";
import type { OutboxRecord } from "../store/schema";
import { BUFFERED_HIGH_WATER, DURABILITY_RETRY_MS, Sender, TokenBucket } from "./sender";

class FakeClock implements ClockPort {
	t = 1_000;
	private id = 0;
	readonly timers = new Map<number, { at: number; fn: () => void }>();
	now(): number { return this.t; }
	monotonic(): number { return this.t; }
	setTimer(d: number, fn: () => void): TimerHandle {
		this.timers.set(++this.id, { at: this.t + d, fn });
		return this.id;
	}
	clearTimer(h: TimerHandle): void { this.timers.delete(h); }
	async yieldNow(): Promise<void> {}
	/** Advance by ms, firing due timers in time order (timers may schedule more). */
	advance(ms = 0): void {
		const end = this.t + ms;
		for (;;) {
			let best: [number, { at: number; fn: () => void }] | null = null;
			for (const e of this.timers) if (e[1].at <= end && (best === null || e[1].at < best[1].at)) best = e;
			if (best === null) break;
			this.timers.delete(best[0]);
			this.t = Math.max(this.t, best[1].at);
			best[1].fn();
		}
		this.t = end;
	}
}

class FakeSession implements RelaySession {
	readonly vaultEpoch = "e1";
	readonly headSeq = 0;
	readonly appends: AppendFrame[] = [];
	buffered = 0;
	readonly limits;
	constructor(readonly canWrite = true, burstBytes = 2 * 1024 * 1024) {
		this.limits = { maxFrameBytes: 1 << 20, maxCheckpointBytes: 1 << 20, appendBytesPerSec: 256 * 1024, burstBytes, feedPageRows: 100, readPageBytes: 1 << 20, readBatchStreams: 1 };
	}
	append(f: AppendFrame): void { this.appends.push(f); }
	bufferedBytes(): number { return this.buffered; }
	feed(): never { throw new Error("unused"); }
	read(): never { throw new Error("unused"); }
	readBatch(): never { throw new Error("unused"); }
	putCheckpoint(): never { throw new Error("unused"); }
	onEvent(): () => void { return () => {}; }
	close(): void {}
	ids(): string[] { return this.appends.map((a) => a.clientFrameId); }
}

const BOUND = "d:bound" as StreamName;
const BG = "d:bg" as StreamName;
const X = "x:chunk" as StreamName;
let ord = 0;
function rec(stream: StreamName, bytes = 10, over: Partial<OutboxRecord> = {}): OutboxRecord {
	const n = ord++;
	return {
		clientFrameId: `f${String(n).padStart(21, "0")}` as ClientFrameId, order: n, stream, kind: stream === NS_STREAM ? "nsOps" : "bodyUpdate",
		state: "pending", sealed: new Uint8Array(bytes), content: new Uint8Array(0), authorNsSeq: 0, flags: 0, dependsOn: null, adoptOf: null,
		attempts: 0, createdAtMs: 0, lastSentAtMs: 0, ...over,
	};
}
const RANK: Record<string, number> = { [BOUND]: 0, [NS_STREAM]: 1, [CFG_STREAM]: 2, [BG]: 3, [X]: 4 };

function mk(maxInflight = 10 * 1024 * 1024) {
	const clock = new FakeClock();
	const ev = { sent: [] as [string, number][], poison: [] as [string, string][], forbidden: 0, daily: [] as number[], diag: [] as string[] };
	const sender = new Sender({
		clock, rankOf: (r) => RANK[r.stream] ?? 3, maxInflightBytes: () => maxInflight,
		onSent: (r, a) => ev.sent.push([r.clientFrameId, a]), onPoison: (r, why) => ev.poison.push([r.clientFrameId, why]),
		onForbidden: () => ev.forbidden++, onDailyLimit: (ms) => ev.daily.push(ms), diag: (c) => ev.diag.push(c),
	});
	const add = (...rs: OutboxRecord[]) => { for (const r of rs) sender.upsert(r); clock.advance(0); return rs; };
	return { clock, ev, sender, add };
}

test("sender: lane rank then outbox order; ns waits for openNs; resend replays in the same order", () => {
	const { sender, add, clock, ev } = mk();
	const [bg, ns, b1, x, b2] = add(rec(BG), rec(NS_STREAM), rec(BOUND), rec(X), rec(BOUND));
	const s = new FakeSession();
	sender.attach(s);
	assert.deepEqual(s.ids(), [b1, b2, bg, x].map((r) => r!.clientFrameId), "ns/cfg held until late-receipt reads");
	assert.equal(sender.nsWindowOpen, false);
	sender.openNs();
	assert.deepEqual(s.ids().slice(4), [ns!.clientFrameId]);
	assert.equal(sender.inflightCount, 5);
	sender.onResend();
	clock.advance(0);
	assert.deepEqual(s.ids().slice(5), [b1, b2, ns, bg, x].map((r) => r!.clientFrameId));
	assert.ok(ev.sent.slice(5).every(([, a]) => a === 2), "attempts counted per send");
	sender.detach();
	const s2 = new FakeSession();
	sender.attach(s2);
	assert.equal(sender.nsWindowOpen, false, "a new session closes the window again");
	assert.equal(s2.appends.length, 4);
});

test("sender: ns and cfg windows are the first NS_SEND_WINDOW unreceipted frames by order, independently", () => {
	const { sender, add, clock } = mk();
	const nss = add(...Array.from({ length: NS_SEND_WINDOW + 8 }, () => rec(NS_STREAM)));
	const cfgs = add(...Array.from({ length: 3 }, () => rec(CFG_STREAM)));
	const s = new FakeSession();
	sender.attach(s);
	sender.openNs();
	const sent = new Set(s.ids());
	assert.equal(s.appends.length, NS_SEND_WINDOW + 3);
	assert.ok(nss.slice(0, NS_SEND_WINDOW).every((r) => sent.has(r.clientFrameId)));
	assert.ok(cfgs.every((r) => sent.has(r.clientFrameId)));
	sender.onReceipt(nss[5]!.clientFrameId);
	clock.advance(0);
	assert.equal(s.appends.at(-1)!.clientFrameId, nss[NS_SEND_WINDOW]!.clientFrameId, "one receipt opens exactly one slot");
	assert.equal(s.appends.length, NS_SEND_WINDOW + 4);
});

test("sender: inflight byte cap is head-of-line; one frame is always allowed; buffered high water defers 50 ms", () => {
	const { sender, add, clock } = mk(1_000);
	const [a, b, c] = add(rec(BOUND, 600), rec(BOUND, 600), rec(BOUND, 300));
	const s = new FakeSession();
	s.buffered = BUFFERED_HIGH_WATER + 1;
	sender.attach(s);
	assert.equal(s.appends.length, 0);
	s.buffered = 0;
	clock.advance(49);
	assert.equal(s.appends.length, 0);
	clock.advance(1);
	assert.deepEqual(s.ids(), [a!.clientFrameId], "b does not fit; c may not jump it");
	assert.equal(sender.inflightByteCount, 600);
	sender.onReceipt(a!.clientFrameId);
	clock.advance(0);
	assert.deepEqual(s.ids().slice(1), [b!.clientFrameId, c!.clientFrameId]);
	sender.onReceipt(b!.clientFrameId);
	sender.onReceipt(c!.clientFrameId);
	const [big] = add(rec(BOUND, 5_000));
	assert.equal(s.appends.at(-1)!.clientFrameId, big!.clientFrameId, "oversize-for-window frame goes alone");
	assert.equal(sender.inflightByteCount, 5_000);
});

test("TokenBucket: take / wait / refill, oversize from a full bucket, half rate while slowed", () => {
	const b = new TokenBucket(10_000, 1_000, 0);
	assert.equal(b.take(6_000, 0), 0);
	assert.equal(b.take(6_000, 0), 2_000);
	assert.equal(b.take(6_000, 2_000), 0);
	const full = new TokenBucket(10_000, 1_000, 0);
	assert.equal(full.take(25_000, 0), 0, "a frame larger than capacity passes from a full bucket");
	assert.equal(full.take(1, 0), 15_001, "and the debt is repaid first");
	const slow = new TokenBucket(1_000, 1_000, 0);
	slow.slowUntil = 10_000;
	slow.take(1_000, 0);
	assert.equal(slow.take(1_000, 0), 2_000);
	assert.equal(slow.rate(10_000), 1_000);
});

test("sender: token bucket defers sends and wakes itself when tokens refill", () => {
	const { sender, add, clock } = mk();
	add(rec(BOUND, 6_000), rec(BOUND, 6_000), rec(BOUND, 6_000));
	const s = new FakeSession(true, 10_000);
	sender.attach(s);
	assert.equal(s.appends.length, 1, "bucket capacity = session burstBytes");
	const rate = sender.bucket.rate(clock.monotonic());
	const wait = Math.ceil((2_000 * 1000) / rate);
	clock.advance(wait - 1);
	assert.equal(s.appends.length, 1);
	clock.advance(1);
	assert.equal(s.appends.length, 2);
	clock.advance(Math.ceil((6_000 * 1000) / rate));
	assert.equal(s.appends.length, 3);
});

test("sender: refusals -- durability retries after 1 s, frame-id-conflict poisons, forbidden goes read-only", () => {
	const { sender, add, clock, ev } = mk();
	const [a, b, c] = add(rec(BOUND), rec(BOUND), rec(BOUND));
	const s = new FakeSession();
	sender.attach(s);
	assert.equal(s.appends.length, 3);
	sender.onRefused(a!.clientFrameId, "durability", null);
	assert.equal(sender.isInflight(a!.clientFrameId), false);
	clock.advance(DURABILITY_RETRY_MS - 1);
	assert.equal(s.appends.length, 3);
	clock.advance(1);
	assert.deepEqual(s.ids().slice(3), [a!.clientFrameId]);
	assert.deepEqual(ev.sent.at(-1), [a!.clientFrameId, 2]);

	sender.onRefused(b!.clientFrameId, "frame-id-conflict", null);
	assert.deepEqual(ev.poison, [[b!.clientFrameId, "frame-id-conflict"]]);
	assert.equal(sender.has(b!.clientFrameId), false);
	assert.equal(sender.stats.poisoned, 1);
	sender.onResend();
	clock.advance(0);
	assert.ok(!s.ids().slice(4).includes(b!.clientFrameId), "a poisoned frame is never resent");

	sender.onRefused(c!.clientFrameId, "forbidden", null);
	assert.equal(ev.forbidden, 1);
	const n = s.appends.length;
	add(rec(BOUND));
	sender.onResend();
	clock.advance(60_000);
	assert.equal(s.appends.length, n, "read-only: nothing more is sent");
	const s2 = new FakeSession(true);
	sender.attach(s2);
	assert.equal(s2.appends.length, 3, "a writable session sends everything unreceipted");
	const ro = new FakeSession(false);
	sender.attach(ro);
	assert.equal(ro.appends.length, 0, "canWrite=false never appends");
	assert.ok(ev.diag.filter((d) => d === "append-refused").length === 3);
});

test("sender: daily-limit holds all sends until retryAfter (or releaseDailyHold)", () => {
	const { sender, add, clock, ev } = mk();
	const [a] = add(rec(BOUND));
	const s = new FakeSession();
	sender.attach(s);
	sender.onRefused(a!.clientFrameId, "daily-limit", 30_000);
	assert.deepEqual(ev.daily, [30_000]);
	const [d] = add(rec(BOUND));
	clock.advance(29_999);
	assert.equal(s.appends.length, 1, "held");
	clock.advance(1);
	assert.deepEqual(s.ids().slice(1), [a!.clientFrameId, d!.clientFrameId]);
	sender.onRefused(d!.clientFrameId, "daily-limit", null);
	assert.equal(ev.daily.at(-1), 60_000, "default wait");
	clock.advance(1_000);
	assert.equal(s.appends.length, 3);
	sender.releaseDailyHold();
	clock.advance(0);
	assert.equal(s.appends.at(-1)!.clientFrameId, d!.clientFrameId);
});

test("sender: probe mode after 1008/1009 -- one frame in flight, a repeat close poisons it, probe ends when suspects clear", () => {
	const { sender, add, ev } = mk();
	const [a, b, c] = add(rec(BOUND), rec(BOUND), rec(BOUND));
	let s = new FakeSession();
	sender.attach(s);
	sender.onClosed(RELAY_CLOSE.oversize);
	assert.equal(sender.probing, true);
	assert.equal(sender.inflightCount, 0);
	const [d] = add(rec(BOUND));
	s = new FakeSession();
	sender.attach(s);
	assert.deepEqual(s.ids(), [a!.clientFrameId], "one at a time");
	sender.onReceipt(a!.clientFrameId);
	add();
	assert.deepEqual(s.ids(), [a!.clientFrameId, b!.clientFrameId]);
	sender.onClosed(RELAY_CLOSE.policy);
	assert.deepEqual(ev.poison, [[b!.clientFrameId, `close-${RELAY_CLOSE.policy}`]]);
	assert.equal(sender.probing, true, "c is still a suspect");
	s = new FakeSession();
	sender.attach(s);
	assert.deepEqual(s.ids(), [c!.clientFrameId]);
	sender.onReceipt(c!.clientFrameId);
	assert.equal(sender.probing, false);
	add(rec(BOUND));
	assert.equal(s.appends.length, 3, "d and the new frame go together again");
	assert.equal(s.appends[1]!.clientFrameId, d!.clientFrameId);
	sender.onClosed(RELAY_CLOSE.abnormal);
	assert.equal(sender.probing, false, "other close codes do not probe");
});

test("sender: backpressure holds 5 s and halves the rate; pause; upsert replace / non-sendable state removes", () => {
	const { sender, add, clock } = mk();
	const s = new FakeSession();
	sender.attach(s);
	sender.onBackpressure();
	assert.equal(sender.bucket.rate(clock.monotonic()), sender.bucket.rate(clock.monotonic() + 11 * 60_000) / 2);
	add(rec(BOUND));
	clock.advance(4_999);
	assert.equal(s.appends.length, 0);
	clock.advance(1);
	assert.equal(s.appends.length, 1);

	sender.paused = true;
	const [p] = add(rec(BOUND, 10));
	clock.advance(1_000);
	assert.equal(s.appends.length, 1);
	sender.upsert({ ...p!, sealed: new Uint8Array(20) });
	sender.paused = false;
	sender.pump();
	assert.equal(s.appends.length, 2);
	assert.equal(s.appends[1]!.payload.length, 20, "the replaced record is what goes out");

	const [h] = add(rec(BOUND));
	sender.upsert({ ...h!, state: "held" });
	assert.equal(sender.has(h!.clientFrameId), false);
	sender.upsert({ ...h!, state: "sent" });
	assert.equal(sender.has(h!.clientFrameId), true, "sent records are still maybe-unsent");
	sender.detach();
	const n = s.appends.length;
	add(rec(BOUND));
	clock.advance(10_000);
	assert.equal(s.appends.length, n, "detached: no timers, no sends");
});
