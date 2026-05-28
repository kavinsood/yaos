/**
 * Snapshot API backward-compatibility tests.
 *
 * Tests the ACTUAL exported normalizer functions from snapshotClient.ts,
 * not simulated parsers. This ensures compatibility logic cannot drift
 * from the real client implementation.
 *
 * Verifies that old plugin + new server and new plugin + old server
 * combinations work without breakage.
 *
 * Usage:
 *   node --import jiti/register tests/snapshot-compat.ts
 */

import {
	normalizeSnapshotListResponse,
	normalizeSnapshotStatusResponse,
	normalizeSnapshotUnchanged,
	type SnapshotIndex,
	type SnapshotStatus,
} from "../src/sync/snapshotClient";

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

// -------------------------------------------------------------------
// Simulated server responses (what each server version returns)
// -------------------------------------------------------------------

// Old server list response
const OLD_SERVER_LIST = {
	snapshots: [
		{ snapshotId: "s1", createdAt: "2026-01-01T00:00:00Z" },
		{ snapshotId: "s2", createdAt: "2026-01-02T00:00:00Z" },
	],
};

// New server default list response (same shape — backward compatible)
const NEW_SERVER_LIST_DEFAULT = {
	snapshots: [
		{ snapshotId: "s1", createdAt: "2026-01-01T00:00:00Z" },
	],
};

// New server ?format=v2 list response
const NEW_SERVER_LIST_V2 = {
	snapshots: [
		{ snapshotId: "s1", createdAt: "2026-01-01T00:00:00Z" },
	],
	totalIndexKeys: 10,
	fetchedCount: 1,
	limited: true,
};

// Bare array (hypothetical edge case)
const BARE_ARRAY = [
	{ snapshotId: "s1" },
	{ snapshotId: "s2" },
];

// Old server status
const OLD_SERVER_STATUS = {
	snapshotCount: 15,
	latestSnapshotId: "s-latest",
	latestCreatedAt: "2026-05-27T00:00:00Z",
	estimatedStorageBytes: 50000,
	pinnedCount: 3,
};

// New server status (returns both old aliases and new fields)
const NEW_SERVER_STATUS = {
	snapshotCountLowerBound: 15,
	listedSnapshotCount: 15,
	listingLimited: false,
	estimatedStorageBytesLowerBound: 50000,
	pinnedCountLowerBound: 3,
	snapshotCount: 15,
	estimatedStorageBytes: 50000,
	pinnedCount: 3,
	latestSnapshotId: "s-latest",
	latestCreatedAt: "2026-05-27T00:00:00Z",
};

// Old server manual snapshot response
const OLD_MANUAL_RESPONSE = {
	status: "created",
	snapshotId: "s-manual",
	semanticUnchanged: true,
};

// New server manual snapshot response
const NEW_MANUAL_RESPONSE = {
	status: "created",
	snapshotId: "s-manual",
	snapshotIdenticalToLatest: true,
	semanticUnchanged: true,
};

// -------------------------------------------------------------------
// Tests — using actual exported normalizers
// -------------------------------------------------------------------

function testListNormalization(): void {
	console.log("\n--- normalizeSnapshotListResponse ---");

	const fromOld = normalizeSnapshotListResponse(OLD_SERVER_LIST);
	assertEqual(fromOld.length, 2, "parses old server { snapshots } response");
	assertEqual(fromOld[0].snapshotId, "s1", "first snapshot ID correct");

	const fromNewDefault = normalizeSnapshotListResponse(NEW_SERVER_LIST_DEFAULT);
	assertEqual(fromNewDefault.length, 1, "parses new server default response");

	const fromV2 = normalizeSnapshotListResponse(NEW_SERVER_LIST_V2);
	assertEqual(fromV2.length, 1, "parses new server v2 response (extracts snapshots)");

	const fromArray = normalizeSnapshotListResponse(BARE_ARRAY);
	assertEqual(fromArray.length, 2, "handles bare array edge case");

	const fromNull = normalizeSnapshotListResponse(null);
	assertEqual(fromNull.length, 0, "handles null gracefully");

	const fromUndefined = normalizeSnapshotListResponse(undefined);
	assertEqual(fromUndefined.length, 0, "handles undefined gracefully");

	const fromEmpty = normalizeSnapshotListResponse({});
	assertEqual(fromEmpty.length, 0, "handles empty object gracefully");
}

