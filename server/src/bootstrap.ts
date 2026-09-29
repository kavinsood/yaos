import { ywasmCrdtEngine as crdtEngine } from "./crdt/ywasmWorkerCrdtEngine";
import { sha256Hex } from "./hex";
import { SERVER_SCHEMA_VERSION, SERVER_STORAGE_FORMAT_VERSION } from "./version";
import { isValidOperationId, type CatalogHeadAtBoundary, type SemanticCatalogHead, type VaultOperation, type VaultStore } from "./vaultStore";
import type { SemanticEpoch } from "./shared/semanticEpoch";
import { canonicalCrdtRootDigestBytes } from "./shared/crdtRootDigest";

const DEFAULT_PAGE_SIZE = 1000;
const SOFT_TTL_MS = 60 * 60_000;
const HARD_TTL_MS = 24 * 60 * 60_000;
export type BootstrapNotRunningReason = "complete" | "expired" | "unknown" | "failed" | "ownership_unknown";

export class BootstrapOperationError extends Error {
	constructor(
		readonly reason: BootstrapNotRunningReason | "owner_mismatch",
		readonly status: 409 | 403 = 409,
	) {
		super(reason === "unknown" ? "bootstrap not found" : `bootstrap is not running: ${reason}`);
	}

	get code(): "bootstrap_not_running" | "bootstrap_owner_mismatch" {
		return this.status === 403 ? "bootstrap_owner_mismatch" : "bootstrap_not_running";
	}

	response(): Response {
		return Response.json({ error: this.code, reason: this.reason }, { status: this.status });
	}
}
export interface ImmutableArtifactStore {
	exists(key: string): Promise<boolean>;
	get(key: string): Promise<Uint8Array | null>;
	put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
	delete(key: string): Promise<void>;
}


export interface BootstrapDescriptor {
	format: "yaos-bootstrap-v2";
	bootstrapId: string;
	schemaVersion: 8;
	storageFormatVersion: 4;
	createdAt: string;
	serverCompleted: boolean;
	expiresAt: string;
	capture: {
		vaultSequence: number;
		rootEpoch: SemanticEpoch;
		rootGeneration: number;
		rootCheckpointHash: string;
		rootCheckpointHashFormat: "canonical-root-v1";
		rootCheckpointBytes: number;
		rootCheckpointKey: string;
	};
	catalog: {
		activeBodyCount: number;
		activeSemanticCount: number;
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
	bodyEpoch: SemanticEpoch;
	generation: number;
	throughSequence: number;
	encodedState: Uint8Array;
}

export interface BootstrapSemanticCatalogPage {
	bootstrapId: string;
	highWater: number;
	entries: SemanticCatalogHead[];
	nextCursor: string | null;
}

export interface BootstrapSemanticState {
	documentId: string;
	bodyEpoch: SemanticEpoch;
	generation: number;
	throughSequence: number;
	encodedState: Uint8Array;
}

/** Owns one exact SQLite-backed bootstrap boundary; object storage is never required. */
export class BootstrapService {
	constructor(
		private readonly store: VaultStore,
		private readonly now: () => number = Date.now,
		private readonly reserveFullState: (documentId: string, overlappingCopies: number) => () => void = () => () => {},
		private readonly ownerDeviceId?: string,
	) {}

	forDevice(deviceId: string): BootstrapService {
		if (!deviceId || deviceId.length > 256) throw new Error("invalid bootstrap device identity");
		return new BootstrapService(this.store, this.now, this.reserveFullState, deviceId);
	}

