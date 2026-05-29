/**
 * Tests for src/sync/fileMeta.ts — validates dual-shape decoding,
 * type guards, read helpers, write helpers, lazy conversion, and
 * semantic diff computation.
 */

import * as Y from "yjs";
import {
	decodeFileMeta,
	isNestedFileMeta,
	isObjectRecord,
	isFileMetaDeletedValue,
	getMetaPath,
	getMetaMtime,
	getMetaDevice,
	getMetaDeletedAt,
	createNestedActiveMeta,
	createNestedDeletedMeta,
	createNestedMetaFromDecoded,
	ensureNestedMetaEntry,
	buildMetaSnapshot,
	computeMetaSemanticChanges,
	type DecodedFileMeta,
} from "../src/sync/fileMeta";

// ── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		passed++;
	} else {
		failed++;
		console.error(`  FAIL: ${msg}`);
	}
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
	if (actual === expected) {
		passed++;
	} else {
		failed++;
		console.error(`  FAIL: ${msg} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
	}
}

function assertNull(actual: unknown, msg: string): void {
	if (actual === null) {
		passed++;
	} else {
		failed++;
		console.error(`  FAIL: ${msg} — expected null, got ${JSON.stringify(actual)}`);
	}
}

function section(name: string): void {
	console.log(`\n── ${name} ──`);
}

// ── Type Guard Tests ────────────────────────────────────────────────────────

section("Type guards");

{
	const ymap = new Y.Map();
	assert(isNestedFileMeta(ymap), "Y.Map is nested");
	assert(!isNestedFileMeta({ path: "a.md" }), "plain object is not nested");
	assert(!isNestedFileMeta(null), "null is not nested");
	assert(!isNestedFileMeta(42), "number is not nested");

	assert(isObjectRecord({ path: "a.md" }), "plain object is record");
	assert(!isObjectRecord(ymap), "Y.Map is not record");
	assert(!isObjectRecord(null), "null is not record");
	assert(!isObjectRecord("string"), "string is not record");
}

// ── Decoder: flat active ────────────────────────────────────────────────────

section("Decoder: flat active");

{
	const result = decodeFileMeta({ path: "notes/foo.md", mtime: 1000, device: "macbook" });
	assert(result !== null, "decodes flat active");
	assertEqual(result!.shape, "flat", "shape is flat");
	assertEqual(result!.path, "notes/foo.md", "path decoded");
	assertEqual(result!.mtime, 1000, "mtime decoded");
	assertEqual(result!.device, "macbook", "device decoded");
	assertEqual(result!.deletedAt, undefined, "deletedAt absent");
	assertEqual(result!.deleted, undefined, "deleted absent");
}

// ── Decoder: flat tombstone with deletedAt ──────────────────────────────────

section("Decoder: flat tombstone with deletedAt");

{
	const result = decodeFileMeta({ path: "old.md", deletedAt: 5000 });
	assert(result !== null, "decodes flat tombstone");
	assertEqual(result!.shape, "flat", "shape is flat");
	assertEqual(result!.path, "old.md", "path decoded");
	assertEqual(result!.deletedAt, 5000, "deletedAt decoded");
	assertEqual(result!.mtime, undefined, "mtime absent");
}

// ── Decoder: legacy flat tombstone with deleted: true ────────────────────────

section("Decoder: legacy flat tombstone");

{
	const result = decodeFileMeta({ path: "legacy.md", deleted: true });
	assert(result !== null, "decodes legacy tombstone");
	assertEqual(result!.deleted, true, "deleted flag decoded");
	assertEqual(result!.deletedAt, undefined, "deletedAt not present");
}

// ── Decoder: nested active ──────────────────────────────────────────────────

section("Decoder: nested active");

{
	const doc = new Y.Doc();
	const container = doc.getMap("test");
	const ymap = new Y.Map<unknown>();
	container.set("entry", ymap);
	ymap.set("path", "nested/file.md");
	ymap.set("mtime", 2000);
	ymap.set("device", "phone");

	const result = decodeFileMeta(ymap);
	assert(result !== null, "decodes nested active");
	assertEqual(result!.shape, "nested", "shape is nested");
	assertEqual(result!.path, "nested/file.md", "path decoded");
	assertEqual(result!.mtime, 2000, "mtime decoded");
	assertEqual(result!.device, "phone", "device decoded");
	assertEqual(result!.deletedAt, undefined, "deletedAt absent");
}

// ── Decoder: nested tombstone ───────────────────────────────────────────────

section("Decoder: nested tombstone");

{
	const doc = new Y.Doc();
	const container = doc.getMap("test");
	const ymap = new Y.Map<unknown>();
	container.set("entry", ymap);
	ymap.set("path", "deleted.md");
	ymap.set("deletedAt", 9999);

	const result = decodeFileMeta(ymap);
	assert(result !== null, "decodes nested tombstone");
	assertEqual(result!.shape, "nested", "shape is nested");
	assertEqual(result!.path, "deleted.md", "path decoded");
	assertEqual(result!.deletedAt, 9999, "deletedAt decoded");
	assertEqual(result!.mtime, undefined, "mtime absent on tombstone");
}

// ── Decoder: invalid inputs ─────────────────────────────────────────────────

section("Decoder: invalid inputs");

{
	assertNull(decodeFileMeta(null), "null returns null");
	assertNull(decodeFileMeta(undefined), "undefined returns null");
	assertNull(decodeFileMeta(42), "number returns null");
	assertNull(decodeFileMeta("string"), "string returns null");
	assertNull(decodeFileMeta({}), "empty object returns null (no path)");
	assertNull(decodeFileMeta({ path: "" }), "empty path returns null");
	assertNull(decodeFileMeta({ path: 123 }), "non-string path returns null");

	const invalidDoc = new Y.Doc();
	const invalidContainer = invalidDoc.getMap("test");

	const emptyMap = new Y.Map<unknown>();
	invalidContainer.set("empty", emptyMap);
	assertNull(decodeFileMeta(emptyMap), "Y.Map without path returns null");

	const badPathMap = new Y.Map<unknown>();
	invalidContainer.set("bad", badPathMap);
	badPathMap.set("path", "");
	assertNull(decodeFileMeta(badPathMap), "Y.Map with empty path returns null");

	const nanMtime = decodeFileMeta({ path: "x.md", mtime: NaN });
	assert(nanMtime !== null, "NaN mtime still decodes");
	assertEqual(nanMtime!.mtime, undefined, "NaN mtime treated as absent");

	const nanDeletedAt = decodeFileMeta({ path: "x.md", deletedAt: NaN });
	assert(nanDeletedAt !== null, "NaN deletedAt still decodes");
	assertEqual(nanDeletedAt!.deletedAt, undefined, "NaN deletedAt treated as absent");

	const infMtime = decodeFileMeta({ path: "x.md", mtime: Infinity });
	assertEqual(infMtime!.mtime, undefined, "Infinity mtime treated as absent");
}

// ── Read helpers ────────────────────────────────────────────────────────────

section("Read helpers");

{
	// Flat
	assertEqual(getMetaPath({ path: "a.md" }), "a.md", "getMetaPath flat");
	assertEqual(getMetaMtime({ path: "a.md", mtime: 100 }), 100, "getMetaMtime flat");
	assertEqual(getMetaDevice({ path: "a.md", device: "dev" }), "dev", "getMetaDevice flat");
	assertEqual(getMetaDeletedAt({ path: "a.md", deletedAt: 500 }), 500, "getMetaDeletedAt flat");
	assertNull(getMetaPath(null), "getMetaPath null input");
	assertNull(getMetaMtime({ path: "a.md" }), "getMetaMtime absent");

	// Nested
	const readDoc = new Y.Doc();
	const readContainer = readDoc.getMap("test");
	const ymap = new Y.Map<unknown>();
	readContainer.set("entry", ymap);
	ymap.set("path", "b.md");
	ymap.set("mtime", 200);
	ymap.set("device", "tablet");
	ymap.set("deletedAt", 300);

	assertEqual(getMetaPath(ymap), "b.md", "getMetaPath nested");
	assertEqual(getMetaMtime(ymap), 200, "getMetaMtime nested");
	assertEqual(getMetaDevice(ymap), "tablet", "getMetaDevice nested");
	assertEqual(getMetaDeletedAt(ymap), 300, "getMetaDeletedAt nested");
}

// ── isFileMetaDeletedValue ──────────────────────────────────────────────────

section("isFileMetaDeletedValue");

{
	assert(isFileMetaDeletedValue({ path: "a.md", deletedAt: 100 }), "flat deletedAt is deleted");
	assert(isFileMetaDeletedValue({ path: "a.md", deleted: true }), "flat deleted:true is deleted");
	assert(!isFileMetaDeletedValue({ path: "a.md", mtime: 1 }), "flat active is not deleted");
	assert(!isFileMetaDeletedValue({ path: "a.md" }), "flat minimal active not deleted");
	assert(!isFileMetaDeletedValue(null), "null not deleted");

	const delDoc = new Y.Doc();
	const delContainer = delDoc.getMap("test");

	const deletedMap = new Y.Map<unknown>();
	delContainer.set("deleted", deletedMap);
	deletedMap.set("path", "d.md");
	deletedMap.set("deletedAt", 999);
	assert(isFileMetaDeletedValue(deletedMap), "nested deletedAt is deleted");

	const activeMap = new Y.Map<unknown>();
	delContainer.set("active", activeMap);
	activeMap.set("path", "a.md");
	activeMap.set("mtime", 1);
	assert(!isFileMetaDeletedValue(activeMap), "nested active not deleted");

	const legacyMap = new Y.Map<unknown>();
	delContainer.set("legacy", legacyMap);
	legacyMap.set("path", "l.md");
	legacyMap.set("deleted", true);
	assert(isFileMetaDeletedValue(legacyMap), "nested legacy deleted:true is deleted");
}

// ── Write helpers ───────────────────────────────────────────────────────────

section("Write helpers: createNestedActiveMeta");

{
	const doc = new Y.Doc();
	const container = doc.getMap("test");

	const entry = createNestedActiveMeta("notes/hello.md", 5000, "laptop");
	container.set("e1", entry);
	assert(entry instanceof Y.Map, "returns Y.Map");
	assertEqual(entry.get("path"), "notes/hello.md", "path set");
	assertEqual(entry.get("mtime"), 5000, "mtime set");
	assertEqual(entry.get("device"), "laptop", "device set");
	assertEqual(entry.get("deletedAt"), undefined, "deletedAt absent");
	assertEqual(entry.get("deleted"), undefined, "deleted absent");

	const noDevice = createNestedActiveMeta("x.md", 1000);
	container.set("e2", noDevice);
	assertEqual(noDevice.get("device"), undefined, "device omitted when undefined");
}

section("Write helpers: createNestedDeletedMeta");

{
	const doc = new Y.Doc();
	const container = doc.getMap("test");

	const entry = createNestedDeletedMeta("trash/old.md", 8000);
	container.set("e1", entry);
	assert(entry instanceof Y.Map, "returns Y.Map");
	assertEqual(entry.get("path"), "trash/old.md", "path set");
	assertEqual(entry.get("deletedAt"), 8000, "deletedAt set");
	assertEqual(entry.get("mtime"), undefined, "mtime absent on tombstone");
	assertEqual(entry.get("device"), undefined, "device absent on tombstone");
}

section("Write helpers: createNestedMetaFromDecoded");

{
	const doc = new Y.Doc();
	const container = doc.getMap("test");

	// Active decoded
	const active = createNestedMetaFromDecoded({
		shape: "flat",
		path: "conv.md",
		mtime: 3000,
		device: "desktop",
	});
	container.set("active", active);
	assertEqual(active.get("path"), "conv.md", "converted active path");
	assertEqual(active.get("mtime"), 3000, "converted active mtime");
	assertEqual(active.get("device"), "desktop", "converted active device");
	assertEqual(active.get("deletedAt"), undefined, "converted active no deletedAt");

	// Tombstone decoded
	const tombstone = createNestedMetaFromDecoded({
		shape: "flat",
		path: "dead.md",
		deletedAt: 7000,
	});
	container.set("tombstone", tombstone);
	assertEqual(tombstone.get("path"), "dead.md", "converted tombstone path");
	assertEqual(tombstone.get("deletedAt"), 7000, "converted tombstone deletedAt");
	assertEqual(tombstone.get("mtime"), undefined, "converted tombstone no mtime");
	assertEqual(tombstone.get("device"), undefined, "converted tombstone no device");

	// Legacy deleted:true
	const legacy = createNestedMetaFromDecoded({
		shape: "flat",
		path: "legacy.md",
		deleted: true,
	});
	container.set("legacy", legacy);
	assert(typeof legacy.get("deletedAt") === "number", "legacy deleted:true gets deletedAt timestamp");
	assertEqual(legacy.get("mtime"), undefined, "legacy no mtime");
}

// ── Lazy conversion: ensureNestedMetaEntry ──────────────────────────────────

section("ensureNestedMetaEntry");

{
	const doc = new Y.Doc();
	const metaMap = doc.getMap("meta");

	// Case 1: already nested
	const existing = new Y.Map<unknown>();
	existing.set("path", "already.md");
	existing.set("mtime", 100);
	metaMap.set("id1", existing);

	const result1 = ensureNestedMetaEntry(metaMap, "id1");
	assert(result1 === existing, "returns existing nested map directly");

	// Case 2: flat entry gets converted
	metaMap.set("id2", { path: "flat.md", mtime: 200, device: "dev" } as unknown);

	const result2 = ensureNestedMetaEntry(metaMap, "id2");
	assert(result2 instanceof Y.Map, "converts flat to nested");
	assertEqual(result2!.get("path"), "flat.md", "converted path preserved");
	assertEqual(result2!.get("mtime"), 200, "converted mtime preserved");
	assertEqual(result2!.get("device"), "dev", "converted device preserved");
	// Verify it was actually replaced in the map
	assert(metaMap.get("id2") instanceof Y.Map, "meta map entry replaced with nested");

	// Case 3: missing entry with fallback
	const result3 = ensureNestedMetaEntry(metaMap, "id3", {
		shape: "flat",
		path: "fallback.md",
		mtime: 300,
	});
	assert(result3 instanceof Y.Map, "creates from fallback");
	assertEqual(result3!.get("path"), "fallback.md", "fallback path");

	// Case 4: missing entry without fallback
	const result4 = ensureNestedMetaEntry(metaMap, "id4");
	assertNull(result4, "returns null without fallback");

	// Case 5: untouched flat entries remain flat
	metaMap.set("id5", { path: "untouched.md", mtime: 500 } as unknown);
	// Don't call ensureNestedMetaEntry on id5
	const raw = metaMap.get("id5");
	assert(!(raw instanceof Y.Map), "untouched entry remains flat");
}

// ── Semantic diff computation ───────────────────────────────────────────────

section("computeMetaSemanticChanges");

{
	const prev = new Map<string, DecodedFileMeta>();
	prev.set("a", { shape: "flat", path: "a.md", mtime: 1 });
	prev.set("b", { shape: "flat", path: "b.md", mtime: 1 });
	prev.set("c", { shape: "flat", path: "c.md", deletedAt: 100 });
	prev.set("d", { shape: "flat", path: "d.md", mtime: 1 });

	const curr = new Map<string, DecodedFileMeta>();
	curr.set("a", { shape: "nested", path: "a-renamed.md", mtime: 1 }); // path changed
	curr.set("b", { shape: "nested", path: "b.md", mtime: 2 }); // mtime changed
	curr.set("c", { shape: "nested", path: "c.md", mtime: 5 }); // revived
	curr.set("e", { shape: "nested", path: "e.md", mtime: 1 }); // added
	// d removed

	const changes = computeMetaSemanticChanges(prev, curr);

	const kinds = changes.map(c => c.kind);
	assert(kinds.includes("removed"), "d was removed");
	assert(kinds.includes("added"), "e was added");
	assert(kinds.includes("path-changed"), "a path changed");
	assert(kinds.includes("mtime-changed"), "b mtime changed");
	assert(kinds.includes("revived"), "c revived");

	const removed = changes.find(c => c.kind === "removed");
	assertEqual((removed as any).fileId, "d", "removed fileId is d");

	const added = changes.find(c => c.kind === "added");
	assertEqual((added as any).fileId, "e", "added fileId is e");

	const pathChanged = changes.find(c => c.kind === "path-changed");
	assertEqual((pathChanged as any).previousPath, "a.md", "previous path");
	assertEqual((pathChanged as any).nextPath, "a-renamed.md", "next path");
}

// ── buildMetaSnapshot ───────────────────────────────────────────────────────

section("buildMetaSnapshot");

{
	const doc = new Y.Doc();
	const metaMap = doc.getMap("meta");

	// Mixed shapes
	metaMap.set("flat1", { path: "flat1.md", mtime: 10 } as unknown);

	const nested1 = new Y.Map<unknown>();
	nested1.set("path", "nested1.md");
	nested1.set("mtime", 20);
	metaMap.set("nested1", nested1);

	metaMap.set("invalid", "not an object" as unknown);

	const snapshot = buildMetaSnapshot(metaMap);
	assertEqual(snapshot.size, 2, "invalid entry excluded");
	assertEqual(snapshot.get("flat1")?.path, "flat1.md", "flat decoded");
	assertEqual(snapshot.get("nested1")?.path, "nested1.md", "nested decoded");
	assertEqual(snapshot.get("flat1")?.shape, "flat", "flat shape");
	assertEqual(snapshot.get("nested1")?.shape, "nested", "nested shape");
}

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}`);

if (failed > 0) {
	process.exit(1);
}
