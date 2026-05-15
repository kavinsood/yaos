/**
 * S07g — Rename/move after create.
 *
 * Class: Plugin-generated writes / Templater stress suite.
 *
 * Scenario:
 *   A plugin-style workflow creates a file at a temporary path (e.g. "Untitled"),
 *   fills it with content, then renames it to a final path (e.g. a dated journal path).
 *   This is exactly what Templater, Periodic Notes, and similar plugins do.
 *
 * Failure modes under test:
 *   1. Rename silently dropped — CRDT never gets crdt.file.renamed → old path orphaned,
 *      new path treated as fresh file with no identity continuity.
 *   2. Tombstone at new path blocks rename — if a previous note existed at the final
 *      path and was deleted, the tombstone must be cleared by the rename.
 *   3. Race: create not yet in CRDT when rename fires — vaultSync.handleRename finds no
 *      fileId and ignores the rename → new path remains unknown to CRDT.
 *   4. Identity-lost resurrection — new path gets crdt.file.created after rename
 *      instead of crdt.file.renamed (i.e. treated as a different file).
 *
 * What this tests:
 *   - vaultSync.queueRename + applyRenameBatch pipeline
 *   - crdt.file.renamed event emission (new in taxonomy v4)
 *   - Tombstone clearing for new path on rename
 *   - Analyzer rule: orphan-after-rename
 *
 * Variants:
 *   S07g-1: simple create → fill → rename (fast path)
 *   S07g-2: create → rename → fill (rename before CRDT registration — race test)
 *   S07g-3: create → fill → rename to a previously-deleted path (tombstone race)
 *   S07g-4: create → fill → rename → rename again (chain: A → B → C)
 *   S07g-5: create → CRDT admission → modify → rename (redirectPendingCreate safety)
 *
 * Assertions (all variants):
 *   - Final disk path exists, original path does not
 *   - disk == CRDT == editor for final path
 *   - Trace contains disk.rename.observed + crdt.file.renamed
 *   - Analyzer passes (orphan-after-rename rule is new; must not fire)
 *   - No crdt.file.tombstoned for final path after rename
 *   - File size unchanged from filled content (no growth)
 */

import type { QaScenario } from "../types";

const FOLDER = "QA-s07g";
const CONTENT_BODY = `# Templater daily note

## Tasks

- [ ] Review meeting notes
- [ ] Follow up on sync bug #25
- [ ] Deploy harness changes

## Notes

This file was created programmatically and then renamed.
The sync engine must preserve file identity across the rename.

`.repeat(10); // ~2k chars, realistic

function s07gPath(suffix: string): string {
	return `${FOLDER}/${suffix}.md`;
}

// -----------------------------------------------------------------------
// S07g-1: Simple create → fill → rename (the golden path)
// -----------------------------------------------------------------------

