import assert from "node:assert/strict";
import * as Y from "yjs";
import { prepareRootSemanticReset, prepareSemanticReset, ROOT_SEMANTIC_ROOTS } from "../../server/src/semanticCompaction";
import type { RootAuthoritySnapshot } from "../../server/src/vaultCatalogStore";
import { suite } from "../harness.ts";

const s = suite("semantic-compaction");

s.test("body reset preserves semantic values without carrying CRDT history", () => {
	const body = new Y.Doc({ guid: "semantic-body" });
	const text = body.getText("body");
	text.insert(0, "---\ntitle: hello\n---\nbody\n");
	for (let index = 0; index < 500; index++) {
		body.clientID = 10_000 + index;
		text.insert(text.length, "x");
		text.delete(text.length - 1, 1);
	}
	body.getMap<number>("frontmatter:meta").set("format", 1);
	body.getMap("frontmatter:registers").set("title", { kind: "value", key: "title", value: "hello" });
	const reset = prepareSemanticReset(body, "body");
	assert.equal(reset.document.getText("body").toString(), text.toString());
	assert.deepEqual(reset.document.getMap("frontmatter:registers").get("title"),
		{ kind: "value", key: "title", value: "hello" });
	assert.ok(reset.fresh.totalStructs < reset.previous.totalStructs / 10);
	assert.equal(reset.fresh.deletedStructs, 0);
	reset.document.destroy();
	body.destroy();
});

s.test("root reset preserves catalog and attachment authority", () => {
	const root = new Y.Doc({ guid: "root" });
	root.getMap("pathToId").set("resident-lie.md", "wrong-body");
	root.getMap("unknown-root").set("must", "disappear");
	root.getMap("__yaosLifecycle").set("old-operation", { kind: "rename" });
	root.getMap("__yaosLifecyclePublicationProof").set("old-operation", true);
	const hash = "a".repeat(64);
	const authority: RootAuthoritySnapshot = {
		boundarySequence: 20,
		markdown: [{ sequence: 10, bodyId: "body-1", bodyEpoch: 2, fileId: "body-1", path: "renamed.md",
			previousPath: "note.md", lifecycle: "active", generation: 3, contentHash: "b".repeat(64), size: 12 }],
		semantic: [{ sequence: 12, documentId: "canvas-1", fileId: "canvas-1", kind: "canvas",
			format: "json-canvas", formatVersion: 1, path: "Board.canvas", previousPath: "Old.canvas",
			lifecycle: "active", generation: 2, bodyEpoch: 1, contentHash: "c".repeat(64), size: 20 }],
		attachments: [
			{ sequence: 14, path: "asset.png", contentHash: hash, size: 4, mime: "image/png",
				lifecycle: "active", operationId: "attachment-upsert", createdAt: 5 },
			{ sequence: 15, path: "Board.canvas", contentHash: "d".repeat(64), size: 8, mime: null,
				lifecycle: "deleted", operationId: "attachment-delete", createdAt: 6 },
		],
		blobs: [{ contentHash: hash, size: 4, mime: "image/png", createdAt: 5 }],
	};
	const reset = prepareRootSemanticReset(root, authority);
	assert.equal(reset.document.getMap("pathToId").get("renamed.md"), "body-1");
	assert.equal(reset.document.getMap("pathToId").has("resident-lie.md"), false);
	assert.deepEqual(reset.document.getMap("pathToSemantic").get("Board.canvas"),
		{ documentId: "canvas-1", kind: "canvas", format: "json-canvas", formatVersion: 1 });
	assert.deepEqual(reset.document.getMap("pathToBlob").get("asset.png"),
		{ hash, size: 4, revision: "attachment-upsert" });
	assert.deepEqual(reset.document.getMap("blobTombstones").get("Board.canvas"),
		{ deletedAt: 6, previousHash: "d".repeat(64), revision: "attachment-delete" });
	assert.equal(reset.document.share.has("__yaosLifecycle"), false,
		"ephemeral operation markers are not current catalog authority");
	assert.equal(reset.document.share.has("__yaosLifecyclePublicationProof"), false);
	assert.equal(reset.document.share.has("unknown-root"), false);
	assert.deepEqual([...reset.document.share.keys()].sort(), [...ROOT_SEMANTIC_ROOTS].sort());
	reset.document.destroy();
	root.destroy();
});

s.test("root reset rejects conflicting SQL path authority", () => {
	const root = new Y.Doc({ guid: "root" });
	const authority: RootAuthoritySnapshot = {
		boundarySequence: 3,
		markdown: [],
		semantic: [{ sequence: 1, documentId: "canvas-1", fileId: "canvas-1", kind: "canvas",
			format: "json-canvas", formatVersion: 1, path: "Conflict.canvas", previousPath: null,
			lifecycle: "active", generation: 1, bodyEpoch: 1, contentHash: null, size: null }],
		attachments: [{ sequence: 2, path: "Conflict.canvas", contentHash: "a".repeat(64), size: 1,
			mime: "application/octet-stream", lifecycle: "active", operationId: "conflicting-upsert", createdAt: 2 }],
		blobs: [{ contentHash: "a".repeat(64), size: 1, mime: "application/octet-stream", createdAt: 2 }],
	};
	assert.throws(() => prepareRootSemanticReset(root, authority), /duplicate root path/);
	root.destroy();
});

s.test("root reset rejects one document identity claimed by Markdown and Canvas", () => {
	const root = new Y.Doc({ guid: "root" });
	const authority: RootAuthoritySnapshot = {
		boundarySequence: 3,
		markdown: [{ sequence: 1, bodyId: "cross-kind-id", bodyEpoch: 1, fileId: "cross-kind-id",
			path: "Note.md", previousPath: null, lifecycle: "active", generation: 1,
			contentHash: null, size: null }],
		semantic: [{ sequence: 2, documentId: "cross-kind-id", fileId: "cross-kind-id", kind: "canvas",
			format: "json-canvas", formatVersion: 1, path: "Board.canvas", previousPath: null,
			lifecycle: "active", generation: 1, bodyEpoch: 1, contentHash: null, size: null }],
		attachments: [],
		blobs: [],
	};
	assert.throws(() => prepareRootSemanticReset(root, authority), /duplicate cross-kind document identity/);
	root.destroy();
});

await s.done();
