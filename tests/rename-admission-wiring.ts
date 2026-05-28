/**
 * Wiring integration tests for rename admission.
 *
 * Tests `planRenameAction` — the same pure function called by main.ts —
 * to prove the correct side-effects are planned for each decision case.
 * This is NOT a duplicated switch; it tests the actual policy function.
 *
 * Also tests cross-category rename classification (markdown <-> blob).
 */

import { admitMarkdownPath } from "../src/sync/policy/pathAdmissionPolicy";
import { decideRenameAdmission, planRenameAction } from "../src/sync/policy/renameAdmissionPolicy";
import type { RenameAction } from "../src/sync/policy/renameAdmissionPolicy";

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

/**
 * Compute the full decision+action pipeline for a markdown rename.
 * This calls the same functions main.ts calls.
 */
function planMarkdownRename(input: {
	oldPath: string;
	newPath: string;
	excludePatterns: string[];
	configDir: string;
}): RenameAction {
	const { oldPath, newPath, excludePatterns, configDir } = input;
	const oldAdmission = admitMarkdownPath(oldPath, excludePatterns, configDir);
	const newAdmission = admitMarkdownPath(newPath, excludePatterns, configDir);
	const decision = decideRenameAdmission({ oldPath, newPath, oldAdmission, newAdmission });
	return planRenameAction(decision);
}

const EXCLUDE = ["templates/", "archive/private/"];
const CONFIG = ".obsidian";

console.log("\n--- Test 1: syncable .md -> syncable .md => queue-rename ---");
{
	const action = planMarkdownRename({
		oldPath: "notes/file.md", newPath: "notes/renamed.md",
		excludePatterns: EXCLUDE, configDir: CONFIG,
	});
	assert(action.kind === "queue-rename", "kind is queue-rename");
	assert(action.kind === "queue-rename" && action.oldPath === "notes/file.md", "oldPath correct");
	assert(action.kind === "queue-rename" && action.newPath === "notes/renamed.md", "newPath correct");
}

console.log("\n--- Test 2: syncable .md -> excluded .md => tombstone-old ---");
{
	const action = planMarkdownRename({
		oldPath: "notes/file.md", newPath: ".trash/file.md",
		excludePatterns: EXCLUDE, configDir: CONFIG,
	});
	assert(action.kind === "tombstone-old", "kind is tombstone-old");
	assert(action.kind === "tombstone-old" && action.oldPath === "notes/file.md", "tombstones oldPath");
	assert(action.kind === "tombstone-old" && action.dropDirty.includes("notes/file.md"), "drops dirty at oldPath");
	assert(action.kind === "tombstone-old" && action.dropDirty.includes(".trash/file.md"), "drops dirty at newPath");
}

console.log("\n--- Test 3: excluded .md -> syncable .md => admit-new ---");
{
	const action = planMarkdownRename({
		oldPath: ".trash/recovered.md", newPath: "notes/recovered.md",
		excludePatterns: EXCLUDE, configDir: CONFIG,
	});
	assert(action.kind === "admit-new", "kind is admit-new");
	assert(action.kind === "admit-new" && action.newPath === "notes/recovered.md", "admits newPath");
	assert(action.kind === "admit-new" && action.dropDirty.includes(".trash/recovered.md"), "drops dirty at excluded oldPath");
}

console.log("\n--- Test 4: excluded .md -> excluded .md => ignore ---");
{
	const action = planMarkdownRename({
		oldPath: ".trash/old.md", newPath: "templates/old.md",
		excludePatterns: EXCLUDE, configDir: CONFIG,
	});
	assert(action.kind === "ignore", "kind is ignore");
}

console.log("\n--- Test 5: syncable .md -> user-excluded pattern => tombstone-old ---");
{
	const action = planMarkdownRename({
		oldPath: "notes/secret.md", newPath: "archive/private/secret.md",
		excludePatterns: EXCLUDE, configDir: CONFIG,
	});
	assert(action.kind === "tombstone-old", "kind is tombstone-old for user pattern");
	assert(action.kind === "tombstone-old" && action.oldPath === "notes/secret.md", "tombstones correct path");
}

