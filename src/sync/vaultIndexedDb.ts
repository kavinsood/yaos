import { vaultIdbName } from "./vaultPersistence";
import type { StoredBodySettlement } from "./bodySettlement";
import type { VaultAuthorityIdentity } from "../collaboration/authority";
import type { SemanticEpoch } from "@shared/semanticEpoch";

interface StoredDocumentFields {
	documentId: string;
	generation: number;
	encodedState: ArrayBuffer;
	dirty: boolean;
	pendingLocalUpdates?: number;
	updatedAt: number;
}

export type StoredDocument =
	| (StoredDocumentFields & { kind: "root"; documentId: "root"; rootEpoch: SemanticEpoch })
	| (StoredDocumentFields & {
		kind: "body";
		bodyEpoch: SemanticEpoch;
		/** Last server-authoritative Markdown used as the diff3 base after an epoch reset. */
		durableBaseline: string;
	})
	| (StoredDocumentFields & {
		kind: "semantic";
		bodyEpoch: SemanticEpoch;
	});

export interface StoredBodyCandidate {
	candidateId: string;
	vaultId: string;
	bodyId: string;
	bodyEpoch: SemanticEpoch;
	previousBaseline: string;
	pendingMarkdown: string;
	candidateDigest: string;
	encodedUpdate: ArrayBuffer;
	/** Ordered valid Yjs updates for a large fresh-note candidate. */
	encodedUpdates?: ArrayBuffer[];
	capturedAt: number;
	capturedLocalUpdates?: number;
	attempts?: number;
	lastAttemptAt?: number | null;
	authority?: VaultAuthorityIdentity;
}

export interface StoredBodyReceipt {
	vaultId: string;
	vaultGeneration: string;
	bodyId: string;
	bodyEpoch: SemanticEpoch;
	clientId: string;
	candidateId: string;
	candidateDigest: string;
	durableGeneration: number;
	runtimeEpoch: string;
}

export interface StoredCanvasCandidate {
	candidateId: string;
	documentId: string;
	bodyEpoch: SemanticEpoch;
	candidateDigest: string;
	encodedUpdate: ArrayBuffer;
	capturedAt: number;
	createPath?: string;
	operationId?: string;
	operationDigest?: string;
	attempts: number;
	lastAttemptAt: number | null;
}

export interface StoredCanvasSettlement {
	format: 1;
	documentId: string;
	bodyEpoch: SemanticEpoch;
	vaultGeneration: string;
	canonicalContent: ArrayBuffer;
	contentHash: string;
	durableGeneration: number;
	serverContentHash: string;
	diskFingerprint: { bytes: number; hash: string };
	pathAtSettlement: string;
	localSettlementRevision: number;
	settledAt: number;
}

export interface StoredCanvasEpochReplacement {
	document: Extract<StoredDocument, { kind: "semantic" }>;
	settlement: StoredCanvasSettlement;
	candidate: StoredCanvasCandidate | null;
	/** Pending lifecycle intents carried through the replacement transaction. */
	lifecycle: StoredCanvasLifecycle[];
}

interface StoredCanvasOperationBase {
	operationId: string;
	requestDigest: string;
	documentId: string;
	bodyEpoch: SemanticEpoch;
	rootEpoch: SemanticEpoch;
	createdAt: number;
	attempts: number;
	lastAttemptAt: number | null;
}

export type StoredCanvasLifecycle = StoredCanvasOperationBase & (
	| { kind: "rename"; fromPath: string; toPath: string }
	| { kind: "delete" }
	| { kind: "revive"; path: string }
	| { kind: "promote"; path: string; sourceRevision: string; sourceHash: string; sourceSize: number;
		contentHash: string; contentSize: number; candidateDigest: string; encodedUpdate: ArrayBuffer;
		sourceBytes: ArrayBuffer }
	| { kind: "demote"; path: string; expectedGeneration: number; expectedContentHash: string;
		expectedSize: number; blobHash: string; blobSize: number; mime: string; semanticBytes: ArrayBuffer }
);

function cloneCanvasLifecycle(operation: StoredCanvasLifecycle): StoredCanvasLifecycle {
	if (operation.kind === "promote") return {
		...operation,
		encodedUpdate: operation.encodedUpdate.slice(0),
		sourceBytes: operation.sourceBytes.slice(0),
	};
	if (operation.kind === "demote") return {
		...operation,
		semanticBytes: operation.semanticBytes.slice(0),
	};
	return { ...operation };
}

export interface StoredSemanticEpochReplacement {
	document: Extract<StoredDocument, { kind: "body" }>;
	candidate: StoredBodyCandidate | null;
}

export type LifecycleOperationKind = "create" | "rename" | "delete" | "revive";

