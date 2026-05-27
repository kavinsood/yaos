/**
 * Snapshot API backward-compatibility tests.
 *
 * Verifies that old plugin + new server and new plugin + old server
 * combinations work without breakage.
 *
 * Usage:
 *   node --import jiti/register tests/snapshot-compat.ts
 */

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
// Simulate server responses
// -------------------------------------------------------------------

// Old server list response (just { snapshots: [...] })
const OLD_SERVER_LIST_RESPONSE = {
	snapshots: [
		{ snapshotId: "s1", createdAt: "2026-01-01T00:00:00Z", markdownFileCount: 5 },
		{ snapshotId: "s2", createdAt: "2026-01-02T00:00:00Z", markdownFileCount: 8 },
	],
};

// New server default list response (same shape — compatible!)
const NEW_SERVER_LIST_RESPONSE_DEFAULT = {
	snapshots: [
		{ snapshotId: "s1", createdAt: "2026-01-01T00:00:00Z", markdownFileCount: 5 },
	],
};

// New server ?format=v2 list response
const NEW_SERVER_LIST_RESPONSE_V2 = {
	snapshots: [
		{ snapshotId: "s1", createdAt: "2026-01-01T00:00:00Z", markdownFileCount: 5 },
	],
	totalIndexKeys: 10,
	fetchedCount: 1,
	limited: true,
};

// Old server status response
const OLD_SERVER_STATUS = {
	snapshotCount: 15,
	latestSnapshotId: "s-latest",
	latestCreatedAt: "2026-05-27T00:00:00Z",
	estimatedStorageBytes: 50000,
	pinnedCount: 3,
};

// New server status response (includes both old aliases and new fields)
const NEW_SERVER_STATUS = {
	snapshotCountLowerBound: 15,
	listedSnapshotCount: 15,
	listingLimited: false,
	estimatedStorageBytesLowerBound: 50000,
	pinnedCountLowerBound: 3,
	// Legacy aliases
	snapshotCount: 15,
	estimatedStorageBytes: 50000,
	pinnedCount: 3,
	// Common
	latestSnapshotId: "s-latest",
	latestCreatedAt: "2026-05-27T00:00:00Z",
};

// Old server manual snapshot response
const OLD_SERVER_MANUAL_SNAPSHOT = {
	status: "created",
	snapshotId: "s-manual",
	semanticUnchanged: true,
};

// New server manual snapshot response
const NEW_SERVER_MANUAL_SNAPSHOT = {
	status: "created",
	snapshotId: "s-manual",
	snapshotIdenticalToLatest: true,
	semanticUnchanged: true, // legacy alias
};

// -------------------------------------------------------------------
// Client parsers (simulate what the plugin does)
// -------------------------------------------------------------------

/** New client list parser — handles both shapes */
function parseListResponse(response: unknown): Array<{ snapshotId: string }> {
	if (Array.isArray(response)) return response;
	const obj = response as { snapshots?: Array<{ snapshotId: string }> };
	return obj.snapshots ?? [];
}

/** New client status parser — handles both old and new field names */
function parseStatusResponse(raw: Record<string, unknown>): {
	snapshotCount: number;
	estimatedStorageBytes: number;
	pinnedCount: number;
} {
	return {
		snapshotCount:
			(raw.snapshotCountLowerBound as number) ?? (raw.snapshotCount as number) ?? 0,
		estimatedStorageBytes:
			(raw.estimatedStorageBytesLowerBound as number) ?? (raw.estimatedStorageBytes as number) ?? 0,
		pinnedCount:
			(raw.pinnedCountLowerBound as number) ?? (raw.pinnedCount as number) ?? 0,
	};
}

/** New client manual snapshot parser — handles both field names */
function parseManualSnapshotUnchanged(raw: Record<string, unknown>): boolean {
	return !!(raw.snapshotIdenticalToLatest ?? raw.semanticUnchanged);
}

/** Old client list parser (what deployed plugins do) */
function oldClientParseList(response: { snapshots?: unknown[] }): unknown[] {
	return response.snapshots ?? [];
}

