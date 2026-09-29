import { strict as assert } from "node:assert";
import * as Y from "yjs";
import {
	BootstrapClient,
	BootstrapHttpPort,
	prepareBootstrapRoot,
	coalesceFeedPage,
	decodeVerifiedBodyContent,
	decodeBootstrapRoot,
	type ClientCatalogEntry,
} from "../../src/sync/bootstrapClient";
import type {
	StoredBootstrapProgress,
	StoredOutstandingBody,
	StoredDocument,
} from "../../src/sync/vaultIndexedDb";
import { suite } from "../harness.ts";
import { BodyManager } from "../../src/sync/bodyManager";
import { BodySettlementRepository, type StoredBodySettlement } from "../../src/sync/bodySettlement";
import { canonicalMarkdownHash, exactMarkdownDiskFingerprint } from "../../server/src/shared/markdownCodec";
import { SCHEMA_VERSION } from "../../src/sync/schema";

const s = suite("bootstrap-settlement");

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

s.test("missing body state never creates a placeholder and remains durably outstanding", async () => {
	const root = new Y.Doc({ guid: "root" });
	root.getMap("sys").set("schemaVersion", SCHEMA_VERSION);
	const rootBytes = Y.encodeStateAsUpdate(root);
	root.destroy();

	const entry: ClientCatalogEntry = {
		bodyId: "file-1",
		bodyEpoch: 1,
		fileId: "file-1",
		path: "notes/real.md",
		generation: 3,
		contentHash: null,
		size: null,
	};
	const maliciousEntry: ClientCatalogEntry = {
		bodyId: "file-malicious",
		bodyEpoch: 1,
		fileId: "file-malicious",
		path: ".obsidian/plugins/yaos/main.md",
		generation: 1,
		contentHash: null,
		size: null,
	};
	let progress: StoredBootstrapProgress | null = null;
	const outstanding = new Map<string, StoredOutstandingBody>();
	const documents = new Map<string, StoredDocument>();
	let diskSettlementCalls = 0;

	const database = {
		getBootstrapProgress: async () => progress,
		putBootstrapProgress: async (next: StoredBootstrapProgress) => { progress = { ...next }; },
		putDocument: async (document: StoredDocument) => { documents.set(document.documentId, document); },
		putFeedCursor: async () => {},
		putOutstanding: async (record: StoredOutstandingBody) => { outstanding.set(record.bodyId, record); },
		getOutstanding: async (bodyId: string) => outstanding.get(bodyId) ?? null,
		listOutstanding: async () => [...outstanding.values()],
		deleteOutstanding: async (bodyId: string) => { outstanding.delete(bodyId); },
		getDocument: async (bodyId: string) => documents.get(bodyId) ?? null,
		deleteDocument: async (bodyId: string) => { documents.delete(bodyId); },
		getMaterializedPath: async () => null,
		setMaterializedPath: async () => {},
		deleteMaterializedPath: async () => {},
		listMaterializedPaths: async () => [],
	};
	const server = {
		start: async () => ({
			bootstrapId: "bootstrap-1",
			createdAt: "2026-08-23T00:00:00Z",
			expiresAt: "2026-08-24T00:00:00Z",
			serverCompleted: false,
			capture: {
				vaultSequence: 0,
				rootEpoch: 1,
				rootGeneration: 1,
				rootCheckpointHash: await sha256(rootBytes),
			},
			catalog: {
				activeBodyCount: 2,
				pageSize: 1000,
				firstCursor: null,
				feedFloor: 0,
				highWater: 0,
			},
		}),
		root: async () => rootBytes,
		catalog: async () => ({ entries: [entry, maliciousEntry], nextCursor: null }),
		bodies: async (_bootstrapId: string, bodyIds: string[]) => {
			assert.deepEqual(bodyIds, [entry.bodyId], "unsafe catalog body is rejected before batch download");
			return new Map();
		},
		renew: async () => {},
		complete: async () => ({ currentHighWater: 0 }),
		changesAfter: async () => ({ entries: [], currentHighWater: 0, resetRequired: false }),
		currentHead: async (bodyId: string) => bodyId === maliciousEntry.bodyId ? maliciousEntry : entry,
		currentBody: async () => { throw new Error("body checkpoint missing"); },
		settleRootThrough: async () => {},
	};
	const disk = {
		settleBody: async () => { diskSettlementCalls++; return "settled" as const; },
		moveBodies: async () => {},
		deleteBody: async () => "deleted" as const,
	};

	const client = new BootstrapClient(
		server as never,
		database as never,
		{} as never,
		disk,
	);
	const result = await client.run();

	assert.equal(result.stage, "complete");
	assert.equal(result.settledBodies, 0, "missing batch body is not counted as settled");
	assert.equal(diskSettlementCalls, 0, "no empty or placeholder body reaches disk");
	assert.equal(outstanding.get(entry.bodyId)?.path, entry.path);
	assert.match(outstanding.get(entry.bodyId)?.reason ?? "", /checkpoint missing|missing from batch/);
	assert.match(outstanding.get(maliciousEntry.bodyId)?.reason ?? "", /unsafe markdown path/);
});

