import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import type { StreamName } from "../../core/types";
import type { PutCheckpointResult, RelaySession } from "../../ports/relay";
import { CheckpointState, writeBodyCheckpoint } from "../body/checkpoints";
import { compactBody } from "../body/compaction";
import { SimRelay } from "../sync/__standins__/simRelay";
import type { LogEngine } from "./engine";
import { converged, startTestEngine, until } from "./testHarness";

const NO_CKPT = { rows: 1e9, bytes: 1e12, idleMs: 1e9, fallbackMs: 1e9, nsRows: 1e9, nsBytes: 1e12 };
const NO_COMPACT = { compactRows: 1e9, compactBytes: 1e12, checkpoint: NO_CKPT };

async function setup(n = 2, readOnly: string[] = []) {
	const relay = new SimRelay({ readOnlyDevices: readOnly as never });
	const es: LogEngine[] = [];
	for (const d of ["a", "b", "c"].slice(0, n)) es.push((await startTestEngine({ relay, deviceId: `dev-${d}`, tuning: NO_COMPACT })).engine);
	await until(() => es.every((e) => e.status().phase === "live"), 3_000, "live");
	return { relay, es };
}

function textOf(state: Uint8Array): { text: string; sv: Uint8Array } {
	const d = new Y.Doc();
	Y.applyUpdate(d, state);
	const out = { text: d.getText("text").toString(), sv: Y.encodeStateVector(d) };
	d.destroy();
	return out;
}

/** Session whose putCheckpoint returns a forced result (other methods pass through). */
function forced(s: RelaySession, res: PutCheckpointResult): RelaySession {
	return new Proxy(s, {
		get(t, p) {
			if (p === "putCheckpoint") return async () => res;
			const v = Reflect.get(t, p) as unknown;
			return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
		},
	});
}

test("compaction exactness: snapshot = fold of (old snapshot + every tail row <= C); rows deleted; replica untouched", async () => {
	const { es: [a, b] } = await setup();
	try {
		const id = await a!.createDoc("c.md", "seed;");
		await converged([a!, b!]);
		for (let i = 0; i < 5; i++) {
			await a!.editDoc(id, (t) => t.insert(t.length, `a${i};`));
			await b!.editDoc(id, (t) => t.insert(0, `b${i};`));
		}
		await converged([a!, b!]);
		const stream = a!.streamOf(id) as StreamName;
		for (const e of [a!, b!]) {
			const rec = e.c.repo.stream(stream)!;
			const { snapshot, tail } = await e.c.repo.loadStream(stream);
			const C = rec.appliedSeq;
			const expect = new Y.Doc();
			if (snapshot) Y.applyUpdate(expect, snapshot.bytes);
			for (const r of tail) if (r.seq <= C) Y.applyUpdate(expect, r.content);
			const res = await compactBody(e.c.deps, stream);
			assert.equal(res.t, "ok");
			const snap = (await e.c.repo.getSnapshot(stream))!;
			assert.equal(snap.coversSeq, C);
			const got = textOf(snap.bytes);
			assert.equal(got.text, expect.getText("text").toString());
			assert.deepEqual(got.sv, Y.encodeStateVector(expect));
			assert.equal(got.text, await e.docText(id), "replica text equals snapshot");
			assert.equal((await e.c.repo.getTail(stream, 0, C)).length, 0, "tail <= C deleted");
			const after = e.c.repo.stream(stream)!;
			assert.equal(after.snapshotCoversSeq, C);
			assert.equal(after.tailRows, 0);
			assert.deepEqual(await compactBody(e.c.deps, stream), { t: "skip", reason: "nothing" });
			expect.destroy();
		}
		// Second round folds on top of the first snapshot.
		await a!.editDoc(id, (t) => t.insert(0, "Z;"));
		await converged([a!, b!]);
		assert.equal((await compactBody(b!.c.deps, stream)).t, "ok");
		assert.equal(textOf((await b!.c.repo.getSnapshot(stream))!.bytes).text, await a!.docText(id));
	} finally {
		await a!.stop();
		await b!.stop();
	}
});

test("compaction is blocked while the stream has unreceipted outbox frames", async () => {
	const { relay, es: [a] } = await setup(1);
	try {
		const id = await a!.createDoc("blk.md", "x");
		await until(() => a!.isIdle(), 3_000, "idle");
		relay.pauseCommits();
		await a!.editDoc(id, (t) => t.insert(1, "y"));
		await until(() => a!.c.outbox.size > 0, 2_000, "outbox");
		assert.deepEqual(await compactBody(a!.c.deps, a!.streamOf(id)), { t: "skip", reason: "outbox" });
		relay.resumeCommits();
		await until(() => a!.isIdle(), 3_000, "idle");
		assert.equal((await compactBody(a!.c.deps, a!.streamOf(id))).t, "ok");
	} finally {
		await a!.stop();
	}
});

