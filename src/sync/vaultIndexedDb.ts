import { vaultIdbName } from "./vaultPersistence";

export interface StoredDocument {
	documentId: string;
	generation: number;
	encodedState: ArrayBuffer;
	dirty: boolean;
	pendingLocalUpdates?: number;
	updatedAt: number;
}

export interface StoredBodyCandidate {
	candidateId: string;
	vaultId: string;
	bodyId: string;
	candidateDigest: string;
	encodedUpdate: ArrayBuffer;
	capturedAt: number;
	capturedLocalUpdates?: number;
	attempts?: number;
	lastAttemptAt?: number | null;
}

export interface StoredBodyReceipt {
	vaultId: string;
	vaultGeneration: string;
	bodyId: string;
	clientId: string;
	candidateId: string;
	candidateDigest: string;
	durableGeneration: number;
	runtimeEpoch: string;
}

export type LifecycleOperationKind = "create" | "rename" | "delete" | "revive";

export interface StoredLifecycleOperation {
	operationId: string;
	kind: LifecycleOperationKind;
	bodyId: string;
	path: string;
	previousPath: string | null;
	content: string | null;
	createdAt: number;
	attempts: number;
	batchId?: string | null;
	batchIndex?: number | null;
	lastAttemptAt: number | null;
}

export type StoredAttachmentPublicationMutation =
	| { operationId: string; kind: "upsert"; path: string; hash: string; size: number; mime: string }
	| { operationId: string; kind: "delete"; path: string }
	| { operationId: string; kind: "rename"; fromPath: string; toPath: string };

export interface StoredAttachmentPublicationOperation {
	mutation: StoredAttachmentPublicationMutation;
	createdAt: number;
	attempts: number;
	lastAttemptAt: number | null;
}

export interface StoredBootstrapProgress {
	bootstrapId: string;
	highWater: number;
	nextCatalogCursor: string | null;
	stage: "root-loaded" | "catalog-paging" | "feed-catching-up" | "complete";
	settledBodies: number;
	totalBodies: number;
	feedCursor: number;
}

export interface StoredFeedCursor {
	sequence: number;
	updatedAt: number;
}

export interface StoredOutstandingBody {
	bodyId: string;
	path: string;
	generation: number;
	reason: string;
	updatedAt: number;
	operation?: "settle" | "delete" | "move";
	attempts?: number;
}

export interface PendingWorkSummary {
	dirtyDocuments: number;
	pendingCandidates: number;
	lifecycleOperations: number;
	attachmentOperations: number;
	outstandingSettlements: number;
	activeRecoveryOperations: number;
}

export class PendingWorkError extends Error {
	constructor(readonly summary: PendingWorkSummary) {
		super(
			"Vault cache contains pending work: " +
			`${summary.dirtyDocuments} dirty documents, ` +
			`${summary.pendingCandidates} candidates, ` +
			`${summary.lifecycleOperations} lifecycle operations, ` +
			`${summary.attachmentOperations} attachment operations, ` +
			`${summary.outstandingSettlements} unsettled bodies, ` +
			`${summary.activeRecoveryOperations} active recovery operations`,
		);
		this.name = "PendingWorkError";
	}
}
export function assertResetAllowed(
	summary: PendingWorkSummary,
	discardPendingWork = false,
): void {
	if (!discardPendingWork && Object.values(summary).some((count) => count > 0)) {
		throw new PendingWorkError(summary);
	}
}


const DATABASE_VERSION = 3;
const DOCUMENTS = "documents";
const CANDIDATES = "pendingCandidates";
const LIFECYCLE = "lifecycleOperations";
const ATTACHMENT_OPERATIONS = "attachmentOperations";
const OUTSTANDING = "outstanding";
const BOOTSTRAP = "bootstrapProgress";
const FEED_CURSOR = "feedCursor";
const PATHS = "paths";
const RECOVERY_STATE = "recoveryState";
const SCHEMA_4_DATABASE_SUFFIX = ":schema-4";

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
		transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
	});
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}
/**
 * Schema-4 state is scoped to one server vault incarnation and local folder.
 * A destructive reprovision can never open the prior generation's cache.
 */
export function schema4VaultIdbName(vaultId: string, vaultGeneration: string, folderKey: string): string {
	if (!vaultId.trim() || !vaultGeneration.trim() || !folderKey.trim()) {
		throw new Error("vault ID, generation, and folder key are required for schema-4 storage");
	}
	return `${vaultIdbName(`${vaultId}:${vaultGeneration}`, folderKey)}${SCHEMA_4_DATABASE_SUFFIX}`;
}


