import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canvasContentHash } from "../core/hash/canvasCanonical";
import { exactFingerprint, markdownContentHash } from "../core/hash/markdownLf";
import { createHasher, utf8 } from "./hashing";

const hasher = createHasher({ sha256: async (b) => new Uint8Array(createHash("sha256").update(b).digest()) });

test("host hashing matches the engine's content hash for markdown, canvas and blobs", async () => {
	const md = utf8("\uFEFFone\r\ntwo\n");
	assert.equal(await hasher.contentHash("a.md", md), markdownContentHash("\uFEFFone\r\ntwo\n"));
	const canvas = utf8('{ "nodes": [{"id":"n1","type":"text","text":"hi","x":0,"y":0,"width":10,"height":10}], "edges": [] }');
	assert.equal(await hasher.contentHash("b.canvas", canvas), canvasContentHash(canvas));
	assert.notEqual(canvasContentHash(canvas), exactFingerprint(canvas), "canvas hashes its canonical form, not its bytes");
	const broken = utf8("{ not json");
	assert.equal(await hasher.contentHash("c.Canvas", broken), canvasContentHash(broken));
	const blob = new Uint8Array([1, 2, 3]);
	assert.equal(await hasher.contentHash("d.png", blob), exactFingerprint(blob));
	assert.equal(await hasher.fingerprint(md), exactFingerprint(md));
});
