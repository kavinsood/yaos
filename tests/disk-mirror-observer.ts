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
 * Obsidian dependency: this test uses JITI_ALIAS to redirect "obsidian" to
 * tests/mocks/obsidian.ts. The mock provides normalizePath (identity) and
 * stub classes for MarkdownView/TFile. Tests run under node --import jiti/register.
 */

import * as Y from "yjs";
import { DiskMirror } from "../src/sync/diskMirror";
import {
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
	ORIGIN_EDITOR_HEALTH_HEAL,
	ORIGIN_RESTORE,
	ORIGIN_SEED,
} from "../src/sync/origins";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

// ── Harness ───────────────────────────────────────────────────────────────────

const FILE_PATH = "notes/test.md";
const FILE_ID = "file-001";

function makeHarness() {
	const doc = new Y.Doc();
	const meta = doc.getMap<{ path: string; deleted?: boolean }>("meta");
	const ytext = doc.getText("content");
	const fakeProvider = { __kind: "fake-provider" };

	// Seed meta so afterTxnHandler can resolve fileId → path
	doc.transact(() => {
		meta.set(FILE_ID, { path: FILE_PATH, deleted: false });
	});

	const fakeVaultSync = {
		provider: fakeProvider,
		ydoc: doc,
		meta,
		getTextForPath: (path: string) => (path === FILE_PATH ? ytext : null),
		getFileIdForText: (text: Y.Text) => (text === ytext ? FILE_ID : null),
		idToText: { entries: () => new Map([[FILE_ID, ytext]]).entries() },
		isFileMetaDeleted: (m: { deleted?: boolean } | undefined) => Boolean(m?.deleted),
	};

	const fakeEditorBindings = {
		getLastEditorActivityForPath: () => null,
	};

	const fakeApp = {
		workspace: { getActiveViewOfType: () => null },
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mirror = new DiskMirror(fakeApp as any, fakeVaultSync as any, fakeEditorBindings as any, false);

	return { doc, ytext, fakeProvider, meta, mirror };
}

// Private-field accessors — DiskMirror internals are not exposed publicly
function debounceTimerCount(m: DiskMirror): number {
	return (m as unknown as { debounceTimers: Map<unknown, unknown> }).debounceTimers.size;
}
function pendingOpenWriteCount(m: DiskMirror): number {
	return (m as unknown as { pendingOpenWrites: Set<unknown> }).pendingOpenWrites.size;
}
function writeQueueSize(m: DiskMirror): number {
	return (m as unknown as { writeQueue: Set<unknown> }).writeQueue.size;
}
function clearTimers(m: DiskMirror): void {
	const dm = m as unknown as {
		debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
		openWriteTimers: Map<string, ReturnType<typeof setTimeout>>;
		pendingOpenWrites: Set<string>;
	};
	for (const t of dm.debounceTimers.values()) clearTimeout(t);
	dm.debounceTimers.clear();
	for (const t of dm.openWriteTimers.values()) clearTimeout(t);
	dm.openWriteTimers.clear();
	dm.pendingOpenWrites.clear();
}

// ── Test 1: afterTransaction (closed file) — recovery origins skip write ──────

console.log("\n--- Test 1: afterTransaction — recovery origins do not schedule write (closed file) ---");
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

		assert(
			debounceTimerCount(mirror) === 0,
			`"${origin}" → afterTxn: no debounce timer set (closed file, write skipped)`,
		);
	}

	assert(writeQueueSize(mirror) === 0, "writeQueue empty after all recovery origins");
	doc.destroy();
}

// ── Test 2: afterTransaction (closed file) — provider origin schedules write ──

console.log("\n--- Test 2: afterTransaction — provider (remote) origin schedules write (closed file) ---");
{
	const { doc, ytext, fakeProvider, mirror } = makeHarness();
	mirror.startMapObservers();

	doc.transact(() => { ytext.insert(0, "remote content"); }, fakeProvider);

	assert(
		debounceTimerCount(mirror) === 1,
		"provider origin → afterTxn: debounce timer set (write will be scheduled)",
	);
	assert(writeQueueSize(mirror) === 0, "write still debouncing — not yet in writeQueue");

	clearTimers(mirror);
	doc.destroy();
}

// ── Test 3: per-file text observer (open file) — recovery origins skip write ──

console.log("\n--- Test 3: per-file text observer — recovery origins do not schedule write (open file) ---");
{
	const { doc, ytext, mirror } = makeHarness();
	mirror.notifyFileOpened(FILE_PATH);

	const recoveryOrigins = [ORIGIN_DISK_SYNC_RECOVER_BOUND, ORIGIN_DISK_SYNC, ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER];

	for (const origin of recoveryOrigins) {
		doc.transact(() => { ytext.insert(0, "x"); }, origin);
		doc.transact(() => { ytext.delete(0, 1); }, origin);

		assert(
			pendingOpenWriteCount(mirror) === 0,
			`"${origin}" → text observer: no pending open write (open file, write skipped)`,
		);
	}

	clearTimers(mirror);
	doc.destroy();
}

// ── Test 4: per-file text observer (open file) — provider origin schedules ────

console.log("\n--- Test 4: per-file text observer — provider origin schedules write (open file) ---");
{
	const { doc, ytext, fakeProvider, mirror } = makeHarness();
	mirror.notifyFileOpened(FILE_PATH);

	doc.transact(() => { ytext.insert(0, "remote content"); }, fakeProvider);

	assert(
		pendingOpenWriteCount(mirror) === 1,
		"provider origin → text observer: pending open write scheduled (open file)",
	);

	clearTimers(mirror);
	doc.destroy();
}

// ── Test 5: mixed cycle — recovery then remote — only remote triggers write ───

console.log("\n--- Test 5: mixed cycle — recovery then provider — only provider triggers write ---");
{
	const { doc, ytext, fakeProvider, mirror } = makeHarness();
	mirror.startMapObservers();

	// Recovery pass — simulates disk reconciliation
	doc.transact(() => { ytext.insert(0, "reconciled disk content"); }, ORIGIN_DISK_SYNC_RECOVER_BOUND);

	assert(debounceTimerCount(mirror) === 0, "after recovery pass: no debounce timer");
	assert(writeQueueSize(mirror) === 0, "after recovery pass: writeQueue empty");

	// Second recovery pass is no-op (same content) — no write
	doc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, "reconciled disk content"); }, ORIGIN_DISK_SYNC_RECOVER_BOUND);

	assert(debounceTimerCount(mirror) === 0, "after second recovery pass: still no debounce timer");

	// Remote update from another device — this SHOULD schedule a write
	doc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, "update from another device"); }, fakeProvider);

	assert(debounceTimerCount(mirror) === 1, "after provider update: debounce timer set");

	clearTimers(mirror);
	doc.destroy();
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
