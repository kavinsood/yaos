import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceId, StreamName } from "../core/types";
import type { RelayEvent } from "../ports/relay";
import { VirtualClock } from "./clock";
import { SimRelay, type SimCommitInfo, type SimRelaySession } from "./relay";
import { attach, connectPeer, connectRaw, frame, trace } from "./a-relay-testkit";
import { SeededRandom } from "./random";

const ns = "ns" as StreamName;

test("relay: contiguous vault seqs in arrival order; broadcasts before receipts; never echoed; other sockets of the device get it", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const a = await connectPeer(relay, clock, "A");
	const a2 = await connectPeer(relay, clock, "A");
	const b = await connectPeer(relay, clock, "B");
	a.session.append(frame("ns", "a1", "x"));
	await clock.advance(1);
	b.session.append(frame("cfg", "b1", "y"));
	await clock.advance(1);
	a.session.append(frame("ns", "a2", "z"));
	await clock.runUntilIdle();
	assert.deepEqual(relay.rows(ns).map((r) => [r.seq, r.clientFrameId]), [[1, "a1"], [3, "a2"]]);
	assert.deepEqual(relay.rows("cfg" as StreamName).map((r) => r.seq), [2]);
	assert.equal(relay.head(), 3);
	assert.deepEqual(trace(a.events), ["committed b1@2", "receipt a1@1", "receipt a2@3", "head 3"]);
	assert.deepEqual(trace(a2.events), ["committed a1@1", "committed b1@2", "committed a2@3"]);
	assert.deepEqual(trace(b.events), ["committed a1@1", "committed a2@3", "receipt b1@2", "head 3"]);
	const committed = b.of("committed")[0]!.frame;
	assert.deepEqual([committed.deviceId, committed.stream, Array.from(committed.payload!)], ["A", "ns", [120]]);
	assert.equal(relay.counters().commits, 1);
});

test("relay: group commit — 300 ms idle, 1500 ms max, 64 KiB pending payload bytes", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const commits: { at: number; info: SimCommitInfo }[] = [];
	relay.onCommit((info) => commits.push({ at: clock.monotonic(), info }));
	const a = await connectPeer(relay, clock, "A");
	const t0 = clock.monotonic();
	a.session.append(frame("ns", "i1", "x"));
	await clock.runUntilIdle();
	assert.deepEqual(commits.map((c) => [c.at - t0, c.info.reason, c.info.rows.length]), [[300, "idle", 1]]);

	commits.length = 0;
	const t1 = clock.monotonic();
	for (let i = 0; i < 10; i++) {
		a.session.append(frame("ns", `m${i}`, "x"));
		await clock.advance(200); // never idle for 300 ms
	}
	await clock.runUntilIdle();
	assert.deepEqual(commits.map((c) => [c.at - t1, c.info.reason, c.info.rows.length]), [[1500, "max", 8], [2100, "idle", 2]]);
	assert.equal(commits.reduce((n, c) => n + c.info.rows.length, 0), 10);

	commits.length = 0;
	const t2 = clock.monotonic();
	a.session.append(frame("b:big", "k1", 40 * 1024));
	a.session.append(frame("b:big", "k2", 24 * 1024)); // 64 KiB pending: commit on arrival
	await clock.runUntilIdle();
	assert.deepEqual(commits.map((c) => [c.at - t2, c.info.reason, c.info.rows.length]), [[0, "bytes", 2]]);
	const seqs = relay.rows("b:big" as StreamName).map((r) => r.seq);
	assert.deepEqual(seqs, [seqs[0]!, seqs[0]! + 1]);
});

test("relay: b:/c: provisional to sockets open at admission; notice joins the held payload; later sockets get the row; forgotten -> null", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const a = await connectPeer(relay, clock, "A");
	const b = await connectPeer(relay, clock, "B");
	const d = await connectPeer(relay, clock, "D");
	a.session.append(frame("b:doc", "p1", "hello"));
	a.session.append(frame("ns", "n1", "ns-op")); // commit-only stream: no provisional
	await clock.advance(100);
	assert.deepEqual(trace(b.events), ["provisional p1"]);
	const c = await connectPeer(relay, clock, "C"); // after admission: no provisional, gets the row
	relay.forgetHeldProvisionals("D" as DeviceId);
	await clock.runUntilIdle();
	assert.deepEqual(trace(b.events), ["provisional p1", "committed p1@1", "committed n1@2"]);
	assert.equal(new TextDecoder().decode(b.of("committed")[0]!.frame.payload!), "hello");
	assert.deepEqual(trace(c.events), ["committed p1@1", "committed n1@2"]);
	assert.deepEqual(trace(d.events), ["provisional p1", "committed p1@1 null", "committed n1@2"]);
	assert.deepEqual(trace(a.events), ["receipt p1@1", "receipt n1@2", "head 2"]);
	assert.equal(relay.counters().notices, 2);
	assert.equal(relay.counters().committedBroadcasts, 4);
});

