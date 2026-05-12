/**
 * Phase 1.6 — Recovery amplifier orchestration test.
 *
 * The "recovery amplifier" was the scariest class of user-reported data
 * corruption: content duplicated or overwritten every few seconds, triggered
 * by external disk edits while a file was editor-bound.
 *
 * Two distinct amplifier mechanisms existed:
 *
 *  A. diskMirror loop — recovery transaction classified as REMOTE → diskMirror
 *     schedules a disk write → write triggers reconciliation → recovery runs
 *     again → infinite loop of disk writes and reconciliations.
 *     Fixed: Phase 1.1 (recovery origins added to LOCAL_STRING_ORIGINS).
 *
 *  B. Editor heal contamination — after disk recovery sets CRDT=disk, the
 *     editor binding saw CRDT changed and called heal() (editor→CRDT), applying
 *     stale editor content on top of the recovered disk content.
 *     Fixed: repair() path (CRDT→editor, CRDT unchanged) is used instead of
 *     heal() (editor→CRDT) in maybeHealBinding().
 *
 * This test covers known mechanism A invariants at the Yjs/origin layer:
 *   - Every recovery origin string is classified as local by isLocalOrigin()
 *   - The diskMirror dispatch simulation skips writeback for all repair origins
 *   - The diskMirror dispatch simulation triggers writeback for provider (remote) origins
 *   - A recovery transaction produces a non-empty delta on the first pass and an
 *     empty delta on the second pass (idempotent — no amplification loop)
 *
 * This test also exercises the three-authority scenario (disk / CRDT / editor)
 * and documents the still-dangerous heal() path to contrast against the safe
 * repair() path. The repair() path is exercised at the application logic level
 * (tests/editor-binding-health-regressions.mjs); this test covers the Y.js
 * invariants that underpin it.
 *
 * COVERAGE BOUNDARY — this is Yjs/origin-layer coverage, not controller orchestration.
 * It proves the known writeback-loop mechanism cannot recur through the tested path.
 * Full controller orchestration coverage (ReconciliationController + EditorBinding +
 * DiskMirror observer/queue) is tracked in FU-14.
 *
 * SCOPE — what this test does NOT cover (requires full Obsidian runtime):
 *   - Actual DiskMirror/ReconciliationController lifecycle
 *   - EditorBinding repair/heal flow end-to-end
 *   - Disk write scheduling and flush-queue side effects
 *   - Provider reconnect triggering second reconciliation
 */

import * as Y from "yjs";
import { applyDiffToYText } from "../src/sync/diff";
import {
	isLocalOrigin,
	isLocalStringOrigin,
	LOCAL_REPAIR_ORIGINS,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeText(content: string): { doc: Y.Doc; ytext: Y.Text } {
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, content);
	return { doc, ytext };
}

/**
 * Simulates the diskMirror text-observer dispatch decision.
 * Returns "skip" (local, no writeback) or "schedule-write" (remote, writeback).
 * This is the exact gate that guards against mechanism A (diskMirror loop).
 */
function diskMirrorDecision(origin: unknown, provider: object): "skip" | "schedule-write" {
	return isLocalOrigin(origin, provider) ? "skip" : "schedule-write";
}

/**
 * Returns true if the doc's state vector has not changed since baseStateVector.
 * A Y.js operation that calls `applyDiffToYText(same, same, ...)` returns early
 * and produces no transaction, leaving the state vector unchanged. This is the
 * correct idempotency check — comparing state vectors is authoritative because
 * state vectors encode the logical clock of every client that has written to the
 * doc. If they match, zero new operations were recorded.
 */
function noChangeSince(doc: Y.Doc, baseStateVector: Uint8Array): boolean {
	const current = Y.encodeStateVector(doc);
	if (current.length !== baseStateVector.length) return false;
	for (let i = 0; i < current.length; i++) {
		if (current[i] !== baseStateVector[i]) return false;
	}
	return true;
}

function hasChangeSince(doc: Y.Doc, baseStateVector: Uint8Array): boolean {
	return !noChangeSince(doc, baseStateVector);
}

const FAKE_PROVIDER = { __kind: "fake-provider" };

// ── Test 1: diskMirror dispatch — recovery origins skip writeback ─────────────

