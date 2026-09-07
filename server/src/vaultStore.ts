import * as Y from "yjs";
import { PROTOCOL_VERSION, SCHEMA_VERSION, STORAGE_FORMAT_VERSION } from "./shared/productVersions";
import { isCanonicalVaultId } from "./vaultId";
import { MAX_DURABLE_UPDATE_BYTES } from "./contracts";
import { RecoveryAuthorityStore } from "./recoveryAuthorityStore";
import {
	CANDIDATE_RECEIPT_TTL_MS,
	MAX_CANDIDATE_RECEIPTS_PER_BODY,
	type AttachmentCatalogEvent,
	type CatalogMutation,
	type DurableCandidateReceipt,
	type DurableLifecycleRecord,
} from "./vaultCatalogStore";
import type {
	DurableCommitResult,
	VaultAuthoritySubjectChange,
	VaultCollaborationMigrationReceipt,
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
	migrateCollaboration(input: {
		migrationId: string;
		vaultId: string;
		vaultGeneration: string;
		requestDigest: string;
		subjectDigest: string;
		ownerPrincipalId: string;
		subjects: VaultAuthoritySubjectChange[];
		now?: number;
	}): VaultCollaborationMigrationReceipt {
		this.initialize();
		const existing = this.collaborationMigrationReceipt(input.migrationId);
		if (existing) {
			if (existing.vaultId !== input.vaultId
				|| existing.vaultGeneration !== input.vaultGeneration
				|| existing.requestDigest !== input.requestDigest
				|| existing.subjectDigest !== input.subjectDigest) {
				throw new Error("collaboration_migration_identity_mismatch");
			}
			return existing;
		}
		const metadata = this.storedVaultMetadata();
		if (!metadata || metadata.vaultId !== input.vaultId
			|| metadata.vaultGeneration !== input.vaultGeneration) {
			throw new Error("vault generation mismatch");
		}
		if (metadata.schemaVersion !== 6 || metadata.storageFormatVersion !== STORAGE_FORMAT_VERSION) {
			throw new Error("collaboration_migration_source_mismatch");
		}
		if (!input.migrationId || !/^[A-Za-z0-9_-]{1,128}$/.test(input.migrationId)
			|| !/^[a-f0-9]{64}$/.test(input.requestDigest)
			|| !/^[a-f0-9]{64}$/.test(input.subjectDigest)
			|| !input.ownerPrincipalId) {
			throw new Error("invalid_collaboration_migration");
		}
		const owner = input.subjects.find((subject) => !("deviceId" in subject)
			&& subject.principalId === input.ownerPrincipalId && subject.role === "owner" && subject.state === "active");
		const activeOwners = input.subjects.filter((subject) => !("deviceId" in subject)
			&& subject.role === "owner" && subject.state === "active");
		if (!owner || activeOwners.length !== 1) throw new Error("owner_invariant");
		const principals = new Set(input.subjects.filter((subject) => !("deviceId" in subject))
			.map((subject) => subject.principalId));
		const devices = input.subjects.filter((subject) => "deviceId" in subject);
		if (devices.length === 0 || devices.some((device) => !principals.has(device.principalId))) {
			throw new Error("device_principal_missing");
		}
		for (const principalId of principals) {
			if (!devices.some((device) => device.principalId === principalId && device.state === "active")) {
				throw new Error("active_membership_without_device");
			}
		}

		const reconstructed = this.reconstructDocument("root");
		const stateVector = Y.encodeStateVector(reconstructed.doc);
		const system = reconstructed.doc.getMap("sys");
		system.set("schemaVersion", SCHEMA_VERSION);
		system.set("protocolVersion", PROTOCOL_VERSION);
		system.set("historyAttribution", "legacy_unattributed");
		const rootUpdate = Y.encodeStateAsUpdate(reconstructed.doc, stateVector);
		reconstructed.doc.destroy();
		if (rootUpdate.byteLength === 0) throw new Error("collaboration_migration_root_unchanged");

		const installedAt = input.now ?? Date.now();
		let rootSequence = 0;
		let settingsEnvironmentCount = 0;
		this.storage.transactionSync(() => {
			if (this.storage.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM vault_principal_authority",
			).one().count !== 0 || this.storage.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM vault_device_authority",
			).one().count !== 0) {
				throw new Error("collaboration_migration_partial_authority");
			}
			const rootHead = this.storage.sql.exec<{ generation: number }>(
				"SELECT generation FROM vault_document_heads WHERE document_id = 'root'",
			).toArray()[0];
			if (!rootHead) throw new Error("collaboration_migration_root_missing");
			rootSequence = this.storage.sql.exec<{ sequence: number }>(
				"UPDATE vault_clock SET sequence = sequence + 1 WHERE id = 1 RETURNING sequence",
			).one().sequence;
			const rootGeneration = rootHead.generation + 1;
			this.storage.sql.exec(
				`INSERT INTO vault_journal(sequence, document_id, generation, kind, update_byte_length, created_at)
				 VALUES (?, 'root', ?, 'root', ?, ?)`,
				rootSequence, rootGeneration, rootUpdate.byteLength, installedAt,
			).toArray();
			this.insertJournalChunks(rootSequence, rootUpdate);
			this.storage.sql.exec(
				"UPDATE vault_document_heads SET generation = ?, latest_sequence = ? WHERE document_id = 'root'",
				rootGeneration, rootSequence,
			).toArray();

			for (const subject of input.subjects) {
				if ("deviceId" in subject) {
					this.storage.sql.exec(`INSERT INTO vault_device_authority(
					 device_id, principal_id, state, credential_revision, change_id
					) VALUES (?, ?, ?, ?, ?)`, subject.deviceId, subject.principalId,
					subject.state, subject.credentialRevision, input.migrationId).toArray();
				} else {
					this.storage.sql.exec(`INSERT INTO vault_principal_authority(
					 principal_id, role, state, membership_revision, policy_version,
					 capability_digest, display_name, color_seed, change_id
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, subject.principalId, subject.role,
					subject.state, subject.membershipRevision, subject.policyVersion,
					subject.capabilityDigest, subject.displayName, subject.colorSeed,
					input.migrationId).toArray();
				}
			}

			const hasSettings = this.storage.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'settings_env'",
			).one().count > 0;
			if (hasSettings) {
				const keys = this.storage.sql.exec<{ config_key: string }>(
					"SELECT config_key FROM settings_env",
				).toArray();
				if (keys.some((row) => row.config_key.startsWith("\u0001"))) {
					throw new Error("collaboration_migration_settings_already_scoped");
				}
				settingsEnvironmentCount = keys.length;
				const prefix = `\u0001${input.ownerPrincipalId}\0`;
				for (const table of ["settings_env", "settings_files", "settings_intents", "settings_themes",
					"settings_tombstones", "settings_plugin_data", "settings_mutation_attribution"]) {
					const exists = this.storage.sql.exec<{ count: number }>(
						"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?", table,
					).one().count > 0;
					if (exists) this.storage.sql.exec(`UPDATE ${table} SET config_key = ? || config_key`, prefix).toArray();
				}
			}

			this.storage.sql.exec("DROP TABLE vault_meta").toArray();
			this.storage.sql.exec(`CREATE TABLE vault_meta (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				vault_id TEXT NOT NULL,
				vault_generation TEXT NOT NULL,
				schema_version INTEGER NOT NULL CHECK(schema_version = 7),
				storage_format_version INTEGER NOT NULL CHECK(storage_format_version = 3),
				provisioned_at INTEGER NOT NULL
			)`).toArray();
			this.storage.sql.exec(
				`INSERT INTO vault_meta(id, vault_id, vault_generation, schema_version,
				 storage_format_version, provisioned_at) VALUES (1, ?, ?, ?, ?, ?)`,
				metadata.vaultId, metadata.vaultGeneration, SCHEMA_VERSION,
				STORAGE_FORMAT_VERSION, metadata.provisionedAt,
			).toArray();
			this.storage.sql.exec(`INSERT INTO vault_authorization_change_receipts(
				change_id, vault_id, vault_generation, subject_digest, installed_at
			) VALUES (?, ?, ?, ?, ?)`, input.migrationId, input.vaultId,
			input.vaultGeneration, input.subjectDigest, installedAt).toArray();
			this.storage.sql.exec(`INSERT INTO vault_collaboration_migration_receipts(
				migration_id, vault_id, vault_generation, request_digest, subject_digest,
				root_sequence, settings_assignment, settings_environment_count,
				history_attribution, installed_at
			) VALUES (?, ?, ?, ?, ?, ?, 'owner_principal_scoped', ?, 'legacy_unattributed', ?)`,
			input.migrationId, input.vaultId, input.vaultGeneration, input.requestDigest,
			input.subjectDigest, rootSequence, settingsEnvironmentCount, installedAt).toArray();
		});
		return {
			migrationId: input.migrationId,
			vaultId: input.vaultId,
			vaultGeneration: input.vaultGeneration,
			requestDigest: input.requestDigest,
			subjectDigest: input.subjectDigest,
			rootSequence,
			settingsAssignment: "owner_principal_scoped",
			settingsEnvironmentCount,
			historyAttribution: "legacy_unattributed",
			installedAt,
		};
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
		this.initialize();
		if (this.activePins(now).length > 0) throw new Error("active_state_reset_blocked_by_history_pin");
		this.storage.transactionSync(() => {
			for (const table of [
				"vault_restore_entries",
				"vault_operation_outcomes",
				"vault_mutation_attribution",
				"vault_lifecycle_publications",
				"vault_lifecycle_receipts",
				"vault_creation_candidates",
				"vault_candidate_receipts",
				"vault_attachment_operations",
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
		expectedHead: { generation: number; latestSequence: number } | null;
		changesState: boolean;
		vaultGeneration: string;
		runtimeEpoch: string;
		actor: { principalId: string; membershipRevision: number; deviceId: string; deviceCredentialRevision: number };
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
			|| currentHead?.latestSequence !== input.expectedHead?.latestSequence) {
			throw new Error("candidate_generation_fence_changed");
		}
		const commit = input.changesState
			? this.commitUpdate({ documentId: input.bodyId, update: input.update, kind: "body", catalog: input.catalog, now: input.now,
				actorAttributions: [{ actor: input.actor, operationId: input.candidateId, requestDigest: input.candidateDigest }] })
			: {
				vaultSequence: currentHead?.latestSequence ?? 0,
				generation: currentHead?.generation ?? 0,
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
		this.storage.transactionSync(() => {
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
		});
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
		actorAttributions?: Array<{
			actor: { principalId: string; membershipRevision: number; deviceId: string; deviceCredentialRevision: number };
			operationId?: string;
			requestDigest?: string;
		}>;
		attachmentCatalog?: Array<Omit<AttachmentCatalogEvent, "sequence"> & { operationId: string }>;
		attachmentOperation?: { operationId: string; requestDigest: string };
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
			if (input.attachmentOperation) {
				const inserted = this.storage.sql.exec(
					`INSERT INTO vault_attachment_operations(
					 operation_id, request_digest, root_sequence, root_generation, created_at
					 ) VALUES (?, ?, ?, ?, ?)`,
					input.attachmentOperation.operationId,
					input.attachmentOperation.requestDigest,
					sequence,
					generation,
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
		actorAttributions?: Array<{
			actor: { principalId: string; membershipRevision: number; deviceId: string; deviceCredentialRevision: number };
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
		operation: { operationId: string; requestDigest: string },
		now = Date.now(),
		actorAttributions: Array<{
			actor: { principalId: string; membershipRevision: number; deviceId: string; deviceCredentialRevision: number };
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
		return this.commitUpdate({ documentId: "root", update: rootUpdate, kind: "blob", attachmentCatalog: events,
			attachmentOperation: operation, actorAttributions, now });
	}
}