s.test("body verification rejects corrupt, mismatched, and wrong-identity 200 responses", async () => {
	const doc = new Y.Doc({ guid: "file-verified" });
	doc.getText("body").insert(0, "verified content");
	const encodedState = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	const contentBytes = new TextEncoder().encode("verified content");
	const entry: ClientCatalogEntry = {
		bodyId: "file-verified",
		bodyEpoch: 1,
		fileId: "file-verified",
		path: "notes/verified.md",
		generation: 4,
		contentHash: await sha256(contentBytes),
		size: contentBytes.byteLength,
	};
	assert.equal(
		await decodeVerifiedBodyContent(entry, {
			bodyId: entry.bodyId,
			bodyEpoch: 1,
			generation: 4,
			encodedState,
		}),
		"verified content",
	);
	await assert.rejects(
		decodeVerifiedBodyContent(entry, {
			bodyId: "different-body",
			bodyEpoch: 1,
			generation: 4,
			encodedState,
		}),
		/identity mismatch/,
	);
	await assert.rejects(
		decodeVerifiedBodyContent({ ...entry, size: entry.size! + 1 }, {
			bodyId: entry.bodyId,
			bodyEpoch: 1,
			generation: 4,
			encodedState,
		}),
		/size mismatch/,
	);
	await assert.rejects(
		decodeVerifiedBodyContent({ ...entry, contentHash: "0".repeat(64) }, {
			bodyId: entry.bodyId,
			bodyEpoch: 1,
			generation: 4,
			encodedState,

		}),
		/content hash mismatch/,
	);
	await assert.rejects(
		decodeVerifiedBodyContent(entry, {
			bodyId: entry.bodyId,
			bodyEpoch: 1,
			generation: 4,
			encodedState: new Uint8Array([255, 255, 255]),
		}),
	);
});

s.test("bootstrap root rejects schema-3 state instead of migrating it", () => {
	const legacy = new Y.Doc({ guid: "root" });
	legacy.getMap("sys").set("schemaVersion", 3);
	const encodedState = Y.encodeStateAsUpdate(legacy);
	legacy.destroy();
	assert.throws(() => decodeBootstrapRoot(encodedState), new RegExp(`not schema ${SCHEMA_VERSION}`));
});

s.test("feed pages collapse repeated body and catalog work to latest durable state", () => {
	const active = {
		bodyId: "body-a",
		bodyEpoch: 1,
		fileId: "body-a",
		path: "renamed/final.md",
		generation: 9,
		contentHash: null,
		size: null,
		lifecycle: "active" as const,
	};
	const page = coalesceFeedPage([
		{ sequence: 1, documentId: "body-a", documentEpoch: 1, generation: 1, kind: "body" },
		{ sequence: 2, documentId: "body-a", documentEpoch: 1, generation: 2, kind: "body" },
		{ sequence: 3, documentId: "root", documentEpoch: 1, generation: 2, kind: "rename", catalogs: [{ ...active, generation: 2 }] },
		{ sequence: 4, documentId: "body-a", documentEpoch: 1, generation: 9, kind: "body" },
		{ sequence: 5, documentId: "body-b", documentEpoch: 1, generation: 3, kind: "body" },
		{ sequence: 6, documentId: "body-b", documentEpoch: 1, generation: 4, kind: "body" },
		{ sequence: 7, documentId: "root", documentEpoch: 1, generation: 3, kind: "root" },
	]);
	assert.equal(page.throughSequence, 7);
	assert.deepEqual(page.catalogs, [{ ...active, generation: 2 }]);
	assert.equal(page.bodyGenerations.has("body-a"), false, "catalog settlement subsumes same-page body updates");
	assert.deepEqual(page.bodyGenerations.get("body-b"), { bodyEpoch: 1, generation: 4, kind: "body" });
});

