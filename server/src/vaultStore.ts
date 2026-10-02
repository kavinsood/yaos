import { SCHEMA_VERSION, STORAGE_FORMAT_VERSION } from "./shared/productVersions";
import { isCanonicalVaultId } from "./vaultId";
import { MAX_DURABLE_UPDATE_BYTES } from "./contracts";
import { MAX_CANDIDATE_UPDATE_BYTES, MAX_CANDIDATE_UPDATE_FRAMES } from "./shared/durableLimits";
import { INITIAL_SEMANTIC_EPOCH, parseSemanticEpoch, type SemanticEpoch } from "./shared/semanticEpoch";
import { RecoveryAuthorityStore } from "./recoveryAuthorityStore";
import type { VaultActorContext } from "./collaboration";
import {
	CANDIDATE_RECEIPT_TTL_MS,
	MAX_CANDIDATE_RECEIPTS_PER_BODY,
	type AttachmentCatalogEvent,
	type BodyLifecycle,
	type CatalogHeadAtBoundary,
	type CatalogMutation,
	type SemanticCatalogMutation,
	type SemanticCatalogHead,
	type SemanticCandidateReceipt,
	type SemanticLifecycleReceipt,
	type DurableCandidateReceipt,
	type DurableLifecycleRecord,
} from "./vaultCatalogStore";
import { SQLITE_BLOB_CHUNK_BYTES } from "./vaultDocumentStore";
import type {
	CheckpointExpectedHead,
	DurableCommitResult,
	SemanticResetResult,
	VaultCommitKind,
	VaultProvisioningResult,
} from "./vaultDocumentStore";

function ownedUpdate(bytes: Uint8Array): ArrayBuffer {
	if (bytes.byteLength < 1 || bytes.byteLength > MAX_DURABLE_UPDATE_BYTES) {
		throw new Error("semantic authority update exceeds durable value limit");
	}
	return bytes.slice().buffer;
}

export type {
	DurableCommitResult,
	JournalFeedEntry,
	JournalFeedPage,
	ReconstructedDocument,
	VaultCommitKind,
	VaultMetadata,
	VaultProvisioningResult,
	VaultStoragePort,
} from "./vaultDocumentStore";
export {
	CANDIDATE_RECEIPT_TTL_MS,
	MAX_CANDIDATE_RECEIPTS_GLOBAL,
	MAX_CANDIDATE_RECEIPTS_PER_BODY,
	MAX_CANDIDATE_RECEIPT_LEDGER_BYTES,
} from "./vaultCatalogStore";

export interface SemanticAuthorityReceipt {
	operationId: string;
	requestDigest: string;
	kind: "promote" | "demote";
	path: string;
	documentId: string;
	sourceRevision: string;
	contentHash: string;
	size: number;
	documentGeneration: number;
	bodyEpoch: SemanticEpoch;
	rootSequence: number;
	rootGeneration: number;
	rootEpoch: SemanticEpoch;
	rollbackBlobHash: string | null;
	vaultGeneration: string;
	runtimeEpoch: string;
	createdAt: number;
}

/** Checkpoint chunks per multi-row INSERT: 1 + 5 x 19 = 96 bound parameters (under the 100 per-query cap). */
const BULK_CHUNK_ROWS_PER_STATEMENT = 19;
/** JSON array parameter split point (UTF-16 units; <= ~768 KB UTF-8, far below the 2 MB value limit). */
const BULK_JSON_PARAMETER_CHARS = 256 * 1024;

export interface BulkCreateFileWrite {
	bodyId: string;
	path: string;
	/** Full encoded Yjs state (no edit history). */
	state: Uint8Array;
	stateSha256: string;
	chunks: Array<{ byteLength: number; sha256: string }>;
	contentHash: string;
	size: number;
}

export interface BulkCreateAttachmentWrite {
	operationId: string;
	path: string;
	hash: string;
	size: number;
	mime: string;
}

export interface BulkCreateReceiptRecord {
	batchId: string;
	requestDigest: string;
	vaultSequence: number;
	rootGeneration: number;
	rootEpoch: SemanticEpoch;
	outcomes: unknown;
	createdAt: number;
}

export interface DurableCommitObservation {
	documentId: string;
	ingressBytes: number;
	commitLatencyMs: number;
	vaultSequence: number;
	sequenceReset?: boolean;
}
export type {
	AttachmentCatalogEvent,
	BodyLifecycle,
	CatalogDeltaEntry,
	CatalogHeadAtBoundary,
	CatalogMutation,
	DurableCandidateReceipt,
	DurableLifecycleRecord,
	DurableRootPublication,
	PendingCreationCandidate,
	SemanticCandidateReceipt,
	SemanticCatalogHead,
	SemanticCatalogMutation,
	SemanticLifecycleReceipt,
} from "./vaultCatalogStore";
export {
	assertHistoryPinAdmission,
	DEFAULT_HISTORY_PIN_LIMITS,
	isValidOperationId,
	MAX_ACTIVE_HISTORY_PINS,
	MAX_HISTORY_PIN_HARD_TTL_MS,
	MAX_PIN_RETAINED_CHECKPOINT_BYTES,
} from "./vaultBootstrapStore";
export type {
	ContentObjectRecord,
	HistoryPin,
	HistoryPinDiagnostic,
	HistoryPinHealth,
	HistoryPinKind,
	HistoryPinLimits,
	VaultOperation,
	VaultOperationKind,
	VaultOperationPage,
} from "./vaultBootstrapStore";
export type {
	BodyRecipeDescriptor,
	CaptureDescriptor,
	CapturePlanEntry,
	CapturePlanStream,
	DurableRestoreEntry,
	GcAuthority,
	GcEpoch,
	MaterializationLease,
	RecoveryCaptureState,
	RecoveryDefectRecord,
	RecoveryReason,
	RecoveryRoot,
	RecoveryRootKind,
	RecoverySnapshotCatalogEntry,
	RecoverySnapshotDependency,
	RecoveryTree,
	RestoreAuthority,
	RestoreEntryState,
	RestoreSelection,
	SweepLease,
} from "./recoveryAuthorityStore";

/** Compatibility facade for cross-domain atomic vault mutations. */
export class VaultStore extends RecoveryAuthorityStore {
	private commitObserver: ((observation: DurableCommitObservation) => void) | null = null;

	setCommitObserver(observer: ((observation: DurableCommitObservation) => void) | null): void {
		this.commitObserver = observer;
	}

	private observeCommit(observation: DurableCommitObservation): void {
		try { this.commitObserver?.(observation); }
		catch (error) {
			// The SQLite transaction is already authoritative. Observability and
			// maintenance must never turn a committed mutation into a reported failure.
			console.warn("[yaos-vault] post-commit observer failed", error);
		}
	}

