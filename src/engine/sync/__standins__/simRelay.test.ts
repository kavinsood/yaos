// Tests for the STAND-IN sim relay (replaced by WP-A src/sim/relay.ts at integration).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientFrameId, DeviceId, StreamName, VaultId } from "../../../core/types";
import type { FeedPage, RelayEvent, RelaySession } from "../../../ports/relay";
import { SimRelay, SimRelayError, type SimRelayOptions } from "./simRelay";

const VAULT = "vault-1" as VaultId;
const A = "device-a" as DeviceId;
const B = "device-b" as DeviceId;
const C = "device-c" as DeviceId;
const R = "device-readonly" as DeviceId;
const NS = "ns" as StreamName;
const BX = "b:x" as StreamName;
const CY = "c:y" as StreamName;
const s = (name: string): StreamName => name as StreamName;
const id = (v: string): ClientFrameId => v as ClientFrameId;
const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const filled = (size: number, value: number): Uint8Array => new Uint8Array(size).fill(value);

interface Client {
	readonly session: RelaySession;
	readonly events: RelayEvent[];
}

async function connect(relay: SimRelay, deviceId: DeviceId, listen = true): Promise<Client> {
	const result = await relay.connect({ vaultId: VAULT, deviceId });
	if (!result.ok) throw new Error(`connect failed: ${result.reason}`);
	const events: RelayEvent[] = [];
	if (listen) result.session.onEvent((e) => events.push(e));
	return { session: result.session, events };
}

function append(c: Client, stream: StreamName, clientFrameId: string, payload: Uint8Array): void {
	c.session.append({ stream, clientFrameId: id(clientFrameId), payload });
}

/** Compact event trace: "t:stream:seq/id" forms that are easy to compare. */
function trace(events: readonly RelayEvent[]): string[] {
	return events.map((e) => {
		switch (e.t) {
			case "receipt": return `receipt ${e.stream} ${e.clientFrameId} ${e.seq}${e.deduped ? " deduped" : ""}`;
			case "committed": return `committed ${e.frame.stream} ${e.frame.clientFrameId} ${e.frame.seq}${e.frame.payload === null ? " null" : ""}`;
			case "provisional": return `provisional ${e.stream} ${e.clientFrameId}`;
			case "refused": return `refused ${e.stream} ${e.clientFrameId} ${e.reason}${e.conflictSeq === null ? "" : ` ${e.conflictSeq}`}${e.retryAfterMs === null ? "" : ` +${e.retryAfterMs}`}`;
			case "provisionalDropped": return `dropped ${e.stream} ${e.clientFrameId}`;
			case "resendUnreceipted": return `resend ${e.headSeq}`;
			case "backpressure": return "backpressure";
			case "head": return `head ${e.headSeq}`;
			case "closed": return `closed ${e.code} ${e.errorCode ?? "-"} ${e.wasClean ? "clean" : "unclean"}`;
		}
	});
}

function committedPayload(events: readonly RelayEvent[], seq: number): Uint8Array | null | undefined {
	for (const e of events) if (e.t === "committed" && e.frame.seq === seq) return e.frame.payload;
	return undefined;
}

function relay(options: SimRelayOptions = {}): SimRelay {
	return new SimRelay(options);
}

test("seqs are vault-wide and contiguous from 1 across group commits", async () => {
	const r = relay();
	const a = await connect(r, A);
	append(a, NS, "f1", bytes(1));
	append(a, BX, "f2", bytes(2));
	append(a, NS, "f3", bytes(3));
	await r.settled();
	append(a, CY, "f4", bytes(4));
	append(a, NS, "f5", bytes(5));
	await r.settled();
	assert.equal(r.head(), 5);
	assert.deepEqual(r.rows(NS).map((row) => row.seq), [1, 3, 5]);
	assert.deepEqual(r.rows(BX).map((row) => row.seq), [2]);
	assert.deepEqual(r.rows(CY).map((row) => row.seq), [4]);
	assert.deepEqual(trace(a.events), [
		"receipt ns f1 1", "receipt b:x f2 2", "receipt ns f3 3", "head 3",
		"receipt c:y f4 4", "receipt ns f5 5", "head 5",
	]);
	assert.equal(a.session.headSeq, 0);
	assert.equal(a.session.vaultEpoch, "sim-epoch-1");
	assert.equal(a.session.bufferedBytes(), 0);
});