s.test("body-only feed catch-up batches state and skips root settlement", async () => {
	const makeBody = async (bodyId: string, path: string, content: string, generation: number) => {
		const doc = new Y.Doc({ guid: bodyId });
		doc.getText("body").insert(0, content);
		const encodedState = Y.encodeStateAsUpdate(doc);
		doc.destroy();
		return {
			head: {
				bodyId, bodyEpoch: 1, fileId: bodyId, path, generation,
				contentHash: await canonicalMarkdownHash(content),
				size: new TextEncoder().encode(content).byteLength,
				lifecycle: "active" as const,
			},
			state: { bodyId, bodyEpoch: 1, generation, encodedState },
		};
	};
	const first = await makeBody("batch-a", "Batch A.md", "first", 2);
	const second = await makeBody("batch-b", "Batch B.md", "second", 3);
	const documents = new Map<string, StoredDocument>();
	let progress: StoredBootstrapProgress = {
		bootstrapId: "batch-bootstrap", rootEpoch: 1, highWater: 0, nextCatalogCursor: null,
		stage: "complete", settledBodies: 0, totalBodies: 2, feedCursor: 0,
	};
	const materialized = new Map<string, string>();
	const database = {
		getBootstrapProgress: async () => progress,
		putBootstrapProgress: async (next: StoredBootstrapProgress) => { progress = { ...next }; },
		putFeedCursor: async () => {},
		getDocument: async (bodyId: string) => documents.get(bodyId) ?? null,
		putDocument: async (document: StoredDocument) => { documents.set(document.documentId, document); },
		deleteDocument: async (bodyId: string) => { documents.delete(bodyId); },
		getOutstanding: async () => null,
		putOutstanding: async () => {}, deleteOutstanding: async () => {}, listOutstanding: async () => [],
		getMaterializedPath: async (bodyId: string) => materialized.get(bodyId) ?? null,
		setMaterializedPath: async (bodyId: string, path: string) => { materialized.set(bodyId, path); },
		setMaterializedPaths: async () => {}, deleteMaterializedPath: async () => {}, listMaterializedPaths: async () => [],
	};
	let page = 0;
	let rootSettlements = 0;
	let batches = 0;
	const heads = new Map([[first.head.bodyId, first.head], [second.head.bodyId, second.head]]);
	const server = {
		changesAfter: async () => page++ === 0
			? {
				entries: [
					{ sequence: 1, documentId: first.head.bodyId, documentEpoch: 1, generation: 2, kind: "body" },
					{ sequence: 2, documentId: second.head.bodyId, documentEpoch: 1, generation: 3, kind: "body" },
				],
				currentHighWater: 2,
				resetRequired: false,
			}
			: { entries: [], currentHighWater: 2, resetRequired: false },
		settleRootThrough: async () => { rootSettlements++; },
		catchUpBodies: async (requests: Array<{ bodyId: string }>) => {
			batches++;
			assert.deepEqual(requests.map((request) => request.bodyId).sort(), ["batch-a", "batch-b"]);
			return new Map([[first.head.bodyId, first], [second.head.bodyId, second]]);
		},
		currentHead: async (bodyId: string) => heads.get(bodyId) ?? null,
	};
	const writes: string[] = [];
	const disk = {
		settleBody: async ({ path }: { path: string }) => { writes.push(path); return "settled" as const; },
		moveBodies: async () => {}, deleteBody: async () => "deleted" as const,
	};
	const bodies = new BodyManager(database);
	const client = new BootstrapClient(server as never, database as never, bodies, disk);
	await client.run();
	assert.equal(batches, 1);
	assert.equal(rootSettlements, 0);
	assert.deepEqual(writes.sort(), ["Batch A.md", "Batch B.md"]);
	assert.equal(progress.feedCursor, 2);
	await bodies.destroy();
});

