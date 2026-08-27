import * as Y from "yjs";
import { sha256Hex } from "./hex";
import { SERVER_SCHEMA_VERSION, SERVER_STORAGE_FORMAT_VERSION } from "./version";
import { isValidOperationId, type CatalogHeadAtBoundary, type VaultOperation, type VaultStore } from "./vaultStore";

const DEFAULT_PAGE_SIZE = 1000;
const SOFT_TTL_MS = 60 * 60_000;
const HARD_TTL_MS = 24 * 60 * 60_000;
export interface ImmutableArtifactStore {
	exists(key: string): Promise<boolean>;
	get(key: string): Promise<Uint8Array | null>;
	put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
	delete(key: string): Promise<void>;
}


export interface BootstrapDescriptor {
	format: "yaos-bootstrap-v1";
	bootstrapId: string;
	schemaVersion: 4;
	storageFormatVersion: 1;
	createdAt: string;
	serverCompleted: boolean;
	expiresAt: string;
	capture: {
		vaultSequence: number;
		rootGeneration: number;
		rootCheckpointHash: string;
		rootCheckpointBytes: number;
		rootCheckpointKey: string;
	};
	catalog: {
		activeBodyCount: number;
		pageSize: number;
		firstCursor: string | null;
		feedFloor: number;
		highWater: number;
	};
}

export interface BootstrapCatalogPage {
	bootstrapId: string;
	highWater: number;
	entries: CatalogHeadAtBoundary[];
	nextCursor: string | null;
}

export interface BootstrapBodyState {
	bodyId: string;
	generation: number;
	throughSequence: number;
	encodedState: Uint8Array;
}

/** Owns one exact SQLite-backed bootstrap boundary; object storage is never required. */
export class BootstrapService {
	constructor(private readonly store: VaultStore, private readonly now: () => number = Date.now) {}

	async start(attemptId?: string): Promise<BootstrapDescriptor> {
		const now = this.now();
		if (attemptId !== undefined && !isValidOperationId(attemptId)) throw new Error("invalid bootstrap attempt ID");
		this.store.cleanupStuckPins(now);
		let operation = attemptId ? this.store.getOperation(attemptId) : this.store.runningOperation("bootstrap");
		if (operation?.state === "failed") {
			const pin = this.store.getPin(operation.operationId);
			if (!pin || now >= pin.hardExpiresAt) throw new Error("bootstrap lease hard-expired");
			operation = this.store.resumeFailedOperation(operation.operationId, now);
		}
		if (operation?.state === "complete") return this.describeOperation(operation);
		const started = this.store.beginPinnedOperation({
			operationId: operation?.operationId ?? attemptId,
			kind: "bootstrap",
			softTtlMs: SOFT_TTL_MS,
			hardTtlMs: HARD_TTL_MS,
			now,
		});
		const descriptor = await this.describeOperation(started.operation);
		if (!started.operation.artifactHash) {
			this.store.stageOperationArtifact(
				started.operation.operationId,
				`sql:root:${started.operation.boundarySequence}`,
				descriptor.capture.rootCheckpointHash,
				now,
			);
		}
		return descriptor;
	}

	async describe(bootstrapId: string): Promise<BootstrapDescriptor> {
		const operation = this.requireOperation(bootstrapId);
		return this.describeOperation(operation);
	}

	rootState(bootstrapId: string): { encodedState: Uint8Array; hash: Promise<string> } {
		const operation = this.requireOperation(bootstrapId);
		const reconstructed = this.store.reconstructDocument("root", operation.boundarySequence);
		const encodedState = Y.encodeStateAsUpdate(reconstructed.doc);
		reconstructed.doc.destroy();
		return { encodedState, hash: sha256Hex(encodedState) };
	}

