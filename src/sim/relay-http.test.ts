import { test } from "node:test";
import assert from "node:assert/strict";
import type { StreamName } from "../core/types";
import { VirtualClock } from "./clock";
import { SimRelay, SimRelayError, type SimRelayOptions } from "./relay";
import { bytes, connectPeer, frame, pump, type RelayPeer } from "./a-relay-testkit";

const ns = "ns" as StreamName;

async function setup(options: Omit<SimRelayOptions, "clock"> = {}): Promise<{ clock: VirtualClock; relay: SimRelay; a: RelayPeer }> {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, ...options });
	return { clock, relay, a: await connectPeer(relay, clock, "A") };
}

/** One commit per frame (each its own group commit), so small sealBytes seal predictably. */
async function commitEach(clock: VirtualClock, a: RelayPeer, frames: readonly [string, string, string | number][]): Promise<void> {
	for (const [stream, id, payload] of frames) {
		a.session.append(frame(stream, id, payload));
		await clock.runUntilIdle();
	}
}

const rejectsWith = (code: string) => (error: unknown): boolean => error instanceof SimRelayError && error.code === code;

test("relay feed: streams ordered by lastSeq, paged by feedPageRows; throughSeq = nextAfter or head; invalid cursor rejects", async () => {
	const { clock, relay, a } = await setup({ limits: { feedPageRows: 2 } });
	for (const [stream, id] of [["s1", "a"], ["s2", "b"], ["s3", "c"], ["s1", "d"], ["s4", "e"]] as const) a.session.append(frame(stream, id, "x"));
	await clock.runUntilIdle();
	const feed = (after: number) => pump(clock, a.session.feed(after));
	assert.deepEqual(await feed(0), { entries: [{ stream: "s2", lastSeq: 2 }, { stream: "s3", lastSeq: 3 }], throughSeq: 3, headSeq: 5, more: true });
	assert.deepEqual(await feed(3), { entries: [{ stream: "s1", lastSeq: 4 }, { stream: "s4", lastSeq: 5 }], throughSeq: 5, headSeq: 5, more: false });
	assert.deepEqual(await feed(5), { entries: [], throughSeq: 5, headSeq: 5, more: false });
	assert.deepEqual(await feed(9), { entries: [], throughSeq: 5, headSeq: 5, more: false });
	await assert.rejects(feed(-1), rejectsWith("invalid_cursor"));
	await assert.rejects(feed(1.5), rejectsWith("invalid_cursor"));
	assert.equal(relay.counters().commits, 1);
});

test("relay read: paged by payload bytes (at least one row) and readPageRows; nextAfterSeq; unknown stream; invalid args reject", async () => {
	const { clock, a } = await setup({ limits: { readPageBytes: 25 } });
	for (let i = 1; i <= 5; i++) a.session.append(frame("ns", `r${i}`, i === 4 ? 40 : 10));
	await clock.runUntilIdle();
	const read = (stream: string, after: number, prefer = false) => pump(clock, a.session.read(stream as StreamName, after, prefer));
	const pages: [number[], number, boolean][] = [];
	for (let after = 0, more = true; more;) {
		const page = await read("ns", after);
		assert.deepEqual([page.lastSeq, page.checkpointSeq, page.checkpoint], [5, 0, null]);
		pages.push([page.rows.map((r) => r.seq), page.nextAfterSeq, page.more]);
		({ more } = page);
		after = page.nextAfterSeq;
	}
	assert.deepEqual(pages, [[[1, 2], 2, true], [[3], 3, true], [[4], 4, true], [[5], 5, false]]);
	assert.deepEqual(await read("ns", 5), { checkpoint: null, rows: [], lastSeq: 5, checkpointSeq: 0, nextAfterSeq: 5, more: false });
	assert.deepEqual(await read("nope", 3), { checkpoint: null, rows: [], lastSeq: 0, checkpointSeq: 0, nextAfterSeq: 3, more: false });
	const row = (await read("ns", 0)).rows[0]!;
	assert.deepEqual([row.deviceId, row.clientFrameId, row.payload.byteLength], ["A", "r1", 10]);
	await assert.rejects(read("", 0), rejectsWith("invalid_stream"));
	await assert.rejects(read("ns", -1), rejectsWith("invalid_cursor"));

	const r2 = await setup({ readPageRows: 2 });
	for (let i = 1; i <= 5; i++) r2.a.session.append(frame("ns", `r${i}`, 10));
	await r2.clock.runUntilIdle();
	const page = await pump(r2.clock, r2.a.session.read(ns, 1, false));
	assert.deepEqual([page.rows.map((r) => r.seq), page.nextAfterSeq, page.more], [[2, 3], 3, true]);
});

