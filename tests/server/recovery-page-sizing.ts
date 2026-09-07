import { sha256Hex } from "../../server/src/hex";
import { canonicalJsonBytes } from "../../server/src/recoveryCanonicalJson";
import type { CaptureDescriptor, CapturePlanEntry, CatalogDeltaEntry } from "../../server/src/recoveryProtocol";
import { VaultRecoveryService } from "../../server/src/vaultRecoveryService";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";
import { suite } from "../harness.ts";

const s = suite("recovery-page-sizing");
const vaultId = "vault-page-sizing-aa";
const vaultGeneration = "generation-page-sizing-aa";
const captureId = "capture-page-sizing-aa";
const capability = "capability-page-sizing-aa";
const hash = "a".repeat(64);

const unusedStorage: VaultStoragePort = {
	sql: {
		exec: (): never => {
			throw new Error("PageSizingStore: SQL is not used by page-sizing tests");
		},
	},
	transactionSync: <T>(closure: () => T): T => closure(),
};

class PageSizingStore extends VaultStore {
	readonly capture: CaptureDescriptor;

	constructor(
		private readonly planEntries: CapturePlanEntry[],
		private readonly deltaEntries: CatalogDeltaEntry[],
		capabilityHash: string,
	) {
		super(unusedStorage);
		const future = Date.now() + 60_000;
		this.capture = {
			captureId,
			requestId: "request-page-sizing-aa",
			vaultId,
			vaultGeneration,
			boundarySequence: 10_000,
			rootGeneration: 1,
			runtimeEpoch: "runtime-page-sizing-aa",
			reason: "manual",
			state: "planning",
			jobId: "capture:vault-page-sizing-aa:generation-page-sizing-aa:capture-page-sizing-aa",
			capabilityHash,
			capabilityExpiresAt: future,
			pinSoftExpiresAt: future,
			pinHardExpiresAt: future,
			planDigest: null,
			deltaDigest: null,
			planComplete: false,
			gcEpoch: null,
			baseSnapshotId: null,
			plannedActiveFiles: 0,
			plannedDeletedFiles: 0,
			plannedAttachments: 0,
			snapshotRootKey: null,
			snapshotRootHash: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			error: null,
		};
	}

	override vaultMetadata() {
		return {
			vaultId,
			vaultGeneration,
			schemaVersion: 7 as const,
			storageFormatVersion: 3 as const,
			provisionedAt: 1,
		};
	}

	override reapExpiredRecoveryCaptures(): string[] { return []; }
	override recoveryCapture(requestedCaptureId: string): CaptureDescriptor | null {
		return requestedCaptureId === captureId ? this.capture : null;
	}
	override getPin(requestedPinId: string) {
		if (requestedPinId !== captureId) return null;
		return {
			pinId: captureId,
			kind: "capture" as const,
			boundarySequence: this.capture.boundarySequence,
			createdAt: this.capture.createdAt,
			softExpiresAt: this.capture.pinSoftExpiresAt,
			hardExpiresAt: this.capture.pinHardExpiresAt,
			lastProgressAt: this.capture.updatedAt,
			progress: 0,
		};
	}
	override listCapturePlanAt(_captureId: string, _stream: "active" | "deleted" | "attachments", _cursor: string | null, limit: number) {
		return this.planEntries.slice(0, limit);
	}
	override planPageCommitment() { return null; }
	override recordPlanPage(input: { rollingDigest: string }) {
		this.capture.planDigest = input.rollingDigest;
		return { digest: input.rollingDigest, replay: false };
	}
	override missingCoverage(_captureId: string, contentHashes: string[], nodeHashes: string[]) {
		return { contentHashes, nodeHashes };
	}
	override journalFloor(): number { return 0; }
	override catalogDeltaAt(_afterSequence: number, _throughSequence: number, _cursor: string | null, limit: number) {
		return this.deltaEntries.slice(0, limit);
	}
	override deltaPageCommitment() { return null; }
	override recordDeltaPage(input: { rollingDigest: string }) {
		this.capture.deltaDigest = input.rollingDigest;
		return { digest: input.rollingDigest, replay: false };
	}
}

function activeEntry(index: number): CapturePlanEntry {
	return {
		kind: "active",
		bodyId: `body-${index.toString().padStart(4, "0")}`,
		fileId: `file-${index.toString().padStart(4, "0")}`,
		canonicalPath: `Notes/${index.toString().padStart(4, "0")}.md`,
		generation: 1,
		contentHash: hash,
		size: 100,
	};
}

function deltaEntry(index: number): CatalogDeltaEntry {
	return {
		sequence: index + 1,
		order: 0,
		kind: "body-hash",
		identity: `body-${index.toString().padStart(4, "0")}`,
		path: `Notes/${index.toString().padStart(4, "0")}.md`,
		previousPath: null,
		contentHash: hash,
		size: 100,
		mime: null,
	};
}

s.test("capture-plan and delta sizing encode every considered entry exactly once", async () => {
	const pageEntries = 200;
	const planEntries = Array.from({ length: pageEntries + 1 }, (_, index) => activeEntry(index));
	const deltaEntries = Array.from({ length: pageEntries + 1 }, (_, index) => deltaEntry(index));
	const counts = new Map<CapturePlanEntry | CatalogDeltaEntry, number>();
	const store = new PageSizingStore(
		planEntries,
		deltaEntries,
		await sha256Hex(new TextEncoder().encode(capability)),
	);
	const service = new VaultRecoveryService({
		alarms: { setAlarm: async () => {}, deleteAlarm: async () => {} },
		store: () => store,
		runtimeEpoch: "runtime-page-sizing-aa",
		flushLoadedDocuments: async () => {},
		hasPendingPersistence: () => false,
		fenceRuntime: () => {},
		closeSockets: () => {},
		canonicalPageEntryBytes: (entry) => {
			counts.set(entry, (counts.get(entry) ?? 0) + 1);
			return canonicalJsonBytes(entry);
		},
	});

	const plan = await service.getCapturePlanPage({
		vaultId,
		vaultGeneration,
		captureId,
		boundarySequence: store.capture.boundarySequence,
		capability,
		stream: "active",
		cursor: null,
		maxEntries: pageEntries,
		maxResponseBytes: 4 * 1024 * 1024,
	});
	const delta = await service.getCatalogDeltaPage({
		captureId,
		boundarySequence: store.capture.boundarySequence,
		capability,
		afterSequence: 0,
		cursor: null,
		maxEntries: pageEntries,
		maxResponseBytes: 4 * 1024 * 1024,
	});

	if (plan.entries.length !== pageEntries || plan.terminal || delta.entries.length !== pageEntries || delta.terminal) {
		throw new Error("test setup did not produce two full non-terminal pages");
	}
	for (const entry of [...planEntries.slice(0, pageEntries), ...deltaEntries.slice(0, pageEntries)]) {
		if (counts.get(entry) !== 1) throw new Error("a considered page entry was not encoded exactly once");
	}
	if (counts.has(planEntries[pageEntries]!) || counts.has(deltaEntries[pageEntries]!)) {
		throw new Error("lookahead sentinels were unnecessarily encoded");
	}
	if (counts.size !== pageEntries * 2) throw new Error("page sizing performed unexpected entry encodes");
});

await s.done();
