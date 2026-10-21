/**
 * CreatorStatus (DESIGN §i.5 "Abandoned creates") against its timer budget (timer-audit.md, idle cost): no timer
 * while no doc waits on a foreign creator, at most one timer otherwise, one request in flight with up to 32 creators
 * whatever the number of docs, a doubling recheck with a cap, and "unknown" never asked again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceId } from "../../core/types";
import type { DeviceState } from "../../ports/identity";
import { CreatorStatus } from "./creatorStatus";

function rig(answer: (id: DeviceId) => DeviceState) {
	let now = 0;
	let seq = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const asked: DeviceId[][] = [];
	let abandoned = 0;
	const cs = new CreatorStatus({
		status: (ids) => {
			asked.push([...ids]);
			return Promise.resolve(new Map(ids.map((id) => [id, answer(id)])));
		},
		mono: () => now,
		setTimer: (ms, fn) => {
			timers.set(++seq, { at: now + ms, fn });
			return seq;
		},
		clearTimer: (h) => void timers.delete(h),
		graceMs: 30_000, recheckMs: 300_000, recheckMaxMs: 3_600_000,
		onAbandoned: () => abandoned++,
	});
	const settle = async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	};
	/** Advance the clock to the next timer and run it. */
	const next = async () => {
		const [h, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
		timers.delete(h);
		now = t.at;
		t.fn();
		await settle();
	};
	return { cs, timers, asked, settle, next, get now() { return now; }, get abandoned() { return abandoned; } };
}

const ids = (n: number, p = "creator") => new Set(Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(4, "0")}` as DeviceId));

test("creatorStatus: no waiting doc arms no timer and asks nothing; a doc that got its body disarms", async () => {
	const r = rig(() => "live");
	r.cs.seen(new Set());
	await r.settle();
	assert.equal(r.asked.length, 0);
	assert.equal(r.timers.size, 0);
	assert.equal(r.cs.armed, false);
	r.cs.seen(ids(1));
	await r.settle();
	assert.equal(r.asked.length, 1);
	assert.equal(r.timers.size, 1, "one recheck timer");
	r.cs.seen(new Set());
	assert.equal(r.timers.size, 0, "nothing waits any more: no timer");
	assert.equal(r.cs.busy(), false);
});

test("creatorStatus: many docs and creators: batched requests of at most 32, one in flight, one timer", async () => {
	const r = rig(() => "live");
	r.cs.seen(ids(70));
	await r.settle();
	assert.deepEqual(r.asked.map((a) => a.length), [32, 32, 6], "70 creators: three requests, one after the other");
	assert.equal(r.timers.size, 1, "one timer for all rechecks");
	r.cs.seen(ids(70));
	await r.settle();
	assert.equal(r.asked.length, 3, "not due: no request");
});

test("creatorStatus: a live creator is rechecked by the timer itself, the wait doubling to the cap", async () => {
	const r = rig(() => "live");
	r.cs.seen(ids(1));
	await r.settle();
	const at: number[] = [];
	for (let i = 0; i < 6; i++) {
		await r.next();
		at.push(r.now);
	}
	assert.equal(r.asked.length, 7, "each timer asks once (no view needed)");
	const gaps = at.map((t, i) => t - (i === 0 ? 0 : at[i - 1]!));
	assert.deepEqual(gaps, [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]);
	assert.equal(r.timers.size, 1);
});

test("creatorStatus: unknown is never asked again; retired ends its grace on the one timer and re-plans once", async () => {
	const answers = new Map<string, DeviceState>([["creator0000", "unknown"], ["creator0001", "retired"], ["creator0002", "retired"]]);
	const r = rig((id) => answers.get(id) ?? "live");
	const named = ids(3);
	r.cs.seen(named);
	await r.settle();
	assert.equal(r.asked.length, 1);
	assert.equal(r.timers.size, 1, "both graces on one timer");
	assert.equal(r.cs.abandoned("creator0001" as DeviceId), false);
	await r.next();
	assert.equal(r.now, 30_000);
	assert.equal(r.abandoned, 1, "one re-plan for both");
	assert.equal(r.cs.abandoned("creator0001" as DeviceId) && r.cs.abandoned("creator0002" as DeviceId), true);
	assert.equal(r.cs.abandoned("creator0000" as DeviceId), false, "unknown is never abandoned");
	assert.equal(r.timers.size, 0, "unknown and abandoned creators arm nothing");
	r.cs.seen(named);
	await r.settle();
	assert.equal(r.asked.length, 1, "neither asked again");
});
