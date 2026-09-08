import { strict as assert } from "node:assert";
import * as Y from "yjs";
import {
	MAX_BODY_SOCKETS,
	MAX_DURABLE_UPDATE_BYTES,
	MAX_LOADED_BODY_ENCODED_STATE_BYTES,
	MAX_PENDING_BYTES_PER_DOCUMENT,
	MAX_ROOT_RESIDENT_ENCODED_STATE_BYTES,
	MAX_TRANSIENT_PENDING_BYTES,
} from "../../server/src/contracts";
import {
	VaultDocumentCache,
	VaultDocumentCachePressureError,
	VaultDocumentValidationError,
	type VaultDocumentCacheLimits,
} from "../../server/src/vaultDocumentCache";
import { VaultRuntime } from "../../server/src/server";
import {
	initializeCanvasDocument,
	materializeCanvasDocument,
} from "../../server/src/shared/canvasSemanticDocument";
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

function cacheLimits(input: Omit<VaultDocumentCacheLimits, "rootEncodedStateBytes"> & {
	rootEncodedStateBytes?: number;
}): VaultDocumentCacheLimits {
	return { rootEncodedStateBytes: MAX_ROOT_RESIDENT_ENCODED_STATE_BYTES, ...input };
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
			semanticEpoch: 1,
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
		cacheLimits({ loadedBodies: 10, encodedStateBytes: 2 * (Math.max(oldBytes, incomingBytes) + smallBytes), transientBytes: 10_000 }),
	);
	cache.load("old-large", true, () => true).lastUsedAt = 1;
	cache.load("new-small", true, () => true).lastUsedAt = 2;
	cache.load("incoming", true, () => true);
	assert.equal(cache.get("old-large"), undefined);
	assert.ok(cache.get("new-small"));
	assert.ok(cache.get("incoming"));
	assert.ok(cache.diagnostics().costs.encodedStateBytes <= cache.diagnostics().limits.encodedStateBytes);
});

s.test("durable updates evict safe LRU state or expose pressure after mutating protected state", () => {
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
	const initialBytes = 2 * (probeTarget.encodedStateBytes + probeVictim.encodedStateBytes);
	probeCache.clear();
	assert.ok(initialBytes <= updatedBytes, "fixture starts within the post-update budget");
	const cache = new VaultDocumentCache(
		makeStore(contents) as never,
		() => open,
		() => new Set(),
		cacheLimits({ loadedBodies: 10, encodedStateBytes: 2 * updatedBytes, transientBytes: 10_000 }),
	);
	const target = cache.load("target", true, () => true);
	cache.load("victim", true, () => true).lastUsedAt = 1;
	open.add("target");
	assert.equal(cache.applyDurableUpdate("target", update, 2, "test"), true);
	assert.equal(cache.get("victim"), undefined);
	assert.equal(target.encodedStateBytes, updatedBytes);

	const rejecting = new VaultDocumentCache(
		makeStore({ protected: "before" }) as never,
		() => new Set(["protected"]),
		() => new Set(),
		cacheLimits({
			loadedBodies: 10,
			encodedStateBytes: 2 * encodedBytes("protected", "before"),
			transientBytes: 10_000,
		}),
	);
	const protectedBody = rejecting.load("protected", true, () => true);
	assert.equal(rejecting.applyDurableUpdate("protected", update, 2, "test"), true,
		"an already-durable update cannot be rejected from the resident authority");
	assert.match(protectedBody.doc.getText("body").toString(), /before/);
	assert.match(protectedBody.doc.getText("body").toString(), /u{100}/);
	assert.equal(protectedBody.generation, 2);
	assert.equal(rejecting.hasResidentMemoryPressure("protected"), true,
		"non-evictable overage becomes a compaction/admission pressure signal");
});

