/**
 * Pure unit tests for closedFilePlanner.
 *
 * Tests the same function that ReconciliationController will call during
 * authoritative reconciliation. No Obsidian, no Yjs, no disk I/O.
 */

import { planClosedFileReconcile } from "../../src/runtime/reconcile/closedFilePlanner";
import type { ClosedFileReconcileInput } from "../../src/runtime/reconcile/closedFilePlanner";
import { suite } from "../harness.ts";

const s = suite("closed-file-planner");

// Helper: SHA-256 hex-like strings (just need to be distinct for testing)
const HASH_A = "aaaa";
const HASH_B = "bbbb";
const HASH_C = "cccc";

function makeInput(overrides: Partial<ClosedFileReconcileInput> = {}): ClosedFileReconcileInput {
	return {
		path: "notes/test.md",
		mode: "authoritative",
		isOpenOrBound: false,
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: HASH_C,
		...overrides,
	};
}

// -----------------------------------------------------------------------
// Non-authoritative mode
// -----------------------------------------------------------------------

s.section("Test 1: non-authoritative mode => defer-to-crdt-flush");
{
	const action = planClosedFileReconcile(makeInput({ mode: "conservative" }));
	s.check(action.kind === "defer-to-crdt-flush", "kind is defer-to-crdt-flush");
	s.check(action.reason === "non-authoritative-mode", "reason is non-authoritative-mode");
}

// -----------------------------------------------------------------------
// Open/bound files
// -----------------------------------------------------------------------

s.section("Test 2: open or bound file => defer-to-crdt-flush");
{
	const action = planClosedFileReconcile(makeInput({ isOpenOrBound: true }));
	s.check(action.kind === "defer-to-crdt-flush", "kind is defer-to-crdt-flush");
	s.check(action.reason === "open-or-bound", "reason is open-or-bound");
}

// -----------------------------------------------------------------------
// Disk equals CRDT
// -----------------------------------------------------------------------

s.section("Test 3: disk == CRDT => no-op");
{
	const action = planClosedFileReconcile(makeInput({ diskHash: HASH_A, crdtHash: HASH_A }));
	s.check(action.kind === "no-op", "kind is no-op");
	s.check(action.reason === "disk-equals-crdt", "reason is disk-equals-crdt");
}

// -----------------------------------------------------------------------
// Three-way: disk at baseline, CRDT changed
// -----------------------------------------------------------------------

s.section("Test 4: disk at baseline, CRDT changed => apply-remote-to-disk");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: HASH_A, // disk == baseline, CRDT changed
	}));
	s.check(action.kind === "apply-remote-to-disk", "CRDT wins cleanly");
	s.check(action.reason === "disk-at-baseline", "reason is disk-at-baseline");
}

// -----------------------------------------------------------------------
// Three-way: CRDT at baseline, disk changed
// -----------------------------------------------------------------------

s.section("Test 5: CRDT at baseline, disk changed => import-disk-to-crdt");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_B,
		crdtHash: HASH_A,
		baselineHash: HASH_A, // CRDT == baseline, disk changed
	}));
	s.check(action.kind === "import-disk-to-crdt", "disk wins cleanly");
	s.check(action.reason === "crdt-at-baseline", "reason is crdt-at-baseline");
}

// -----------------------------------------------------------------------
// Three-way: both changed
// -----------------------------------------------------------------------

s.section("Test 6: both changed => create-conflict-artifact");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: HASH_C, // neither matches baseline
	}));
	s.check(action.kind === "create-conflict-artifact", "conflict artifact created");
	s.check(action.kind === "create-conflict-artifact" && action.winner === "disk", "disk wins");
	s.check(action.kind === "create-conflict-artifact" && action.preserveSide === "crdt", "CRDT preserved as artifact");
	s.check(action.reason === "both-changed", "reason is both-changed");
}

// -----------------------------------------------------------------------
// Missing baseline: disk newer than last save
// -----------------------------------------------------------------------

