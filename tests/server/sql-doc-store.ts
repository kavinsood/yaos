/**
 * Tests for SqlDocStore — validates CRUD, compaction, size limits, and the
 * cold-start path of a room that has never been written to.
 */

import { SqlDocStore } from "../../server/src/sqlDocStore";
import * as Y from "yjs";
import { suite } from "../harness.ts";
import { FakeDurableObjectStorage } from "../mocks/sqlStorage";


// ── Test helpers ────────────────────────────────────────────────────────────

const s = suite("sql-doc-store");

function makeDoc(fileCount: number): Y.Doc {
	const doc = new Y.Doc();
	const meta = doc.getMap("meta");
	for (let i = 0; i < fileCount; i++) {
		meta.set(`file-${i}`, { path: `notes/file-${i}.md`, mtime: Date.now() });
	}
	return doc;
}

// ── Tests ───────────────────────────────────────────────────────────────────

s.section("Test 1: empty state");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage);
	const state = store.loadState();
	s.check(state.snapshot === null, "no snapshot");
	s.check(state.journalUpdates.length === 0, "no journal entries");
	s.check(state.journalStats.entryCount === 0, "entry count is 0");
	s.check(state.journalStats.totalBytes === 0, "total bytes is 0");
}

s.section("Test 2: append and load");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage);

	const doc = makeDoc(10);
	const update = Y.encodeStateAsUpdate(doc);
	const stats = store.appendUpdate(update);
	s.check(stats !== null, "append succeeds");
	s.check(stats!.entryCount === 1, `entry count is 1 (got ${stats!.entryCount})`);
	s.check(stats!.totalBytes === update.byteLength, "total bytes matches");

	// Load and verify
	const state = store.loadState();
	s.check(state.snapshot === null, "no snapshot yet");
	s.check(state.journalUpdates.length === 1, "one journal entry");

	// Apply to a new doc and check content
	const doc2 = new Y.Doc();
	Y.applyUpdate(doc2, state.journalUpdates[0]!);
	const meta2 = doc2.getMap("meta");
	s.check(meta2.size === 10, `loaded doc has 10 entries (got ${meta2.size})`);
	doc.destroy();
	doc2.destroy();
}

s.section("Test 3: rewriteCheckpoint clears journal");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage);

	const doc = makeDoc(50);
	// Append some entries
	for (let i = 0; i < 5; i++) {
		doc.getMap("meta").set(`extra-${i}`, { path: `extra-${i}.md`, mtime: Date.now() });
		store.appendUpdate(Y.encodeStateAsUpdate(doc));
	}
	const beforeStats = store.getJournalStats();
	s.check(beforeStats.entryCount === 5, `5 journal entries before compact (got ${beforeStats.entryCount})`);

	// Compact
	const fullUpdate = Y.encodeStateAsUpdate(doc);
	store.rewriteCheckpoint(fullUpdate);

	const afterStats = store.getJournalStats();
	s.check(afterStats.entryCount === 0, "journal cleared after checkpoint");
	s.check(afterStats.totalBytes === 0, "journal bytes cleared");

	// Load and verify snapshot exists
	const state = store.loadState();
	s.check(state.snapshot !== null, "snapshot exists after checkpoint");
	s.check(state.journalUpdates.length === 0, "no journal after checkpoint");

	// Verify content round-trips
	const doc2 = new Y.Doc();
	Y.applyUpdate(doc2, state.snapshot!);
	const meta2 = doc2.getMap("meta");
	s.check(meta2.size === 55, `checkpoint has all 55 entries (got ${meta2.size})`);
	doc.destroy();
	doc2.destroy();
}

s.section("Test 4: snapshot chunking for large docs");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage);

	// Create a doc large enough to need multiple chunks (>1MB)
	const doc = new Y.Doc();
	const text = doc.getText("bigfile");
	// ~1.5MB of text content
	const bigContent = "x".repeat(1_500_000);
	text.insert(0, bigContent);

	const fullUpdate = Y.encodeStateAsUpdate(doc);
	s.check(fullUpdate.byteLength > 1_000_000, `encoded doc is >1MB (got ${fullUpdate.byteLength})`);

	store.rewriteCheckpoint(fullUpdate);
	const state = store.loadState();
	s.check(state.snapshot !== null, "snapshot loaded");
	s.check(state.snapshot!.byteLength === fullUpdate.byteLength, "snapshot round-trips exactly");

	// Verify content
	const doc2 = new Y.Doc();
	Y.applyUpdate(doc2, state.snapshot!);
	s.check(doc2.getText("bigfile").toString().length === 1_500_000, "content preserved");
	doc.destroy();
	doc2.destroy();
}