s.test("post-commit transient pressure discards stale resident mirrors without rejecting durability", () => {
	const store = makeStore({ durable: "before" });
	const cache = new VaultDocumentCache(
		store as never,
		() => new Set(["durable"]),
		() => new Set(),
		cacheLimits({ loadedBodies: 10, encodedStateBytes: 10_000, transientBytes: 10_000 }),
	);
	cache.load("durable", true, () => true);
	const releasePrefill = cache.recordTransient("other-operation", 9_999);
	assert.equal(cache.applyDurableUpdate("durable", updateBytes("committed"), 2, "post-commit"), true,
		"an exact durable update remains publishable when resident application cannot reserve memory");
	assert.equal(cache.get("durable"), undefined,
		"the pre-commit resident view is discarded instead of remaining stale");
	assert.equal(cache.diagnostics().costs.transientBytes, 9_999,
		"failed post-commit reservation does not leak transient accounting");
	releasePrefill();
	assert.equal(cache.diagnostics().costs.transientBytes, 0);
});

s.test("persistent validation rejects poison, rebuilds its mirror, and reuses one reconstruction", async () => {
	const store = makeStore({ protected: "before" });
	const cache = new VaultDocumentCache(store as never, () => new Set(), () => new Set());
	const loaded = cache.load("protected", true, () => true);
	const invalid = new Y.Doc({ guid: "protected" });
	invalid.clientID = 0x1a05_4101;
	Y.applyUpdate(invalid, Y.encodeStateAsUpdate(loaded.doc));
	const invalidVector = Y.encodeStateVector(invalid);
	invalid.getMap("frontmatter:future-root").set("poison", true);
	const invalidUpdate = Y.encodeStateAsUpdate(invalid, invalidVector);
	invalid.destroy();
	assert.throws(
		() => cache.validateBodyUpdate("protected", invalidUpdate),
		(error: unknown) => error instanceof VaultDocumentValidationError
			&& error.reason === "frontmatter_semantic_root_invalid",
	);
	assert.equal(loaded.doc.getText("body").toString(), "before", "rejected state never reaches the live document");

	const valid = new Y.Doc({ guid: "protected" });
	valid.clientID = 0x1a05_4102;
	valid.getText("body").insert(0, "after");
	const validUpdate = Y.encodeStateAsUpdate(valid);
	valid.destroy();
	const staged = cache.validateBodyUpdate("protected", validUpdate);
	assert.equal(staged.changesState, true);
	const validatedText = loaded.validationDoc.getText("body").toString();
	assert.match(validatedText, /after/, "validation mirror accepted the next update");
	assert.equal(cache.commitValidatedBodyUpdate("protected", validUpdate, 2, 1, "test", staged), true,
		"committed validated state emits exactly one live update");
	const durableNoOp = cache.validateBodyUpdate("protected", validUpdate);
	assert.equal(durableNoOp.changesState, false);
	assert.equal(durableNoOp.requiresDurableCommit, false,
		"a true no-op against clean durable state does not consume a journal row");
	assert.equal(cache.stageValidatedBodyUpdate("protected", durableNoOp), false);
	assert.equal(loaded.generation, 2);
	assert.equal(store.reconstructions.get("protected"), 1, "ordinary validation keeps a persistent mirror");
	await cache.serializeDocument("protected", async () => {});
});

