import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { ManualClock } from "../engine/adapters/relayTestFakes";
import { bounded, relayHttpDeadlineMs, RELAY_HTTP_BASE_MS, untilAborted, watched, type BoundedEnd } from "./deadline";

class Ended extends Error {
	constructor(readonly why: BoundedEnd) {
		super(why);
	}
}
const ended = (why: BoundedEnd): Error => new Ended(why);
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

function track<T>(p: Promise<T>): { readonly p: Promise<T>; readonly out: () => unknown } {
	let out: unknown = "pending";
	p.then((v) => (out = v), (e: unknown) => (out = e));
	return { p, out: () => out };
}

test("bounded: a call that ignores its signal and never settles ends at its deadline; the caller's abort ends it at once", async () => {
	const clock = new ManualClock();
	const seen: AbortSignal[] = [];
	const deaf = track(bounded(1000, undefined, clock, (s) => (seen.push(s), never()), ended));
	clock.advance(999);
	await flush();
	assert.equal(deaf.out(), "pending");
	clock.advance(1);
	await flush();
	assert.ok(deaf.out() instanceof Ended && (deaf.out() as Ended).why === "timeout");
	assert.equal(seen[0]!.aborted, true, "the call's own signal is aborted too (a fetch that honours it stops)");
	assert.equal(clock.pendingTimers, 0);

	const ctl = new AbortController();
	const aborted = track(bounded(1000, ctl.signal, clock, () => never(), ended));
	ctl.abort();
	await flush();
	assert.equal((aborted.out() as Ended).why, "aborted");
	assert.equal(clock.pendingTimers, 0);
	assert.equal(getEventListeners(ctl.signal, "abort").length, 0);

	let runs = 0;
	await assert.rejects(bounded(1000, ctl.signal, clock, async () => ++runs, ended), (e: unknown) => e instanceof Ended && e.why === "aborted");
	assert.equal(runs, 0, "an aborted caller never starts the call");
});

test("bounded: a reply in time passes through and leaves no timer or listener; a failure of its own is not relabelled", async () => {
	const clock = new ManualClock();
	const ctl = new AbortController();
	assert.equal(await bounded(1000, ctl.signal, clock, async () => 7, ended), 7);
	await assert.rejects(bounded(1000, ctl.signal, clock, async () => { throw new TypeError("network"); }, ended), TypeError);
	assert.equal(clock.pendingTimers, 0);
	assert.equal(getEventListeners(ctl.signal, "abort").length, 0);
	// A call that settles after its deadline is still ended: the caller never sees a late reply.
	let answer!: (v: number) => void;
	const late = track(bounded(10, undefined, clock, () => new Promise<number>((r) => (answer = r)), ended));
	clock.advance(10);
	answer(1);
	await flush();
	assert.equal((late.out() as Ended).why, "timeout");
});

test("untilAborted rejects with the signal's reason when the promise never settles; the deadline formula is base + bytes at the floor", async () => {
	const ctl = new AbortController();
	const p = track(untilAborted(never<number>(), ctl.signal));
	ctl.abort(new Ended("aborted"));
	await flush();
	assert.ok(p.out() instanceof Ended);
	assert.equal(getEventListeners(ctl.signal, "abort").length, 0);
	assert.equal(relayHttpDeadlineMs(0), RELAY_HTTP_BASE_MS);
	assert.equal(relayHttpDeadlineMs(4096), 15_063);
});

test("watched: no first byte ends \"timeout\" at firstByteMs; after it, no progress for idleMs ends \"stalled\"; progress keeps it alive until totalMs", async () => {
	const limits = { firstByteMs: 1000, idleMs: 300, totalMs: 5000 };
	const clock = new ManualClock();
	const silent = track(watched(limits, undefined, clock, () => never(), (w) => new Error(w)));
	clock.advance(999);
	await flush();
	assert.equal(silent.out(), "pending");
	clock.advance(1);
	await flush();
	assert.equal((silent.out() as Error).message, "timeout");
	assert.equal(clock.pendingTimers, 0);

	let progress!: () => void;
	const stalled = track(watched(limits, undefined, clock, (_s, p) => ((progress = p), never()), (w) => new Error(w)));
	clock.advance(900);
	progress(); // headers
	clock.advance(299);
	await flush();
	assert.equal(stalled.out(), "pending", "the idle window replaced the first-byte window");
	clock.advance(1);
	await flush();
	assert.equal((stalled.out() as Error).message, "stalled");
	assert.equal(clock.pendingTimers, 0);

	let answer!: (v: number) => void;
	const slow = track(watched(limits, undefined, clock, (_s, p) => ((progress = p), new Promise<number>((r) => (answer = r))), (w) => new Error(w)));
	for (let t = 0; t < 4800; t += 200) {
		clock.advance(200);
		progress();
	}
	await flush();
	assert.equal(slow.out(), "pending", "progress every 200 ms is never cut by the idle window");
	answer(9);
	await flush();
	assert.equal(slow.out(), 9);
	assert.equal(clock.pendingTimers, 0);

	const trickle = track(watched(limits, undefined, clock, (_s, p) => ((progress = p), never()), (w) => new Error(w)));
	for (let t = 0; t < 4800; t += 200) {
		clock.advance(200);
		progress();
	}
	clock.advance(200);
	await flush();
	assert.equal((trickle.out() as Error).message, "timeout", "the total backstop holds");
	assert.equal(clock.pendingTimers, 0);
});