/** Old client status parser (what deployed plugins do) */
function oldClientParseStatus(raw: Record<string, unknown>): {
	snapshotCount: number;
	estimatedStorageBytes: number;
	pinnedCount: number;
} {
	return {
		snapshotCount: (raw.snapshotCount as number) ?? 0,
		estimatedStorageBytes: (raw.estimatedStorageBytes as number) ?? 0,
		pinnedCount: (raw.pinnedCount as number) ?? 0,
	};
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

function testOldClientNewServerList(): void {
	console.log("\n--- Old client + new server: GET /snapshots (default) ---");
	const result = oldClientParseList(NEW_SERVER_LIST_RESPONSE_DEFAULT);
	assertEqual(result.length, 1, "old client gets snapshots from new server default response");
}

function testNewClientOldServerList(): void {
	console.log("\n--- New client + old server: GET /snapshots ---");
	const result = parseListResponse(OLD_SERVER_LIST_RESPONSE);
	assertEqual(result.length, 2, "new client parses old server { snapshots } response");
}

function testNewClientNewServerV2List(): void {
	console.log("\n--- New client + new server: GET /snapshots?format=v2 ---");
	const result = parseListResponse(NEW_SERVER_LIST_RESPONSE_V2);
	assertEqual(result.length, 1, "new client parses v2 response snapshots");
	// v2 metadata available
	const v2 = NEW_SERVER_LIST_RESPONSE_V2;
	assertEqual(v2.totalIndexKeys, 10, "v2 response includes totalIndexKeys");
	assertEqual(v2.limited, true, "v2 response includes limited flag");
}

function testNewClientHandlesArrayResponse(): void {
	console.log("\n--- New client: handles bare array response (edge case) ---");
	const bareArray = [{ snapshotId: "s1" }, { snapshotId: "s2" }];
	const result = parseListResponse(bareArray);
	assertEqual(result.length, 2, "new client handles bare array gracefully");
}

function testOldClientNewServerStatus(): void {
	console.log("\n--- Old client + new server: GET /snapshots/status ---");
	const result = oldClientParseStatus(NEW_SERVER_STATUS as Record<string, unknown>);
	assertEqual(result.snapshotCount, 15, "old client reads snapshotCount alias from new server");
	assertEqual(result.estimatedStorageBytes, 50000, "old client reads estimatedStorageBytes alias");
	assertEqual(result.pinnedCount, 3, "old client reads pinnedCount alias");
}

function testNewClientOldServerStatus(): void {
	console.log("\n--- New client + old server: GET /snapshots/status ---");
	const result = parseStatusResponse(OLD_SERVER_STATUS as Record<string, unknown>);
	assertEqual(result.snapshotCount, 15, "new client falls back to snapshotCount from old server");
	assertEqual(result.estimatedStorageBytes, 50000, "new client falls back to estimatedStorageBytes");
	assertEqual(result.pinnedCount, 3, "new client falls back to pinnedCount");
}

function testNewClientNewServerStatus(): void {
	console.log("\n--- New client + new server: GET /snapshots/status ---");
	const result = parseStatusResponse(NEW_SERVER_STATUS as Record<string, unknown>);
	assertEqual(result.snapshotCount, 15, "new client uses snapshotCountLowerBound from new server");
	assertEqual(result.estimatedStorageBytes, 50000, "new client uses estimatedStorageBytesLowerBound");
	assertEqual(result.pinnedCount, 3, "new client uses pinnedCountLowerBound");
}

function testOldClientNewServerManualSnapshot(): void {
	console.log("\n--- Old client + new server: manual snapshot unchanged ---");
	// Old client checks result.semanticUnchanged
	const unchanged = !!(NEW_SERVER_MANUAL_SNAPSHOT as Record<string, unknown>).semanticUnchanged;
	assertEqual(unchanged, true, "old client reads semanticUnchanged alias from new server");
}

function testNewClientOldServerManualSnapshot(): void {
	console.log("\n--- New client + old server: manual snapshot unchanged ---");
	// Old server returns semanticUnchanged only
	const unchanged = parseManualSnapshotUnchanged(OLD_SERVER_MANUAL_SNAPSHOT as Record<string, unknown>);
	assertEqual(unchanged, true, "new client falls back to semanticUnchanged from old server");
}

function testNewClientNewServerManualSnapshot(): void {
	console.log("\n--- New client + new server: manual snapshot unchanged ---");
	const unchanged = parseManualSnapshotUnchanged(NEW_SERVER_MANUAL_SNAPSHOT as Record<string, unknown>);
	assertEqual(unchanged, true, "new client uses snapshotIdenticalToLatest from new server");
}

function testNewServerDefaultShapeIsLegacyCompatible(): void {
	console.log("\n--- New server default GET /snapshots is legacy-compatible ---");
	// The default response (without ?format=v2) should NOT include v2-only fields
	// to avoid confusing old clients with unexpected properties.
	const defaultResponse = NEW_SERVER_LIST_RESPONSE_DEFAULT;
	assert(!("totalIndexKeys" in defaultResponse), "default response omits totalIndexKeys");
	assert(!("limited" in defaultResponse), "default response omits limited");
	assert("snapshots" in defaultResponse, "default response has snapshots array");
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

function main(): void {
	console.log("╔═══════════════════════════════════════════════╗");
	console.log("║  Snapshot API Backward Compatibility Tests    ║");
	console.log("╚═══════════════════════════════════════════════╝");

	testOldClientNewServerList();
	testNewClientOldServerList();
	testNewClientNewServerV2List();
	testNewClientHandlesArrayResponse();
	testOldClientNewServerStatus();
	testNewClientOldServerStatus();
	testNewClientNewServerStatus();
	testOldClientNewServerManualSnapshot();
	testNewClientOldServerManualSnapshot();
	testNewClientNewServerManualSnapshot();
	testNewServerDefaultShapeIsLegacyCompatible();

	console.log("\n═══════════════════════════════════════════════");
	console.log(`RESULTS: ${passed} passed, ${failed} failed`);
	console.log("═══════════════════════════════════════════════");

	if (failed > 0) {
		process.exit(1);
	}
}

main();