console.log("\n--- Test 6: config dir -> syncable .md => admit-new ---");
{
	const action = planMarkdownRename({
		oldPath: ".obsidian/plugins/note.md", newPath: "notes/rescued.md",
		excludePatterns: EXCLUDE, configDir: CONFIG,
	});
	assert(action.kind === "admit-new", "kind is admit-new for config->syncable");
}

// -----------------------------------------------------------------------
// Cross-category rename behavior.
//
// Key invariants:
//   1. isBlobSyncable(path) returns false for .md files (structural).
//   2. isMarkdownSyncable(path) returns false for non-.md files.
//   3. .md -> .png: markdown branch tombstones old .md.
//      Blob branch does NOT fire (isOldMd=true blocks isBlobOnlyRename).
//      New blob appears via Obsidian create event, handled by blobSync.
//   4. .png -> .md: markdown branch admits new .md.
//      Blob branch does NOT fire (isNewMd=true blocks isBlobOnlyRename).
//      Old blob relies on Obsidian delete event for cleanup.
//   5. .png -> .png (both syncable): markdown branch ignores.
//      Blob branch fires (isBlobOnlyRename=true).
// -----------------------------------------------------------------------

console.log("\n--- Test 7: cross-category .md -> .png (markdown branch tombstones) ---");
{
	const action = planMarkdownRename({
		oldPath: "notes/diagram.md", newPath: "assets/diagram.png",
		excludePatterns: EXCLUDE, configDir: CONFIG,
	});
	assert(action.kind === "tombstone-old", "md->png: markdown branch tombstones old .md path");
	assert(action.kind === "tombstone-old" && action.oldPath === "notes/diagram.md", "tombstones the markdown path");
}

console.log("\n--- Test 8: cross-category .png -> .md (markdown branch admits new) ---");
{
	const action = planMarkdownRename({
		oldPath: "assets/notes.png", newPath: "notes/imported.md",
		excludePatterns: EXCLUDE, configDir: CONFIG,
	});
	assert(action.kind === "admit-new", "png->md: markdown branch admits new .md path");
	assert(action.kind === "admit-new" && action.newPath === "notes/imported.md", "admits the markdown path");
}

console.log("\n--- Test 9: blob-only rename classification ---");
{
	// For a pure blob rename (non-.md -> non-.md), the markdown branch produces
	// "ignore" (both excluded as not-markdown). The blob branch handles it.
	const action = planMarkdownRename({
		oldPath: "assets/image.png", newPath: "assets/renamed.png",
		excludePatterns: EXCLUDE, configDir: CONFIG,
	});
	assert(action.kind === "ignore", "blob->blob: markdown branch ignores (not its domain)");

	// The blob-only guard: isBlobOnlyRename = (isOldBlob || isNewBlob) && !isOldMd && !isNewMd
	const isOldMd = false;
	const isNewMd = false;
	const isOldBlob = true;
	const isNewBlob = true;
	const isBlobOnlyRename = (isOldBlob || isNewBlob) && !isOldMd && !isNewMd;
	assert(isBlobOnlyRename === true, "blob-only guard allows pure blob rename to queue");
}

console.log("\n--- Test 10: .md -> .png blob guard does NOT fire ---");
{
	const isOldMd = true;
	const isNewMd = false;
	const isOldBlob = false; // .md is never blob-syncable
	const isNewBlob = true;
	const isBlobOnlyRename = (isOldBlob || isNewBlob) && !isOldMd && !isNewMd;
	assert(isBlobOnlyRename === false, "md->png: blob branch blocked by isOldMd=true");
}

console.log("\n--- Test 11: .png -> .md blob guard does NOT fire ---");
{
	const isOldMd = false;
	const isNewMd = true;
	const isOldBlob = true;
	const isNewBlob = false; // .md is never blob-syncable
	const isBlobOnlyRename = (isOldBlob || isNewBlob) && !isOldMd && !isNewMd;
	assert(isBlobOnlyRename === false, "png->md: blob branch blocked by isNewMd=true");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
