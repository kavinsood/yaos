/**
 * Tests for usesLegacyPathModel(), the rule that decides whether `pathToId`
 * still authorises path -> fileId resolution.
 *
 * Getting this wrong is silent rather than loud, and it has already produced two
 * distinct wrong answers on a real vault:
 *
 *   - The tombstone reaper treated a `pathToId` reference as proof a file was
 *     live, and pinned 14 of 46 tombstoned bodies that could never be reclaimed.
 *   - getDocumentSummary() resolved its consistency counters through `pathToId`
 *     and reported a healthy 92-file vault as `activePathsWithText: 0`.
 *
 * Both consulted a map that the v2 migration froze: under the id-first model the
 * client resolves from `meta` alone and stops writing `pathToId`, so surviving
 * entries point into the pre-migration fileId space forever.
 *
 * These tests pin the rule itself and reproduce the exact vault shape that
 * produced the misleading numbers.
 */

import * as Y from "yjs";
import { usesLegacyPathModel, ID_FIRST_PATH_MODEL_MIN_SCHEMA } from "../../server/src/schemaModel";
import { reapTombstonedBodies } from "../../server/src/tombstoneReaper";
import {
	asMapLike,
	buildDocumentSummary,
	isMetaDeleted,
	readMetaDeletedAt,
	readMetaPath,
} from "../../server/src/documentSummary";
import { suite } from "../harness.ts";

const s = suite("schema-path-model");

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function docWithSchema(version: unknown): Y.Doc {
	const doc = new Y.Doc();
	if (version !== undefined) {
		doc.transact(() => { doc.getMap("sys").set("schemaVersion", version); });
	}
	return doc;
}

// ---------------------------------------------------------------------------

s.section("Test 1: the rule itself");
{
	s.check(ID_FIRST_PATH_MODEL_MIN_SCHEMA === 2, "id-first begins at schema 2");

	s.check(usesLegacyPathModel(docWithSchema(undefined)) === true, "absent schemaVersion => legacy");
	s.check(usesLegacyPathModel(docWithSchema(1)) === true, "schema 1 => legacy");
	s.check(usesLegacyPathModel(docWithSchema(2)) === false, "schema 2 => id-first");
	s.check(usesLegacyPathModel(docWithSchema(3)) === false, "schema 3 => id-first");
	s.check(usesLegacyPathModel(docWithSchema(99)) === false, "future schema => id-first");

	// Unreadable values must resolve to legacy, the conservative answer: it keeps
	// pathToId authoritative so callers veto rather than act on a document whose
	// model they cannot establish.
	s.check(usesLegacyPathModel(docWithSchema("2")) === true, "string schemaVersion => legacy (unreadable)");
	s.check(usesLegacyPathModel(docWithSchema(null)) === true, "null schemaVersion => legacy");
	s.check(usesLegacyPathModel(docWithSchema(Number.NaN)) === true, "NaN schemaVersion => legacy");
}

s.section("Test 2: a migrated vault's frozen pathToId does not pin bodies");
{
	// The exact shape that misled the reaper: schema 2, tombstones whose paths
	// still appear in the legacy map, pointing at pre-migration fileIds.
	const doc = new Y.Doc();
	const idToText = doc.getMap<Y.Text>("idToText");
	const meta = doc.getMap("meta");
	const pathToId = doc.getMap<string>("pathToId");
	doc.transact(() => {
		doc.getMap("sys").set("schemaVersion", 2);
		for (let i = 0; i < 4; i++) {
			const t = new Y.Text();
			idToText.set(`new-${i}`, t);
			t.insert(0, "x".repeat(10_000));
			meta.set(`new-${i}`, { path: `n${i}.md`, deletedAt: NOW - 60 * DAY });
			// Frozen legacy entry: same PATH, but a dead pre-migration fileId.
			pathToId.set(`n${i}.md`, `old-${i}`);
		}
	});

	const result = reapTombstonedBodies(doc, { now: NOW });
	s.check(result.conflicted === 0, `no false conflicts under id-first (got ${result.conflicted})`);
	s.check(result.reaped === 4, `all four bodies reclaimed (got ${result.reaped})`);
	s.check(result.charsFreed === 40_000, `chars freed reported (got ${result.charsFreed})`);
	for (let i = 0; i < 4; i++) {
		s.check(!idToText.has(`new-${i}`), `body ${i} gone`);
		s.check(meta.has(`new-${i}`), `tombstone ${i} preserved`);
	}
	doc.destroy();
}

