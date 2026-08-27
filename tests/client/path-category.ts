/**
 * Tests for path category classification and category-aware rename planning.
 *
 * Tests classifySyncPath and planCategoryRenameAction — the same functions
 * main.ts uses for rename admission.
 */

import { classifySyncPath } from "../../src/paths/pathCategory";
import { isExcluded } from "../../src/sync/exclude";
import { planCategoryRenameAction } from "../../src/sync/policy/renameAdmissionPolicy";
import type { RenameAction } from "../../src/sync/policy/renameAdmissionPolicy";
import { suite } from "../harness.ts";

const s = suite("path-category");

const EXCLUDE = ["templates/", "archive/private/"];
const CONFIG = ".obsidian";

function classify(path: string) {
	return classifySyncPath({ path, excludePatterns: EXCLUDE, configDir: CONFIG });
}

function planRename(oldPath: string, newPath: string): RenameAction {
	return planCategoryRenameAction({
		oldCategory: classify(oldPath),
		newCategory: classify(newPath),
	});
}

// -----------------------------------------------------------------------
// Category classification tests
// -----------------------------------------------------------------------

s.section("Test 1: .md file = markdown");
{
	const cat = classify("notes/a.md");
	s.check(cat.kind === "markdown", "notes/a.md is markdown");
	s.check(cat.path.canonicalKey === "notes/a.md", "canonical key correct");
	s.check(cat.path.displayPath === "notes/a.md", "displayPath preserved");
}

s.section("Test 2: .png file = blob");
{
	const cat = classify("assets/image.png");
	s.check(cat.kind === "blob", "assets/image.png is blob");
}

s.section("Test 3: .obsidian/ path = excluded");
{
	const cat = classify(".obsidian/workspace.md");
	s.check(cat.kind === "excluded", ".obsidian/workspace.md is excluded");
	s.check(cat.kind === "excluded" && cat.reason === "excluded-by-pattern", "reason correct");
}

s.section("Test 4: .trash/ path = excluded");
{
	const cat = classify(".trash/deleted.md");
	s.check(cat.kind === "excluded", ".trash/deleted.md is excluded");
}

s.section("Test 5: user-excluded prefix = excluded");
{
	const cat = classify("templates/daily.md");
	s.check(cat.kind === "excluded", "templates/daily.md excluded by user pattern");
}

s.section("Test 6: NFD markdown classifies as markdown after canonicalization");
{
	const nfd = "notes/A\u0300.md";
	const cat = classify(nfd);
	s.check(cat.kind === "markdown", "NFD .md path is markdown");
	s.check(cat.path.canonicalKey === "notes/\u00C0.md", "canonicalKey is NFC");
	s.check(cat.path.displayPath === nfd, "displayPath preserves NFD input");
}

s.section("Test 7: backslash path classifies correctly");
{
	const cat = classify("notes\\sub\\file.md");
	s.check(cat.kind === "markdown", "backslash path is markdown");
	s.check(cat.path.canonicalKey === "notes/sub/file.md", "canonicalKey normalized");
	s.check(cat.path.displayPath === "notes\\sub\\file.md", "displayPath preserved");
}

s.section("Test 8: non-.md non-excluded = blob");
{
	s.check(classify("data/file.json").kind === "blob", ".json is blob");
	s.check(classify("images/photo.jpg").kind === "blob", ".jpg is blob");
}
s.section("Test 8b: exclusions use canonical separator and Unicode identity");
{
	s.check(
		isExcluded("././templates\\daily.md", EXCLUDE, CONFIG),
		"repeated ./ and backslashes still match a configured exclusion",
	);
	s.check(
		isExcluded("/.obsidian//workspace.md", EXCLUDE, CONFIG),
		"leading and repeated slashes still match the config directory",
	);
	s.check(
		isExcluded("archive/cafe\u0301/note.md", ["archive/caf\u00E9/"], CONFIG),
		"NFD path matches an NFC exclusion prefix",
	);
}


// -----------------------------------------------------------------------
// Rename category matrix — full 9-case matrix + same-identity
// -----------------------------------------------------------------------