console.log("\n--- Test 1: all recovery origins are classified local (no diskMirror writeback) ---");
{
	const recoveryOrigins = [
		ORIGIN_DISK_SYNC,
		ORIGIN_DISK_SYNC_RECOVER_BOUND,
		ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
		ORIGIN_EDITOR_HEALTH_HEAL,
		ORIGIN_RESTORE,
		ORIGIN_SEED,
	];

	for (const origin of recoveryOrigins) {
		assert(
			diskMirrorDecision(origin, FAKE_PROVIDER) === "skip",
			`"${origin}" → diskMirror skips writeback (local origin)`,
		);
	}

	// Verify the set hasn't drifted from what we enumerated above
	assert(
		recoveryOrigins.every((o) => isLocalStringOrigin(o)),
		"all enumerated recovery origins are in LOCAL_REPAIR_ORIGINS",
	);
}

// ── Test 2: provider origin schedules writeback ──────────────────────────────

console.log("\n--- Test 2: provider (remote) origin triggers diskMirror writeback ---");
{
	assert(
		diskMirrorDecision(FAKE_PROVIDER, FAKE_PROVIDER) === "schedule-write",
		"provider-origin transaction → diskMirror schedules writeback",
	);
	assert(
		diskMirrorDecision("not-a-known-origin", FAKE_PROVIDER) === "schedule-write",
		"unknown string origin → diskMirror schedules writeback (not silently local)",
	);
	assert(
		diskMirrorDecision(null, FAKE_PROVIDER) === "skip",
		"null origin (local transact() without origin) → skip",
	);
}

// ── Test 3: disk recovery wins over stale CRDT ───────────────────────────────

console.log("\n--- Test 3: disk recovery sets CRDT to disk content ---");
{
	const staleCrdt = "stale CRDT content from before external edit";
	const diskContent = "fresh disk content after external editor saved it";

	const { doc, ytext } = makeText(staleCrdt);
	applyDiffToYText(ytext, staleCrdt, diskContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);

	assert(ytext.toString() === diskContent, "CRDT reflects disk content after recovery");
	assert(ytext.toString() !== staleCrdt, "stale CRDT content is gone");
	doc.destroy();
}

// ── Test 4: recovery is idempotent (second pass is no-op) ────────────────────

console.log("\n--- Test 4: second recovery pass produces no delta (amplifier loop is dead) ---");
{
	const staleCrdt = "---\nfrontmatter: old\n---\nbody text\n";
	const diskContent = "---\nfrontmatter: new\n---\nbody text\n";

	const { doc, ytext } = makeText(staleCrdt);

	// First pass: content changes → state vector advances
	const sv1 = Y.encodeStateVector(doc);
	applyDiffToYText(ytext, staleCrdt, diskContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);

	assert(hasChangeSince(doc, sv1), "first recovery pass advances state vector (content changed)");
	assert(ytext.toString() === diskContent, "first recovery sets correct content");

	// Second pass: same content → applyDiffToYText returns early (oldText === newText)
	// → no transaction, state vector unchanged → idempotent, loop cannot start
	const sv2 = Y.encodeStateVector(doc);
	applyDiffToYText(ytext, diskContent, diskContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);

	assert(noChangeSince(doc, sv2), "second recovery pass leaves state vector unchanged (no-op)");
	assert(ytext.toString() === diskContent, "content unchanged after second pass");

	// Third pass: just to be sure
	const sv3 = Y.encodeStateVector(doc);
	applyDiffToYText(ytext, diskContent, diskContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);

	assert(noChangeSince(doc, sv3), "third recovery pass is also a no-op");

	doc.destroy();
}

// ── Test 5: three-authority scenario — disk wins, repair is no-op ────────────

console.log("\n--- Test 5: three-authority scenario (disk / CRDT / editor) ---");
{
	// The scenario that triggered real user reports:
	//   disk    = "A" (user just saved externally)
	//   CRDT    = "B" (old server state, before external edit)
	//   editor  = "C" (user has unsaved edits in Obsidian)
	// Recovery should apply disk ("A") to CRDT.
	// Repair (CRDT→editor) then shows the editor the new content ("A").
	// CRDT must not end up as "C" (editor content contaminating via heal).

	const diskContent  = "# Disk content\nSaved externally by another tool.";
	const staleCrdt    = "# Old CRDT\nContent before external edit.";
	const editorContent = "# Editor drafts\nUser has been typing here.";

	const { doc, ytext } = makeText(staleCrdt);

	// Step 1: recovery applies disk content to CRDT
	applyDiffToYText(ytext, staleCrdt, diskContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);
	assert(ytext.toString() === diskContent, "after recovery: CRDT = disk content");

	// Step 2: repair path — CRDT content would be pushed to editor view.
	// Repair does NOT change Y.Text; it updates the CM6 editor to match.
	// Simulate: "editor is now updated to crdtContent" (no Y.Text write).
	const updatedEditorContent = ytext.toString(); // editor now shows disk content
	assert(updatedEditorContent === diskContent, "repair path: editor updated to match CRDT");

	// Step 3: a second recovery with the same disk content is a no-op
	const sv = Y.encodeStateVector(doc);
	applyDiffToYText(ytext, diskContent, diskContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);
	assert(noChangeSince(doc, sv), "second recovery after repair is still a no-op");
	assert(ytext.toString() === diskContent, "CRDT still holds disk content after repair+recovery");

	doc.destroy();
}

