import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamName } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import type { LogEngine } from "./engine";
import { converged, sleep, startTestEngine, until } from "./testHarness";

const CKPT = { rows: 3, bytes: 1e9, idleMs: 10, settleMs: 1e9, fallbackMs: 50, nsRows: 3, nsBytes: 1e9 };
const NO_CKPT = { rows: 1e9, bytes: 1e12, idleMs: 1e9, settleMs: 1e9, fallbackMs: 1e9, nsRows: 1e9, nsBytes: 1e12 };

async function live(...es: LogEngine[]): Promise<void> {
	await until(() => es.every((e) => e.status().phase === "live"), 3_000, "live");
}
async function stopAll(...es: LogEngine[]): Promise<void> {
	for (const e of es) await e.stop();
}

test("disconnect/reconnect: offline edits on both sides (body + ns) converge", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		await live(a, b);
		const id = await a.createDoc("shared.md", "0123456789");
		await converged([a, b]);
		a.disconnect();
		await until(() => a.status().phase !== "live", 2_000, "a offline");
		await a.editDoc(id, (t) => t.insert(0, "[a]"));
		const offA = await a.createDoc("offline-a.md", "made offline");
		await b.editDoc(id, (t) => t.insert(t.length, "[b]"));
		const onB = await b.createDoc("online-b.md", "made by b");
		await b.renameDoc(id, "shared-renamed.md");
		await sleep(100);
		assert.equal(relay.rows(a.streamOf(offA)).length, 0, "nothing from a while offline");
		await a.reconnect();
		await converged([a, b]);
		assert.equal(await a.docText(id), "[a]0123456789[b]");
		assert.equal(await b.docText(offA), "made offline");
		assert.equal(await a.docText(onB), "made by b");
		assert.equal(a.listDocs().find((d) => d.docId === id)?.path, "shared-renamed.md");
		assert.equal(a.c.outbox.size + b.c.outbox.size, 0);
	} finally {
		await stopAll(a, b);
	}
});

test("socket drop: auto-reconnect, unreceipted frames resent, live again", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		await live(a, b);
		const id = await a.createDoc("drop.md", "x");
		await converged([a, b]);
		const before = a.c.sess.stats.sessions;
		relay.pauseCommits();
		await a.editDoc(id, (t) => t.insert(1, "y"));
		await until(() => a.c.sender.inflightCount > 0, 2_000, "inflight");
		relay.dropSession("dev-a" as never);
		await b.editDoc(id, (t) => t.insert(0, "w"));
		relay.resumeCommits();
		await until(() => a.c.sess.stats.sessions > before, 3_000, "reconnected");
		await converged([a, b]);
		assert.equal(await b.docText(id), "wxy");
		assert.equal(relay.rows(a.streamOf(id)).filter((r) => r.deviceId === "dev-a").length, 2, "create + one edit, no duplicate");
	} finally {
		await stopAll(a, b);
	}
});

test("checkpoint duty: maintenance writes a body checkpoint, relay GCs, fresh engine adopts it", async () => {
	const relay = new SimRelay({ sealBytes: 64 }); // small segments so a checkpoint can GC sealed ones
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", tuning: { checkpoint: CKPT } });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", tuning: { checkpoint: CKPT } });
	let c: LogEngine | null = null;
	try {
		await live(a, b);
		const id = await a.createDoc("ck.md", "");
		for (let i = 0; i < 8; i++) await a.editDoc(id, (t) => t.insert(t.length, `r${i};`));
		await converged([a, b]);
		const stream = a.streamOf(id);
		await until(() => (relay.checkpoint(stream)?.coversSeq ?? 0) > 0 && relay.gcSeq(stream) > 0, 4_000, "checkpoint + gc");
		await until(() => a.maint.stats.checkpoints + b.maint.stats.checkpoints >= 1, 2_000, "outcome applied");
		const cp = relay.checkpoint(stream)!;
		assert.ok(a.c.repo.stream(stream)!.remoteCheckpointCoversSeq >= cp.coversSeq || b.c.repo.stream(stream)!.remoteCheckpointCoversSeq >= cp.coversSeq);
		c = (await startTestEngine({ relay, deviceId: "dev-c", tuning: { checkpoint: NO_CKPT } })).engine;
		await converged([a, b, c]);
		assert.equal(await c.docText(id), "r0;r1;r2;r3;r4;r5;r6;r7;");
		const rc = c.c.repo.stream(stream)!;
		assert.ok(rc.snapshotCoversSeq >= cp.coversSeq, `c snapshot ${rc.snapshotCoversSeq} >= checkpoint ${cp.coversSeq}`);
		assert.ok(rc.remoteCheckpointCoversSeq >= cp.coversSeq);
		assert.equal(c.c.repo.cursor.vaultSeq, relay.head());
	} finally {
		await stopAll(a, b, ...(c ? [c] : []));
	}
});