test("checkpoint CAS: ok / not-advancing-local / conflict -> refresh -> ok / daily-limit hold / forbidden", async () => {
	const { relay, es: [a, b, c] } = await setup(3, ["dev-c"]);
	try {
		const id = await a!.createDoc("cas.md", "v0;");
		for (let i = 1; i < 4; i++) await a!.editDoc(id, (t) => t.insert(t.length, `v${i};`));
		await converged([a!, b!, c!]);
		const stream = a!.streamOf(id);
		const sa = new CheckpointState();
		const r1 = await writeBodyCheckpoint(a!.c.deps, sa, a!.c.session!, stream);
		const C1 = a!.c.repo.stream(stream)!.appliedSeq;
		assert.deepEqual(r1, { t: "ok", coversSeq: C1 });
		assert.equal(relay.checkpoint(stream)!.coversSeq, C1);
		assert.equal(a!.c.repo.stream(stream)!.remoteCheckpointCoversSeq, C1);
		assert.equal(a!.c.repo.stream(stream)!.rowsSinceRemoteCheckpoint, 0);
		assert.deepEqual(await writeBodyCheckpoint(a!.c.deps, sa, a!.c.session!, stream), { t: "skipped", reason: "not-advancing-local" });

		await b!.editDoc(id, (t) => t.insert(0, "B;"));
		await converged([a!, b!, c!]);
		const sb = new CheckpointState();
		const pre = b!.c.repo.stream(stream)!.remoteCheckpointCoversSeq;
		const r2 = await writeBodyCheckpoint(b!.c.deps, sb, b!.c.session!, stream);
		assert.ok(pre < C1, "b has not seen a's checkpoint");
		assert.deepEqual(r2, { t: "conflict", current: C1, retry: true });
		assert.equal(b!.c.repo.stream(stream)!.remoteCheckpointCoversSeq, C1);
		const C2 = b!.c.repo.stream(stream)!.appliedSeq;
		assert.deepEqual(await writeBodyCheckpoint(b!.c.deps, sb, b!.c.session!, stream), { t: "ok", coversSeq: C2 });
		assert.equal(relay.checkpoint(stream)!.coversSeq, C2);
		const st = textOf((await b!.c.repo.getSnapshot(stream))!.bytes);
		assert.equal(st.text, "B;v0;v1;v2;v3;");

		await a!.editDoc(id, (t) => t.insert(t.length, "more;"));
		await converged([a!, b!, c!]);
		relay.setDailyLimit(true, 5_000);
		const r3 = await writeBodyCheckpoint(a!.c.deps, sa, a!.c.session!, stream);
		assert.deepEqual(r3, { t: "refused", reason: "daily-limit" });
		assert.ok(sa.holdUntilMono > a!.c.mono() + 4_000, "daily-limit hold armed");
		relay.setDailyLimit(false);

		assert.equal(c!.c.session!.canWrite, false);
		const r4 = await writeBodyCheckpoint(c!.c.deps, new CheckpointState(), c!.c.session!, stream);
		assert.deepEqual(r4, { t: "refused", reason: "forbidden" });
		assert.equal(c!.c.readOnly, true);
		assert.ok(c!.status().notices.some((n) => n.code === "read-only"), "read-only notice");
		assert.equal(relay.checkpoint(stream)!.coversSeq, C2, "forbidden write did not land");
	} finally {
		for (const e of [a!, b!, c!]) await e.stop();
	}
});

test("checkpoint outcome table: not-advancing refresh, too-large hold, ahead-of-stream / stream-not-found backoff", async () => {
	const { relay, es: [a] } = await setup(1);
	try {
		const id = await a!.createDoc("tbl.md", "1;");
		for (let i = 2; i < 5; i++) await a!.editDoc(id, (t) => t.insert(t.length, `${i};`));
		await until(() => a!.isIdle(), 3_000, "idle");
		const stream = a!.streamOf(id);
		const s = a!.c.session!;
		const st = new CheckpointState();
		const C = a!.c.repo.stream(stream)!.appliedSeq;
		// Another device's checkpoint at C landed unseen: relay says not-advancing; the read refreshes it.
		assert.equal((await writeBodyCheckpoint(a!.c.deps, new CheckpointState(), s, stream)).t, "ok");
		await a!.c.repo.tPatchStreams([{ stream, patch: (r) => { r.remoteCheckpointCoversSeq = 0; r.rowsSinceRemoteCheckpoint = 7; } }], a!.c.now());
		const na = await writeBodyCheckpoint(a!.c.deps, st, forced(s, { t: "refused", reason: "not-advancing", retryAfterMs: null }), stream);
		assert.deepEqual(na, { t: "not-advancing", refreshed: C });
		assert.equal(a!.c.repo.stream(stream)!.remoteCheckpointCoversSeq, C);
		assert.equal(a!.c.repo.stream(stream)!.rowsSinceRemoteCheckpoint, 0);

		await a!.editDoc(id, (t) => t.insert(0, "x;"));
		await until(() => a!.isIdle(), 3_000, "idle");
		const tl = await writeBodyCheckpoint(a!.c.deps, st, forced(s, { t: "refused", reason: "too-large", retryAfterMs: null }), stream);
		assert.deepEqual(tl, { t: "refused", reason: "too-large" });
		assert.ok(st.tooLarge.has(stream));
		assert.deepEqual(await writeBodyCheckpoint(a!.c.deps, st, s, stream), { t: "skipped", reason: "too-large" }, "held until the snapshot shrinks");
		st.tooLarge.clear();

		for (const reason of ["ahead-of-stream", "stream-not-found"] as const) {
			st.backoffUntil.clear();
			const r = await writeBodyCheckpoint(a!.c.deps, st, forced(s, { t: "refused", reason, retryAfterMs: null }), stream);
			assert.deepEqual(r, { t: "refused", reason });
			assert.ok((st.backoffUntil.get(stream) ?? 0) > a!.c.mono(), `${reason} backoff`);
		}
		assert.deepEqual(st.results, { "not-advancing": 1, "too-large": 1, "ahead-of-stream": 1, "stream-not-found": 1 });
		assert.equal((await writeBodyCheckpoint(a!.c.deps, st, s, stream)).t, "ok");
		assert.equal(relay.checkpoint(stream)!.coversSeq, a!.c.repo.stream(stream)!.appliedSeq);
	} finally {
		await a!.stop();
	}
});
