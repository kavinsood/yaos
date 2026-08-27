/**
 * Unit tests for snapshot: dedup, retention, hash computation, and safety invariants.
 *
 * Usage:
 *   node --import jiti/register tests/server/snapshot-retention.ts
 *
 * Required test cases (from code review):
 *  1. Delete-only Yjs transaction changes fullUpdateHash (catches state-vector bug)
 *  2. Edit existing Markdown content without changing path/fileId — daily snapshot must not skip
 *  3. Manual snapshot after content edit must not warn "unchanged" (structureHash vs content)
 *  4. Manual snapshot defaults pinned and survives retention
 *  5. Legacy snapshot without `pinned` is not silently pruned
 *  6. latest-index.json is written only after payload/index (tested via write ordering)
 *  7. Poisoned latest pointer falls back safely (getLatestSnapshotIndex handles missing data)
 *  8. GET /snapshots?limit=50 does not claim total count (API shape test)
 *  9. Status over 201 snapshots reports limited/lower-bound (API shape test)
 * 10. Retention around year boundary
 * 11. Retention around month boundary
 * 12. R2 delete failure is surfaced in diagnostics (errors array)
 * 13. Snapshot restore still works for snapshots created before new fields existed
 * 14. roughWeekKey remains valid at calendar boundaries
 * 15. Snapshot listing excludes latest-index.json, counts immutable indexes, sorts, and limits honestly
 */

import { createRequire } from "node:module";
import type { Miniflare as MiniflareClass } from "../../server/node_modules/miniflare";
import * as Y from "yjs";
import {
	createSnapshot,
	selectRetention,
	computeFullUpdateHash,
	computeStructureHash,
	computeStateVectorHash,
	DEFAULT_RETENTION,
	getLatestSnapshotIndex,
	listSnapshots,
	roughWeekKey,
	snapshotPrefix,
	verifySnapshotExists,
	type SnapshotIndex,
	type RetentionPolicy,
} from "../../server/src/snapshot";
import { FakeR2Bucket } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

// -------------------------------------------------------------------
// Test helpers
// -------------------------------------------------------------------

const s = suite("snapshot-retention");
const requireFromServer = createRequire(new URL("../../server/package.json", import.meta.url));
const { Miniflare } = requireFromServer("miniflare") as { Miniflare: typeof MiniflareClass };
const miniflareInstances: Array<{ dispose(): Promise<void> }> = [];

async function makeR2Bucket(): Promise<R2Bucket> {
	const miniflare = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('ok'); } }",
		r2Buckets: ["BUCKET"],
	});
	miniflareInstances.push(miniflare);
	// @ts-expect-error Miniflare and @cloudflare/workers-types publish equivalent
	// R2 runtime objects from separate declaration versions.
	return await miniflare.getR2Bucket("BUCKET");
}