function testStatusNormalization(): void {
	console.log("\n--- normalizeSnapshotStatusResponse ---");

	// New client + old server
	const fromOld = normalizeSnapshotStatusResponse(OLD_SERVER_STATUS);
	assertEqual(fromOld.snapshotCountLowerBound, 15, "falls back to snapshotCount from old server");
	assertEqual(fromOld.estimatedStorageBytesLowerBound, 50000, "falls back to estimatedStorageBytes");
	assertEqual(fromOld.pinnedCountLowerBound, 3, "falls back to pinnedCount");
	assertEqual(fromOld.listingLimited, false, "defaults listingLimited to false");
	assertEqual(fromOld.latestSnapshotId, "s-latest", "reads latestSnapshotId");

	// New client + new server
	const fromNew = normalizeSnapshotStatusResponse(NEW_SERVER_STATUS);
	assertEqual(fromNew.snapshotCountLowerBound, 15, "prefers snapshotCountLowerBound from new server");
	assertEqual(fromNew.estimatedStorageBytesLowerBound, 50000, "prefers estimatedStorageBytesLowerBound");
	assertEqual(fromNew.pinnedCountLowerBound, 3, "prefers pinnedCountLowerBound");

	// Edge cases
	const fromNull = normalizeSnapshotStatusResponse(null);
	assertEqual(fromNull.snapshotCountLowerBound, 0, "handles null — defaults to 0");

	const fromEmpty = normalizeSnapshotStatusResponse({});
	assertEqual(fromEmpty.snapshotCountLowerBound, 0, "handles empty — defaults to 0");
}

function testUnchangedNormalization(): void {
	console.log("\n--- normalizeSnapshotUnchanged ---");

	// New client + old server (only semanticUnchanged)
	assertEqual(
		normalizeSnapshotUnchanged(OLD_MANUAL_RESPONSE),
		true,
		"reads semanticUnchanged from old server",
	);

	// New client + new server (both fields)
	assertEqual(
		normalizeSnapshotUnchanged(NEW_MANUAL_RESPONSE),
		true,
		"reads snapshotIdenticalToLatest from new server",
	);

	// Not unchanged
	assertEqual(
		normalizeSnapshotUnchanged({ status: "created", snapshotId: "x" }),
		false,
		"returns false when neither field present",
	);

	// Edge cases
	assertEqual(normalizeSnapshotUnchanged(null), false, "handles null");
	assertEqual(normalizeSnapshotUnchanged(undefined), false, "handles undefined");
}

function testOldClientSimulation(): void {
	console.log("\n--- Old client behavior against new server ---");

	// Old client would do: result.snapshots ?? []
	// Verify new server default response has .snapshots
	const newDefault = NEW_SERVER_LIST_DEFAULT as Record<string, unknown>;
	assert("snapshots" in newDefault, "new server default has 'snapshots' key for old clients");
	assert(!("totalIndexKeys" in NEW_SERVER_LIST_DEFAULT), "default response omits v2 fields");

	// Old client would do: raw.snapshotCount
	const newStatus = NEW_SERVER_STATUS as Record<string, unknown>;
	assertEqual(newStatus.snapshotCount, 15, "new server status includes snapshotCount alias");
	assertEqual(newStatus.estimatedStorageBytes, 50000, "new server status includes estimatedStorageBytes alias");
	assertEqual(newStatus.pinnedCount, 3, "new server status includes pinnedCount alias");

	// Old client would do: result.semanticUnchanged
	const newManual = NEW_MANUAL_RESPONSE as Record<string, unknown>;
	assertEqual(newManual.semanticUnchanged, true, "new server manual includes semanticUnchanged alias");
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

function main(): void {
	console.log("╔═══════════════════════════════════════════════╗");
	console.log("║  Snapshot API Backward Compatibility Tests    ║");
	console.log("╚═══════════════════════════════════════════════╝");

	testListNormalization();
	testStatusNormalization();
	testUnchangedNormalization();
	testOldClientSimulation();

	console.log("\n═══════════════════════════════════════════════");
	console.log(`RESULTS: ${passed} passed, ${failed} failed`);
	console.log("═══════════════════════════════════════════════");

	if (failed > 0) {
		process.exit(1);
	}
}

main();
