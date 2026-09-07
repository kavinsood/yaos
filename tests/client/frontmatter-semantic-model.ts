import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { projectFrontmatterSemantics } from "../../src/sync/frontmatterProjection";
import { FrontmatterSemanticMirror } from "../../src/sync/frontmatterSemanticMirror";
import {
	FRONTMATTER_SET_ADDS_ROOT,
	FRONTMATTER_SET_REMOVES_ROOT,
	FRONTMATTER_PRESENCE_ROOT,
	applyFrontmatterSemanticTransition,
	readFrontmatterSemanticSnapshot,
} from "../../src/sync/frontmatterSemanticModel";
import { suite } from "../harness.ts";

const s = suite("frontmatter-semantic-model");

function seed(content: string): Y.Doc {
	const doc = new Y.Doc();
	doc.getText("body").insert(0, content);
	doc.transact(() => {
		applyFrontmatterSemanticTransition(doc, content, content, (() => {
			let token = 0;
			return () => `token-${token++}`;
		})());
	});
	return doc;
}

s.test("models registers, observed-remove sets, and ordered lists separately", () => {
	const content = [
		"---",
		"title: Original",
		"tags:",
		"  - one",
		"  - two",
		"aliases:",
		"  - First",
		"  - Second",
		"unknown: kept",
		"---",
		"Body",
	].join("\n");
	const doc = seed(content);
	const snapshot = readFrontmatterSemanticSnapshot(doc);
	assert.equal(snapshot?.fields.title?.policy, "register");
	assert.deepEqual(snapshot?.fields.tags?.value, ["one", "two"]);
	assert.deepEqual(snapshot?.fields.aliases?.value, ["First", "Second"]);
	assert.equal(snapshot?.fields.unknown, undefined);
});

s.test("set removal tombstones observed adds while a concurrent unseen add survives", () => {
	const before = "---\ntags:\n  - one\n---\nBody";
	const base = seed(before);
	const remove = new Y.Doc();
	const add = new Y.Doc();
	Y.applyUpdate(remove, Y.encodeStateAsUpdate(base));
	Y.applyUpdate(add, Y.encodeStateAsUpdate(base));
	remove.transact(() => applyFrontmatterSemanticTransition(
		remove,
		before,
		"---\ntags: []\n---\nBody",
		() => "remove-unused",
	));
	add.transact(() => applyFrontmatterSemanticTransition(
		add,
		before,
		"---\ntags:\n  - one\n  - two\n---\nBody",
		() => "concurrent-two",
	));
	Y.applyUpdate(remove, Y.encodeStateAsUpdate(add, Y.encodeStateVector(base)));
	const snapshot = readFrontmatterSemanticSnapshot(remove);
	assert.deepEqual(snapshot?.fields.tags?.value, ["two"]);
	assert.equal(remove.getMap(FRONTMATTER_SET_REMOVES_ROOT).size, 1);
	assert.equal(remove.getMap(FRONTMATTER_SET_ADDS_ROOT).size, 2);
});

s.test("a concurrent unseen set add stays visible when field deletion wins presence", () => {
	const before = "---\ntags:\n  - one\n---\nBody";
	const base = seed(before);
	const remove = new Y.Doc();
	const add = new Y.Doc();
	Y.applyUpdate(remove, Y.encodeStateAsUpdate(base));
	Y.applyUpdate(add, Y.encodeStateAsUpdate(base));
	remove.clientID = 200;
	add.clientID = 100;
	remove.transact(() => applyFrontmatterSemanticTransition(remove, before, "Body", () => "unused-remove"));
	add.transact(() => applyFrontmatterSemanticTransition(
		add,
		before,
		"---\ntags:\n  - one\n  - two\n---\nBody",
		() => "unseen-add",
	));
	Y.applyUpdate(remove, Y.encodeStateAsUpdate(add, Y.encodeStateVector(base)));
	assert.equal(
		(remove.getMap(FRONTMATTER_PRESENCE_ROOT).get("tags") as { present: boolean }).present,
		false,
		"delete wins the independent presence register",
	);
	assert.deepEqual(readFrontmatterSemanticSnapshot(remove)?.fields.tags?.value, ["two"]);
});

