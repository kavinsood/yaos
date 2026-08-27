import { strict as assert } from "node:assert";
import { safeBlobPath, safeMarkdownPath } from "../../src/sync/pathPolicy";
import { suite } from "../harness.ts";

const s = suite("schema4-path-policy");

s.test("markdown admissions share the canonical fail-closed path boundary", () => {
	for (const path of [
		".obsidian/plugins/yaos/main.md",
		".trash/recovered.md",
		"../outside.md",
		"/absolute.md",
		"C:/vault.md",
		"notes/not-markdown.txt",
		"notes/CON.md",
		"notes/bad?.md",
		"notes/cafe\u0301.md",
		"notes\\windows.md",
	]) {
		assert.equal(safeMarkdownPath(path), null, `${path} is rejected`);
	}
	assert.equal(safeMarkdownPath("notes/Café.md"), "notes/Café.md");
	assert.equal(safeMarkdownPath("private/note.md", ["private/"]), null);
	assert.equal(safeMarkdownPath("custom/config.md", [], "custom"), null);
});

s.test("blob admissions validate both path and content reference", () => {
	const validRef = { hash: "a".repeat(64), size: 12 };
	assert.equal(safeBlobPath("assets/image.png", [], ".obsidian", validRef), "assets/image.png");
	assert.equal(safeBlobPath("assets/note.md", [], ".obsidian", validRef), null);
	assert.equal(safeBlobPath("assets/image.png", [], ".obsidian", { ...validRef, hash: "bad" }), null);
	assert.equal(safeBlobPath("assets/image.png", [], ".obsidian", { ...validRef, size: -1 }), null);
	assert.equal(safeBlobPath("private/image.png", ["private/"], ".obsidian", validRef), null);
});

await s.done();
