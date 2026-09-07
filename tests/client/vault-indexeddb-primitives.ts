import { strict as assert } from "node:assert";
import {
	assertResetAllowed,
	PendingWorkError,
	schema6VaultIdbName,
	VaultIndexedDb,
	type PendingWorkSummary,
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

s.test("schema-4 databases fence vault generation and local folder identity", () => {
	const legacyCache = vaultIdbName("vault-a", "folder-a");
	assert.equal(
		schema6VaultIdbName("vault-a", "generation-a", "folder-a"),
		"yaos:vault-a:generation-a:folder-a:schema-6",
	);
	assert.notEqual(schema6VaultIdbName("vault-a", "generation-a", "folder-a"), legacyCache);
	assert.notEqual(
		schema6VaultIdbName("vault-a", "generation-a", "folder-a"),
		schema6VaultIdbName("vault-a", "generation-b", "folder-a"),
		"destructive reprovisioning never opens the prior generation cache",
	);
	assert.notEqual(
		schema6VaultIdbName("vault-a", "generation-a", "folder-a"),
		schema6VaultIdbName("vault-a", "generation-a", "folder-b"),
		"two local folders enrolled in the same vault never share schema-4 state",
	);
	assert.equal(localVaultImportIdbName("vault-a", "folder-a"), `${legacyCache}:schema-6:local-import`);
	assert.throws(() => schema6VaultIdbName("vault-a", "", "folder-a"), /generation/);
	assert.throws(() => schema6VaultIdbName("vault-a", "generation-a", ""), /folder key/);
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
await s.done();