s.test("Canvas mirror rejects malformed and semantic poison while preserving an earlier queued frame", async () => {
	const documentId = "canvas-mirror";
	const baseline = new Y.Doc({ guid: documentId });
	initializeCanvasDocument(baseline);
	baseline.getMap("rootFields").set("theme", "light");
	const durableState = Y.encodeStateAsUpdate(baseline);
	baseline.destroy();
	let reconstructions = 0;
	const store = {
		documentHead: () => ({ generation: 1, semanticEpoch: 1, latestSequence: 1 }),
		documentEncodedHistoryBytes: () => durableState.byteLength,
		reconstructDocument: () => {
			reconstructions++;
			const doc = new Y.Doc({ guid: documentId });
			Y.applyUpdate(doc, durableState);
			return { documentId, throughSequence: 1, generation: 1, semanticEpoch: 1,
				checkpointSequence: 0, journalUpdates: 1, doc, rowsRead: 1 };
		},
	};
	const cache = new VaultDocumentCache(store as never, () => new Set(), () => new Set());
	const loaded = cache.load(documentId, true, () => true, "canvas");
	const validProducer = new Y.Doc({ guid: documentId });
	Y.applyUpdate(validProducer, Y.encodeStateAsUpdate(loaded.doc));
	const validVector = Y.encodeStateVector(validProducer);
	validProducer.getMap("rootFields").set("theme", "dark");
	const valid = Y.encodeStateAsUpdate(validProducer, validVector);
	validProducer.destroy();
	const validated = await cache.validateCanvasUpdate(documentId, valid);
	assert.equal(cache.stageValidatedBodyUpdate(documentId, validated), true);
	assert.deepEqual(cache.queue(documentId, {
		bytes: valid,
		digest: "a".repeat(64),
		socketId: "canvas-socket-valid",
	}), { ok: true });
	assert.equal(loaded.doc.getMap("rootFields").get("theme"), "light");
	assert.equal(loaded.validationDoc.getMap("rootFields").get("theme"), "dark");

	await assert.rejects(
		() => cache.validateCanvasUpdate(documentId, new Uint8Array([255])),
		(error: unknown) => error instanceof VaultDocumentValidationError
			&& error.reason === "invalid_canvas_update",
	);
	assert.equal(loaded.validationDoc.getMap("rootFields").get("theme"), "dark",
		"malformed frame rebuild retains the earlier queued valid state");

	const poisonProducer = new Y.Doc({ guid: documentId });
	Y.applyUpdate(poisonProducer, Y.encodeStateAsUpdate(loaded.validationDoc));
	const poisonVector = Y.encodeStateVector(poisonProducer);
	poisonProducer.getMap("canvasMeta").set("format", "poison");
	const poison = Y.encodeStateAsUpdate(poisonProducer, poisonVector);
	poisonProducer.destroy();
	await assert.rejects(
		() => cache.validateCanvasUpdate(documentId, poison),
		(error: unknown) => error instanceof VaultDocumentValidationError
			&& error.reason === "canvas_meta_invalid",
	);

	assert.equal(cache.pendingFor(documentId).length, 1);
	assert.equal(loaded.doc.getMap("rootFields").get("theme"), "light",
		"neither valid queued state nor poison reaches authoritative live state before durability");
	assert.equal(loaded.doc.getMap("canvasMeta").get("format"), "yaos-json-canvas");
	assert.equal(loaded.validationDoc.getMap("rootFields").get("theme"), "dark");
	assert.equal(loaded.validationDoc.getMap("canvasMeta").get("format"), "yaos-json-canvas");
	assert.equal((await materializeCanvasDocument(loaded.validationDoc, false)).rootFields.theme, "dark");
	assert.equal(reconstructions, 1, "ordinary rejection rebuilds from resident live + queue, not SQLite");
	cache.clear();
});

s.test("socket validation mirror stages ordered frames without touching authoritative live state", () => {
	const cache = new VaultDocumentCache(makeStore({ staged: "before" }) as never, () => new Set(), () => new Set());
	const loaded = cache.load("staged", true, () => true);
	const producer = new Y.Doc({ guid: "staged" });
	Y.applyUpdate(producer, Y.encodeStateAsUpdate(loaded.doc));
	const firstVector = Y.encodeStateVector(producer);
	producer.getText("body").insert(producer.getText("body").length, "-one");
	const first = Y.encodeStateAsUpdate(producer, firstVector);
	const secondVector = Y.encodeStateVector(producer);
	producer.getText("body").insert(producer.getText("body").length, "-two");
	const second = Y.encodeStateAsUpdate(producer, secondVector);

	const firstValidated = cache.validateBodyUpdate("staged", first);
	assert.equal(cache.stageValidatedBodyUpdate("staged", firstValidated), true);
	assert.equal(loaded.doc.getText("body").toString(), "before");
	assert.equal(loaded.validationDoc.getText("body").toString(), "before-one");
	const secondValidated = cache.validateBodyUpdate("staged", second);
	assert.equal(cache.stageValidatedBodyUpdate("staged", secondValidated), true);
	assert.equal(loaded.doc.getText("body").toString(), "before");
	assert.equal(loaded.validationDoc.getText("body").toString(), "before-one-two");

	const duplicate = cache.validateBodyUpdate("staged", first);
	assert.equal(cache.stageValidatedBodyUpdate("staged", duplicate), false, "duplicate is a speculative no-op");
	assert.equal(loaded.validationPending, false);
	assert.equal(cache.applyDurableUpdate("staged", first, 2, "durable-prefix"), true);
	assert.equal(loaded.doc.getText("body").toString(), "before-one");
	assert.equal(loaded.validationDoc.getText("body").toString(), "before-one-two");
	assert.equal(cache.applyDurableUpdate("staged", second, 3, "durable-prefix"), true);
	assert.equal(loaded.doc.getText("body").toString(), "before-one-two");
	producer.destroy();
});

