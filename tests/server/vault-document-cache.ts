import { strict as assert } from "node:assert";
import * as Y from "yjs";
import {
	MAX_BODY_SOCKETS,
	MAX_LOADED_BODY_ESTIMATED_BYTES,
	MAX_PENDING_BYTES_PER_DOCUMENT,
	MAX_TRANSIENT_PENDING_BYTES,
} from "../../server/src/contracts";
import { VaultDocumentCache } from "../../server/src/vaultDocumentCache";
import { suite } from "../harness.ts";

const s = suite("vault-document-cache");

function testDoc(documentId: string): Y.Doc {
	const doc = new Y.Doc({ guid: documentId });
	doc.clientID = [...documentId].reduce((value, character) =>
		(value * 33 + character.charCodeAt(0)) >>> 0, 5381) || 1;
	return doc;
}

function encodedBytes(documentId: string, content: string): number {
	const doc = testDoc(documentId);
	doc.getText("body").insert(0, content);
	const bytes = Y.encodeStateAsUpdate(doc).byteLength;
	doc.destroy();
	return bytes;
}

function updateBytes(content: string): Uint8Array {
	const doc = testDoc("candidate-update");
	doc.getText("body").insert(0, content);
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return update;
}

function measuredAfterUpdate(doc: Y.Doc, update: Uint8Array): number {
	const candidate = new Y.Doc();
	Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc));
	Y.applyUpdate(candidate, update);
	const bytes = Y.encodeStateAsUpdate(candidate).byteLength;
	candidate.destroy();
	return bytes;
}

