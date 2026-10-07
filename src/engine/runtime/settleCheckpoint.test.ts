/**
 * Settle rule of the remote checkpoint duty (DESIGN §d.9): streams edited below the hot threshold are checkpointed
 * once quiet, so a quiescent vault has no tail; a stream being typed in is never checkpointed; non-duty devices find
 * the duty device's checkpoint with a read instead of a second put.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { REMOTE_CHECKPOINT_IDLE_MS, REMOTE_CHECKPOINT_ROWS, REMOTE_CHECKPOINT_SETTLE_DAILY, REMOTE_CHECKPOINT_SETTLE_MS } from "../../core/limits";
import { NS_STREAM, type DocId, type StreamName, type VaultPath } from "../../core/types";
import { VirtualClock } from "../../sim/clock";
import { SimRelay } from "../../sim/relay";
import { bodyCheckpointDue, CHECKPOINT_FALLBACK_MS, CheckpointState, DEFAULT_CHECKPOINT_TUNING, foldCheckpointDue, settleWanted } from "../body/checkpoints";
import type { StreamRecord } from "../store/schema";
import type { FoldRuntime } from "../sync/foldRuntime";
import type { LogEngine } from "./engine";
import { converged, drive, sleep, startTestEngine, until } from "./testHarness";

const S = REMOTE_CHECKPOINT_SETTLE_MS;
const F = CHECKPOINT_FALLBACK_MS;
const T = DEFAULT_CHECKPOINT_TUNING;
const stream = "b:doc" as StreamName;

function rec(o: Partial<StreamRecord>): StreamRecord {
	return {
		stream, cls: "body", docId: null, appliedSeq: 10, remoteHeadSeq: 10, stale: 0, priority: 0, snapshotCoversSeq: 0, tailRows: 0, tailBytes: 0,
		remoteCheckpointCoversSeq: 0, rowsSinceRemoteCheckpoint: 0, bytesSinceRemoteCheckpoint: 0, lastOwnSeq: 0, bodyVersion: 0 as never,
		quarantinedRows: 0, frozen: 0, frozenReason: null, disputedCheckpointCoversSeq: 0, lastAccessMs: 0, textHash: null, ...o,
	};
}

test("settleWanted: any row behind a checkpoint, or two rows without one; a lone first frame is left alone", () => {
	assert.equal(settleWanted(rec({ rowsSinceRemoteCheckpoint: 1 })), false, "one row, no checkpoint: one open either way");
	assert.equal(settleWanted(rec({ rowsSinceRemoteCheckpoint: 2 })), true);
	assert.equal(settleWanted(rec({ remoteCheckpointCoversSeq: 9, rowsSinceRemoteCheckpoint: 1 })), true, "checkpoint + 1 row = 2 opens");
	assert.equal(settleWanted(rec({ remoteCheckpointCoversSeq: 10, rowsSinceRemoteCheckpoint: 5 })), false, "stale counters: nothing above the checkpoint");
});

test("bodyCheckpointDue settle: duty after S idle, typing keeps it closed and restarts the fallback clock, fallback after F + jitter", () => {
	const r = rec({ remoteCheckpointCoversSeq: 4, rowsSinceRemoteCheckpoint: 3 });
	const st = new CheckpointState();
	st.lastActivity.set(stream, 0);
	assert.equal(bodyCheckpointDue(r, true, st, T, S - 1, 0), false, "not idle for the settle window");
	assert.equal(bodyCheckpointDue(r, true, st, T, S, 0), true, "duty device at S");
	// Non-duty: the fallback clock starts once the stream is settle-idle and restarts on any activity.
	const j = 123_456;
	const nd = new CheckpointState();
	nd.lastActivity.set(stream, 0);
	assert.equal(bodyCheckpointDue(r, false, nd, T, S, j), false);
	assert.equal(nd.condSince.get(stream), S);
	nd.lastActivity.set(stream, S + 60_000); // the author types again
	assert.equal(bodyCheckpointDue(r, false, nd, T, S + 61_000, j), false);
	assert.equal(nd.condSince.has(stream), false, "activity resets the fallback clock");
	const quietAt = S + 60_000 + S;
	assert.equal(bodyCheckpointDue(r, false, nd, T, quietAt, j), false);
	assert.equal(bodyCheckpointDue(r, false, nd, T, quietAt + F + j - 1, j), false);
	assert.equal(bodyCheckpointDue(r, false, nd, T, quietAt + F + j, j), true, "fallback after F + jitter of quiet");
	// A typed-in doc past the hot threshold still waits for the (short) idle gate.
	const hot = rec({ rowsSinceRemoteCheckpoint: REMOTE_CHECKPOINT_ROWS });
	const ht = new CheckpointState();
	ht.lastActivity.set(stream, 1_000_000);
	assert.equal(bodyCheckpointDue(hot, true, ht, T, 1_000_000 + REMOTE_CHECKPOINT_IDLE_MS - 1, 0), false, "hot, typing");
	assert.equal(bodyCheckpointDue(hot, true, ht, T, 1_000_000 + REMOTE_CHECKPOINT_IDLE_MS, 0), true, "hot uses idleMs, not S");
	assert.equal(bodyCheckpointDue(rec({ rowsSinceRemoteCheckpoint: REMOTE_CHECKPOINT_ROWS - 1 }), true, ht, T, 1_000_000 + REMOTE_CHECKPOINT_IDLE_MS, 0), false, "below hot: settle window");
});

test("idle gate after a restart: a stream with no activity seen counts as active when the run went live", () => {
	const r = rec({ remoteCheckpointCoversSeq: 4, rowsSinceRemoteCheckpoint: 3 });
	const t0 = 5 * S;
	const st = new CheckpointState();
	st.markLive(t0);
	st.markLive(t0 + 1_000); // only the first live tick counts
	assert.equal(bodyCheckpointDue(r, true, st, T, t0 + S - 1, 0), false, "settle: S after going live");
	assert.equal(bodyCheckpointDue(r, true, st, T, t0 + S, 0), true);
	const ht = new CheckpointState();
	ht.markLive(t0);
	const hot = rec({ rowsSinceRemoteCheckpoint: REMOTE_CHECKPOINT_ROWS });
	assert.equal(bodyCheckpointDue(hot, true, ht, T, t0 + REMOTE_CHECKPOINT_IDLE_MS - 1, 0), false, "hot: idleMs after going live");
	assert.equal(bodyCheckpointDue(hot, true, ht, T, t0 + REMOTE_CHECKPOINT_IDLE_MS, 0), true);
	st.lastActivity.set(stream, t0 + S); // activity seen in this run wins
	assert.equal(bodyCheckpointDue(r, true, st, T, t0 + S + 1, 0), false);
});

test("bodyCheckpointDue: never for a stale / frozen stream, during a hold or backoff, or while too large and unchanged", () => {
	const r = rec({ rowsSinceRemoteCheckpoint: 3 });
	const now = 10 * S;
	assert.equal(bodyCheckpointDue(rec({ rowsSinceRemoteCheckpoint: 3, stale: 1, remoteHeadSeq: 11 }), true, new CheckpointState(), T, now, 0), false, "stale (not loaded)");
	assert.equal(bodyCheckpointDue(rec({ rowsSinceRemoteCheckpoint: 3, frozen: 1 }), true, new CheckpointState(), T, now, 0), false, "frozen");
	const held = new CheckpointState();
	held.holdUntilMono = now + 1;
	assert.equal(bodyCheckpointDue(r, true, held, T, now, 0), false, "daily-limit hold");
	const bo = new CheckpointState();
	bo.backoffUntil.set(stream, now + 1);
	assert.equal(bodyCheckpointDue(r, true, bo, T, now, 0), false, "backoff");
	const tl = new CheckpointState();
	tl.tooLarge.set(stream, { bytes: 1, seq: 10 });
	assert.equal(bodyCheckpointDue(r, true, tl, T, now, 0), false, "too large at this seq");
	assert.equal(bodyCheckpointDue(rec({ rowsSinceRemoteCheckpoint: 4, appliedSeq: 11 }), true, tl, T, now, 0), true, "a new row: try again (75 % rule)");
});

test("settle cap: at most REMOTE_CHECKPOINT_SETTLE_DAILY puts per device per 24 h open the settle rule; hot is not capped", () => {
	const st = new CheckpointState();
	st.lastActivity.set(stream, 0);
	const t0 = S;
	const r = rec({ remoteCheckpointCoversSeq: 4, rowsSinceRemoteCheckpoint: 3 });
	assert.equal(bodyCheckpointDue(r, true, st, T, t0, 0), true);
	st.written += REMOTE_CHECKPOINT_SETTLE_DAILY;
	assert.equal(bodyCheckpointDue(r, true, st, T, t0 + 1, 0), false, "cap reached");
	assert.equal(bodyCheckpointDue(rec({ rowsSinceRemoteCheckpoint: REMOTE_CHECKPOINT_ROWS }), true, st, T, t0 + 1, 0), true, "hot rule still fires");
	assert.equal(bodyCheckpointDue(r, true, st, T, t0 + 24 * 60 * 60_000 - 1, 0), false);
	assert.equal(bodyCheckpointDue(r, true, st, T, t0 + 24 * 60 * 60_000, 0), true, "next window");
});

test("foldCheckpointDue: hot without idle gate; settle after S idle; at most up to the newest candidate", () => {
	const fold = (seq: number, self: boolean) => ({ stream: NS_STREAM, halted: false, candidate: { seq, bytes: new Uint8Array(1), authoredBySelf: self } }) as unknown as FoldRuntime<unknown, unknown>;
	const ns = (o: Partial<StreamRecord>) => rec({ stream: NS_STREAM, cls: "ns", ...o });
	const st = new CheckpointState();
	st.lastActivity.set(NS_STREAM, 0);
	assert.equal(foldCheckpointDue(ns({ appliedSeq: 1500, rowsSinceRemoteCheckpoint: T.nsRows }), fold(1000, true), st, T, 1, 0), true, "hot: no idle gate");
	const r = ns({ appliedSeq: 1500, remoteCheckpointCoversSeq: 400, rowsSinceRemoteCheckpoint: 5 });
	assert.equal(foldCheckpointDue(r, fold(1000, true), st, T, S - 1, 0), false, "settle waits for S idle");
	assert.equal(foldCheckpointDue(r, fold(1000, true), st, T, S, 0), true);
	assert.equal(foldCheckpointDue(r, fold(400, true), st, T, S, 0), false, "no candidate above the remote checkpoint");
	const nd = new CheckpointState();
	nd.lastActivity.set(NS_STREAM, 0);
	assert.equal(foldCheckpointDue(r, fold(1000, false), nd, T, S, 7), false);
	assert.equal(foldCheckpointDue(r, fold(1000, false), nd, T, S + F + 7, 7), true, "non-author: fallback");
});

// ---- engine, virtual clock, shipped constants -------------------------------------------------------------------

/** Shipped checkpoint tuning; maintenance / status / gap timers at their defaults (virtual minutes stay cheap). */
const TUNING = { maintenanceMs: 1_000, statusIntervalMs: 250, gapMs: 5_000 };