s.section("Test 3: under the legacy model pathToId still vetoes");
{
	const doc = new Y.Doc();
	const idToText = doc.getMap<Y.Text>("idToText");
	const meta = doc.getMap("meta");
	doc.transact(() => {
		// No schemaVersion at all: legacy.
		const t = new Y.Text();
		idToText.set("f", t);
		t.insert(0, "y".repeat(5_000));
		meta.set("f", { path: "f.md", deletedAt: NOW - 60 * DAY });
		doc.getMap<string>("pathToId").set("f.md", "f");
	});

	const result = reapTombstonedBodies(doc, { now: NOW });
	s.check(result.conflicted === 1, `legacy pathToId vetoes (conflicted=${result.conflicted})`);
	s.check(result.reaped === 0, "nothing reclaimed while the legacy map authorises the id");
	s.check(idToText.has("f"), "body preserved");
	doc.destroy();
}

s.section("Test 4: the reaper and the summary agree on the model");
{
	// Both call sites must derive the model from the same helper.  If they ever
	// diverge, one of them acts on a map the other considers dead, which is how
	// a vault ends up with unreclaimable bodies AND nonsense counters.
	for (const version of [undefined, 1, 2, 3]) {
		const doc = docWithSchema(version);
		const expectLegacy = version === undefined || version === 1;
		s.check(
			usesLegacyPathModel(doc) === expectLegacy,
			`schema ${String(version)}: single source of truth returns ${expectLegacy ? "legacy" : "id-first"}`,
		);
		doc.destroy();
	}
}

s.section("Test 5: the real vault's numbers, before and after");
{
	// Reproduces the shape that produced the misleading report: schema 2, 92
	// active files each with a body, 46 tombstones each still holding a body
	// (nothing past the grace window yet), and 82 frozen pathToId entries left
	// by the v1->v2 migration pointing at dead pre-migration fileIds.
	const doc = new Y.Doc();
	const idToText = doc.getMap<Y.Text>("idToText");
	const meta = doc.getMap("meta");
	const pathToId = doc.getMap<string>("pathToId");
	doc.transact(() => {
		doc.getMap("sys").set("schemaVersion", 2);
		for (let i = 0; i < 92; i++) {
			const id = `live-${i}`;
			const t = new Y.Text();
			idToText.set(id, t);
			t.insert(0, "content");
			meta.set(id, { path: `a${i}.md`, mtime: 1 });
		}
		for (let i = 0; i < 46; i++) {
			const id = `dead-${i}`;
			const t = new Y.Text();
			idToText.set(id, t);
			t.insert(0, "old content");
			meta.set(id, { path: `d${i}.md`, deletedAt: 1 });
		}
		// 61 stale entries on live paths + 21 on paths with no active meta = 82.
		for (let i = 0; i < 61; i++) pathToId.set(`a${i}.md`, `premigration-${i}`);
		for (let i = 0; i < 21; i++) pathToId.set(`gone${i}.md`, `premigration-x${i}`);
	});

	const summary = buildDocumentSummary(doc);

	s.check(summary.pathModel === "id-first", `model reported (got ${summary.pathModel})`);
	s.check(summary.activePathCount === 92, `activePathCount 92 (got ${summary.activePathCount})`);
	s.check(summary.tombstonedPathCount === 46, `tombstonedPathCount 46 (got ${summary.tombstonedPathCount})`);
	s.check(summary.metaCount === 138 && summary.idToTextCount === 138, "metaCount and idToTextCount both 138");
	s.check(summary.pathToIdCount === 82, `pathToIdCount 82 (got ${summary.pathToIdCount})`);

	// The fix: every active file resolves to its own body via the metadata key.
	s.check(summary.activePathsWithText === 92, `all 92 active files have text (got ${summary.activePathsWithText})`);
	s.check(summary.activePathsMissingText === 0, `none missing text (got ${summary.activePathsMissingText})`);
	s.check(
		summary.activePathsMissingFromPathToId === 0,
		`pathToId is not consulted under id-first (got ${summary.activePathsMissingFromPathToId})`,
	);
	// Stale residue is still reported, but now interpretable via pathModel.
	s.check(
		summary.pathToIdWithoutActiveMeta === 21,
		`frozen pathToId residue still visible (got ${summary.pathToIdWithoutActiveMeta})`,
	);
	s.check(summary.flatMetaEntries === 138 && summary.nestedMetaEntries === 0, "all metadata still flat (v2)");
	s.check(summary.invalidMetaEntries === 0, "no invalid entries");

	// And the old rule, reproduced by declaring the same document legacy, gives
	// back exactly the numbers that were reported from production.
	doc.transact(() => { doc.getMap("sys").set("schemaVersion", 1); });
	const legacy = buildDocumentSummary(doc);
	s.check(legacy.pathModel === "legacy", "same document, legacy model");
	s.check(legacy.activePathsWithText === 0, `legacy rule reproduces activePathsWithText 0 (got ${legacy.activePathsWithText})`);
	s.check(
		legacy.activePathsMissingFromPathToId === 31,
		`legacy rule reproduces 31 missing-from-pathToId (got ${legacy.activePathsMissingFromPathToId})`,
	);
	s.check(
		legacy.activePathsMissingText === 61,
		`legacy rule reproduces 61 missing-text (got ${legacy.activePathsMissingText})`,
	);
	s.check(
		legacy.activePathsMissingFromPathToId + legacy.activePathsMissingText + legacy.activePathsWithText === 92,
		"the three counters still partition activePathCount",
	);
	doc.destroy();
}