s.test("exceptional socket failure reloads both live and mirror from exact durability", () => {
	const cache = new VaultDocumentCache(makeStore({ recovered: "durable" }) as never, () => new Set(), () => new Set());
	const loaded = cache.load("recovered", true, () => true);
	const speculative = updateBytes("speculative");
	const validated = cache.validateBodyUpdate("recovered", speculative);
	assert.equal(cache.stageValidatedBodyUpdate("recovered", validated), true);
	assert.match(loaded.validationDoc.getText("body").toString(), /speculative/);
	assert.equal(loaded.doc.getText("body").toString(), "durable");
	cache.reloadFromDurable("recovered");
	assert.equal(loaded.doc.getText("body").toString(), "durable");
	assert.equal(loaded.validationDoc.getText("body").toString(), "durable");
	assert.equal(loaded.validationPending, false);
	assert.equal(loaded.dirty, false);
});

interface FlushProbe {
	flushDocument(documentId: string): Promise<boolean>;
}

function flushProbe(
	entries: Array<{ bytes: Uint8Array; digest: string; socketId: string; actor: object;
		kind: "body"; documentEpoch: 1; contentHash: string; contentSize: number }>,
	failCommit: number | null,
): { runtime: FlushProbe; events: string[] } {
	const events: string[] = [];
	let commits = 0;
	const cache = {
		serializeDocument: async (_documentId: string, operation: () => Promise<void>) => {
			events.push("serialize");
			return operation();
		},
		takePending: () => { events.push("take"); return entries; },
		applyDurableUpdate: (_documentId: string, _update: Uint8Array, generation: number) => {
			events.push(`apply:${generation}`);
			return true;
		},
		completePendingPersistence: () => { events.push("complete"); },
		reloadFromDurable: () => { events.push("reload"); },
	};
	const store = {
		validateActor: () => "allowed" as const,
		currentSequence: () => 0,
		semanticHeadAt: () => null,
		documentHead: () => ({ generation: commits + 1, semanticEpoch: 1, latestSequence: commits + 1 }),
		commitUpdate: () => {
			commits++;
			events.push(`commit:${commits}`);
			if (commits === failCommit) throw new Error("injected durable failure");
			return { generation: commits + 1, vaultSequence: commits + 10 };
		},
		documentJournalStats: () => ({ entries: 0, bytes: 0 }),
	};
	const sockets = {
		broadcastCommittedSocketUpdate: (_documentId: string, _update: Uint8Array, socketId: string) => {
			events.push(`broadcast:${socketId}`);
		},
		notifyBodyCommitted: (_documentId: string, generation: number) => { events.push(`notify:${generation}`); },
		closeUndurableOrigins: (_documentId: string, rejected: Array<{ socketId: string }>) => {
			events.push(`close:${rejected.map((entry) => entry.socketId).join(",")}`);
		},
		closeAll: () => { events.push("close-all"); },
	};
	const runtime = Object.create(VaultRuntime.prototype) as FlushProbe;
	Object.defineProperties(runtime, {
		cache: { value: cache },
		store: { value: store },
		sockets: { value: sockets },
		lifecycle: { value: { activeBodyHead: (bodyId: string) => ({ bodyId, fileId: bodyId,
			path: `${bodyId}.md`, lifecycle: "active", generation: commits + 1, contentHash: null, size: null }) } },
		semanticCompaction: { value: { recordCommit: async () => {} } },
		options: { value: {
			execution: { waitUntil: () => {} },
			alarms: { setAlarm: async () => { events.push("alarm"); } },
		} },
		persistence: { value: new Map() },
		flushChain: { value: Promise.resolve(), writable: true },
	});
	return { runtime, events };
}

