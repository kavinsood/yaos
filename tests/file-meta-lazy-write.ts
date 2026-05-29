/**
 * Tests for lazy on-write conversion behavior.
 *
 * Validates that:
 * - New writes always produce nested Y.Maps
 * - Only touched flat entries get converted
 * - Untouched entries remain flat
 * - No full-vault migration storm occurs
 * - Concurrent lazy conversion converges
 */

import * as Y from "yjs";
import {
	ensureNestedMetaEntry,
	createNestedActiveMeta,
	createNestedDeletedMeta,
	decodeFileMeta,
	isNestedFileMeta,
	isFileMetaDeletedValue,
} from "../src/sync/fileMeta";

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

// ── Helper: populate a doc with N flat metadata entries ──────────────────────

function populateFlat(doc: Y.Doc, count: number): void {
	const meta = doc.getMap("meta");
	doc.transact(() => {
		for (let i = 0; i < count; i++) {
			meta.set(`file-${i}`, { path: `notes/file-${i}.md`, mtime: 1000 + i, device: "dev" });
		}
	});
}

// ── Test: new active write creates nested map ───────────────────────────────

section("New active write creates nested map");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	const entry = createNestedActiveMeta("new-file.md", Date.now(), "laptop");
	meta.set("new-id", entry);

	assert(meta.get("new-id") instanceof Y.Map, "new entry is nested Y.Map");
	const nested = meta.get("new-id") as Y.Map<unknown>;
	assertEqual(nested.get("path"), "new-file.md", "path correct");
}

// ── Test: new tombstone write creates nested map ────────────────────────────

section("New tombstone write creates nested map");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	const entry = createNestedDeletedMeta("deleted.md", 5000);
	meta.set("tomb-id", entry);

	assert(meta.get("tomb-id") instanceof Y.Map, "tombstone is nested Y.Map");
	const nested = meta.get("tomb-id") as Y.Map<unknown>;
	assertEqual(nested.get("deletedAt"), 5000, "deletedAt correct");
}

// ── Test: active write converts ONLY the touched flat entry ─────────────────

section("Active write converts only touched flat entry");

{
	const doc = new Y.Doc();
	populateFlat(doc, 100);
	const meta = doc.getMap("meta");

	// Touch only file-5
	doc.transact(() => {
		const entry = ensureNestedMetaEntry(meta, "file-5");
		assert(entry !== null, "entry returned");
		entry!.set("mtime", Date.now());
	});

	// file-5 should be nested
	assert(meta.get("file-5") instanceof Y.Map, "touched entry is now nested");

	// All others should remain flat
	let flatCount = 0;
	let nestedCount = 0;
	meta.forEach((value: unknown, key: string) => {
		if (key === "file-5") return;
		if (value instanceof Y.Map) nestedCount++;
		else flatCount++;
	});

	assertEqual(flatCount, 99, "99 entries remain flat");
	assertEqual(nestedCount, 0, "no other entries converted");
}

// ── Test: untouched flat entries remain flat after multiple writes ───────────

section("Untouched flat entries remain flat");

{
	const doc = new Y.Doc();
	populateFlat(doc, 50);
	const meta = doc.getMap("meta");

	// Touch files 0, 1, 2 only
	doc.transact(() => {
		for (let i = 0; i < 3; i++) {
			const entry = ensureNestedMetaEntry(meta, `file-${i}`);
			entry!.set("mtime", Date.now());
		}
	});

	let flatCount = 0;
	meta.forEach((value: unknown, key: string) => {
		if (!key.startsWith("file-")) return;
		if (!(value instanceof Y.Map)) flatCount++;
	});

	assertEqual(flatCount, 47, "47 untouched entries remain flat");
}

// ── Test: delete write converts only touched flat entry ─────────────────────

section("Delete write converts only touched entry");

{
	const doc = new Y.Doc();
	populateFlat(doc, 20);
	const meta = doc.getMap("meta");

	doc.transact(() => {
		const entry = ensureNestedMetaEntry(meta, "file-10");
		entry!.set("deletedAt", Date.now());
		entry!.delete("mtime");
		entry!.delete("device");
	});

	assert(meta.get("file-10") instanceof Y.Map, "deleted entry is nested");
	assert(isFileMetaDeletedValue(meta.get("file-10")), "entry is tombstoned");

	// Others remain flat
	let flatCount = 0;
	meta.forEach((value: unknown, key: string) => {
		if (key === "file-10") return;
		if (!(value instanceof Y.Map)) flatCount++;
	});
	assertEqual(flatCount, 19, "19 entries remain flat");
}

// ── Test: revive write clears deletedAt ─────────────────────────────────────

section("Revive write clears deletedAt");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	// Start with a nested tombstone
	const tombstone = createNestedDeletedMeta("revived.md", 3000);
	meta.set("revive-id", tombstone);

	assert(isFileMetaDeletedValue(meta.get("revive-id")), "starts as deleted");

	// Revive it
	doc.transact(() => {
		const entry = ensureNestedMetaEntry(meta, "revive-id");
		entry!.delete("deletedAt");
		entry!.delete("deleted");
		entry!.set("mtime", Date.now());
		entry!.set("device", "laptop");
	});

	assert(!isFileMetaDeletedValue(meta.get("revive-id")), "no longer deleted");
	const revived = meta.get("revive-id") as Y.Map<unknown>;
	assertEqual(revived.get("path"), "revived.md", "path preserved");
	assertEqual(revived.get("deletedAt"), undefined, "deletedAt cleared");
}