// ── Test 6: documenting the heal() contamination — why repair() must be used ─

console.log("\n--- Test 6: heal() contamination documents the amplifier class ---");
{
	// This test deliberately shows what HAPPENS if the wrong path (heal: editor→CRDT)
	// is taken instead of the correct path (repair: CRDT→editor). It proves the
	// pre-Phase-1.1 amplifier class was real and is dangerous if reintroduced.

	const diskContent   = "# Correct\nDisk won recovery.";
	const staleCrdt     = "# Stale\nOld CRDT before external edit.";
	const editorContent = "# Wrong\nStale editor content (should not win).";

	const { doc: docCorrect, ytext: ytextCorrect } = makeText(staleCrdt);
	const { doc: docBug,     ytext: ytextBug }     = makeText(staleCrdt);

	// Correct path: disk recovery + repair (CRDT→editor)
	applyDiffToYText(ytextCorrect, staleCrdt,    diskContent,   ORIGIN_DISK_SYNC_RECOVER_BOUND);
	// "repair()" would push ytextCorrect.toString() to editor view — no Y.Text write.
	assert(ytextCorrect.toString() === diskContent, "correct path: CRDT = disk after recovery");

	// Buggy path: disk recovery + heal (editor→CRDT) — the amplifier
	applyDiffToYText(ytextBug, staleCrdt,    diskContent,   ORIGIN_DISK_SYNC_RECOVER_BOUND);
	applyDiffToYText(ytextBug, diskContent,  editorContent, ORIGIN_EDITOR_HEALTH_HEAL);
	assert(ytextBug.toString() === editorContent, "buggy heal() path overwrites disk recovery with editor content");
	assert(ytextBug.toString() !== diskContent,   "buggy heal() path destroys disk authority");

	// Critically: after heal() ran and wrote editorContent to CRDT via ORIGIN_EDITOR_HEALTH_HEAL,
	// the diskMirror classifies ORIGIN_EDITOR_HEALTH_HEAL as LOCAL (Phase 1.1 fix),
	// so it does NOT schedule another disk write. The loop stops here.
	// BUT: this does not make heal() safe. Calling heal() in a recovery cycle is still
	// a correctness bug — it overwrites disk authority with stale editor content.
	// "No disk-write loop" ≠ "no corruption." The fix is using repair() instead of heal().
	assert(
		diskMirrorDecision(ORIGIN_EDITOR_HEALTH_HEAL, FAKE_PROVIDER) === "skip",
		"even the buggy heal() origin is local — diskMirror does not loop on it",
	);

	docCorrect.destroy();
	docBug.destroy();
}

// ── Test 7: recovery amplifier loop can't start — diskMirror skips all phases ─