function flushEntry(socketId: string, update: Uint8Array): {
	bytes: Uint8Array; digest: string; socketId: string; actor: object;
	kind: "body"; documentEpoch: 1; contentHash: string; contentSize: number;
} {
	return { bytes: update, digest: socketId.padEnd(64, "0"), socketId, actor: {}, kind: "body", documentEpoch: 1,
		contentHash: "a".repeat(64), contentSize: update.byteLength };
}

s.test("socket flush publishes only after durable success and preserves frame order", async () => {
	const harness = flushProbe([
		flushEntry("socket-a", updateBytes("first")),
		flushEntry("socket-b", updateBytes("second")),
	], null);
	assert.equal(await harness.runtime.flushDocument("ordered-body"), true);
	assert.ok(harness.events.indexOf("commit:1") < harness.events.indexOf("apply:2"));
	assert.ok(harness.events.indexOf("apply:2") < harness.events.indexOf("broadcast:socket-a"));
	assert.deepEqual(harness.events.filter((event) => event.startsWith("broadcast:")), [
		"broadcast:socket-a", "broadcast:socket-b",
	]);
	assert.ok(harness.events.includes("complete"));
});

s.test("socket flush failure publishes nothing, rebuilds durability, and closes origins", async () => {
	const harness = flushProbe([flushEntry("socket-failed", updateBytes("failed"))], 1);
	assert.equal(await harness.runtime.flushDocument("failed-body"), false);
	assert.equal(harness.events.some((event) => event.startsWith("apply:")), false);
	assert.equal(harness.events.some((event) => event.startsWith("broadcast:")), false);
	assert.ok(harness.events.indexOf("reload") < harness.events.indexOf("close:socket-failed"));
	assert.ok(harness.events.includes("alarm"));
});

s.test("partial socket flush exposes the committed prefix and rejects only its suffix", async () => {
	const first = updateBytes("a".repeat(Math.floor(MAX_DURABLE_UPDATE_BYTES * 0.55)));
	const second = updateBytes("b".repeat(Math.floor(MAX_DURABLE_UPDATE_BYTES * 0.55)));
	assert.ok(first.byteLength + second.byteLength > MAX_DURABLE_UPDATE_BYTES);
	const harness = flushProbe([
		flushEntry("socket-prefix", first),
		flushEntry("socket-suffix", second),
	], 2);
	assert.equal(await harness.runtime.flushDocument("partial-body"), false);
	assert.deepEqual(harness.events.filter((event) => event.startsWith("broadcast:")), ["broadcast:socket-prefix"]);
	assert.ok(harness.events.includes("close:socket-suffix"));
	assert.equal(harness.events.includes("close:socket-prefix,socket-suffix"), false);
});

s.test("resident accounting charges both the live document and validation mirror", () => {
	const cache = new VaultDocumentCache(makeStore({ mirrored: "resident" }) as never, () => new Set(), () => new Set());
	const loaded = cache.load("mirrored", true, () => true);
	const diagnostics = cache.diagnostics();
	const entry = diagnostics.loaded.find((candidate) => candidate.documentId === "mirrored");
	assert.ok(entry);
	assert.equal(entry.encodedStateBytes, loaded.encodedStateBytes);
	assert.equal(entry.validationEncodedStateBytes, loaded.encodedStateBytes);
	assert.equal(entry.residentEncodedStateBytes, loaded.encodedStateBytes * 2);
	assert.equal(diagnostics.costs.bodyEncodedStateBytes, loaded.encodedStateBytes * 2);
	assert.equal(diagnostics.costs.encodedStateBytes, loaded.encodedStateBytes * 2);
});

s.test("resident cache identity changes atomically with the semantic epoch", () => {
	const cache = new VaultDocumentCache(makeStore({ lineage: "before" }) as never, () => new Set(), () => new Set());
	const loaded = cache.load("lineage", true, () => true);
	assert.equal(loaded.lineageKey, "lineage@epoch:1");
	const fresh = testDoc("lineage");
	fresh.getText("body").insert(0, "after");
	cache.installSemanticReset("lineage", fresh, 1, 2);
	assert.equal(cache.get("lineage")?.semanticEpoch, 2);
	assert.equal(cache.get("lineage")?.lineageKey, "lineage@epoch:2");
	assert.deepEqual(cache.diagnostics().loaded.map((entry) => entry.lineageKey), ["lineage@epoch:2"]);
});

