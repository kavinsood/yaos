import { VaultRecoveryService } from "../../server/src/vaultRecoveryService";
import {
	type RecoverySnapshotCatalogEntry,
	VaultStore,
	type VaultStoragePort,
} from "../../server/src/vaultStore";
import { makeDurableObjectState, makeEnv } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("snapshot-v2-retention");
const vaultId = "vault-retention-aa";
const vaultGeneration = "generation-retention-aa";

type Snapshot = RecoverySnapshotCatalogEntry;

function snapshot(snapshotId: string, completedAt: number, pinned = false): Snapshot {
	return {
		snapshotId,
		boundarySequence: completedAt,
		rootKey: `vault/${vaultId}/${vaultGeneration}/recovery-v2/roots/${snapshotId}.json`,
		rootHash: completedAt.toString(16).padStart(64, "0"),
		reason: "manual",
		pinned,
		createdAt: completedAt - 1,
		completedAt,
	};
}
const unusedStorage: VaultStoragePort = {
	sql: {
		exec: (): never => {
			throw new Error("RetentionStore: SQL is not used by retention tests");
		},
	},
	transactionSync: <T>(closure: () => T): T => closure(),
};

class RetentionStore extends VaultStore {
	constructor(
		private readonly catalog: Map<string, Snapshot>,
		private readonly dependencies: Set<string>,
		private readonly deletes: string[],
		private readonly pins: Array<{ snapshotId: string; pinned: boolean }>,
	) {
		super(unusedStorage);
	}

	override vaultMetadata() {
		return {
			vaultId,
			vaultGeneration,
			schemaVersion: 4 as const,
			storageFormatVersion: 1 as const,
			provisionedAt: 1,
		};
	}

	override listSnapshots(_cursor: string | null, _limit = 100): Snapshot[] {
		return [...this.catalog.values()];
	}

	override setSnapshotPinned(snapshotId: string, pinned: boolean): void {
		const entry = this.catalog.get(snapshotId);
		if (!entry) throw new Error("snapshot not found");
		entry.pinned = pinned;
		this.pins.push({ snapshotId, pinned });
	}

	override deleteSnapshot(snapshotId: string): boolean {
		this.deletes.push(snapshotId);
		if (this.dependencies.has(snapshotId)) throw new Error("snapshot is retained by policy or dependency");
		return this.catalog.delete(snapshotId);
	}

	override snapshot(snapshotId: string): Snapshot | null {
		return this.catalog.get(snapshotId) ?? null;
	}
}


function retentionService(initial: Snapshot[], dependentIds: string[] = []) {
	const catalog = new Map(initial.map((entry) => [entry.snapshotId, { ...entry }]));
	const dependencies = new Set(dependentIds);
	const deletes: string[] = [];
	const pins: Array<{ snapshotId: string; pinned: boolean }> = [];
	const store = new RetentionStore(catalog, dependencies, deletes, pins);
	const service = new VaultRecoveryService({
		ctx: makeDurableObjectState(),
		env: makeEnv(),
		store: () => store,
		runtimeEpoch: "runtime-retention-aa",
		flushLoadedDocuments: async () => {},
		hasPendingPersistence: () => false,
		fenceRuntime: () => {},
	});
	return { service, catalog, deletes, pins };
}

s.test("retention keeps newest roots, removes only catalog authority, and never scans R2", async () => {
	const { service, catalog, deletes } = retentionService([
		snapshot("snapshot-1", 1),
		snapshot("snapshot-2", 2),
		snapshot("snapshot-3", 3),
		snapshot("snapshot-4", 4),
	]);
	const result = await service.applyRecoveryRetention({ vaultId, policy: { keepLast: 2 } });
	if (result.retained.join(",") !== "snapshot-4,snapshot-3" || result.removed.join(",") !== "snapshot-2,snapshot-1") {
		throw new Error("newest-root retention changed");
	}
	if (deletes.join(",") !== "snapshot-2,snapshot-1" || [...catalog.keys()].sort().join(",") !== "snapshot-3,snapshot-4") {
		throw new Error("retention deleted outside catalog authority");
	}
});

s.test("explicit pins survive retention while stale pin state is cleanly replaced", async () => {
	const { service, catalog, pins } = retentionService([
		snapshot("snapshot-old", 1, true),
		snapshot("snapshot-middle", 2, true),
		snapshot("snapshot-new", 3),
	]);
	const result = await service.applyRecoveryRetention({
		vaultId,
		policy: { keepLast: 1, pinnedSnapshotIds: ["snapshot-old"] },
	});
	if (!catalog.has("snapshot-old") || !catalog.has("snapshot-new") || catalog.has("snapshot-middle")) {
		throw new Error("explicit retention pins changed");
	}
	if (!pins.some((entry) => entry.snapshotId === "snapshot-middle" && !entry.pinned)) {
		throw new Error("stale pin was not removed");
	}
	if (result.retained.join(",") !== "snapshot-new,snapshot-old") throw new Error("retained result omitted pinned root");
});

s.test("capture and restore dependencies defer catalog deletion until release", async () => {
	const { service, catalog, deletes } = retentionService([
		snapshot("snapshot-dependent", 1),
		snapshot("snapshot-new", 2),
	], ["snapshot-dependent"]);
	const result = await service.applyRecoveryRetention({ vaultId, policy: { keepLast: 1 } });
	if (result.deferred.join(",") !== "snapshot-dependent" || result.removed.length !== 0
		|| !catalog.has("snapshot-dependent") || deletes.join(",") !== "snapshot-dependent") {
		throw new Error("active dependency did not fence retention deletion");
	}
	if (result.retained.join(",") !== "snapshot-new,snapshot-dependent") {
		throw new Error("deferred dependency was not reported as retained");
	}
});

s.test("retention request for another vault cannot mutate this generation", async () => {
	const { service, catalog, deletes, pins } = retentionService([snapshot("snapshot-1", 1)]);
	let rejected = false;
	try {
		await service.applyRecoveryRetention({ vaultId: "vault-stale-aa", policy: { keepLast: 1 } });
	} catch {
		rejected = true;
	}
	if (!rejected || deletes.length !== 0 || pins.length !== 0 || catalog.size !== 1) {
		throw new Error("foreign vault retention mutated catalog state");
	}
});

await s.done();