s.test("feed catch-up settles a live body that sync already brought current instead of failing (B2)", async () => {
	const bodyId = "live-body";
	const content = "# Live\n\nremote edit already merged over the body socket\n";
	const doc = new Y.Doc({ guid: bodyId });
	doc.getText("body").insert(0, content);
	const encodedState = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	const head = {
		bodyId, bodyEpoch: 1, fileId: bodyId, path: "Live.md", generation: 5,
		contentHash: await canonicalMarkdownHash(content),
		size: new TextEncoder().encode(content).byteLength,
		lifecycle: "active" as const,
	};
	const run = async (withPromotion: boolean) => {
		const documents = new Map<string, StoredDocument>([[bodyId, {
			kind: "body", documentId: bodyId, bodyEpoch: 1, durableBaseline: content,
			// Live sync merged the content, but the commit notice that would
			// have advanced the generation never arrived.
			generation: 2, encodedState: encodedState.slice().buffer, dirty: false, updatedAt: 1,
		}]]);
		const outstanding = new Map<string, StoredOutstandingBody>();
		let progress: StoredBootstrapProgress = {
			bootstrapId: "live-bootstrap", rootEpoch: 1, highWater: 0, nextCatalogCursor: null,
			stage: "complete", settledBodies: 1, totalBodies: 1, feedCursor: 0,
		};
		const database = {
			getBootstrapProgress: async () => progress,
			putBootstrapProgress: async (next: StoredBootstrapProgress) => { progress = { ...next }; },
			putFeedCursor: async () => {},
			getDocument: async (id: string) => documents.get(id) ?? null,
			putDocument: async (document: StoredDocument) => { documents.set(document.documentId, document); },
			deleteDocument: async (id: string) => { documents.delete(id); },
			getOutstanding: async (id: string) => outstanding.get(id) ?? null,
			putOutstanding: async (record: StoredOutstandingBody) => { outstanding.set(record.bodyId, record); },
			deleteOutstanding: async (id: string) => { outstanding.delete(id); },
			listOutstanding: async () => [...outstanding.values()],
			getMaterializedPath: async () => "Live.md",
			setMaterializedPath: async () => {}, setMaterializedPaths: async () => {},
			deleteMaterializedPath: async () => {}, listMaterializedPaths: async () => [],
		};
		let page = 0;
		const server = {
			changesAfter: async () => page++ === 0
				? { entries: [{ sequence: 1, documentId: bodyId, documentEpoch: 1, generation: 5, kind: "body" }],
					currentHighWater: 1, resetRequired: false }
				: { entries: [], currentHighWater: 1, resetRequired: false },
			settleRootThrough: async () => {},
			catchUpBodies: async () => new Map([[bodyId, { head, state: { bodyId, bodyEpoch: 1, generation: 5, encodedState } }]]),
			currentHead: async () => head,
			currentBody: async () => ({ bodyId, bodyEpoch: 1, generation: 5, encodedState }),
		};
		const writes: Array<{ path: string; content: string }> = [];
		const disk = {
			settleBody: async (input: { path: string; content: string }) => { writes.push(input); return "settled" as const; },
			moveBodies: async () => {}, deleteBody: async () => "deleted" as const,
		};
		const bodies = new BodyManager(database);
		const live = await bodies.load(bodyId);
		bodies.pin(bodyId); // an open (or warm, leased) body refuses replacement
		const client = new BootstrapClient(server as never, database as never, bodies, disk);
		const promotions: number[] = [];
		if (withPromotion) {
			client.configureLiveBodyPromotion(async (target) => {
				promotions.push(target.generation);
				return live.doc.getText("body").toJSON() === content;
			});
		}
		await client.run();
		bodies.unpin(bodyId);
		await bodies.destroy();
		return { outstanding: [...outstanding.values()], writes, promotions };
	};

	const without = await run(false);
	assert.equal(without.outstanding.length, 1, "without promotion the live body is left needing attention");
	assert.match(without.outstanding[0]!.reason, /cannot replace/);

	const withHook = await run(true);
	assert.deepEqual(withHook.promotions, [5]);
	assert.equal(withHook.outstanding.length, 0, "the already-current live body settles");
	assert.equal(withHook.writes.length, 1, "the verified server content is settled to disk");
	assert.equal(withHook.writes[0]!.path, "Live.md");
	assert.equal(withHook.writes[0]!.content, content);
});

