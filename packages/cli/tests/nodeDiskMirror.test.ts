import assert from "node:assert/strict";
import test from "node:test";
import { splitSafeVaultPathParts } from "../src/nodeDiskMirror";
import { normalizeVaultPath } from "../../../src/utils/normalizeVaultPath";

test("splitSafeVaultPathParts rejects dot-segment traversal", () => {
	assert.throws(
		() => splitSafeVaultPathParts("folder/../victim.md", normalizeVaultPath("folder/../victim.md")),
		/Path traversal rejected/,
	);
	assert.throws(
		() => splitSafeVaultPathParts("folder/./victim.md", normalizeVaultPath("folder/./victim.md")),
		/Path traversal rejected/,
	);
});

test("splitSafeVaultPathParts accepts normalized vault-relative paths", () => {
	assert.deepEqual(
		splitSafeVaultPathParts("folder/note.md", normalizeVaultPath("folder/note.md")),
		["folder", "note.md"],
	);
});