s.test("observing a durable epoch advance retires old queued bytes before rebuilding", () => {
	let epoch = 1;
	const documentId = "external-lineage-reset";
	const store = {
		documentHead: () => ({ generation: 1, semanticEpoch: epoch, latestSequence: epoch }),
		documentEncodedHistoryBytes: () => encodedBytes(documentId, epoch === 1 ? "old" : "fresh"),
		reconstructDocument: () => {
			const doc = testDoc(documentId);
			doc.getText("body").insert(0, epoch === 1 ? "old" : "fresh");
			return { documentId, throughSequence: epoch, generation: 1, semanticEpoch: epoch,
				checkpointSequence: epoch, journalUpdates: 0, doc, rowsRead: 1 };
		},
	};
	const cache = new VaultDocumentCache(store as never, () => new Set(), () => new Set());
	cache.load(documentId, true, () => true);
	assert.deepEqual(cache.queue(documentId, { bytes: updateBytes("retired"), digest: "e".repeat(64),
		socketId: "old-lineage-socket", documentEpoch: 1 }), { ok: true });
	epoch = 2;
	const fresh = cache.load(documentId, true, () => true);
	assert.equal(fresh.lineageKey, `${documentId}@epoch:2`);
	assert.equal(fresh.validationDoc.getText("body").toString(), "fresh");
	assert.equal(cache.pendingFor(documentId).length, 0);
	assert.equal(cache.diagnostics().pendingBytes.total, 0);
	assert.deepEqual(cache.diagnostics().pendingByLineage, {});
});

s.test("a fresh-epoch operation lane waits for the retiring lineage", async () => {
	const cache = new VaultDocumentCache(makeStore({ "lane-reset": "before" }) as never,
		() => new Set(), () => new Set());
	cache.load("lane-reset", true, () => true);
	let releaseFirst!: () => void;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const events: string[] = [];
	const first = cache.serializeDocument("lane-reset", async () => {
		events.push("old-start");
		markStarted();
		await gate;
		events.push("old-end");
	});
	await started;
	const fresh = testDoc("lane-reset");
	fresh.getText("body").insert(0, "after");
	cache.installSemanticReset("lane-reset", fresh, 1, 2);
	const second = cache.serializeDocument("lane-reset", async () => { events.push("new"); });
	await Promise.resolve();
	assert.deepEqual(events, ["old-start"], "new lineage must not overlap a retiring operation");
	releaseFirst();
	await Promise.all([first, second]);
	assert.deepEqual(events, ["old-start", "old-end", "new"]);
});

s.test("input-byte encoded-state proxies cannot reject an otherwise valid update", () => {
	const store = makeStore({ proxy: "before" });
	const initialBytes = encodedBytes("proxy", "before");
	const cache = new VaultDocumentCache(
		store as never,
		() => new Set(["proxy"]),
		() => new Set(),
		cacheLimits({ loadedBodies: 10, encodedStateBytes: (2 * initialBytes) + 1, transientBytes: 100_000 }),
	);
	cache.load("proxy", true, () => true);
	const validated = cache.validateBodyUpdate("proxy", updateBytes("bounded-update"));
	assert.equal(validated.exactEncodedStateBytes, false);
	assert.equal(validated.changesState, true);
	cache.discardValidatedBodyUpdate("proxy");
});

s.test("exact validation census is periodic without taxing every tiny frame", () => {
	const documentId = "periodic-census";
	const cache = new VaultDocumentCache(makeStore({ [documentId]: "before" }) as never,
		() => new Set([documentId]), () => new Set());
	const loaded = cache.load(documentId, true, () => true);
	const producer = testDoc(`${documentId}-producer`);
	Y.applyUpdate(producer, Y.encodeStateAsUpdate(loaded.doc));
	for (let index = 1; index <= 500; index++) {
		const vector = Y.encodeStateVector(producer);
		producer.getText("body").insert(producer.getText("body").length, "x");
		const validated = cache.validateBodyUpdate(documentId, Y.encodeStateAsUpdate(producer, vector));
		assert.equal(validated.exactEncodedStateBytes, index === 500,
			`frame ${index} uses ${index === 500 ? "the periodic exact census" : "the operational proxy"}`);
		cache.stageValidatedBodyUpdate(documentId, validated);
	}
	assert.equal(loaded.validationUpdatesSinceExact, 0);
	assert.equal(loaded.validationInputBytesSinceExact, 0);
	producer.destroy();
	cache.clear();
});