// ── Test: tombstone write removes mtime and device ──────────────────────────

section("Tombstone write removes mtime and device");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	const active = createNestedActiveMeta("to-delete.md", 1000, "phone");
	meta.set("del-id", active);

	doc.transact(() => {
		const entry = meta.get("del-id") as Y.Map<unknown>;
		entry.set("deletedAt", Date.now());
		entry.delete("mtime");
		entry.delete("device");
	});

	const result = meta.get("del-id") as Y.Map<unknown>;
	assertEqual(result.get("mtime"), undefined, "mtime removed");
	assertEqual(result.get("device"), undefined, "device removed");
	assert(typeof result.get("deletedAt") === "number", "deletedAt set");
}

// ── Test: no keys set to undefined ──────────────────────────────────────────

section("No keys set to undefined");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");

	const entry = createNestedActiveMeta("clean.md", 1000);
	meta.set("clean-id", entry);

	// Verify the nested map has no undefined values
	const nested = meta.get("clean-id") as Y.Map<unknown>;
	const keys: string[] = [];
	nested.forEach((_val: unknown, key: string) => { keys.push(key); });

	// Should only have path and mtime (no device since undefined was passed)
	assertEqual(keys.length, 2, "only path and mtime keys present");
	assert(keys.includes("path"), "has path");
	assert(keys.includes("mtime"), "has mtime");
}

// ── Test: repeated active writes are idempotent ─────────────────────────────

section("Repeated active writes idempotent");

{
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");
	populateFlat(doc, 5);

	// Convert file-0 twice
	doc.transact(() => {
		const e1 = ensureNestedMetaEntry(meta, "file-0");
		e1!.set("mtime", 2000);
	});
	doc.transact(() => {
		const e2 = ensureNestedMetaEntry(meta, "file-0");
		e2!.set("mtime", 3000);
	});

	const final = meta.get("file-0") as Y.Map<unknown>;
	assertEqual(final.get("mtime"), 3000, "last write wins");
	assertEqual(final.get("path"), "notes/file-0.md", "path preserved");
}

// ── Test: no full-vault migration storm ─────────────────────────────────────

section("No full-vault migration storm (200 entries, touch 5)");

{
	const doc = new Y.Doc();
	populateFlat(doc, 200);
	const meta = doc.getMap("meta");

	// Measure update size from touching 5 entries
	let updateSize = 0;
	doc.on("update", (update: Uint8Array) => {
		updateSize += update.byteLength;
	});

	doc.transact(() => {
		for (let i = 0; i < 5; i++) {
			const entry = ensureNestedMetaEntry(meta, `file-${i}`);
			entry!.set("mtime", Date.now());
		}
	});

	// The update should be small (proportional to 5 entries, not 200)
	assert(updateSize < 2000, `update size bounded: ${updateSize} bytes (expected < 2000)`);

	// Verify counts
	let nestedCount = 0;
	let flatCount = 0;
	meta.forEach((value: unknown) => {
		if (value instanceof Y.Map) nestedCount++;
		else flatCount++;
	});

	assertEqual(nestedCount, 5, "only 5 entries converted");
	assertEqual(flatCount, 195, "195 entries remain flat");
}

// ── Test: concurrent lazy conversion converges ──────────────────────────────

section("Concurrent lazy conversion converges");

{
	// Two docs syncing — both touch the same flat entry
	const doc1 = new Y.Doc({ gc: false });
	const doc2 = new Y.Doc({ gc: false });

	// Start with same flat state
	populateFlat(doc1, 10);
	const state = Y.encodeStateAsUpdate(doc1);
	Y.applyUpdate(doc2, state);

	// doc1 converts file-3 with mtime=1000
	doc1.transact(() => {
		const meta1 = doc1.getMap("meta");
		const entry = ensureNestedMetaEntry(meta1, "file-3");
		entry!.set("mtime", 1000);
		entry!.set("device", "doc1");
	});

	// doc2 converts file-3 with mtime=2000
	doc2.transact(() => {
		const meta2 = doc2.getMap("meta");
		const entry = ensureNestedMetaEntry(meta2, "file-3");
		entry!.set("mtime", 2000);
		entry!.set("device", "doc2");
	});

	// Sync both ways
	Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
	Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

	// Both should have the same final state
	const meta1 = doc1.getMap("meta");
	const meta2 = doc2.getMap("meta");

	const entry1 = meta1.get("file-3") as Y.Map<unknown>;
	const entry2 = meta2.get("file-3") as Y.Map<unknown>;

	assert(entry1 instanceof Y.Map, "doc1 file-3 is nested");
	assert(entry2 instanceof Y.Map, "doc2 file-3 is nested");
	assertEqual(entry1.get("path"), entry2.get("path"), "paths converge");
	assertEqual(entry1.get("mtime"), entry2.get("mtime"), "mtime converges (LWW)");
	assertEqual(entry1.get("device"), entry2.get("device"), "device converges (LWW)");

	// Untouched entries should still be flat in both
	assert(!(meta1.get("file-7") instanceof Y.Map), "doc1 untouched still flat");
	assert(!(meta2.get("file-7") instanceof Y.Map), "doc2 untouched still flat");
}

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}`);

if (failed > 0) {
	process.exit(1);
}