function behind(relay: SimRelay, s: StreamName): number {
	const c = relay.checkpoint(s)?.coversSeq ?? 0;
	return relay.rows(s, { includeGc: true }).filter((r) => r.seq > c).length;
}

test("engine: a quiescent vault ends with no tail; the typed-in doc is not checkpointed; one put per stream, non-duty devices read", async () => {
	const clock = new VirtualClock(Date.UTC(2026, 0, 1, 12, 0));
	const relay = new SimRelay({ clock });
	const es: LogEngine[] = [];
	for (const d of ["a", "b"]) es.push((await startTestEngine({ relay, deviceId: `dev-${d}`, clock, tuning: TUNING })).engine);
	const [a, b] = es as [LogEngine, LogEngine];
	try {
		await until(() => es.every((e) => e.status().phase === "live"), 10_000, "live", clock);
		const single = await drive(a.createDoc("single.md" as VaultPath, "one row"), clock);
		const typing = await drive(a.createDoc("typing.md" as VaultPath, "draft"), clock);
		const ids: DocId[] = [];
		for (let i = 0; i < 8; i++) ids.push(await drive(a.createDoc(`d${i}.md` as VaultPath, `seed ${i};`), clock));
		await converged(es, 30_000, clock);
		// Below the hot threshold: 2..9 edits per doc; odd docs end on b, every third doc is edited by both.
		for (let i = 0; i < ids.length; i++) {
			for (let k = 0; k < 2 + i; k++) {
				const e = i % 3 === 0 ? (k % 2 === 0 ? a : b) : i % 2 === 1 ? b : a;
				await drive(e.editDoc(ids[i]!, (t) => t.insert(t.length, `e${k};`)), clock);
				await sleep(200, clock);
			}
		}
		await converged(es, 30_000, clock);
		const streams = ids.map((id) => a.streamOf(id));
		const ts = a.streamOf(typing);
		for (const s of streams) assert.ok(relay.rows(s).length >= 2 && relay.rows(s).length < REMOTE_CHECKPOINT_ROWS, `${s} below the hot threshold`);
		assert.equal(relay.rows(a.streamOf(single)).length, 1);

		let typed = 0;
		const typeFor = async (ms: number) => {
			for (let t = 0; t < ms; t += 5_000) {
				await drive(a.editDoc(typing, (x) => x.insert(x.length, "x")), clock);
				typed++;
				await sleep(5_000, clock);
			}
		};
		await typeFor(S + 60_000);
		const written = () => es.reduce((n, e) => n + e.c.ckpt.written, 0);
		for (const s of streams) assert.equal(behind(relay, s), 0, `${s}: no row behind the checkpoint after S of quiet`);
		assert.equal(written(), streams.length, "one put per stream, by its duty device");
		assert.equal(relay.checkpoint(ts), null, "typed-in doc: idle gate closed");
		assert.equal(relay.checkpoint(a.streamOf(single)), null, "single-row stream: no checkpoint");

		// Up to S + F + jitter: every non-duty device's fallback reads the checkpoint instead of putting one.
		await typeFor(2 * F + 60_000);
		assert.ok(typed > REMOTE_CHECKPOINT_ROWS, "typed past the hot threshold");
		assert.ok(relay.rows(ts).length > REMOTE_CHECKPOINT_ROWS);
		assert.equal(relay.checkpoint(ts), null, "typed-in doc past the hot threshold: still no checkpoint while typing");
		assert.equal(written(), streams.length, "no second put");
		const outcomes = es.map((e) => e.c.ckpt.results);
		assert.equal(outcomes.reduce((n, o) => n + (o.conflict ?? 0), 0), 0, JSON.stringify(outcomes));
		assert.equal(outcomes.reduce((n, o) => n + (o.refreshed ?? 0), 0), streams.length, `each non-duty device read once: ${JSON.stringify(outcomes)}`);
		for (const e of es) {
			for (const s of streams) {
				const r = e.c.repo.stream(s)!;
				assert.equal(r.remoteCheckpointCoversSeq, r.appliedSeq, `${e.c.self} ${s} knows the checkpoint`);
				assert.equal(r.rowsSinceRemoteCheckpoint, 0, `${e.c.self} ${s}: not due again`);
			}
		}

		// Typing stops: the doc settles too.
		await sleep(S + 5_000, clock);
		assert.equal(behind(relay, ts), 0, "typed-in doc checkpointed once quiet");
		assert.equal(relay.checkpoint(a.streamOf(single)), null);
		for (const s of streams) assert.equal(behind(relay, s), 0);
	} finally {
		for (const e of es) await drive(e.stop(), clock);
	}
});