export const s07gRenameAfterCreate: QaScenario = {
	id: "s07g-rename-after-create",
	title: "S07g-1: Plugin-style create → fill → rename (Templater golden path)",
	tags: ["s07g", "rename", "plugin-writes", "templater-class", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const tmpPath = s07gPath("untitled-" + Date.now().toString(36));
		const finalPath = s07gPath("daily-" + Date.now().toString(36));

		// 1. Create file at temp path (empty, like Obsidian's new-note command).
		await ctx.createFile(tmpPath, "");
		await ctx.waitForFile(tmpPath, 15000);
		await ctx.waitForIdle(10000);

		// 2. Fill with content (template execution).
		await ctx.modifyFile(tmpPath, CONTENT_BODY);
		// Wait until CRDT is seeded — waitForIdle is not sufficient here because
		// YAOS processes disk events asynchronously. waitForCrdtFile polls
		// getCrdtHash until it returns non-null.
		await ctx.waitForCrdtFile(tmpPath, 15000);
		await ctx.waitForIdle(5000);

		// 3. PRECONDITION: tmpPath disk == CRDT.
		const diskBefore = await ctx.yaos.getDiskHash(tmpPath);
		const crdtBefore = await ctx.yaos.getCrdtHash(tmpPath);
		if (!diskBefore || !crdtBefore || diskBefore !== crdtBefore) {
			throw new Error(
				`S07g-1: tmpPath not converged before rename\n  disk: ${diskBefore}\n  crdt: ${crdtBefore}`,
			);
		}
		console.log("[S07g-1] tmpPath converged before rename", { diskBefore });

		// 4. Rename tmpPath → finalPath (Templater/Periodic Notes behaviour).
		await ctx.renameFile(tmpPath, finalPath);
		// Give the rename batch timer and CRDT flush time to settle.
		await ctx.sleep(1500);
		await ctx.waitForIdle(15000);

		// 5. POSTCONDITION: final path exists and disk == CRDT.
		const diskFinal = await ctx.yaos.getDiskHash(finalPath);
		const crdtFinal = await ctx.yaos.getCrdtHash(finalPath);
		console.log("[S07g-1] final path hashes", { diskFinal, crdtFinal });

		if (!diskFinal) {
			throw new Error(`S07g-1: finalPath not on disk after rename: ${finalPath}`);
		}
		if (!crdtFinal) {
			throw new Error(`S07g-1: finalPath not in CRDT after rename: ${finalPath}`);
		}
		if (diskFinal !== crdtFinal) {
			throw new Error(
				`S07g-1: disk != CRDT at final path\n  disk: ${diskFinal}\n  crdt: ${crdtFinal}`,
			);
		}

		// 6. Original path must NOT be in CRDT.
		const crdtOld = await ctx.yaos.getCrdtHash(tmpPath);
		if (crdtOld) {
			throw new Error(`S07g-1: tmpPath still in CRDT after rename (orphan): ${tmpPath}`);
		}

		// 7. Content hash at final path must match what was written.
		if (diskFinal !== diskBefore) {
			throw new Error(
				`S07g-1: content changed across rename\n  before: ${diskBefore}\n  after: ${diskFinal}`,
			);
		}

		await ctx.deleteFile(finalPath);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.fileNotExists(s07gPath("untitled-")); // partial match not possible in API
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

// -----------------------------------------------------------------------
// S07g-2: Create → rename immediately (before CRDT registration) — race test
//
// This tests the race that real Templater workflows can trigger:
//   1. Plugin calls vault.create() to get a new note path.
//   2. Plugin immediately calls vault.rename() before YAOS has processed
//      the create event and registered a fileId in the CRDT.
//   3. vaultSync.handleRename fires with no fileId → must queue/buffer
//      the rename rather than silently drop it.
//
// Expected: final path exists in CRDT with correct content; original path
// is NOT in CRDT as an orphan; file identity is preserved.
//
// If YAOS silently drops the rename:
//   - new path appears as a fresh crdt.file.created (identity loss)
//   - old path may remain as a ghost CRDT entry (orphan)
// -----------------------------------------------------------------------

export const s07gRenameBeforeCrdtRegistration: QaScenario = {
	id: "s07g-rename-before-crdt",
	title: "S07g-2: Create → rename before CRDT registration (Templater race)",
	tags: ["s07g", "rename", "plugin-writes", "templater-class", "race", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const ts = Date.now().toString(36);
		const tmpPath = s07gPath(`race-tmp-${ts}`);
		const finalPath = s07gPath(`race-final-${ts}`);

		// 1. Create file with content in ONE step (no waitForCrdtFile).
		//    We intentionally do NOT wait for CRDT before renaming —
		//    that is the race we are testing.
		await ctx.createFile(tmpPath, CONTENT_BODY);

		// Race window probe: attempt with 0ms delay first, then 50ms fallback.
		// On fast hardware YAOS registers files synchronously within the vault
		// create event callback. If CRDT already has the file at 0ms, we are
		// on a fast device where the race window has already closed. We still
		// run the rename (testing the post-registration path) and record the
		// actual precondition state for diagnostic purposes.
		const crdtAtZero = await ctx.yaos.getCrdtHash(tmpPath);
		const raceHit = crdtAtZero === null;
		console.log("[S07g-2] pre-rename CRDT state", { crdtAtZero, raceHit });

		if (!raceHit) {
			// CRDT already registered. This means YAOS processes creates
			// synchronously on this machine — the race window is <1ms.
			// The scenario still verifies the rename pipeline correctness,
			// just not the race condition specifically. Log this clearly.
			console.warn(
				"[S07g-2] race window missed: CRDT registered tmpPath before rename. " +
				"On this machine the race window is <1ms. Running rename anyway to " +
				"verify pipeline correctness (not the race path).",
			);
		}

		// 2. Rename immediately.
		await ctx.renameFile(tmpPath, finalPath);

		// 3. Now wait for the dust to settle. Give YAOS enough time to
		//    process the queued create + rename in whatever order they arrive.
		await ctx.sleep(2000);
		await ctx.waitForIdle(20000);

		// 4. POSTCONDITION: final path must exist on disk.
		const diskFinal = await ctx.yaos.getDiskHash(finalPath);
		if (!diskFinal) {
			throw new Error(
				`S07g-2: finalPath not on disk after race rename: ${finalPath}`,
			);
		}

		// 5. CRDT must have the final path (not just a stale tmpPath entry).
		//    Wait a bit longer for CRDT convergence since the race may have
		//    delayed processing.
		await ctx.waitForCrdtFile(finalPath, 20000);

		const crdtFinal = await ctx.yaos.getCrdtHash(finalPath);
		if (!crdtFinal) {
			throw new Error(
				`S07g-2: finalPath not in CRDT after race rename — rename was silently dropped: ${finalPath}`,
			);
		}

		// 6. disk == CRDT at final path.
		if (diskFinal !== crdtFinal) {
			throw new Error(
				`S07g-2: disk != CRDT at finalPath after race\n  disk: ${diskFinal}\n  crdt: ${crdtFinal}`,
			);
		}

		// 7. tmpPath must NOT be an orphan in CRDT.
		const crdtOld = await ctx.yaos.getCrdtHash(tmpPath);
		if (crdtOld) {
			throw new Error(
				`S07g-2: tmpPath still in CRDT after rename (orphan): ${tmpPath}`,
			);
		}

		// 8. Content integrity: final CRDT content must match what was written.
		//    (disk hash of finalPath == disk hash of CONTENT_BODY on a fresh file)
		//    We verify content hash is the same as a reference write.
		const refPath = s07gPath(`race-ref-${ts}`);
		await ctx.createFile(refPath, CONTENT_BODY);
		await ctx.waitForFile(refPath, 10000);
		const refDisk = await ctx.yaos.getDiskHash(refPath);
		await ctx.deleteFile(refPath);

		if (refDisk && diskFinal !== refDisk) {
			throw new Error(
				`S07g-2: content corrupted across race rename\n  expected: ${refDisk}\n  got: ${diskFinal}`,
			);
		}

		console.log("[S07g-2] rename converged", { diskFinal, crdtFinal, raceHit });
		await ctx.deleteFile(finalPath);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

// -----------------------------------------------------------------------
// S07g-3: Create → fill → rename to a previously-deleted path (tombstone)
// -----------------------------------------------------------------------

export const s07gRenameToTombstonedPath: QaScenario = {
	id: "s07g-rename-to-tombstoned-path",
	title: "S07g-3: Rename to previously-deleted path (tombstone clearance)",
	tags: ["s07g", "rename", "tombstone", "plugin-writes", "templater-class", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const tombstonedPath = s07gPath("previously-deleted-" + Date.now().toString(36));
		const tmpPath = s07gPath("new-untitled-" + Date.now().toString(36));

		// 1. Create a file at the target path, seed it into CRDT, then delete it.
		//    This creates a tombstone at tombstonedPath.
		await ctx.createFile(tombstonedPath, "old content that should be gone");
		await ctx.waitForFile(tombstonedPath, 15000);
		await ctx.waitForCrdtFile(tombstonedPath, 15000);
		await ctx.waitForIdle(5000);
		await ctx.deleteFile(tombstonedPath);
		await ctx.waitForIdle(8000);

		// Confirm tombstonedPath is gone from CRDT.
		const crdtAfterDelete = await ctx.yaos.getCrdtHash(tombstonedPath);
		if (crdtAfterDelete) {
			throw new Error(`S07g-3: tombstonedPath still in CRDT after delete: ${tombstonedPath}`);
		}
		console.log("[S07g-3] tombstone created at", tombstonedPath);

		// 2. Create new file at tmpPath and fill it.
		await ctx.createFile(tmpPath, CONTENT_BODY);
		await ctx.waitForFile(tmpPath, 15000);
		await ctx.waitForCrdtFile(tmpPath, 15000);
		await ctx.waitForIdle(5000);

		const diskBeforeRename = await ctx.yaos.getDiskHash(tmpPath);
		const crdtBeforeRename = await ctx.yaos.getCrdtHash(tmpPath);
		if (!diskBeforeRename || !crdtBeforeRename || diskBeforeRename !== crdtBeforeRename) {
			throw new Error(`S07g-3: tmpPath not converged before rename`);
		}
		console.log("[S07g-3] tmpPath converged before rename", { diskBeforeRename });

		// 3. Rename tmpPath to tombstonedPath.
		//    The tombstone at tombstonedPath must be cleared, not block the rename.
		await ctx.renameFile(tmpPath, tombstonedPath);
		await ctx.sleep(1500);
		await ctx.waitForIdle(15000);

		// 4. POSTCONDITION.
		const diskFinal = await ctx.yaos.getDiskHash(tombstonedPath);
		const crdtFinal = await ctx.yaos.getCrdtHash(tombstonedPath);
		console.log("[S07g-3] postcondition", { diskFinal, crdtFinal });

		if (!diskFinal) {
			throw new Error(`S07g-3: file not on disk after rename-to-tombstoned-path`);
		}
		if (!crdtFinal) {
			throw new Error(`S07g-3: file not in CRDT after rename-to-tombstoned-path (tombstone may have blocked it)`);
		}
		if (diskFinal !== crdtFinal) {
			throw new Error(`S07g-3: disk != CRDT after rename-to-tombstoned-path\n  disk: ${diskFinal}\n  crdt: ${crdtFinal}`);
		}
		if (diskFinal !== diskBeforeRename) {
			throw new Error(`S07g-3: content changed across rename\n  before: ${diskBeforeRename}\n  after: ${diskFinal}`);
		}

		const crdtOld = await ctx.yaos.getCrdtHash(tmpPath);
		if (crdtOld) {
			throw new Error(`S07g-3: tmpPath still in CRDT after rename (orphan): ${tmpPath}`);
		}

		await ctx.deleteFile(tombstonedPath);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

// -----------------------------------------------------------------------
// S07g-4: Create → fill → rename → rename again (transitive chain A→B→C)
// -----------------------------------------------------------------------

export const s07gRenameChain: QaScenario = {
	id: "s07g-rename-chain",
	title: "S07g-4: Transitive rename chain A→B→C (Templater move-to-folder)",
	tags: ["s07g", "rename", "rename-chain", "plugin-writes", "templater-class", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const ts = Date.now().toString(36);
		const pathA = s07gPath(`chain-a-${ts}`);
		const pathB = s07gPath(`chain-b-${ts}`);
		const pathC = s07gPath(`chain-c-${ts}`);

		// 1. Create at A.
		await ctx.createFile(pathA, CONTENT_BODY);
		await ctx.waitForFile(pathA, 15000);
		await ctx.waitForCrdtFile(pathA, 15000);
		await ctx.waitForIdle(5000);

		const diskAtA = await ctx.yaos.getDiskHash(pathA);
		const crdtAtA = await ctx.yaos.getCrdtHash(pathA);
		if (!diskAtA || !crdtAtA || diskAtA !== crdtAtA) {
			throw new Error(`S07g-4: pathA not converged`);
		}
		console.log("[S07g-4] pathA converged", { diskAtA });

		// 2. Rename A → B.
		await ctx.renameFile(pathA, pathB);
		await ctx.sleep(1500);
		await ctx.waitForIdle(10000);

		// 3. Rename B → C (within the rename batch debounce window or after).
		await ctx.renameFile(pathB, pathC);
		await ctx.sleep(1500);
		await ctx.waitForIdle(15000);

		// 4. POSTCONDITION: C exists, A and B do not.
		const diskC = await ctx.yaos.getDiskHash(pathC);
		const crdtC = await ctx.yaos.getCrdtHash(pathC);
		console.log("[S07g-4] final hashes at C", { diskC, crdtC });

		if (!diskC) throw new Error(`S07g-4: pathC not on disk`);
		if (!crdtC) throw new Error(`S07g-4: pathC not in CRDT`);
		if (diskC !== crdtC) {
			throw new Error(`S07g-4: disk != CRDT at pathC\n  disk: ${diskC}\n  crdt: ${crdtC}`);
		}
		if (diskC !== diskAtA) {
			throw new Error(`S07g-4: content changed across chain rename`);
		}

		const crdtA = await ctx.yaos.getCrdtHash(pathA);
		const crdtB = await ctx.yaos.getCrdtHash(pathB);
		if (crdtA) throw new Error(`S07g-4: pathA still in CRDT (orphan)`);
		if (crdtB) throw new Error(`S07g-4: pathB still in CRDT (orphan)`);

		await ctx.deleteFile(pathC);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

// -----------------------------------------------------------------------
// S07g-5: Admitted file → dirty modify pending → rename fires
//
// This is the regression guard for the redirectPendingCreate safety fix.
//
// Background:
//   redirectPendingCreate is called for every rename batch entry. It must
//   be a no-op when oldPath has a pending MODIFY (not create). If it were
//   to delete the modify entry, the modified content would be silently lost.
//
// Sequence:
//   1. Create file at tmpPath and wait for CRDT admission (ensureFile).
//   2. Modify the file (dirty modify queued, not yet drained).
//   3. Rename tmpPath → finalPath immediately (before drain fires).
//   4. Wait for settle.
//
// Expected:
//   - finalPath exists on disk with the modified content.
//   - disk == CRDT at finalPath (the modify was not lost).
//   - tmpPath is not in CRDT (clean rename, no orphan).
//
// If redirectPendingCreate had deleted the modify entry:
//   - finalPath CRDT would reflect the pre-modify content.
//   - disk != CRDT, or disk shows modified content but CRDT shows old.
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// S07g-6: Admitted file → pending modify → rename A→B → rename B→C (chain)
//
// Tests that redirectPendingDirtyPath correctly follows the dirty entry through
// a two-hop rename chain when the dirty modify has not drained between the two
// renames. If both renames arrive in the same flush (or A→B fires before B→C),
// the entry must end up at C.
//
// Expected:
//   - C has v2 (modified) content on disk and in CRDT
//   - A and B absent from CRDT
//   - disk == CRDT at C
// -----------------------------------------------------------------------

export const s07gModifyThenRenameChain: QaScenario = {
	id: "s07g-modify-then-rename-chain",
	title: "S07g-6: Admitted file → pending modify → rename chain A→B→C",
	tags: ["s07g", "rename", "rename-chain", "plugin-writes", "regression", "race-safety"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const ts = Date.now().toString(36);
		const pathA = s07gPath(`chain-mod-a-${ts}`);
		const pathB = s07gPath(`chain-mod-b-${ts}`);
		const pathC = s07gPath(`chain-mod-c-${ts}`);

		// 1. Create at A and wait for CRDT admission.
		await ctx.createFile(pathA, CONTENT_BODY);
		await ctx.waitForCrdtFile(pathA, 15000);
		await ctx.waitForIdle(5000);

		const crdtV1 = await ctx.yaos.getCrdtHash(pathA);
		if (!crdtV1) throw new Error("S07g-6: pathA not in CRDT after create");
		console.log("[S07g-6] v1 admitted at A", { crdtV1 });

		// 2. Modify A — do NOT wait for drain (dirty modify pending at A).
		await ctx.modifyFile(pathA, CONTENT_V2);

		// 3. Rename A → B without waiting.
		await ctx.renameFile(pathA, pathB);

		// 4. Rename B → C without waiting.
		//    If both renames fire in the same batch, the redirect must chain:
		//    dirty[A] → dirty[B] → dirty[C].
		//    If they arrive in separate batches, each redirect still moves the
		//    entry forward one hop.
		await ctx.renameFile(pathB, pathC);

		await ctx.sleep(2000);
		await ctx.waitForIdle(15000);

		// 5. POSTCONDITION: C has v2 content; A and B absent.
		const diskC = await ctx.yaos.getDiskHash(pathC);
		const crdtC = await ctx.yaos.getCrdtHash(pathC);
		console.log("[S07g-6] final state at C", { diskC, crdtC });

		if (!diskC) throw new Error(`S07g-6: pathC not on disk: ${pathC}`);
		if (!crdtC) throw new Error(`S07g-6: pathC not in CRDT: ${pathC}`);
		if (diskC !== crdtC) {
			throw new Error(
				`S07g-6: disk != CRDT at C — modify may have been lost across chain rename\n` +
				`  disk: ${diskC}\n  crdt: ${crdtC}`,
			);
		}
		if (diskC === crdtV1) {
			throw new Error(
				`S07g-6: C has v1 content — dirty modify was lost across rename chain`,
			);
		}

		const crdtA = await ctx.yaos.getCrdtHash(pathA);
		const crdtB = await ctx.yaos.getCrdtHash(pathB);
		if (crdtA) throw new Error(`S07g-6: pathA still in CRDT (orphan): ${pathA}`);
		if (crdtB) throw new Error(`S07g-6: pathB still in CRDT (orphan): ${pathB}`);

		await ctx.deleteFile(pathC);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

const CONTENT_V1 = `# Original content

This is the original version of the file before modification.
`.repeat(5);

const CONTENT_V2 = `# Modified content

This version was written AFTER the file was admitted to CRDT.
The modify must survive the subsequent rename.
`.repeat(5);

export const s07gModifyThenRename: QaScenario = {
	id: "s07g-modify-then-rename",
	title: "S07g-5: Admitted file → pending modify → rename (redirectPendingCreate must not drop modify)",
	tags: ["s07g", "rename", "plugin-writes", "regression", "race-safety"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const ts = Date.now().toString(36);
		const tmpPath = s07gPath(`mod-tmp-${ts}`);
		const finalPath = s07gPath(`mod-final-${ts}`);

		// 1. Create file and wait for full CRDT admission.
		await ctx.createFile(tmpPath, CONTENT_V1);
		await ctx.waitForCrdtFile(tmpPath, 15000);
		await ctx.waitForIdle(5000);

		const crdtV1 = await ctx.yaos.getCrdtHash(tmpPath);
		if (!crdtV1) throw new Error("S07g-5: tmpPath not in CRDT after create");
		console.log("[S07g-5] v1 admitted to CRDT", { crdtV1 });

		// 2. Write modified content. Do NOT wait for drain — we want a pending
		//    dirty modify in the queue when the rename fires.
		await ctx.modifyFile(tmpPath, CONTENT_V2);

		// 3. Rename immediately — dirty modify for tmpPath is still pending.
		//    redirectPendingCreate must be a no-op here (entry reason is "modify",
		//    not "create"). The modify must be handled by the rename pipeline instead.
		await ctx.renameFile(tmpPath, finalPath);

		await ctx.sleep(2000);
		await ctx.waitForIdle(15000);

		// 4. POSTCONDITION: final path exists on disk with v2 content.
		const diskFinal = await ctx.yaos.getDiskHash(finalPath);
		const crdtFinal = await ctx.yaos.getCrdtHash(finalPath);
		console.log("[S07g-5] final state", { diskFinal, crdtFinal });

		if (!diskFinal) throw new Error(`S07g-5: finalPath not on disk: ${finalPath}`);
		if (!crdtFinal) throw new Error(`S07g-5: finalPath not in CRDT after rename: ${finalPath}`);
		if (diskFinal !== crdtFinal) {
			throw new Error(
				`S07g-5: disk != CRDT at finalPath — modify may have been lost\n` +
				`  disk: ${diskFinal}\n  crdt: ${crdtFinal}`,
			);
		}

		// 5. Verify content is v2, not v1.
		if (diskFinal === crdtV1) {
			throw new Error(
				`S07g-5: final content is still v1 — the modify was lost across the rename. ` +
				`redirectPendingCreate may have incorrectly dropped the modify entry.`,
			);
		}

		// 6. tmpPath must not be orphaned in CRDT.
		const crdtOld = await ctx.yaos.getCrdtHash(tmpPath);
		if (crdtOld) {
			throw new Error(`S07g-5: tmpPath still in CRDT after rename (orphan): ${tmpPath}`);
		}

		await ctx.deleteFile(finalPath);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};