test("one group commit: broadcasts in seq order, then the origin's receipts; never synchronous inside append", async () => {
	const r = relay();
	const a = await connect(r, A);
	const b = await connect(r, B);
	append(a, NS, "a1", bytes(1));
	append(b, NS, "b1", bytes(2));
	append(a, NS, "a2", bytes(3));
	append(b, BX, "b2", bytes(4));
	assert.equal(a.events.length, 0, "no synchronous delivery inside append");
	assert.equal(b.events.length, 0);
	await r.settled();
	assert.deepEqual(trace(a.events), [
		"provisional b:x b2",
		"committed ns b1 2", "committed b:x b2 4",
		"receipt ns a1 1", "receipt ns a2 3", "head 4",
	]);
	assert.deepEqual(trace(b.events), [
		"committed ns a1 1", "committed ns a2 3",
		"receipt ns b1 2", "receipt b:x b2 4", "head 4",
	]);
	assert.deepEqual(committedPayload(a.events, 2), bytes(2));
	assert.deepEqual(committedPayload(a.events, 4), bytes(4));
});

test("b:/c: get provisional then committed (with payload); ns is commit-only; late sessions get committed from the row", async () => {
	const r = relay();
	const a = await connect(r, A);
	const b = await connect(r, B);
	r.pauseCommits();
	append(a, BX, "p1", bytes(10));
	append(a, CY, "p2", bytes(20));
	append(a, NS, "n1", bytes(30));
	await r.settled();
	assert.deepEqual(trace(b.events), ["provisional b:x p1", "provisional c:y p2"]);
	const late = await connect(r, C);
	r.resumeCommits();
	await r.settled();
	assert.deepEqual(trace(b.events), [
		"provisional b:x p1", "provisional c:y p2",
		"committed b:x p1 1", "committed c:y p2 2", "committed ns n1 3",
	]);
	assert.deepEqual(committedPayload(b.events, 1), bytes(10));
	assert.deepEqual(committedPayload(b.events, 2), bytes(20));
	assert.deepEqual(committedPayload(b.events, 3), bytes(30));
	assert.deepEqual(trace(late.events), ["committed b:x p1 1", "committed c:y p2 2", "committed ns n1 3"]);
	assert.deepEqual(committedPayload(late.events, 1), bytes(10));
	assert.ok(!a.events.some((e) => e.t === "committed" || e.t === "provisional"), "the author never gets its own frame");
});

test("dedupe within the window: deduped receipt with the original seq; b: peers get provisional + older-seq committed; ns not re-delivered", async () => {
	const r = relay();
	const a1 = await connect(r, A);
	const b = await connect(r, B);
	append(a1, NS, "n1", bytes(1));
	append(a1, BX, "x1", bytes(2));
	await r.settled();
	append(b, NS, "bn", bytes(3));
	await r.settled();
	assert.equal(r.head(), 3);
	a1.session.close(1000, "reconnect");
	const a2 = await connect(r, A);
	b.events.length = 0;
	append(a2, NS, "n1", bytes(1));
	append(a2, BX, "x1", bytes(2));
	await r.settled();
	assert.equal(r.head(), 3, "no new rows");
	assert.deepEqual(trace(a2.events), ["receipt ns n1 1 deduped", "receipt b:x x1 2 deduped", "head 3"]);
	assert.deepEqual(trace(b.events), ["provisional b:x x1", "committed b:x x1 2"], "R7: older seq, ns not re-delivered");
	assert.deepEqual(committedPayload(b.events, 2), bytes(2));
});

test("a resend while still pending (another session of the device) joins it: peer delivery + deduped receipt", async () => {
	const r = relay();
	const a1 = await connect(r, A);
	const a2 = await connect(r, A);
	r.pauseCommits();
	append(a1, NS, "n1", bytes(7));
	append(a2, NS, "n1", bytes(7));
	await r.flush();
	assert.equal(r.head(), 1);
	assert.deepEqual(trace(a1.events), ["receipt ns n1 1", "head 1"]);
	assert.deepEqual(trace(a2.events), ["committed ns n1 1", "receipt ns n1 1 deduped", "head 1"]);
});

