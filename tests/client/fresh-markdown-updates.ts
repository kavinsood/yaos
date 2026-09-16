import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { MAX_DURABLE_UPDATE_BYTES, MAX_CLIENT_MARKDOWN_BYTES } from "../../server/src/shared/durableLimits";
import { FrontmatterSemanticMirror } from "../../src/sync/frontmatterSemanticMirror";
import {
	materializeFreshMarkdownUpdates,
	splitUtf8Text,
} from "../../src/sync/freshMarkdownUpdates";
import { suite } from "../harness.ts";

const s = suite("fresh-markdown-updates");

s.test("UTF-8 framing preserves CJK, combining text, emoji, and ZWJ content exactly", () => {
	const source = "漢字e\u0301👩‍🚀🙂العربية".repeat(32);
	const chunks = splitUtf8Text(source, 17);
	assert.equal(chunks.join(""), source);
	for (const chunk of chunks) assert.ok(new TextEncoder().encode(chunk).byteLength <= 17);
});

s.test("an exact-limit Markdown note becomes ordered durable Yjs frames", () => {
	const prefix = "---\ntitle: Large note 🙂\ntags: [測試, wasm]\n---\n";
	const prefixBytes = new TextEncoder().encode(prefix).byteLength;
	const content = prefix + "x".repeat(MAX_CLIENT_MARKDOWN_BYTES - prefixBytes);
	assert.equal(new TextEncoder().encode(content).byteLength, MAX_CLIENT_MARKDOWN_BYTES);

	const source = new Y.Doc({ guid: "large-source" });
	const mirror: { current: FrontmatterSemanticMirror | null } = { current: null };
	const framed = materializeFreshMarkdownUpdates(source, content, () => {
		mirror.current = new FrontmatterSemanticMirror(source);
		mirror.current.seedCurrent();
	});
	try {
		assert.ok(framed.encodedUpdates.length >= 5);
		for (const update of framed.encodedUpdates) {
			assert.ok(update.byteLength > 0);
			assert.ok(update.byteLength <= MAX_DURABLE_UPDATE_BYTES);
		}
		const reconstructed = new Y.Doc({ guid: "large-reconstructed" });
		try {
			for (const update of framed.encodedUpdates) Y.applyUpdate(reconstructed, update);
			assert.equal(reconstructed.getText("body").toString(), content);
			const aggregate = new Y.Doc({ guid: "large-aggregate" });
			try {
				Y.applyUpdate(aggregate, framed.encodedUpdate);
				assert.equal(aggregate.getText("body").toString(), content);
			} finally {
				aggregate.destroy();
			}
		} finally {
			reconstructed.destroy();
		}
	} finally {
		mirror.current?.destroy();
		source.destroy();
	}
});

await s.done();