console.log("\n--- Test 7: simulated observer loop — recovery never triggers a write cycle ---");
{
	// Simulate what happens in a recovery cycle at the observer level:
	//  1. Provider applies remote update (REMOTE → diskMirror schedules write)
	//  2. ReconciliationController reads disk, applies recovery (LOCAL → diskMirror skips)
	//  3. Second recovery (no-op, empty delta) → nothing dispatched
	// The loop cannot start because recovery transactions are always "skip".

	const staleCrdt   = "stale";
	const diskContent = "fresh";

	const { doc, ytext } = makeText(staleCrdt);
	const writes: string[] = [];

	// Attach a minimal observer that mirrors the diskMirror dispatch logic
	doc.on("update", (_update: Uint8Array, origin: unknown) => {
		const decision = diskMirrorDecision(origin, FAKE_PROVIDER);
		if (decision === "schedule-write") {
			writes.push(typeof origin === "string" ? origin : "(object)");
		}
	});

	// Step 1: remote update arrives (another device made a change).
	// Use a separate map key so the update event fires without interfering
	// with the "content" Y.Text that recovery will operate on.
	const remoteDoc = new Y.Doc();
	remoteDoc.getMap("remote-events").set("tick", 1);
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(remoteDoc), FAKE_PROVIDER);

	// Step 2: disk recovery runs (simulates reconciliationController writing disk content).
	// ytext still holds staleCrdt (the map update above did not touch it).
	const currentContent = ytext.toString();
	applyDiffToYText(ytext, currentContent, diskContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);

	// Step 3: second recovery is a no-op
	applyDiffToYText(ytext, diskContent, diskContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);

	// Only the provider remote update should have triggered a write
	assert(
		writes.filter((w) => w === "(object)").length === 1,
		"exactly one write scheduled — for the remote provider update",
	);
	assert(
		writes.filter((w) => w === ORIGIN_DISK_SYNC_RECOVER_BOUND).length === 0,
		"recovery origin never triggers a write — amplifier loop cannot start",
	);
	assert(ytext.toString() === diskContent, "CRDT holds disk content after simulated recovery cycle");

	doc.destroy();
}

// ── Test 8: all repair origins survive repeated cycles without growing ────────

console.log("\n--- Test 8: repeated recovery cycles across all repair origins stay bounded ---");
{
	const initial = "initial content";
	const target  = "target content after recovery";

	for (const origin of [
		ORIGIN_DISK_SYNC,
		ORIGIN_DISK_SYNC_RECOVER_BOUND,
		ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
	] as const) {
		const { doc, ytext } = makeText(initial);
		let current = initial;

		for (let i = 0; i < 10; i++) {
			applyDiffToYText(ytext, current, target, origin);
			current = ytext.toString();
		}

		assert(ytext.toString() === target, `repeated recovery via "${origin}" converges to target`);
		assert(
			ytext.toString().length === target.length,
			`"${origin}" does not grow content over 10 cycles`,
		);
		doc.destroy();
	}
}

// ── Test 9: controller-shaped recovery picks one authority and second pass no-ops

console.log("\n--- Test 9: controller-shaped disk/CRDT/editor recovery is stable ---");
{
	const diskInitial = "# Disk authority\nSaved externally.";
	const crdtInitial = "# Old CRDT\nBefore external save.";
	const editorInitial = "# Editor draft\nUnsaved stale view.";

	const { doc, ytext } = makeText(crdtInitial);
	let disk = diskInitial;
	let editor = editorInitial;
	const scheduledWrites: string[] = [];
	let repairCount = 0;
	let noActionCount = 0;

	doc.on("update", (_update: Uint8Array, origin: unknown) => {
		if (diskMirrorDecision(origin, FAKE_PROVIDER) === "schedule-write") {
			scheduledWrites.push(ytext.toString());
		}
	});

	function reconcileOnce(): void {
		const before = ytext.toString();
		if (before !== disk) {
			applyDiffToYText(ytext, before, disk, ORIGIN_DISK_SYNC_RECOVER_BOUND);
		}
		if (editor !== ytext.toString()) {
			// Correct controller behavior: repair updates editor from CRDT.
			editor = ytext.toString();
			repairCount++;
			return;
		}
		// A heal would write editor into CRDT. The safe path must never need it here.
		noActionCount++;
	}

	reconcileOnce();
	assert(ytext.toString() === diskInitial, "first pass: CRDT adopts disk authority");
	assert(editor === diskInitial, "first pass: editor repaired from CRDT/disk authority");
	assert(repairCount === 1, "first pass: repair path used once");
	assert(noActionCount === 0, "first pass: no-op path not reached yet");
	assert(scheduledWrites.length === 0, "first pass: recovery origin schedules no disk write");

	const svAfterFirstPass = Y.encodeStateVector(doc);
	reconcileOnce();
	assert(noChangeSince(doc, svAfterFirstPass), "second pass: CRDT state vector unchanged");
	assert(editor === disk, "second pass: editor remains aligned");
	assert(repairCount === 1, "second pass: no extra repair");
	assert(noActionCount === 1, "second pass: no-op path reached without CRDT mutation");
	assert(scheduledWrites.length === 0, "second pass: still no disk write scheduled");

	doc.destroy();
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