	async start(attemptId?: string, resume = false): Promise<BootstrapDescriptor> {
		const now = this.now();
		if (attemptId !== undefined && !isValidOperationId(attemptId)) {
			if (resume) throw new BootstrapOperationError("unknown");
			throw new Error("invalid bootstrap attempt ID");
		}
		this.store.cleanupStuckPins(now);
		let operation = attemptId ? this.store.getOperation(attemptId) : null;
		if (!operation && !resume && this.ownerDeviceId) {
			operation = this.store.runningBootstrapForDevice(this.ownerDeviceId);
		}
		if (resume && !operation) throw new BootstrapOperationError("unknown");
		if (operation) this.requireRunning(operation.operationId);
		const started = this.store.beginPinnedOperation({
			operationId: operation?.operationId ?? attemptId,
			ownerDeviceId: this.ownerDeviceId,
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
		const operation = this.requireRunning(bootstrapId);
		return this.describeOperation(operation);
	}

	rootState(bootstrapId: string): { encodedState: Uint8Array; rootEpoch: SemanticEpoch; hash: Promise<string> } {
		const operation = this.requireRunning(bootstrapId);
		const release = this.reserveFullState("root", 2);
		try {
			const reconstructed = this.store.reconstructDocument("root", operation.boundarySequence);
			try {
				const encodedState = crdtEngine.encodeStateAsUpdate(reconstructed.doc);
				return { encodedState, rootEpoch: reconstructed.semanticEpoch,
					hash: sha256Hex(canonicalCrdtRootDigestBytes(crdtEngine.snapshotRoots(reconstructed.doc))) };
			} finally { crdtEngine.destroyDocument(reconstructed.doc); }
		} finally { release(); }
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
		const release = this.reserveFullState(bodyId, 2);
		try {
			const reconstructed = this.store.reconstructDocument(bodyId, operation.boundarySequence);
			try {
				const encodedState = crdtEngine.encodeStateAsUpdate(reconstructed.doc);
				return {
					bodyId,
					bodyEpoch: reconstructed.semanticEpoch,
					generation: reconstructed.generation,
					throughSequence: operation.boundarySequence,
					encodedState,
				};
			} finally { crdtEngine.destroyDocument(reconstructed.doc); }
		} finally { release(); }
	}

	semanticCatalogPage(bootstrapId: string, cursor: string | null, limit = DEFAULT_PAGE_SIZE): BootstrapSemanticCatalogPage {
		const operation = this.requireRunning(bootstrapId);
		const bounded = Math.min(DEFAULT_PAGE_SIZE, Math.max(1, limit));
		const entries = this.store.listActiveSemanticAt(operation.boundarySequence, cursor ?? "", bounded);
		return { bootstrapId, highWater: operation.boundarySequence, entries,
			nextCursor: entries.length === bounded ? entries.at(-1)!.documentId : null };
	}

	semanticState(bootstrapId: string, documentId: string): BootstrapSemanticState {
		const operation = this.requireRunning(bootstrapId);
		const head = this.store.semanticHeadAt(operation.boundarySequence, documentId);
		if (!head || head.lifecycle !== "active") throw new Error("semantic document is not active at bootstrap boundary");
		const release = this.reserveFullState(documentId, 2);
		try {
			const reconstructed = this.store.reconstructDocument(documentId, operation.boundarySequence);
			try {
				const encodedState = crdtEngine.encodeStateAsUpdate(reconstructed.doc);
				return { documentId, bodyEpoch: reconstructed.semanticEpoch, generation: reconstructed.generation,
					throughSequence: operation.boundarySequence, encodedState };
			} finally { crdtEngine.destroyDocument(reconstructed.doc); }
		} finally { release(); }
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
		if (!isValidOperationId(bootstrapId)) throw new BootstrapOperationError("unknown");
		const operation = this.store.getOperation(bootstrapId);
		if (!operation || operation.kind !== "bootstrap") throw new BootstrapOperationError("unknown");
		const owner = this.store.bootstrapOwner?.(bootstrapId) ?? null;
		if (this.ownerDeviceId !== undefined) {
			if (!owner) throw new BootstrapOperationError("ownership_unknown");
			if (owner !== this.ownerDeviceId) throw new BootstrapOperationError("owner_mismatch", 403);
		} else if (owner) {
			throw new BootstrapOperationError("owner_mismatch", 403);
		}
		return operation;
	}

	private requireRunning(bootstrapId: string): VaultOperation {
		const operation = this.requireOperation(bootstrapId);
		if (operation.state === "complete") throw new BootstrapOperationError("complete");
		const pin = this.store.getPin(bootstrapId);
		if (!pin || this.now() >= pin.softExpiresAt || this.now() >= pin.hardExpiresAt) throw new BootstrapOperationError("expired");
		if (operation.state !== "running") throw new BootstrapOperationError("failed");
		return operation;
	}
	private async describeOperation(operation: VaultOperation): Promise<BootstrapDescriptor> {
		const release = this.reserveFullState("root", 2);
		try {
			const reconstructed = this.store.reconstructDocument("root", operation.boundarySequence);
			let rootGeneration: number;
			let rootEpoch: SemanticEpoch;
			let encodedRoot: Uint8Array;
			let canonicalRootHash: string;
			try {
				rootGeneration = reconstructed.generation;
				rootEpoch = reconstructed.semanticEpoch;
				encodedRoot = crdtEngine.encodeStateAsUpdate(reconstructed.doc);
				canonicalRootHash = await sha256Hex(canonicalCrdtRootDigestBytes(crdtEngine.snapshotRoots(reconstructed.doc)));
			} finally { crdtEngine.destroyDocument(reconstructed.doc); }
			const pin = this.store.getPin(operation.operationId);
			return {
				format: "yaos-bootstrap-v2",
				bootstrapId: operation.operationId,
				schemaVersion: SERVER_SCHEMA_VERSION as 8,
				storageFormatVersion: SERVER_STORAGE_FORMAT_VERSION as 4,
				serverCompleted: operation.state === "complete",
				createdAt: new Date(operation.createdAt).toISOString(),
				expiresAt: new Date(pin?.softExpiresAt ?? operation.updatedAt).toISOString(),
				capture: {
					vaultSequence: operation.boundarySequence,
					rootEpoch,
					rootGeneration,
					rootCheckpointKey: operation.artifactKey ?? `sql:root:${operation.boundarySequence}`,
					rootCheckpointHash: operation.artifactHash ?? canonicalRootHash,
					rootCheckpointHashFormat: "canonical-root-v1",
					rootCheckpointBytes: encodedRoot.byteLength,
				},
				catalog: {
					activeBodyCount: this.store.countActiveCatalogAt(operation.boundarySequence),
					activeSemanticCount: this.store.countActiveSemanticAt(operation.boundarySequence),
					pageSize: DEFAULT_PAGE_SIZE,
					firstCursor: null,
					feedFloor: this.store.journalFloor(),
					highWater: operation.boundarySequence,
				},
			};
		} finally { release(); }
	}
}
