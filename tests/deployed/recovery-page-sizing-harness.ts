import { sha256Hex } from "../../server/src/hex";
import { canonicalJsonBytes } from "../../server/src/recoveryCanonicalJson";
import {
	MAX_CAPTURE_PLAN_BYTES,
	MAX_CAPTURE_PLAN_ENTRIES,
	type CaptureDescriptor,
	type CapturePlanEntry,
	type CatalogDeltaEntry,
} from "../../server/src/recoveryProtocol";
import { VaultRecoveryService } from "../../server/src/vaultRecoveryService";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";

const VAULT_ID = "vault-deployed-page-sizing-aa";
const VAULT_GENERATION = "generation-deployed-page-sizing-aa";
const CAPTURE_ID = "capture-deployed-page-sizing-aa";
const CAPABILITY = "capability-deployed-page-sizing-aa";
const CONTENT_HASH = "a".repeat(64);
const DEFAULT_PAGE_SIZES = [25, 100, 200, MAX_CAPTURE_PLAN_ENTRIES] as const;

const unusedStorage: VaultStoragePort = {
	sql: {
		exec: (): never => {
			throw new Error("DeployedPageSizingStore: SQL is not used by this harness");
		},
	},
	transactionSync: <T>(closure: () => T): T => closure(),
};

class DeployedPageSizingStore extends VaultStore {
	readonly capture: CaptureDescriptor;

	constructor(
		private readonly planEntries: CapturePlanEntry[],
		private readonly deltaEntries: CatalogDeltaEntry[],
		capabilityHash: string,
	) {
		super(unusedStorage);
		const now = Date.now();
		const future = now + 60_000;
		this.capture = {
			captureId: CAPTURE_ID,
			requestId: "request-deployed-page-sizing-aa",
			vaultId: VAULT_ID,
			vaultGeneration: VAULT_GENERATION,
			boundarySequence: 10_000,
			rootGeneration: 1,
			runtimeEpoch: "runtime-deployed-page-sizing-aa",
			reason: "manual",
			state: "planning",
			jobId: "capture:vault-deployed-page-sizing-aa:generation-deployed-page-sizing-aa:capture-deployed-page-sizing-aa",
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
			createdAt: now,
			updatedAt: now,
			error: null,
		};
	}

	override vaultMetadata() {
		return {
			vaultId: VAULT_ID,
			vaultGeneration: VAULT_GENERATION,
			schemaVersion: 8 as const,
			storageFormatVersion: 3 as const,
			provisionedAt: 1,
		};
	}