test("engine: the duty device goes away before S; the other device checkpoints after S + fallback + jitter", async () => {
	const clock = new VirtualClock(Date.UTC(2026, 0, 1, 12, 0));
	const relay = new SimRelay({ clock });
	const a = (await startTestEngine({ relay, deviceId: "dev-a", clock, tuning: TUNING })).engine;
	const b = (await startTestEngine({ relay, deviceId: "dev-b", clock, tuning: TUNING })).engine;
	let aRunning = true;
	try {
		await until(() => a.status().phase === "live" && b.status().phase === "live", 10_000, "live", clock);
		const ids: DocId[] = [];
		for (let i = 0; i < 4; i++) {
			ids.push(await drive(a.createDoc(`g${i}.md` as VaultPath, `seed ${i};`), clock));
			for (let k = 0; k < 3; k++) await drive(a.editDoc(ids[i]!, (t) => t.insert(t.length, `e${k};`)), clock);
		}
		await converged([a, b], 30_000, clock);
		const streams = ids.map((id) => a.streamOf(id));
		await drive(a.stop(), clock);
		aRunning = false;
		await sleep(S + F - 1_000, clock);
		assert.equal(b.c.ckpt.written, 0, "no fallback before S + F");
		await sleep(F + 2_000, clock);
		for (const s of streams) assert.equal(behind(relay, s), 0, `${s} checkpointed by the fallback device`);
		assert.equal(b.c.ckpt.written, streams.length);
		assert.equal(b.c.ckpt.results.refreshed, undefined, "the read found no checkpoint, so b put one");
	} finally {
		if (aRunning) await drive(a.stop(), clock);
		await drive(b.stop(), clock);
	}
});

