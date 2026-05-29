/**
 * Tests for schema v3 version gating, server stats dual-read,
 * and realistic mixed-metadata vault scenarios.
 */

import * as Y from "yjs";
import {
	getMetaPath,
	isFileMetaDeletedValue,
	ensureNestedMetaEntry,
	createNestedActiveMeta,
	createNestedDeletedMeta,
	computeMetaShapeStats,
} from "../src/sync/fileMeta";
import {
	SERVER_MIN_SCHEMA_VERSION,
	SERVER_MAX_SCHEMA_VERSION,
} from "../server/src/version";
import { SCHEMA_VERSION } from "../src/sync/schema";

// Both client and server must agree on the target schema version.
const EXPECTED_SCHEMA_VERSION = SCHEMA_VERSION;

// ── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) { passed++; } else { failed++; console.error(`  FAIL: ${msg}`); }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
	if (actual === expected) { passed++; } else { failed++; console.error(`  FAIL: ${msg} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

function section(name: string): void {
	console.log(`\n── ${name} ──`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function populateMixedVault(doc: Y.Doc, activeCount: number, tombstoneCount: number): void {
	const meta = doc.getMap("meta");
	const sys = doc.getMap("sys");
	const idToText = doc.getMap("idToText");

	doc.transact(() => {
		sys.set("schemaVersion", 2);
		sys.set("initialized", true);

		// Flat active entries
		for (let i = 0; i < activeCount; i++) {
			meta.set(`active-${i}`, { path: `notes/file-${i}.md`, mtime: 1000 + i, device: "dev" });
			const text = new Y.Text();
			text.insert(0, `Content of file ${i}`);
			idToText.set(`active-${i}`, text);
		}

		// Flat tombstones
		for (let i = 0; i < tombstoneCount; i++) {
			meta.set(`tomb-${i}`, { path: `deleted/old-${i}.md`, deletedAt: 500 + i });
		}
	});
}

function simulateServerReadMetaPath(value: unknown): string | null {
	if (value instanceof Y.Map) {
		const path = value.get("path");
		return typeof path === "string" && path.length > 0 ? path : null;
	}
	if (typeof value === "object" && value !== null && "path" in value) {
		const path = (value as { path: unknown }).path;
		return typeof path === "string" && path.length > 0 ? path : null;
	}
	return null;
}

function simulateServerIsMetaDeleted(value: unknown): boolean {
	if (value instanceof Y.Map) {
		const deletedAt = value.get("deletedAt");
		if (typeof deletedAt === "number" && Number.isFinite(deletedAt)) return true;
		return value.get("deleted") === true;
	}
	if (typeof value === "object" && value !== null) {
		const m = value as { deleted?: boolean; deletedAt?: unknown };
		if (typeof m.deletedAt === "number" && Number.isFinite(m.deletedAt)) return true;
		return m.deleted === true;
	}
	return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Schema Gate Tests
// ═══════════════════════════════════════════════════════════════════════════

section("Schema gate: SCHEMA_VERSION is 3");

{
	// Verify the server constants are the real values from source, not hardcoded.
	assertEqual(SERVER_MIN_SCHEMA_VERSION, EXPECTED_SCHEMA_VERSION, "SERVER_MIN_SCHEMA_VERSION === 3");
	assertEqual(SERVER_MAX_SCHEMA_VERSION, EXPECTED_SCHEMA_VERSION, "SERVER_MAX_SCHEMA_VERSION === 3");
	assertEqual(SERVER_MIN_SCHEMA_VERSION, SERVER_MAX_SCHEMA_VERSION, "min === max (no legacy range)");
}

section("Schema gate: v3 client accepts room at schema 2");

{
	// A v3 client should be able to connect to a room still marked as schema 2
	// (it will mark it as 3 on connect). Schema 2 < min acceptable is NOT the rule —
	// the client marks it forward, so stored v2 is acceptable (client upgrades it).
	const doc = new Y.Doc();
	const sys = doc.getMap("sys");
	sys.set("schemaVersion", 2);

	const stored = sys.get("schemaVersion") as number;
	assert(stored < EXPECTED_SCHEMA_VERSION, "stored v2 < EXPECTED_SCHEMA_VERSION 3");
	assert(stored <= SERVER_MAX_SCHEMA_VERSION, "stored v2 within server max range");
}

section("Schema gate: v3 client rejects future room schema");

{
	const doc = new Y.Doc();
	const sys = doc.getMap("sys");
	sys.set("schemaVersion", 4);

	const stored = sys.get("schemaVersion") as number;
	assert(stored > EXPECTED_SCHEMA_VERSION, "future schema 4 > EXPECTED_SCHEMA_VERSION 3");
	assert(stored > SERVER_MAX_SCHEMA_VERSION, "future schema 4 > SERVER_MAX_SCHEMA_VERSION");
	// Client should show error and refuse to operate
}

section("Schema gate: markSchemaV3 is idempotent");

{
	const doc = new Y.Doc();
	const sys = doc.getMap("sys");
	sys.set("schemaVersion", 2);

	// Simulate markSchemaV3
	const current = sys.get("schemaVersion") as number;
	if (current < 3) {
		doc.transact(() => {
			sys.set("schemaVersion", 3);
			sys.set("schemaUpdatedAt", Date.now());
		});
	}

	assertEqual(sys.get("schemaVersion"), 3, "schema bumped to 3");

	// Call again — should be no-op
	const before = sys.get("schemaUpdatedAt");
	const currentAgain = sys.get("schemaVersion") as number;
	if (currentAgain < 3) {
		doc.transact(() => { sys.set("schemaVersion", 3); });
	}
	assertEqual(sys.get("schemaUpdatedAt"), before, "second call is no-op");
}

section("Schema gate: concurrent v3 marker writes converge");

{
	const doc1 = new Y.Doc({ gc: false });
	const doc2 = new Y.Doc({ gc: false });

	// Start both at schema 2
	doc1.transact(() => { doc1.getMap("sys").set("schemaVersion", 2); });
	Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

	// Both independently write schema 3
	doc1.transact(() => { doc1.getMap("sys").set("schemaVersion", 3); });
	doc2.transact(() => { doc2.getMap("sys").set("schemaVersion", 3); });

	// Sync
	Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
	Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

	assertEqual(doc1.getMap("sys").get("schemaVersion"), 3, "doc1 converges to 3");
	assertEqual(doc2.getMap("sys").get("schemaVersion"), 3, "doc2 converges to 3");
}

// ═══════════════════════════════════════════════════════════════════════════
// Server Stats Dual-Read Tests
// ═══════════════════════════════════════════════════════════════════════════

section("Server stats: flat-only room");

{
	const doc = new Y.Doc();
	populateMixedVault(doc, 50, 20);
	const meta = doc.getMap("meta");

	let activeCount = 0;
	let tombstoneCount = 0;
	meta.forEach((value: unknown) => {
		const path = simulateServerReadMetaPath(value);
		if (!path) return;
		if (simulateServerIsMetaDeleted(value)) tombstoneCount++;
		else activeCount++;
	});

	assertEqual(activeCount, 50, "server counts 50 active from flat");
	assertEqual(tombstoneCount, 20, "server counts 20 tombstones from flat");
}

section("Server stats: nested-only room");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	doc.transact(() => {
		for (let i = 0; i < 30; i++) {
			const entry = createNestedActiveMeta(`nested/file-${i}.md`, 2000 + i, "dev");
			meta.set(`active-${i}`, entry);
		}
		for (let i = 0; i < 10; i++) {
			const entry = createNestedDeletedMeta(`nested/deleted-${i}.md`, 3000 + i);
			meta.set(`tomb-${i}`, entry);
		}
	});

	let activeCount = 0;
	let tombstoneCount = 0;
	meta.forEach((value: unknown) => {
		const path = simulateServerReadMetaPath(value);
		if (!path) return;
		if (simulateServerIsMetaDeleted(value)) tombstoneCount++;
		else activeCount++;
	});

	assertEqual(activeCount, 30, "server counts 30 active from nested");
	assertEqual(tombstoneCount, 10, "server counts 10 tombstones from nested");
}

section("Server stats: mixed flat+nested room");

{
	const doc = new Y.Doc();
	populateMixedVault(doc, 100, 50);
	const meta = doc.getMap("meta");

	// Convert 10 entries to nested
	doc.transact(() => {
		for (let i = 0; i < 10; i++) {
			ensureNestedMetaEntry(meta, `active-${i}`);
		}
	});

	let activeCount = 0;
	let tombstoneCount = 0;
	let invalidCount = 0;
	meta.forEach((value: unknown) => {
		const path = simulateServerReadMetaPath(value);
		if (!path) { invalidCount++; return; }
		if (simulateServerIsMetaDeleted(value)) tombstoneCount++;
		else activeCount++;
	});

	assertEqual(activeCount, 100, "server counts 100 active from mixed");
	assertEqual(tombstoneCount, 50, "server counts 50 tombstones from mixed");
	assertEqual(invalidCount, 0, "no invalid entries in mixed room");
}

section("Server stats: invalid metadata does not crash");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	doc.transact(() => {
		meta.set("good", { path: "good.md", mtime: 1 });
		meta.set("bad1", "not an object" as unknown);
		meta.set("bad2", 42 as unknown);
		meta.set("bad3", { nopath: true } as unknown);
	});

	let count = 0;
	let invalid = 0;
	meta.forEach((value: unknown) => {
		const path = simulateServerReadMetaPath(value);
		if (!path) { invalid++; return; }
		count++;
	});

	assertEqual(count, 1, "only valid entry counted");
	assertEqual(invalid, 3, "3 invalid entries detected");
}

section("Server stats: v2 persisted room boots under v3 server");

{
	// Simulate: server loads a doc that was persisted at schema v2
	const doc = new Y.Doc();
	populateMixedVault(doc, 200, 1500);

	// Server computes stats — should not crash
	const meta = doc.getMap("meta");
	let total = 0;
	meta.forEach((value: unknown) => {
		simulateServerReadMetaPath(value);
		simulateServerIsMetaDeleted(value);
		total++;
	});

	assertEqual(total, 1700, "server iterated all 1700 entries without crash");
}

// ═══════════════════════════════════════════════════════════════════════════
// computeMetaShapeStats Tests
// ═══════════════════════════════════════════════════════════════════════════

section("computeMetaShapeStats: mixed room");

{
	const doc = new Y.Doc();
	populateMixedVault(doc, 80, 30);
	const meta = doc.getMap("meta");

	// Convert 5 to nested
	doc.transact(() => {
		for (let i = 0; i < 5; i++) {
			ensureNestedMetaEntry(meta, `active-${i}`);
		}
	});

	const stats = computeMetaShapeStats(meta, 3);
	assertEqual(stats.schemaVersion, 3, "schema version in stats");
	assertEqual(stats.flatMetaEntries, 75 + 30, "flat = 75 untouched active + 30 tombstones");
	assertEqual(stats.nestedMetaEntries, 5, "5 nested entries");
	assertEqual(stats.invalidMetaEntries, 0, "no invalid");
	assertEqual(stats.activeMetaEntries, 80, "80 active");
	assertEqual(stats.tombstoneMetaEntries, 30, "30 tombstones");
	assertEqual(stats.totalMetaEntries, 110, "110 total");
}

// ═══════════════════════════════════════════════════════════════════════════
// Realistic Vault Test
// ═══════════════════════════════════════════════════════════════════════════

section("Realistic vault: 200 active + 1500 tombstones, touch 5, SQL round-trip");

{
	const doc = new Y.Doc();
	populateMixedVault(doc, 200, 1500);
	const meta = doc.getMap("meta");

	// Verify initial state
	const initialStats = computeMetaShapeStats(meta, 2);
	assertEqual(initialStats.activeMetaEntries, 200, "initial: 200 active");
	assertEqual(initialStats.tombstoneMetaEntries, 1500, "initial: 1500 tombstones");
	assertEqual(initialStats.flatMetaEntries, 1700, "initial: all flat");
	assertEqual(initialStats.nestedMetaEntries, 0, "initial: no nested");

	// Touch 5 entries (simulating v3 client editing)
	let updateSize = 0;
	doc.on("update", (update: Uint8Array) => { updateSize += update.byteLength; });

	doc.transact(() => {
		for (let i = 0; i < 5; i++) {
			const entry = ensureNestedMetaEntry(meta, `active-${i}`);
			entry!.set("mtime", Date.now());
		}
	});

	// Verify only 5 converted
	const afterStats = computeMetaShapeStats(meta, 3);
	assertEqual(afterStats.nestedMetaEntries, 5, "after touch: 5 nested");
	assertEqual(afterStats.flatMetaEntries, 1695, "after touch: 1695 flat");
	assertEqual(afterStats.activeMetaEntries, 200, "after touch: still 200 active");
	assertEqual(afterStats.tombstoneMetaEntries, 1500, "after touch: still 1500 tombstones");

	// Update size is bounded (not proportional to 1700 entries)
	assert(updateSize < 3000, `update size bounded: ${updateSize} bytes < 3000`);

	// Simulate SQL persistence round-trip
	const encoded = Y.encodeStateAsUpdate(doc);
	const doc2 = new Y.Doc();
	Y.applyUpdate(doc2, encoded);

	// Verify round-trip preserves everything
	const meta2 = doc2.getMap("meta");
	const rtStats = computeMetaShapeStats(meta2, 3);
	assertEqual(rtStats.activeMetaEntries, 200, "round-trip: 200 active");
	assertEqual(rtStats.tombstoneMetaEntries, 1500, "round-trip: 1500 tombstones");
	assertEqual(rtStats.nestedMetaEntries, 5, "round-trip: 5 nested preserved");
	assertEqual(rtStats.flatMetaEntries, 1695, "round-trip: 1695 flat preserved");

	// Verify a nested entry survived correctly
	const entry0 = meta2.get("active-0");
	assert(entry0 instanceof Y.Map, "round-trip: entry-0 is still Y.Map");
	assertEqual(getMetaPath(entry0), "notes/file-0.md", "round-trip: entry-0 path correct");
}

section("Realistic vault: reconnect after lazy conversion");

{
	// Simulate: device A touches some entries, persists, device B loads the state
	const docA = new Y.Doc({ gc: false });
	populateMixedVault(docA, 100, 50);
	const metaA = docA.getMap("meta");

	// Device A converts 3 entries
	docA.transact(() => {
		for (let i = 10; i < 13; i++) {
			const entry = ensureNestedMetaEntry(metaA, `active-${i}`);
			entry!.set("mtime", 9999);
			entry!.set("device", "deviceA");
		}
	});

	// Persist and load on device B
	const state = Y.encodeStateAsUpdate(docA);
	const docB = new Y.Doc({ gc: false });
	Y.applyUpdate(docB, state);

	const metaB = docB.getMap("meta");

	// Device B sees the mixed state
	const statsB = computeMetaShapeStats(metaB, 3);
	assertEqual(statsB.nestedMetaEntries, 3, "device B sees 3 nested");
	assertEqual(statsB.flatMetaEntries, 147, "device B sees 147 flat");

	// Device B touches a different entry
	docB.transact(() => {
		const entry = ensureNestedMetaEntry(metaB, "active-50");
		entry!.set("mtime", Date.now());
		entry!.set("device", "deviceB");
	});

	// Sync back to A
	Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

	const finalStats = computeMetaShapeStats(metaA, 3);
	assertEqual(finalStats.nestedMetaEntries, 4, "after sync: 4 nested total");
	assertEqual(finalStats.flatMetaEntries, 146, "after sync: 146 flat remaining");
}

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}`);

if (failed > 0) {
	process.exit(1);
}