test("outside the dedupe window a resend is appended again with a new seq", async () => {
	const r = relay({ dedupeWindow: 2 });
	const a = await connect(r, A);
	const b = await connect(r, B);
	append(a, NS, "f1", bytes(1));
	append(a, NS, "f2", bytes(2));
	append(a, NS, "f3", bytes(3));
	append(a, BX, "other-stream", bytes(9));
	await r.settled();
	a.events.length = 0;
	b.events.length = 0;
	append(a, NS, "f1", bytes(1));
	append(a, NS, "f3", bytes(3));
	await r.settled();
	assert.equal(r.head(), 5);
	assert.deepEqual(trace(a.events), ["receipt ns f1 5", "receipt ns f3 3 deduped", "head 5"]);
	assert.deepEqual(trace(b.events), ["committed ns f1 5"]);
	assert.deepEqual(r.rows(NS).map((row) => [row.seq, row.clientFrameId]), [[1, "f1"], [2, "f2"], [3, "f3"], [5, "f1"]]);
});

test("frame-id-conflict: different bytes after commit (conflictSeq, provisional dropped) and different stream while pending", async () => {
	const r = relay();
	const a = await connect(r, A);
	const b = await connect(r, B);
	append(a, NS, "k1", bytes(1));
	append(a, BX, "k2", bytes(2));
	await r.settled();
	a.events.length = 0;
	b.events.length = 0;
	append(a, NS, "k1", bytes(99));
	append(a, BX, "k2", bytes(98));
	await r.settled();
	assert.equal(r.head(), 2);
	assert.deepEqual(trace(a.events), ["refused ns k1 frame-id-conflict 1", "refused b:x k2 frame-id-conflict 2"]);
	assert.deepEqual(trace(b.events), ["provisional b:x k2", "dropped b:x k2"]);

	a.events.length = 0;
	b.events.length = 0;
	r.pauseCommits();
	append(a, BX, "k3", bytes(3));
	append(a, CY, "k3", bytes(3));
	append(a, BX, "k3", bytes(4));
	await r.settled();
	assert.deepEqual(trace(a.events), ["refused c:y k3 frame-id-conflict", "refused b:x k3 frame-id-conflict"]);
	assert.deepEqual(trace(b.events), ["provisional b:x k3"], "a pending conflict is never broadcast");
	r.resumeCommits();
	await r.settled();
	assert.equal(r.head(), 3);
	assert.deepEqual(r.rows(BX).map((row) => row.clientFrameId), ["k2", "k3"]);
});

test("restart: uncommitted frames lost, resendUnreceipted to every session, held provisionals dropped silently", async () => {
	const r = relay();
	const a = await connect(r, A);
	const b = await connect(r, B);
	append(a, NS, "n0", bytes(0));
	await r.settled();
	r.pauseCommits();
	append(a, NS, "n1", bytes(1));
	append(a, BX, "x1", bytes(2));
	await r.settled();
	r.restart();
	r.resumeCommits();
	await r.settled();
	assert.equal(r.head(), 1);
	assert.equal(r.pendingCount(), 0);
	assert.deepEqual(trace(a.events), ["receipt ns n0 1", "head 1", "resend 1"]);
	assert.deepEqual(trace(b.events), ["committed ns n0 1", "provisional b:x x1", "resend 1"]);
	append(a, NS, "n1", bytes(1));
	append(a, BX, "x1", bytes(2));
	await r.settled();
	assert.equal(r.head(), 3);
	assert.deepEqual(trace(a.events).slice(3), ["receipt ns n1 2", "receipt b:x x1 3", "head 3"]);
	assert.deepEqual(trace(b.events).slice(3), ["provisional b:x x1", "committed ns n1 2", "committed b:x x1 3"]);
	assert.deepEqual(committedPayload(b.events, 3), bytes(2));
});