test("relay readBatch: first pages in request order under one readPageBytes budget; first always served; cap; single fallback", async () => {
	const { clock, relay, a } = await setup({ limits: { readPageBytes: 25, readBatchStreams: 3 } });
	for (const [stream, id, size] of [["b:1", "x1", 10], ["b:2", "x2", 10], ["b:3", "x3", 10], ["b:1", "x4", 10], ["b:4", "x5", 40]] as const) {
		a.session.append(frame(stream, id, size));
	}
	await clock.runUntilIdle();
	const req = (stream: string, afterSeq = 0, preferCheckpoint = false) => ({ stream: stream as StreamName, afterSeq, preferCheckpoint });
	const batch = (...reqs: ReturnType<typeof req>[]) => pump(clock, a.session.readBatch(reqs));
	// b:1 (20 bytes) + b:2 (10) would overrun 25 -> only b:1.
	assert.deepEqual((await batch(req("b:1"), req("b:2"), req("b:3"))).map((p) => p.rows.map((r) => r.seq)), [[1, 4]]);
	assert.deepEqual((await batch(req("b:2"), req("b:3"), req("nope"), req("b:1"))).map((p) => [p.rows.map((r) => r.seq), p.lastSeq]),
		[[[2], 2], [[3], 3], [[], 0]], "capped at readBatchStreams (3)");
	assert.deepEqual((await batch(req("b:4"), req("b:2"))).map((p) => p.rows.length), [1], "first entry over budget is still served");
	assert.deepEqual((await batch(req("b:1", 1), req("b:2", 2))).map((p) => [p.rows.map((r) => r.seq), p.nextAfterSeq, p.more]),
		[[[4], 4, false], [[], 2, false]], "per-entry cursors");
	await assert.rejects(batch(req(""), req("b:1")), rejectsWith("invalid_stream"));
	await assert.rejects(pump(clock, a.session.readBatch([])), /no requests/);
	assert.equal(relay.limits.readBatchStreams, 3);

	const single = await setup({ limits: { readBatchStreams: 1 } });
	single.a.session.append(frame("b:1", "y1", 10));
	single.a.session.append(frame("b:2", "y2", 10));
	await single.clock.runUntilIdle();
	const one = await pump(single.clock, single.a.session.readBatch([req("b:1"), req("b:2")]));
	assert.deepEqual(one.map((p) => p.rows.map((r) => r.seq)), [[1]], "no batch form: read(reqs[0])");
});

test("relay checkpoint: CAS order (not found, conflict, not advancing, ahead), GC of covered sealed segments, reads take the checkpoint after GC", async () => {
	// rows are 1 + 2 + 3 + 11 = 17 bytes: one-row commits seal every 2 rows
	const { clock, relay, a } = await setup({ sealBytes: 34, limits: { maxCheckpointBytes: 16 } });
	await commitEach(clock, a, [1, 2, 3, 4, 5].map((i) => ["ns", `c${i}`, 10] as [string, string, number]));
	assert.deepEqual(relay.store.segments(ns).sealed.map((s) => [s.firstSeq, s.lastSeq]), [[1, 2], [3, 4]]);
	const put = (stream: string, covers: number, expected: number, body: string | number = "ck") => pump(clock, a.session.putCheckpoint(stream as StreamName, covers, expected, bytes(body)));
	assert.deepEqual(await put("nope", 1, 0), { t: "refused", reason: "stream-not-found", retryAfterMs: null });
	assert.deepEqual(await put("ns", 3, 1), { t: "conflict", currentCoversSeq: 0 });
	assert.deepEqual(await put("ns", 6, 0), { t: "refused", reason: "ahead-of-stream", retryAfterMs: null });
	assert.deepEqual(await put("ns", 3, 1, 17), { t: "refused", reason: "too-large", retryAfterMs: null }, "size is checked before the CAS");
	await assert.rejects(put("ns", 0, 0), rejectsWith("invalid_covers_seq"));
	await assert.rejects(put("ns", 3, -1), rejectsWith("invalid_expected_covers_seq"));
	await assert.rejects(put("", 3, 0), rejectsWith("invalid_stream"));

	assert.deepEqual(await put("ns", 3, 0, "ck3"), { t: "ok" });
	assert.deepEqual([relay.gcSeq(ns), relay.checkpoint(ns)?.coversSeq], [2, 3]);
	assert.deepEqual(relay.rows(ns).map((r) => r.seq), [3, 4, 5]);
	assert.deepEqual(relay.rows(ns, { includeGc: true }).map((r) => r.seq), [1, 2, 3, 4, 5]);
	assert.deepEqual(await put("ns", 3, 3), { t: "refused", reason: "not-advancing", retryAfterMs: null });
	assert.deepEqual(await put("ns", 2, 3), { t: "refused", reason: "not-advancing", retryAfterMs: null });
	assert.deepEqual(await put("ns", 4, 0), { t: "conflict", currentCoversSeq: 3 });

	const read = async (after: number, prefer: boolean) => {
		const page = await pump(clock, a.session.read(ns, after, prefer));
		const ck = page.checkpoint === null ? null : `${page.checkpoint.coversSeq}:${new TextDecoder().decode(page.checkpoint.bytes)}`;
		return [ck, page.rows.map((r) => r.seq), page.checkpointSeq, page.nextAfterSeq];
	};
	assert.deepEqual(await read(0, false), ["3:ck3", [4, 5], 3, 5], "after < gcSeq: the checkpoint is required");
	assert.deepEqual(await read(1, false), ["3:ck3", [4, 5], 3, 5]);
	assert.deepEqual(await read(2, false), [null, [3, 4, 5], 3, 5]);
	assert.deepEqual(await read(2, true), ["3:ck3", [4, 5], 3, 5], "preferCheckpoint and after < coversSeq");
	assert.deepEqual(await read(3, true), [null, [4, 5], 3, 5]);

	assert.deepEqual(await put("ns", 5, 3, "ck5"), { t: "ok" });
	assert.equal(relay.gcSeq(ns), 4);
	assert.deepEqual(relay.store.segments(ns), { sealed: [], open: { firstSeq: 5, lastSeq: 5, rows: 1, bytes: 17 } }, "the open segment is never collected");
	assert.deepEqual(await read(0, false), ["5:ck5", [], 5, 5]);
	assert.deepEqual(await read(4, false), [null, [5], 5, 5]);
});

