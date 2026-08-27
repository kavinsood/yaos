import { strict as assert } from "node:assert";
import {
	assertResetAllowed,
	PendingWorkError,
	schema4VaultIdbName,
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
	outstandingSettlements: 0,
	activeRecoveryOperations: 0,
};

s.test("schema-4 databases fence vault generation and local folder identity", () => {
	const legacyCache = vaultIdbName("vault-a", "folder-a");
	assert.equal(
		schema4VaultIdbName("vault-a", "generation-a", "folder-a"),
		"yaos:vault-a:generation-a:folder-a:schema-4",
	);
	assert.notEqual(schema4VaultIdbName("vault-a", "generation-a", "folder-a"), legacyCache);
	assert.notEqual(
		schema4VaultIdbName("vault-a", "generation-a", "folder-a"),
		schema4VaultIdbName("vault-a", "generation-b", "folder-a"),
		"destructive reprovisioning never opens the prior generation cache",
	);
	assert.notEqual(
		schema4VaultIdbName("vault-a", "generation-a", "folder-a"),
		schema4VaultIdbName("vault-a", "generation-a", "folder-b"),
		"two local folders enrolled in the same vault never share schema-4 state",
	);
	assert.equal(localVaultImportIdbName("vault-a", "folder-a"), `${legacyCache}:schema-4:local-import`);
	assert.throws(() => schema4VaultIdbName("vault-a", "", "folder-a"), /generation/);
	assert.throws(() => schema4VaultIdbName("vault-a", "generation-a", ""), /folder key/);
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
await s.done();