test("feed pages by streams; throughSeq = nextAfter or head; no stream is lost across pages", async () => {
	const r = relay({ limits: { feedPageRows: 2 } });
	const a = await connect(r, A);
	const plan = ["s1", "s2", "s1", "s3", "s4", "s2", "s5"];
	for (const [i, name] of plan.entries()) {
		append(a, s(name), `f${i}`, bytes(i));
		await r.settled();
	}
	// lastSeq: s1:3 s3:4 s4:5 s2:6 s5:7
	const pages: FeedPage[] = [];
	let after = 0;
	for (;;) {
		const page = await a.session.feed(after);
		pages.push(page);
		if (!page.more) break;
		after = page.throughSeq;
	}
	assert.deepEqual(pages.map((p) => [p.entries.map((e) => `${e.stream}:${e.lastSeq}`), p.throughSeq, p.headSeq, p.more]), [
		[["s1:3", "s3:4"], 4, 7, true],
		[["s4:5", "s2:6"], 6, 7, true],
		[["s5:7"], 7, 7, false],
	]);
	// Cursor safety: every commit <= throughSeq belongs to a stream listed so far, or one whose lastSeq is past
	// throughSeq (so feed(throughSeq) lists it).
	const listed = new Set<string>();
	let prev = 0;
	for (const page of pages) {
		for (const e of page.entries) listed.add(e.stream);
		for (const name of r.streams()) {
			const lastSeq = r.rows(name).at(-1)?.seq ?? 0;
			if (lastSeq > prev && lastSeq <= page.throughSeq) assert.ok(listed.has(name), `${name} listed by page through ${page.throughSeq}`);
			const hasCommitInRange = r.rows(name).some((row) => row.seq > prev && row.seq <= page.throughSeq);
			if (hasCommitInRange) assert.ok(listed.has(name) || lastSeq > page.throughSeq);
		}
		prev = page.throughSeq;
	}
	const empty = await a.session.feed(7);
	assert.deepEqual(empty, { entries: [], throughSeq: 7, headSeq: 7, more: false });
	// Uncommitted frames are invisible to feed (it does not flush the buffer).
	r.pauseCommits();
	append(a, s("s6"), "f-late", bytes(1));
	const lagging = await a.session.feed(7);
	assert.deepEqual(lagging.entries, []);
	assert.equal(lagging.headSeq, 7);
	await assert.rejects(a.session.feed(-1), (e: unknown) => e instanceof SimRelayError && e.code === "invalid_cursor");
});

test("read pages by bytes and rows; nextAfterSeq/more/lastSeq; unknown stream", async () => {
	const r = relay({ limits: { readPageBytes: 25 } });
	const a = await connect(r, A);
	for (let i = 1; i <= 5; i++) append(a, BX, `x${i}`, filled(10, i));
	append(a, NS, "other", bytes(1));
	await r.settled();
	const p1 = await a.session.read(BX, 0, false);
	assert.deepEqual([p1.rows.map((row) => row.seq), p1.nextAfterSeq, p1.more, p1.lastSeq, p1.checkpointSeq, p1.checkpoint], [[1, 2], 2, true, 5, 0, null]);
	assert.equal(p1.rows[0]?.clientFrameId, "x1");
	assert.equal(p1.rows[0]?.deviceId, A);
	assert.deepEqual(p1.rows[0]?.payload, filled(10, 1));
	const p2 = await a.session.read(BX, p1.nextAfterSeq, false);
	assert.deepEqual([p2.rows.map((row) => row.seq), p2.nextAfterSeq, p2.more], [[3, 4], 4, true]);
	const p3 = await a.session.read(BX, p2.nextAfterSeq, false);
	assert.deepEqual([p3.rows.map((row) => row.seq), p3.nextAfterSeq, p3.more], [[5], 5, false]);
	const p4 = await a.session.read(BX, 5, false);
	assert.deepEqual([p4.rows, p4.nextAfterSeq, p4.more, p4.lastSeq], [[], 5, false, 5]);
	// A row larger than the page still progresses (at least one row per page).
	append(a, BX, "big", filled(40, 9));
	await r.settled();
	const big = await a.session.read(BX, 5, false);
	assert.deepEqual([big.rows.map((row) => row.seq), big.more], [[7], false]);
	const unknown = await a.session.read(s("b:nope"), 3, true);
	assert.deepEqual(unknown, { checkpoint: null, rows: [], lastSeq: 0, checkpointSeq: 0, nextAfterSeq: 3, more: false });

	const rowsCapped = relay({ readPageRows: 1 });
	const c = await connect(rowsCapped, C);
	append(c, NS, "n1", bytes(1));
	append(c, NS, "n2", bytes(2));
	await rowsCapped.settled();
	const q1 = await c.session.read(NS, 0, false);
	assert.deepEqual([q1.rows.map((row) => row.seq), q1.nextAfterSeq, q1.more], [[1], 1, true]);
});

