import * as Y from "yjs";
import { SCHEMA_VERSION, STORAGE_FORMAT_VERSION } from "./shared/productVersions";
import { isCanonicalVaultId } from "./vaultId";
import { MAX_DURABLE_UPDATE_BYTES } from "./contracts";
import { RecoveryAuthorityStore } from "./recoveryAuthorityStore";
import {
	MAX_CANDIDATE_RECEIPTS_PER_BODY,
	type AttachmentCatalogEvent,
	type CatalogMutation,
	type DurableCandidateReceipt,
	type DurableLifecycleRecord,
} from "./vaultCatalogStore";
import type {
	DurableCommitResult,
	VaultCommitKind,
	VaultProvisioningResult,
} from "./vaultDocumentStore";

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
} from "./vaultCatalogStore";
export { isValidOperationId } from "./vaultBootstrapStore";
export type {
	ContentObjectRecord,
	HistoryPin,
	HistoryPinHealth,
	HistoryPinKind,
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
		this.initialize();
		if (this.activePins(now).length > 0) throw new Error("active_state_reset_blocked_by_history_pin");
		this.storage.transactionSync(() => {
			for (const table of [
				"vault_restore_entries",
				"vault_lifecycle_publications",
				"vault_lifecycle_receipts",
				"vault_creation_candidates",
				"vault_candidate_receipts",
				"vault_attachment_catalog_events",
				"vault_catalog_events",
				"vault_checkpoints",
				"vault_journal_chunks",
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
				"INSERT INTO vault_journal(sequence, document_id, generation, kind, update_byte_length, created_at) VALUES (1, 'root', 1, 'root', ?, ?)",
				rootUpdate.byteLength,
				now,
			).toArray();
			this.insertJournalChunks(1, rootUpdate);
			this.storage.sql.exec(
				"INSERT INTO vault_document_heads(document_id, generation, latest_sequence) VALUES ('root', 1, 1)",
			).toArray();
		});
	}

	commitCandidate(input: {
		catalog?: CatalogMutation;
		bodyId: string;
		clientId: string;
		candidateId: string;
		candidateDigest: string;
		update: Uint8Array;
		vaultGeneration: string;
		runtimeEpoch: string;
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
		const reconstructed = this.reconstructDocument(input.bodyId);
		let changed = false;
		const observe = () => { changed = true; };
		reconstructed.doc.on("update", observe);
		try {
			Y.applyUpdate(reconstructed.doc, input.update, "candidate-coverage-check");
		} finally {
			reconstructed.doc.off("update", observe);
			reconstructed.doc.destroy();
		}
		const commit = changed
			? this.commitUpdate({ documentId: input.bodyId, update: input.update, kind: "body", catalog: input.catalog, now: input.now })
			: {
				vaultSequence: this.documentHead(input.bodyId)?.latestSequence ?? 0,
				generation: this.documentHead(input.bodyId)?.generation ?? 0,
			};
		if (commit.generation <= 0) throw new Error("body state is missing");
		const receipt: DurableCandidateReceipt = {
			bodyId: input.bodyId,
			clientId: input.clientId,
			candidateId: input.candidateId,
			candidateDigest: input.candidateDigest,
			durableGeneration: commit.generation,
			vaultSequence: commit.vaultSequence,
			vaultGeneration: input.vaultGeneration,
			runtimeEpoch: input.runtimeEpoch,
		};
		this.storage.sql.exec(
			`INSERT INTO vault_candidate_receipts(
			 body_id, client_id, candidate_id, candidate_digest, durable_generation,
			 vault_sequence, runtime_epoch, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			receipt.bodyId,
			receipt.clientId,
			receipt.candidateId,
			receipt.candidateDigest,
			receipt.durableGeneration,
			receipt.vaultSequence,
			receipt.runtimeEpoch,
			now,
		).toArray();
		return receipt;
	}

	commitUpdate(input: {
		documentId: string;
		update: Uint8Array;
		kind: VaultCommitKind;
		catalog?: CatalogMutation | CatalogMutation[];
		lifecycleReceipt?: Omit<DurableLifecycleRecord, "vaultSequence" | "rootGeneration">;
		lifecycleReceipts?: Array<Omit<DurableLifecycleRecord, "vaultSequence" | "rootGeneration">>;
		completeCreation?: { bodyId: string; candidateId: string; candidateDigest: string };
		completeCreations?: Array<{ bodyId: string; candidateId: string; candidateDigest: string }>;
		rootPublications?: Array<{ operationId: string; lifecycleSequence: number; vaultGeneration: string; runtimeEpoch: string }>;
		attachmentCatalog?: Array<Omit<AttachmentCatalogEvent, "sequence"> & { operationId: string }>;
		provisioning?: { vaultId: string; vaultGeneration: string; provisionedAt: number };
		now?: number;
	}): DurableCommitResult {
		this.initialize();
		if (!input.documentId) throw new Error("documentId is required");
		if (input.update.byteLength === 0) throw new Error("empty semantic update is not a commit");
		if (input.update.byteLength > MAX_DURABLE_UPDATE_BYTES) {
			throw new Error("semantic update exceeds durable value limit");
		}
		const now = input.now ?? Date.now();
		for (const receipt of [input.lifecycleReceipt, ...(input.lifecycleReceipts ?? [])]) {
			if (receipt) this.assertVaultGeneration(receipt.vaultGeneration);
		}
		for (const publication of input.rootPublications ?? []) this.assertVaultGeneration(publication.vaultGeneration);
		if ((input.lifecycleReceipt || input.lifecycleReceipts || input.completeCreation
			|| input.completeCreations || input.rootPublications || input.attachmentCatalog) && input.documentId !== "root") {
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
		this.storage.transactionSync(() => {
			const head = this.storage.sql.exec<{ generation: number }>(
				"SELECT generation FROM vault_document_heads WHERE document_id = ?",
				input.documentId,
			);
			generation = (head.toArray()[0]?.generation ?? 0) + 1;
			rowsRead += head.rowsRead;
			const clock = this.storage.sql.exec<{ sequence: number }>(
				"UPDATE vault_clock SET sequence = sequence + 1 WHERE id = 1 RETURNING sequence",
			);
			sequence = clock.one().sequence;
			rowsWritten += clock.rowsWritten;
			const journal = this.storage.sql.exec(
				`INSERT INTO vault_journal(sequence, document_id, generation, kind, update_byte_length, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				sequence,
				input.documentId,
				generation,
				input.kind,
				input.update.byteLength,
				now,
			);
			journal.toArray();
			rowsWritten += journal.rowsWritten;
			rowsWritten += this.insertJournalChunks(sequence, input.update);
			const writeHead = this.storage.sql.exec(
				`INSERT INTO vault_document_heads(document_id, generation, latest_sequence)
				 VALUES (?, ?, ?)
				 ON CONFLICT(document_id) DO UPDATE SET
				 generation = excluded.generation,
				 latest_sequence = excluded.latest_sequence`,
				input.documentId,
				generation,
				sequence,
			);
			writeHead.toArray();
			rowsWritten += writeHead.rowsWritten;
			const mutations = input.catalog
				? (Array.isArray(input.catalog) ? input.catalog : [input.catalog])
				: [];
			this.assertCatalogPathUniqueness(mutations, sequence - 1);
			for (const [mutationIndex, mutation] of mutations.entries()) {
				const catalog = this.storage.sql.exec(
					`INSERT INTO vault_catalog_events(
					 sequence, body_id, file_id, path, previous_path, lifecycle, generation,
					 content_hash, size, mutation_index
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					sequence,
					mutation.bodyId,
					mutation.fileId,
					mutation.path,
					mutation.previousPath ?? null,
					mutation.lifecycle,
					mutation.bodyGeneration,
					mutation.contentHash ?? null,
					mutation.size ?? null,
					mutationIndex,
				);
				catalog.toArray();
				rowsWritten += catalog.rowsWritten;
			}
			for (const receipt of [
				...(input.lifecycleReceipt ? [input.lifecycleReceipt] : []),
				...(input.lifecycleReceipts ?? []),
			]) {
				const lifecycle = this.storage.sql.exec(
					`INSERT INTO vault_lifecycle_receipts(
					 operation_id, kind, body_id, file_id, durable_generation,
					 vault_sequence, runtime_epoch, candidate_id, candidate_digest,
					 source_path, result_path, result_lifecycle, root_generation, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					receipt.operationId,
					receipt.kind,
					receipt.bodyId,
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
					 operation_id, lifecycle_sequence, root_sequence, root_generation, runtime_epoch, created_at
					) VALUES (?, ?, ?, ?, ?, ?)`,
					publication.operationId,
					publication.lifecycleSequence,
					sequence,
					generation,
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
		return { vaultSequence: sequence, documentId: input.documentId, generation, kind: input.kind, rowsRead, rowsWritten };
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
		rootPublications?: Array<{ operationId: string; lifecycleSequence: number; vaultGeneration: string; runtimeEpoch: string }>;
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
			now: input.now,
		});
	}

	commitRootAttachments(rootUpdate: Uint8Array, events: Array<Omit<AttachmentCatalogEvent, "sequence"> & { operationId: string }>, now = Date.now()): DurableCommitResult {
		if (events.length === 0) throw new Error("attachment publication requires an event");
		return this.commitUpdate({ documentId: "root", update: rootUpdate, kind: "blob", attachmentCatalog: events, now });
	}
}
