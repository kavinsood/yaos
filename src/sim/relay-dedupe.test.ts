import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientFrameId, DeviceId, StreamName } from "../core/types";
import { VirtualClock } from "./clock";
import { SimRelay } from "./relay";
import { RelayStore } from "./a-relay-store";
import { bytes, connectPeer, frame, trace } from "./a-relay-testkit";

const ns = "ns" as StreamName;

test("relay dedupe: pending buffer is vault-wide by (device, frame id) — same stream+bytes joins, otherwise conflict without seq", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const a = await connectPeer(relay, clock, "A");
	const a2 = await connectPeer(relay, clock, "A");
	const b = await connectPeer(relay, clock, "B");
	a.session.append(frame("ns", "f1", "x"));
	await clock.advance(1);
	a2.session.append(frame("ns", "f1", "x")); // other socket, same device: joins the pending frame
	a.session.append(frame("ns", "f1", "y")); // different bytes
	a2.session.append(frame("cfg", "f1", "x")); // different stream
	b.session.append(frame("ns", "f1", "x")); // other device: a different key
	await clock.runUntilIdle();
	assert.deepEqual(relay.rows(ns).map((r) => [r.seq, r.deviceId]), [[1, "A"], [2, "B"]]);
	assert.deepEqual(trace(a.events), ["refused f1 frame-id-conflict", "committed f1@2", "receipt f1@1", "head 2"]);
	assert.deepEqual(trace(a2.events), ["refused f1 frame-id-conflict", "committed f1@1", "committed f1@2", "receipt f1@1 dedup", "head 2"]);
	assert.deepEqual(trace(b.events), ["committed f1@1", "receipt f1@2", "head 2"]);
	const c = relay.counters();
	assert.deepEqual([c.pendingDedupes, c.conflicts, c.commits], [1, 2, 1]);
});

test("relay dedupe: store hit — same bytes -> deduped receipt with the original seq, holders get a notice with the OLDER seq (R7), commit-only peers nothing; different bytes -> conflict@seq + dropped", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const a = await connectPeer(relay, clock, "A");
	const b = await connectPeer(relay, clock, "B");
	a.session.append(frame("b:d", "p1", "v1"));
	await clock.runUntilIdle();
	const c = await connectPeer(relay, clock, "C");
	assert.equal(c.session.headSeq, 1);
	a.session.append(frame("b:d", "p1", "v1")); // resend after the receipt was lost, say
	await clock.runUntilIdle();
	a.session.append(frame("ns", "n1", "op"));
	await clock.runUntilIdle();
	a.session.append(frame("ns", "n1", "op"));
	await clock.runUntilIdle();
	a.session.append(frame("b:d", "p1", "v2"));
	await clock.runUntilIdle();
	assert.deepEqual(trace(a.events), [
		"receipt p1@1", "head 1", "receipt p1@1 dedup", "head 1", "receipt n1@2", "head 2", "receipt n1@2 dedup", "head 2",
		"refused p1 frame-id-conflict@1",
	]);
	assert.deepEqual(trace(b.events), ["provisional p1", "committed p1@1", "provisional p1", "committed p1@1", "committed n1@2", "provisional p1", "dropped p1"]);
	assert.deepEqual(trace(c.events), ["provisional p1", "committed p1@1", "committed n1@2", "provisional p1", "dropped p1"]);
	assert.equal(new TextDecoder().decode(c.of("committed")[0]!.frame.payload!), "v1");
	assert.equal(relay.head(), 2);
	const k = relay.counters();
	assert.deepEqual([k.storeDedupes, k.committedRows, k.provisionalDrops], [2, 2, 2]);
});

test("relay dedupe: window = open segment + newest sealed while open has < tail rows; outside it a resend is appended again (R4)", async () => {
	const clock = new VirtualClock();
	// rows here are 27 bytes: segments seal after 4 one-row commits; tail rule after 2 open rows
	const relay = new SimRelay({ clock, sealBytes: 100, dedupeWindow: 2 });
	const a = await connectPeer(relay, clock, "A");
	const send = async (id: string): Promise<void> => {
		a.session.append(frame("ns", id, 20));
		await clock.runUntilIdle();
	};
	for (const id of ["f1", "f2", "f3", "f4"]) await send(id);
	assert.deepEqual(relay.store.segments(ns), { sealed: [{ firstSeq: 1, lastSeq: 4, rows: 4, bytes: 108 }], open: null });
	await send("f1"); // open empty -> newest sealed searched -> deduped
	assert.deepEqual(trace(a.events).slice(-2), ["receipt f1@1 dedup", "head 4"]);
	await send("f5");
	assert.ok(relay.store.inDedupeWindow(ns, "A" as DeviceId, "f2" as ClientFrameId));
	await send("f6");
	assert.ok(!relay.store.inDedupeWindow(ns, "A" as DeviceId, "f2" as ClientFrameId), "open holds 2 rows: sealed tail no longer searched");
	assert.ok(relay.store.inDedupeWindow(ns, "A" as DeviceId, "f6" as ClientFrameId));
	await send("f2");
	assert.deepEqual(trace(a.events).slice(-2), ["receipt f2@7", "head 7"]);
	assert.deepEqual(relay.rows(ns).map((r) => r.clientFrameId), ["f1", "f2", "f3", "f4", "f5", "f6", "f2"]);
	assert.deepEqual(relay.store.segments(ns), { sealed: [{ firstSeq: 1, lastSeq: 4, rows: 4, bytes: 108 }], open: { firstSeq: 5, lastSeq: 7, rows: 3, bytes: 81 } });
});

test("relay store: batch-level dedupe is vault-wide; pre-seal before maxSegmentBytes; seal after >= sealBytes", () => {
	const store = new RelayStore({ sealBytes: 1000, maxSegmentBytes: 60, tailRows: 64, gcOnCheckpoint: true });
	const f = (stream: string, id: string, payload: string) => ({ stream: stream as StreamName, deviceId: "A" as DeviceId, clientFrameId: id as ClientFrameId, payload: bytes(payload) });
	const r = store.commit([f("ns", "k", "x"), f("ns", "k", "x"), f("cfg", "k", "x"), f("ns", "k", "y"), f("ns", "j", "x".repeat(40)), f("ns", "i", "x".repeat(40))]);
	assert.deepEqual(r.outcomes, [
		{ kind: "appended", seq: 1 }, { kind: "deduped", seq: 1 }, { kind: "conflict", seq: 1 }, { kind: "conflict", seq: 1 },
		{ kind: "appended", seq: 2 }, { kind: "appended", seq: 3 },
	]);
	assert.equal(r.head, 3);
	// seq 1 + "A" 2 + "k" 2 + "x" 2 = 7, then 46-byte rows: 7+46 = 53 fits, +46 would pass 60 -> pre-seal
	assert.deepEqual(store.segments(ns), { sealed: [{ firstSeq: 1, lastSeq: 2, rows: 2, bytes: 53 }], open: { firstSeq: 3, lastSeq: 3, rows: 1, bytes: 46 } });
	assert.equal(store.lastSeq("cfg" as StreamName), 0);
});