test("read after checkpoint + GC returns the checkpoint; preferCheckpoint takes a newer one while rows exist", async () => {
	const r = relay({ limits: { readPageBytes: 25 } });
	const a = await connect(r, A);
	for (let i = 1; i <= 5; i++) append(a, BX, `x${i}`, filled(10, i));
	await r.settled();
	assert.deepEqual(await a.session.putCheckpoint(BX, 3, 0, filled(4, 7)), { t: "ok" });
	assert.equal(r.gcSeq(BX), 3);
	assert.deepEqual(r.rows(BX).map((row) => row.seq), [4, 5]);
	assert.equal(r.rows(BX, { includeGc: true }).length, 5);
	assert.deepEqual(r.checkpoint(BX), { coversSeq: 3, bytes: filled(4, 7) });

	const gone = await a.session.read(BX, 1, false);
	assert.deepEqual(gone.checkpoint, { coversSeq: 3, bytes: filled(4, 7) });
	assert.deepEqual([gone.rows.map((row) => row.seq), gone.checkpointSeq, gone.nextAfterSeq, gone.more], [[4, 5], 3, 5, false]);
	const atCheckpoint = await a.session.read(BX, 3, true);
	assert.equal(atCheckpoint.checkpoint, null, "coversSeq is not newer than afterSeq");
	assert.deepEqual(atCheckpoint.rows.map((row) => row.seq), [4, 5]);
	assert.equal(atCheckpoint.checkpointSeq, 3);

	// The checkpoint counts against the page budget; a page may carry only the checkpoint.
	assert.deepEqual(await a.session.putCheckpoint(BX, 4, 3, filled(20, 8)), { t: "ok" });
	const cpOnly = await a.session.read(BX, 0, false);
	assert.deepEqual([cpOnly.checkpoint?.coversSeq, cpOnly.rows.length, cpOnly.nextAfterSeq, cpOnly.more], [4, 0, 4, true]);
	const rest = await a.session.read(BX, cpOnly.nextAfterSeq, false);
	assert.deepEqual([rest.checkpoint, rest.rows.map((row) => row.seq), rest.more], [null, [5], false]);

	// Without GC the rows stay; preferCheckpoint opts into the newer checkpoint.
	const keep = relay({ gcOnCheckpoint: false });
	const k = await connect(keep, A);
	for (let i = 1; i <= 5; i++) append(k, CY, `y${i}`, bytes(i));
	await keep.settled();
	assert.deepEqual(await k.session.putCheckpoint(CY, 4, 0, bytes(44)), { t: "ok" });
	assert.equal(keep.gcSeq(CY), 0);
	const rowsPath = await k.session.read(CY, 1, false);
	assert.deepEqual([rowsPath.checkpoint, rowsPath.rows.map((row) => row.seq), rowsPath.checkpointSeq], [null, [2, 3, 4, 5], 4]);
	const preferred = await k.session.read(CY, 1, true);
	assert.deepEqual([preferred.checkpoint?.coversSeq, preferred.rows.map((row) => row.seq)], [4, [5]]);
});