test("relay: events before the first listener are buffered; close() emits one closed synchronously; the relay sees the close after in-flight appends", async () => {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock, link: { uplinkMs: 50, downlinkMs: 50 } });
	const a = await connectPeer(relay, clock, "A");
	const raw = await connectRaw(relay, clock, "B");
	assert.ok(raw.ok);
	assert.equal(raw.session.headSeq, 0);
	a.session.append(frame("ns", "x1", "1"));
	await clock.runUntilIdle();
	const b = attach(raw.session as SimRelaySession); // listener attached late: nothing lost
	assert.deepEqual(trace(b.events), ["committed x1@1"]);

	b.session.append(frame("ns", "y1", "2"));
	assert.ok(b.session.bufferedBytes() > 0);
	b.session.close(1000, "bye");
	assert.deepEqual(trace(b.events).slice(1), ["closed 1000"]);
	b.session.close(1000, "again");
	b.session.append(frame("ns", "y2", "3")); // ignored after close
	await clock.runUntilIdle();
	assert.deepEqual(relay.rows(ns).map((r) => r.clientFrameId), ["x1", "y1"]); // in-flight append still committed
	assert.deepEqual(trace(b.events).slice(1), ["closed 1000"]);
	assert.deepEqual(relay.sessions().map((s) => s.deviceId), ["A"]);
	assert.equal(b.session.bufferedBytes(), 0);
	assert.ok(relay.quiescent());
});

test("relay: R2 under random link delays and jitter — each session gets every seq > headSeq once; receipts after all lower seqs", async () => {
	const tally = { storeDedupes: 0, pendingDedupes: 0, notices: 0 };
	for (const seed of [1, 2, 3, 4, 5]) {
		const clock = new VirtualClock();
		const rnd = new SeededRandom(seed);
		const relay = new SimRelay({ clock, seed, link: { uplinkMs: 5, downlinkMs: 20, jitterMs: 40, connectMs: 30 } });
		const peers = [await connectPeer(relay, clock, "A"), await connectPeer(relay, clock, "B")];
		const sent: { peer: number; f: ReturnType<typeof frame> }[] = [];
		for (let step = 0; step < 300; step++) {
			const roll = rnd.float();
			if (roll < 0.02 && peers.length < 5) peers.push(await connectPeer(relay, clock, rnd.pick(["A", "B", "C"])));
			const p = rnd.int(peers.length);
			if (roll > 0.85 && sent.length > 0) {
				const old = sent[rnd.int(sent.length)]!; // resend (same bytes) from the same device
				if (peers[p]!.deviceId === peers[old.peer]!.deviceId) peers[p]!.session.append(old.f);
			} else {
				const f = frame(rnd.pick(["ns", "cfg", "b:x", "b:y", "c:z"]), `f${seed}-${step}`, rnd.token(rnd.int(20) + 1));
				sent.push({ peer: p, f });
				peers[p]!.session.append(f);
			}
			await clock.advance(rnd.int(200));
		}
		await clock.runUntilIdle();
		const byseq = new Map(relay.streams().flatMap((s) => relay.rows(s).map((r) => [r.seq, r] as const)));
		assert.equal(byseq.size, relay.head(), "R1: contiguous");
		for (const peer of peers) {
			const seen = new Set<number>();
			for (const e of peer.events as RelayEvent[]) {
				if (e.t !== "committed" && e.t !== "receipt") continue;
				const seq = e.t === "committed" ? e.frame.seq : e.seq;
				const row = byseq.get(seq)!;
				assert.equal(e.t === "committed" ? e.frame.clientFrameId : e.clientFrameId, row.clientFrameId, `seed ${seed}`);
				if (seen.has(seq) || seq <= peer.session.headSeq) {
					assert.ok(e.t === "committed" || e.deduped, "a repeat is a dedupe settle (R7)");
					continue;
				}
				if (e.t === "receipt") for (let s = peer.session.headSeq + 1; s < seq; s++) assert.ok(seen.has(s), `seed ${seed}: receipt ${seq} before ${s}`);
				seen.add(seq);
			}
			assert.equal(seen.size, relay.head() - peer.session.headSeq, `seed ${seed}: every seq once`);
		}
		const c = relay.counters();
		tally.storeDedupes += c.storeDedupes;
		tally.pendingDedupes += c.pendingDedupes;
		tally.notices += c.notices;
	}
	assert.ok(tally.storeDedupes > 0 && tally.pendingDedupes > 0 && tally.notices > 0, JSON.stringify(tally));
});