test("union: engine with a local tail below a GC'd checkpoint catches up via checkpoint union", async () => {
	const relay = new SimRelay({ sealBytes: 64 }); // small segments so a checkpoint can GC sealed ones
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", tuning: { checkpoint: CKPT } });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", tuning: { checkpoint: NO_CKPT } });
	try {
		await live(a, b);
		const id = await a.createDoc("u.md", "start;");
		await converged([a, b]);
		const stream = a.streamOf(id);
		await b.editDoc(id, (t) => t.insert(t.length, "b1;"));
		await converged([a, b]);
		const bTail = b.c.repo.stream(stream)!;
		assert.ok(bTail.tailRows > 0, "b keeps a local tail");
		b.disconnect();
		for (let i = 0; i < 6; i++) await a.editDoc(id, (t) => t.insert(t.length, `a${i};`));
		await b.editDoc(id, (t) => t.insert(0, "OFF;"));
		await until(() => relay.gcSeq(stream) > bTail.appliedSeq, 4_000, "gc past b's applied seq");
		const cp = relay.checkpoint(stream)!;
		await b.reconnect();
		await converged([a, b]);
		assert.equal(await a.docText(id), "OFF;start;b1;a0;a1;a2;a3;a4;a5;");
		assert.equal(await b.docText(id), await a.docText(id));
		const rb = b.c.repo.stream(stream)!;
		assert.ok(rb.snapshotCoversSeq >= cp.coversSeq, "union snapshot covers the checkpoint");
		const tail = await b.c.repo.getTail(stream, 0, rb.snapshotCoversSeq);
		assert.equal(tail.length, 0, "tail rows <= C deleted by the union T_snapshot");
	} finally {
		await stopAll(a, b);
	}
});

test("catch-up: a body read that finds only own rows still reports the doc (the planner waits on caughtUp)", async () => {
	// Same deviceId on fresh storage (IndexedDB evicted): every row of the doc is "own", none is foreign and there is
	// no checkpoint. The read flips the stream to caught up; without onBodyChange nothing re-plans the doc's
	// body-not-caught-up wait before the periodic full reconcile (minutes), so a local edit to it is not uploaded.
	const relay = new SimRelay();
	const { engine: a1 } = await startTestEngine({ relay, deviceId: "dev-a", tuning: { checkpoint: NO_CKPT } });
	let a2: LogEngine | null = null;
	try {
		await live(a1);
		const id = await a1.createDoc("own.md", "mine");
		await a1.editDoc(id, (t) => t.insert(t.length, "!"));
		await converged([a1]);
		const stream = a1.streamOf(id);
		await a1.stop();
		const seen: string[] = [];
		a2 = (await startTestEngine({ relay, deviceId: "dev-a", tuning: { checkpoint: NO_CKPT }, extra: { onBodyChange: (ids) => seen.push(...ids) } })).engine;
		const e2 = a2;
		await live(e2);
		await until(() => {
			const r = e2.c.repo.stream(stream);
			return !!r && r.remoteHeadSeq > 0 && r.appliedSeq >= r.remoteHeadSeq;
		}, 3_000, "body caught up");
		assert.equal(await e2.docText(id), "mine!");
		await until(() => seen.includes(id), 1_000, "onBodyChange for the caught-up doc");
	} finally {
		await stopAll(a1, ...(a2 ? [a2] : []));
	}
});