s.test("verified body-only agreement creates a restart-safe component base", async () => {
	const bodyId = "body-common-base";
	const path = "notes/common.md";
	const content = "---\ntitle: server\n---\nshared base\n";
	const heldDiskContent = "---\ntitle: disk\n---\nshared base\n";
	const contentHash = await canonicalMarkdownHash(content);
	const bodyDoc = new Y.Doc({ guid: bodyId });
	bodyDoc.getText("body").insert(0, content);
	const encodedState = Y.encodeStateAsUpdate(bodyDoc);
	bodyDoc.destroy();
	const head: ClientCatalogEntry = {
		bodyId, bodyEpoch: 1, fileId: bodyId, path, generation: 7,
		contentHash, size: new TextEncoder().encode(content).byteLength,
	};
	const progress: StoredBootstrapProgress = {
		bootstrapId: "prepared", rootEpoch: 1, highWater: 0, nextCatalogCursor: null,
		stage: "complete", settledBodies: 1, totalBodies: 1, feedCursor: 0,
	};
	const documents = new Map<string, StoredDocument>();
	let materializedPath: string | null = null;
	let settlement: StoredBodySettlement | null = null;
	let outstanding: StoredOutstandingBody | null = null;
	let diskContent = heldDiskContent;
	let bodyFetches = 0;
	let diskWrites = 0;
	const database = {
		getDocument: async (id: string) => documents.get(id) ?? null,
		putDocument: async (document: StoredDocument) => { documents.set(document.documentId, document); },
		deleteDocument: async () => {},
		getBootstrapProgress: async () => progress,
		putBootstrapProgress: async () => {}, putFeedCursor: async () => {},
		getOutstanding: async () => outstanding,
		putOutstanding: async (value: StoredOutstandingBody) => { outstanding = structuredClone(value); },
		deleteOutstanding: async () => { outstanding = null; },
		listOutstanding: async () => outstanding ? [outstanding] : [],
		getMaterializedPath: async () => materializedPath,
		setMaterializedPath: async (_id: string, value: string) => { materializedPath = value; },
		setMaterializedPaths: async () => {}, deleteMaterializedPath: async () => {}, listMaterializedPaths: async () => [],
		getBodySettlement: async () => settlement,
		compareAndSwapBodySettlement: async (next: StoredBodySettlement, expected: number | null) => {
			if ((settlement?.localSettlementRevision ?? null) !== expected) return false;
			settlement = structuredClone(next); return true;
		},
		deleteBodySettlement: async () => { settlement = null; },
	};
	const server = {
		currentHead: async () => head,
		currentBody: async () => { bodyFetches++; return { bodyId, bodyEpoch: 1, generation: 7, encodedState }; },
	};
	const disk = {
		settleBody: async () => { diskWrites++; return "settled" as const; },
		moveBodies: async () => {}, deleteBody: async () => "deleted" as const,
		markPendingPath: () => {}, clearPendingPath: () => {},
		readCanonicalDiskEvidence: async () => ({
			content: diskContent,
			fingerprint: await exactMarkdownDiskFingerprint(diskContent),
		}),
	};
	const bodies = new BodyManager(database);
	bodies.coordinator.bindPath(path, bodyId);
	const repository = new BodySettlementRepository(
		database,
		BodySettlementRepository.markdownScope("vault-generation"),
		canonicalMarkdownHash,
	);
	const client = new BootstrapClient(server as never, database as never, bodies, disk as never);
	client.configureSettlements(repository);
	await client.settleBodyNow(bodyId);
	const storedSettlement = settlement as StoredBodySettlement | null;
	assert.equal(storedSettlement?.content, content);
	assert.equal(storedSettlement?.durableGeneration, 7);
	assert.equal(storedSettlement?.pathAtSettlement, path);
	assert.equal(storedSettlement?.format, 2);
	if (storedSettlement?.format === 2) assert.equal(storedSettlement.agreement, "body-only");
	assert.equal(diskContent, heldDiskContent, "bootstrap holds divergent disk properties");
	assert.equal(diskWrites, 1);
	assert.equal(
		(outstanding as StoredOutstandingBody | null)?.operation,
		"properties",
		"held properties remain explicit durable work",
	);
	outstanding = null;
	await bodies.destroy();
	const restartedBodies = new BodyManager(database);
	restartedBodies.coordinator.bindPath(path, bodyId);
	const restartedClient = new BootstrapClient(server as never, database as never, restartedBodies, disk as never);
	restartedClient.configureSettlements(new BodySettlementRepository(
		database,
		BodySettlementRepository.markdownScope("vault-generation"),
		canonicalMarkdownHash,
	));
	await restartedClient.settleBodyNow(bodyId);
	assert.equal(bodyFetches, 1, "valid persisted base enables the fenced fast path");
	assert.equal(diskWrites, 1, "valid exact disk evidence skips rematerialization");
	assert.equal(
		(outstanding as StoredOutstandingBody | null)?.operation,
		"properties",
		"restart self-heals missing dormant properties-held work",
	);
	diskContent = content;
	await restartedClient.settleBodyNow(bodyId);
	assert.equal(outstanding, null, "whole agreement clears properties-held work");
	await restartedBodies.destroy();
});