test("engine: a restart in the middle of an edit session waits S after going live before the settle put", async () => {
	const clock = new VirtualClock(Date.UTC(2026, 0, 1, 12, 0));
	const relay = new SimRelay({ clock });
	const first = await startTestEngine({ relay, deviceId: "dev-a", clock, tuning: TUNING });
	let a = first.engine;
	try {
		await until(() => a.status().phase === "live", 10_000, "live", clock);
		const id = await drive(a.createDoc("r.md" as VaultPath, "seed;"), clock);
		for (let k = 0; k < 3; k++) await drive(a.editDoc(id, (t) => t.insert(t.length, `e${k};`)), clock);
		await converged([a], 30_000, clock);
		const s = a.streamOf(id);
		await sleep(60_000, clock); // the restart comes before S of quiet
		await drive(a.stop(), clock);
		a = (await startTestEngine({ relay, deviceId: "dev-a", clock, tuning: TUNING, storage: first.storage })).engine;
		await until(() => a.status().phase === "live", 10_000, "live again", clock);
		assert.ok(a.c.repo.hasCkptDuty(s), "still the duty device");
		await sleep(S - 5_000, clock);
		assert.equal(relay.checkpoint(s), null, "no put before S after going live: the edit session may go on");
		await sleep(10_000, clock);
		assert.equal(behind(relay, s), 0, "settled S after going live");
		assert.equal(a.c.ckpt.written, 1);
	} finally {
		await drive(a.stop(), clock);
	}
});

