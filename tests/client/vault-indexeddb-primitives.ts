import { strict as assert } from "node:assert";
import {
	assertResetAllowed,
	PendingWorkError,
	schema10VaultIdbName,
	VaultIndexedDb,
	type PendingWorkSummary,
	type StoredCanvasLifecycle,
} from "../../src/sync/vaultIndexedDb";
import { parsePendingRecoveryState } from "../../src/snapshots/recoveryState";
import { FakeIndexedDb } from "../mocks/indexedDb";
import { vaultIdbName } from "../../src/sync/vaultPersistence";
import { localVaultImportIdbName } from "../../src/onboarding/localVaultImportStore";
import { suite } from "../harness.ts";

const s = suite("vault-indexeddb-primitives");

const clean: PendingWorkSummary = {
	dirtyDocuments: 0,
	pendingCandidates: 0,
	lifecycleOperations: 0,
	attachmentOperations: 0,
	outstandingSettlements: 0,
	activeRecoveryOperations: 0,
};

s.test("schema-10 databases fence vault generation and local folder identity", () => {
	const legacyCache = vaultIdbName("vault-a", "folder-a");
	assert.equal(
		schema10VaultIdbName("vault-a", "generation-a", "folder-a"),
		"yaos:vault-a:generation-a:folder-a:schema-10",
	);
	assert.notEqual(schema10VaultIdbName("vault-a", "generation-a", "folder-a"), legacyCache);
	assert.notEqual(
		schema10VaultIdbName("vault-a", "generation-a", "folder-a"),
		schema10VaultIdbName("vault-a", "generation-b", "folder-a"),
		"destructive reprovisioning never opens the prior generation cache",
	);
	assert.notEqual(
		schema10VaultIdbName("vault-a", "generation-a", "folder-a"),
		schema10VaultIdbName("vault-a", "generation-a", "folder-b"),
		"two local folders enrolled in the same vault never share schema-4 state",
	);
	assert.equal(localVaultImportIdbName("vault-a", "folder-a"), `${legacyCache}:schema-10:local-import`);
	assert.throws(() => schema10VaultIdbName("vault-a", "", "folder-a"), /generation/);
	assert.throws(() => schema10VaultIdbName("vault-a", "generation-a", ""), /folder key/);
	assert.throws(() => localVaultImportIdbName("", "folder-a"), /vault ID/);
});

s.test("ordinary reset refuses every class of pending schema-4 work", () => {
	assert.doesNotThrow(() => assertResetAllowed(clean));
	for (const key of Object.keys(clean) as Array<keyof PendingWorkSummary>) {
		const pending = { ...clean, [key]: 1 };
		assert.throws(
			() => assertResetAllowed(pending),
			(error) => error instanceof PendingWorkError && error.summary[key] === 1,
			`${key} must fence cache reset`,
		);
		assert.doesNotThrow(() => assertResetAllowed(pending, true));
	}
});


s.test("recovery operation identities hydrate from the vault-and-folder database after restart", async () => {
	const indexedDb = new FakeIndexedDb();
	const first = new VaultIndexedDb("vault-recovery", "generation-recovery", "folder-recovery", indexedDb);
	await first.putRecoveryState({
		activeCaptureId: "capture-1",
		activeRestore: { restoreId: "restore-1", snapshotId: "snapshot-1" },
		lastCaptureStatus: null,
		lastRestoreStatus: null,
		lastRecoveryStatus: null,
	});
	await first.close();

	const restarted = new VaultIndexedDb("vault-recovery", "generation-recovery", "folder-recovery", indexedDb);
	const hydrated = parsePendingRecoveryState(await restarted.getRecoveryState());
	assert.equal(hydrated.activeCaptureId, "capture-1");
	assert.equal(hydrated.activeRestore?.restoreId, "restore-1");
	await restarted.close();
});

s.test("attachment operations allocate a durable causal sequence transactionally", async () => {
	const indexedDb = new FakeIndexedDb();
	const database = new VaultIndexedDb("vault-attachments", "generation-attachments", "folder-attachments", indexedDb);
	const first = await database.putAttachmentOperation({
		vaultId: "vault-attachments",
		vaultGeneration: "generation-attachments",
		rootEpoch: 1,
		mutation: { operationId: "operation-z", kind: "upsert", path: "assets/order.bin", expectedRevision: null,
			hash: "a".repeat(64), size: 1, mime: "application/octet-stream" },
		localSequence: 0,
		createdAt: 1,
		attempts: 0,
		lastAttemptAt: null,
	});
	const second = await database.putAttachmentOperation({
		vaultId: "vault-attachments",
		vaultGeneration: "generation-attachments",
		rootEpoch: 1,
		mutation: { operationId: "operation-a", kind: "delete", path: "assets/order.bin", expectedRevision: first.mutation.operationId },
		localSequence: 0,
		createdAt: 1,
		attempts: 0,
		lastAttemptAt: null,
	});
	assert.equal(first.localSequence, 1);
	assert.equal(second.localSequence, 2);
	assert.deepEqual((await database.listAttachmentOperations()).map((operation) => operation.mutation.operationId), ["operation-z", "operation-a"]);
	await database.close();
});

