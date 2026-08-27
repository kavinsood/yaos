import { strict as assert } from "node:assert";
import * as Y from "yjs";
import {
	MAX_BODY_SOCKETS,
	MAX_PENDING_BYTES_PER_DOCUMENT,
} from "../../server/src/contracts";
import { VaultDocumentCache } from "../../server/src/vaultDocumentCache";
import { suite } from "../harness.ts";

const s = suite("vault-document-cache");

function makeStore() {
	return {
		reconstructDocument(documentId: string) {
			const doc = new Y.Doc({ guid: documentId });
			doc.getText("body").insert(0, documentId);
			return { doc, generation: 1 };
		},
	};
}

s.test("clean least-recently-used bodies are evicted to admit another body", () => {
	const cache = new VaultDocumentCache(makeStore() as never, () => new Set(), () => new Set());
	for (let index = 0; index < MAX_BODY_SOCKETS; index++) {
		cache.load(`body-cache-${index}`, true, () => true);
	}
	assert.equal(cache.diagnostics().loaded.length, MAX_BODY_SOCKETS);
	assert.equal(cache.admitBody("body-cache-next"), true);
	assert.equal(cache.get("body-cache-0"), undefined, "oldest clean body was evicted");
	assert.ok(cache.get(`body-cache-${MAX_BODY_SOCKETS - 1}`), "newer body remains resident");
});

s.test("open bodies refuse cache admission instead of evicting live state", () => {
	const open = new Set<string>();
	const cache = new VaultDocumentCache(makeStore() as never, () => open, () => new Set());
	for (let index = 0; index < MAX_BODY_SOCKETS; index++) {
		const id = `body-open-${index}`;
		cache.load(id, true, () => true);
		open.add(id);
	}
	assert.equal(cache.admitBody("body-refused"), false);
	assert.equal(cache.diagnostics().loaded.length, MAX_BODY_SOCKETS);
});

s.test("pending byte cost is exact, observable, and released after durability", () => {
	const cache = new VaultDocumentCache(makeStore() as never, () => new Set(), () => new Set());
	const documentId = "body-cost-0001";
	cache.load(documentId, true, () => true);
	const accepted = cache.queue(documentId, {
		bytes: new Uint8Array(MAX_PENDING_BYTES_PER_DOCUMENT),
		digest: "a".repeat(64),
		socketId: "socket-cost-0001",
	});
	assert.deepEqual(accepted, { ok: true });
	assert.deepEqual(cache.queue(documentId, {
		bytes: new Uint8Array(1),
		digest: "b".repeat(64),
		socketId: "socket-cost-0001",
	}), { ok: false, reason: "document_pending_bytes" });
	const underPressure = cache.diagnostics();
	assert.equal(underPressure.pendingBytes.total, MAX_PENDING_BYTES_PER_DOCUMENT);
	assert.equal(underPressure.costs.transientBytes, MAX_PENDING_BYTES_PER_DOCUMENT);
	assert.equal(cache.evict(documentId), false, "dirty/pending documents cannot be evicted");
	assert.equal(cache.takePending(documentId).length, 1);
	const drained = cache.diagnostics();
	assert.equal(drained.pendingBytes.total, 0);
	assert.equal(drained.costs.transientBytes, 0);
	assert.equal(cache.evict(documentId), true);
});

await s.done();
