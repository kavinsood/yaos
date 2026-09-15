import { SCHEMA_VERSION, STORAGE_FORMAT_VERSION } from "./shared/productVersions";
import { isCanonicalVaultId } from "./vaultId";
import { MAX_DURABLE_UPDATE_BYTES } from "./contracts";
import { INITIAL_SEMANTIC_EPOCH, parseSemanticEpoch, type SemanticEpoch } from "./shared/semanticEpoch";
import { RecoveryAuthorityStore } from "./recoveryAuthorityStore";
import type { VaultActorContext } from "./collaboration";
import {
	CANDIDATE_RECEIPT_TTL_MS,
	MAX_CANDIDATE_RECEIPTS_PER_BODY,
	type AttachmentCatalogEvent,
	type CatalogMutation,
	type ExcalidrawCatalogMutation,
	type SemanticCatalogMutation,
	type SemanticCatalogHead,
	type SemanticCandidateReceipt,
	type SemanticLifecycleReceipt,
	type DurableCandidateReceipt,
	type DurableLifecycleRecord,
} from "./vaultCatalogStore";
import type {
	DurableCommitResult,
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
export type {
	AttachmentCatalogEvent,
	BodyLifecycle,
	CatalogDeltaEntry,
	CatalogHeadAtBoundary,
	CatalogMutation,
	ExcalidrawCatalogHead,
	ExcalidrawCatalogMutation,
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
				"UPDATE vault_clock SET sequence = sequence + 1 WHERE id = 1 RETURNING sequence").one().sequence;
			documentGeneration = 1;
			this.storage.sql.exec(`INSERT INTO vault_journal(
			 sequence, document_id, generation, semantic_epoch, kind, update_byte_length, data, created_at)
			 VALUES (?, ?, ?, ?, 'semantic-promote', ?, ?, ?)`, documentSequence, input.documentId,
				documentGeneration, INITIAL_SEMANTIC_EPOCH, input.semanticUpdate.byteLength,
				ownedUpdate(input.semanticUpdate), now).toArray();
			this.storage.sql.exec(`INSERT INTO vault_document_heads(document_id, generation, semantic_epoch, latest_sequence)
			 VALUES (?, ?, ?, ?)`, input.documentId, documentGeneration, INITIAL_SEMANTIC_EPOCH, documentSequence).toArray();

			rootSequence = this.storage.sql.exec<{ sequence: number }>(
				"UPDATE vault_clock SET sequence = sequence + 1 WHERE id = 1 RETURNING sequence").one().sequence;
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
				"UPDATE vault_clock SET sequence = sequence + 1 WHERE id = 1 RETURNING sequence").one().sequence;
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
		if (rootUpdate.byteLength === 0 || rootUpdate.byteLength > MAX_DURABLE_UPDATE_BYTES) {
			throw new Error("root update exceeds durable value limit");
		}
		this.initialize();
		if (this.activePins(now).length > 0) throw new Error("active_state_reset_blocked_by_history_pin");
		this.storage.transactionSync(() => {
			for (const table of [
				"vault_excalidraw_finalize_receipts",
				"vault_excalidraw_permits",
				"vault_excalidraw_drawings",
				"vault_excalidraw_prepares",
				"vault_restore_entries",
				"vault_operation_outcomes",
				"vault_mutation_attribution",
				"vault_lifecycle_publications",
				"vault_lifecycle_receipts",
				"vault_creation_candidates",
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
	}

	commitCandidate(input: {
		catalog?: CatalogMutation;
		bodyId: string;
		clientId: string;
		candidateId: string;
		candidateDigest: string;
		bodyEpoch: SemanticEpoch;
		update: Uint8Array;
		expectedHead: { generation: number; semanticEpoch: SemanticEpoch; latestSequence: number } | null;
		changesState: boolean;
		vaultGeneration: string;
		runtimeEpoch: string;
		actor: VaultActorContext;
		now?: number;
	}): DurableCandidateReceipt {
		if (input.update.byteLength === 0 || input.update.byteLength > MAX_DURABLE_UPDATE_BYTES) {
			throw new Error("candidate update exceeds durable value limit");
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
		const currentHead = this.documentHead(input.bodyId);
		if (currentHead?.generation !== input.expectedHead?.generation
			|| currentHead?.semanticEpoch !== input.expectedHead?.semanticEpoch
			|| currentHead?.latestSequence !== input.expectedHead?.latestSequence) {
			throw new Error("candidate_generation_fence_changed");
		}
		if (currentHead?.semanticEpoch !== parseSemanticEpoch(input.bodyEpoch, "candidate body epoch")) {
			throw new Error("candidate_semantic_epoch_fence_changed");
		}
		const commit = input.changesState
			? this.commitUpdate({ documentId: input.bodyId, update: input.update, kind: "body", expectedHead: input.expectedHead,
				catalog: input.catalog, now: input.now,
				actorAttributions: [{ actor: input.actor, operationId: input.candidateId, requestDigest: input.candidateDigest }] })
			: {
				vaultSequence: currentHead?.latestSequence ?? 0,
				generation: currentHead?.generation ?? 0,
				semanticEpoch: currentHead?.semanticEpoch ?? input.bodyEpoch,
			};
		if (commit.generation <= 0) throw new Error("body state is missing");
		const receipt: DurableCandidateReceipt = {
			bodyId: input.bodyId,
			clientId: input.clientId,
			candidateId: input.candidateId,
			candidateDigest: input.candidateDigest,
			bodyEpoch: commit.semanticEpoch,
			durableGeneration: commit.generation,
			vaultSequence: commit.vaultSequence,
			vaultGeneration: input.vaultGeneration,
			runtimeEpoch: input.runtimeEpoch,
		};
		this.storage.transactionSync(() => {
			this.assertActorCurrent(input.actor);
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
		excalidrawCatalog?: ExcalidrawCatalogMutation;
		semanticCandidateReceipt?: Omit<SemanticCandidateReceipt, "vaultSequence">;
		semanticLifecycleReceipt?: Omit<SemanticLifecycleReceipt, "vaultSequence" | "rootGeneration">;
		excalidrawLifecycleReceipt?: Omit<SemanticLifecycleReceipt, "vaultSequence" | "rootGeneration">;
		lifecycleReceipt?: Omit<DurableLifecycleRecord, "vaultSequence" | "rootGeneration">;
		lifecycleReceipts?: Array<Omit<DurableLifecycleRecord, "vaultSequence" | "rootGeneration">>;
		completeCreation?: { bodyId: string; candidateId: string; candidateDigest: string };
		completeCreations?: Array<{ bodyId: string; candidateId: string; candidateDigest: string }>;
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
			if ((input.lifecycleReceipt || input.lifecycleReceipts || input.completeCreation
				|| input.excalidrawLifecycleReceipt
				|| input.completeCreations || input.rootPublications || input.attachmentCatalog || input.attachmentOperation) && input.documentId !== "root") {
			throw new Error("root publication metadata must commit through root");
		}
		if (input.completeCreation && !input.lifecycleReceipt) {
			throw new Error("creation fence completion requires an atomic lifecycle receipt");
		}
		if (input.completeCreations && input.completeCreations.length !== (input.lifecycleReceipts?.length ?? 0)) {
			throw new Error("creation fence batch requires matching atomic lifecycle receipts");
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
				"UPDATE vault_clock SET sequence = sequence + 1 WHERE id = 1 RETURNING sequence",
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
			if (input.excalidrawCatalog) {
				const mutation = input.excalidrawCatalog;
				const catalog = this.storage.sql.exec(`INSERT INTO vault_semantic_catalog_events(
				 sequence, document_id, file_id, kind, format, format_version, path, previous_path,
				 lifecycle, generation, document_epoch, content_hash, size, mutation_index
				) VALUES (?, ?, ?, 'excalidraw', 'excalidraw-native', 1, ?, ?, ?, ?, ?, ?, ?, 0)`,
				sequence, mutation.documentId, mutation.fileId, mutation.path, mutation.previousPath,
				mutation.lifecycle, mutation.documentGeneration, mutation.documentEpoch,
				mutation.contentHash ?? null, mutation.size ?? null);
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
				if (input.excalidrawLifecycleReceipt) {
					const receipt = input.excalidrawLifecycleReceipt;
					this.assertVaultGeneration(receipt.vaultGeneration);
					if (input.documentId !== "root" || semanticEpoch !== receipt.rootEpoch) {
						throw new Error("excalidraw_lifecycle_root_epoch_changed");
					}
					this.storage.sql.exec(`INSERT INTO vault_semantic_lifecycle_receipts(
						operation_id, request_digest, document_id, file_id, kind, result_path, result_lifecycle,
						durable_generation, body_epoch, vault_sequence, root_generation, root_epoch, runtime_epoch, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, receipt.operationId, receipt.requestDigest,
						receipt.documentId, receipt.fileId, receipt.kind, receipt.resultPath, receipt.resultLifecycle,
						receipt.durableGeneration, receipt.bodyEpoch, sequence, generation, receipt.rootEpoch,
						receipt.runtimeEpoch, now).toArray();
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
			for (const creation of [
				...(input.completeCreation ? [input.completeCreation] : []),
				...(input.completeCreations ?? []),
			]) {
				const completed = this.storage.sql.exec(
					`DELETE FROM vault_creation_candidates
					 WHERE body_id = ? AND candidate_id = ? AND candidate_digest = ?`,
					creation.bodyId,
					creation.candidateId,
					creation.candidateDigest,
				);
				completed.toArray();
				rowsWritten += completed.rowsWritten;
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
		return { vaultSequence: sequence, documentId: input.documentId, generation, semanticEpoch, kind: input.kind, rowsRead, rowsWritten };
	}

	/** Record lifecycle/catalog events in the same sequence as their root update. */
	commitRootLifecycle(input: {
		rootUpdate: Uint8Array;
		kind: Extract<VaultCommitKind, "create" | "rename" | "delete" | "revive" | "lifecycle-batch">;
		catalog: CatalogMutation | CatalogMutation[];
		lifecycleReceipt?: Omit<DurableLifecycleRecord, "vaultSequence" | "rootGeneration">;
		lifecycleReceipts?: Array<Omit<DurableLifecycleRecord, "vaultSequence" | "rootGeneration">>;
		completeCreation?: { bodyId: string; candidateId: string; candidateDigest: string };
		completeCreations?: Array<{ bodyId: string; candidateId: string; candidateDigest: string }>;
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
			completeCreation: input.completeCreation,
			completeCreations: input.completeCreations,
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
}