test("relay checkpoint: gcOnCheckpoint false keeps segments; a checkpoint consumes read budget", async () => {
	const { clock, relay, a } = await setup({ sealBytes: 34, gcOnCheckpoint: false, limits: { readPageBytes: 25 } });
	await commitEach(clock, a, [1, 2, 3, 4].map((i) => ["ns", `c${i}`, 10] as [string, string, number]));
	assert.deepEqual(await pump(clock, a.session.putCheckpoint(ns, 2, 0, bytes(20))), { t: "ok" });
	assert.equal(relay.gcSeq(ns), 0);
	const page = await pump(clock, a.session.read(ns, 0, true));
	assert.deepEqual([page.checkpoint?.coversSeq, page.rows.map((r) => r.seq), page.nextAfterSeq, page.more], [2, [], 2, true]);
	const next = await pump(clock, a.session.read(ns, page.nextAfterSeq, true));
	assert.deepEqual([next.checkpoint, next.rows.map((r) => r.seq), next.more], [null, [3, 4], false]);
});

test("relay http: answered from state at request arrival (httpMs each way); does not flush the buffer; setHttpFailure -> network_error", async () => {
	const { clock, relay, a } = await setup({ link: { httpMs: 30 } });
	a.session.append(frame("ns", "n1", "x"));
	await clock.advance(1);
	const t = clock.monotonic();
	let resolvedAt = -1;
	const feed = a.session.feed(0).then((page) => {
		resolvedAt = clock.monotonic() - t;
		return page;
	});
	await clock.advance(40); // the request was answered at +30
	relay.commitNow();
	const page = await pump(clock, feed);
	assert.deepEqual([page.headSeq, resolvedAt], [0, 60]);
	assert.equal(relay.head(), 1);

	a.session.append(frame("ns", "n2", "y"));
	await clock.advance(1);
	assert.equal((await pump(clock, a.session.feed(0))).headSeq, 1);
	assert.equal(relay.pendingCount(), 1, "feed/read never force a commit");
	await clock.runUntilIdle();
	relay.setHttpFailure(true);
	await assert.rejects(pump(clock, a.session.feed(0)), rejectsWith("network_error"));
	await assert.rejects(pump(clock, a.session.read(ns, 0, false)), rejectsWith("network_error"));
	await assert.rejects(pump(clock, a.session.putCheckpoint(ns, 1, 0, bytes("c"))), rejectsWith("network_error"));
	relay.setHttpFailure(false);
	assert.equal((await pump(clock, a.session.feed(0))).headSeq, 2);
	await pump(clock, relay.flush());
	assert.ok(relay.quiescent());
});