/** One fresh schema-4 database per enrolled vault and local Obsidian folder. */
export class VaultIndexedDb {
	private readonly database: Promise<IDBDatabase>;
	private readonly databaseName: string;

	constructor(
		vaultId: string,
		vaultGeneration: string,
		folderKey: string,
		private readonly indexedDb: IDBFactory = window.indexedDB,
	) {
		this.databaseName = schema4VaultIdbName(vaultId, vaultGeneration, folderKey);
		this.database = new Promise((resolve, reject) => {
			const request = this.indexedDb.open(this.databaseName, DATABASE_VERSION);
			request.onupgradeneeded = (event) => {
				const db = request.result;
				if (event.oldVersion < 1) {
					db.createObjectStore(DOCUMENTS, { keyPath: "documentId" });
					db.createObjectStore(CANDIDATES, { keyPath: "candidateId" });
					db.createObjectStore(LIFECYCLE, { keyPath: "operationId" });
					db.createObjectStore(OUTSTANDING, { keyPath: "bodyId" });
					db.createObjectStore(BOOTSTRAP);
					db.createObjectStore(FEED_CURSOR);
					db.createObjectStore(PATHS);
				}
				if (event.oldVersion < 2) {
					db.createObjectStore(RECOVERY_STATE);
				}
				if (event.oldVersion < 3) {
					db.createObjectStore(ATTACHMENT_OPERATIONS, { keyPath: "mutation.operationId" });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error(`Failed to open ${this.databaseName}`));
		});
	}

	async getDocument(documentId: string): Promise<StoredDocument | null> {
		const db = await this.database;
		const transaction = db.transaction(DOCUMENTS, "readonly");
		const value = await requestValue(transaction.objectStore(DOCUMENTS).get(documentId)) as StoredDocument | undefined;
		await transactionDone(transaction);
		return value ?? null;
	}

	async putDocument(document: StoredDocument): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(DOCUMENTS, "readwrite");
		transaction.objectStore(DOCUMENTS).put({ ...document, encodedState: document.encodedState.slice(0) });
		await transactionDone(transaction);
	}

