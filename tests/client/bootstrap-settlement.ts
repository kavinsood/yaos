import { strict as assert } from "node:assert";
import * as Y from "yjs";
import {
	BootstrapClient,
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
await s.done();