export interface StoredLifecycleOperation {
	operationId: string;
	kind: LifecycleOperationKind;
	bodyId: string;
	bodyEpoch: SemanticEpoch;
	path: string;
	previousPath: string | null;
	content: string | null;
	candidateId?: string;
	candidateDigest?: string;
	createdAt: number;
	attempts: number;
	batchId?: string | null;
	batchIndex?: number | null;
	lastAttemptAt: number | null;
	authority?: VaultAuthorityIdentity;
}

export type StoredAttachmentPublicationMutation =
	| { operationId: string; kind: "upsert"; path: string; expectedRevision: string | null; hash: string; size: number; mime: string }
	| { operationId: string; kind: "delete"; path: string; expectedRevision: string | null }
	| { operationId: string; kind: "rename"; fromPath: string; toPath: string; expectedFromRevision: string; expectedToRevision: string | null };

export interface StoredAttachmentPublicationOperation {
	vaultId: string;
	vaultGeneration: string;
	rootEpoch: SemanticEpoch;
	mutation: StoredAttachmentPublicationMutation;
	localSequence: number;
	createdAt: number;
	attempts: number;
	lastAttemptAt: number | null;
	authority?: VaultAuthorityIdentity;
}

export interface StoredBootstrapProgress {
	bootstrapId: string;
	rootEpoch: SemanticEpoch;
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
	operation?: "settle" | "delete" | "move" | "properties";
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


const DATABASE_VERSION = 7;
const DOCUMENTS = "documents";
const CANDIDATES = "pendingCandidates";
const LIFECYCLE = "lifecycleOperations";
const ATTACHMENT_OPERATIONS = "attachmentOperations";
const OUTSTANDING = "outstanding";
const BOOTSTRAP = "bootstrapProgress";
const FEED_CURSOR = "feedCursor";
const PATHS = "paths";
const RECOVERY_STATE = "recoveryState";
const ATTACHMENT_SEQUENCE = "attachmentSequence";
const BODY_SETTLEMENTS = "bodySettlements";
const CANVAS_CANDIDATES = "canvasCandidates";
const CANVAS_SETTLEMENTS = "canvasSettlements";
const CANVAS_LIFECYCLE = "canvasLifecycle";
const SCHEMA_8_DATABASE_SUFFIX = ":schema-8";

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
 * Schema-6 state is scoped to one server vault incarnation and local folder.
 * A destructive reprovision can never open the prior generation's cache.
 */
export function schema8VaultIdbName(vaultId: string, vaultGeneration: string, folderKey: string): string {
	if (!vaultId.trim() || !vaultGeneration.trim() || !folderKey.trim()) {
		throw new Error("vault ID, generation, and folder key are required for schema-8 storage");
	}
	return `${vaultIdbName(`${vaultId}:${vaultGeneration}`, folderKey)}${SCHEMA_8_DATABASE_SUFFIX}`;
}

/** Compatibility alias for callers which only need deterministic namespace construction. */
export const schema6VaultIdbName = schema8VaultIdbName;


/** One fresh schema-8 database per enrolled vault generation, authority, and local folder. */
export class VaultIndexedDb {
	private readonly database: Promise<IDBDatabase>;
	private readonly databaseName: string;

	constructor(
		vaultId: string,
		vaultGeneration: string,
		folderKey: string,
		private readonly indexedDb: IDBFactory = window.indexedDB,
	) {
		this.databaseName = schema8VaultIdbName(vaultId, vaultGeneration, folderKey);
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
				if (event.oldVersion < 4) db.createObjectStore(ATTACHMENT_SEQUENCE);
				if (event.oldVersion < 5) db.createObjectStore(BODY_SETTLEMENTS, { keyPath: "bodyId" });
				if (event.oldVersion < 6) {
					db.createObjectStore(CANVAS_CANDIDATES, { keyPath: "candidateId" });
					db.createObjectStore(CANVAS_SETTLEMENTS, { keyPath: "documentId" });
				}
				if (event.oldVersion < 7) db.createObjectStore(CANVAS_LIFECYCLE, { keyPath: "operationId" });
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
		if (!value) return null;
		if ((value.kind === "root") !== (documentId === "root")
			|| (value.kind !== "root" && value.kind !== "body" && value.kind !== "semantic")) {
			throw new Error("stored document epoch kind mismatch");
		}
		return value;
	}

	async putDocument(document: StoredDocument): Promise<void> {
		if ((document.kind === "root") !== (document.documentId === "root")) {
			throw new Error("stored document epoch kind mismatch");
		}
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

	async putCanvasCandidate(candidate: StoredCanvasCandidate): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(CANVAS_CANDIDATES, "readwrite");
		transaction.objectStore(CANVAS_CANDIDATES).put({ ...candidate, encodedUpdate: candidate.encodedUpdate.slice(0) });
		await transactionDone(transaction);
	}