test("engine: ns settles at its newest candidate once quiet (below NS_CHECKPOINT_ROWS)", async () => {
	const clock = new VirtualClock(Date.UTC(2026, 0, 1, 12, 0));
	const relay = new SimRelay({ clock });
	const a = (await startTestEngine({ relay, deviceId: "dev-a", clock, tuning: TUNING })).engine;
	try {
		await until(() => a.status().phase === "live", 10_000, "live", clock);
		const x = await drive(a.createDoc("x.md" as VaultPath, "x"), clock);
		await drive(a.createDoc("y.md" as VaultPath, "y"), clock);
		// Move the vault seq past the first candidate boundary with body frames, then add an ns row there.
		while ((relay.rows(a.streamOf(x), { includeGc: true }).at(-1)?.seq ?? 0) < 1_000) {
			await drive(a.editDoc(x, (t) => t.insert(t.length, "z")), clock);
			await sleep(20, clock);
		}
		await drive(a.createDoc("z.md" as VaultPath, "z"), clock);
		await until(() => (a.c.ns.candidate?.seq ?? 0) > 1_000, 30_000, "ns candidate", clock);
		const cand = a.c.ns.candidate!.seq;
		assert.ok(relay.rows(NS_STREAM).length < DEFAULT_CHECKPOINT_TUNING.nsRows, "below the ns hot threshold");
		await sleep(S - 10_000, clock);
		assert.equal(relay.checkpoint(NS_STREAM), null, "not before S of quiet");
		await sleep(30_000, clock);
		assert.equal(relay.checkpoint(NS_STREAM)?.coversSeq, cand, "ns checkpoint at the newest candidate");
		assert.equal(behind(relay, a.streamOf(x)), 0, "the typed doc settled too");
	} finally {
		await drive(a.stop(), clock);
	}
});
