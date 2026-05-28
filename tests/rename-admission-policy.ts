/**
 * Unit tests for rename admission policy.
 *
 * Covers the 4-case decision matrix:
 *   syncable → syncable   = rename
 *   syncable → excluded   = tombstone-old
 *   excluded → syncable   = admit-new
 *   excluded → excluded   = ignore
 */

import { decideRenameAdmission } from "../src/sync/policy/renameAdmissionPolicy";
import { admitMarkdownPath } from "../src/sync/policy/pathAdmissionPolicy";
import type { PathAdmission } from "../src/sync/policy/pathAdmissionPolicy";

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

// Helpers
const syncable = (path: string): PathAdmission => ({ kind: "syncable", path });
const excluded = (path: string, reason: string): PathAdmission => ({ kind: "excluded", path, reason });

console.log("\n--- Test 1: syncable → syncable = rename ---");
{
	const result = decideRenameAdmission({
		oldPath: "notes/a.md",
		newPath: "notes/b.md",
		oldAdmission: syncable("notes/a.md"),
		newAdmission: syncable("notes/b.md"),
	});
	assert(result.kind === "rename", "kind is rename");
	assert(result.oldPath === "notes/a.md", "oldPath preserved");
	assert(result.newPath === "notes/b.md", "newPath preserved");
}

console.log("\n--- Test 2: syncable → excluded = tombstone-old ---");
{
	const result = decideRenameAdmission({
		oldPath: "notes/a.md",
		newPath: ".trash/a.md",
		oldAdmission: syncable("notes/a.md"),
		newAdmission: excluded(".trash/a.md", "excluded-by-pattern"),
	});
	assert(result.kind === "tombstone-old", "kind is tombstone-old");
	assert(result.oldPath === "notes/a.md", "oldPath preserved");
	assert(result.newPath === ".trash/a.md", "newPath preserved");
	assert("reason" in result && result.reason.includes("destination-excluded"), "reason includes destination-excluded");
}

console.log("\n--- Test 3: excluded → syncable = admit-new ---");
{
	const result = decideRenameAdmission({
		oldPath: ".trash/recovered.md",
		newPath: "notes/recovered.md",
		oldAdmission: excluded(".trash/recovered.md", "excluded-by-pattern"),
		newAdmission: syncable("notes/recovered.md"),
	});
	assert(result.kind === "admit-new", "kind is admit-new");
	assert(result.oldPath === ".trash/recovered.md", "oldPath preserved");
	assert(result.newPath === "notes/recovered.md", "newPath preserved");
	assert("reason" in result && result.reason.includes("source-excluded"), "reason includes source-excluded");
}

console.log("\n--- Test 4: excluded → excluded = ignore ---");
{
	const result = decideRenameAdmission({
		oldPath: ".trash/old.md",
		newPath: ".obsidian/plugins/moved.md",
		oldAdmission: excluded(".trash/old.md", "excluded-by-pattern"),
		newAdmission: excluded(".obsidian/plugins/moved.md", "excluded-by-pattern"),
	});
	assert(result.kind === "ignore", "kind is ignore");
	assert("reason" in result && result.reason === "excluded-to-excluded", "reason is excluded-to-excluded");
}

console.log("\n--- Test 5: reason codes propagate from PathAdmission ---");
{
	const result = decideRenameAdmission({
		oldPath: "notes/a.md",
		newPath: "templates/a.md",
		oldAdmission: syncable("notes/a.md"),
		newAdmission: excluded("templates/a.md", "excluded-by-pattern"),
	});
	assert(result.kind === "tombstone-old", "tombstone-old for user-excluded destination");
	assert("reason" in result && result.reason.includes("excluded-by-pattern"), "reason carries exclusion detail");
}

console.log("\n--- Test 6: admitMarkdownPath integration ---");
{
	// Verify that admitMarkdownPath + decideRenameAdmission compose correctly.
	const oldAdmission = admitMarkdownPath("notes/file.md", ["templates/"], ".obsidian");
	const newAdmission = admitMarkdownPath("templates/file.md", ["templates/"], ".obsidian");

	assert(oldAdmission.kind === "syncable", "notes/file.md is syncable");
	assert(newAdmission.kind === "excluded", "templates/file.md is excluded");

	const result = decideRenameAdmission({
		oldPath: "notes/file.md",
		newPath: "templates/file.md",
		oldAdmission,
		newAdmission,
	});
	assert(result.kind === "tombstone-old", "integration: syncable → user-excluded = tombstone-old");
}

console.log("\n--- Test 7: admitMarkdownPath rejects non-.md ---");
{
	const admission = admitMarkdownPath("image.png", [], ".obsidian");
	assert(admission.kind === "excluded", "non-.md is excluded");
	assert(admission.reason === "not-markdown", "reason is not-markdown");
}

console.log("\n--- Test 8: admitMarkdownPath excludes config dir ---");
{
	const admission = admitMarkdownPath(".obsidian/workspace.md", [], ".obsidian");
	assert(admission.kind === "excluded", "config dir path is excluded");
	assert(admission.reason === "excluded-by-pattern", "reason is excluded-by-pattern");
}

console.log("\n--- Test 9: admitMarkdownPath excludes .trash ---");
{
	const admission = admitMarkdownPath(".trash/deleted.md", [], ".obsidian");
	assert(admission.kind === "excluded", ".trash path is excluded");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