s.test("null feed head records delete settlement before advancing the cursor", async () => {
	const baseline = new Y.Doc({ guid: "deleted-body" });
	baseline.getText("body").insert(0, "last durable body");
	const stored: StoredDocument = {
		kind: "body",
		documentId: "deleted-body",
		bodyEpoch: 1,
		durableBaseline: "last durable body",
		generation: 2,
		encodedState: Y.encodeStateAsUpdate(baseline).slice().buffer,
		dirty: false,
		updatedAt: 1,
	};
	baseline.destroy();
	let progress: StoredBootstrapProgress = {
		bootstrapId: "complete-bootstrap",
		rootEpoch: 1,
		highWater: 0,
		nextCatalogCursor: null,
		stage: "complete",
		settledBodies: 1,
		totalBodies: 1,
		feedCursor: 0,
	};
	let outstanding: StoredOutstandingBody | null = null;
	const order: string[] = [];
	const database = {
		getBootstrapProgress: async () => progress,
		putBootstrapProgress: async (next: StoredBootstrapProgress) => { progress = { ...next }; },
		putFeedCursor: async ({ sequence }: { sequence: number }) => { order.push(`cursor:${sequence}`); },
		getOutstanding: async () => outstanding,
		putOutstanding: async (next: StoredOutstandingBody) => {
			outstanding = next;
			order.push("outstanding");
		},
		listOutstanding: async () => outstanding ? [outstanding] : [],
		deleteOutstanding: async () => { outstanding = null; },
		getMaterializedPath: async () => "notes/deleted.md",
		setMaterializedPath: async () => {},
		deleteMaterializedPath: async () => {},
		getDocument: async () => stored,
		deleteDocument: async () => {},
	};
	let page = 0;
	const server = {
		changesAfter: async () => page++ === 0
			? {
				entries: [{ sequence: 1, documentId: "deleted-body", documentEpoch: 1, generation: 2, kind: "delete" }],
				currentHighWater: 1,
				resetRequired: false,
			}
			: { entries: [], currentHighWater: 1, resetRequired: false },
		settleRootThrough: async () => { order.push("root"); },
		currentHead: async () => null,
	};
	const disk = {
		deleteBody: async () => "preserved-unresolved" as const,
		settleBody: async () => "settled" as const,
		moveBodies: async () => {},
	};
	const client = new BootstrapClient(
		server as never,
		database as never,
		{} as never,
		disk,
	);
	await client.run();
	assert.equal(progress.feedCursor, 1);
	const finalOutstanding = outstanding as StoredOutstandingBody | null;
	assert.equal(finalOutstanding?.operation, "delete");
	assert.ok(
		order.indexOf("outstanding") >= 0
			&& order.indexOf("outstanding") < order.indexOf("cursor:1"),
		"durable outstanding delete precedes feed cursor advancement",
	);
});
for (const endpoint of ["start", "root", "catalog", "bodies", "renew", "complete", "semanticCatalog", "semantic"] as const) {
	s.test(`G7 typed ${endpoint} rejection resets durable progress and restarts`, async () => {
		const fixture = await g7ClientFixture(endpoint);
		const result = await fixture.client.run();
		assert.equal(result.stage, "complete");
		assert.equal(result.bootstrapId, "fresh-g7");
		assert.equal(fixture.starts(), 2);
		assert.ok(fixture.writes.some((entry) => entry.bootstrapId === ""), "invalid operation is durably discarded before restart");
	});
}