s.test("full-state reservation rejects validation before touching either document", () => {
	const cache = new VaultDocumentCache(
		makeStore({ protected: "before" }) as never,
		() => new Set(["protected"]),
		() => new Set(),
		cacheLimits({ loadedBodies: 10, encodedStateBytes: 10_000, transientBytes: 10_000 }),
	);
	const loaded = cache.load("protected", true, () => true);
	const required = loaded.encodedStateBytes * 4;
	const externalReservation = 10_000 - required + 1;
	const release = cache.recordTransient("other", externalReservation);
	const update = updateBytes("must-not-appear");
	assert.throws(
		() => cache.validateBodyUpdate("protected", update),
		(error: unknown) => error instanceof VaultDocumentCachePressureError
			&& error.reason === "vault_transient_bytes",
	);
	assert.equal(loaded.doc.getText("body").toString(), "before");
	assert.equal(loaded.validationDoc.getText("body").toString(), "before");
	assert.equal(loaded.validationPending, false);
	assert.equal(cache.diagnostics().costs.transientBytes, externalReservation,
		"rejected validation releases its attempted full-state and exact-wire reservation");
	release();
	assert.equal(cache.diagnostics().costs.transientBytes, 0);
});

s.test("non-evictable root residency is accounted and exposes compaction pressure", () => {
	const rootBytes = encodedBytes("root", "catalog".repeat(20));
	const cache = new VaultDocumentCache(
		makeStore({ root: "catalog".repeat(20) }) as never,
		() => new Set(),
		() => new Set(),
		cacheLimits({
			loadedBodies: 10,
			encodedStateBytes: 10_000,
			rootEncodedStateBytes: (2 * rootBytes) - 1,
			transientBytes: 10_000,
		}),
	);
	const root = cache.load("root", false, () => true);
	const diagnostics = cache.diagnostics();
	assert.equal(diagnostics.costs.bodyEncodedStateBytes, 0);
	assert.equal(diagnostics.costs.rootEncodedStateBytes, root.encodedStateBytes * 2);
	assert.equal(diagnostics.costs.encodedStateBytes, root.encodedStateBytes * 2);
	assert.equal(cache.hasResidentMemoryPressure("root"), true);
	assert.equal(diagnostics.loaded[0]?.memoryPressure, true);
});

s.test("root handshake validation accepts durable duplicates and rebuilds after a real mutation", () => {
	const cache = new VaultDocumentCache(makeStore({ root: "catalog" }) as never, () => new Set(), () => new Set());
	const root = cache.load("root", false, () => true);
	const duplicate = Y.encodeStateAsUpdate(root.doc);
	assert.equal(cache.validateRootSyncNoop("root", duplicate), true);

	const peer = testDoc("root-peer-mutation");
	Y.applyUpdate(peer, duplicate);
	const vector = Y.encodeStateVector(peer);
	peer.getMap("pathToId").set("forbidden.md", "forbidden-body");
	const mutation = Y.encodeStateAsUpdate(peer, vector);
	peer.destroy();
	assert.equal(cache.validateRootSyncNoop("root", mutation), false);
	assert.equal(root.validationDoc.getMap("pathToId").has("forbidden.md"), false,
		"rejected root state is removed from the private mirror");
	assert.equal(cache.validateRootSyncNoop("root", duplicate), true,
		"the rebuilt mirror remains usable by the next handshake");
	assert.equal(cache.validateRootSyncNoop("root", new Uint8Array([255, 1, 2])), false);
});