	catalogPage(bootstrapId: string, cursor: string | null, limit = DEFAULT_PAGE_SIZE): BootstrapCatalogPage {
		const operation = this.requireRunning(bootstrapId);
		const bounded = Math.min(DEFAULT_PAGE_SIZE, Math.max(1, limit));
		const entries = this.store.listActiveCatalogAt(operation.boundarySequence, cursor ?? "", bounded);
		return {
			bootstrapId,
			highWater: operation.boundarySequence,
			entries,
			nextCursor: entries.length === bounded ? entries.at(-1)!.bodyId : null,
		};
	}

	bodyState(bootstrapId: string, bodyId: string): BootstrapBodyState {
		const operation = this.requireRunning(bootstrapId);
		const catalog = this.store.getCatalogHeadAt(operation.boundarySequence, bodyId);
		if (!catalog || catalog.lifecycle !== "active") throw new Error("body is not active at bootstrap boundary");
		const reconstructed = this.store.reconstructDocument(bodyId, operation.boundarySequence);
		const encodedState = Y.encodeStateAsUpdate(reconstructed.doc);
		reconstructed.doc.destroy();
		return {
			bodyId,
			generation: reconstructed.generation,
			throughSequence: operation.boundarySequence,
			encodedState,
		};
	}

	renew(bootstrapId: string, settledBodies: number): void {
		this.requireRunning(bootstrapId);
		this.store.renewPin(bootstrapId, settledBodies, SOFT_TTL_MS, this.now());
	}

	complete(bootstrapId: string): VaultOperation {
		const operation = this.requireRunning(bootstrapId);
		if (!operation.artifactKey || !operation.artifactHash) throw new Error("bootstrap root metadata missing");
		return this.store.completePinnedOperation(bootstrapId, operation.artifactKey, operation.artifactHash, this.now());
	}

	private requireOperation(bootstrapId: string): VaultOperation {
		if (!isValidOperationId(bootstrapId)) throw new Error("invalid bootstrap attempt ID");
		const operation = this.store.getOperation(bootstrapId);
		if (!operation || operation.kind !== "bootstrap") throw new Error("bootstrap not found");
		return operation;
	}

	private requireRunning(bootstrapId: string): VaultOperation {
		const operation = this.requireOperation(bootstrapId);
		if (operation.state !== "running") throw new Error(`bootstrap is ${operation.state}`);
		const pin = this.store.getPin(bootstrapId);
		if (!pin) throw new Error("bootstrap lease missing");
		if (this.now() >= pin.hardExpiresAt) throw new Error("bootstrap lease hard-expired");
		return operation;
	}
	private async describeOperation(operation: VaultOperation): Promise<BootstrapDescriptor> {
		const reconstructed = this.store.reconstructDocument("root", operation.boundarySequence);
		const rootGeneration = reconstructed.generation;
		const encodedRoot = Y.encodeStateAsUpdate(reconstructed.doc);
		reconstructed.doc.destroy();
		const pin = this.store.getPin(operation.operationId);
		return {
			format: "yaos-bootstrap-v1",
			bootstrapId: operation.operationId,
			schemaVersion: SERVER_SCHEMA_VERSION as 4,
			storageFormatVersion: SERVER_STORAGE_FORMAT_VERSION as 1,
			serverCompleted: operation.state === "complete",
			createdAt: new Date(operation.createdAt).toISOString(),
			expiresAt: new Date(pin?.softExpiresAt ?? operation.updatedAt).toISOString(),
			capture: {
				vaultSequence: operation.boundarySequence,
				rootGeneration,
				rootCheckpointKey: operation.artifactKey ?? `sql:root:${operation.boundarySequence}`,
				rootCheckpointHash: operation.artifactHash ?? await sha256Hex(encodedRoot),
				rootCheckpointBytes: encodedRoot.byteLength,
			},
			catalog: {
				activeBodyCount: this.store.countActiveCatalogAt(operation.boundarySequence),
				pageSize: DEFAULT_PAGE_SIZE,
				firstCursor: null,
				feedFloor: this.store.journalFloor(),
				highWater: operation.boundarySequence,
			},
		};
	}
}