s.test("G7 persistent rejection is bounded and ordinary failures do not restart", async () => {
	const fixture = await g7ClientFixture("start", true);
	await assert.rejects(() => fixture.client.run(), /bootstrap.*restart.*limit/i);
	assert.equal(fixture.starts(), 3);
	assert.equal(fixture.writes.at(-1)?.bootstrapId, "");
	const ordinary = await g7ClientFixture("start", true, "permission_denied");
	await assert.rejects(() => ordinary.client.run(), /permission_denied/);
	assert.equal(ordinary.starts(), 1);
	assert.equal(ordinary.writes.length, 0);
});

s.test("G7 prepare-root entry point independently recovers a stale operation", async () => {
	const fixture = await g7ClientFixture("start");
	const result = await prepareBootstrapRoot(fixture.server as never, fixture.database as never);
	assert.equal(result.progress.bootstrapId, "fresh-g7");
	assert.equal(fixture.starts(), 2);
});

s.test("G7 stale bootstrap recovery retains the feed cursor for deletions absent from the new active catalog", async () => {
	const fixture = await g7ClientFixture("start");
	await fixture.database.putBootstrapProgress({
		bootstrapId: "completed-old-operation", rootEpoch: 1, highWater: 12,
		nextCatalogCursor: null, stage: "complete", settledBodies: 1, totalBodies: 1, feedCursor: 12,
	});
	const originalStart = fixture.server.start;
	fixture.server.start = async (attemptId) => {
		const descriptor = await originalStart(attemptId);
		return { ...descriptor, capture: { ...descriptor.capture, vaultSequence: 25 },
			catalog: { ...descriptor.catalog, highWater: 25 } };
	};
	const result = await prepareBootstrapRoot(fixture.server as never, fixture.database as never);
	assert.equal(result.progress.bootstrapId, "fresh-g7");
	assert.equal(result.progress.highWater, 25);
	assert.equal(result.progress.feedCursor, 12, "unseen deletion events must be replayed after the fresh catalog");
	assert.equal(fixture.writes.find((entry) => entry.bootstrapId === "")?.feedCursor, 12);
});

s.test("G7 semantic restart drains in-flight work before resetting progress", async () => {
	const fixture = await g7ClientFixture("semantic");
	const order: string[] = [];
	const originalWrite = fixture.database.putBootstrapProgress;
	fixture.database.putBootstrapProgress = async (value) => {
		if (value.bootstrapId === "") order.push("reset");
		await originalWrite(value);
	};
	fixture.database.putDocument = async () => { order.push("document"); };
	fixture.server.semanticCatalog = async () => ({ entries: ["fast", "slow"].map((documentId) => ({
		documentId, fileId: documentId, kind: "canvas" as const, format: "json-canvas" as const, formatVersion: 1 as const,
		path: `${documentId}.canvas`, bodyEpoch: 1, generation: 1, contentHash: "0".repeat(64), size: 0,
	})), nextCursor: null });
	let rejected = false;
	fixture.server.semantic = async (_id, documentId) => {
		if (documentId === "fast" && !rejected) {
			rejected = true;
			throw Object.assign(new Error("expired"), { code: "bootstrap_not_running", reason: "expired", status: 409 });
		}
		if (documentId === "slow") {
			await new Promise<void>((resolve) => setTimeout(resolve, 15));
			order.push("slow-finished");
		}
		return { documentId, bodyEpoch: 1, generation: 1, encodedState: new Uint8Array([0, 0]) };
	};
	await fixture.client.run();
	assert.ok(order.indexOf("slow-finished") < order.indexOf("reset"), "old in-flight writes finish before clearing bootstrap state");
});

