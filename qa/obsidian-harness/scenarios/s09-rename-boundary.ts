/**
 * S09 — Rename boundary scenarios.
 *
 * Class: Syncable/excluded path boundary cases for redirectPendingDirtyPath.
 *
 * These scenarios exercise the edges of what happens when a rename crosses
 * the boundary between syncable and excluded paths.
 *
 * Variants:
 *   S09a: modify syncable path → rename into excluded (.trash/) — dirty modify must not
 *         create a ghost CRDT entry at the excluded path.
 *   S09b: create in excluded path → rename into syncable path — final path must be
 *         admitted cleanly as a new file.
 *   S09c: two dirty files — rename one onto the other (collision/overwrite) — final
 *         CRDT must match disk (disk is authoritative).
 */

import type { QaScenario } from "../types";

const FOLDER = "QA-s09";

// .trash/ is always excluded from sync regardless of user exclude patterns.
// We use it as a guaranteed excluded path for S09a and S09b.
const TRASH_FOLDER = ".trash";

function s09Path(suffix: string): string {
	return `${FOLDER}/${suffix}.md`;
}

function trashPath(suffix: string): string {
	return `${TRASH_FOLDER}/${suffix}.md`;
}

const CONTENT_A = `# File A

Content belonging to file A, written before a rename.
`.repeat(8);

const CONTENT_A_V2 = `# File A — modified

This is the modified version of file A, written after CRDT admission.
The modify must not be replayed at the excluded destination.
`.repeat(8);

const CONTENT_B = `# File B

Content belonging to file B, separate from A.
`.repeat(8);

// -----------------------------------------------------------------------
// S09a: modify syncable path → rename into excluded (.trash/)
//
// Sequence:
//   1. Create note.md, wait for CRDT admission.
//   2. Modify note.md (dirty modify pending, not yet drained).
//   3. Rename note.md → .trash/note.md (crosses exclude boundary).
//
// Expected:
//   - note.md CRDT entry removed/tombstoned (file was renamed out).
//   - .trash/note.md NEVER gets a CRDT entry (excluded path).
//   - redirectPendingDirtyPath redirects the dirty modify to .trash/note.md,
//     but syncFileFromDisk checks isMarkdownPathSyncable and silently no-ops.
//
// This is primarily a safety test: verify that redirecting a dirty entry
// to an excluded path does NOT create a ghost CRDT entry there.
// -----------------------------------------------------------------------

