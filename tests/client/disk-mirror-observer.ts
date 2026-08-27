/**
 * FU-14 — DiskMirror observer wiring test (Phase 1.6b).
 *
 * Phase 1.6 proved the recovery amplifier class is guarded at the Yjs/origin
 * layer using a simulated decision function. This test drives the actual
 * DiskMirror text observer and afterTransaction handler to prove the WIRING:
 *
 *   recovery-origin transaction → observer fires → isLocalOrigin gate → SKIP
 *   provider-origin transaction  → observer fires → isLocalOrigin gate → scheduleWrite
 *
 * Two observer paths are tested:
 *
 *   A. afterTransaction handler — fires for every transaction on the Y.Doc.
 *      Handles CLOSED files: not open in Obsidian, no per-file text observer.
 *      Gate: `if (isLocalOrigin(txn.origin, provider)) return;`
 *
 *   B. Per-file text observer — attached via observeText() when a file is opened.
 *      Gate: `if (isLocalOrigin(txn.origin, provider)) return;`
 *
 * Both paths gate on the same predicate. This test proves neither path schedules
 * a write for recovery origins, and both paths do schedule for provider origin.
 *
 * SCOPE — what this test does NOT cover (FU-14 still partially open):
 *   - ReconciliationController choosing disk as the only authority
 *   - EditorBinding repair() vs heal() path selection
 *   - flushWriteUnlocked() actual disk I/O
 *   - Suppression fingerprint behavior
 *   - Debounce timer drain and write queue flush
 *
 * Obsidian dependency: the regression runner redirects "obsidian" to
 * tests/mocks/obsidian.ts through its programmatic Jiti bootstrap.
 */

import * as Y from "yjs";
import type { App } from "obsidian";
import { DiskMirror } from "../../src/sync/diskMirror";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { partialOf } from "../mocks/productFixture.ts";
import {
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
	ORIGIN_EDITOR_HEALTH_HEAL,
	ORIGIN_RESTORE,
	ORIGIN_SEED,
} from "../../src/sync/origins";
import {
	buildMetaSnapshot,
	extractAffectedFileIds,
	computeIncrementalMetaChanges,
	isFileMetaDeletedValue,
	type MetaChangeBatch,
} from "../../src/sync/fileMeta";
import { isLocalOrigin } from "../../src/sync/origins";
import { suite } from "../harness.ts";

const s = suite("disk-mirror-observer");

// ── Harness ───────────────────────────────────────────────────────────────────

const FILE_PATH = "notes/test.md";
const FILE_ID = "file-001";

function makeHarness() {
	const doc = new Y.Doc();
	const meta = doc.getMap<{ path: string; deleted?: boolean }>("meta");
	const ytext = doc.getText("content");
	// Only ever compared by identity (isLocalOrigin) and used as a transaction
	// origin, so `roomname` carries the marker purely to name it in a debugger.
	const fakeProvider = partialOf<VaultSync["provider"]>({ roomname: "fake-provider" });

	// Seed meta so afterTxnHandler can resolve fileId → path
	doc.transact(() => {
		meta.set(FILE_ID, { path: FILE_PATH, deleted: false });
	});

	const fakeVaultSync = partialOf<VaultSync>({
		provider: fakeProvider,
		ydoc: doc,
		meta,
		getTextForPath: (path: string) => (path === FILE_PATH ? ytext : null),
		// `undefined`, not `null`: that is what VaultSync.getFileIdForText returns
		// on a miss, and DiskMirror's caller tests it for truthiness either way.
		getFileIdForText: (text: Y.Text) => (text === ytext ? FILE_ID : undefined),
		idToText: { entries: () => new Map([[FILE_ID, ytext]]).entries() },
		isFileMetaDeleted: (m: unknown) => isFileMetaDeletedValue(m),
		// The harness uses the production-style deep semantic observer so nested
		// Y.Map field mutations reach DiskMirror through the same dual-read path.
		observeMetaChanges: (() => {
			let snapshot = buildMetaSnapshot(meta as Y.Map<unknown>);
			const listeners = new Set<(batch: MetaChangeBatch) => void>();
			(meta as Y.Map<unknown>).observeDeep((events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
				const origin = events[0]?.transaction.origin;
				const isLocal = isLocalOrigin(origin, fakeProvider);
				const affected = extractAffectedFileIds(events, meta as Y.Map<unknown>);
				if (!affected) return;
				const changes = computeIncrementalMetaChanges(snapshot, meta as Y.Map<unknown>, affected);
				if (changes.length === 0) return;
				const batch: MetaChangeBatch = { origin, isLocal, changes };
				for (const listener of listeners) listener(batch);
			});
			return (cb: (batch: MetaChangeBatch) => void) => {
				listeners.add(cb);
				return () => { listeners.delete(cb); };
			};
		})(),
	});

	const fakeEditorBindings = partialOf<EditorBindingManager>({
		getLastEditorActivityForPath: () => null,
	});

	const fakeApp = partialOf<App>({
		workspace: { getActiveViewOfType: () => null },
	});

	const mirror = new DiskMirror(fakeApp, fakeVaultSync, fakeEditorBindings, false);

	return { doc, ytext, fakeProvider, meta, mirror };
}

