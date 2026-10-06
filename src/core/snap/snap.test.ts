/**
 * snap index: codec bounds, fold semantics, snapFoldV1 round trip, and a seeded fuzz of order and
 * duplication independence (YAOS_FUZZ_SEEDS / YAOS_FUZZ_SEED as in core/ns/fuzz.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContentHash, DeviceId } from "../types";
import { CodecError, Writer, bytesEqual } from "../codec/lib0";
import { decodeSnapFoldV1, encodeSnapFoldV1 } from "../codec/snapFoldV1";
import {
	SNAP_MAX_PARTS, SNAP_MAX_PART_BYTES, SNAP_MAX_LABEL_BYTES, SNAP_MAX_OPS, SNAP_MAX_TOTAL_BYTES, SnapOpTag,
	decodeSnapOps, decodeSnapRecord, encodeSnapOps, encodeSnapRecord, parseRemoteSnapshotId, parseSnapshotId,
	remoteSnapshotId, snapRecordProblem, snapshotId, type SnapOp, type SnapReason, type SnapRecord,
} from "./record";
import {
	foldSnapFrame, newSnapFold, overlayPendingSnap, retentionFloor, snapFoldFingerprint, snapLive, type SnapFrame,
} from "./fold";

declare const process: { env: Record<string, string | undefined> };

const A = "deviceAAAAAAAAAAAAAAAA" as DeviceId;
const B = "deviceBBBBBBBBBBBBBBBB" as DeviceId;
const C = "deviceCCCCCCCCCCCCCCCC" as DeviceId;
const H = (n: number) => (n.toString(16).padStart(2, "0").repeat(32)) as ContentHash;
const T0 = Date.UTC(2026, 9, 1);
const DAY = 86_400_000;

function rec(createdAtMs: number, o: Partial<SnapRecord> = {}, reason: SnapReason = "daily"): SnapRecord {
	return {
		version: 1, snapshotId: snapshotId(createdAtMs, reason), createdAtMs, deviceLabel: "laptop", reason, format: 1,
		fileCount: 3, totalBytes: 100, bundleDigest: H(1), parts: [{ address: H(2), size: 120, sha256: H(3) }], ...o,
	};
}
const put = (r: SnapRecord): SnapOp => ({ t: "put", record: r });

test("snap ids: round trip, remote ids, rejects junk", () => {
	const id = snapshotId(T0, "manual");
	assert.deepEqual(parseSnapshotId(id), { createdAtMs: T0, reason: "manual" });
	assert.equal(parseSnapshotId("../x-manual"), null);
	assert.equal(parseSnapshotId(`${id}x`), null);
	assert.deepEqual(parseRemoteSnapshotId(remoteSnapshotId(A, id)), { deviceId: A, snapshotId: id });
	assert.equal(parseRemoteSnapshotId(`${id}@short`), null);
	assert.equal(parseRemoteSnapshotId(id), null);
});

test("snapOps codec: round trip, canonical", () => {
	const ops: SnapOp[] = [put(rec(T0)), { t: "floor", createdAtMs: T0 - DAY }, { t: "del", deviceId: B, snapshotId: snapshotId(T0, "manual") }];
	const bytes = encodeSnapOps(ops);
	const back = decodeSnapOps(bytes);
	assert.deepEqual(back, ops);
	assert.ok(bytesEqual(encodeSnapOps(back!), bytes));
	assert.deepEqual(decodeSnapRecord(encodeSnapRecord(rec(T0))), rec(T0));
});

test("snapOps codec: bounds and schema violations are malformed", () => {
	assert.ok(snapRecordProblem(rec(T0, { createdAtMs: T0 + 1 })));
	assert.ok(snapRecordProblem(rec(T0, { reason: "manual" })));
	assert.ok(snapRecordProblem(rec(T0, { parts: [] })));
	assert.ok(snapRecordProblem(rec(T0, { parts: Array.from({ length: SNAP_MAX_PARTS + 1 }, () => ({ address: H(2), size: 1, sha256: H(3) })) })));
	assert.ok(snapRecordProblem(rec(T0, { parts: [{ address: H(2), size: SNAP_MAX_PART_BYTES + 1, sha256: H(3) }] })));
	assert.ok(snapRecordProblem(rec(T0, { parts: [{ address: H(2), size: 0, sha256: H(3) }] })));
	assert.ok(snapRecordProblem(rec(T0, { parts: [{ address: "AB".repeat(32), size: 1, sha256: H(3) }] })));
	assert.ok(snapRecordProblem(rec(T0, { totalBytes: SNAP_MAX_TOTAL_BYTES + 1 })));
	assert.ok(snapRecordProblem(rec(T0, { deviceLabel: "x".repeat(SNAP_MAX_LABEL_BYTES + 1) })));
	assert.ok(snapRecordProblem(rec(T0, { deviceLabel: "\ud800" })));
	assert.equal(snapRecordProblem(rec(T0, { parts: Array.from({ length: SNAP_MAX_PARTS }, () => ({ address: H(2), size: 1, sha256: H(3) })) })), null);
	assert.throws(() => encodeSnapOps([put(rec(T0, { fileCount: -1 }))]), CodecError);
	assert.throws(() => encodeSnapOps(Array.from({ length: SNAP_MAX_OPS + 1 }, () => put(rec(T0)))), CodecError);
	assert.throws(() => encodeSnapOps([]), CodecError);

	const good = encodeSnapOps([put(rec(T0))]);
	for (let cut = 1; cut < good.length; cut++) assert.equal(decodeSnapOps(good.subarray(0, cut)), null, `truncated at ${cut}`);
	// A put whose embedded createdAt disagrees with its id (hand-encoded past the encoder's checks).
	const body = encodeSnapRecord(rec(T0));
	const lying = body.slice();
	lying[1 + 1 + rec(T0).snapshotId.length]! ^= 1; // first byte of createdAtMs, after u8 version + varstring id
	assert.equal(decodeSnapOps(new Writer().varuint(1).u8(SnapOpTag.put).varbytes(lying).finish()), null);
	// Unknown tag, oversized body, too many ops.
	assert.equal(decodeSnapOps(new Writer().varuint(1).u8(9).varbytes(new Uint8Array(1)).finish()), null);
	assert.equal(decodeSnapOps(new Writer().varuint(1).u8(SnapOpTag.put).varbytes(new Uint8Array(49 * 1024)).finish()), null);
	const many = new Writer().varuint(SNAP_MAX_OPS + 1);
	for (let i = 0; i < SNAP_MAX_OPS + 1; i++) many.u8(SnapOpTag.floor).varbytes(new Writer().varuint(1).finish());
	assert.equal(decodeSnapOps(many.finish()), null);
	// Unknown record version: kept as putUnknown (ignored by the fold, reported).
	const v9 = decodeSnapOps(new Writer().varuint(1).u8(SnapOpTag.put).varbytes(new Uint8Array([9, 1, 2, 3])).finish());
	assert.deepEqual(v9, [{ t: "putUnknown", version: 9 }]);
	const s = newSnapFold();
	const ev = foldSnapFrame(s, { seq: 1, deviceId: A, ops: v9! });
	assert.deepEqual(ev[0]!.outcome, { t: "ignored", reason: "unknown-version" });
	assert.equal(s.records.size, 0);
});

test("snap fold: live set, delete tombstones, retention floor", () => {
	const s = newSnapFold();
	const r1 = rec(T0), r2 = rec(T0 + DAY), r3 = rec(T0 + 2 * DAY);
	foldSnapFrame(s, { seq: 1, deviceId: A, ops: [put(r1)] });
	foldSnapFrame(s, { seq: 2, deviceId: A, ops: [put(r2)] });
	foldSnapFrame(s, { seq: 3, deviceId: B, ops: [put(r1)] });
	assert.deepEqual(snapLive(s).map((e) => [e.deviceId, e.record.snapshotId]), [[A, r2.snapshotId], [A, r1.snapshotId], [B, r1.snapshotId]]);
	// B deletes A's newest: tombstoned, a later re-put does not resurrect it.
	foldSnapFrame(s, { seq: 4, deviceId: B, ops: [{ t: "del", deviceId: A, snapshotId: r2.snapshotId }] });
	assert.deepEqual(foldSnapFrame(s, { seq: 5, deviceId: A, ops: [put(r2)] })[0]!.outcome, { t: "ignored", reason: "deleted" });
	// Retention: A keeps the newest 1 -> floor = r3.createdAt; older records and tombstones are dropped.
	assert.equal(retentionFloor([r1.createdAtMs, r3.createdAtMs], 1), r3.createdAtMs);
	assert.equal(retentionFloor([r1.createdAtMs], 1), null);
	foldSnapFrame(s, { seq: 6, deviceId: A, ops: [put(r3), { t: "floor", createdAtMs: r3.createdAtMs }] });
	assert.deepEqual(snapLive(s).map((e) => [e.deviceId, e.record.snapshotId]), [[A, r3.snapshotId], [B, r1.snapshotId]]);
	assert.equal(s.dels.size, 0);
	// A floor only affects its author; already-folded rows are skipped.
	assert.deepEqual(foldSnapFrame(s, { seq: 6, deviceId: B, ops: [{ t: "floor", createdAtMs: T0 + 9 * DAY }] }), []);
	assert.equal(snapLive(s).length, 2);
	// Pending overlay does not touch the committed state.
	const view = overlayPendingSnap(s, B, [{ ops: [{ t: "del", deviceId: B, snapshotId: r1.snapshotId }] }]);
	assert.equal(snapLive(view).length, 1);
	assert.equal(snapLive(s).length, 2);
	// Checkpoint round trip is canonical.
	const bytes = encodeSnapFoldV1(s);
	const back = decodeSnapFoldV1(bytes)!;
	assert.equal(snapFoldFingerprint(back), snapFoldFingerprint(s));
	assert.ok(bytesEqual(encodeSnapFoldV1(back), bytes));
	assert.equal(back.coversSeq, 6);
	assert.equal(decodeSnapFoldV1(bytes.subarray(0, bytes.length - 1)), null);
});

test("snap fold: conflicting puts for one key converge on the smaller body", () => {
	const a = rec(T0, { fileCount: 1 }), b = rec(T0, { fileCount: 2 });
	const s1 = newSnapFold(), s2 = newSnapFold();
	foldSnapFrame(s1, { seq: 1, deviceId: A, ops: [put(a)] }); foldSnapFrame(s1, { seq: 2, deviceId: A, ops: [put(b)] });
	foldSnapFrame(s2, { seq: 1, deviceId: A, ops: [put(b)] }); foldSnapFrame(s2, { seq: 2, deviceId: A, ops: [put(a)] });
	assert.equal(snapFoldFingerprint(s1), snapFoldFingerprint(s2));
	assert.equal(snapLive(s1)[0]!.record.fileCount, 1);
});

// ---------------------------------------------------------------------------
// Seeded fuzz: the folded state is a function of the multiset of (author, op), independent of order and duplicates.
// ---------------------------------------------------------------------------

function rngFor(seed: number) {
	let x = (seed ^ 0x9e3779b9) >>> 0 || 1;
	const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
	const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
	return { next, int, pick };
}

function randomFrames(seed: number): { deviceId: DeviceId; ops: SnapOp[] }[] {
	const r = rngFor(seed);
	const devs = [A, B, C];
	const times = Array.from({ length: 12 }, (_, i) => T0 + i * DAY);
	const frames: { deviceId: DeviceId; ops: SnapOp[] }[] = [];
	for (let i = r.int(5, 40); i > 0; i--) {
		const ops: SnapOp[] = [];
		for (let k = r.int(1, 3); k > 0; k--) {
			const t = r.pick(times);
			const roll = r.next();
			if (roll < 0.55) ops.push(put(rec(t, { fileCount: r.int(1, 3), deviceLabel: r.pick(["a", "b"]) }, r.pick(["daily", "manual"] as const))));
			else if (roll < 0.75) ops.push({ t: "del", deviceId: r.pick(devs), snapshotId: snapshotId(t, r.pick(["daily", "manual"] as const)) });
			else if (roll < 0.9) ops.push({ t: "floor", createdAtMs: t });
			else ops.push({ t: "putUnknown", version: r.int(2, 9) });
		}
		frames.push({ deviceId: r.pick(devs), ops });
	}
	return frames;
}

function foldAll(frames: readonly { deviceId: DeviceId; ops: readonly SnapOp[] }[]): string {
	const s = newSnapFold();
	frames.forEach((f, i) => foldSnapFrame(s, { seq: i + 1, deviceId: f.deviceId, ops: f.ops } satisfies SnapFrame));
	const fp = snapFoldFingerprint(s);
	const back = decodeSnapFoldV1(encodeSnapFoldV1(s));
	assert.ok(back, "checkpoint decodes");
	assert.equal(snapFoldFingerprint(back), fp, "checkpoint round trip");
	return fp;
}

test("snap fold fuzz: order and duplication independent", () => {
	const one = process.env.YAOS_FUZZ_SEED;
	const seeds = one ? [Number(one)] : Array.from({ length: Number(process.env.YAOS_FUZZ_SEEDS ?? 200) }, (_, i) => i + 1);
	for (const seed of seeds) {
		const frames = randomFrames(seed);
		// Ops split across frames differently must not matter either: flatten to single-op frames.
		const flat = frames.flatMap((f) => f.ops.map((op) => ({ deviceId: f.deviceId, ops: [op] })));
		const want = foldAll(frames);
		const r = rngFor(seed * 7919);
		for (let trial = 0; trial < 6; trial++) {
			const shuffled = [...flat];
			for (let i = shuffled.length - 1; i > 0; i--) { const j = r.int(0, i); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
			const dup = shuffled.flatMap((f) => (r.next() < 0.3 ? [f, f] : [f]));
			assert.equal(foldAll(dup), want, `seed ${seed} trial ${trial}`);
		}
	}
});
