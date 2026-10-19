/**
 * DESIGN §d.6 / e2ee-design §9.3: a snap row that does not open for a reader-dependent reason (here `k` not judged
 * to its seq, §14.3) is stored unopened and halts the snap fold, like an ns / cfg row. The re-gate that runs once
 * keys change (regateUnopened) must cover it: it used to walk ns and cfg only, so the snapshot index stayed halted
 * for good (a restart halts on the same stored row again).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { snapLive } from "../../core/snap/fold";
import { snapshotId, type SnapRecord } from "../../core/snap/record";
import { KEYRING_STREAM, SNAP_STREAM, type ContentHash } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { LOCAL_FLAG_UNOPENED } from "../sync/foldRuntime";
import { regateUnopened } from "../runtime/quarantineRelease";
import { until } from "../runtime/testHarness";
import { live, rawAppend, start } from "./testkit/engines";
import { K, genesis } from "./testkit/world";

const T0 = Date.UTC(2026, 9, 7);
const H = (n: number) => n.toString(16).padStart(64, "0") as ContentHash;
const rec = (createdAtMs: number): SnapRecord => ({
	version: 1, snapshotId: snapshotId(createdAtMs, "daily"), createdAtMs, deviceLabel: "laptop", reason: "daily", format: 1,
	fileCount: 1, totalBytes: 10, bundleDigest: H(1), parts: [{ address: H(2), size: 120, sha256: H(2) }],
});

void describe("unopened snap rows (§d.6, §14.3)", () => {
	void it("halt the snap fold until keys change; the re-gate opens them and the fold advances", async () => {
		const relay = new SimRelay();
		const g = await genesis();
		await rawAppend(relay, KEYRING_STREAM, g);
		const pin = { keys: [{ e: 1, k: K(1) }], records: [g] };
		const x = await start(relay, "dev-x-0123456789abcdef", pin);
		const y = await start(relay, "dev-y-0123456789abcdef", pin);
		try {
			await live(x);
			await live(y);
			const yc = y.engine.c;
			const judged = yc.gateCtx.staleCheck;
			yc.gateCtx.staleCheck = () => "hold"; // y's `k` not judged to the row's seq: reader-dependent
			await x.engine.submitSnap([{ t: "put", record: rec(T0) }]);
			await until(() => yc.snap.halted !== null, 5_000, "snap fold halted");
			assert.equal(yc.snap.halted?.reason, "reader-dependent");
			const tail = await yc.repo.getTail(SNAP_STREAM, 0);
			assert.equal(tail.length, 1);
			assert.ok(tail[0]!.flags & LOCAL_FLAG_UNOPENED, "stored unopened");
			assert.equal(snapLive(y.engine.snapView().state).length, 0);

			yc.gateCtx.staleCheck = judged; // `k` judged: the row opens now
			assert.equal(await regateUnopened(yc), 1, "the snap row was re-gated");
			assert.equal(yc.snap.halted, null, "halt lifted");
			assert.deepEqual(snapLive(y.engine.snapView().state).map((s) => s.record.snapshotId), [rec(T0).snapshotId], "folded");
			assert.equal((await yc.repo.getTail(SNAP_STREAM, 0))[0]!.flags & LOCAL_FLAG_UNOPENED, 0, "replaced by the opened row");
		} finally {
			await y.engine.stop();
			await x.engine.stop();
		}
	});

	void it("a row the re-gate finds stale-epoch leaves the tail and stops holding the fold (sim heavy E2EE seed 42)", async () => {
		// A stale snap row is accounted only (never stored, §9.3). Stored unopened first (`k` not judged yet), its
		// re-gate came out "account", which the re-gate skipped: the row stayed unopened and the snap fold halted for
		// good, behind every later row (sim: A's index lacked B's manual snapshot that the oracle and B had).
		const relay = new SimRelay();
		const g = await genesis();
		await rawAppend(relay, KEYRING_STREAM, g);
		const pin = { keys: [{ e: 1, k: K(1) }], records: [g] };
		const x = await start(relay, "dev-x-0123456789abcdef", pin);
		const y = await start(relay, "dev-y-0123456789abcdef", pin);
		try {
			await live(x);
			await live(y);
			const yc = y.engine.c;
			const judged = yc.gateCtx.staleCheck;
			yc.gateCtx.staleCheck = () => "hold";
			await x.engine.submitSnap([{ t: "put", record: rec(T0) }]);
			await until(() => yc.snap.halted !== null, 5_000, "snap fold halted");
			const staleSeq = (await yc.repo.getTail(SNAP_STREAM, 0))[0]!.seq;

			yc.gateCtx.staleCheck = (e, seq) => (seq === staleSeq ? "stale" : judged(e, seq)); // `k` judged: stale
			assert.equal(await regateUnopened(yc), 1, "the stale row was re-gated");
			assert.equal(yc.snap.halted, null, "halt lifted");
			assert.deepEqual(await yc.repo.getTail(SNAP_STREAM, 0), [], "the accounted row left the tail");
			assert.equal(yc.repo.stream(SNAP_STREAM)?.tailRows, 0);

			await x.engine.submitSnap([{ t: "put", record: rec(T0 + 1_000) }]);
			await until(() => snapLive(y.engine.snapView().state).length === 1, 5_000, "a later row folds");
			assert.deepEqual(snapLive(y.engine.snapView().state).map((s) => s.record.snapshotId), [rec(T0 + 1_000).snapshotId]);
		} finally {
			await y.engine.stop();
			await x.engine.stop();
		}
	});
});
