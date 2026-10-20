/**
 * Stream subscriptions in the engine (runtime/subscriptions.ts, DESIGN §d.7) over SimRelay on a virtual clock: the
 * set (bound, own outbox, recently unbound; capped; debounced; sent on change and on every session), live ingest of
 * skipped rows (accounted in order, the stream stale), the deferred read (settle / max, exemptions, wantFresh) and
 * the checkpoint duty hand-over through skipped rows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocId, StreamName } from "../../core/types";
import { VirtualClock } from "../../sim/clock";
import { SimRelay } from "../../sim/relay";
import { bodyCheckpointDue, CheckpointState, DEFAULT_CHECKPOINT_TUNING } from "../body/checkpoints";
import type { EngineTuning } from "./options";
import type { LogEngine } from "./engine";
import { converged, createDoc, docText, drive, editDoc, sleep, startTestEngine, until } from "./testHarness";

const TUNING: Partial<EngineTuning> = { maintenanceMs: 250, subscribeDebounceMs: 250 };

async function world(o: { b?: Partial<EngineTuning>; relayLimits?: { maxSubscriptions: number } } = {}) {
	const clock = new VirtualClock(Date.UTC(2026, 9, 19, 12));
	clock.onError = (e) => {
		throw e;
	};
	const relay = new SimRelay({ clock, ...(o.relayLimits ? { limits: o.relayLimits } : {}) });
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", clock, tuning: TUNING });
	const { engine: b } = await startTestEngine({
		relay, deviceId: "dev-b", clock, tuning: { ...TUNING, ...o.b },
	});
	await until(() => a.status().phase === "live" && b.status().phase === "live", 10_000, "live", clock);
	return { clock, relay, a, b };
}

async function docs(clock: VirtualClock, a: LogEngine, n: number): Promise<DocId[]> {
	const ids: DocId[] = [];
	for (let i = 0; i < n; i++) ids.push(await drive(createDoc(a, `d${i}.md`, `doc ${i};`), clock));
	return ids;
}

const subsOf = (relay: SimRelay, d: LogEngine) => relay.subscriptionsOf(d.c.self);

test("subscriptions: sent on every session before the feed; bound, own outbox and the 8 newest unbound for 10 min; only on change", async () => {
	const { clock, relay, a, b } = await world();
	try {
		const ids = await docs(clock, a, 10);
		await converged([a, b], 30_000, clock);
		const s = ids.map((id) => b.streamOf(id));
		assert.deepEqual(subsOf(relay, b), [[]], "each session subscribes at once, here to nothing");
		const sends = () => b.c.subs.stats.sends;
		const base = sends();

		await drive(b.bind(ids[0]!), clock);
		await sleep(50, clock);
		assert.deepEqual(subsOf(relay, b), [[s[0]]], "a bind is sent without the debounce");
		b.unbind(ids[0]!);
		await sleep(1_000, clock);
		assert.deepEqual(subsOf(relay, b), [[s[0]]], "recently unbound: still subscribed");
		assert.equal(sends(), base + 1, "nothing to send on that unbind");

		for (let i = 1; i < 10; i++) {
			await drive(b.bind(ids[i]!), clock);
			b.unbind(ids[i]!);
		}
		await sleep(1_000, clock);
		assert.deepEqual(subsOf(relay, b), [s.slice(2).sort()], "the 8 most recently unbound");

		// Own outbox records: an edit whose frame has no receipt yet.
		await sleep(11 * 60_000, clock);
		assert.deepEqual(subsOf(relay, b), [[]], "unbound for 10 min: dropped");
		relay.pauseCommits();
		await drive(editDoc(b, ids[3]!, (t) => t.insert(t.length, "own;")), clock);
		await sleep(1_000, clock);
		assert.deepEqual(subsOf(relay, b), [[s[3]]], "a stream with own frames in flight");
		relay.resumeCommits();
		await converged([a, b], 30_000, clock);
		await sleep(1_000, clock);
		assert.deepEqual(subsOf(relay, b), [[]], "receipted: dropped");

		// A new session: subscribed again right after VAULT_READY.
		await drive(b.bind(ids[5]!), clock);
		const before = sends();
		b.disconnect();
		await drive(b.reconnect(), clock);
		await until(() => b.status().phase === "live", 10_000, "live again", clock);
		assert.equal(sends(), before + 1, "one send per session");
		assert.deepEqual(subsOf(relay, b), [[s[5]]]);
	} finally {
		await drive(a.stop(), clock);
		await drive(b.stop(), clock);
	}
});

test("subscriptions: the set is capped at maxSubscriptions, bound streams first", async () => {
	const { clock, relay, a, b } = await world({ relayLimits: { maxSubscriptions: 2 } });
	try {
		const ids = await docs(clock, a, 4);
		await converged([a, b], 30_000, clock);
		await drive(b.bind(ids[0]!), clock);
		b.unbind(ids[0]!);
		await drive(b.bind(ids[1]!), clock);
		b.unbind(ids[1]!);
		await drive(b.bind(ids[2]!), clock);
		await drive(b.bind(ids[3]!), clock);
		await sleep(1_000, clock);
		assert.deepEqual(subsOf(relay, b), [[b.streamOf(ids[2]!), b.streamOf(ids[3]!)].sort()]);
	} finally {
		await drive(a.stop(), clock);
		await drive(b.stop(), clock);
	}
});

test("skipped rows: accounted in order, the stream stale; its read waits settleMs of quiet or maxDeferMs; bound and wantFresh read now", async () => {
	const { clock, relay, a, b } = await world({ b: { skipSettleMs: 5_000, skipMaxDeferMs: 30_000 } });
	try {
		const [x, y] = await docs(clock, a, 2);
		await converged([a, b], 30_000, clock);
		const sx = b.streamOf(x!);
		const applied = (s: StreamName) => b.c.repo.stream(s)!.appliedSeq;
		const start = applied(sx);

		// a keeps typing in x (b has it closed): skips, no read until maxDeferMs.
		const t0 = clock.monotonic();
		let k = 0;
		const typeUntil = async (ms: number) => {
			while (clock.monotonic() - t0 < ms) {
				await drive(editDoc(a, x!, (t) => t.insert(t.length, `k${k++};`)), clock);
				await sleep(1_000, clock);
			}
		};
		await typeUntil(20_000);
		assert.ok(b.c.live.stats.skipped >= 10, `b got skips (${b.c.live.stats.skipped})`);
		assert.equal(b.c.repo.cursor.vaultSeq, relay.head(), "every skipped seq is accounted");
		assert.equal(b.c.repo.stream(sx)!.stale, 1);
		assert.equal(applied(sx), start, "not read while a types (settle not reached)");
		assert.equal(b.c.subs.deferredCount, 1);
		assert.equal(b.status().counts.staleStreams, 0, "a deferred stream is not counted as being fetched");
		assert.equal(b.isIdle(), false, "nor converged");
		await typeUntil(34_000);
		assert.ok(applied(sx) > start, "read at maxDeferMs although a still types");

		// a stops: read once quiet for settleMs.
		await sleep(7_000, clock);
		assert.equal(b.c.repo.stream(sx)!.stale, 0, "read after settleMs of quiet");
		assert.equal(await drive(docText(b, x!), clock), await drive(docText(a, x!), clock));

		// wantFresh (the disk side waits for the body): read at once, and later skips do not defer it until caught up.
		await drive(editDoc(a, y!, (t) => t.insert(t.length, "fresh;")), clock);
		await sleep(1_000, clock);
		const sy = b.streamOf(y!);
		assert.equal(b.c.repo.stream(sy)!.stale, 1);
		b.wantFresh([y!]);
		await sleep(1_000, clock);
		assert.equal(b.c.repo.stream(sy)!.stale, 0, "wantFresh reads now");

		// Bound: never deferred (and subscribed: pushed, so nothing to defer).
		await drive(b.bind(x!), clock);
		await drive(editDoc(a, x!, (t) => t.insert(t.length, "open;")), clock);
		await sleep(1_500, clock);
		assert.equal(b.c.repo.stream(sx)!.stale, 0);
		assert.equal(await drive(docText(b, x!), clock), await drive(docText(a, x!), clock));
		await converged([a, b], 30_000, clock);
	} finally {
		await drive(a.stop(), clock);
		await drive(b.stop(), clock);
	}
});

test("skipped rows hand the checkpoint duty on; a stale stream restarts the fallback clock", async () => {
	const { clock, a, b } = await world();
	try {
		const [x] = await docs(clock, a, 1);
		await converged([a, b], 30_000, clock);
		const s = a.streamOf(x!);
		assert.ok(a.c.repo.hasCkptDuty(s), "the creator has the duty");
		await sleep(1_000, clock); // a's own frames receipted: the stream leaves its set
		await drive(editDoc(b, x!, (t) => t.insert(t.length, "b;")), clock);
		await converged([a, b], 30_000, clock);
		assert.ok(b.c.repo.hasCkptDuty(s), "the last writer has it");
		assert.ok(a.c.live.stats.skipped > 0, "a saw b's row as a skip");
		assert.equal(a.c.repo.hasCkptDuty(s), false, "and handed the duty on");

		const st = new CheckpointState();
		st.condSince.set(s, 0);
		assert.equal(bodyCheckpointDue({ ...a.c.repo.stream(s)!, stale: 1 }, false, st, DEFAULT_CHECKPOINT_TUNING, 1e9, 0), false);
		assert.equal(st.condSince.has(s), false, "stale: the fallback clock starts over");
	} finally {
		await drive(a.stop(), clock);
		await drive(b.stop(), clock);
	}
});