	async deleteDocument(documentId: string): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(DOCUMENTS, "readwrite");
		transaction.objectStore(DOCUMENTS).delete(documentId);
		await transactionDone(transaction);
	}
	async putPendingCandidate(candidate: StoredBodyCandidate): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(CANDIDATES, "readwrite");
		transaction.objectStore(CANDIDATES).put({
			...candidate,
			encodedUpdate: candidate.encodedUpdate.slice(0),
		});
		await transactionDone(transaction);
	}
	async putCandidate(candidate: StoredBodyCandidate): Promise<void> {
		await this.putPendingCandidate(candidate);
	}


	async getPendingCandidate(candidateId: string): Promise<StoredBodyCandidate | null> {
		const db = await this.database;
		const transaction = db.transaction(CANDIDATES, "readonly");
		const value = await requestValue(transaction.objectStore(CANDIDATES).get(candidateId)) as
			| StoredBodyCandidate
			| undefined;
		await transactionDone(transaction);
		return value ?? null;
	}

	async listPendingCandidates(): Promise<StoredBodyCandidate[]> {
		const db = await this.database;
		const transaction = db.transaction(CANDIDATES, "readonly");
		const values = await requestValue(transaction.objectStore(CANDIDATES).getAll()) as StoredBodyCandidate[];
		await transactionDone(transaction);
		return values;
	}

	async listCandidates(): Promise<StoredBodyCandidate[]> {
		return this.listPendingCandidates();
	}

	async deletePendingCandidate(candidateId: string): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(CANDIDATES, "readwrite");
		transaction.objectStore(CANDIDATES).delete(candidateId);
		await transactionDone(transaction);
	}

	async deleteCandidate(bodyId: string, candidateId: string): Promise<void> {
		const candidate = await this.getPendingCandidate(candidateId);
		if (candidate && candidate.bodyId !== bodyId) {
			throw new Error(`Candidate ${candidateId} belongs to a different body`);
		}
		await this.deletePendingCandidate(candidateId);
	}

	async confirmPendingCandidate(receipt: StoredBodyReceipt): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction([CANDIDATES, DOCUMENTS], "readwrite");
		if (
			!receipt.runtimeEpoch
			|| !receipt.vaultGeneration
			|| !Number.isSafeInteger(receipt.durableGeneration)
			|| receipt.durableGeneration < 0
		) {
			transaction.abort();
			throw new Error(`Invalid durable receipt for candidate ${receipt.candidateId}`);
		}
		const candidates = transaction.objectStore(CANDIDATES);
		const stored = await requestValue(candidates.get(receipt.candidateId)) as
			| StoredBodyCandidate
			| undefined;
		if (!stored) {
			transaction.abort();
			throw new Error(`Unknown candidate ${receipt.candidateId}`);
		}
		if (
			stored.vaultId !== receipt.vaultId
			|| stored.bodyId !== receipt.bodyId
			|| stored.candidateDigest !== receipt.candidateDigest
		) {
			transaction.abort();
			throw new Error(`Receipt identity mismatch for candidate ${receipt.candidateId}`);
		}
		const remainingForBody = (
			await requestValue(candidates.getAll()) as StoredBodyCandidate[]
		).some((candidate) =>
			candidate.candidateId !== receipt.candidateId
			&& candidate.bodyId === receipt.bodyId
		);
		const documents = transaction.objectStore(DOCUMENTS);
		const document = await requestValue(documents.get(receipt.bodyId)) as
			| StoredDocument
			| undefined;
		if (document) {
			const pendingLocalUpdates = Math.max(
				0,
				(document.pendingLocalUpdates ?? 0)
					- (stored.capturedLocalUpdates ?? 0),
			);
			documents.put({
				...document,
				generation: Math.max(document.generation, receipt.durableGeneration),
				dirty: remainingForBody || pendingLocalUpdates > 0,
				pendingLocalUpdates,
				updatedAt: Date.now(),
			});
		}
		candidates.delete(receipt.candidateId);
		await transactionDone(transaction);
	}

	async putLifecycleOperation(operation: StoredLifecycleOperation): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(LIFECYCLE, "readwrite");
		transaction.objectStore(LIFECYCLE).put({ ...operation });
		await transactionDone(transaction);
	}

	async getLifecycleOperation(operationId: string): Promise<StoredLifecycleOperation | null> {
		const db = await this.database;
		const transaction = db.transaction(LIFECYCLE, "readonly");
		const value = await requestValue(transaction.objectStore(LIFECYCLE).get(operationId)) as
			| StoredLifecycleOperation
			| undefined;
		await transactionDone(transaction);
		return value ?? null;
	}

	async listLifecycleOperations(): Promise<StoredLifecycleOperation[]> {
		const db = await this.database;
		const transaction = db.transaction(LIFECYCLE, "readonly");
		const values = await requestValue(transaction.objectStore(LIFECYCLE).getAll()) as StoredLifecycleOperation[];
		await transactionDone(transaction);
		return values;
	}

	async deleteLifecycleOperation(operationId: string): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(LIFECYCLE, "readwrite");
		transaction.objectStore(LIFECYCLE).delete(operationId);
		await transactionDone(transaction);
	}

	async putAttachmentOperation(operation: StoredAttachmentPublicationOperation): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(ATTACHMENT_OPERATIONS, "readwrite");
		transaction.objectStore(ATTACHMENT_OPERATIONS).put(structuredClone(operation));
		await transactionDone(transaction);
	}

	async listAttachmentOperations(): Promise<StoredAttachmentPublicationOperation[]> {
		const db = await this.database;
		const transaction = db.transaction(ATTACHMENT_OPERATIONS, "readonly");
		const values = await requestValue(
			transaction.objectStore(ATTACHMENT_OPERATIONS).getAll(),
		) as StoredAttachmentPublicationOperation[];
		await transactionDone(transaction);
		return values.sort((left, right) =>
			left.createdAt - right.createdAt
			|| left.mutation.operationId.localeCompare(right.mutation.operationId)
		);
	}

	async deleteAttachmentOperation(operationId: string): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(ATTACHMENT_OPERATIONS, "readwrite");
		transaction.objectStore(ATTACHMENT_OPERATIONS).delete(operationId);
		await transactionDone(transaction);
	}

	async getFeedCursor(): Promise<StoredFeedCursor | null> {
		const db = await this.database;
		const transaction = db.transaction(FEED_CURSOR, "readonly");
		const value = await requestValue(transaction.objectStore(FEED_CURSOR).get("cursor")) as
			| StoredFeedCursor
			| undefined;
		await transactionDone(transaction);
		return value ?? null;
	}

	async putFeedCursor(cursor: StoredFeedCursor): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(FEED_CURSOR, "readwrite");
		transaction.objectStore(FEED_CURSOR).put({ ...cursor }, "cursor");
		await transactionDone(transaction);
	}

	async deleteLifecycleOperations(operationIds: readonly string[]): Promise<void> {
		if (operationIds.length === 0) return;
		const db = await this.database;
		const transaction = db.transaction(LIFECYCLE, "readwrite");
		const store = transaction.objectStore(LIFECYCLE);
		for (const operationId of operationIds) store.delete(operationId);
		await transactionDone(transaction);
	}


	async getBootstrapProgress(): Promise<StoredBootstrapProgress | null> {
		const db = await this.database;
		const transaction = db.transaction(BOOTSTRAP, "readonly");
		const value = await requestValue(transaction.objectStore(BOOTSTRAP).get("bootstrap")) as
			| StoredBootstrapProgress
			| undefined;
		await transactionDone(transaction);
		return value ?? null;
	}

	async putBootstrapProgress(progress: StoredBootstrapProgress): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(BOOTSTRAP, "readwrite");
		transaction.objectStore(BOOTSTRAP).put({ ...progress }, "bootstrap");
		await transactionDone(transaction);
	}

	async putOutstanding(entry: StoredOutstandingBody): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(OUTSTANDING, "readwrite");
		transaction.objectStore(OUTSTANDING).put({ ...entry });
		await transactionDone(transaction);
	}

	async deleteOutstanding(bodyId: string): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(OUTSTANDING, "readwrite");
		transaction.objectStore(OUTSTANDING).delete(bodyId);
		await transactionDone(transaction);
	}

	async getOutstanding(bodyId: string): Promise<StoredOutstandingBody | null> {
		const db = await this.database;
		const transaction = db.transaction(OUTSTANDING, "readonly");
		const value = await requestValue(transaction.objectStore(OUTSTANDING).get(bodyId)) as StoredOutstandingBody | undefined;
		await transactionDone(transaction);
		return value ?? null;
	}

	async listOutstanding(): Promise<StoredOutstandingBody[]> {
		const db = await this.database;
		const transaction = db.transaction(OUTSTANDING, "readonly");
		const values = await requestValue(transaction.objectStore(OUTSTANDING).getAll()) as StoredOutstandingBody[];
		await transactionDone(transaction);
		return values;
	}

	async getMaterializedPath(bodyId: string): Promise<string | null> {
		const db = await this.database;
		const transaction = db.transaction(PATHS, "readonly");
		const value: unknown = await requestValue<unknown>(transaction.objectStore(PATHS).get(bodyId));
		await transactionDone(transaction);
		return typeof value === "string" ? value : null;
	}

	async setMaterializedPath(bodyId: string, path: string): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(PATHS, "readwrite");
		transaction.objectStore(PATHS).put(path, bodyId);
		await transactionDone(transaction);
	}

	async deleteMaterializedPath(bodyId: string): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(PATHS, "readwrite");
		transaction.objectStore(PATHS).delete(bodyId);
		await transactionDone(transaction);
	}
	async setMaterializedPaths(
		moves: readonly { bodyId: string; path: string }[],
	): Promise<void> {
		if (moves.length === 0) return;
		const db = await this.database;
		const transaction = db.transaction(PATHS, "readwrite");
		const store = transaction.objectStore(PATHS);
		for (const move of moves) store.put(move.path, move.bodyId);
		await transactionDone(transaction);
	}


	async listMaterializedPaths(): Promise<Array<{ bodyId: string; path: string }>> {
		const db = await this.database;
		const transaction = db.transaction(PATHS, "readonly");
		const store = transaction.objectStore(PATHS);
		const [keys, values] = await Promise.all([
			requestValue<IDBValidKey[]>(store.getAllKeys()),
			requestValue<unknown[]>(store.getAll()),
		]);
		await transactionDone(transaction);
		return keys.flatMap((key, index) => {
			const path: unknown = values[index];
			return typeof key === "string" && typeof path === "string" ? [{ bodyId: key, path }] : [];
		});
	}

	async getRecoveryState(): Promise<unknown> {
		const db = await this.database;
		const transaction = db.transaction(RECOVERY_STATE, "readonly");
		const value = await requestValue<unknown>(transaction.objectStore(RECOVERY_STATE).get("state"));
		await transactionDone(transaction);
		return value ?? null;
	}

	async putRecoveryState(state: object): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(RECOVERY_STATE, "readwrite");
		transaction.objectStore(RECOVERY_STATE).put(structuredClone(state), "state");
		await transactionDone(transaction);
	}

	async clearRecoveryState(): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(RECOVERY_STATE, "readwrite");
		transaction.objectStore(RECOVERY_STATE).delete("state");
		await transactionDone(transaction);
	}

	async getPendingWorkSummary(): Promise<PendingWorkSummary> {
		const db = await this.database;
		const transaction = db.transaction(
			[DOCUMENTS, CANDIDATES, LIFECYCLE, ATTACHMENT_OPERATIONS, OUTSTANDING, RECOVERY_STATE],
			"readonly",
		);
		const summary = await this.readPendingWorkSummary(transaction);
		await transactionDone(transaction);
		return summary;
	}

	async hasPendingWork(): Promise<boolean> {
		const summary = await this.getPendingWorkSummary();
		return Object.values(summary).some((count) => count > 0);
	}

	/**
	 * Explicit cache reset. Ordinary cache reset refuses to erase any locally
	 * dirty or unsettled work. Only the separately-confirmed nuclear reset may
	 * pass discardPendingWork=true.
	 */
	async clearLocalCache(options: { discardPendingWork?: boolean } = {}): Promise<PendingWorkSummary> {
		const db = await this.database;
		const stores = [
			DOCUMENTS,
			CANDIDATES,
			LIFECYCLE,
			ATTACHMENT_OPERATIONS,
			OUTSTANDING,
			BOOTSTRAP,
			FEED_CURSOR,
			PATHS,
			RECOVERY_STATE,
		];
		const transaction = db.transaction(stores, "readwrite");
		const summary = await this.readPendingWorkSummary(transaction);
		try {
			assertResetAllowed(summary, options.discardPendingWork);
		} catch (error) {
			transaction.abort();
			throw error;
		}
		for (const store of stores) transaction.objectStore(store).clear();
		await transactionDone(transaction);
		return summary;
	}

	async getDiagnosticsSnapshot(): Promise<{
		pending: PendingWorkSummary;
		bootstrap: StoredBootstrapProgress | null;
		feedCursor: StoredFeedCursor | null;
	}> {
		const [pending, bootstrap, feedCursor] = await Promise.all([
			this.getPendingWorkSummary(),
			this.getBootstrapProgress(),
			this.getFeedCursor(),
		]);
		return { pending, bootstrap, feedCursor };
	}

	async deleteDatabase(
		options: { discardPendingWork?: boolean } = {},
	): Promise<PendingWorkSummary> {
		const summary = await this.getPendingWorkSummary();
		assertResetAllowed(summary, options.discardPendingWork);
		(await this.database).close();
		await new Promise<void>((resolve, reject) => {
			const request = this.indexedDb.deleteDatabase(this.databaseName);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(
				request.error ?? new Error(`Failed to delete ${this.databaseName}`),
			);
			request.onblocked = () => reject(new Error(`Deletion blocked for ${this.databaseName}`));
		});
		return summary;
	}
	async deleteDatabaseAfterClose(
		preflight: PendingWorkSummary,
		options: { discardPendingWork?: boolean } = {},
	): Promise<void> {
		assertResetAllowed(preflight, options.discardPendingWork);
		await new Promise<void>((resolve, reject) => {
			const request = this.indexedDb.deleteDatabase(this.databaseName);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(
				request.error ?? new Error(`Failed to delete ${this.databaseName}`),
			);
			request.onblocked = () => reject(new Error(`Deletion blocked for ${this.databaseName}`));
		});
	}


	private async readPendingWorkSummary(
		transaction: IDBTransaction,
	): Promise<PendingWorkSummary> {
		const [
			documents,
			pendingCandidates,
			lifecycleOperations,
			attachmentOperations,
			outstandingSettlements,
			recoveryState,
		] = await Promise.all([
			requestValue(transaction.objectStore(DOCUMENTS).getAll()) as Promise<StoredDocument[]>,
			requestValue(transaction.objectStore(CANDIDATES).count()),
			requestValue(transaction.objectStore(LIFECYCLE).count()),
			requestValue(transaction.objectStore(ATTACHMENT_OPERATIONS).count()),
			requestValue(transaction.objectStore(OUTSTANDING).count()),
			requestValue<unknown>(transaction.objectStore(RECOVERY_STATE).get("state")),
		]);
		const recovery = typeof recoveryState === "object" && recoveryState !== null
			? recoveryState as { activeCaptureId?: unknown; activeRestore?: unknown }
			: null;
		return {
			dirtyDocuments: documents.reduce((count, document) => count + (document.dirty ? 1 : 0), 0),
			pendingCandidates,
			lifecycleOperations,
			attachmentOperations,
			outstandingSettlements,
			activeRecoveryOperations:
				(typeof recovery?.activeCaptureId === "string" ? 1 : 0)
				+ (typeof recovery?.activeRestore === "object" && recovery.activeRestore !== null ? 1 : 0),
		};
	}


	async close(): Promise<void> {
		(await this.database).close();
	}
}