test("checkpoint CAS outcomes: ok, conflict, not-advancing, ahead-of-stream, stream-not-found, too-large, daily-limit, forbidden", async () => {
	const r = relay({ limits: { maxCheckpointBytes: 8 }, readOnlyDevices: [R] });
	const a = await connect(r, A);
	const ro = await connect(r, R);
	append(a, NS, "n1", bytes(1));
	append(a, BX, "x1", bytes(2));
	append(a, NS, "n3", bytes(3));
	await r.settled();
	// lastSeq(ns) = 3; coversSeq need not be a row seq of the stream (2 is a b:x row).
	assert.deepEqual(await a.session.putCheckpoint(NS, 2, 0, bytes(1)), { t: "ok" });
	assert.deepEqual(await a.session.putCheckpoint(NS, 3, 0, bytes(1)), { t: "conflict", currentCoversSeq: 2 });
	assert.deepEqual(await a.session.putCheckpoint(NS, 2, 2, bytes(1)), { t: "refused", reason: "not-advancing", retryAfterMs: null });
	assert.deepEqual(await a.session.putCheckpoint(NS, 4, 2, bytes(1)), { t: "refused", reason: "ahead-of-stream", retryAfterMs: null });
	assert.deepEqual(await a.session.putCheckpoint(s("b:missing"), 1, 0, bytes(1)), { t: "refused", reason: "stream-not-found", retryAfterMs: null });
	assert.deepEqual(await a.session.putCheckpoint(NS, 3, 2, filled(9, 1)), { t: "refused", reason: "too-large", retryAfterMs: null });
	assert.deepEqual(await ro.session.putCheckpoint(NS, 3, 2, bytes(1)), { t: "refused", reason: "forbidden", retryAfterMs: null });
	r.setDailyLimit(true, 5_000);
	assert.deepEqual(await a.session.putCheckpoint(NS, 3, 2, bytes(1)), { t: "refused", reason: "daily-limit", retryAfterMs: 5_000 });
	r.setDailyLimit(false);
	assert.deepEqual(await a.session.putCheckpoint(NS, 3, 2, bytes(1)), { t: "ok" });
	assert.equal(r.checkpoint(NS)?.coversSeq, 3);
	await assert.rejects(a.session.putCheckpoint(NS, 0, 3, bytes(1)), (e: unknown) => e instanceof SimRelayError && e.code === "invalid_covers_seq");
});

test("oversize payload closes 1009; frames buffered before it still commit (receipts lost); the resend dedupes", async () => {
	const r = relay({ limits: { maxFrameBytes: 8 } });
	const a = await connect(r, A);
	const b = await connect(r, B);
	append(a, NS, "ok", bytes(1));
	append(a, NS, "huge", filled(9, 1));
	append(a, NS, "after-close", bytes(2));
	await r.settled();
	assert.deepEqual(trace(a.events), ["closed 1009 - clean"]);
	assert.deepEqual(trace(b.events), ["committed ns ok 1"]);
	assert.equal(r.head(), 1);
	assert.equal(r.sessions().length, 1);
	const a2 = await connect(r, A);
	append(a2, NS, "ok", bytes(1));
	await r.settled();
	assert.deepEqual(trace(a2.events), ["receipt ns ok 1 deduped", "head 1"]);
	// Malformed APPEND (empty clientFrameId) closes 1008.
	append(a2, NS, "", bytes(1));
	await r.settled();
	assert.deepEqual(trace(a2.events).at(-1), "closed 1008 - clean");
});

test("read-only device: canWrite=false, appends refused forbidden, nothing broadcast", async () => {
	const r = relay({ readOnlyDevices: [R] });
	const ro = await connect(r, R);
	const b = await connect(r, B);
	assert.equal(ro.session.canWrite, false);
	assert.equal(b.session.canWrite, true);
	append(ro, BX, "x1", bytes(1));
	await r.settled();
	assert.deepEqual(trace(ro.events), ["refused b:x x1 forbidden"]);
	assert.deepEqual(b.events, []);
	assert.equal(r.head(), 0);
});

test("events before the first listener are buffered and flushed in order; headSeq is the head at admission", async () => {
	const r = relay();
	const b = await connect(r, B);
	append(b, NS, "n1", bytes(1));
	await r.settled();
	const a = await connect(r, A, false);
	assert.equal(a.session.headSeq, 1);
	append(b, BX, "x2", bytes(2));
	append(b, NS, "n3", bytes(3));
	await r.settled();
	const seen: RelayEvent[] = [];
	a.session.onEvent((e) => seen.push(e));
	assert.deepEqual(trace(seen), ["provisional b:x x2", "committed b:x x2 2", "committed ns n3 3"]);
	append(b, NS, "n4", bytes(4));
	await r.settled();
	assert.deepEqual(trace(seen).at(-1), "committed ns n4 4");
});