function makeStore(
	contents: Record<string, string> = {},
	historyCosts: Record<string, number> = {},
) {
	const reconstructions = new Map<string, number>();
	return {
		reconstructions,
		documentHead(documentId: string) {
			return { generation: 1, latestSequence: 1 };
		},
		documentEncodedHistoryBytes(documentId: string) {
			return historyCosts[documentId] ?? encodedBytes(documentId, contents[documentId] ?? documentId);
		},
		reconstructDocument(documentId: string) {
			reconstructions.set(documentId, (reconstructions.get(documentId) ?? 0) + 1);
			const doc = testDoc(documentId);
			doc.getText("body").insert(0, contents[documentId] ?? documentId);
			return {
				documentId,
				throughSequence: 1,
				generation: 1,
				checkpointSequence: 0,
				journalUpdates: 1,
				doc,
				rowsRead: 1,
			};
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

s.test("mixed-size byte admission evicts the clean least-recently-used body", () => {
	const contents = {
		"old-large": "o".repeat(400),
		"new-small": "n",
		incoming: "i".repeat(400),
	};
	const oldBytes = encodedBytes("old-large", contents["old-large"]);
	const smallBytes = encodedBytes("new-small", contents["new-small"]);
	const incomingBytes = encodedBytes("incoming", contents.incoming);
	const cache = new VaultDocumentCache(
		makeStore(contents) as never,
		() => new Set(),
		() => new Set(),
		{ loadedBodies: 10, residentBytes: Math.max(oldBytes, incomingBytes) + smallBytes, transientBytes: 100 },
	);
	cache.load("old-large", true, () => true).lastUsedAt = 1;
	cache.load("new-small", true, () => true).lastUsedAt = 2;
	cache.load("incoming", true, () => true);
	assert.equal(cache.get("old-large"), undefined);
	assert.ok(cache.get("new-small"));
	assert.ok(cache.get("incoming"));
	assert.ok(cache.diagnostics().costs.residentBytes <= cache.diagnostics().limits.residentBytes);
});

s.test("durable updates evict safe LRU state or reject before mutating protected state", () => {
	const open = new Set<string>();
	const contents = { target: "target", victim: "victim" };
	const update = updateBytes("u".repeat(400));
	const probe = makeStore(contents);
	const probeCache = new VaultDocumentCache(
		probe as never,
		() => new Set(),
		() => new Set(),
	);
	const probeTarget = probeCache.load("target", true, () => true);
	const probeVictim = probeCache.load("victim", true, () => true);
	const updatedBytes = measuredAfterUpdate(probeTarget.doc, update);
	const initialBytes = probeTarget.residentBytes + probeVictim.residentBytes;
	probeCache.clear();
	assert.ok(initialBytes <= updatedBytes, "fixture starts within the post-update budget");
	const cache = new VaultDocumentCache(
		makeStore(contents) as never,
		() => open,
		() => new Set(),
		{ loadedBodies: 10, residentBytes: updatedBytes, transientBytes: 100 },
	);
	const target = cache.load("target", true, () => true);
	cache.load("victim", true, () => true).lastUsedAt = 1;
	open.add("target");
	assert.equal(cache.applyDurableUpdate("target", update, 2, "test"), true);
	assert.equal(cache.get("victim"), undefined);
	assert.equal(target.residentBytes, updatedBytes);

	const rejecting = new VaultDocumentCache(
		makeStore({ protected: "before" }) as never,
		() => new Set(["protected"]),
		() => new Set(),
		{
			loadedBodies: 10,
			residentBytes: encodedBytes("protected", "before"),
			transientBytes: 100,
		},
	);
	const protectedBody = rejecting.load("protected", true, () => true);
	assert.throws(
		() => rejecting.applyDurableUpdate("protected", update, 2, "test"),
		/body_cache_resident_bytes/,
	);
	assert.equal(protectedBody.doc.getText("body").toString(), "before");
	assert.equal(protectedBody.generation, 1);
});

s.test("dirty, open, and pinned bodies refuse byte-pressure eviction", () => {
	const open = new Set<string>();
	const pinned = new Set<string>();
	const contents = {
		dirty: "dirty",
		open: "open",
		pinned: "pinned",
		incoming: "incoming",
	};
	const probe = new VaultDocumentCache(
		makeStore(contents) as never,
		() => new Set(),
		() => new Set(),
	);
	for (const id of ["dirty", "open", "pinned"]) probe.load(id, true, () => true);
	const residentBytes = probe.diagnostics().costs.residentBytes;
	probe.clear();
	const cache = new VaultDocumentCache(
		makeStore(contents) as never,
		() => open,
		() => pinned,
		{ loadedBodies: 10, residentBytes, transientBytes: 100 },
	);
	cache.load("dirty", true, () => true);
	assert.deepEqual(cache.queue("dirty", {
		bytes: new Uint8Array(1),
		digest: "d",
		socketId: "dirty-socket",
	}), { ok: true });
	cache.load("open", true, () => true);
	open.add("open");
	cache.load("pinned", true, () => true);
	pinned.add("pinned");
	assert.throws(() => cache.load("incoming", true, () => true), /body_cache_resident_bytes/);
	assert.ok(cache.get("dirty"));
	assert.ok(cache.get("open"));
	assert.ok(cache.get("pinned"));
	assert.equal(cache.get("incoming"), undefined);
});

s.test("a single body over budget is rejected from durable cost before reconstruction", () => {
	const store = makeStore({ oversized: "small-state" }, { oversized: 11 });
	const cache = new VaultDocumentCache(
		store as never,
		() => new Set(),
		() => new Set(),
		{ loadedBodies: 10, residentBytes: 10, transientBytes: 10 },
	);
	assert.throws(() => cache.load("oversized", true, () => true), /body_cache_resident_bytes/);
	assert.equal(store.reconstructions.get("oversized"), undefined);
	assert.equal(cache.diagnostics().costs.residentBytes, 0);
});

s.test("transient reservations enforce their aggregate limit and release exactly once", () => {
	const cache = new VaultDocumentCache(
		makeStore() as never,
		() => new Set(),
		() => new Set(),
		{ loadedBodies: 10, residentBytes: 100, transientBytes: 10 },
	);
	const release = cache.recordTransient("unloaded", 6);
	assert.equal(cache.diagnostics().costs.transientBytes, 6);
	assert.throws(() => cache.recordTransient("other", 5), /vault_transient_bytes/);
	release();
	release();
	assert.equal(cache.diagnostics().costs.transientBytes, 0);
	const releaseAll = cache.recordTransient("other", 10);
	assert.deepEqual(cache.queue("pending", {
		bytes: new Uint8Array(1),
		digest: "p",
		socketId: "pending-socket",
	}), { ok: false, reason: "vault_transient_bytes" });
	releaseAll();
	assert.equal(cache.diagnostics().costs.transientBytes, 0);
});

s.test("count and byte fences interact without stopping after one eviction", () => {
	const contents = {
		"small-old": "a",
		"small-new": "b",
		medium: "m".repeat(400),
	};
	const mediumBytes = encodedBytes("medium", contents.medium);
	assert.ok(encodedBytes("small-old", contents["small-old"]) + encodedBytes("small-new", contents["small-new"]) <= mediumBytes);
	const cache = new VaultDocumentCache(
		makeStore(contents) as never,
		() => new Set(),
		() => new Set(),
		{ loadedBodies: 2, residentBytes: mediumBytes, transientBytes: 100 },
	);
	cache.load("small-old", true, () => true).lastUsedAt = 1;
	cache.load("small-new", true, () => true).lastUsedAt = 2;
	cache.load("medium", true, () => true);
	assert.equal(cache.get("small-old"), undefined);
	assert.equal(cache.get("small-new"), undefined, "byte fence requires a second eviction after count fits");
	assert.ok(cache.get("medium"));
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

s.test("default aggregate limits are explicit in diagnostics", () => {
	const cache = new VaultDocumentCache(makeStore() as never, () => new Set(), () => new Set());
	assert.deepEqual(cache.diagnostics().limits, {
		loadedBodies: MAX_BODY_SOCKETS,
		residentBytes: MAX_LOADED_BODY_ESTIMATED_BYTES,
		transientBytes: MAX_TRANSIENT_PENDING_BYTES,
	});
});

await s.done();