	override reapExpiredRecoveryCaptures(): string[] { return []; }
	override recoveryCapture(requestedCaptureId: string): CaptureDescriptor | null {
		return requestedCaptureId === CAPTURE_ID ? this.capture : null;
	}
	override getPin(requestedPinId: string) {
		if (requestedPinId !== CAPTURE_ID) return null;
		return {
			pinId: CAPTURE_ID,
			kind: "capture" as const,
			boundarySequence: this.capture.boundarySequence,
			createdAt: this.capture.createdAt,
			softExpiresAt: this.capture.pinSoftExpiresAt,
			hardExpiresAt: this.capture.pinHardExpiresAt,
			lastProgressAt: this.capture.updatedAt,
			progress: 0,
		};
	}
	override listCapturePlanAt(
		_captureId: string,
		_stream: "active" | "deleted" | "attachments",
		_cursor: string | null,
		limit: number,
	) {
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
	override catalogDeltaAt(
		_afterSequence: number,
		_throughSequence: number,
		_cursor: string | null,
		limit: number,
	) {
		return this.deltaEntries.slice(0, limit);
	}
	override deltaPageCommitment() { return null; }
	override recordDeltaPage(input: { rollingDigest: string }) {
		this.capture.deltaDigest = input.rollingDigest;
		return { digest: input.rollingDigest, replay: false };
	}
}

function activeEntry(index: number): CapturePlanEntry {
	const suffix = index.toString().padStart(4, "0");
	return {
		kind: "active",
		bodyId: `body-${suffix}`,
		fileId: `file-${suffix}`,
		canonicalPath: `Notes/${suffix}.md`,
		generation: 1,
		contentHash: CONTENT_HASH,
		size: 100,
	};
}

function deltaEntry(index: number): CatalogDeltaEntry {
	const suffix = index.toString().padStart(4, "0");
	return {
		sequence: index + 1,
		order: 0,
		kind: "body-hash",
		identity: `body-${suffix}`,
		path: `Notes/${suffix}.md`,
		previousPath: null,
		contentHash: CONTENT_HASH,
		size: 100,
		mime: null,
	};
}

export interface RecoveryPageSizingValidationInput {
	/** Sizes must fit the product's real recovery-page entry ceiling. */
	pageSizes?: readonly number[];
}

export interface RecoveryPageSizingMethodResult {
	entriesReturned: number;
	terminal: boolean;
	sizingSerializationCalls: number;
	uniqueEntriesSized: number;
	duplicateSizingSerializations: number;
	lookaheadSerializationCalls: number;
	oldQuadraticSizingCalls: number;
	elapsedMs: number;
}

export interface RecoveryPageSizingCaseResult {
	pageSize: number;
	capturePlan: RecoveryPageSizingMethodResult;
	catalogDelta: RecoveryPageSizingMethodResult;
	passed: true;
}

export interface RecoveryPageSizingValidationResult {
	format: "yaos-deployed-recovery-page-sizing-v1";
	implementation: "VaultRecoveryService";
	productMaxEntries: number;
	productMaxResponseBytes: number;
	pageSizes: number[];
	cases: RecoveryPageSizingCaseResult[];
	passed: true;
}

function checkedPageSizes(input: RecoveryPageSizingValidationInput): number[] {
	const values = input.pageSizes === undefined ? [...DEFAULT_PAGE_SIZES] : [...input.pageSizes];
	if (values.length === 0 || values.length > 16) throw new Error("pageSizes must contain between 1 and 16 values");
	for (const value of values) {
		if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CAPTURE_PLAN_ENTRIES) {
			throw new Error(`page size must be an integer from 1 through ${MAX_CAPTURE_PLAN_ENTRIES}`);
		}
	}
	return values;
}

function summarize(
	entries: readonly (CapturePlanEntry | CatalogDeltaEntry)[],
	lookahead: CapturePlanEntry | CatalogDeltaEntry,
	counts: ReadonlyMap<CapturePlanEntry | CatalogDeltaEntry, number>,
	elapsedMs: number,
	entriesReturned: number,
	terminal: boolean,
): RecoveryPageSizingMethodResult {
	const sizingSerializationCalls = entries.reduce((sum, entry) => sum + (counts.get(entry) ?? 0), 0);
	const uniqueEntriesSized = entries.filter((entry) => counts.has(entry)).length;
	const duplicateSizingSerializations = entries.reduce(
		(sum, entry) => sum + Math.max(0, (counts.get(entry) ?? 0) - 1),
		0,
	);
	return {
		entriesReturned,
		terminal,
		sizingSerializationCalls,
		uniqueEntriesSized,
		duplicateSizingSerializations,
		lookaheadSerializationCalls: counts.get(lookahead) ?? 0,
		oldQuadraticSizingCalls: entries.length * (entries.length + 1) / 2,
		elapsedMs,
	};
}

function assertLinearResult(label: string, pageSize: number, result: RecoveryPageSizingMethodResult): void {
	if (result.entriesReturned !== pageSize) throw new Error(`${label}: expected ${pageSize} entries, got ${result.entriesReturned}`);
	if (result.terminal) throw new Error(`${label}: lookahead was not reflected in the terminal flag`);
	if (result.sizingSerializationCalls !== pageSize || result.uniqueEntriesSized !== pageSize) {
		throw new Error(`${label}: sizing did not serialize each considered entry exactly once`);
	}
	if (result.duplicateSizingSerializations !== 0) throw new Error(`${label}: duplicate sizing serialization detected`);
	if (result.lookaheadSerializationCalls !== 0) throw new Error(`${label}: lookahead entry was unnecessarily serialized`);
}