	override semanticResetFromEncodedState(
		documentId: string,
		freshEncodedState: Uint8Array,
		expectedHead: CheckpointExpectedHead,
		now = Date.now(),
		catalogContent?: { contentHash: string; size: number },
	): SemanticResetResult {
		const startedAt = performance.now();
		const result = super.semanticResetFromEncodedState(documentId, freshEncodedState, expectedHead, now, catalogContent);
		this.observeCommit({ documentId, ingressBytes: freshEncodedState.byteLength,
			commitLatencyMs: performance.now() - startedAt, vaultSequence: result.vaultSequence });
		return result;
	}
	semanticAuthorityReceipt(operationId: string): SemanticAuthorityReceipt | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			operation_id: string; request_digest: string; kind: "promote" | "demote"; path: string;
			document_id: string; source_revision: string; content_hash: string; size: number;
			document_generation: number; body_epoch: number; root_sequence: number; root_generation: number; root_epoch: number;
			rollback_blob_hash: string | null; runtime_epoch: string; created_at: number;
		}>(`SELECT operation_id, request_digest, kind, path, document_id, source_revision,
		          content_hash, size, document_generation, body_epoch, root_sequence, root_generation, root_epoch,
		          rollback_blob_hash, runtime_epoch, created_at
		   FROM vault_semantic_authority_receipts WHERE operation_id = ?`, operationId).toArray()[0];
		return row ? { operationId: row.operation_id, requestDigest: row.request_digest, kind: row.kind,
			path: row.path, documentId: row.document_id, sourceRevision: row.source_revision,
			contentHash: row.content_hash, size: row.size, documentGeneration: row.document_generation,
			bodyEpoch: parseSemanticEpoch(row.body_epoch, "semantic authority body epoch"),
			rootSequence: row.root_sequence, rootGeneration: row.root_generation,
			rootEpoch: parseSemanticEpoch(row.root_epoch, "semantic authority root epoch"),
			rollbackBlobHash: row.rollback_blob_hash, vaultGeneration: this.currentVaultGeneration(),
			runtimeEpoch: row.runtime_epoch, createdAt: row.created_at } : null;
	}

	commitSemanticPromotion(input: {
		operationId: string; requestDigest: string; path: string; documentId: string;
		sourceRevision: string; contentHash: string; size: number; rollbackBlobHash: string;
		rollbackBlobSize: number; semanticUpdate: Uint8Array;
		bodyEpoch: SemanticEpoch; rootEpoch: SemanticEpoch; rootUpdate: Uint8Array; expectedRootGeneration: number;
		runtimeEpoch: string; rollbackRetainedUntil: number;
		actor: VaultActorContext;
		now?: number;
	}): SemanticAuthorityReceipt {
		const commitStartedAt = performance.now();
		this.initialize();
		const existing = this.semanticAuthorityReceipt(input.operationId);
		if (existing) {
			if (existing.requestDigest !== input.requestDigest || existing.kind !== "promote"
				|| existing.bodyEpoch !== input.bodyEpoch || existing.rootEpoch !== input.rootEpoch) {
				throw new Error("semantic_authority_operation_reused");
			}
			return existing;
		}
		if (this.documentHead(input.documentId)) throw new Error("semantic_document_already_exists");
		const now = input.now ?? Date.now();
		let documentGeneration = 0;
		let rootSequence = 0;
		let rootGeneration = 0;
		this.storage.transactionSync(() => {
			this.assertActorCurrent(input.actor);
			if (this.documentHead(input.documentId)) throw new Error("semantic_document_already_exists");
			this.assertSemanticHead(input.documentId, null);
			const rootHead = this.documentHead("root");
			if (!rootHead || rootHead.generation !== input.expectedRootGeneration
				|| rootHead.semanticEpoch !== input.rootEpoch) throw new Error("semantic_root_head_changed");
			if (input.bodyEpoch !== INITIAL_SEMANTIC_EPOCH) throw new Error("semantic_body_epoch_changed");
			const attachmentHead = this.attachmentHead(input.path);
			if (!attachmentHead || attachmentHead.lifecycle !== "active"
				|| attachmentHead.operationId !== input.sourceRevision
				|| attachmentHead.contentHash !== input.rollbackBlobHash
				|| attachmentHead.size !== input.rollbackBlobSize) throw new Error("attachment_head_changed");
			const documentSequence = this.storage.sql.exec<{ sequence: number }>(
				this.clockAdvanceSql()).one().sequence;
			documentGeneration = 1;
			this.storage.sql.exec(`INSERT INTO vault_journal(
			 sequence, document_id, generation, semantic_epoch, kind, update_byte_length, data, created_at)
			 VALUES (?, ?, ?, ?, 'semantic-promote', ?, ?, ?)`, documentSequence, input.documentId,
				documentGeneration, INITIAL_SEMANTIC_EPOCH, input.semanticUpdate.byteLength,
				ownedUpdate(input.semanticUpdate), now).toArray();
			this.storage.sql.exec(`INSERT INTO vault_document_heads(document_id, generation, semantic_epoch, latest_sequence)
			 VALUES (?, ?, ?, ?)`, input.documentId, documentGeneration, INITIAL_SEMANTIC_EPOCH, documentSequence).toArray();

			rootSequence = this.storage.sql.exec<{ sequence: number }>(
				this.clockAdvanceSql()).one().sequence;
			rootGeneration = rootHead.generation + 1;
			this.storage.sql.exec(`INSERT INTO vault_journal(
			 sequence, document_id, generation, semantic_epoch, kind, update_byte_length, data, created_at)
			 VALUES (?, 'root', ?, ?, 'semantic-promote', ?, ?, ?)`, rootSequence, rootGeneration,
				rootHead.semanticEpoch, input.rootUpdate.byteLength, ownedUpdate(input.rootUpdate), now).toArray();
			this.storage.sql.exec("UPDATE vault_document_heads SET generation = ?, latest_sequence = ? WHERE document_id = 'root'",
				rootGeneration, rootSequence).toArray();
			this.storage.sql.exec(`INSERT INTO vault_semantic_catalog_events(
			 sequence, document_id, file_id, kind, format, format_version, path, previous_path,
			 lifecycle, generation, document_epoch, content_hash, size, mutation_index
			) VALUES (?, ?, ?, 'canvas', 'json-canvas', 1, ?, NULL, 'active', ?, ?, ?, ?, 0)`,
				rootSequence, input.documentId, input.documentId, input.path, documentGeneration,
				INITIAL_SEMANTIC_EPOCH, input.contentHash, input.size).toArray();
			this.storage.sql.exec(`INSERT INTO vault_attachment_catalog_events(
			 sequence, path, content_hash, size, mime, lifecycle, operation_id
			) VALUES (?, ?, ?, ?, 'application/json', 'deleted', ?)`, rootSequence, input.path,
				input.rollbackBlobHash, input.rollbackBlobSize, input.operationId).toArray();
			this.storage.sql.exec(`INSERT INTO vault_semantic_authority_receipts(
			 operation_id, request_digest, kind, path, document_id, source_revision, content_hash,
			 size, document_generation, body_epoch, root_sequence, root_generation, root_epoch,
			 rollback_blob_hash, runtime_epoch, created_at
			) VALUES (?, ?, 'promote', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, input.operationId,
				input.requestDigest, input.path, input.documentId, input.sourceRevision, input.contentHash,
				input.size, documentGeneration, input.bodyEpoch, rootSequence, rootGeneration, input.rootEpoch, input.rollbackBlobHash,
				input.runtimeEpoch, now).toArray();
			this.storage.sql.exec(`INSERT INTO vault_semantic_rollback_blobs(
			 document_id, content_hash, size, retained_until, operation_id
			) VALUES (?, ?, ?, ?, ?)`, input.documentId, input.rollbackBlobHash, input.rollbackBlobSize,
				input.rollbackRetainedUntil, input.operationId).toArray();
			this.storage.sql.exec(`INSERT INTO vault_mutation_attribution(
			 sequence, mutation_index, principal_id, membership_revision, device_id,
			 device_credential_revision, operation_id, request_digest
			) VALUES (?, 0, ?, ?, ?, ?, ?, ?)`, rootSequence, input.actor.principalId,
				input.actor.membershipRevision, input.actor.deviceId, input.actor.deviceCredentialRevision,
				input.operationId, input.requestDigest).toArray();
		});
		const commitLatencyMs = performance.now() - commitStartedAt;
		this.observeCommit({ documentId: input.documentId, ingressBytes: input.semanticUpdate.byteLength,
			commitLatencyMs, vaultSequence: rootSequence - 1 });
		this.observeCommit({ documentId: "root", ingressBytes: input.rootUpdate.byteLength,
			commitLatencyMs, vaultSequence: rootSequence });
		return { operationId: input.operationId, requestDigest: input.requestDigest, kind: "promote",
			path: input.path, documentId: input.documentId, sourceRevision: input.sourceRevision,
			contentHash: input.contentHash, size: input.size, documentGeneration, bodyEpoch: input.bodyEpoch, rootSequence,
			rootGeneration, rootEpoch: input.rootEpoch, rollbackBlobHash: input.rollbackBlobHash, vaultGeneration: this.currentVaultGeneration(),
			runtimeEpoch: input.runtimeEpoch, createdAt: now };
	}

	commitSemanticDemotion(input: {
		operationId: string; requestDigest: string; path: string; documentId: string;
		sourceRevision: string; expectedDocumentGeneration: number; contentHash: string; size: number;
		bodyEpoch: SemanticEpoch; rootEpoch: SemanticEpoch; mime: string; rootUpdate: Uint8Array;
		expectedRootGeneration: number; runtimeEpoch: string;
		expectedSemanticHead: SemanticCatalogHead;
		actor: VaultActorContext;
		now?: number;
	}): SemanticAuthorityReceipt {
		const commitStartedAt = performance.now();
		this.initialize();
		const existing = this.semanticAuthorityReceipt(input.operationId);
		if (existing) {
			if (existing.requestDigest !== input.requestDigest || existing.kind !== "demote"
				|| existing.bodyEpoch !== input.bodyEpoch || existing.rootEpoch !== input.rootEpoch) {
				throw new Error("semantic_authority_operation_reused");
			}
			return existing;
		}
		const now = input.now ?? Date.now();
		let rootSequence = 0;
		let rootGeneration = 0;
		this.storage.transactionSync(() => {
			this.assertActorCurrent(input.actor);
			this.assertSemanticHead(input.documentId, input.expectedSemanticHead);
			const documentHead = this.documentHead(input.documentId);
			if (!documentHead || documentHead.generation !== input.expectedDocumentGeneration
				|| documentHead.semanticEpoch !== input.bodyEpoch) throw new Error("semantic_head_changed");
			const rootHead = this.documentHead("root");
			if (!rootHead || rootHead.generation !== input.expectedRootGeneration
				|| rootHead.semanticEpoch !== input.rootEpoch) throw new Error("semantic_root_head_changed");
			const semanticHead = this.semanticHeadAt(this.currentSequence(), input.documentId);
			if (!semanticHead || semanticHead.lifecycle !== "active" || semanticHead.path !== input.path
				|| semanticHead.generation !== input.expectedDocumentGeneration || semanticHead.bodyEpoch !== input.bodyEpoch
				|| semanticHead.contentHash !== input.contentHash || semanticHead.size !== input.size) {
				throw new Error("semantic_catalog_head_changed");
			}
			rootSequence = this.storage.sql.exec<{ sequence: number }>(
				this.clockAdvanceSql()).one().sequence;
			rootGeneration = rootHead.generation + 1;
			this.storage.sql.exec(`INSERT INTO vault_journal(
			 sequence, document_id, generation, semantic_epoch, kind, update_byte_length, data, created_at)
			 VALUES (?, 'root', ?, ?, 'semantic-demote', ?, ?, ?)`, rootSequence, rootGeneration,
				rootHead.semanticEpoch, input.rootUpdate.byteLength, ownedUpdate(input.rootUpdate), now).toArray();
			this.storage.sql.exec("UPDATE vault_document_heads SET generation = ?, latest_sequence = ? WHERE document_id = 'root'",
				rootGeneration, rootSequence).toArray();
			this.storage.sql.exec(`INSERT INTO vault_semantic_catalog_events(
			 sequence, document_id, file_id, kind, format, format_version, path, previous_path,
			 lifecycle, generation, document_epoch, content_hash, size, mutation_index
			) VALUES (?, ?, ?, 'canvas', 'json-canvas', 1, ?, NULL, 'tombstoned', ?, ?, ?, ?, 0)`,
				rootSequence, input.documentId, input.documentId, input.path, input.expectedDocumentGeneration,
				documentHead.semanticEpoch, input.contentHash, input.size).toArray();
			this.storage.sql.exec(`INSERT INTO vault_attachment_catalog_events(
			 sequence, path, content_hash, size, mime, lifecycle, operation_id
			) VALUES (?, ?, ?, ?, ?, 'active', ?)`, rootSequence, input.path, input.contentHash,
				input.size, input.mime, input.operationId).toArray();
			this.storage.sql.exec(`INSERT INTO vault_semantic_authority_receipts(
			 operation_id, request_digest, kind, path, document_id, source_revision, content_hash,
			 size, document_generation, body_epoch, root_sequence, root_generation, root_epoch,
			 rollback_blob_hash, runtime_epoch, created_at
			) VALUES (?, ?, 'demote', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`, input.operationId,
				input.requestDigest, input.path, input.documentId, input.sourceRevision, input.contentHash,
				input.size, input.expectedDocumentGeneration, input.bodyEpoch, rootSequence, rootGeneration, input.rootEpoch,
				input.runtimeEpoch, now).toArray();
			this.storage.sql.exec(`INSERT INTO vault_mutation_attribution(
			 sequence, mutation_index, principal_id, membership_revision, device_id,
			 device_credential_revision, operation_id, request_digest
			) VALUES (?, 0, ?, ?, ?, ?, ?, ?)`, rootSequence, input.actor.principalId,
				input.actor.membershipRevision, input.actor.deviceId, input.actor.deviceCredentialRevision,
				input.operationId, input.requestDigest).toArray();
		});
		this.observeCommit({ documentId: "root", ingressBytes: input.rootUpdate.byteLength,
			commitLatencyMs: performance.now() - commitStartedAt, vaultSequence: rootSequence });
		return { operationId: input.operationId, requestDigest: input.requestDigest, kind: "demote",
			path: input.path, documentId: input.documentId, sourceRevision: input.sourceRevision,
			contentHash: input.contentHash, size: input.size, documentGeneration: input.expectedDocumentGeneration,
			bodyEpoch: input.bodyEpoch, rootSequence, rootGeneration, rootEpoch: input.rootEpoch,
			rollbackBlobHash: null, vaultGeneration: this.currentVaultGeneration(),
			runtimeEpoch: input.runtimeEpoch, createdAt: now };
	}

	listRetainedSemanticRollbackBlobs(afterDocumentId = "", limit = 1000, now = Date.now()): Array<{
		documentId: string; contentHash: string; size: number; retainedUntil: number;
	}> {
		this.initialize();
		return this.storage.sql.exec<{ document_id: string; content_hash: string; size: number; retained_until: number }>(
			`SELECT document_id, content_hash, size, retained_until FROM vault_semantic_rollback_blobs
			 WHERE retained_until > ? AND document_id > ? ORDER BY document_id LIMIT ?`, now, afterDocumentId,
			Math.min(1000, Math.max(1, limit))).toArray().map((row) => ({ documentId: row.document_id,
				contentHash: row.content_hash, size: row.size, retainedUntil: row.retained_until }));
	}

	countRetainedSemanticRollbackBlobs(now = Date.now()): number {
		this.initialize();
		return this.storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM vault_semantic_rollback_blobs WHERE retained_until > ?", now).one().count;
	}

	provisionVault(
		vaultId: string,
		vaultGeneration: string,
		rootUpdate: Uint8Array,
		now = Date.now(),
	): VaultProvisioningResult {
		this.initialize();
		if (!isCanonicalVaultId(vaultId) || !isCanonicalVaultId(vaultGeneration)) {
			throw new Error("invalid vault identity");
		}
		const existing = this.vaultMetadata();
		if (existing !== null) {
			if (existing.vaultId !== vaultId || existing.vaultGeneration !== vaultGeneration) {
				throw new Error("vault generation mismatch");
			}
			return { ...existing, created: false };
		}
		const rootHead = this.documentHead("root");
		if (rootHead !== null) {
			throw new Error("vault storage contains a root without provisioning metadata");
		}
		this.commitUpdate({
			documentId: "root",
			update: rootUpdate,
			kind: "root",
			now,
			provisioning: { vaultId, vaultGeneration, provisionedAt: now },
		});
		return {
			created: true,
			vaultId,
			vaultGeneration,
			schemaVersion: SCHEMA_VERSION,
			storageFormatVersion: STORAGE_FORMAT_VERSION,
			provisionedAt: now,
		};
	}

	resetActiveState(rootUpdate: Uint8Array, now = Date.now()): void {
		const commitStartedAt = performance.now();
		if (rootUpdate.byteLength === 0 || rootUpdate.byteLength > MAX_DURABLE_UPDATE_BYTES) {
			throw new Error("root update exceeds durable value limit");
		}
		this.ensureBulkCreateReceipts();
		if (this.activePins(now).length > 0) throw new Error("active_state_reset_blocked_by_history_pin");
		this.storage.transactionSync(() => {
			for (const table of [
				"vault_restore_entries",
				"vault_operation_outcomes",
				"vault_mutation_attribution",
				"vault_lifecycle_publications",
				"vault_lifecycle_receipts",
				"vault_creation_candidates",
				"vault_bulk_create_receipts",
				"vault_candidate_receipts",
				"vault_semantic_lifecycle_receipts",
				"vault_semantic_authority_receipts",
				"vault_semantic_rollback_blobs",
				"vault_semantic_candidate_receipts",
				"vault_semantic_catalog_events",
				"vault_attachment_operations",
				"vault_attachment_catalog_events",
				"vault_catalog_events",
				"vault_semantic_compaction_state",
				"vault_checkpoint_manifests",
				"vault_checkpoints",
				"vault_journal",
				"vault_document_heads",
			]) {
				this.storage.sql.exec(`DELETE FROM ${table}`).toArray();
			}
			if (this.relayTailEnabled) {
				this.storage.sql.exec("DELETE FROM relay_body_tail").toArray();
				this.storage.sql.exec("DELETE FROM relay_device_receipts").toArray();
			}
			this.storage.sql.exec(
				"DELETE FROM vault_operation_pages WHERE operation_id IN (SELECT operation_id FROM vault_operations WHERE kind = 'bootstrap')",
			).toArray();
			this.storage.sql.exec("DELETE FROM vault_operations WHERE kind = 'bootstrap'").toArray();
			this.storage.sql.exec("DELETE FROM vault_recovery_roots WHERE kind = 'restore'").toArray();
			this.storage.sql.exec("DELETE FROM vault_recovery_mutex").toArray();
			this.storage.sql.exec("UPDATE vault_clock SET sequence = 1 WHERE id = 1").toArray();
			this.storage.sql.exec("UPDATE vault_feed_state SET floor_sequence = 0 WHERE id = 1").toArray();
			this.storage.sql.exec(
			"INSERT INTO vault_journal(sequence, document_id, generation, semantic_epoch, kind, update_byte_length, data, created_at) VALUES (1, 'root', 1, 1, 'root', ?, ?, ?)",
				rootUpdate.byteLength,
				rootUpdate.slice().buffer,
				now,
			).toArray();
			this.storage.sql.exec(
			"INSERT INTO vault_document_heads(document_id, generation, semantic_epoch, latest_sequence) VALUES ('root', 1, 1, 1)",
			).toArray();
		});
		this.observeCommit({ documentId: "root", ingressBytes: rootUpdate.byteLength,
			commitLatencyMs: performance.now() - commitStartedAt, vaultSequence: 1, sequenceReset: true });
	}

	commitCandidate(input: {
		catalog?: CatalogMutation;
		bodyId: string;
		clientId: string;
		candidateId: string;
		candidateDigest: string;
		bodyEpoch: SemanticEpoch;
		/** Legacy one-frame form. */
		update?: Uint8Array;
		/** Ordered, independently valid CRDT frames for one logical candidate. */
		updates?: readonly Uint8Array[];
		expectedHead: { generation: number; semanticEpoch: SemanticEpoch; latestSequence: number } | null;
		changesState: boolean;
		vaultGeneration: string;
		runtimeEpoch: string;
		actor: VaultActorContext;
		now?: number;
	}): DurableCandidateReceipt {
		if (input.update && input.updates) throw new Error("candidate update form is ambiguous");
		const updates = input.updates ?? (input.update ? [input.update] : []);
		if (updates.length === 0 || updates.length > MAX_CANDIDATE_UPDATE_FRAMES) {
			throw new Error("invalid candidate frame count");
		}
		let ingressBytes = 0;
		for (const update of updates) {
			if (!(update instanceof Uint8Array) || update.byteLength === 0
				|| update.byteLength > MAX_DURABLE_UPDATE_BYTES) {
				throw new Error("candidate update exceeds durable value limit");
			}
			ingressBytes += update.byteLength;
			if (!Number.isSafeInteger(ingressBytes) || ingressBytes > MAX_CANDIDATE_UPDATE_BYTES) {
				throw new Error("candidate update exceeds aggregate limit");
			}
		}
		if (!input.bodyId || input.bodyId.length > 256 || !input.clientId || input.clientId.length > 256
			|| !input.candidateId || input.candidateId.length > 256
			|| !/^[a-f0-9]{64}$/.test(input.candidateDigest)
			|| !input.runtimeEpoch || input.runtimeEpoch.length > 128) {
			throw new Error("invalid candidate receipt identity");
		}
		this.initialize();
		this.assertVaultGeneration(input.vaultGeneration);
		const now = input.now ?? Date.now();
		this.pruneCandidateReceipts(now);
		const bodyOverflow = this.storage.sql.exec(
			`DELETE FROM vault_candidate_receipts WHERE rowid IN (
			   SELECT rowid FROM vault_candidate_receipts WHERE body_id = ?
			   ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
			 )`,
			input.bodyId,
			MAX_CANDIDATE_RECEIPTS_PER_BODY - 1,
		);
		bodyOverflow.toArray();
		const existing = this.candidateReceipt(input.bodyId, input.clientId, input.candidateId);
		if (existing) {
			if (existing.candidateDigest !== input.candidateDigest) {
				throw new Error("candidate ID reused with a different digest");
			}
			return existing;
		}
		const commitStartedAt = performance.now();
		let receipt!: DurableCandidateReceipt;
		this.storage.transactionSync(() => {
			this.assertActorCurrent(input.actor);
			const headQuery = this.storage.sql.exec<{ generation: number; semantic_epoch: number; latest_sequence: number }>(
				"SELECT generation, semantic_epoch, latest_sequence FROM vault_document_heads WHERE document_id = ?",
				input.bodyId,
			);
			const currentHead = headQuery.toArray()[0];
			if (currentHead?.generation !== input.expectedHead?.generation
				|| currentHead?.semantic_epoch !== input.expectedHead?.semanticEpoch
				|| currentHead?.latest_sequence !== input.expectedHead?.latestSequence) {
				throw new Error("candidate_generation_fence_changed");
			}
			const semanticEpoch = parseSemanticEpoch(input.bodyEpoch, "candidate body epoch");
			if (currentHead?.semantic_epoch !== semanticEpoch) {
				throw new Error("candidate_semantic_epoch_fence_changed");
			}
			if (!currentHead || currentHead.generation <= 0) throw new Error("body state is missing");

			let vaultSequence = currentHead.latest_sequence;
			let generation = currentHead.generation;
			if (input.changesState) {
				generation++;
				const clock = this.storage.sql.exec<{ sequence: number }>(
					this.clockAdvanceSql(true),
					updates.length,
				);
				vaultSequence = clock.one().sequence;
				const firstSequence = vaultSequence - updates.length + 1;
				for (const [index, update] of updates.entries()) {
					this.storage.sql.exec(
						`INSERT INTO vault_journal(sequence, document_id, generation, semantic_epoch, kind,
						 update_byte_length, data, created_at) VALUES (?, ?, ?, ?, 'body', ?, ?, ?)`,
						firstSequence + index,
						input.bodyId,
						generation,
						semanticEpoch,
						update.byteLength,
						update.slice().buffer,
						now,
					).toArray();
				}
				this.storage.sql.exec(
					`INSERT INTO vault_mutation_attribution(
					 sequence, mutation_index, principal_id, membership_revision, device_id,
					 device_credential_revision, operation_id, request_digest
					) VALUES (?, 0, ?, ?, ?, ?, ?, ?)`,
					vaultSequence,
					input.actor.principalId,
					input.actor.membershipRevision,
					input.actor.deviceId,
					input.actor.deviceCredentialRevision,
					input.candidateId,
					input.candidateDigest,
				).toArray();
				this.storage.sql.exec(
					`INSERT INTO vault_document_heads(document_id, generation, semantic_epoch, latest_sequence)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(document_id) DO UPDATE SET generation = excluded.generation,
					 semantic_epoch = excluded.semantic_epoch, latest_sequence = excluded.latest_sequence`,
					input.bodyId,
					generation,
					semanticEpoch,
					vaultSequence,
				).toArray();
				if (input.catalog) {
					this.assertCatalogPathUniqueness([input.catalog], vaultSequence - 1);
					this.storage.sql.exec(
						`INSERT INTO vault_catalog_events(
						 sequence, body_id, file_id, path, previous_path, lifecycle, generation, body_epoch,
						 content_hash, size, mutation_index
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
						vaultSequence,
						input.catalog.bodyId,
						input.catalog.fileId,
						input.catalog.path,
						input.catalog.previousPath ?? null,
						input.catalog.lifecycle,
						input.catalog.bodyGeneration,
						semanticEpoch,
						input.catalog.contentHash ?? null,
						input.catalog.size ?? null,
					).toArray();
				}
			}
			receipt = {
				bodyId: input.bodyId,
				clientId: input.clientId,
				candidateId: input.candidateId,
				candidateDigest: input.candidateDigest,
				bodyEpoch: semanticEpoch,
				durableGeneration: generation,
				vaultSequence,
				vaultGeneration: input.vaultGeneration,
				runtimeEpoch: input.runtimeEpoch,
			};
			this.storage.sql.exec(
				`INSERT INTO vault_operation_outcomes(
					 principal_id, membership_revision, device_id, device_credential_revision,
					 operation_id, request_digest, vault_sequence, committed_at, expires_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				input.actor.principalId,
				input.actor.membershipRevision,
				input.actor.deviceId,
				input.actor.deviceCredentialRevision,
				input.candidateId,
				input.candidateDigest,
				receipt.vaultSequence,
				now,
				now + CANDIDATE_RECEIPT_TTL_MS,
			).toArray();
			this.storage.sql.exec(
				`INSERT INTO vault_candidate_receipts(
					 body_id, client_id, candidate_id, candidate_digest, body_epoch, durable_generation,
					 vault_sequence, runtime_epoch, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				receipt.bodyId,
				receipt.clientId,
				receipt.candidateId,
				receipt.candidateDigest,
				receipt.bodyEpoch,
				receipt.durableGeneration,
				receipt.vaultSequence,
				receipt.runtimeEpoch,
				now,
			).toArray();
		});
		this.noteCandidateReceiptInserts(1);
		if (input.changesState) {
			this.observeCommit({ documentId: input.bodyId, ingressBytes,
				commitLatencyMs: performance.now() - commitStartedAt, vaultSequence: receipt.vaultSequence });
		}
		return receipt;
	}

	commitUpdate(input: {
		documentId: string;
		update: Uint8Array;
		kind: VaultCommitKind;
		expectedHead?: { generation: number; semanticEpoch: SemanticEpoch; latestSequence: number } | null;
		expectedSemanticHead?: SemanticCatalogHead | null;
		catalog?: CatalogMutation | CatalogMutation[];
		semanticCatalog?: SemanticCatalogMutation | SemanticCatalogMutation[];
		semanticCandidateReceipt?: Omit<SemanticCandidateReceipt, "vaultSequence">;
		semanticLifecycleReceipt?: Omit<SemanticLifecycleReceipt, "vaultSequence" | "rootGeneration">;
		lifecycleReceipt?: Omit<DurableLifecycleRecord, "vaultSequence" | "rootGeneration">;
		lifecycleReceipts?: Array<Omit<DurableLifecycleRecord, "vaultSequence" | "rootGeneration">>;
		rootPublications?: Array<{ operationId: string; lifecycleSequence: number; rootEpoch: SemanticEpoch;
			vaultGeneration: string; runtimeEpoch: string }>;
		actorAttributions?: Array<{
			actor: VaultActorContext;
			operationId?: string;
			requestDigest?: string;
		}>;
		attachmentCatalog?: Array<Omit<AttachmentCatalogEvent, "sequence"> & { operationId: string }>;
		attachmentOperation?: { operationId: string; requestDigest: string; rootEpoch: SemanticEpoch };
		provisioning?: { vaultId: string; vaultGeneration: string; provisionedAt: number };
		now?: number;
	}): DurableCommitResult {
		const commitStartedAt = performance.now();
		if (!input.documentId) throw new Error("documentId is required");
		if (input.update.byteLength === 0) throw new Error("empty semantic update is not a commit");
		if (input.update.byteLength > MAX_DURABLE_UPDATE_BYTES) {
			throw new Error("semantic update exceeds durable value limit");
		}
		this.initialize();
		const now = input.now ?? Date.now();
		for (const receipt of [input.lifecycleReceipt, ...(input.lifecycleReceipts ?? [])]) {
			if (receipt) this.assertVaultGeneration(receipt.vaultGeneration);
		}
		for (const publication of input.rootPublications ?? []) this.assertVaultGeneration(publication.vaultGeneration);
		if ((input.lifecycleReceipt || input.lifecycleReceipts || input.rootPublications || input.attachmentCatalog || input.attachmentOperation) && input.documentId !== "root") {
			throw new Error("root publication metadata must commit through root");
		}
		if (input.provisioning && input.documentId !== "root") {
			throw new Error("provisioning metadata must commit with the root");
		}
		let rowsRead = 0;
		let rowsWritten = 0;
		let sequence = 0;
		let generation = 0;
		let semanticEpoch: SemanticEpoch = INITIAL_SEMANTIC_EPOCH;
		this.storage.transactionSync(() => {
			for (const attribution of input.actorAttributions ?? []) this.assertActorCurrent(attribution.actor);
			const head = this.storage.sql.exec<{ generation: number; semantic_epoch: number; latest_sequence: number }>(
				"SELECT generation, semantic_epoch, latest_sequence FROM vault_document_heads WHERE document_id = ?",
				input.documentId,
			);
			const currentHead = head.toArray()[0];
			if (input.expectedSemanticHead !== undefined) {
				const semanticMutations = input.semanticCatalog
					? (Array.isArray(input.semanticCatalog) ? input.semanticCatalog : [input.semanticCatalog]) : [];
				const documentId = input.expectedSemanticHead?.documentId
					?? (semanticMutations.length === 1 ? semanticMutations[0]!.documentId : undefined)
					?? (input.documentId === "root" ? undefined : input.documentId);
				if (!documentId) throw new Error("semantic catalog expectation requires one mutation");
				this.assertSemanticHead(documentId, input.expectedSemanticHead);
			}
			if (input.expectedHead !== undefined) {
				const expected = input.expectedHead;
				if (expected === null ? currentHead !== undefined
					: !currentHead || currentHead.generation !== expected.generation
						|| currentHead.semantic_epoch !== expected.semanticEpoch
						|| currentHead.latest_sequence !== expected.latestSequence) {
					throw new Error("document_head_changed");
				}
			}
			generation = (currentHead?.generation ?? 0) + 1;
			semanticEpoch = currentHead
				? parseSemanticEpoch(currentHead.semantic_epoch)
				: INITIAL_SEMANTIC_EPOCH;
			rowsRead += head.rowsRead;
			const clock = this.storage.sql.exec<{ sequence: number }>(
				this.clockAdvanceSql(),
			);
			sequence = clock.one().sequence;
			rowsWritten += clock.rowsWritten;
			const journal = this.storage.sql.exec(
				`INSERT INTO vault_journal(sequence, document_id, generation, semantic_epoch, kind,
				 update_byte_length, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				sequence,
				input.documentId,
				generation,
				semanticEpoch,
				input.kind,
				input.update.byteLength,
				input.update.slice().buffer,
				now,
			);
			journal.toArray();
			rowsWritten += journal.rowsWritten;
			for (const [mutationIndex, attribution] of (input.actorAttributions ?? []).entries()) {
				const actor = attribution.actor;
				const written = this.storage.sql.exec(`INSERT INTO vault_mutation_attribution(
				 sequence, mutation_index, principal_id, membership_revision, device_id,
				 device_credential_revision, operation_id, request_digest
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, sequence, mutationIndex, actor.principalId,
					actor.membershipRevision, actor.deviceId, actor.deviceCredentialRevision,
					attribution.operationId ?? null, attribution.requestDigest ?? null);
				written.toArray();
				rowsWritten += written.rowsWritten;
			}
			const writeHead = this.storage.sql.exec(
				`INSERT INTO vault_document_heads(document_id, generation, semantic_epoch, latest_sequence)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(document_id) DO UPDATE SET
				 generation = excluded.generation,
				 semantic_epoch = excluded.semantic_epoch,
				 latest_sequence = excluded.latest_sequence`,
				input.documentId,
				generation,
				semanticEpoch,
				sequence,
			);
			writeHead.toArray();
			rowsWritten += writeHead.rowsWritten;
			const mutations = input.catalog
				? (Array.isArray(input.catalog) ? input.catalog : [input.catalog])
				: [];
			this.assertCatalogPathUniqueness(mutations, sequence - 1);
			for (const [mutationIndex, mutation] of mutations.entries()) {
				let bodyEpoch = input.documentId === mutation.bodyId ? semanticEpoch : null;
				if (bodyEpoch === null) {
					const bodyHead = this.storage.sql.exec<{ semantic_epoch: number }>(
						"SELECT semantic_epoch FROM vault_document_heads WHERE document_id = ?",
						mutation.bodyId,
					);
					const row = bodyHead.toArray()[0];
					rowsRead += bodyHead.rowsRead;
					if (!row) throw new Error("catalog body epoch is missing");
					bodyEpoch = parseSemanticEpoch(row.semantic_epoch, "catalog body epoch");
				}
				const catalog = this.storage.sql.exec(
					`INSERT INTO vault_catalog_events(
					 sequence, body_id, file_id, path, previous_path, lifecycle, generation, body_epoch,
					 content_hash, size, mutation_index
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					sequence,
					mutation.bodyId,
					mutation.fileId,
					mutation.path,
					mutation.previousPath ?? null,
					mutation.lifecycle,
					mutation.bodyGeneration,
					bodyEpoch,
					mutation.contentHash ?? null,
					mutation.size ?? null,
					mutationIndex,
				);
				catalog.toArray();
				rowsWritten += catalog.rowsWritten;
			}
			const semanticMutations = input.semanticCatalog
				? (Array.isArray(input.semanticCatalog) ? input.semanticCatalog : [input.semanticCatalog]) : [];
			for (const [mutationIndex, mutation] of semanticMutations.entries()) {
				let documentEpoch = input.documentId === mutation.documentId ? semanticEpoch : null;
				if (documentEpoch === null) {
					const targetHead = this.storage.sql.exec<{ semantic_epoch: number }>(
						"SELECT semantic_epoch FROM vault_document_heads WHERE document_id = ?",
						mutation.documentId,
					);
					const row = targetHead.toArray()[0];
					rowsRead += targetHead.rowsRead;
					if (!row) throw new Error("semantic catalog document epoch is missing");
					documentEpoch = parseSemanticEpoch(row.semantic_epoch, "semantic catalog document epoch");
				}
				const catalog = this.storage.sql.exec(`INSERT INTO vault_semantic_catalog_events(
				 sequence, document_id, file_id, kind, format, format_version, path, previous_path,
				 lifecycle, generation, document_epoch, content_hash, size, mutation_index
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, sequence, mutation.documentId,
					mutation.fileId, mutation.kind, mutation.format, mutation.formatVersion, mutation.path,
					mutation.previousPath, mutation.lifecycle, mutation.documentGeneration, documentEpoch,
					mutation.contentHash ?? null, mutation.size ?? null, mutationIndex);
				catalog.toArray();
				rowsWritten += catalog.rowsWritten;
			}
			if (input.semanticLifecycleReceipt) {
				const receipt = input.semanticLifecycleReceipt;
				this.assertVaultGeneration(receipt.vaultGeneration);
				if (input.documentId !== "root" || semanticEpoch !== receipt.rootEpoch) {
					throw new Error("semantic_lifecycle_root_epoch_changed");
				}
				const receiptDocumentHead = this.storage.sql.exec<{ semantic_epoch: number }>(
					"SELECT semantic_epoch FROM vault_document_heads WHERE document_id = ?", receipt.documentId).toArray()[0];
				if (!receiptDocumentHead || receiptDocumentHead.semantic_epoch !== receipt.bodyEpoch) {
					throw new Error("semantic_lifecycle_body_epoch_changed");
				}
				this.storage.sql.exec(`INSERT INTO vault_semantic_lifecycle_receipts(
				 operation_id, request_digest, document_id, file_id, kind, result_path, result_lifecycle,
				 durable_generation, body_epoch, vault_sequence, root_generation, root_epoch, runtime_epoch, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, receipt.operationId, receipt.requestDigest,
				receipt.documentId, receipt.fileId, receipt.kind, receipt.resultPath, receipt.resultLifecycle,
				receipt.durableGeneration, receipt.bodyEpoch, sequence, generation, receipt.rootEpoch, receipt.runtimeEpoch, now).toArray();
			}
			if (input.semanticCandidateReceipt) {
				const receipt = input.semanticCandidateReceipt;
				this.assertVaultGeneration(receipt.vaultGeneration);
				this.storage.sql.exec(`INSERT INTO vault_semantic_candidate_receipts(
				 document_id, client_id, candidate_id, candidate_digest, body_epoch, durable_generation, vault_sequence,
				 runtime_epoch, content_hash, size, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, receipt.documentId, receipt.clientId,
					receipt.candidateId, receipt.candidateDigest, receipt.bodyEpoch, receipt.durableGeneration, sequence,
				receipt.runtimeEpoch, receipt.contentHash, receipt.size, now).toArray();
			}
			for (const receipt of [
				...(input.lifecycleReceipt ? [input.lifecycleReceipt] : []),
				...(input.lifecycleReceipts ?? []),
			]) {
				const lifecycle = this.storage.sql.exec(
					`INSERT INTO vault_lifecycle_receipts(
						 operation_id, kind, body_id, body_epoch, file_id, durable_generation,
						 vault_sequence, runtime_epoch, candidate_id, candidate_digest,
						 source_path, result_path, result_lifecycle, root_generation, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					receipt.operationId,
					receipt.kind,
					receipt.bodyId,
					parseSemanticEpoch(receipt.bodyEpoch, "lifecycle receipt body epoch"),
					receipt.fileId,
					receipt.durableGeneration,
					sequence,
					receipt.runtimeEpoch,
					receipt.candidateId,
					receipt.candidateDigest,
					receipt.sourcePath,
					receipt.resultPath,
					receipt.resultLifecycle,
					generation,
					now,
				);
				lifecycle.toArray();
				rowsWritten += lifecycle.rowsWritten;
			}
			for (const publication of input.rootPublications ?? []) {
				const inserted = this.storage.sql.exec(
					`INSERT INTO vault_lifecycle_publications(
						 operation_id, lifecycle_sequence, root_sequence, root_generation, root_epoch, runtime_epoch, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					publication.operationId,
					publication.lifecycleSequence,
					sequence,
					generation,
					parseSemanticEpoch(publication.rootEpoch, "root publication epoch"),
					publication.runtimeEpoch,
					now,
				);
				inserted.toArray();
				rowsWritten += inserted.rowsWritten;
			}
			for (const attachment of input.attachmentCatalog ?? []) {
				const inserted = this.storage.sql.exec(
					`INSERT INTO vault_attachment_catalog_events(
					 sequence, path, content_hash, size, mime, lifecycle, operation_id
					 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					sequence,
					attachment.path,
					attachment.contentHash,
					attachment.size,
					attachment.mime,
					attachment.lifecycle,
					attachment.operationId,
				);
				inserted.toArray();
				rowsWritten += inserted.rowsWritten;
			}
			if (input.attachmentOperation) {
				const inserted = this.storage.sql.exec(
					`INSERT INTO vault_attachment_operations(
					 operation_id, request_digest, root_sequence, root_generation, root_epoch, created_at
					 ) VALUES (?, ?, ?, ?, ?, ?)`,
					input.attachmentOperation.operationId,
					input.attachmentOperation.requestDigest,
					sequence,
					generation,
					parseSemanticEpoch(input.attachmentOperation.rootEpoch, "attachment operation root epoch"),
					now,
				);
				inserted.toArray();
				rowsWritten += inserted.rowsWritten;
			}
			if (input.provisioning) {
				const inserted = this.storage.sql.exec(
					`INSERT INTO vault_meta(
					 id, vault_id, vault_generation, schema_version, storage_format_version, provisioned_at
					 ) VALUES (1, ?, ?, ?, ?, ?)`,
					input.provisioning.vaultId,
					input.provisioning.vaultGeneration,
					SCHEMA_VERSION,
					STORAGE_FORMAT_VERSION,
					input.provisioning.provisionedAt,
				);
				inserted.toArray();
				rowsWritten += inserted.rowsWritten;
			}
		});
		const result = { vaultSequence: sequence, documentId: input.documentId, generation, semanticEpoch,
			kind: input.kind, rowsRead, rowsWritten };
		this.observeCommit({ documentId: input.documentId, ingressBytes: input.update.byteLength,
			commitLatencyMs: performance.now() - commitStartedAt, vaultSequence: sequence });
		return result;
	}

	/** Record lifecycle/catalog events in the same sequence as their root update. */
	commitRootLifecycle(input: {
		rootUpdate: Uint8Array;
		kind: Extract<VaultCommitKind, "create" | "rename" | "delete" | "revive" | "lifecycle-batch">;
		catalog: CatalogMutation | CatalogMutation[];
		lifecycleReceipt?: Omit<DurableLifecycleRecord, "vaultSequence" | "rootGeneration">;
		lifecycleReceipts?: Array<Omit<DurableLifecycleRecord, "vaultSequence" | "rootGeneration">>;
		rootPublications?: Array<{ operationId: string; lifecycleSequence: number; rootEpoch: SemanticEpoch;
			vaultGeneration: string; runtimeEpoch: string }>;
		actorAttributions?: Array<{
			actor: VaultActorContext;
			operationId?: string;
			requestDigest?: string;
		}>;
		now?: number;
	}): DurableCommitResult {
		return this.commitUpdate({
			documentId: "root",
			update: input.rootUpdate,
			kind: input.kind,
			catalog: input.catalog,
			lifecycleReceipt: input.lifecycleReceipt,
			lifecycleReceipts: input.lifecycleReceipts,
			rootPublications: input.rootPublications,
			actorAttributions: input.actorAttributions,
			now: input.now,
		});
	}

	commitRootAttachments(
		rootUpdate: Uint8Array,
		events: Array<Omit<AttachmentCatalogEvent, "sequence"> & { operationId: string }>,
		operation: { operationId: string; requestDigest: string; rootEpoch: SemanticEpoch },
		expectedHead: { generation: number; semanticEpoch: SemanticEpoch; latestSequence: number },
		now = Date.now(),
		actorAttributions: Array<{
			actor: VaultActorContext;
			operationId?: string;
			requestDigest?: string;
		}> = [],
	): DurableCommitResult {
		if (events.length === 0) throw new Error("attachment publication requires an event");
		if (!operation.operationId || operation.operationId.length > 256
			|| !/^[a-f0-9]{64}$/.test(operation.requestDigest)
			|| events.length > 2
			|| new Set(events.map((event) => event.path)).size !== events.length
			|| events.some((event) => event.operationId !== operation.operationId)) {
			throw new Error("invalid attachment publication commit");
		}
		if (operation.rootEpoch !== expectedHead.semanticEpoch) throw new Error("attachment_root_epoch_changed");
		return this.commitUpdate({ documentId: "root", update: rootUpdate, kind: "blob", expectedHead, attachmentCatalog: events,
			attachmentOperation: operation, actorAttributions, now });
	}

	// ---- Write-budget spike W2: bulk create (one transaction per batch) ----

	private bulkReceiptTableReady = false;

	/** Lazily created (flag-free) so the base schema is untouched until the first bulk create. */
	ensureBulkCreateReceipts(): void {
		this.initialize();
		if (this.bulkReceiptTableReady) return;
		// WITHOUT ROWID: the TEXT primary key is the table, so one receipt is one row
		// write (no separate autoindex entry).
		this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS vault_bulk_create_receipts (
			batch_id TEXT PRIMARY KEY,
			request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
			vault_sequence INTEGER NOT NULL,
			root_generation INTEGER NOT NULL,
			root_epoch INTEGER NOT NULL CHECK(root_epoch >= 1),
			outcomes TEXT NOT NULL,
			created_at INTEGER NOT NULL
		) WITHOUT ROWID`).toArray();
		this.bulkReceiptTableReady = true;
	}

	bulkCreateReceipt(batchId: string): BulkCreateReceiptRecord | null {
		this.ensureBulkCreateReceipts();
		const row = this.storage.sql.exec<{
			batch_id: string; request_digest: string; vault_sequence: number; root_generation: number;
			root_epoch: number; outcomes: string; created_at: number;
		}>("SELECT * FROM vault_bulk_create_receipts WHERE batch_id = ?", batchId).toArray()[0];
		if (!row) return null;
		return { batchId: row.batch_id, requestDigest: row.request_digest, vaultSequence: row.vault_sequence,
			rootGeneration: row.root_generation, rootEpoch: parseSemanticEpoch(row.root_epoch, "bulk receipt root epoch"),
			outcomes: JSON.parse(row.outcomes) as unknown, createdAt: row.created_at };
	}

	/**
	 * True when an attachment operation was committed by a bulk-create batch
	 * (those carry no per-operation attachment ledger row). Rare path: only a
	 * per-operation replay of an already bulk-committed id reaches it, so a
	 * receipt scan is acceptable.
	 */
	bulkCreateCommittedAttachment(operationId: string): boolean {
		this.ensureBulkCreateReceipts();
		const needle = `"operationId":${JSON.stringify(operationId)}`;
		const rows = this.storage.sql.exec<{ outcomes: string }>(
			"SELECT outcomes FROM vault_bulk_create_receipts WHERE instr(outcomes, ?) > 0", needle).toArray();
		return rows.some((row) => (JSON.parse(row.outcomes) as Array<{ kind?: string; operationId?: string; outcome?: string }>)
			.some((item) => item.kind === "attachment" && item.operationId === operationId && item.outcome === "created"));
	}

	/**
	 * Current active Markdown owners of any of `paths` (one scan for the whole
	 * batch, instead of one `activeBodiesAtPath` scan per path), lean-overlaid.
	 */
	activeCatalogHeadsAtPaths(paths: readonly string[]): Map<string, CatalogHeadAtBoundary> {
		this.initialize();
		const result = new Map<string, CatalogHeadAtBoundary>();
		if (paths.length === 0) return result;
		const boundary = this.currentSequence();
		const rows = this.storage.sql.exec<{
			sequence: number; body_id: string; file_id: string; path: string; previous_path: string | null;
			lifecycle: BodyLifecycle; generation: number; body_epoch: number; content_hash: string | null; size: number | null;
		}>(
			`SELECT e.sequence, e.body_id, e.file_id, e.path, e.previous_path, e.lifecycle, e.generation,
			        e.body_epoch, e.content_hash, e.size
			   FROM vault_catalog_events e
			   JOIN (SELECT body_id, MAX(sequence) AS sequence FROM vault_catalog_events
			          WHERE sequence <= ? GROUP BY body_id) latest
			     ON latest.body_id = e.body_id AND latest.sequence = e.sequence
			  WHERE e.lifecycle = 'active' AND e.path IN (SELECT value FROM json_each(?))`,
			boundary, JSON.stringify(paths),
		).toArray();
		for (const row of rows) {
			if (result.has(row.path)) continue;
			result.set(row.path, this.leanOverlay(boundary, {
				sequence: row.sequence, bodyId: row.body_id,
				bodyEpoch: parseSemanticEpoch(row.body_epoch, "catalog body epoch"),
				fileId: row.file_id, path: row.path, previousPath: row.previous_path, lifecycle: row.lifecycle,
				generation: row.generation, contentHash: row.content_hash, size: row.size,
			}));
		}
		return result;
	}

	/** Read-only check (no row write) used by fully synchronous mutation sections. */
	recoveryMutexHeld(now = Date.now()): boolean {
		this.initialize();
		const row = this.storage.sql.exec<{ expires_at: number }>(
			"SELECT expires_at FROM vault_recovery_mutex WHERE id = 1",
		).toArray()[0];
		return !!row && row.expires_at > now;
	}

	/** Body ids (of `bodyIds`) that already have any durable state (head or catalog). */
	existingBodyIds(bodyIds: readonly string[]): Set<string> {
		this.initialize();
		if (bodyIds.length === 0) return new Set();
		const ids = JSON.stringify(bodyIds);
		return new Set(this.storage.sql.exec<{ id: string }>(
			`SELECT document_id AS id FROM vault_document_heads WHERE document_id IN (SELECT value FROM json_each(?))
			 UNION SELECT body_id AS id FROM vault_catalog_events WHERE body_id IN (SELECT value FROM json_each(?))`,
			ids, ids,
		).toArray().map((row) => row.id));
	}

	/** Attachment operation ids (of `operationIds`) that are already committed. */
	committedAttachmentOperationIds(operationIds: readonly string[]): Set<string> {
		this.initialize();
		if (operationIds.length === 0) return new Set();
		const ids = JSON.stringify(operationIds);
		return new Set(this.storage.sql.exec<{ id: string }>(
			`SELECT operation_id AS id FROM vault_attachment_operations WHERE operation_id IN (SELECT value FROM json_each(?))
			 UNION SELECT operation_id AS id FROM vault_attachment_catalog_events WHERE operation_id IN (SELECT value FROM json_each(?))`,
			ids, ids,
		).toArray().map((row) => row.id));
	}

	/**
	 * W2 bulk create: one transaction, one sequence. Per file: a finished
	 * checkpoint (chunked at SQLITE_BLOB_CHUNK_BYTES) + manifest, a body head and
	 * one catalog event. Per batch: one root journal row + root head, one clock
	 * advance (none in lean mode: the root journal row carries the sequence), one
	 * attribution row and one receipt row. Bodies need no journal row: a
	 * reconstruct reads checkpoint + journal rows after it.
	 */
	commitBulkCreate(input: {
		batchId: string;
		requestDigest: string;
		rootUpdate: Uint8Array;
		expectedRootHead: { generation: number; semanticEpoch: SemanticEpoch; latestSequence: number };
		files: BulkCreateFileWrite[];
		attachments: BulkCreateAttachmentWrite[];
		actor: VaultActorContext;
		/** JSON-serialisable per-item outcomes; stored verbatim for idempotent replay. */
		outcomes: unknown;
		now?: number;
	}): DurableCommitResult {
		const commitStartedAt = performance.now();
		if (input.rootUpdate.byteLength === 0 || input.rootUpdate.byteLength > MAX_DURABLE_UPDATE_BYTES) {
			throw new Error("bulk create root update exceeds durable value limit");
		}
		if (!/^[a-f0-9]{64}$/.test(input.requestDigest)) throw new Error("invalid bulk create request digest");
		this.ensureBulkCreateReceipts();
		const now = input.now ?? Date.now();
		const ingressBytes = input.files.reduce((sum, file) => sum + file.state.byteLength, input.rootUpdate.byteLength);
		let rowsRead = 0;
		let rowsWritten = 0;
		let sequence = 0;
		const generation = input.expectedRootHead.generation + 1;
		const semanticEpoch = input.expectedRootHead.semanticEpoch;
		const exec = (sql: string, ...bindings: unknown[]): void => {
			const cursor = this.storage.sql.exec(sql, ...bindings);
			cursor.toArray();
			rowsRead += cursor.rowsRead;
			rowsWritten += cursor.rowsWritten;
		};
		this.storage.transactionSync(() => {
			this.assertActorCurrent(input.actor);
			if (this.recoveryMutexHeld(now)) throw new Error("recovery_boundary_in_progress");
			const head = this.storage.sql.exec<{ generation: number; semantic_epoch: number; latest_sequence: number }>(
				"SELECT generation, semantic_epoch, latest_sequence FROM vault_document_heads WHERE document_id = 'root'",
			).toArray()[0];
			if (!head || head.generation !== input.expectedRootHead.generation
				|| head.semantic_epoch !== input.expectedRootHead.semanticEpoch
				|| head.latest_sequence !== input.expectedRootHead.latestSequence) {
				throw new Error("document_head_changed");
			}
			if (this.storage.sql.exec("SELECT 1 FROM vault_bulk_create_receipts WHERE batch_id = ?", input.batchId).toArray()[0]) {
				throw new Error("bulk_create_batch_exists");
			}
			const bodyIds = input.files.map((file) => file.bodyId);
			if (new Set(bodyIds).size !== bodyIds.length || this.existingBodyIds(bodyIds).size > 0) {
				throw new Error("bulk_create_body_exists");
			}
			const paths = input.files.map((file) => file.path);
			if (new Set(paths).size !== paths.length || this.activeCatalogHeadsAtPaths(paths).size > 0) {
				throw new Error("active_path_conflict");
			}
			if (this.leanRowsEnabled) {
				// Lean (§6.4): the root journal row below carries the sequence, as relay appends do.
				// Relay3: leanNextSequence() also takes the relay_body_tail head, so a bulk sequence never
				// reuses a sequence already handed to a tail record (group commits write no journal row).
				const next = this.leanNextSequence();
				sequence = next.sequence;
				rowsRead += next.rowsRead;
			} else {
				const clock = this.storage.sql.exec<{ sequence: number }>(this.clockAdvanceSql());
				sequence = clock.one().sequence;
				rowsWritten += clock.rowsWritten;
			}
			exec(`INSERT INTO vault_journal(sequence, document_id, generation, semantic_epoch, kind,
			 update_byte_length, data, created_at) VALUES (?, 'root', ?, ?, 'create', ?, ?, ?)`,
			sequence, generation, semanticEpoch, input.rootUpdate.byteLength, input.rootUpdate.slice().buffer, now);
			exec(`UPDATE vault_document_heads SET generation = ?, latest_sequence = ? WHERE document_id = 'root'`,
				generation, sequence);
			exec(`INSERT INTO vault_mutation_attribution(
			 sequence, mutation_index, principal_id, membership_revision, device_id,
			 device_credential_revision, operation_id, request_digest
			) VALUES (?, 0, ?, ?, ?, ?, ?, ?)`, sequence, input.actor.principalId, input.actor.membershipRevision,
			input.actor.deviceId, input.actor.deviceCredentialRevision, input.batchId, input.requestDigest);
			// Set-based writes (write-budget int-bulk, CPU): the same rows as one INSERT per row, in
			// a handful of statements per batch instead of four per note. Blob chunks go as multi-row
			// VALUES (?1 = sequence, 5 parameters per chunk, <= 96 bound parameters per statement); the
			// blob-free rows go as one JSON array parameter through json_each, split so the parameter
			// stays far below the 2 MB SQLite value limit (paths may be up to 16 KiB).
			const chunkRows: unknown[] = [];
			for (const file of input.files) {
				if (file.chunks.length === 0) throw new Error("bulk create body requires a checkpoint chunk");
				let offset = 0;
				for (const [chunkIndex, chunk] of file.chunks.entries()) {
					if (chunk.byteLength < 1 || chunk.byteLength > SQLITE_BLOB_CHUNK_BYTES) throw new Error("invalid bulk create chunk");
					const whole = offset === 0 && chunk.byteLength === file.state.byteLength
						&& file.state.byteOffset === 0 && file.state.byteLength === file.state.buffer.byteLength;
					chunkRows.push(file.bodyId, chunkIndex, chunk.byteLength, chunk.sha256,
						whole ? file.state.buffer : file.state.slice(offset, offset + chunk.byteLength).buffer);
					offset += chunk.byteLength;
				}
				if (offset !== file.state.byteLength) throw new Error("bulk create chunks do not cover the state");
			}
			for (let start = 0; start < chunkRows.length; start += BULK_CHUNK_ROWS_PER_STATEMENT * 5) {
				const rows = chunkRows.slice(start, start + BULK_CHUNK_ROWS_PER_STATEMENT * 5);
				const values = Array.from({ length: rows.length / 5 }, (_value, row) => {
					const base = 2 + row * 5;
					return `(?${base}, ?1, 1, 1, ?${base + 1}, ?${base + 2}, ?${base + 3}, ?${base + 4})`;
				}).join(", ");
				exec(`INSERT INTO vault_checkpoints(document_id, checkpoint_sequence, generation, semantic_epoch,
				 chunk_index, chunk_byte_length, chunk_sha256, data) VALUES ${values}`, sequence, ...rows);
			}
			const jsonRows = (sql: string, rows: unknown[][]): void => {
				let parts: string[] = [];
				let length = 0;
				const flush = (): void => {
					if (parts.length === 0) return;
					exec(sql, sequence, now, `[${parts.join(",")}]`);
					parts = [];
					length = 0;
				};
				for (const row of rows) {
					const text = JSON.stringify(row);
					if (length + text.length > BULK_JSON_PARAMETER_CHARS) flush();
					parts.push(text);
					length += text.length + 1;
				}
				flush();
			};
			jsonRows(`INSERT INTO vault_checkpoint_manifests(document_id, checkpoint_sequence, generation,
			 semantic_epoch, chunk_count, total_byte_length, state_sha256, complete, created_at)
			 SELECT json_extract(value, '$[0]'), ?1, 1, 1, json_extract(value, '$[1]'), json_extract(value, '$[2]'),
			        json_extract(value, '$[3]'), 1, ?2
			 FROM json_each(?3)`,
			input.files.map((file) => [file.bodyId, file.chunks.length, file.state.byteLength, file.stateSha256]));
			jsonRows(`INSERT INTO vault_document_heads(document_id, generation, semantic_epoch, latest_sequence)
			 SELECT json_extract(value, '$[0]'), 1, 1, ?1 FROM json_each(?3)`,
			input.files.map((file) => [file.bodyId]));
			jsonRows(`INSERT INTO vault_catalog_events(
			 sequence, body_id, file_id, path, previous_path, lifecycle, generation, body_epoch,
			 content_hash, size, mutation_index
			) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[0]'), json_extract(value, '$[1]'), NULL,
			         'active', 1, 1, json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]')
			  FROM json_each(?3)`,
			input.files.map((file, mutationIndex) => [file.bodyId, file.path, file.contentHash, file.size, mutationIndex]));
			jsonRows(`INSERT INTO vault_attachment_catalog_events(
			 sequence, path, content_hash, size, mime, lifecycle, operation_id
			) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
			         json_extract(value, '$[3]'), 'active', json_extract(value, '$[4]')
			  FROM json_each(?3)`,
			input.attachments.map((item) => [item.path, item.hash, item.size, item.mime, item.operationId]));
			exec(`INSERT INTO vault_bulk_create_receipts(batch_id, request_digest, vault_sequence, root_generation,
			 root_epoch, outcomes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			input.batchId, input.requestDigest, sequence, generation, semanticEpoch, JSON.stringify(input.outcomes), now);
		});
		this.observeCommit({ documentId: "root", ingressBytes, commitLatencyMs: performance.now() - commitStartedAt,
			vaultSequence: sequence });
		return { vaultSequence: sequence, documentId: "root", generation, semanticEpoch, kind: "create", rowsRead, rowsWritten };
	}
}