s.test("G7 HTTP adapter recognizes typed errors on JSON, raw, and batch endpoints only", async () => {
	let errorCode = "bootstrap_not_running";
	let status = 409;
	const port = new BootstrapHttpPort("https://g7.invalid", "vault", "test-token", {} as never, async () => ({
		status, headers: {}, arrayBuffer: new ArrayBuffer(0), json: { error: errorCode, reason: "expired" },
	}));
	for (const work of [() => port.start("stale", true), () => port.root("stale"), () => port.catalog("stale", null, 1),
		() => port.bodies("stale", ["body"]), () => port.body("stale", "body"), () => port.semantic("stale", "canvas"),
		() => port.semanticCatalog("stale", null, 1), () => port.renew("stale", 1), () => port.complete("stale")]) {
		await assert.rejects(work, (error: unknown) => (error as { code?: string }).code === "bootstrap_not_running");
	}
	errorCode = "bootstrap_owner_mismatch";
	status = 403;
	await assert.rejects(() => port.root("foreign"), /vault request failed \(403\)/);
});

async function g7ClientFixture(failAt: string, persistent = false, code = "bootstrap_not_running") {
	const root = new Y.Doc({ guid: "root" });
	root.getMap("sys").set("schemaVersion", SCHEMA_VERSION);
	const rootBytes = Y.encodeStateAsUpdate(root);
	root.destroy();
	let progress: StoredBootstrapProgress = { bootstrapId: "stale-g7", rootEpoch: 1, highWater: 0,
		nextCatalogCursor: null, stage: failAt === "root" ? "root-loaded" : "catalog-paging", settledBodies: 0, totalBodies: 0, feedCursor: 0 };
	const writes: StoredBootstrapProgress[] = [];
	let calls = 0;
	let failed = false;
	const fail = (endpoint: string) => {
		if (endpoint !== failAt || (failed && !persistent)) return;
		failed = true;
		throw Object.assign(new Error(code), { code, reason: "complete", status: 409 });
	};
	const database = {
		getBootstrapProgress: async () => (failAt === "root" || failAt.startsWith("semantic")) && calls === 0 ? null : { ...progress },
		putBootstrapProgress: async (value: StoredBootstrapProgress) => { progress = { ...value }; writes.push({ ...value }); },
		putDocument: async () => {}, putFeedCursor: async () => {}, listOutstanding: async () => [],
	};
	const server = {
		start: async (attemptId?: string) => {
			calls++;
			fail("start");
			return { bootstrapId: failed ? "fresh-g7" : attemptId ?? "stale-g7", createdAt: "", expiresAt: "", serverCompleted: false,
				capture: { vaultSequence: 0, rootEpoch: 1, rootGeneration: 1, rootCheckpointHash: await sha256(rootBytes) },
				catalog: { activeBodyCount: 0, activeSemanticCount: failAt.startsWith("semantic") ? 1 : 0,
					pageSize: 1000, firstCursor: null, feedFloor: 0, highWater: 0 } };
		},
		root: async () => { fail("root"); return rootBytes; },
		catalog: async () => { fail("catalog"); return { entries: [], nextCursor: null }; },
		bodies: async () => { fail("bodies"); return new Map(); },
		semanticCatalog: async () => { fail("semanticCatalog"); return { entries: [{ documentId: "canvas", fileId: "canvas",
			kind: "canvas" as const, format: "json-canvas" as const, formatVersion: 1 as const, path: "canvas.canvas",
			bodyEpoch: 1, generation: 1, contentHash: "0".repeat(64), size: 0 }], nextCursor: null }; },
		semantic: async (_id: string, documentId: string) => { fail("semantic");
			return { documentId, bodyEpoch: 1, generation: 1, encodedState: new Uint8Array([0, 0]) }; },
		renew: async () => { fail("renew"); },
		complete: async () => { fail("complete"); return { currentHighWater: 0 }; },
		changesAfter: async () => ({ entries: [], currentHighWater: 0, resetRequired: false }),
		settleRootThrough: async () => {},
	};
	const client = new BootstrapClient(server as never, database as never, {} as never, {} as never);
	return { client, database, server, writes, starts: () => calls };
}
await s.done();