	async listCanvasCandidates(): Promise<StoredCanvasCandidate[]> {
		const db = await this.database;
		const transaction = db.transaction(CANVAS_CANDIDATES, "readonly");
		const values = await requestValue(transaction.objectStore(CANVAS_CANDIDATES).getAll()) as StoredCanvasCandidate[];
		await transactionDone(transaction);
		return values.map((value) => ({ ...value, encodedUpdate: value.encodedUpdate.slice(0) }));
	}

	async deleteCanvasCandidate(candidateId: string): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(CANVAS_CANDIDATES, "readwrite");
		transaction.objectStore(CANVAS_CANDIDATES).delete(candidateId);
		await transactionDone(transaction);
	}

	async putCanvasLifecycle(operation: StoredCanvasLifecycle): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(CANVAS_LIFECYCLE, "readwrite");
		transaction.objectStore(CANVAS_LIFECYCLE).put(cloneCanvasLifecycle(operation));
		await transactionDone(transaction);
	}

	async listCanvasLifecycle(): Promise<StoredCanvasLifecycle[]> {
		const db = await this.database;
		const transaction = db.transaction(CANVAS_LIFECYCLE, "readonly");
		const values = await requestValue(transaction.objectStore(CANVAS_LIFECYCLE).getAll()) as StoredCanvasLifecycle[];
		await transactionDone(transaction);
		return values.map(cloneCanvasLifecycle);
	}

	async deleteCanvasLifecycle(operationId: string): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(CANVAS_LIFECYCLE, "readwrite");
		transaction.objectStore(CANVAS_LIFECYCLE).delete(operationId);
		await transactionDone(transaction);
	}

	async getCanvasSettlement(documentId: string): Promise<StoredCanvasSettlement | null> {
		const db = await this.database;
		const transaction = db.transaction(CANVAS_SETTLEMENTS, "readonly");
		const value = await requestValue(transaction.objectStore(CANVAS_SETTLEMENTS).get(documentId)) as StoredCanvasSettlement | undefined;
		await transactionDone(transaction);
		return value ? { ...value, canonicalContent: value.canonicalContent.slice(0) } : null;
	}

	async putCanvasSettlement(settlement: StoredCanvasSettlement, expectedRevision: number | null): Promise<boolean> {
		const db = await this.database;
		const transaction = db.transaction(CANVAS_SETTLEMENTS, "readwrite");
		const store = transaction.objectStore(CANVAS_SETTLEMENTS);
		const current = await requestValue(store.get(settlement.documentId)) as StoredCanvasSettlement | undefined;
		const currentRevision = current?.localSettlementRevision ?? null;
		if (currentRevision !== expectedRevision) { transaction.abort(); return false; }
		store.put({ ...settlement, canonicalContent: settlement.canonicalContent.slice(0) });
		await transactionDone(transaction);
		return true;
	}

	/** Atomically abandons an old Canvas CRDT lineage and installs its semantic rebase. */
	async replaceCanvasSemanticEpoch(replacement: StoredCanvasEpochReplacement): Promise<void> {
		const { document, settlement, candidate, lifecycle } = replacement;
		if (settlement.documentId !== document.documentId || settlement.bodyEpoch !== document.bodyEpoch
			|| (candidate && (candidate.documentId !== document.documentId
				|| candidate.bodyEpoch !== document.bodyEpoch))
			|| lifecycle.some((operation) => operation.documentId !== document.documentId
				|| operation.bodyEpoch !== document.bodyEpoch)) {
			throw new Error("Canvas semantic epoch replacement identity mismatch");
		}
		const db = await this.database;
		const transaction = db.transaction([DOCUMENTS, CANVAS_CANDIDATES, CANVAS_SETTLEMENTS, CANVAS_LIFECYCLE], "readwrite");
		const candidates = transaction.objectStore(CANVAS_CANDIDATES);
		for (const stored of await requestValue(candidates.getAll()) as StoredCanvasCandidate[]) {
			if (stored.documentId === document.documentId) candidates.delete(stored.candidateId);
		}
		transaction.objectStore(DOCUMENTS).put({ ...document, encodedState: document.encodedState.slice(0) });
		transaction.objectStore(CANVAS_SETTLEMENTS).put({
			...settlement,
			canonicalContent: settlement.canonicalContent.slice(0),
		});
		if (candidate) candidates.put({ ...candidate, encodedUpdate: candidate.encodedUpdate.slice(0) });
		const lifecycleStore = transaction.objectStore(CANVAS_LIFECYCLE);
		for (const stored of await requestValue(lifecycleStore.getAll()) as StoredCanvasLifecycle[]) {
			if (stored.documentId === document.documentId) lifecycleStore.delete(stored.operationId);
		}
		for (const operation of lifecycle) lifecycleStore.put(cloneCanvasLifecycle(operation));
		await transactionDone(transaction);
	}

	async getBodySettlement(bodyId: string): Promise<StoredBodySettlement | null> {
		const db = await this.database;
		const transaction = db.transaction(BODY_SETTLEMENTS, "readonly");
		const value = await requestValue(transaction.objectStore(BODY_SETTLEMENTS).get(bodyId)) as
			| StoredBodySettlement
			| undefined;
		await transactionDone(transaction);
		return value ?? null;
	}

	async compareAndSwapBodySettlement(
		settlement: StoredBodySettlement,
		expectedLocalSettlementRevision: number | null,
	): Promise<boolean> {
		const db = await this.database;
		const transaction = db.transaction(BODY_SETTLEMENTS, "readwrite");
		const store = transaction.objectStore(BODY_SETTLEMENTS);
		const current = await requestValue(store.get(settlement.bodyId)) as StoredBodySettlement | undefined;
		const currentRevision = current?.localSettlementRevision ?? null;
		if (currentRevision !== expectedLocalSettlementRevision) {
			transaction.abort();
			try { await transactionDone(transaction); } catch { /* expected abort */ }
			return false;
		}
		store.put(structuredClone(settlement));
		await transactionDone(transaction);
		return true;
	}

	async deleteBodySettlement(bodyId: string): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction(BODY_SETTLEMENTS, "readwrite");
		transaction.objectStore(BODY_SETTLEMENTS).delete(bodyId);
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

	/** Atomically abandons every old-lineage candidate and installs the rebased lineage. */
	async replaceBodySemanticEpoch(replacement: StoredSemanticEpochReplacement): Promise<void> {
		const { document, candidate } = replacement;
		if (candidate && (candidate.bodyId !== document.documentId || candidate.bodyEpoch !== document.bodyEpoch)) {
			throw new Error("semantic epoch replacement candidate identity mismatch");
		}
		const db = await this.database;
		const transaction = db.transaction([DOCUMENTS, CANDIDATES], "readwrite");
		const documents = transaction.objectStore(DOCUMENTS);
		const candidates = transaction.objectStore(CANDIDATES);
		for (const stored of await requestValue(candidates.getAll()) as StoredBodyCandidate[]) {
			if (stored.bodyId === document.documentId) candidates.delete(stored.candidateId);
		}
		documents.put({ ...document, encodedState: document.encodedState.slice(0) });
		if (candidate) candidates.put({ ...candidate, encodedUpdate: candidate.encodedUpdate.slice(0) });
		await transactionDone(transaction);
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
			|| stored.bodyEpoch !== receipt.bodyEpoch
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

	async putAttachmentOperation(operation: StoredAttachmentPublicationOperation): Promise<StoredAttachmentPublicationOperation> {
		const db = await this.database;
		const transaction = db.transaction([ATTACHMENT_OPERATIONS, ATTACHMENT_SEQUENCE], "readwrite");
		let stored = structuredClone(operation);
		if (!Number.isSafeInteger(stored.localSequence) || stored.localSequence <= 0) {
			const sequenceStore = transaction.objectStore(ATTACHMENT_SEQUENCE);
			const previous = await requestValue(sequenceStore.get("next")) as number | undefined;
			const localSequence = (previous ?? 0) + 1;
			sequenceStore.put(localSequence, "next");
			stored = { ...stored, localSequence };
		}
		transaction.objectStore(ATTACHMENT_OPERATIONS).put(stored);
		await transactionDone(transaction);
		return stored;
	}

	async listAttachmentOperations(): Promise<StoredAttachmentPublicationOperation[]> {
		const db = await this.database;
		const transaction = db.transaction(ATTACHMENT_OPERATIONS, "readonly");
		const values = await requestValue(
			transaction.objectStore(ATTACHMENT_OPERATIONS).getAll(),
		) as StoredAttachmentPublicationOperation[];
		await transactionDone(transaction);
		return values.sort((left, right) => left.localSequence - right.localSequence);
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
			[DOCUMENTS, CANDIDATES, LIFECYCLE, ATTACHMENT_OPERATIONS, OUTSTANDING, RECOVERY_STATE,
				CANVAS_CANDIDATES, CANVAS_LIFECYCLE],
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
			BODY_SETTLEMENTS,
			CANVAS_CANDIDATES,
			CANVAS_SETTLEMENTS,
			CANVAS_LIFECYCLE,
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
			Promise.all([requestValue(transaction.objectStore(CANDIDATES).count()),
				requestValue(transaction.objectStore(CANVAS_CANDIDATES).count())]).then(([body, canvas]) => body + canvas),
			Promise.all([requestValue(transaction.objectStore(LIFECYCLE).count()),
				requestValue(transaction.objectStore(CANVAS_LIFECYCLE).count())]).then(([body, canvas]) => body + canvas),
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
