/**
 * The `snap` stream through the engine (DESIGN §j.4): own ops overlay at once, converge on other devices,
 * checkpoint + compaction like cfg, a fresh engine adopts the checkpoint, a restart reloads the fold.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { snapLive } from "../../core/snap/fold";
import { snapKey, snapshotId, type SnapRecord } from "../../core/snap/record";
import { SNAP_STREAM, type ContentHash, type DeviceId } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import type { LogEngine } from "./engine";
import { startTestEngine, until } from "./testHarness";

const A = "dev-a-0123456789abcdef";
const B = "dev-b-0123456789abcdef";
const T0 = Date.UTC(2026, 9, 7);
const H = (n: number) => n.toString(16).padStart(64, "0") as ContentHash;
const CKPT = { rows: 1e9, bytes: 1e12, idleMs: 10, settleMs: 1e9, fallbackMs: 50, nsRows: 3, nsBytes: 1e9 };
const NO_CKPT = { rows: 1e9, bytes: 1e12, idleMs: 1e9, settleMs: 1e9, fallbackMs: 1e9, nsRows: 1e9, nsBytes: 1e12 };

function rec(createdAtMs: number): SnapRecord {
	return {
		version: 1, snapshotId: snapshotId(createdAtMs, "daily"), createdAtMs, deviceLabel: "laptop", reason: "daily", format: 1,
		fileCount: 2, totalBytes: 10, bundleDigest: H(1), parts: [{ address: H(2), size: 120, sha256: H(2) }],
	};
}
const live = (e: LogEngine) => snapLive(e.snapView().state).map((x) => `${x.deviceId}/${x.record.snapshotId}`);

async function stopAll(...es: LogEngine[]): Promise<void> {
	for (const e of es) await e.stop();
}

test("snap: submitSnap overlays at once, converges on a second engine, floor and del apply everywhere", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: A });
	const { engine: b } = await startTestEngine({ relay, deviceId: B });
	try {
		relay.pauseCommits();
		await a.submitSnap([{ t: "put", record: rec(T0) }]);
		assert.deepEqual(live(a), [`${A}/${rec(T0).snapshotId}`], "own pending op overlaid");
		assert.equal(a.c.snap.state.records.size, 0, "committed fold untouched");
		a.snapView().state.records.clear();
		assert.equal(live(a).length, 1, "the view is a copy");
		relay.resumeCommits();
		await until(() => live(b).length === 1 && a.isIdle() && a.c.snap.state.records.size === 1, 3_000, "b converges");

		await a.submitSnap([{ t: "put", record: rec(T0 + 1000) }, { t: "put", record: rec(T0 + 2000) }, { t: "floor", createdAtMs: T0 + 1000 }]);
		await b.submitSnap([{ t: "del", deviceId: A as DeviceId, snapshotId: rec(T0 + 2000).snapshotId }]);
		const want = [`${A}/${rec(T0 + 1000).snapshotId}`];
		await until(() => JSON.stringify(live(a)) === JSON.stringify(want) && JSON.stringify(live(b)) === JSON.stringify(want) && a.isIdle() && b.isIdle(), 3_000, "floor + del");
		assert.ok(b.snapView().state.dels.has(snapKey(A as DeviceId, rec(T0 + 2000).snapshotId)));
		assert.equal(b.snapView().state.floors.get(A as DeviceId), T0 + 1000);
		assert.equal(a.snapView().caughtUp, true);
		assert.equal((await b.submitSnap([])).length, 0);
	} finally {
		await stopAll(a, b);
	}
});

test("snap: checkpoint + compaction; a fresh engine adopts the snap checkpoint; restart reloads the fold", async () => {
	const relay = new SimRelay({ sealBytes: 64 });
	const tuning = { checkpoint: CKPT, nsCandidateModulus: 2, compactRows: 2 };
	const { engine: a, storage } = await startTestEngine({ relay, deviceId: A, tuning });
	let c: LogEngine | null = null;
	let a2: LogEngine | null = null;
	try {
		for (let i = 0; i < 8; i++) await a.submitSnap([{ t: "put", record: rec(T0 + i * 1000) }]);
		await until(() => (relay.checkpoint(SNAP_STREAM)?.coversSeq ?? 0) > 0, 4_000, "snap checkpoint");
		await until(() => (a.c.repo.stream(SNAP_STREAM)?.snapshotCoversSeq ?? 0) > 0, 4_000, "snap compaction");
		await until(() => (a.maint.stats.checkpointOutcomes["snap-ok"] ?? 0) >= 1, 2_000, "snap-ok outcome counted");

		c = (await startTestEngine({ relay, deviceId: B, tuning: { checkpoint: NO_CKPT } })).engine;
		await until(() => live(c!).length === 8, 4_000, "c has every record");

		await a.stop();
		a2 = (await startTestEngine({ relay, deviceId: A, storage, tuning })).engine;
		assert.equal(live(a2).length, 8, "restart: snapshot + tail fold");
	} finally {
		await stopAll(...[a2 ?? a, c].filter((e): e is LogEngine => e !== null));
	}
});