s.section("Test 6: snapshot + journal replay produces correct state");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage);

	// Write initial checkpoint
	const doc = makeDoc(100);
	store.rewriteCheckpoint(Y.encodeStateAsUpdate(doc));

	// Append additional changes as journal entries
	doc.getMap("meta").set("new-file", { path: "new.md", mtime: Date.now() });
	const delta = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc));
	// Use full update relative to checkpoint for the delta
	const fullAfter = Y.encodeStateAsUpdate(doc);
	store.appendUpdate(fullAfter);

	// Load and replay
	const state = store.loadState();
	const doc2 = new Y.Doc();
	if (state.snapshot) Y.applyUpdate(doc2, state.snapshot);
	for (const u of state.journalUpdates) Y.applyUpdate(doc2, u);

	const meta2 = doc2.getMap("meta");
	s.check(meta2.has("new-file"), "journal delta applied correctly");
	s.check(meta2.size === 101, `final state has 101 entries (got ${meta2.size})`);
	doc.destroy();
	doc2.destroy();
}

s.section("Test 7: empty store loads as empty, then a first checkpoint round-trips");
{
	// A room nobody has written to must load as "no snapshot" rather than as an
	// empty-but-present one, and the first checkpoint written over that empty
	// state must be readable in full.

	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage);

	// Verify empty
	const emptyState = store.loadState();
	s.check(emptyState.snapshot === null, "a never-written store loads with no snapshot");

	const seedDoc = makeDoc(200);
	store.rewriteCheckpoint(Y.encodeStateAsUpdate(seedDoc));

	const seededState = store.loadState();
	s.check(seededState.snapshot !== null, "snapshot exists after the first checkpoint");
	s.check(seededState.journalUpdates.length === 0, "no journal after a checkpoint");

	const doc2 = new Y.Doc();
	Y.applyUpdate(doc2, seededState.snapshot!);
	const meta2 = doc2.getMap("meta");
	s.check(meta2.size === 200, `checkpointed doc has 200 entries (got ${meta2.size})`);
	seedDoc.destroy();
	doc2.destroy();
}

s.section("Test 8: snapshot size mismatch fails loudly");
{
	const storage = new FakeDurableObjectStorage();
	// FakeDurableObjectStorage structurally implements the subset of the DO
	// storage surface SqlDocStore uses; the worker-types interface is private.
	const store = new SqlDocStore(
		storage,
	);

	const doc = makeDoc(20);
	store.rewriteCheckpoint(Y.encodeStateAsUpdate(doc));

	// A snapshot buffer sized from a wrong total would silently truncate the
	// Y.Doc update, which Yjs would then fail to decode or — worse — decode
	// partially.  loadState must refuse to return a buffer it could not fill
	// exactly, in either direction.
	storage.sql.snapshotTotalBias = -1;
	let shortMessage = "";
	try {
		store.loadState();
	} catch (err) {
		shortMessage = err instanceof Error ? err.message : String(err);
	}
	s.check(
		shortMessage.includes("size mismatch"),
		`under-reported total throws (got ${shortMessage || "no throw"})`,
	);

	storage.sql.snapshotTotalBias = 1;
	let longMessage = "";
	try {
		store.loadState();
	} catch (err) {
		longMessage = err instanceof Error ? err.message : String(err);
	}
	s.check(
		longMessage.includes("size mismatch"),
		`over-reported total throws (got ${longMessage || "no throw"})`,
	);

	doc.destroy();
}

s.section("Test 9: journal stats never drift from storage");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(
		storage,
	);

	// getJournalStats() is now answered from in-memory counters.  They are the
	// only source of truth callers see, so the one thing that must never happen
	// is drift from the table — check against a full scan after every mutation.
	let drifts = 0;
	const checkAgainstStorage = (label: string): void => {
		const stats = store.getJournalStats();
		const truth = storage.sql.journalTruth();
		if (stats.entryCount !== truth.entryCount || stats.totalBytes !== truth.totalBytes) {
			drifts++;
			console.log(
				`    drift at ${label}: reported ${stats.entryCount}/${stats.totalBytes}, `
				+ `storage has ${truth.entryCount}/${truth.totalBytes}`,
			);
		}
	};

	checkAgainstStorage("cold instance");

	// A realistic cycle: appends of varying size, a mid-cycle load, a
	// zero-length update, and a compaction that empties the journal.
	for (let i = 1; i <= 25; i++) {
		store.appendUpdate(new Uint8Array(i * 7 + 1));
		checkAgainstStorage(`append ${i}`);

		if (i === 8) {
			store.appendUpdate(new Uint8Array(0));
			checkAgainstStorage("zero-length append");
		}
		if (i === 12) {
			store.loadState();
			checkAgainstStorage("after loadState");
		}
		if (i === 18) {
			store.rewriteCheckpoint(Y.encodeStateAsUpdate(makeDoc(5)));
			checkAgainstStorage("after rewriteCheckpoint");
		}
	}

	s.check(drifts === 0, `in-memory stats match a full scan at every step (${drifts} drifts)`);

	const finalStats = store.getJournalStats();
	s.check(finalStats.entryCount === 7, `7 entries survive the compaction (got ${finalStats.entryCount})`);
}

