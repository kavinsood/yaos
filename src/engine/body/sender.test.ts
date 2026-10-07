/**
 * Sender unit tests (DESIGN §d.4-§d.6, §i.1, §i.6) with a fake clock and session:
 * lane/outbox order, ns/cfg send window, inflight byte cap, buffered high water,
 * token bucket, refusals, probe mode, STREAM_RESEND, backpressure, pause, a live
 * create's body frames behind their ns create, the ns cork.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { NS_SEND_WINDOW, RELAY_CLOSE } from "../../core/limits";
import { CFG_STREAM, NS_STREAM, type ClientFrameId, type StreamName } from "../../core/types";
import type { ClockPort, TimerHandle } from "../../ports/clock";
import type { AppendFrame, RelaySession } from "../../ports/relay";
import type { OutboxRecord } from "../store/schema";
import { BUFFERED_HIGH_WATER, DURABILITY_RETRY_MS, NS_CORK_MAX_MS, Sender, TokenBucket, type SendGate } from "./sender";

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
const X = "d:low" as StreamName;
let ord = 0;
/** Per-stream frameNo counters for ns/cfg records, allocated in outbox order like LogApi does. */
const frameNos = new Map<StreamName, number>();
function rec(stream: StreamName, bytes = 10, over: Partial<OutboxRecord> = {}): OutboxRecord {
	const n = ord++;
	const counted = stream === NS_STREAM || stream === CFG_STREAM;
	const frameNo = counted ? (frameNos.get(stream) ?? 0) + 1 : null;
	if (frameNo !== null) frameNos.set(stream, frameNo);
	return {
		clientFrameId: `f${String(n).padStart(21, "0")}` as ClientFrameId, order: n, stream,
		kind: stream === NS_STREAM ? "nsOps" : stream === CFG_STREAM ? "cfgOps" : "bodyUpdate",
		state: "pending", sealed: new Uint8Array(bytes), content: new Uint8Array(0), authorNsSeq: 0, flags: 0, frameNo, keyEpoch: 0, dependsOn: null, adoptOf: null,
		attempts: 0, createdAtMs: 0, lastSentAtMs: 0, ...over,
	};
}
const RANK: Record<string, number> = { [BOUND]: 0, [NS_STREAM]: 1, [CFG_STREAM]: 2, [BG]: 3, [X]: 4 };