export const s09aRenameIntoExcluded: QaScenario = {
	id: "s09a-rename-into-excluded",
	title: "S09a: modify syncable → rename into .trash/ (excluded path, no ghost CRDT)",
	tags: ["s09", "rename", "excluded-path", "safety", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const ts = Date.now().toString(36);
		const syncPath = s09Path(`trash-src-${ts}`);
		const excludedDest = trashPath(`trash-dst-${ts}`);

		// Ensure .trash/ directory exists before renaming into it.
		// On a fresh QA vault .trash/ may not exist yet. writeAdapterFile
		// creates parent dirs via adapter.mkdir before writing.
		await ctx.writeAdapterFile(trashPath(`.keep-${ts}`), "");

		// 1. Create syncable file and wait for CRDT admission.
		await ctx.createFile(syncPath, CONTENT_A);
		await ctx.waitForCrdtFile(syncPath, 15000);
		await ctx.waitForIdle(5000);

		const crdtV1 = await ctx.yaos.getCrdtHash(syncPath);
		if (!crdtV1) throw new Error("S09a: syncPath not in CRDT after create");
		console.log("[S09a] admitted to CRDT at syncPath", { crdtV1 });

		// 2. Modify — do NOT wait for drain.
		await ctx.modifyFile(syncPath, CONTENT_A_V2);

		// 3. Rename into .trash/ — crosses exclude boundary.
		await ctx.renameFile(syncPath, excludedDest);

		await ctx.sleep(2000);
		await ctx.waitForIdle(15000);

		// 4. POSTCONDITION: syncPath must NOT be in CRDT (was renamed away).
		const crdtAtSrc = await ctx.yaos.getCrdtHash(syncPath);
		if (crdtAtSrc) {
			throw new Error(
				`S09a: syncPath still in CRDT after rename-into-excluded (orphan): ${syncPath}`,
			);
		}

		// 5. POSTCONDITION: .trash/ path must NOT be in CRDT (excluded).
		//    If redirectPendingDirtyPath leaked a dirty modify into an excluded path
		//    and syncFileFromDisk failed to gate it, a ghost entry appears here.
		const crdtAtDest = await ctx.yaos.getCrdtHash(excludedDest);
		if (crdtAtDest) {
			throw new Error(
				`S09a: excluded path has a CRDT entry — ghost entry created at .trash/: ${excludedDest}`,
			);
		}

		console.log("[S09a] no ghost CRDT entry at excluded destination", { excludedDest });

		// Cleanup: remove from trash and the .keep placeholder.
		await ctx.deleteAdapterFile(excludedDest);
		await ctx.deleteAdapterFile(trashPath(`.keep-${ts}`));
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

// -----------------------------------------------------------------------
// S09b: create in excluded path → rename into syncable path
//
// Sequence:
//   1. Write a file directly into .trash/ (adapter write, never syncable).
//   2. Rename .trash/draft.md → notes/final.md (crosses into syncable).
//
// Expected:
//   - notes/final.md admitted to CRDT as a fresh create (no prior identity).
//   - disk == CRDT at notes/final.md.
//   - .trash/draft.md has no CRDT entry (was never syncable).
//
// NOTE: This test depends on Obsidian firing a vault `create` event at the
// destination path when renaming from an excluded path. If Obsidian only
// fires `rename` (with no `create` at the destination), the file is missed.
// The scenario records whether admission happened and fails clearly if not.
// -----------------------------------------------------------------------

export const s09bRenameFromExcluded: QaScenario = {
	id: "s09b-rename-from-excluded",
	title: "S09b: create in .trash/ → rename into syncable path (clean admission)",
	tags: ["s09", "rename", "excluded-path", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const ts = Date.now().toString(36);
		const excludedSrc = trashPath(`from-trash-${ts}`);
		const syncDest = s09Path(`from-trash-dst-${ts}`);

		// 1. Write file into .trash/ via adapter (never triggers CRDT create).
		//    writeAdapterFile creates the .trash/ dir if it doesn't exist.
		//    NOTE: Obsidian does NOT index .trash/, so waitForFile() will always
		//    time out for excluded paths. We skip it — adapter.write is synchronous
		//    enough that the file is ready immediately for vault.rename.
		await ctx.writeAdapterFile(excludedSrc, CONTENT_A);
		await ctx.sleep(200); // let the adapter flush

		// Confirm .trash/ path has no CRDT entry.
		const crdtAtSrc = await ctx.yaos.getCrdtHash(excludedSrc);
		if (crdtAtSrc) {
			throw new Error(
				`S09b: excluded source unexpectedly has a CRDT entry before rename: ${excludedSrc}`,
			);
		}
		console.log("[S09b] excluded source confirmed not in CRDT", { excludedSrc });

		// 2. Rename into syncable path via adapter.
		//    vault.rename requires the file to be indexed by Obsidian, which excluded
		//    paths are not. Use adapter.rename directly to move the file.
		//    The key question is whether this fires a vault `create` event at syncDest.
		await (ctx.app.vault.adapter as unknown as { rename(src: string, dst: string): Promise<void> })
			.rename(excludedSrc, syncDest);

		// Wait for Obsidian to settle. Whether syncDest gets admitted depends on
		// whether Obsidian fires a vault `create` event at the destination.
		// If only a `rename` event fires (no `create`), applyRenameBatch finds no
		// fileId for the excluded source and drops the rename silently — product gap.
		await ctx.sleep(3000);
		await ctx.waitForIdle(15000);

		// 3. POSTCONDITION: syncDest must be on disk.
		const diskDest = await ctx.yaos.getDiskHash(syncDest);
		if (!diskDest) {
			throw new Error(`S09b: syncDest not on disk after rename: ${syncDest}`);
		}

		// 4. Check CRDT admission. Document the product gap clearly on failure.
		const crdtDest = await ctx.yaos.getCrdtHash(syncDest);
		console.log("[S09b] syncDest state", { diskDest, crdtDest });

		if (!crdtDest) {
			throw new Error(
				`S09b: syncDest not in CRDT after rename-from-excluded.\n` +
				`PRODUCT GAP: Obsidian fires only a vault rename event (no create at destination) ` +
				`when renaming from an excluded path. applyRenameBatch finds no fileId for the ` +
				`excluded source and drops the rename. No create event fires at syncDest. ` +
				`Files renamed from excluded paths into the vault are silently missed by CRDT sync.\n` +
				`Path: ${syncDest}`,
			);
		}

		if (diskDest !== crdtDest) {
			throw new Error(
				`S09b: disk != CRDT at syncDest\n  disk: ${diskDest}\n  crdt: ${crdtDest}`,
			);
		}

		await ctx.deleteFile(syncDest);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};

// -----------------------------------------------------------------------
// S09c: dirty rename into a previously occupied but now freed path
//
// NOTE: This is NOT a true overwrite/collision test. Obsidian's vault.rename
// blocks renames onto existing files ("Destination file already exists!").
// True simultaneous-dirty collision requires adapter-level file replacement
// outside Obsidian's guarded vault API — that is a separate scenario.
//
// What this tests: A has a pending dirty modify. B exists and has been
// deleted (freeing the path slot). A is renamed onto the vacated B path.
// The pending dirty modify must follow the rename and CRDT at B must
// converge to A's modified content.
//
// Sequence:
//   1. Create A.md, wait for CRDT.
//   2. Modify A.md (leave dirty, do not drain).
//   3. Create B.md, wait for CRDT.
//   4. Delete B.md (frees the path slot).
//   5. Rename A.md → B.md.
//
// Expected:
//   - disk == CRDT at B.md (A's modified content)
//   - A.md absent from CRDT
// -----------------------------------------------------------------------

export const s09cRenameToVacatedPath: QaScenario = {
	id: "s09c-rename-to-vacated-path",
	title: "S09c: dirty rename into vacated path (A dirty → delete B → rename A onto B)",
	tags: ["s09", "rename", "vacated-path", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const ts = Date.now().toString(36);
		const pathA = s09Path(`collision-a-${ts}`);
		const pathB = s09Path(`collision-b-${ts}`);

		// 1. Create A, wait for CRDT, then modify (leave dirty).
		await ctx.createFile(pathA, CONTENT_A);
		await ctx.waitForCrdtFile(pathA, 15000);
		await ctx.waitForIdle(5000);
		await ctx.modifyFile(pathA, CONTENT_A_V2);
		console.log("[S09c] A modified (dirty), B about to be created");

		// 2. Create B, wait for CRDT admission.
		await ctx.createFile(pathB, CONTENT_B);
		await ctx.waitForCrdtFile(pathB, 15000);
		await ctx.waitForIdle(5000);
		console.log("[S09c] B created and admitted, A and B both potentially dirty");

		// NOTE: Obsidian's vault.rename blocks renames onto existing files with
		// "Destination file already exists!". This is not a simultaneous-dirty
		// collision test — it tests a dirty rename into a vacated path slot.
		// A true overwrite collision requires adapter-level file replacement.
		await ctx.deleteFile(pathB);
		await ctx.waitForIdle(5000);

		// 3. Rename A → B (A's v2 content lands at B path).
		//    A may still have a pending dirty modify. redirectPendingDirtyPath
		//    moves it to B. syncFileFromDisk("B", "modify") re-reads disk → v2.
		await ctx.renameFile(pathA, pathB);

		await ctx.sleep(2000);
		await ctx.waitForIdle(15000);

		// 4. POSTCONDITION: disk at B has A's v2 content; CRDT matches.
		const diskB = await ctx.yaos.getDiskHash(pathB);
		const crdtB = await ctx.yaos.getCrdtHash(pathB);
		console.log("[S09c] final state at B", { diskB, crdtB });

		if (!diskB) throw new Error(`S09c: pathB not on disk after rename: ${pathB}`);
		if (!crdtB) throw new Error(`S09c: pathB not in CRDT after rename: ${pathB}`);
		if (diskB !== crdtB) {
			throw new Error(
				`S09c: disk != CRDT at B — dirty modify redirect may have suppressed sync\n` +
				`  disk: ${diskB}\n  crdt: ${crdtB}`,
			);
		}

		// A must be absent from CRDT.
		const crdtA = await ctx.yaos.getCrdtHash(pathA);
		if (crdtA) {
			throw new Error(`S09c: pathA still in CRDT after rename (orphan): ${pathA}`);
		}

		await ctx.deleteFile(pathB);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies(FOLDER);
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};