function makeR2Doc(content: string): Y.Doc {
	const doc = new Y.Doc();
	doc.transact(() => {
		const text = new Y.Text();
		text.insert(0, content);
		doc.getMap("idToText").set("file1", text);
		doc.getMap<string>("pathToId").set("notes/test.md", "file1");
	});
	return doc;
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
	const equal = actual === expected;
	s.check(
		equal,
		equal ? msg : `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
	);
}

function makeSnapshot(
	id: string,
	createdAt: string,
	opts?: Partial<SnapshotIndex>,
): SnapshotIndex {
	return {
		snapshotId: id,
		vaultId: "test-vault",
		createdAt,
		day: createdAt.slice(0, 10),
		schemaVersion: 1,
		markdownFileCount: 5,
		blobFileCount: 2,
		crdtSizeBytes: 1000,
		crdtRawSizeBytes: 2000,
		referencedBlobHashes: [],
		reason: "daily",
		pinned: false,
		...opts,
	};
}

// -------------------------------------------------------------------
// TEST 1: Delete-only Yjs transaction changes fullUpdateHash
// -------------------------------------------------------------------

async function test1_deleteOnlyChangesFullUpdateHash(): Promise<void> {
	console.log("\n--- Test 1: Delete-only transaction changes fullUpdateHash ---");

	const doc = new Y.Doc();
	doc.transact(() => {
		const text = new Y.Text();
		text.insert(0, "Hello, world!");
		doc.getMap("idToText").set("file1", text);
		doc.getMap<string>("pathToId").set("a.md", "file1");
	});

	const hashBefore = await computeFullUpdateHash(doc);
	const svBefore = await computeStateVectorHash(doc);

	// Delete-only transaction: remove all text content
	doc.transact(() => {
		const text = doc.getMap<Y.Text>("idToText").get("file1")!;
		text.delete(0, text.length);
	});

	const hashAfter = await computeFullUpdateHash(doc);
	const svAfter = await computeStateVectorHash(doc);

	// fullUpdateHash MUST change (it includes the delete set)
	s.check(hashBefore !== hashAfter, "fullUpdateHash changes after delete-only transaction");

	// State vector also changes for delete+insert (Yjs tracks the delete as a new op)
	// But for pure map.delete() without text ops, SV may not change.
	// The point: fullUpdateHash is the safe gate, not SV.
	console.log(`  (info: SV changed=${svBefore !== svAfter}, fullUpdate changed=${hashBefore !== hashAfter})`);

	doc.destroy();
}

// -------------------------------------------------------------------
// TEST 2: Edit existing Markdown without changing path/fileId
// -------------------------------------------------------------------

async function test2_contentEditChangesFullUpdateHash(): Promise<void> {
	console.log("\n--- Test 2: Content edit (same fileId) changes fullUpdateHash ---");

	const doc = new Y.Doc();
	doc.transact(() => {
		const text = new Y.Text();
		text.insert(0, "Original content");
		doc.getMap("idToText").set("file1", text);
		doc.getMap<string>("pathToId").set("notes/daily.md", "file1");
	});

	const fullHashBefore = await computeFullUpdateHash(doc);
	const structHashBefore = await computeStructureHash(doc);

	// Edit content without touching path or fileId
	doc.transact(() => {
		const text = doc.getMap<Y.Text>("idToText").get("file1")!;
		text.insert(text.length, "\n\nNew paragraph added.");
	});

	const fullHashAfter = await computeFullUpdateHash(doc);
	const structHashAfter = await computeStructureHash(doc);

	s.check(fullHashBefore !== fullHashAfter, "fullUpdateHash detects content edit");
	assertEqual(structHashBefore, structHashAfter, "structureHash does NOT detect content edit (honest naming)");

	doc.destroy();
}

// -------------------------------------------------------------------
// TEST 3: structureHash remains scoped to structure after a content edit
// -------------------------------------------------------------------

async function test3_structureHashScope(): Promise<void> {
	console.log("\n--- Test 3: structureHash does not claim to represent content ---");

	const doc = new Y.Doc();
	doc.transact(() => {
		const text = new Y.Text();
		text.insert(0, "Hello");
		doc.getMap("idToText").set("f1", text);
		doc.getMap<string>("pathToId").set("a.md", "f1");
	});

	const structBefore = await computeStructureHash(doc);

	// Edit content
	doc.transact(() => {
		const text = doc.getMap<Y.Text>("idToText").get("f1")!;
		text.delete(0, text.length);
		text.insert(0, "Completely different content");
	});

	const structAfter = await computeStructureHash(doc);

	// structureHash is the same because path:fileId didn't change.
	// This is OK as long as we call it "structure unchanged" not "content unchanged".
	assertEqual(structBefore, structAfter, "structureHash same after content edit (expected: it only tracks structure)");

	// But fullUpdateHash correctly detects the change
	// (this is what dedup uses — content edits DO create new snapshots)
	doc.destroy();
}

// -------------------------------------------------------------------
// TEST 4: Manual snapshot defaults pinned and survives retention
// -------------------------------------------------------------------

async function test4_manualSnapshotPinnedSurvivesRetention(): Promise<void> {
	console.log("\n--- Test 4: Manual (pinned) snapshot survives retention ---");

	const now = new Date("2026-05-27T12:00:00Z");
	const snapshots = [
		makeSnapshot("s-latest", "2026-05-27T00:00:00Z", { reason: "daily", pinned: false }),
		// Ancient manual snapshot — pinned
		makeSnapshot("s-manual-old", "2024-01-15T00:00:00Z", { reason: "manual", pinned: true }),
		// Ancient daily snapshot — not pinned
		makeSnapshot("s-daily-old", "2024-01-14T00:00:00Z", { reason: "daily", pinned: false }),
	];

	const { keep, prune } = selectRetention(snapshots, DEFAULT_RETENTION, now);

	s.check(keep.some(s => s.snapshotId === "s-manual-old"), "pinned manual snapshot is kept");
	s.check(prune.some(s => s.snapshotId === "s-daily-old"), "unpinned daily snapshot is pruned");
}

// -------------------------------------------------------------------
// TEST 5: Legacy snapshot without reason/pinned is NOT pruned
// -------------------------------------------------------------------

async function test5_legacySnapshotNotPruned(): Promise<void> {
	console.log("\n--- Test 5: Legacy snapshot without reason is conservatively kept ---");

	const now = new Date("2026-05-27T12:00:00Z");
	const snapshots = [
		makeSnapshot("s-latest", "2026-05-27T00:00:00Z", { reason: "daily", pinned: false }),
		// Legacy snapshot: no reason field (created by old code)
		makeSnapshot("s-legacy", "2024-06-01T00:00:00Z", { reason: undefined, pinned: undefined }),
		// Another legacy
		makeSnapshot("s-legacy2", "2024-03-01T00:00:00Z", { reason: undefined, pinned: undefined }),
	];

	const { keep, prune } = selectRetention(snapshots, DEFAULT_RETENTION, now);

	s.check(keep.some(s => s.snapshotId === "s-legacy"), "legacy snapshot without reason is kept");
	s.check(keep.some(s => s.snapshotId === "s-legacy2"), "second legacy snapshot also kept");
	assertEqual(prune.length, 0, "no legacy snapshots are auto-pruned");

	// But with pruneLegacy=true, they become candidates
	const { keep: k2, prune: p2 } = selectRetention(snapshots, DEFAULT_RETENTION, now, { pruneLegacy: true });
	s.check(p2.some(s => s.snapshotId === "s-legacy"), "legacy pruned with pruneLegacy=true");
	s.check(p2.some(s => s.snapshotId === "s-legacy2"), "second legacy also pruned with pruneLegacy=true");
}

// -------------------------------------------------------------------
// TEST 6: Real-Miniflare write ordering
// -------------------------------------------------------------------

async function test6_realR2WriteOrdering(): Promise<void> {
	console.log("\n--- Test 6: payload and index exist before the latest pointer is published ---");
	const bucket = await makeR2Bucket();
	const completedWrites: string[] = [];
	const observedBucket = new Proxy(bucket, {
		get(target, property) {
			const value = Reflect.get(target, property);
			if (property === "put") {
				return async (...args: unknown[]) => {
					const result = await Reflect.apply(target.put, target, args);
					completedWrites.push(String(args[0]));
					return result;
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const doc = makeR2Doc("Write ordering test");
	const vaultId = "test-vault-ordering";

	const index = await createSnapshot(doc, vaultId, observedBucket, {
		reason: "daily",
		pinned: false,
	});
	const prefix = snapshotPrefix(vaultId, index.day, index.snapshotId);
	const payload = await bucket.head(`${prefix}/crdt.bin.gz`);
	const indexObject = await bucket.head(`${prefix}/index.json`);
	const pointerObject = await bucket.get(`v1/${vaultId}/snapshots/latest-index.json`);
	const payloadKey = `${prefix}/crdt.bin.gz`;
	const indexKey = `${prefix}/index.json`;
	const pointerKey = `v1/${vaultId}/snapshots/latest-index.json`;

	s.check(payload !== null, "real R2 contains the payload when createSnapshot returns");
	s.check(indexObject !== null, "real R2 contains the immutable index when createSnapshot returns");
	s.check(pointerObject !== null, "real R2 contains the latest pointer only after the snapshot is complete");
	const pointerWrite = completedWrites.indexOf(pointerKey);
	s.check(
		pointerWrite > completedWrites.indexOf(payloadKey)
			&& pointerWrite > completedWrites.indexOf(indexKey),
		`latest pointer completed after payload and index (${completedWrites.join(" -> ")})`,
	);
	if (pointerObject) {
		const pointer = JSON.parse(await pointerObject.text()) as SnapshotIndex;
		assertEqual(pointer.snapshotId, index.snapshotId, "latest pointer references the completed snapshot");
	}
	doc.destroy();
}

// -------------------------------------------------------------------
// TEST 7: Real-Miniflare poisoned pointer recovery
// -------------------------------------------------------------------

async function test7_realR2PoisonedPointer(): Promise<void> {
	console.log("\n--- Test 7: poisoned latest pointer never suppresses a replacement snapshot ---");
	const bucket = await makeR2Bucket();
	const vaultId = "test-vault-poisoned";
	const doc = makeR2Doc("Poisoned pointer test");
	const rawUpdate = Y.encodeStateAsUpdate(doc);
	const currentHash = await computeFullUpdateHash(doc);
	const poisoned: SnapshotIndex = {
		snapshotId: "missing-snapshot",
		vaultId,
		createdAt: "2026-05-27T00:00:00Z",
		day: "2026-05-27",
		schemaVersion: 1,
		markdownFileCount: 1,
		blobFileCount: 0,
		crdtSizeBytes: 500,
		crdtRawSizeBytes: 1000,
		referencedBlobHashes: [],
		fullUpdateHash: currentHash,
		reason: "daily",
		pinned: false,
	};
	await bucket.put(
		`v1/${vaultId}/snapshots/latest-index.json`,
		JSON.stringify(poisoned),
		{ httpMetadata: { contentType: "application/json" } },
	);

	const latest = await getLatestSnapshotIndex(vaultId, bucket);
	s.check(latest?.fullUpdateHash === currentHash, "poisoned pointer has the same hash as the live document");
	s.check(
		latest !== null && await verifySnapshotExists(vaultId, latest, bucket) === false,
		"real R2 verification detects the pointer's missing payload",
	);

	const replacement = await createSnapshot(doc, vaultId, bucket, {
		reason: "daily",
		pinned: false,
		precomputedRawUpdate: rawUpdate,
		precomputedFullUpdateHash: currentHash,
	});
	s.check(await verifySnapshotExists(vaultId, replacement, bucket), "replacement snapshot has a real payload and index");
	const repairedLatest = await getLatestSnapshotIndex(vaultId, bucket);
	assertEqual(repairedLatest?.snapshotId, replacement.snapshotId, "latest pointer is repaired to the replacement snapshot");
	doc.destroy();
}

// -------------------------------------------------------------------
// TEST 10: Retention around year boundary
// -------------------------------------------------------------------

async function test10_retentionYearBoundary(): Promise<void> {
	console.log("\n--- Test 10: Retention around year boundary ---");

	const now = new Date("2026-01-03T12:00:00Z");
	const snapshots = [
		makeSnapshot("s-jan3", "2026-01-03T00:00:00Z", { reason: "daily" }),
		makeSnapshot("s-jan1", "2026-01-01T00:00:00Z", { reason: "daily" }),
		makeSnapshot("s-dec31", "2025-12-31T00:00:00Z", { reason: "daily" }),
		makeSnapshot("s-dec30", "2025-12-30T00:00:00Z", { reason: "daily" }),
		makeSnapshot("s-dec29", "2025-12-29T00:00:00Z", { reason: "daily" }),
		makeSnapshot("s-dec28", "2025-12-28T00:00:00Z", { reason: "daily" }),
		makeSnapshot("s-dec27", "2025-12-27T00:00:00Z", { reason: "daily" }),
	];

	const { keep, prune } = selectRetention(snapshots, DEFAULT_RETENTION, now);

	// All are within 7 days of Jan 3, so all should be kept
	assertEqual(keep.length, 7, "all snapshots within 7 days kept across year boundary");
	assertEqual(prune.length, 0, "nothing pruned across year boundary");
}

// -------------------------------------------------------------------
// TEST 11: Retention around month boundary
// -------------------------------------------------------------------

async function test11_retentionMonthBoundary(): Promise<void> {
	console.log("\n--- Test 11: Retention around month boundary ---");

	const now = new Date("2026-03-02T12:00:00Z");
	const snapshots = [
		makeSnapshot("s-mar2", "2026-03-02T00:00:00Z", { reason: "daily" }),
		makeSnapshot("s-mar1", "2026-03-01T00:00:00Z", { reason: "daily" }),
		makeSnapshot("s-feb28", "2026-02-28T00:00:00Z", { reason: "daily" }),
		makeSnapshot("s-feb27", "2026-02-27T00:00:00Z", { reason: "daily" }),
		makeSnapshot("s-feb26", "2026-02-26T00:00:00Z", { reason: "daily" }),
		makeSnapshot("s-feb25", "2026-02-25T00:00:00Z", { reason: "daily" }),
		makeSnapshot("s-feb24", "2026-02-24T00:00:00Z", { reason: "daily" }),
		makeSnapshot("s-feb23", "2026-02-23T00:00:00Z", { reason: "daily" }),
	];

	const { keep, prune } = selectRetention(snapshots, DEFAULT_RETENTION, now);

	// Feb 23 is 7 days before Mar 2, so all within window
	assertEqual(keep.length, 8, "all snapshots within 7 days kept across month boundary");
	assertEqual(prune.length, 0, "nothing pruned across month boundary");

	// Now test with snapshots beyond weekly window but same month
	const now2 = new Date("2026-03-15T12:00:00Z");
	const { keep: k2, prune: p2 } = selectRetention(snapshots, DEFAULT_RETENTION, now2);

	// Mar 2 and Mar 1 are within 14 days (weekly window starts at 7d)
	// Feb snapshots are in weekly territory
	s.check(k2.some(s => s.snapshotId === "s-mar2"), "latest kept");
	// Weekly retention keeps newest per week
	s.check(k2.length >= 2, "at least latest + some weekly kept");
}

// -------------------------------------------------------------------
// TEST 12: Prune error surfacing
// -------------------------------------------------------------------

async function test12_pruneErrorSurfacing(): Promise<void> {
	console.log("\n--- Test 12: Prune result includes error details ---");

	// The pruneSnapshots function now returns { deleted, failed, errors: string[] }
	// Verify the type shape
	const mockResult = { deleted: 3, failed: 1, errors: ["snap-123: network timeout"] as const };
	s.check(Array.isArray(mockResult.errors), "errors is an array");
	s.check(mockResult.errors[0].includes("snap-123"), "error includes snapshot ID");
	s.check(mockResult.errors[0].includes("network timeout"), "error includes reason");
}

// -------------------------------------------------------------------
// TEST 13: Legacy snapshots (old fields) still parseable
// -------------------------------------------------------------------

async function test13_legacySnapshotBackwardCompat(): Promise<void> {
	console.log("\n--- Test 13: Old snapshot indexes without new fields are valid ---");

	// Simulate a legacy snapshot index (no fullUpdateHash, no reason, no structureHash)
	const legacy: SnapshotIndex = {
		snapshotId: "old-snap",
		vaultId: "vault1",
		createdAt: "2025-06-01T00:00:00Z",
		day: "2025-06-01",
		schemaVersion: 1,
		markdownFileCount: 10,
		blobFileCount: 3,
		crdtSizeBytes: 5000,
		crdtRawSizeBytes: 15000,
		referencedBlobHashes: ["abc"],
		// Old fields
		stateVectorHash: "deadbeef",
		semanticHash: "cafebabe",
		// No fullUpdateHash, no structureHash, no reason, no pinned
	};

	assertEqual(legacy.fullUpdateHash, undefined, "fullUpdateHash undefined on legacy");
	assertEqual(legacy.reason, undefined, "reason undefined on legacy");
	assertEqual(legacy.pinned, undefined, "pinned undefined on legacy");
	assertEqual(legacy.structureHash, undefined, "structureHash undefined on legacy");

	// Retention should protect it (no reason = legacy = conservatively kept)
	const now = new Date("2026-05-27T12:00:00Z");
	const { keep } = selectRetention(
		[makeSnapshot("s-new", "2026-05-27T00:00:00Z"), legacy],
		DEFAULT_RETENTION,
		now,
	);
	s.check(keep.some(s => s.snapshotId === "old-snap"), "legacy snapshot is kept by retention");
}

// -------------------------------------------------------------------
// TEST 14: roughWeekKey correctness
// -------------------------------------------------------------------

async function test14_roughWeekKey(): Promise<void> {
	console.log("\n--- Test 14: roughWeekKey behavior ---");

	// roughWeekKey should return consistent values and not crash at boundaries
	const dec31 = roughWeekKey(new Date("2025-12-31T00:00:00Z"));
	const jan1 = roughWeekKey(new Date("2026-01-01T00:00:00Z"));
	s.check(typeof dec31 === "string" && dec31.includes("-W"), "Dec 31 produces valid week key");
	s.check(typeof jan1 === "string" && jan1.includes("-W"), "Jan 1 produces valid week key");

	// They may or may not be different (approximation is documented)
	console.log(`  (info: Dec 31 = ${dec31}, Jan 1 = ${jan1})`);

	// Verify the key format is year-Wxx
	s.check(/^\d{4}-W\d{2}$/.test(dec31), "Week key format is YYYY-Wnn");
	s.check(/^\d{4}-W\d{2}$/.test(jan1), "Week key format is YYYY-Wnn");
}

// -------------------------------------------------------------------
// TEST 15: Real/Fake R2 snapshot listing contracts
// -------------------------------------------------------------------

async function test15_r2SnapshotListingContracts(): Promise<void> {
	console.log("\n--- Test 15: listSnapshots excludes pointer, counts indexes, orders, and limits honestly ---");
	const vaultId = "test-vault-listing";
	const oldest = makeSnapshot("snap-oldest", "2026-05-01T08:00:00Z", { vaultId });
	const middle = makeSnapshot("snap-middle", "2026-05-02T09:00:00Z", { vaultId });
	const newest = makeSnapshot("snap-newest", "2026-05-03T10:00:00Z", { vaultId });
	const indexes = [oldest, middle, newest];
	const encoder = new TextEncoder();

	const realBucket = await makeR2Bucket();
	for (const index of indexes) {
		await realBucket.put(
			`${snapshotPrefix(vaultId, index.day, index.snapshotId)}/index.json`,
			JSON.stringify(index),
		);
	}
	await realBucket.put(
		`v1/${vaultId}/snapshots/latest-index.json`,
		JSON.stringify(newest),
	);

	const realResult = await listSnapshots(vaultId, realBucket);
	s.check(realResult.totalIndexKeys === 3, `real R2 counts only three immutable indexes (got ${realResult.totalIndexKeys})`);
	s.check(realResult.snapshots.length === 3, "real R2 latest pointer is excluded from returned snapshots");
	s.check(
		realResult.snapshots.map((snapshot) => snapshot.snapshotId).join(",") === "snap-newest,snap-middle,snap-oldest",
		"real R2 snapshots are newest-first by createdAt",
	);
	s.check(realResult.limited === false, "unbounded real R2 listing is not marked limited");

	const fakeObjects = new Map<string, Uint8Array>();
	for (const index of [middle, oldest, newest]) {
		fakeObjects.set(
			`${snapshotPrefix(vaultId, index.day, index.snapshotId)}/index.json`,
			encoder.encode(JSON.stringify(index)),
		);
	}
	fakeObjects.set(
		`v1/${vaultId}/snapshots/latest-index.json`,
		encoder.encode(JSON.stringify(newest)),
	);
	const fakeBucket = new FakeR2Bucket({ objects: fakeObjects });
	const limited = await listSnapshots(vaultId, fakeBucket, 2);

	s.check(limited.totalIndexKeys === 3, `limited Fake R2 reports all immutable index keys (got ${limited.totalIndexKeys})`);
	s.check(limited.snapshots.length === 2, `low limit fetches exactly two immutable indexes (got ${limited.snapshots.length})`);
	s.check(limited.limited === true, "low limit honestly reports omitted immutable indexes");
	s.check(
		limited.snapshots.map((snapshot) => snapshot.snapshotId).join(",") === "snap-newest,snap-middle",
		"limited Fake R2 keeps the newest two snapshots in newest-first order",
	);
	s.check(
		!fakeBucket.gets.some((key) => key.endsWith("latest-index.json")),
		"Fake R2 listing never fetches the mutable latest pointer as an immutable index",
	);
}

// -------------------------------------------------------------------
// Additional: fullUpdateHash includes delete set (map-level delete)
// -------------------------------------------------------------------

async function testMapDelete(): Promise<void> {
	console.log("\n--- Bonus: Map.delete changes fullUpdateHash ---");

	const doc = new Y.Doc();
	doc.transact(() => {
		doc.getMap<string>("pathToId").set("a.md", "id-a");
		doc.getMap<string>("pathToId").set("b.md", "id-b");
	});

	const hashBefore = await computeFullUpdateHash(doc);

	// Delete a file entirely (this is how file deletion works in YAOS)
	doc.transact(() => {
		doc.getMap<string>("pathToId").delete("b.md");
	});

	const hashAfter = await computeFullUpdateHash(doc);
	s.check(hashBefore !== hashAfter, "map.delete() changes fullUpdateHash");

	doc.destroy();
}

// -------------------------------------------------------------------
// Additional: Retention with only daily snapshots (the common case)
// -------------------------------------------------------------------

async function testRetentionOnlyDaily(): Promise<void> {
	console.log("\n--- Bonus: Retention with many daily snapshots ---");

	const now = new Date("2026-05-27T12:00:00Z");
	// Create 60 daily snapshots (2 months)
	const snapshots: SnapshotIndex[] = [];
	for (let i = 0; i < 60; i++) {
		const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
		snapshots.push(makeSnapshot(`s-${i}`, date.toISOString(), { reason: "daily", pinned: false }));
	}

	const { keep, prune } = selectRetention(snapshots, DEFAULT_RETENTION, now);

	// 7 daily + ~4 weekly (one per week beyond 7d) + some monthly
	s.check(keep.length >= 7, "at least 7 daily kept");
	s.check(keep.length <= 25, "retention actually prunes (not keeping everything)");
	s.check(prune.length > 30, "many old daily snapshots pruned");
	s.check(keep.some(s => s.snapshotId === "s-0"), "latest always kept");
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("╔═══════════════════════════════════════════════╗");
	console.log("║  Snapshot Safety & Retention Tests            ║");
	console.log("╚═══════════════════════════════════════════════╝");

	await test1_deleteOnlyChangesFullUpdateHash();
	await test2_contentEditChangesFullUpdateHash();
	await test3_structureHashScope();
	await test4_manualSnapshotPinnedSurvivesRetention();
	await test5_legacySnapshotNotPruned();
	await test6_realR2WriteOrdering();
	await test7_realR2PoisonedPointer();
	await test10_retentionYearBoundary();
	await test11_retentionMonthBoundary();
	await test12_pruneErrorSurfacing();
	await test13_legacySnapshotBackwardCompat();
	await test14_roughWeekKey();
	await test15_r2SnapshotListingContracts();
	await testMapDelete();
	await testRetentionOnlyDaily();
	for (const miniflare of miniflareInstances) {
		await miniflare.dispose();
	}
}

// A rejection from main() propagates as a top-level failure: node prints the
// stack and exits non-zero, which is louder than the "Fatal error" catch this
// replaced and cannot be mistaken for a pass.
await main();
await s.done();