s.section("Test 7: missing baseline, disk newer => conflict, disk wins");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: null,
		diskMtime: 2000,
		lastDiskIndexPersistedAt: 1000, // disk modified after last save
	}));
	s.check(action.kind === "create-conflict-artifact", "conflict created");
	s.check(action.kind === "create-conflict-artifact" && action.winner === "disk", "disk wins (newer)");
	s.check(action.kind === "create-conflict-artifact" && action.preserveSide === "crdt", "CRDT preserved");
	s.check(action.kind === "create-conflict-artifact" && action.missingBaselinePolicy === "disk-mtime-after-last-index-save", "policy documented");
}

// -----------------------------------------------------------------------
// Missing baseline: no mtime evidence
// -----------------------------------------------------------------------

s.section("Test 8: missing baseline, no mtime evidence => conflict, CRDT wins");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: null,
		// no diskMtime, no lastDiskIndexPersistedAt
	}));
	s.check(action.kind === "create-conflict-artifact", "conflict created");
	s.check(action.kind === "create-conflict-artifact" && action.winner === "crdt", "CRDT wins (safe default)");
	s.check(action.kind === "create-conflict-artifact" && action.preserveSide === "disk", "disk preserved");
	s.check(action.kind === "create-conflict-artifact" && action.missingBaselinePolicy === "crdt-default-no-evidence", "policy documented");
}

// -----------------------------------------------------------------------
// Missing baseline: mtime present but disk not newer
// -----------------------------------------------------------------------

s.section("Test 9: missing baseline, disk NOT newer => conflict, CRDT wins");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: null,
		diskMtime: 500,
		lastDiskIndexPersistedAt: 1000, // disk older than last save
	}));
	s.check(action.kind === "create-conflict-artifact", "conflict created");
	s.check(action.kind === "create-conflict-artifact" && action.winner === "crdt", "CRDT wins");
	s.check(action.kind === "create-conflict-artifact" && action.missingBaselinePolicy === "crdt-default-disk-not-newer", "policy: not newer");
}

// -----------------------------------------------------------------------
// Path is preserved in all actions
// -----------------------------------------------------------------------

s.section("Test 10: path is preserved in all action kinds");
{
	const path = "deep/nested/path/file.md";
	const action1 = planClosedFileReconcile(makeInput({ path, diskHash: HASH_A, crdtHash: HASH_A }));
	s.check(action1.path === path, "path preserved in no-op");

	const action2 = planClosedFileReconcile(makeInput({ path, mode: "conservative" }));
	s.check(action2.path === path, "path preserved in defer");

	const action3 = planClosedFileReconcile(makeInput({ path, diskHash: HASH_A, crdtHash: HASH_B, baselineHash: HASH_A }));
	s.check(action3.path === path, "path preserved in apply-remote");
}

// -----------------------------------------------------------------------
// Edge: disk == crdt even when baseline is null
// -----------------------------------------------------------------------

s.section("Test 11: disk == CRDT with null baseline => no-op (not conflict)");
{
	const action = planClosedFileReconcile(makeInput({
		diskHash: HASH_A,
		crdtHash: HASH_A,
		baselineHash: null,
	}));
	s.check(action.kind === "no-op", "agreement overrides missing baseline");
}