s.section("Test 9: markdown -> markdown = queue-markdown-rename");
{
	const action = planRename("notes/a.md", "notes/b.md");
	s.check(action.kind === "queue-markdown-rename", "markdown→markdown: queue-markdown-rename");
	s.check(action.kind === "queue-markdown-rename" && action.oldPath === "notes/a.md", "uses displayPath for oldPath");
	s.check(action.kind === "queue-markdown-rename" && action.newPath === "notes/b.md", "uses displayPath for newPath");
}

s.section("Test 10: markdown -> excluded = tombstone-markdown");
{
	const action = planRename("notes/a.md", ".trash/a.md");
	s.check(action.kind === "tombstone-markdown", "markdown→excluded: tombstone-markdown");
	s.check(action.kind === "tombstone-markdown" && action.oldPath === "notes/a.md", "tombstones displayPath");
}

s.section("Test 11: excluded -> markdown = admit-markdown");
{
	const action = planRename(".trash/a.md", "notes/a.md");
	s.check(action.kind === "admit-markdown", "excluded→markdown: admit-markdown");
	s.check(action.kind === "admit-markdown" && action.newPath === "notes/a.md", "admits displayPath");
}

s.section("Test 12: blob -> blob = queue-blob-rename");
{
	const action = planRename("assets/a.png", "assets/b.png");
	s.check(action.kind === "queue-blob-rename", "blob→blob: queue-blob-rename");
}

s.section("Test 13: blob -> excluded = defer-blob-to-events");
{
	const action = planRename("assets/a.png", ".trash/a.png");
	s.check(action.kind === "defer-blob-to-events", "blob→excluded: defer-blob-to-events");
}

s.section("Test 14: excluded -> blob = admit-blob-via-event");
{
	const action = planRename(".trash/a.png", "assets/a.png");
	s.check(action.kind === "admit-blob-via-event", "excluded→blob: admit-blob-via-event");
}

s.section("Test 15: markdown -> blob = tombstone-markdown");
{
	const action = planRename("notes/diagram.md", "assets/diagram.png");
	s.check(action.kind === "tombstone-markdown", "markdown→blob: tombstone-markdown");
}

s.section("Test 16: blob -> markdown = admit-markdown");
{
	const action = planRename("assets/notes.png", "notes/imported.md");
	s.check(action.kind === "admit-markdown", "blob→markdown: admit-markdown");
}

s.section("Test 17: excluded -> excluded = ignore");
{
	const action = planRename(".trash/a.md", "templates/a.md");
	s.check(action.kind === "ignore", "excluded→excluded: ignore");
}

// -----------------------------------------------------------------------
// Same-identity (NFC/NFD equivalent) = no-op
// -----------------------------------------------------------------------

s.section("Test 18: NFC -> NFD-equivalent = same-identity (no CRDT mutation)");
{
	const nfc = "notes/\u00C0.md";
	const nfd = "notes/A\u0300.md";
	const action = planRename(nfc, nfd);
	s.check(action.kind === "same-identity", "NFC→NFD: same-identity (no-op)");
	s.check(action.kind === "same-identity" && action.oldPath === nfc, "preserves old displayPath");
	s.check(action.kind === "same-identity" && action.newPath === nfd, "preserves new displayPath");
}

// -----------------------------------------------------------------------
// Execution paths use displayPath, not normalizedPath
// -----------------------------------------------------------------------

s.section("Test 19: backslash rename uses displayPath for execution");
{
	// Backslash paths should pass through to execution unchanged.
	const action = planRename("notes\\old.md", "notes\\new.md");
	s.check(action.kind === "queue-markdown-rename", "backslash: queue-markdown-rename");
	s.check(action.kind === "queue-markdown-rename" && action.oldPath === "notes\\old.md", "oldPath is raw displayPath");
	s.check(action.kind === "queue-markdown-rename" && action.newPath === "notes\\new.md", "newPath is raw displayPath");
}

s.section("Test 20: dirty path cleanup uses displayPath");
{
	const action = planRename("notes/file.md", ".trash/file.md");
	s.check(action.kind === "tombstone-markdown", "tombstone action");
	s.check(action.kind === "tombstone-markdown" && action.dropDirty.includes("notes/file.md"), "drops old displayPath");
	s.check(action.kind === "tombstone-markdown" && action.dropDirty.includes(".trash/file.md"), "drops new displayPath");
}
await s.done();
