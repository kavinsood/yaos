import { strict as assert } from "node:assert";
import {
	composeBodyOnlyProgress,
	composeMarkdownComponents,
	splitMarkdownComponents,
} from "../../src/sync/frontmatterBoundary";
import { suite } from "../harness.ts";

const s = suite("frontmatter-boundary");

s.test("splits exact properties bytes from the body without rewriting either", () => {
	const content = "---\ntitle: 'Kept'\n---\n\nBody  \n";
	const split = splitMarkdownComponents(content);
	assert.equal(split.kind, "present");
	if (split.kind !== "present") return;
	assert.equal(split.propertiesRegion, "---\ntitle: 'Kept'\n---\n");
	assert.equal(split.yamlText, "title: 'Kept'\n");
	assert.equal(split.body, "\nBody  \n");
	assert.equal(composeMarkdownComponents(split.propertiesRegion, split.body), content);
});

s.test("canonicalizes BOM and CRLF at the shared Markdown boundary", () => {
	const split = splitMarkdownComponents("\uFEFF---\r\ntitle: A\r\n---\r\nBody\r\n");
	assert.equal(split.kind, "present");
	if (split.kind !== "present") return;
	assert.equal(split.propertiesRegion, "---\ntitle: A\n---\n");
	assert.equal(split.body, "Body\n");
});

s.test("distinguishes no frontmatter from an ambiguous opening fence", () => {
	assert.equal(splitMarkdownComponents("# Heading\n---\nbody").kind, "none");
	assert.deepEqual(splitMarkdownComponents("---\ntitle: broken"), {
		kind: "ambiguous",
		reason: "missing-closing-fence",
		content: "---\ntitle: broken",
	});
});

s.test("holds current properties while advancing an incoming body", () => {
	const result = composeBodyOnlyProgress(
		"---\ntitle: safe\n---\nold body",
		"---\ntitle: [unsafe\n---\nnew body",
	);
	assert.equal(result.kind, "composed");
	if (result.kind !== "composed") return;
	assert.equal(result.content, "---\ntitle: safe\n---\nnew body");
	assert.equal(result.incomingPropertiesRegion, "---\ntitle: [unsafe\n---\n");
});

await s.done();