/**
 * Executes the production recovery-page methods inside the deployed Worker.
 * The injected callback instruments only per-entry page-size accounting; final
 * canonical page hashing remains unchanged and deliberately outside the count.
 */
export async function runRecoveryPageSizingValidation(
	input: RecoveryPageSizingValidationInput = {},
): Promise<RecoveryPageSizingValidationResult> {
	const pageSizes = checkedPageSizes(input);
	const capabilityHash = await sha256Hex(new TextEncoder().encode(CAPABILITY));
	const cases: RecoveryPageSizingCaseResult[] = [];

	for (const pageSize of pageSizes) {
		const planEntries = Array.from({ length: pageSize + 1 }, (_, index) => activeEntry(index));
		const deltaEntries = Array.from({ length: pageSize + 1 }, (_, index) => deltaEntry(index));
		const counts = new Map<CapturePlanEntry | CatalogDeltaEntry, number>();
		const store = new DeployedPageSizingStore(planEntries, deltaEntries, capabilityHash);
		const service = new VaultRecoveryService({
			alarms: { setAlarm: async () => {}, deleteAlarm: async () => {} },
			store: () => store,
			runtimeEpoch: "runtime-deployed-page-sizing-aa",
			flushLoadedDocuments: async () => {},
			hasPendingPersistence: () => false,
			fenceRuntime: () => {},
			closeSockets: () => {},
			canonicalPageEntryBytes: (entry) => {
				counts.set(entry, (counts.get(entry) ?? 0) + 1);
				return canonicalJsonBytes(entry);
			},
		});

		const planStarted = performance.now();
		const plan = await service.getCapturePlanPage({
			vaultId: VAULT_ID,
			vaultGeneration: VAULT_GENERATION,
			captureId: CAPTURE_ID,
			boundarySequence: store.capture.boundarySequence,
			capability: CAPABILITY,
			stream: "active",
			cursor: null,
			maxEntries: pageSize,
			maxResponseBytes: MAX_CAPTURE_PLAN_BYTES,
		});
		const planElapsedMs = performance.now() - planStarted;
		const planResult = summarize(
			planEntries.slice(0, pageSize),
			planEntries[pageSize]!,
			counts,
			planElapsedMs,
			plan.entries.length,
			plan.terminal,
		);

		const deltaStarted = performance.now();
		const delta = await service.getCatalogDeltaPage({
			captureId: CAPTURE_ID,
			boundarySequence: store.capture.boundarySequence,
			capability: CAPABILITY,
			afterSequence: 0,
			cursor: null,
			maxEntries: pageSize,
			maxResponseBytes: MAX_CAPTURE_PLAN_BYTES,
		});
		const deltaElapsedMs = performance.now() - deltaStarted;
		const deltaResult = summarize(
			deltaEntries.slice(0, pageSize),
			deltaEntries[pageSize]!,
			counts,
			deltaElapsedMs,
			delta.entries.length,
			delta.terminal,
		);

		assertLinearResult("capture plan", pageSize, planResult);
		assertLinearResult("catalog delta", pageSize, deltaResult);
		cases.push({ pageSize, capturePlan: planResult, catalogDelta: deltaResult, passed: true });
	}

	return {
		format: "yaos-deployed-recovery-page-sizing-v1",
		implementation: "VaultRecoveryService",
		productMaxEntries: MAX_CAPTURE_PLAN_ENTRIES,
		productMaxResponseBytes: MAX_CAPTURE_PLAN_BYTES,
		pageSizes,
		cases,
		passed: true,
	};
}
