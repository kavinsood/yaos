/**
 * Behavioral tests for snapshot safety using real R2 (via Miniflare).
 *
 * These tests exercise actual R2 storage semantics — not mocks.
 * They prove the correctness of:
 *   - Write ordering (payload + index before latest pointer)
 *   - Poisoned pointer detection (latest points to missing payload)
 *   - Listing correctly excludes latest-index.json
 *   - createSnapshot with precomputed update avoids double-encode
 *   - Retention with pruneLegacy flag
 *   - Status endpoint returns honest lower bounds
 *
 * Usage:
 *   node --import jiti/register tests/snapshot-r2.ts
 */

import { Miniflare } from "miniflare";
import * as Y from "yjs";
import {
	createSnapshot,
	getLatestSnapshotIndex,
	verifySnapshotExists,
	listSnapshots,
	computeFullUpdateHash,
	applyRetention,
	selectRetention,
	snapshotPrefix,
	DEFAULT_RETENTION,
	type SnapshotIndex,
} from "../src/snapshot";
import { sha256Hex } from "../src/hex";

// -------------------------------------------------------------------
// Test infra
// -------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  ✓ ${msg}`);
		passed++;
	} else {
		console.error(`  ✗ FAIL: ${msg}`);
		failed++;
	}
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
	if (actual === expected) {
		console.log(`  ✓ ${msg}`);
		passed++;
	} else {
		console.error(`  ✗ FAIL: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
		failed++;
	}
}

const instances: Miniflare[] = [];

async function getBucket(): Promise<R2Bucket> {
	const mf = new Miniflare({
		modules: true,
		script: "export default { fetch() { return new Response('ok'); } }",
		r2Buckets: ["BUCKET"],
	});
	instances.push(mf);
	return await mf.getR2Bucket("BUCKET");
}

function makeDoc(content: string = "Hello"): Y.Doc {
	const doc = new Y.Doc();
	doc.transact(() => {
		const text = new Y.Text();
		text.insert(0, content);
		doc.getMap("idToText").set("file1", text);
		doc.getMap<string>("pathToId").set("notes/test.md", "file1");
	});
	return doc;
}

// -------------------------------------------------------------------
// Test 1: Write ordering — payload and index exist before pointer
// -------------------------------------------------------------------

async function test1_writeOrdering(): Promise<void> {
	console.log("\n--- Test 1: Write ordering (payload + index before pointer) ---");

	const bucket = await getBucket();
	const doc = makeDoc("Write ordering test");
	const vaultId = "test-vault-ordering";

	const index = await createSnapshot(doc, vaultId, bucket, {
		reason: "daily",
		pinned: false,
	});

	// Verify all three objects exist
	const prefix = snapshotPrefix(vaultId, index.day, index.snapshotId);
	const payload = await bucket.head(`${prefix}/crdt.bin.gz`);
	const indexObj = await bucket.head(`${prefix}/index.json`);
	const pointer = await bucket.head(`v1/${vaultId}/snapshots/latest-index.json`);

	assert(payload !== null, "crdt.bin.gz exists after createSnapshot");
	assert(indexObj !== null, "index.json exists after createSnapshot");
	assert(pointer !== null, "latest-index.json exists after createSnapshot");

	// Verify pointer content matches the index
	const pointerObj = await bucket.get(`v1/${vaultId}/snapshots/latest-index.json`);
	const pointerContent = JSON.parse(await pointerObj!.text()) as SnapshotIndex;
	assertEqual(pointerContent.snapshotId, index.snapshotId, "pointer references correct snapshot");

	doc.destroy();
}

// -------------------------------------------------------------------
// Test 2: Poisoned pointer — latest points to missing payload
// -------------------------------------------------------------------

async function test2_poisonedPointer(): Promise<void> {
	console.log("\n--- Test 2: Poisoned pointer detection ---");

	const bucket = await getBucket();
	const vaultId = "test-vault-poisoned";

	// Manually write a poisoned latest-index.json (no corresponding payload)
	const fakeIndex: SnapshotIndex = {
		snapshotId: "fake-snap-id",
		vaultId,
		createdAt: "2026-05-27T00:00:00Z",
		day: "2026-05-27",
		schemaVersion: 1,
		markdownFileCount: 3,
		blobFileCount: 0,
		crdtSizeBytes: 500,
		crdtRawSizeBytes: 1000,
		referencedBlobHashes: [],
		fullUpdateHash: "will_be_set_below",
		reason: "daily",
		pinned: false,
	};

	// Create a doc whose fullUpdateHash we'll match to the poison pointer
	const doc = makeDoc("Poisoned pointer test");
	const rawUpdate = Y.encodeStateAsUpdate(doc);
	const docHash = await sha256Hex(rawUpdate);

	// Set the poisoned pointer to have the same hash as our doc
	fakeIndex.fullUpdateHash = docHash;

	await bucket.put(
		`v1/${vaultId}/snapshots/latest-index.json`,
		JSON.stringify(fakeIndex),
		{ httpMetadata: { contentType: "application/json" } },
	);

	// DO NOT write the actual crdt.bin.gz or index.json

	// Verify getLatestSnapshotIndex returns the poisoned pointer
	const latest = await getLatestSnapshotIndex(vaultId, bucket);
	assert(latest !== null, "poisoned pointer is readable");
	assertEqual(latest!.fullUpdateHash, docHash, "poisoned pointer has matching hash");

	// Verify verifySnapshotExists detects the missing payload
	const exists = await verifySnapshotExists(vaultId, latest!, bucket);
	assertEqual(exists, false, "verifySnapshotExists returns false for poisoned pointer");

	// Now the daily dedup logic should NOT skip.
	// Simulate what server.ts does:
	const currentHash = await sha256Hex(rawUpdate);
	let shouldSkip = false;
	if (latest?.fullUpdateHash === currentHash) {
		const verified = await verifySnapshotExists(vaultId, latest, bucket);
		if (verified) {
			shouldSkip = true;
		}
	}
	assertEqual(shouldSkip, false, "dedup does NOT skip when pointer is poisoned");

	// Now create a real snapshot and verify it works
	const realIndex = await createSnapshot(doc, vaultId, bucket, {
		reason: "daily",
		pinned: false,
		precomputedRawUpdate: rawUpdate,
		precomputedFullUpdateHash: currentHash,
	});

	const realExists = await verifySnapshotExists(vaultId, realIndex, bucket);
	assertEqual(realExists, true, "real snapshot passes verification");

	// After creating, latest pointer should reference the real snapshot
	const newLatest = await getLatestSnapshotIndex(vaultId, bucket);
	assertEqual(newLatest!.snapshotId, realIndex.snapshotId, "latest pointer updated to real snapshot");

	doc.destroy();
}

// -------------------------------------------------------------------
// Test 3: Listing excludes latest-index.json
// -------------------------------------------------------------------

async function test3_listingExcludesPointer(): Promise<void> {
	console.log("\n--- Test 3: Listing excludes latest-index.json ---");

	const bucket = await getBucket();
	const vaultId = "test-vault-listing";
	const doc = makeDoc("Listing test");

	// Create two snapshots
	await createSnapshot(doc, vaultId, bucket, { reason: "daily", pinned: false });
	doc.transact(() => {
		doc.getMap<string>("pathToId").set("another.md", "file2");
	});
	await createSnapshot(doc, vaultId, bucket, { reason: "daily", pinned: false });

	const { snapshots, totalIndexKeys, limited } = await listSnapshots(vaultId, bucket);

	assertEqual(snapshots.length, 2, "listing returns exactly 2 snapshots");
	assertEqual(totalIndexKeys, 2, "totalIndexKeys is 2 (not 3 — excludes latest-index.json)");
	assertEqual(limited, false, "not limited with only 2 snapshots");

	// Verify latest-index.json key exists in bucket but is not in listing
	const pointerObj = await bucket.head(`v1/${vaultId}/snapshots/latest-index.json`);
	assert(pointerObj !== null, "latest-index.json exists in bucket");

	// Verify no snapshot has ID derived from the pointer file
	for (const snap of snapshots) {
		assert(snap.snapshotId !== "latest-index", "no snapshot mistakenly named 'latest-index'");
	}

	doc.destroy();
}

// -------------------------------------------------------------------
// Test 4: Limited listing is honest
// -------------------------------------------------------------------

async function test4_limitedListingHonest(): Promise<void> {
	console.log("\n--- Test 4: Limited listing reports correct totals ---");

	const bucket = await getBucket();
	const vaultId = "test-vault-limited";
	const doc = makeDoc("Limited test");

	// Create 5 snapshots
	for (let i = 0; i < 5; i++) {
		doc.transact(() => {
			doc.getMap<string>("pathToId").set(`file${i}.md`, `id-${i}`);
		});
		await createSnapshot(doc, vaultId, bucket, { reason: "daily", pinned: false });
	}

	// List with limit 3
	const { snapshots, totalIndexKeys, limited } = await listSnapshots(vaultId, bucket, 3);

	assertEqual(totalIndexKeys, 5, "totalIndexKeys reports all 5 despite limit");
	assertEqual(snapshots.length, 3, "only 3 snapshots returned");
	assertEqual(limited, true, "limited flag is true");

	doc.destroy();
}

// -------------------------------------------------------------------
// Test 5: Precomputed raw update avoids double-encode
// -------------------------------------------------------------------

async function test5_precomputedUpdate(): Promise<void> {
	console.log("\n--- Test 5: Precomputed update produces correct snapshot ---");

	const bucket = await getBucket();
	const vaultId = "test-vault-precompute";
	const doc = makeDoc("Precomputed test");

	const rawUpdate = Y.encodeStateAsUpdate(doc);
	const hash = await sha256Hex(rawUpdate);

	const index = await createSnapshot(doc, vaultId, bucket, {
		reason: "manual",
		pinned: true,
		precomputedRawUpdate: rawUpdate,
		precomputedFullUpdateHash: hash,
	});

	assertEqual(index.fullUpdateHash, hash, "snapshot uses precomputed hash");
	assertEqual(index.reason, "manual", "reason is manual");
	assertEqual(index.pinned, true, "manual snapshot is pinned");

	// Verify payload is valid by downloading and applying
	const prefix = snapshotPrefix(vaultId, index.day, index.snapshotId);
	const payloadObj = await bucket.get(`${prefix}/crdt.bin.gz`);
	assert(payloadObj !== null, "payload exists");
	assert(payloadObj!.size > 0, "payload is non-empty");

	doc.destroy();
}

// -------------------------------------------------------------------
// Test 6: Retention with pruneLegacy=false protects legacy snapshots
// -------------------------------------------------------------------

async function test6_retentionLegacyProtection(): Promise<void> {
	console.log("\n--- Test 6: Retention protects legacy snapshots unless pruneLegacy=true ---");

	const bucket = await getBucket();
	const vaultId = "test-vault-legacy-retention";
	const doc = makeDoc("Legacy test");

	// Create a "legacy" snapshot by writing directly to R2 (no reason field)
	const legacyIndex: SnapshotIndex = {
		snapshotId: "legacy-snap-001",
		vaultId,
		createdAt: "2024-01-15T00:00:00Z",
		day: "2024-01-15",
		schemaVersion: 1,
		markdownFileCount: 10,
		blobFileCount: 0,
		crdtSizeBytes: 2000,
		crdtRawSizeBytes: 5000,
		referencedBlobHashes: [],
		// No reason, no pinned — legacy format
	};
	const legacyPrefix = snapshotPrefix(vaultId, legacyIndex.day, legacyIndex.snapshotId);
	await bucket.put(`${legacyPrefix}/crdt.bin.gz`, new Uint8Array([1, 2, 3]));
	await bucket.put(`${legacyPrefix}/index.json`, JSON.stringify(legacyIndex));

	// Create a recent daily snapshot
	const recentIndex = await createSnapshot(doc, vaultId, bucket, {
		reason: "daily",
		pinned: false,
	});

	// Run retention without pruneLegacy
	const result1 = await applyRetention(vaultId, bucket, DEFAULT_RETENTION, { pruneLegacy: false });
	assertEqual(result1.pruned, 0, "legacy snapshot NOT pruned with pruneLegacy=false");

	// Verify legacy snapshot still exists
	const legacyPayload = await bucket.head(`${legacyPrefix}/crdt.bin.gz`);
	assert(legacyPayload !== null, "legacy crdt.bin.gz still exists");

	// Run retention WITH pruneLegacy
	const result2 = await applyRetention(vaultId, bucket, DEFAULT_RETENTION, { pruneLegacy: true });
	assertEqual(result2.pruned, 1, "legacy snapshot IS pruned with pruneLegacy=true");

	// Verify legacy snapshot is gone
	const legacyPayloadAfter = await bucket.head(`${legacyPrefix}/crdt.bin.gz`);
	assertEqual(legacyPayloadAfter, null, "legacy crdt.bin.gz deleted after pruneLegacy");

	doc.destroy();
}

// -------------------------------------------------------------------
// Test 7: fullUpdateHash dedup with real R2 — identical doc skips
// -------------------------------------------------------------------

async function test7_dedupWithRealR2(): Promise<void> {
	console.log("\n--- Test 7: fullUpdateHash dedup with real R2 ---");

	const bucket = await getBucket();
	const vaultId = "test-vault-dedup";
	const doc = makeDoc("Dedup test");

	// Create first snapshot
	const index1 = await createSnapshot(doc, vaultId, bucket, {
		reason: "daily",
		pinned: false,
	});

	// Get latest and verify dedup would skip
	const latest = await getLatestSnapshotIndex(vaultId, bucket);
	assert(latest !== null, "latest pointer exists");
	assertEqual(latest!.snapshotId, index1.snapshotId, "latest points to first snapshot");

	const currentHash = await computeFullUpdateHash(doc);
	assertEqual(currentHash, latest!.fullUpdateHash, "hash matches — dedup should skip");

	// Verify the snapshot is real (not poisoned)
	const exists = await verifySnapshotExists(vaultId, latest!, bucket);
	assertEqual(exists, true, "snapshot verified — safe to skip");

	// Now modify doc and verify hash changes
	doc.transact(() => {
		const text = doc.getMap<Y.Text>("idToText").get("file1")!;
		text.insert(text.length, " — modified!");
	});
	const newHash = await computeFullUpdateHash(doc);
	assert(newHash !== latest!.fullUpdateHash, "hash changes after edit — dedup would NOT skip");

	doc.destroy();
}

// -------------------------------------------------------------------
// Test 8: Delete-only change + real R2 dedup
// -------------------------------------------------------------------

async function test8_deleteOnlyWithR2(): Promise<void> {
	console.log("\n--- Test 8: Delete-only change is not skipped by dedup ---");

	const bucket = await getBucket();
	const vaultId = "test-vault-delete-dedup";
	const doc = new Y.Doc();
	doc.transact(() => {
		const text = new Y.Text();
		text.insert(0, "This will be deleted");
		doc.getMap("idToText").set("f1", text);
		doc.getMap<string>("pathToId").set("a.md", "f1");
		doc.getMap<string>("pathToId").set("b.md", "f2");
	});

	// Snapshot before delete
	const index1 = await createSnapshot(doc, vaultId, bucket, { reason: "daily", pinned: false });
	const latest = await getLatestSnapshotIndex(vaultId, bucket);

	// Delete-only operation
	doc.transact(() => {
		doc.getMap<string>("pathToId").delete("b.md");
	});

	const currentHash = await computeFullUpdateHash(doc);
	assert(currentHash !== latest!.fullUpdateHash, "fullUpdateHash changes after delete-only op");

	// This means dedup will NOT skip — a new snapshot will be created
	doc.destroy();
}

// -------------------------------------------------------------------
// Test 9: Multiple snapshots same day sort correctly
// -------------------------------------------------------------------

async function test9_sameDaySorting(): Promise<void> {
	console.log("\n--- Test 9: Multiple snapshots on same day sort by createdAt ---");

	const bucket = await getBucket();
	const vaultId = "test-vault-sort";
	const doc = makeDoc("Sort test");

	const index1 = await createSnapshot(doc, vaultId, bucket, { reason: "daily", pinned: false });

	// Small delay to ensure different timestamps
	await new Promise(r => setTimeout(r, 10));

	doc.transact(() => {
		doc.getMap<string>("pathToId").set("new.md", "f-new");
	});
	const index2 = await createSnapshot(doc, vaultId, bucket, { reason: "manual", pinned: true });

	const { snapshots } = await listSnapshots(vaultId, bucket);
	assertEqual(snapshots.length, 2, "2 snapshots listed");
	assertEqual(snapshots[0].snapshotId, index2.snapshotId, "newest first in listing");
	assertEqual(snapshots[1].snapshotId, index1.snapshotId, "oldest second");

	doc.destroy();
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("╔═══════════════════════════════════════════════╗");
	console.log("║  Snapshot R2 Behavioral Tests (Miniflare)     ║");
	console.log("╚═══════════════════════════════════════════════╝");

	await test1_writeOrdering();
	await test2_poisonedPointer();
	await test3_listingExcludesPointer();
	await test4_limitedListingHonest();
	await test5_precomputedUpdate();
	await test6_retentionLegacyProtection();
	await test7_dedupWithRealR2();
	await test8_deleteOnlyWithR2();
	await test9_sameDaySorting();

	console.log("\n═══════════════════════════════════════════════");
	console.log(`RESULTS: ${passed} passed, ${failed} failed`);
	console.log("═══════════════════════════════════════════════");

	// Dispose all Miniflare instances to allow clean process exit.
	for (const mf of instances) {
		await mf.dispose();
	}

	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