// -----------------------------------------------------------------------
// Characterization: open/bound file semantics (IMPORTANT — read before changing)
//
// When isOpenOrBound=true in authoritative mode, the planner returns
// defer-to-crdt-flush. The ReconciliationController pre-filters open/bound
// paths before calling the planner (the outer `!isOpenOrBound` guard in
// the updatedOnDisk loop), which means this return value is currently
// unreachable from the controller path.
//
// The semantics are intentional: open/bound files are NOT flushed to disk
// during reconcile. Convergence is guaranteed by other paths:
//
//   externalEditPolicy="always":
//     vault.modify fires for the external disk change →
//     syncFileFromDisk called → decideExternalEditImport returns allowImport:true →
//     handleBoundFileSyncGap resolves disk↔CRDT via the live editor binding.
//
//   externalEditPolicy="closed-only":
//     vault.modify fires but syncFileFromDisk defers (open file, closed-only policy) →
//     on tab close: reconcileTrackedOpenFiles → maybeImportDeferredClosedOnlyPath →
//     processDirtyMarkdownPath → syncFileFromDisk with file now closed → import runs.
//
//   Stale binding (isBound but no MarkdownView):
//     next syncFileFromDisk call hits the stale-binding cleaner at
//     reconciliationController.ts:1356-1363 → unbindByPath → proceeds normally.
//     Workspace-restore case: y-codemirror initializes editor from CRDT →
//     diskMirror writes to disk.
//
// The OLD pre-extraction behavior (flushing CRDT to disk during reconcile
// for open files) was a latent bug: it raced with vault.modify →
// syncFileFromDisk → handleBoundFileSyncGap, potentially overwriting a
// correct disk→CRDT merge with a stale CRDT→disk flush.
//
// DO NOT restore the flush without understanding these convergence paths.
// -----------------------------------------------------------------------

s.section("Test 12 (characterization): open file in authoritative mode defers");
{
	// Current contract: isOpenOrBound=true → defer-to-crdt-flush.
	// This is reached when conservative mode runs (mode is "conservative"),
	// or when the controller explicitly passes isOpenOrBound=true.
	// See convergence analysis above for why this is correct.
	const action = planClosedFileReconcile(makeInput({
		mode: "authoritative",
		isOpenOrBound: true,
		diskHash: HASH_A,
		crdtHash: HASH_B, // disk differs from CRDT
		baselineHash: HASH_A,
	}));
	s.check(action.kind === "defer-to-crdt-flush", "open file → defer (convergence via vault.modify path)");
	s.check(action.reason === "open-or-bound", "reason documents why flush was deferred");
}

s.section("Test 13 (characterization): conservative mode always defers");
{
	// Conservative admission remains a planner-level safety contract for
	// bootstrap settlement when authority is unavailable.
	const actionDiffers = planClosedFileReconcile(makeInput({
		mode: "conservative",
		diskHash: HASH_A,
		crdtHash: HASH_B,
		baselineHash: HASH_A,
	}));
	s.check(actionDiffers.kind === "defer-to-crdt-flush", "conservative → defer regardless of hash state");

	const actionAgrees = planClosedFileReconcile(makeInput({
		mode: "conservative",
		diskHash: HASH_A,
		crdtHash: HASH_A,
	}));
	s.check(actionAgrees.kind === "defer-to-crdt-flush", "conservative → defer even when disk==crdt");
}

s.section("Test 14 (characterization): closed/unbound file in authoritative mode does NOT defer");
{
	// The symmetric guarantee: once isOpenOrBound=false and mode=authoritative,
	// the planner uses the full three-way conflict resolution. This is the path
	// the controller exercises for every file in updatedOnDisk that is not open.
	const actionApplyRemote = planClosedFileReconcile(makeInput({
		mode: "authoritative",
		isOpenOrBound: false,
		diskHash: HASH_A,     // disk at baseline
		crdtHash: HASH_B,     // CRDT moved
		baselineHash: HASH_A,
	}));
	s.check(actionApplyRemote.kind === "apply-remote-to-disk", "closed + CRDT-only-change → apply remote");

	const actionImportDisk = planClosedFileReconcile(makeInput({
		mode: "authoritative",
		isOpenOrBound: false,
		diskHash: HASH_B,     // disk moved
		crdtHash: HASH_A,     // CRDT at baseline
		baselineHash: HASH_A,
	}));
	s.check(actionImportDisk.kind === "import-disk-to-crdt", "closed + disk-only-change → import disk");
}
await s.done();