s.section("Test 6: nested (v3) metadata is classified without instanceof");
{
	const doc = new Y.Doc();
	doc.transact(() => {
		doc.getMap("sys").set("schemaVersion", 3);
		const t = new Y.Text();
		doc.getMap<Y.Text>("idToText").set("n1", t);
		t.insert(0, "body");
		const entry = new Y.Map();
		entry.set("path", "n.md");
		entry.set("mtime", 1);
		doc.getMap("meta").set("n1", entry);

		const tombText = new Y.Text();
		doc.getMap<Y.Text>("idToText").set("n2", tombText);
		tombText.insert(0, "old");
		const tomb = new Y.Map();
		tomb.set("path", "t.md");
		tomb.set("deletedAt", 5);
		doc.getMap("meta").set("n2", tomb);
	});

	const summary = buildDocumentSummary(doc);
	s.check(summary.nestedMetaEntries === 2, `both entries seen as nested (got ${summary.nestedMetaEntries})`);
	s.check(summary.flatMetaEntries === 0, "none misclassified as flat");
	s.check(summary.activePathCount === 1, `one active (got ${summary.activePathCount})`);
	s.check(summary.tombstonedPathCount === 1, `one tombstoned (got ${summary.tombstonedPathCount})`);
	s.check(summary.activePathsWithText === 1, `nested active file resolves to its body (got ${summary.activePathsWithText})`);
	doc.destroy();
}

s.section("Test 7: unreadable metadata is counted, not silently dropped");
{
	const doc = new Y.Doc();
	doc.transact(() => {
		doc.getMap("sys").set("schemaVersion", 2);
		doc.getMap("meta").set("bad", { mtime: 1 });        // no path
		doc.getMap("meta").set("worse", "not-an-object");
	});
	const summary = buildDocumentSummary(doc);
	s.check(summary.invalidMetaEntries === 2, `both invalid entries counted (got ${summary.invalidMetaEntries})`);
	s.check(summary.activePathCount === 0 && summary.tombstonedPathCount === 0,
		"invalid entries are in neither active nor tombstoned");
	s.check(summary.metaCount === 2, "raw metaCount still reports them");
	doc.destroy();
}

s.section("Test 8: metadata readers accept map values from another Yjs copy");
{
	const values: Record<string, unknown> = {
		path: "foreign.md",
		deletedAt: NOW - 60 * DAY,
	};
	const foreignMap = {
		get: (key: string) => values[key],
	};
	s.check(asMapLike(foreignMap) === foreignMap, "duck typing accepts a foreign map-like value");
	s.check(readMetaPath(foreignMap) === "foreign.md", "foreign map path is readable");
	s.check(readMetaDeletedAt(foreignMap) === values.deletedAt, "foreign map deletion timestamp is readable");
	s.check(isMetaDeleted(foreignMap), "foreign map tombstone is recognised");
	s.check(readMetaDeletedAt({ deletedAt: Number.NaN }) === null, "non-finite deletion age remains unknown");
}
await s.done();