// Private-field accessors — DiskMirror internals are not exposed publicly.
// Element access reaches a private member without a cast, and unlike a cast it
// is checked: the field must exist and its real type is what comes back.
function debounceTimerCount(m: DiskMirror): number {
	return m["debounceTimers"].size;
}
function pendingOpenWriteCount(m: DiskMirror): number {
	return m["pendingOpenWrites"].size;
}
function writeQueueSize(m: DiskMirror): number {
	return m["writeQueue"].size;
}
function clearTimers(m: DiskMirror): void {
	for (const t of m["debounceTimers"].values()) clearTimeout(t);
	m["debounceTimers"].clear();
	for (const t of m["openWriteTimers"].values()) clearTimeout(t);
	m["openWriteTimers"].clear();
	m["pendingOpenWrites"].clear();
}

// ── Test 1: afterTransaction (closed file) — recovery origins skip write ──────

s.section("Test 1: afterTransaction — recovery origins do not schedule write (closed file)");
{
	const { doc, ytext, mirror } = makeHarness();
	mirror.startMapObservers();

	const recoveryOrigins = [
		ORIGIN_DISK_SYNC,
		ORIGIN_DISK_SYNC_RECOVER_BOUND,
		ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
		ORIGIN_EDITOR_HEALTH_HEAL,
		ORIGIN_RESTORE,
		ORIGIN_SEED,
	];

	for (const origin of recoveryOrigins) {
		// Insert then delete to leave content unchanged; both use the recovery origin
		doc.transact(() => { ytext.insert(0, "x"); }, origin);
		doc.transact(() => { ytext.delete(0, 1); }, origin);

		s.check(
			debounceTimerCount(mirror) === 0,
			`"${origin}" → afterTxn: no debounce timer set (closed file, write skipped)`,
		);
	}

	s.check(writeQueueSize(mirror) === 0, "writeQueue empty after all recovery origins");
	doc.destroy();
}

// ── Test 2: afterTransaction (closed file) — provider origin schedules write ──

s.section("Test 2: afterTransaction — provider (remote) origin schedules write (closed file)");
{
	const { doc, ytext, fakeProvider, mirror } = makeHarness();
	mirror.startMapObservers();

	doc.transact(() => { ytext.insert(0, "remote content"); }, fakeProvider);

	s.check(
		debounceTimerCount(mirror) === 1,
		"provider origin → afterTxn: debounce timer set (write will be scheduled)",
	);
	s.check(writeQueueSize(mirror) === 0, "write still debouncing — not yet in writeQueue");

	clearTimers(mirror);
	doc.destroy();
}

// ── Test 3: per-file text observer (open file) — recovery origins skip write ──

s.section("Test 3: per-file text observer — recovery origins do not schedule write (open file)");
{
	const { doc, ytext, mirror } = makeHarness();
	mirror.notifyFileOpened(FILE_PATH);

	const recoveryOrigins = [ORIGIN_DISK_SYNC_RECOVER_BOUND, ORIGIN_DISK_SYNC, ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER];

	for (const origin of recoveryOrigins) {
		doc.transact(() => { ytext.insert(0, "x"); }, origin);
		doc.transact(() => { ytext.delete(0, 1); }, origin);

		s.check(
			pendingOpenWriteCount(mirror) === 0,
			`"${origin}" → text observer: no pending open write (open file, write skipped)`,
		);
	}

	clearTimers(mirror);
	doc.destroy();
}

// ── Test 4: per-file text observer (open file) — provider origin schedules ────

s.section("Test 4: per-file text observer — provider origin schedules write (open file)");
{
	const { doc, ytext, fakeProvider, mirror } = makeHarness();
	mirror.notifyFileOpened(FILE_PATH);

	doc.transact(() => { ytext.insert(0, "remote content"); }, fakeProvider);

	s.check(
		pendingOpenWriteCount(mirror) === 1,
		"provider origin → text observer: pending open write scheduled (open file)",
	);

	clearTimers(mirror);
	doc.destroy();
}

// ── Test 5: mixed cycle — recovery then remote — only remote triggers write ───

s.section("Test 5: mixed cycle — recovery then provider — only provider triggers write");
{
	const { doc, ytext, fakeProvider, mirror } = makeHarness();
	mirror.startMapObservers();

	// Recovery pass — simulates disk reconciliation
	doc.transact(() => { ytext.insert(0, "reconciled disk content"); }, ORIGIN_DISK_SYNC_RECOVER_BOUND);

	s.check(debounceTimerCount(mirror) === 0, "after recovery pass: no debounce timer");
	s.check(writeQueueSize(mirror) === 0, "after recovery pass: writeQueue empty");

	// Second recovery pass is no-op (same content) — no write
	doc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, "reconciled disk content"); }, ORIGIN_DISK_SYNC_RECOVER_BOUND);

	s.check(debounceTimerCount(mirror) === 0, "after second recovery pass: still no debounce timer");

	// Remote update from another device — this SHOULD schedule a write
	doc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, "update from another device"); }, fakeProvider);

	s.check(debounceTimerCount(mirror) === 1, "after provider update: debounce timer set");

	clearTimers(mirror);
	doc.destroy();
}
await s.done();