function mk(maxInflight = 10 * 1024 * 1024, sendGate?: SendGate) {
	const clock = new FakeClock();
	const ev = { sent: [] as [string, number][], poison: [] as [string, string][], forbidden: 0, daily: [] as number[], diag: [] as string[], reseal: [] as string[] };
	const gate = { blocked: false, minEpoch: 0 };
	/** The outbox as blockedBy sees it (EngineCtx.outbox): add() puts records in, tests take them out. */
	const outbox = new Set<ClientFrameId>();
	const sender = new Sender({
		clock, rankOf: (r) => RANK[r.stream] ?? 3, maxInflightBytes: () => maxInflight,
		onSent: (r, a) => ev.sent.push([r.clientFrameId, a]), onPoison: (r, why) => ev.poison.push([r.clientFrameId, why]),
		onForbidden: () => ev.forbidden++, onDailyLimit: (ms) => ev.daily.push(ms), writeBlocked: () => gate.blocked, diag: (c) => ev.diag.push(c),
		minSendEpoch: () => gate.minEpoch, reseal: (r) => ev.reseal.push(r.clientFrameId), gate: sendGate,
		blockedBy: (r) => (r.dependsOn !== null && outbox.has(r.dependsOn) ? r.dependsOn : null),
	});
	const add = (...rs: OutboxRecord[]) => { for (const r of rs) { outbox.add(r.clientFrameId); sender.upsert(r); } clock.advance(0); return rs; };
	return { clock, ev, sender, add, gate, outbox };
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

test("sender: ns and cfg windows are frameNo < lowest unreceipted own frameNo + NS_SEND_WINDOW, independently (e2ee-design §8.2)", () => {
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
	assert.equal(s.appends.length, NS_SEND_WINDOW + 3, "a receipt above the lowest unreceipted frameNo opens no slot");
	sender.onReceipt(nss[0]!.clientFrameId);
	clock.advance(0);
	assert.equal(s.appends.at(-1)!.clientFrameId, nss[NS_SEND_WINDOW]!.clientFrameId, "the lowest receipt opens exactly one slot");
	assert.equal(s.appends.length, NS_SEND_WINDOW + 4);
	for (const i of [1, 2, 3, 4]) sender.onReceipt(nss[i]!.clientFrameId);
	clock.advance(0);
	// u is now nss[6]'s frameNo (nss[5] was receipted early): frameNos up to u + 31 are out.
	assert.deepEqual(s.ids().slice(-5), nss.slice(NS_SEND_WINDOW + 1, NS_SEND_WINDOW + 6).map((r) => r.clientFrameId));
	assert.equal(s.appends.length, NS_SEND_WINDOW + 9);
	assert.ok(s.ids().every((id) => id !== nss[NS_SEND_WINDOW + 6]!.clientFrameId), "frameNo u + 32 waits");
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
	const { sender, add, clock, gate } = mk();
	const s = new FakeSession();
	sender.attach(s);
	sender.onBackpressure();
	assert.equal(sender.bucket.rate(clock.monotonic()), sender.bucket.rate(clock.monotonic() + 11 * 60_000) / 2);
	add(rec(BOUND));
	clock.advance(4_999);
	assert.equal(s.appends.length, 0);
	clock.advance(1);
	assert.equal(s.appends.length, 1);

	gate.blocked = true;
	const [p] = add(rec(BOUND, 10));
	clock.advance(1_000);
	assert.equal(s.appends.length, 1);
	sender.upsert({ ...p!, sealed: new Uint8Array(20) });
	gate.blocked = false;
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

test("sender: below the revoke floor, or not sealed yet, a record goes to reseal and never out; ns/cfg only inside the open window (e2ee-design §14.2)", () => {
	const { sender, add, clock, ev, gate } = mk();
	gate.minEpoch = 2;
	const [old, cur, copy, ns] = add(rec(BOUND, 10, { keyEpoch: 1 }), rec(BOUND, 10, { keyEpoch: 2 }), rec(BG, 10, { keyEpoch: 2, sealed: new Uint8Array(0) }), rec(NS_STREAM, 10, { keyEpoch: 1 }));
	const s = new FakeSession();
	sender.attach(s);
	assert.deepEqual(s.ids(), [cur!.clientFrameId]);
	assert.deepEqual(ev.reseal, [old!.clientFrameId, copy!.clientFrameId], "the ns record waits for openNs");
	sender.openNs();
	assert.deepEqual([...new Set(ev.reseal)], [old, copy, ns].map((r) => r!.clientFrameId), "asked again on every pump (reseal.ts dedupes)");
	assert.deepEqual(s.ids(), [cur!.clientFrameId], "nothing below the floor was appended");
	sender.remove(old!.clientFrameId);
	add({ ...old!, clientFrameId: "resealed".padEnd(22, "R") as ClientFrameId, keyEpoch: 2 });
	clock.advance(0);
	assert.deepEqual(s.ids().slice(1), ["resealed".padEnd(22, "R")]);
	gate.minEpoch = 0;
	sender.onResend();
	clock.advance(0);
	assert.ok(!s.ids().includes(copy!.clientFrameId), "an empty sealed is never sent, whatever the floor");
});

test("sender: an ns/cfg record to re-seal, or in flight below the floor, holds the later frames of its stream; bodies and other streams do not wait (e2ee-design §14.2)", () => {
	const { sender, add, clock, ev, gate } = mk();
	gate.minEpoch = 2;
	const [n1, n2, c1, b1, b2] = add(rec(NS_STREAM, 10, { keyEpoch: 1 }), rec(NS_STREAM, 10, { keyEpoch: 2 }), rec(CFG_STREAM, 10, { keyEpoch: 2 }), rec(BOUND, 10, { keyEpoch: 1 }), rec(BOUND, 10, { keyEpoch: 2 }));
	const s = new FakeSession();
	sender.attach(s);
	sender.openNs();
	assert.deepEqual(s.ids(), [b2, c1].map((r) => r!.clientFrameId), "n2 waits behind n1; the body and cfg streams go");
	assert.deepEqual([...new Set(ev.reseal)], [b1, n1].map((r) => r!.clientFrameId));
	add({ ...n1!, keyEpoch: 2 });
	assert.deepEqual(s.ids().slice(2), [n1, n2].map((r) => r!.clientFrameId), "re-sealed: n1, then n2");
	// A copy (empty sealed) holds the same way.
	const [copy, n3] = add(rec(CFG_STREAM, 10, { keyEpoch: 2, sealed: new Uint8Array(0) }), rec(CFG_STREAM, 10, { keyEpoch: 2 }));
	assert.equal(s.ids().length, 4, "n3 waits behind the unsealed copy");
	add({ ...copy!, sealed: new Uint8Array(10) });
	assert.deepEqual(s.ids().slice(4), [copy, n3].map((r) => r!.clientFrameId));
	// In flight under K_1 when the revoke wins: it may commit stale and come back as a copy, so n5 waits for its receipt.
	sender.remove(b1!.clientFrameId); // replaced by its re-sealed record (fresh id)
	gate.minEpoch = 0;
	const [n4] = add(rec(NS_STREAM, 10, { keyEpoch: 1 }));
	assert.deepEqual(s.ids().slice(6), [n4!.clientFrameId]);
	gate.minEpoch = 2;
	const [n5] = add(rec(NS_STREAM, 10, { keyEpoch: 2 }));
	assert.equal(s.ids().length, 7, "n5 waits for n4's receipt");
	sender.onReceipt(n4!.clientFrameId);
	clock.advance(0);
	assert.deepEqual(s.ids().slice(7), [n5!.clientFrameId]);
});

test("sender: the blob gate holds a frame and the later frames of its stream; poke() sends them; reset per session, forget on remove", () => {
	const holding = new Set<string>();
	const calls = { reset: 0, forgot: [] as string[] };
	const gate: SendGate = {
		ready: (r) => !holding.has(r.clientFrameId),
		reset: () => void calls.reset++,
		forget: (cfid) => void calls.forgot.push(cfid),
	};
	const { sender, add, clock } = mk(10 * 1024 * 1024, gate);
	const [a1, a2, other] = add(rec(BG), rec(BG), rec(BOUND));
	holding.add(a1!.clientFrameId);
	const s = new FakeSession();
	sender.attach(s);
	assert.equal(calls.reset, 1);
	assert.deepEqual(s.ids(), [other!.clientFrameId], "a2 waits behind the held a1 of the same stream");
	holding.delete(a1!.clientFrameId);
	sender.poke();
	clock.advance(0);
	assert.deepEqual(s.ids().slice(1), [a1!.clientFrameId, a2!.clientFrameId]);
	sender.remove(a1!.clientFrameId);
	assert.deepEqual(calls.forgot, [a1!.clientFrameId]);
});

/** A live create's body frame (DESIGN §e.1): pending, dependsOn = its ns create. */
const after = (create: OutboxRecord, stream: StreamName = BOUND, bytes = 10) => rec(stream, bytes, { dependsOn: create.clientFrameId });

test("sender: a live create's body frames go right after their ns create, in the same pump, even from the bound lane", () => {
	const { sender, add, clock } = mk();
	const [other, created] = add(rec(BOUND), rec(NS_STREAM));
	const [d1, d2] = add(after(created!), after(created!));
	const s = new FakeSession();
	sender.attach(s);
	assert.deepEqual(s.ids(), [other!.clientFrameId], "before openNs the create cannot go, so neither can its body frames");
	sender.openNs();
	assert.deepEqual(s.ids().slice(1), [created, d1, d2].map((r) => r!.clientFrameId), "create first (lower seq), its body frames in the same pump");
	sender.onResend();
	clock.advance(0);
	assert.deepEqual(s.ids().slice(4), [other, created, d1, d2].map((r) => r!.clientFrameId), "a resend keeps the create ahead of its body frames");
	sender.detach();
	const s2 = new FakeSession();
	sender.attach(s2);
	assert.deepEqual(s2.ids(), [other!.clientFrameId], "a new session: they wait for the create's resend again");
	sender.openNs();
	assert.deepEqual(s2.ids().slice(1), [created, d1, d2].map((r) => r!.clientFrameId));
});

test("sender: a body frame never overtakes its create: create outside the ns window, create not in the sender (held, poisoned), create receipted", () => {
	const { sender, add, clock, outbox } = mk();
	const full = add(...Array.from({ length: NS_SEND_WINDOW }, () => rec(NS_STREAM)));
	const [create] = add(rec(NS_STREAM));
	const [d1] = add(after(create!, BG));
	const [later, free] = add(rec(BG), rec("d:other" as StreamName));
	const s = new FakeSession();
	sender.attach(s);
	sender.openNs();
	assert.equal(s.appends.length, NS_SEND_WINDOW + 1);
	assert.ok(!s.ids().includes(create!.clientFrameId) && !s.ids().includes(d1!.clientFrameId), "create outside the window: its body frame waits");
	assert.ok(!s.ids().includes(later!.clientFrameId), "so do the later frames of its stream (per-stream order)");
	assert.ok(s.ids().includes(free!.clientFrameId), "a frame of another stream behind it does not wait");
	sender.onReceipt(full[0]!.clientFrameId);
	outbox.delete(full[0]!.clientFrameId);
	clock.advance(0);
	assert.deepEqual(s.ids().slice(-3), [create, d1, later].map((r) => r!.clientFrameId), "the window opens: create, then its body frame");

	// A create in the outbox but not sendable (poisoned, held): the frame waits however long.
	const ghost = rec(NS_STREAM);
	outbox.add(ghost.clientFrameId);
	const [d2] = add(after(ghost, BG));
	clock.advance(60_000);
	assert.ok(!s.ids().includes(d2!.clientFrameId));
	// The create left the outbox (receipted, or deleted with its dependents' fate decided by the fold): the frame goes.
	outbox.delete(ghost.clientFrameId);
	sender.poke();
	clock.advance(0);
	assert.equal(s.ids().at(-1), d2!.clientFrameId);
});

test("sender: corkNs holds ns frames (not cfg, not bodies) until released or NS_CORK_MAX_MS; the release sends a create and its body frames together", () => {
	const { sender, add, clock } = mk();
	const s = new FakeSession();
	sender.attach(s);
	sender.openNs();
	const uncork = sender.corkNs();
	const [create, cfg, other] = add(rec(NS_STREAM), rec(CFG_STREAM), rec(BG));
	clock.advance(0);
	assert.deepEqual(s.ids(), [cfg, other].map((r) => r!.clientFrameId), "corked: only the ns frame waits");
	const [d1, d2] = add(after(create!), after(create!));
	clock.advance(0);
	assert.equal(s.appends.length, 2, "its body frames wait with it");
	uncork();
	clock.advance(0);
	assert.deepEqual(s.ids().slice(2), [create, d1, d2].map((r) => r!.clientFrameId), "one pump: create, then its body frames");
	uncork(); // idempotent
	const u1 = sender.corkNs();
	const u2 = sender.corkNs();
	const [n2] = add(rec(NS_STREAM));
	u1();
	clock.advance(0);
	assert.ok(!s.ids().includes(n2!.clientFrameId), "every cork must be released");
	clock.advance(NS_CORK_MAX_MS);
	assert.equal(s.ids().at(-1), n2!.clientFrameId, "a cork lasts NS_CORK_MAX_MS at most");
	u2();
	const before = s.appends.length;
	sender.detach();
	const u3 = sender.corkNs();
	u3();
	clock.advance(NS_CORK_MAX_MS * 2);
	assert.equal(s.appends.length, before, "a release while detached sends nothing");
});