s.section("Test 10: getJournalStats is O(1)");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(
		storage,
	);

	const APPENDS = 60;
	// Before the fix, appendUpdate and the explicit call each ran a COUNT/SUM
	// over the whole journal, so the Nth save touched 2N rows.
	const preChangeRows = APPENDS * (APPENDS + 1);

	storage.sql.rowsRead = 0;
	storage.sql.journalRowsScanned = 0;
	for (let i = 0; i < APPENDS; i++) {
		store.appendUpdate(new Uint8Array(64));
		store.getJournalStats();
	}

	s.check(
		storage.sql.journalRowsScanned <= 4,
		`${APPENDS} save cycles touch ≤4 journal rows (got ${storage.sql.journalRowsScanned}; `
		+ `pre-change cost was ${preChangeRows} rows read)`,
	);
	s.check(
		storage.sql.rowsRead <= 4,
		`${APPENDS} save cycles issue ≤4 rows of SELECT output (got ${storage.sql.rowsRead})`,
	);
	s.check(
		store.getJournalStats().entryCount === APPENDS,
		"the O(1) path still reports the true entry count",
	);
}

s.section("Test 11: oversized update leaves stats untouched");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(
		storage,
	);

	store.appendUpdate(new Uint8Array(100));
	store.appendUpdate(new Uint8Array(250));
	const before = store.getJournalStats();

	// Over MAX_JOURNAL_ENTRY_BYTES (1.5MB): rejected without an INSERT, so the
	// counters must not move — otherwise every oversized paste would inflate
	// them permanently and force spurious compactions.
	const rejected = store.appendUpdate(new Uint8Array(2 * 1024 * 1024));
	s.check(rejected === null, "oversized append still returns null");

	const after = store.getJournalStats();
	s.check(
		after.entryCount === before.entryCount && after.totalBytes === before.totalBytes,
		`stats unchanged by rejected append (${after.entryCount}/${after.totalBytes})`,
	);
	const truth = storage.sql.journalTruth();
	s.check(
		after.entryCount === truth.entryCount && after.totalBytes === truth.totalBytes,
		"stats still match storage after a rejected append",
	);
}

s.section("Test 12: rewriteCheckpoint resets the counters");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(
		storage,
	);

	for (let i = 0; i < 5; i++) store.appendUpdate(new Uint8Array(128));
	store.rewriteCheckpoint(Y.encodeStateAsUpdate(makeDoc(3)));

	const cleared = store.getJournalStats();
	s.check(cleared.entryCount === 0, `entryCount zeroed by checkpoint (got ${cleared.entryCount})`);
	s.check(cleared.totalBytes === 0, `totalBytes zeroed by checkpoint (got ${cleared.totalBytes})`);

	const next = store.appendUpdate(new Uint8Array(42));
	s.check(next?.entryCount === 1, `first post-checkpoint append reports 1 entry (got ${next?.entryCount})`);
	s.check(next?.totalBytes === 42, `first post-checkpoint append reports 42 bytes (got ${next?.totalBytes})`);
}

s.section("Test 13: stats seed lazily from an existing journal");
{
	const storage = new FakeDurableObjectStorage();
	storage.sql.seedJournalRows([10, 20, 30]);
	const store = new SqlDocStore(
		storage,
	);

	// A fresh instance over a warm journal (the cold-start case) must not
	// report zero just because it has not loaded yet.
	storage.sql.journalRowsScanned = 0;
	const seeded = store.getJournalStats();
	s.check(seeded.entryCount === 3, `seeded entryCount from storage (got ${seeded.entryCount})`);
	s.check(seeded.totalBytes === 60, `seeded totalBytes from storage (got ${seeded.totalBytes})`);

	const afterFirstCall = storage.sql.journalRowsScanned;
	store.getJournalStats();
	store.getJournalStats();
	s.check(
		storage.sql.journalRowsScanned === afterFirstCall,
		`seed scan runs at most once per instance (${afterFirstCall} rows, then ${storage.sql.journalRowsScanned})`,
	);

	const grown = store.appendUpdate(new Uint8Array(5));
	s.check(grown?.entryCount === 4 && grown?.totalBytes === 65, `append builds on the seed (got ${grown?.entryCount}/${grown?.totalBytes})`);
}