s.test("live checkpoint falls back to durable reconstruction while a detached flush batch is in flight", () => {
	const documentId = "checkpoint-in-flight";
	const cache = new VaultDocumentCache(
		makeStore({ [documentId]: "durable" }) as never,
		() => new Set(),
		() => new Set(),
	);
	const loaded = cache.load(documentId, true, () => true);
	loaded.doc.getText("body").insert(loaded.doc.getText("body").length, "-not-durable");
	const pending = updateBytes("wire-update");
	assert.deepEqual(cache.queue(documentId, {
		bytes: pending,
		digest: "a".repeat(64),
		socketId: "socket-checkpoint-in-flight",
	}), { ok: true });

	const detached = cache.takePending(documentId);
	assert.equal(detached.length, 1);
	assert.equal(loaded.dirty, true, "detaching a batch must not make its live state checkpointable");

	let persistedContent = "";
	let reconstructedWrites = 0;
	let liveWrites = 0;
	const checkpointStore = {
		documentHead: () => ({ generation: 1, semanticEpoch: 1, latestSequence: 1 }),
		writeCheckpoint: () => {
			reconstructedWrites++;
			persistedContent = "durable";
		},
		writeCheckpointFromDocument: (_id: string, doc: Y.Doc) => {
			liveWrites++;
			persistedContent = doc.getText("body").toString();
		},
	};
	type LiveCheckpointProbe = {
		cache: VaultDocumentCache;
		store: typeof checkpointStore;
		writeLiveCheckpoint(documentId: string): void;
	};
	const runtime = Object.create(VaultRuntime.prototype) as LiveCheckpointProbe;
	Object.defineProperties(runtime, {
		cache: { value: cache },
		store: { value: checkpointStore },
	});
	runtime.writeLiveCheckpoint(documentId);

	assert.equal(reconstructedWrites, 1);
	assert.equal(liveWrites, 0, "uncommitted live bytes must never enter a checkpoint");
	assert.equal(persistedContent, "durable");
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
	const encodedStateBytes = probe.diagnostics().costs.encodedStateBytes;
	probe.clear();
	const cache = new VaultDocumentCache(
		makeStore(contents) as never,
		() => open,
		() => pinned,
		cacheLimits({ loadedBodies: 10, encodedStateBytes, transientBytes: 10_000 }),
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
	assert.throws(() => cache.load("incoming", true, () => true), /body_cache_encoded_state_bytes/);
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
		cacheLimits({ loadedBodies: 10, encodedStateBytes: 10, transientBytes: 10 }),
	);
	assert.throws(
		() => cache.load("oversized", true, () => true),
		(error: unknown) => error instanceof VaultDocumentCachePressureError
			&& error.reason === "body_cache_encoded_state_bytes",
	);
	assert.equal(store.reconstructions.get("oversized"), undefined);
	assert.equal(cache.diagnostics().costs.encodedStateBytes, 0);
});

s.test("transient reservations enforce their aggregate limit and release exactly once", () => {
	const cache = new VaultDocumentCache(
		makeStore() as never,
		() => new Set(),
		() => new Set(),
		cacheLimits({ loadedBodies: 10, encodedStateBytes: 100, transientBytes: 10 }),
	);
	const release = cache.recordTransient("unloaded", 6);
	assert.equal(cache.diagnostics().costs.transientBytes, 6);
	assert.throws(
		() => cache.recordTransient("other", 5),
		(error: unknown) => error instanceof VaultDocumentCachePressureError
			&& error.reason === "vault_transient_bytes",
	);
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
		cacheLimits({ loadedBodies: 2, encodedStateBytes: 2 * mediumBytes, transientBytes: 10_000 }),
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
	assert.equal(cache.evict(documentId), false, "detached persistence remains dirty until commit confirmation");
	cache.completePendingPersistence(documentId);
	assert.equal(cache.evict(documentId), true);
});

s.test("default aggregate limits are explicit in diagnostics", () => {
	const cache = new VaultDocumentCache(makeStore() as never, () => new Set(), () => new Set());
	assert.deepEqual(cache.diagnostics().accounting, {
		formatVersion: 1,
		claim: "encoded-yjs-state-proxy-not-heap-measurement",
	});
	assert.deepEqual(cache.diagnostics().limits, {
		loadedBodies: MAX_BODY_SOCKETS,
		encodedStateBytes: MAX_LOADED_BODY_ENCODED_STATE_BYTES,
		rootEncodedStateBytes: MAX_ROOT_RESIDENT_ENCODED_STATE_BYTES,
		transientBytes: MAX_TRANSIENT_PENDING_BYTES,
	});
});

await s.done();