s.test("body common bases survive restart in the generation-scoped database", async () => {
	const indexedDb = new FakeIndexedDb();
	const first = new VaultIndexedDb("vault-base", "generation-base", "folder-base", indexedDb);
	assert.equal(await first.compareAndSwapBodySettlement({
		format: 2,
		bodyId: "body-base",
		vaultGeneration: "generation-base",
		canonicalVersion: "markdown-lf-v1",
		boundaryVersion: "frontmatter-boundary-v1",
		agreement: "whole",
		content: "common content",
		contentHash: "c".repeat(64),
		diskContentHash: "c".repeat(64),
		durableGeneration: 3,
		serverContentHash: "c".repeat(64),
		diskFingerprint: { bytes: 14, hash: "d".repeat(64) },
		pathAtSettlement: "common.md",
		localSettlementRevision: 1,
		settledAt: 100,
		bodyBase: { kind: "available", content: "common content", contentHash: "c".repeat(64), advancedAtGeneration: 3 },
		propertiesBase: { kind: "available", content: "", contentHash: "c".repeat(64), advancedAtGeneration: 3 },
		observation: {
			serverBodyHash: "c".repeat(64),
			serverPropertiesHash: "c".repeat(64),
			diskBodyHash: "c".repeat(64),
			diskPropertiesHash: "c".repeat(64),
		},
	}, null), true);
	await first.close();

	const restarted = new VaultIndexedDb("vault-base", "generation-base", "folder-base", indexedDb);
	assert.equal((await restarted.getBodySettlement("body-base"))?.content, "common content");
	await restarted.deleteBodySettlement("body-base");
	assert.equal(await restarted.getBodySettlement("body-base"), null);
	await restarted.close();
});

s.test("Canvas lifecycle binary payloads are owned across IndexedDB writes and reads", async () => {
	const indexedDb = new FakeIndexedDb();
	const database = new VaultIndexedDb("vault-canvas-binary", "generation-canvas-binary", "folder-canvas-binary", indexedDb);
	const encodedUpdate = new Uint8Array([1, 2, 3]).buffer;
	const sourceBytes = new Uint8Array([4, 5, 6]).buffer;
	const promotion: StoredCanvasLifecycle = {
		operationId: "promote-binary",
		requestDigest: "digest-promote",
		documentId: "canvas-binary",
		bodyEpoch: 1,
		rootEpoch: 2,
		kind: "promote",
		path: "Binary.canvas",
		sourceRevision: "revision",
		sourceHash: "a".repeat(64),
		sourceSize: 3,
		contentHash: "b".repeat(64),
		contentSize: 3,
		candidateDigest: "c".repeat(64),
		encodedUpdate,
		sourceBytes,
		createdAt: 1,
		attempts: 0,
		lastAttemptAt: null,
	};
	await database.putCanvasLifecycle(promotion);
	new Uint8Array(encodedUpdate)[0] = 99;
	new Uint8Array(sourceBytes)[0] = 98;

	const first = (await database.listCanvasLifecycle())[0];
	assert.equal(first?.kind, "promote");
	if (!first || first.kind !== "promote") return;
	assert.deepEqual([first.bodyEpoch, first.rootEpoch], [1, 2]);
	assert.deepEqual([...new Uint8Array(first.encodedUpdate)], [1, 2, 3]);
	assert.deepEqual([...new Uint8Array(first.sourceBytes)], [4, 5, 6]);
	new Uint8Array(first.encodedUpdate)[1] = 97;
	new Uint8Array(first.sourceBytes)[1] = 96;

	const second = (await database.listCanvasLifecycle())[0];
	assert.equal(second?.kind, "promote");
	if (!second || second.kind !== "promote") return;
	assert.deepEqual([...new Uint8Array(second.encodedUpdate)], [1, 2, 3]);
	assert.deepEqual([...new Uint8Array(second.sourceBytes)], [4, 5, 6]);
	await database.close();
});
await s.done();