s.test("surgical projection preserves unknown source, comments, order, and body bytes", () => {
	const original = "---\nunknown: &anchor 'kept'\n# title comment\ntitle: Old\nother: *anchor\n---\n\nBody  \n";
	const doc = seed("---\ntitle: New\n---\nBody");
	const snapshot = readFrontmatterSemanticSnapshot(doc);
	assert.ok(snapshot);
	const projected = projectFrontmatterSemantics(original, snapshot!);
	assert.equal(projected.kind, "projected");
	assert.equal(projected.content.includes("unknown: &anchor 'kept'"), true);
	assert.equal(projected.content.includes("other: *anchor"), true);
	assert.equal(projected.content.endsWith("\nBody  \n"), true);
	assert.equal(projected.content.includes("title: \"New\""), true);
});

s.test("projection stays opaque when a known quoted key cannot be source-located", () => {
	const original = "---\n\"title\": Old\nunknown: kept\n---\nBody";
	const doc = seed("---\ntitle: New\n---\nBody");
	const snapshot = readFrontmatterSemanticSnapshot(doc);
	assert.ok(snapshot);
	const projected = projectFrontmatterSemantics(original, snapshot!);
	assert.equal(projected.kind, "opaque");
	assert.equal(projected.content, original);
	if (projected.kind === "opaque") assert.equal(projected.reason, "unlocated-source:title");
});

s.test("mirror includes text and semantic state in the first local update and repairs semantic changes", async () => {
	const doc = new Y.Doc();
	const mirror = new FrontmatterSemanticMirror(doc, { createToken: () => "tag-one" });
	const updates: Uint8Array[] = [];
	doc.on("update", (update) => updates.push(update));
	doc.getText("body").insert(0, "---\ntitle: One\ntags:\n  - alpha\n---\nBody");
	assert.ok(updates.length > 0);
	const first = new Y.Doc();
	Y.applyUpdate(first, updates[0]!);
	assert.equal(first.getText("body").toString().includes("title: One"), true);
	assert.equal(readFrontmatterSemanticSnapshot(first)?.fields.title?.value, "One");

	doc.getMap("frontmatter:registers").set("title", { kind: "value", key: "title", value: "Two" });
	await Promise.resolve();
	assert.equal(doc.getText("body").toString().includes("title: \"Two\""), true);
	mirror.destroy();
});

s.test("an empty fresh note still emits semantic format in its first candidate delta", () => {
	const doc = new Y.Doc();
	const mirror = new FrontmatterSemanticMirror(doc);
	const before = Y.encodeStateVector(doc);
	assert.equal(mirror.seedCurrent(), true);
	const candidate = Y.encodeStateAsUpdate(doc, before);
	assert.ok(candidate.byteLength > 2);
	const admitted = new Y.Doc();
	Y.applyUpdate(admitted, candidate);
	assert.deepEqual(readFrontmatterSemanticSnapshot(admitted), { format: 1, fields: {} });
	mirror.destroy();
	doc.destroy();
	admitted.destroy();
});

s.test("oversized aliases stay opaque before ordered-list LCS allocation", () => {
	const before = "---\naliases:\n  - one\n---\nBody";
	const doc = seed(before);
	const aliases = Array.from({ length: 257 }, (_, index) => `  - alias-${index}`).join("\n");
	const result = applyFrontmatterSemanticTransition(
		doc,
		before,
		`---\naliases:\n${aliases}\n---\nBody`,
	);
	assert.deepEqual(result, { kind: "opaque", reason: "semantic-entry-limit:aliases" });
	assert.deepEqual(readFrontmatterSemanticSnapshot(doc)?.fields.aliases?.value, ["one"]);
	doc.destroy();
});

await s.done();