s.section("Test 9: coalesceJournal collapses entries without changing state");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(
		storage,
	);

	const doc = makeDoc(5);
	store.rewriteCheckpoint(Y.encodeStateAsUpdate(doc));

	// Twelve incremental deltas, exactly as the save path would produce them.
	let sv = Y.encodeStateVector(doc);
	for (let i = 0; i < 12; i++) {
		doc.getMap("meta").set(`extra-${i}`, { path: `extra-${i}.md`, mtime: i });
		store.appendUpdate(Y.encodeStateAsUpdate(doc, sv));
		sv = Y.encodeStateVector(doc);
	}
	s.check(store.getJournalStats().entryCount === 12, `12 entries before coalesce (got ${store.getJournalStats().entryCount})`);

	// Replay the pre-coalesce state so the two can be compared byte for byte.
	const before = store.loadState();
	const beforeDoc = new Y.Doc();
	if (before.snapshot) Y.applyUpdate(beforeDoc, before.snapshot);
	for (const u of before.journalUpdates) Y.applyUpdate(beforeDoc, u);

	const result = store.coalesceJournal();
	s.check(result.status === "ok", `coalesce succeeded (got ${result.status})`);
	s.check(result.stats.entryCount === 1, `journal collapsed to one row (got ${result.stats.entryCount})`);
	s.check(store.getJournalStats().entryCount === 1, "cached counters follow the collapse");
	s.check(store.getJournalStats().totalBytes === result.stats.totalBytes, "cached bytes follow the collapse");

	const after = store.loadState();
	const afterDoc = new Y.Doc();
	if (after.snapshot) Y.applyUpdate(afterDoc, after.snapshot);
	for (const u of after.journalUpdates) Y.applyUpdate(afterDoc, u);

	s.check(
		Buffer.from(Y.encodeStateVector(afterDoc)).toString("hex")
			=== Buffer.from(Y.encodeStateVector(beforeDoc)).toString("hex"),
		"state vector identical across coalesce",
	);
	s.check(afterDoc.getMap("meta").size === beforeDoc.getMap("meta").size, "same entry count in replayed doc");
	s.check(afterDoc.getMap("meta").has("extra-11"), "last delta survives the coalesce");

	doc.destroy(); beforeDoc.destroy(); afterDoc.destroy();
}

s.section("Test 10: coalesceJournal is a no-op below two entries");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(
		storage,
	);
	s.check(store.coalesceJournal().status === "noop", "empty journal coalesces to noop");

	const doc = makeDoc(2);
	store.appendUpdate(Y.encodeStateAsUpdate(doc));
	s.check(store.coalesceJournal().status === "noop", "single entry coalesces to noop");
	doc.destroy();
}

s.section("Test 11: snapshot size is tracked for the compaction trigger");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(
		storage,
	);
	s.check(store.getSnapshotBytes() === 0, "unknown before anything is written");

	const doc = makeDoc(40);
	const update = Y.encodeStateAsUpdate(doc);
	store.rewriteCheckpoint(update);
	s.check(store.getSnapshotBytes() === update.byteLength, `checkpoint sets snapshot bytes (got ${store.getSnapshotBytes()})`);

	// A fresh instance over the same storage must recover it from the load.
	const reopened = new SqlDocStore(
		storage,
	);
	reopened.loadState();
	s.check(reopened.getSnapshotBytes() === update.byteLength, `load recovers snapshot bytes (got ${reopened.getSnapshotBytes()})`);
	doc.destroy();
}

s.section("Test 12: loadState returns journal rows unmerged");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(
		storage,
	);
	const doc = makeDoc(3);
	store.rewriteCheckpoint(Y.encodeStateAsUpdate(doc));
	let sv = Y.encodeStateVector(doc);
	for (let i = 0; i < 6; i++) {
		doc.getMap("meta").set(`n-${i}`, { path: `n-${i}.md`, mtime: i });
		store.appendUpdate(Y.encodeStateAsUpdate(doc, sv));
		sv = Y.encodeStateVector(doc);
	}

	const state = store.loadState();
	// loadState returns rows verbatim: merging on read costs more than it saves
	// (143ms to save 10ms at 4,000 rows).  Coalescing at write time is what keeps
	// this list short in practice.
	s.check(state.journalUpdates.length === 6, `rows returned unmerged (got ${state.journalUpdates.length})`);
	s.check(state.journalStats.entryCount === 6, `journalStats reports six rows (got ${state.journalStats.entryCount})`);

	const replay = new Y.Doc();
	if (state.snapshot) Y.applyUpdate(replay, state.snapshot);
	for (const u of state.journalUpdates) Y.applyUpdate(replay, u);
	s.check(replay.getMap("meta").size === doc.getMap("meta").size, "replay reproduces the document");
	s.check(replay.getMap("meta").has("n-5"), "last delta present after replay");
	doc.destroy(); replay.destroy();
}
await s.done();
