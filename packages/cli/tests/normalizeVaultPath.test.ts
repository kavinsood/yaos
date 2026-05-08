import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVaultPath } from "../../../src/utils/normalizeVaultPath";

test("normalizeVaultPath preserves existing slash semantics", () => {
	assert.equal(normalizeVaultPath("./folder//nested\\note.md/"), "folder/nested/note.md");
	assert.equal(normalizeVaultPath("/folder/note.md"), "folder/note.md");
	assert.equal(normalizeVaultPath("folder/"), "folder");
});

test("normalizeVaultPath normalizes decomposed Unicode filenames to NFC", () => {
	const nfc = "caf\u00e9.md";
	const nfd = "cafe\u0301.md";
	assert.notEqual(nfd, nfc);
	assert.equal(normalizeVaultPath(nfd), nfc);
	assert.equal(normalizeVaultPath(nfd), normalizeVaultPath(nfc));
});