test("a reconnect by the same device does not supersede (wire §5.3); supersede() closes 4403 authority_superseded", async () => {
	const r = relay();
	const a1 = await connect(r, A);
	const a2 = await connect(r, A);
	const b = await connect(r, B);
	append(b, NS, "bn", bytes(1));
	append(a2, NS, "an", bytes(2));
	await r.settled();
	assert.deepEqual(trace(a1.events), ["committed ns bn 1", "committed ns an 2"], "other sockets of the same device get its frames");
	assert.deepEqual(trace(a2.events), ["committed ns bn 1", "receipt ns an 2", "head 2"]);
	r.pauseCommits();
	append(a1, NS, "pending", bytes(3));
	r.resumeCommits();
	r.supersede(A);
	await r.settled();
	assert.equal(r.head(), 3, "the buffer is committed before the authority fence");
	assert.deepEqual(trace(a1.events).slice(-3), ["receipt ns pending 3", "head 3", "closed 4403 authority_superseded clean"]);
	assert.deepEqual(trace(a2.events).slice(-2), ["committed ns pending 3", "closed 4403 authority_superseded clean"]);
	assert.deepEqual(r.sessions().map((x) => x.deviceId), [B]);
});

test("failNextCommit: durability refuses the whole commit and drops provisionals; daily-limit latches", async () => {
	const r = relay();
	const a = await connect(r, A);
	const b = await connect(r, B);
	r.failNextCommit("durability");
	append(a, NS, "n1", bytes(1));
	append(a, BX, "x1", bytes(2));
	await r.settled();
	assert.equal(r.head(), 0);
	assert.deepEqual(trace(a.events), ["refused ns n1 durability", "refused b:x x1 durability"]);
	assert.deepEqual(trace(b.events), ["provisional b:x x1", "dropped b:x x1"]);

	a.events.length = 0;
	b.events.length = 0;
	r.failNextCommit("daily-limit", 1_234);
	append(a, BX, "x1", bytes(2));
	await r.settled();
	append(a, BX, "x2", bytes(3));
	await r.settled();
	assert.deepEqual(trace(a.events), ["refused b:x x1 daily-limit +1234", "refused b:x x2 daily-limit +1234"]);
	assert.deepEqual(trace(b.events), ["provisional b:x x1", "dropped b:x x1"], "no provisional while latched");
	r.setDailyLimit(false);
	append(a, BX, "x2", bytes(3));
	await r.settled();
	assert.equal(r.head(), 1);
});

test("dropSession, backpressure and client close", async () => {
	const r = relay();
	const a = await connect(r, A);
	const b = await connect(r, B);
	const c = await connect(r, C);
	r.pauseCommits();
	append(a, NS, "n1", bytes(1));
	r.dropSession(A);
	r.backpressure(B);
	await r.settled();
	assert.deepEqual(trace(a.events), ["closed 1006 - unclean"]);
	assert.deepEqual(trace(b.events), ["backpressure", "closed 1013 - clean"]);
	await r.flush();
	assert.deepEqual(trace(c.events), ["committed ns n1 1"], "frames buffered before a drop still commit");
	// Client close: "closed" is emitted synchronously (like wsRelay); later appends are ignored.
	c.session.close(1000, "bye");
	assert.deepEqual(trace(c.events).at(-1), "closed 1000 - clean");
	append(c, NS, "ignored", bytes(1));
	await r.settled();
	assert.equal(r.head(), 1);
	assert.equal(r.sessions().length, 0);
});

test("connect failures and a held provisional the session forgot (payload null)", async () => {
	const r = relay();
	r.setConnectFailure("unavailable", 2_000);
	assert.deepEqual(await r.connect({ vaultId: VAULT, deviceId: A }), { ok: false, reason: "unavailable", retryAfterMs: 2_000 });
	r.setConnectFailure(null);
	const a = await connect(r, A);
	const b = await connect(r, B);
	r.pauseCommits();
	append(a, BX, "x1", bytes(5));
	await r.settled();
	r.forgetHeldProvisionals(B);
	await r.flush();
	assert.deepEqual(trace(b.events), ["provisional b:x x1", "committed b:x x1 1 null"]);
});

test("resetEpoch wipes the vault and closes sessions 1001; new sessions see the new epoch", async () => {
	const r = relay({ vaultEpoch: "e1" });
	const a = await connect(r, A);
	append(a, NS, "n1", bytes(1));
	await r.settled();
	r.resetEpoch("e2");
	await r.settled();
	assert.deepEqual(trace(a.events).at(-1), "closed 1001 - clean");
	const a2 = await connect(r, A);
	assert.deepEqual([a2.session.vaultEpoch, a2.session.headSeq, r.head(), r.streams().length], ["e2", 0, 0, 0]);
});
