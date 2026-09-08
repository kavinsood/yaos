import * as Y from "yjs";
import { SCHEMA_VERSION, STORAGE_FORMAT_VERSION } from "./shared/productVersions";
import type { BodyLifecycle, CatalogHeadAtBoundary, SemanticCatalogHead } from "./vaultCatalogStore";
import type { HistoryPin } from "./vaultBootstrapStore";
import type { VaultActorContext, VaultRole } from "./collaboration";
import { SQLITE_ROW_SAFE_BYTES } from "./shared/durableLimits";

/**
 * Durable Object SQLite rows are limited to 2 MB. Durable updates are capped
 * below this value and therefore fit in one binary row. Checkpoints may be
 * larger and are split into independently bounded binary rows.
 */
export const SQLITE_BLOB_CHUNK_BYTES = SQLITE_ROW_SAFE_BYTES;
export type DurableChunkValue = ArrayBuffer;

interface SqlCursor<T> extends Iterable<T> {
	toArray(): T[];
	one(): T;
	rowsRead: number;
	rowsWritten: number;
}

interface SqlPort {
	exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): SqlCursor<T>;
}

export interface VaultStoragePort {
	sql: SqlPort;
	transactionSync<T>(closure: () => T): T;
}

export interface VaultMetadata {
	vaultId: string;
	vaultGeneration: string;
	schemaVersion: typeof SCHEMA_VERSION;
	storageFormatVersion: typeof STORAGE_FORMAT_VERSION;
	provisionedAt: number;
}

export interface VaultProvisioningResult extends VaultMetadata {
	created: boolean;
}

export type VaultCommitKind = "root" | "body" | "semantic" | "semantic-create" | "semantic-rename"
	| "semantic-delete" | "semantic-revive" | "semantic-promote" | "semantic-demote"
	| "create" | "rename" | "delete" | "revive"
	| "lifecycle-batch" | "blob" | "restore";

export interface DurableCommitResult {
	vaultSequence: number;
	documentId: string;
	generation: number;
	kind: VaultCommitKind;
	rowsRead: number;
	rowsWritten: number;
}

export interface ReconstructedDocument {
	documentId: string;
	throughSequence: number;
	generation: number;
	checkpointSequence: number;
	journalUpdates: number;
	doc: Y.Doc;
	rowsRead: number;
}

export interface JournalFeedEntry {
	sequence: number;
	documentId: string;
	generation: number;
	kind: VaultCommitKind;
	catalogs: CatalogHeadAtBoundary[];
	semanticCatalogs: SemanticCatalogHead[];
}

export interface JournalFeedPage {
	entries: JournalFeedEntry[];
	floor: number;
	highWater: number;
	resetRequired: boolean;
}

export interface VaultPrincipalAuthority {
	principalId: string;
	role: VaultRole;
	state: "active" | "revoked";
	membershipRevision: number;
	policyVersion: number;
	capabilityDigest: string;
	displayName: string;
	colorSeed: string;
	changeId: string;
}

export interface VaultDeviceAuthority {
	deviceId: string;
	principalId: string;
	state: "active" | "revoked";
	credentialRevision: number;
	changeId: string;
}

export type VaultAuthoritySubjectChange =
	| Omit<VaultPrincipalAuthority, "changeId">
	| Omit<VaultDeviceAuthority, "changeId">;

export interface VaultAuthorityFenceReceipt {
	changeId: string;
	vaultId: string;
	vaultGeneration: string;
	subjectDigest: string;
	installedAt: number;
}

export interface VaultCollaborationMigrationReceipt {
	migrationId: string;
	vaultId: string;
	vaultGeneration: string;
	requestDigest: string;
	subjectDigest: string;
	rootSequence: number;
	settingsAssignment: "owner_principal_scoped";
	settingsEnvironmentCount: number;
	historyAttribution: "legacy_unattributed";
	installedAt: number;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

export function decodeSqlChunks(rows: Iterable<{ data: DurableChunkValue }>): Uint8Array {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (const row of rows) {
		const chunk = new Uint8Array(row.data);
		chunks.push(chunk);
		total += chunk.byteLength;
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** Document metadata, journal, reconstruction, checkpoint, and feed storage. */
export abstract class VaultDocumentStore {
	private initialized = false;

	constructor(protected readonly storage: VaultStoragePort) {}

	abstract activePins(now?: number): HistoryPin[];

	initialize(): void {
		if (this.initialized) return;
		this.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS vault_clock (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				sequence INTEGER NOT NULL
			);
			INSERT OR IGNORE INTO vault_clock(id, sequence) VALUES (1, 0);
			CREATE TABLE IF NOT EXISTS vault_feed_state (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				floor_sequence INTEGER NOT NULL
			);
			INSERT OR IGNORE INTO vault_feed_state(id, floor_sequence) VALUES (1, 0);
			CREATE TABLE IF NOT EXISTS vault_document_heads (
				document_id TEXT PRIMARY KEY,
				generation INTEGER NOT NULL,
				latest_sequence INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_journal (
				sequence INTEGER PRIMARY KEY,
				document_id TEXT NOT NULL,
				generation INTEGER NOT NULL,
				kind TEXT NOT NULL,
				update_byte_length INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS vault_journal_document_sequence
				ON vault_journal(document_id, sequence);
			CREATE TABLE IF NOT EXISTS vault_journal_chunks (
				sequence INTEGER NOT NULL,
				chunk_index INTEGER NOT NULL,
				data BLOB NOT NULL,
				PRIMARY KEY(sequence, chunk_index)
			);
			CREATE TABLE IF NOT EXISTS vault_checkpoints (
				document_id TEXT NOT NULL,
				checkpoint_sequence INTEGER NOT NULL,
				generation INTEGER NOT NULL,
				chunk_index INTEGER NOT NULL,
				data BLOB NOT NULL,
				PRIMARY KEY(document_id, checkpoint_sequence, chunk_index)
			);
			CREATE INDEX IF NOT EXISTS vault_checkpoint_lookup
				ON vault_checkpoints(document_id, checkpoint_sequence DESC);
			CREATE TABLE IF NOT EXISTS vault_catalog_events (
				sequence INTEGER NOT NULL,
				body_id TEXT NOT NULL,
				file_id TEXT NOT NULL,
				path TEXT NOT NULL,
				previous_path TEXT,
				lifecycle TEXT NOT NULL,
				generation INTEGER NOT NULL,
				content_hash TEXT,
				size INTEGER,
				mutation_index INTEGER NOT NULL,
				PRIMARY KEY(sequence, body_id)
			);
			CREATE INDEX IF NOT EXISTS vault_catalog_body_sequence
				ON vault_catalog_events(body_id, sequence DESC);
			CREATE TABLE IF NOT EXISTS vault_history_pins (
				pin_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				boundary_sequence INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				soft_expires_at INTEGER NOT NULL,
				hard_expires_at INTEGER NOT NULL,
				last_progress_at INTEGER NOT NULL,
				progress INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_operations (
				operation_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				boundary_sequence INTEGER NOT NULL,
				state TEXT NOT NULL,
				artifact_key TEXT,
				artifact_hash TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				error TEXT,
				progress_cursor TEXT
			);
			CREATE TABLE IF NOT EXISTS vault_operation_pages (
				operation_id TEXT NOT NULL,
				page_index INTEGER NOT NULL,
				cursor TEXT NOT NULL,
				artifact_key TEXT NOT NULL,
				artifact_hash TEXT NOT NULL,
				entry_count INTEGER NOT NULL,
				PRIMARY KEY(operation_id, page_index)
			);
			CREATE TABLE IF NOT EXISTS vault_content_objects (
				content_hash TEXT PRIMARY KEY,
				artifact_key TEXT NOT NULL,
				verified_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_meta (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				vault_id TEXT NOT NULL,
				vault_generation TEXT NOT NULL,
				schema_version INTEGER NOT NULL CHECK(schema_version = 8),
				storage_format_version INTEGER NOT NULL CHECK(storage_format_version = 3),
				provisioned_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_revoked_devices (
				device_id TEXT PRIMARY KEY,
				revoked_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_principal_authority (
				principal_id TEXT PRIMARY KEY,
				role TEXT NOT NULL,
				state TEXT NOT NULL,
				membership_revision INTEGER NOT NULL,
				policy_version INTEGER NOT NULL,
				capability_digest TEXT NOT NULL,
				display_name TEXT NOT NULL,
				color_seed TEXT NOT NULL,
				change_id TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_device_authority (
				device_id TEXT PRIMARY KEY,
				principal_id TEXT NOT NULL,
				state TEXT NOT NULL,
				credential_revision INTEGER NOT NULL,
				change_id TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS vault_device_authority_principal
				ON vault_device_authority(principal_id);
			CREATE TABLE IF NOT EXISTS vault_authorization_change_receipts (
				change_id TEXT PRIMARY KEY,
				vault_id TEXT NOT NULL,
				vault_generation TEXT NOT NULL,
				subject_digest TEXT NOT NULL,
				installed_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_collaboration_migration_receipts (
				migration_id TEXT PRIMARY KEY,
				vault_id TEXT NOT NULL,
				vault_generation TEXT NOT NULL,
				request_digest TEXT NOT NULL,
				subject_digest TEXT NOT NULL,
				root_sequence INTEGER NOT NULL,
				settings_assignment TEXT NOT NULL,
				settings_environment_count INTEGER NOT NULL,
				history_attribution TEXT NOT NULL,
				installed_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_schema_migration_receipts (
				migration_id TEXT PRIMARY KEY,
				vault_id TEXT NOT NULL,
				vault_generation TEXT NOT NULL,
				from_schema INTEGER NOT NULL,
				to_schema INTEGER NOT NULL,
				root_sequence INTEGER NOT NULL,
				root_state_hash TEXT NOT NULL,
				completed_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_mutation_attribution (
				sequence INTEGER NOT NULL,
				mutation_index INTEGER NOT NULL,
				principal_id TEXT NOT NULL,
				membership_revision INTEGER NOT NULL,
				device_id TEXT NOT NULL,
				device_credential_revision INTEGER NOT NULL,
				operation_id TEXT,
				request_digest TEXT,
				PRIMARY KEY(sequence, mutation_index)
			);
			CREATE TABLE IF NOT EXISTS vault_operation_outcomes (
				principal_id TEXT NOT NULL,
				membership_revision INTEGER NOT NULL,
				device_id TEXT NOT NULL,
				device_credential_revision INTEGER NOT NULL,
				operation_id TEXT NOT NULL,
				request_digest TEXT NOT NULL,
				vault_sequence INTEGER NOT NULL,
				committed_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				PRIMARY KEY(
					principal_id, membership_revision, device_id, device_credential_revision,
					operation_id, request_digest
				)
			);
			CREATE TABLE IF NOT EXISTS vault_candidate_receipts (
				body_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				candidate_id TEXT NOT NULL,
				candidate_digest TEXT NOT NULL,
				durable_generation INTEGER NOT NULL,
				vault_sequence INTEGER NOT NULL,
				runtime_epoch TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY(body_id, client_id, candidate_id)
			);
			CREATE TABLE IF NOT EXISTS vault_creation_candidates (
				body_id TEXT PRIMARY KEY,
				file_id TEXT NOT NULL,
				path TEXT NOT NULL,
				operation_id TEXT NOT NULL UNIQUE,
				candidate_id TEXT NOT NULL,
				candidate_digest TEXT NOT NULL,
				durable_generation INTEGER NOT NULL,
				vault_sequence INTEGER NOT NULL,
				runtime_epoch TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_semantic_catalog_events (
				sequence INTEGER NOT NULL,
				document_id TEXT NOT NULL,
				file_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				format TEXT NOT NULL,
				format_version INTEGER NOT NULL,
				path TEXT NOT NULL,
				previous_path TEXT,
				lifecycle TEXT NOT NULL,
				generation INTEGER NOT NULL,
				content_hash TEXT,
				size INTEGER,
				mutation_index INTEGER NOT NULL,
				PRIMARY KEY(sequence, document_id)
			);
			CREATE INDEX IF NOT EXISTS vault_semantic_catalog_document_sequence
				ON vault_semantic_catalog_events(document_id, sequence DESC);
			CREATE TABLE IF NOT EXISTS vault_semantic_candidate_receipts (
				document_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				candidate_id TEXT NOT NULL,
				candidate_digest TEXT NOT NULL,
				durable_generation INTEGER NOT NULL,
				vault_sequence INTEGER NOT NULL,
				runtime_epoch TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				size INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY(document_id, client_id, candidate_id)
			);
			CREATE TABLE IF NOT EXISTS vault_semantic_lifecycle_receipts (
				operation_id TEXT PRIMARY KEY,
				request_digest TEXT NOT NULL,
				document_id TEXT NOT NULL,
				file_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				result_path TEXT NOT NULL,
				result_lifecycle TEXT NOT NULL,
				durable_generation INTEGER NOT NULL,
				vault_sequence INTEGER NOT NULL,
				root_generation INTEGER NOT NULL,
				runtime_epoch TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_semantic_authority_receipts (
				operation_id TEXT PRIMARY KEY,
				request_digest TEXT NOT NULL,
				kind TEXT NOT NULL,
				path TEXT NOT NULL,
				document_id TEXT NOT NULL,
				source_revision TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				size INTEGER NOT NULL,
				document_generation INTEGER NOT NULL,
				root_sequence INTEGER NOT NULL,
				root_generation INTEGER NOT NULL,
				rollback_blob_hash TEXT,
				runtime_epoch TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_semantic_rollback_blobs (
				document_id TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				size INTEGER NOT NULL,
				retained_until INTEGER NOT NULL,
				operation_id TEXT NOT NULL UNIQUE,
				PRIMARY KEY(document_id, content_hash)
			);
			CREATE TABLE IF NOT EXISTS vault_lifecycle_receipts (
				operation_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				body_id TEXT NOT NULL,
				file_id TEXT NOT NULL,
				durable_generation INTEGER NOT NULL,
				candidate_id TEXT,
				candidate_digest TEXT,
				source_path TEXT,
				result_path TEXT NOT NULL,
				result_lifecycle TEXT NOT NULL,
				root_generation INTEGER NOT NULL,
				vault_sequence INTEGER NOT NULL,
				runtime_epoch TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_lifecycle_publications (
				operation_id TEXT PRIMARY KEY,
				lifecycle_sequence INTEGER NOT NULL,
				root_sequence INTEGER NOT NULL,
				root_generation INTEGER NOT NULL,
				runtime_epoch TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_recovery_roots (
				root_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				manifest_key TEXT NOT NULL,
				manifest_hash TEXT NOT NULL,
				state TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				error TEXT
			);
			CREATE TABLE IF NOT EXISTS vault_restore_entries (
				restore_id TEXT NOT NULL,
				path TEXT NOT NULL,
				snapshot_content_hash TEXT NOT NULL,
				live_fingerprint TEXT,
				state TEXT NOT NULL,
				file_id TEXT,
				body_id TEXT,
				error TEXT,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY(restore_id, path)
			);
			CREATE TABLE IF NOT EXISTS vault_recovery_mutex (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				owner TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_attachment_catalog_events (
				sequence INTEGER NOT NULL,
				path TEXT NOT NULL,
				content_hash TEXT,
				size INTEGER,
				mime TEXT,
				lifecycle TEXT NOT NULL,
				operation_id TEXT NOT NULL,
				PRIMARY KEY(sequence, path),
				UNIQUE(operation_id, path)
			);
			CREATE INDEX IF NOT EXISTS vault_attachment_path_sequence
				ON vault_attachment_catalog_events(path, sequence DESC);
			CREATE TABLE IF NOT EXISTS vault_attachment_operations (
				operation_id TEXT PRIMARY KEY,
				request_digest TEXT NOT NULL,
				root_sequence INTEGER NOT NULL,
				root_generation INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS recovery_captures (
				capture_id TEXT PRIMARY KEY,
				request_id TEXT NOT NULL UNIQUE,
				vault_id TEXT NOT NULL,
				boundary_sequence INTEGER NOT NULL,
				root_generation INTEGER NOT NULL,
				runtime_epoch TEXT NOT NULL,
				reason TEXT NOT NULL,
				state TEXT NOT NULL,
				job_id TEXT NOT NULL UNIQUE,
				capability_hash TEXT NOT NULL,
				capability_expires_at INTEGER NOT NULL,
				plan_digest TEXT,
				delta_digest TEXT,
				plan_complete INTEGER NOT NULL DEFAULT 0,
				gc_epoch INTEGER,
				base_snapshot_id TEXT,
				planned_active_files INTEGER NOT NULL DEFAULT 0,
				planned_deleted_files INTEGER NOT NULL DEFAULT 0,
				planned_attachments INTEGER NOT NULL DEFAULT 0,
				snapshot_root_key TEXT,
				snapshot_root_hash TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				error TEXT
			);
			CREATE TABLE IF NOT EXISTS recovery_capture_plan_pages (
				capture_id TEXT NOT NULL,
				stream TEXT NOT NULL,
				start_cursor TEXT NOT NULL,
				end_cursor TEXT,
				page_hash TEXT NOT NULL,
				entries INTEGER NOT NULL,
				terminal INTEGER NOT NULL,
				rolling_digest TEXT NOT NULL,
				PRIMARY KEY(capture_id, stream, start_cursor)
			);
			CREATE TABLE IF NOT EXISTS recovery_capture_delta_pages (
				capture_id TEXT NOT NULL,
				start_cursor TEXT NOT NULL,
				end_cursor TEXT,
				page_hash TEXT NOT NULL,
				entries INTEGER NOT NULL,
				terminal INTEGER NOT NULL,
				rolling_digest TEXT NOT NULL,
				PRIMARY KEY(capture_id, start_cursor)
			);
			CREATE TABLE IF NOT EXISTS recovery_recipes (
				recipe_id TEXT PRIMARY KEY,
				capture_id TEXT NOT NULL,
				body_id TEXT NOT NULL,
				generation INTEGER NOT NULL,
				expected_content_hash TEXT NOT NULL,
				expected_size INTEGER NOT NULL,
				encoded_history_bytes INTEGER NOT NULL,
				UNIQUE(capture_id, body_id, generation)
			);
			CREATE TABLE IF NOT EXISTS recovery_snapshot_dependencies (
				operation_kind TEXT NOT NULL,
				operation_id TEXT NOT NULL,
				snapshot_id TEXT NOT NULL,
				PRIMARY KEY(operation_kind, operation_id, snapshot_id)
			);
			CREATE TABLE IF NOT EXISTS recovery_capture_manifest_nodes (
				capture_id TEXT NOT NULL,
				tree TEXT NOT NULL,
				logical_prefix TEXT NOT NULL,
				node_hash TEXT NOT NULL,
				subtree_entries INTEGER NOT NULL,
				subtree_nodes INTEGER NOT NULL,
				provenance_snapshot_id TEXT,
				PRIMARY KEY(capture_id, tree, logical_prefix)
			);
			CREATE TABLE IF NOT EXISTS recovery_snapshot_manifest_nodes (
				snapshot_id TEXT NOT NULL,
				node_hash TEXT NOT NULL,
				PRIMARY KEY(snapshot_id, node_hash)
			);
			CREATE TABLE IF NOT EXISTS recovery_content_index (
				content_hash TEXT PRIMARY KEY,
				object_key TEXT NOT NULL,
				plain_bytes INTEGER NOT NULL,
				verified_at INTEGER NOT NULL,
				verified_epoch INTEGER
			);
			CREATE TABLE IF NOT EXISTS recovery_manifest_index (
				node_hash TEXT PRIMARY KEY,
				object_key TEXT NOT NULL,
				node_format TEXT NOT NULL,
				subtree_entries INTEGER NOT NULL,
				subtree_nodes INTEGER NOT NULL,
				verified_at INTEGER NOT NULL,
				verified_epoch INTEGER
			);
			CREATE TABLE IF NOT EXISTS recovery_capture_content (
				capture_id TEXT NOT NULL,
				body_id TEXT NOT NULL,
				generation INTEGER NOT NULL,
				content_hash TEXT NOT NULL,
				PRIMARY KEY(capture_id, body_id, generation)
			);
			CREATE TABLE IF NOT EXISTS recovery_snapshot_catalog (
				snapshot_id TEXT PRIMARY KEY,
				boundary_sequence INTEGER NOT NULL,
				root_key TEXT NOT NULL,
				root_hash TEXT NOT NULL,
				reason TEXT NOT NULL,
				pinned INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				completed_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS recovery_restores (
				restore_id TEXT PRIMARY KEY,
				request_id TEXT NOT NULL UNIQUE,
				vault_id TEXT NOT NULL,
				snapshot_id TEXT NOT NULL,
				selection_json TEXT NOT NULL,
				state TEXT NOT NULL,
				job_id TEXT NOT NULL UNIQUE,
				capability_hash TEXT NOT NULL,
				capability_expires_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS recovery_projection_lease (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				lease_id TEXT NOT NULL,
				capability_hash TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				enabled INTEGER NOT NULL,
				runtime_epoch TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS recovery_key_leases (
				object_key TEXT PRIMARY KEY,
				lease_id TEXT NOT NULL,
				lease_kind TEXT NOT NULL,
				owner_kind TEXT NOT NULL,
				owner_id TEXT NOT NULL,
				domain TEXT,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS recovery_key_leases_lease
				ON recovery_key_leases(lease_id);
			CREATE TABLE IF NOT EXISTS recovery_defects (
				capture_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				identity TEXT NOT NULL,
				generation INTEGER NOT NULL,
				code TEXT NOT NULL,
				reference_hash TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY(capture_id, kind, identity, generation)
			);
			CREATE TABLE IF NOT EXISTS recovery_gc_epochs (
				epoch INTEGER PRIMARY KEY,
				request_id TEXT NOT NULL UNIQUE,
				vault_id TEXT NOT NULL,
				projection_was_enabled INTEGER NOT NULL,
				job_id TEXT NOT NULL,
				capability_hash TEXT NOT NULL,
				capability_expires_at INTEGER NOT NULL,
				state TEXT NOT NULL,
				mark_boundary_sequence INTEGER NOT NULL,
				mark_started_at INTEGER NOT NULL,
				mark_completed_at INTEGER,
				sweep_completed_at INTEGER,
				deadline_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_deletion_authority (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				deletion_id TEXT NOT NULL,
				vault_generation TEXT NOT NULL,
				begun_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_deletion_jobs (
				job_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL
			);
		`);
		this.initialized = true;
	}

	protected insertJournalChunks(sequence: number, update: Uint8Array): number {
		let chunkIndex = 0;
		let rowsWritten = 0;
		for (let offset = 0; offset < update.byteLength; offset += SQLITE_BLOB_CHUNK_BYTES) {
			const chunk = update.subarray(offset, Math.min(offset + SQLITE_BLOB_CHUNK_BYTES, update.byteLength));
			const write = this.storage.sql.exec(
				"INSERT INTO vault_journal_chunks(sequence, chunk_index, data) VALUES (?, ?, ?)",
				sequence,
				chunkIndex++,
				ownedBuffer(chunk),
			);
			write.toArray();
			rowsWritten += write.rowsWritten;
		}
		return rowsWritten;
	}

	currentSequence(): number {
		this.initialize();
		return this.storage.sql.exec<{ sequence: number }>(
			"SELECT sequence FROM vault_clock WHERE id = 1",
		).one().sequence;
	}

	vaultMetadata(): VaultMetadata | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			vault_id: string;
			vault_generation: string;
			schema_version: typeof SCHEMA_VERSION;
			storage_format_version: typeof STORAGE_FORMAT_VERSION;
			provisioned_at: number;
		}>(
			`SELECT vault_id, vault_generation, schema_version, storage_format_version, provisioned_at
			 FROM vault_meta
			 WHERE id = 1 AND schema_version = ? AND storage_format_version = ?`,
			SCHEMA_VERSION,
			STORAGE_FORMAT_VERSION,
		).toArray()[0];
		return row ? {
			vaultId: row.vault_id,
			vaultGeneration: row.vault_generation,
			schemaVersion: row.schema_version,
			storageFormatVersion: row.storage_format_version,
			provisionedAt: row.provisioned_at,
		} : null;
	}

	storedVaultSchemaVersion(): number | null {
		this.initialize();
		return this.storage.sql.exec<{ schema_version: number }>(
			"SELECT schema_version FROM vault_meta WHERE id = 1",
		).toArray()[0]?.schema_version ?? null;
	}

	storedVaultMetadata(): {
		vaultId: string;
		vaultGeneration: string;
		schemaVersion: number;
		storageFormatVersion: number;
		provisionedAt: number;
	} | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			vault_id: string;
			vault_generation: string;
			schema_version: number;
			storage_format_version: number;
			provisioned_at: number;
		}>(`SELECT vault_id, vault_generation, schema_version,
		          storage_format_version, provisioned_at
		   FROM vault_meta WHERE id = 1`).toArray()[0];
		return row ? {
			vaultId: row.vault_id,
			vaultGeneration: row.vault_generation,
			schemaVersion: row.schema_version,
			storageFormatVersion: row.storage_format_version,
			provisionedAt: row.provisioned_at,
		} : null;
	}

	collaborationMigrationReceipt(migrationId: string): VaultCollaborationMigrationReceipt | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			migration_id: string;
			vault_id: string;
			vault_generation: string;
			request_digest: string;
			subject_digest: string;
			root_sequence: number;
			settings_assignment: "owner_principal_scoped";
			settings_environment_count: number;
			history_attribution: "legacy_unattributed";
			installed_at: number;
		}>(`SELECT migration_id, vault_id, vault_generation, request_digest,
		          subject_digest, root_sequence, settings_assignment,
		          settings_environment_count, history_attribution, installed_at
		   FROM vault_collaboration_migration_receipts WHERE migration_id = ?`, migrationId).toArray()[0];
		return row ? {
			migrationId: row.migration_id,
			vaultId: row.vault_id,
			vaultGeneration: row.vault_generation,
			requestDigest: row.request_digest,
			subjectDigest: row.subject_digest,
			rootSequence: row.root_sequence,
			settingsAssignment: row.settings_assignment,
			settingsEnvironmentCount: row.settings_environment_count,
			historyAttribution: row.history_attribution,
			installedAt: row.installed_at,
		} : null;
	}

	protected assertVaultGeneration(vaultGeneration: string): VaultMetadata {
		const metadata = this.vaultMetadata();
		if (!metadata || metadata.vaultGeneration !== vaultGeneration) {
			throw new Error("vault generation mismatch");
		}
		return metadata;
	}

	protected currentVaultGeneration(): string {
		const metadata = this.vaultMetadata();
		if (!metadata) throw new Error("vault is not provisioned");
		return metadata.vaultGeneration;
	}

	revokeDevice(deviceId: string, now = Date.now()): void {
		this.initialize();
		if (!deviceId || deviceId.length > 128) throw new Error("invalid device identity");
		this.storage.sql.exec(
			"INSERT OR IGNORE INTO vault_revoked_devices(device_id, revoked_at) VALUES (?, ?)",
			deviceId,
			now,
		).toArray();
	}

	isDeviceRevoked(deviceId: string): boolean {
		this.initialize();
		return this.storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM vault_revoked_devices WHERE device_id = ?",
			deviceId,
		).one().count > 0;
	}

	principalAuthority(principalId: string): VaultPrincipalAuthority | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			principal_id: string; role: VaultRole; state: "active" | "revoked";
			membership_revision: number; policy_version: number; capability_digest: string;
			display_name: string; color_seed: string; change_id: string;
		}>(`SELECT principal_id, role, state, membership_revision, policy_version,
		          capability_digest, display_name, color_seed, change_id
		   FROM vault_principal_authority WHERE principal_id = ?`, principalId).toArray()[0];
		return row ? {
			principalId: row.principal_id, role: row.role, state: row.state,
			membershipRevision: row.membership_revision, policyVersion: row.policy_version,
			capabilityDigest: row.capability_digest, displayName: row.display_name,
			colorSeed: row.color_seed, changeId: row.change_id,
		} : null;
	}

	deviceAuthority(deviceId: string): VaultDeviceAuthority | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			device_id: string; principal_id: string; state: "active" | "revoked";
			credential_revision: number; change_id: string;
		}>(`SELECT device_id, principal_id, state, credential_revision, change_id
		   FROM vault_device_authority WHERE device_id = ?`, deviceId).toArray()[0];
		return row ? {
			deviceId: row.device_id, principalId: row.principal_id, state: row.state,
			credentialRevision: row.credential_revision, changeId: row.change_id,
		} : null;
	}

	validateActor(actor: VaultActorContext): "allowed" | "authority_superseded" {
		const metadata = this.vaultMetadata();
		if (!metadata || actor.vaultId !== metadata.vaultId || actor.vaultGeneration !== metadata.vaultGeneration) {
			return "authority_superseded";
		}
		const principal = this.principalAuthority(actor.principalId);
		const device = this.deviceAuthority(actor.deviceId);
		if (!principal || !device || principal.state !== "active" || device.state !== "active"
			|| device.principalId !== actor.principalId || principal.role !== actor.role
			|| principal.membershipRevision !== actor.membershipRevision
			|| device.credentialRevision !== actor.deviceCredentialRevision
			|| principal.policyVersion !== actor.policyVersion
			|| principal.capabilityDigest !== actor.capabilityDigest) return "authority_superseded";
		return "allowed";
	}

	authorityFenceReceipt(changeId: string): VaultAuthorityFenceReceipt | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			change_id: string; vault_id: string; vault_generation: string;
			subject_digest: string; installed_at: number;
		}>(`SELECT change_id, vault_id, vault_generation, subject_digest, installed_at
		   FROM vault_authorization_change_receipts WHERE change_id = ?`, changeId).toArray()[0];
		return row ? { changeId: row.change_id, vaultId: row.vault_id,
			vaultGeneration: row.vault_generation, subjectDigest: row.subject_digest,
			installedAt: row.installed_at } : null;
	}

	installAuthorityFence(input: {
		changeId: string;
		vaultId: string;
		vaultGeneration: string;
		subjectDigest: string;
		subjects: VaultAuthoritySubjectChange[];
		now?: number;
	}): VaultAuthorityFenceReceipt {
		this.initialize();
		const metadata = this.assertVaultGeneration(input.vaultGeneration);
		if (metadata.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		const existing = this.authorityFenceReceipt(input.changeId);
		if (existing) {
			if (existing.vaultId !== input.vaultId || existing.vaultGeneration !== input.vaultGeneration
				|| existing.subjectDigest !== input.subjectDigest) throw new Error("authorization_change_identity_mismatch");
			return existing;
		}
		const installedAt = input.now ?? Date.now();
		this.storage.transactionSync(() => {
			for (const subject of input.subjects) {
				if ("deviceId" in subject) {
					const current = this.deviceAuthority(subject.deviceId);
					if (current && subject.credentialRevision < current.credentialRevision) throw new Error("authority_revision_regressed");
					if (current && subject.credentialRevision === current.credentialRevision) throw new Error("authority_revision_reused");
					if (current && current.principalId !== subject.principalId) throw new Error("device_principal_mismatch");
					this.storage.sql.exec(`INSERT INTO vault_device_authority(
					 device_id, principal_id, state, credential_revision, change_id
					) VALUES (?, ?, ?, ?, ?)
					ON CONFLICT(device_id) DO UPDATE SET principal_id=excluded.principal_id,
					 state=excluded.state, credential_revision=excluded.credential_revision,
					 change_id=excluded.change_id`, subject.deviceId, subject.principalId,
					subject.state, subject.credentialRevision, input.changeId).toArray();
					if (subject.state === "revoked") this.revokeDevice(subject.deviceId, installedAt);
				} else {
					const current = this.principalAuthority(subject.principalId);
					if (current && subject.membershipRevision < current.membershipRevision) throw new Error("authority_revision_regressed");
					if (current && subject.membershipRevision === current.membershipRevision) throw new Error("authority_revision_reused");
					this.storage.sql.exec(`INSERT INTO vault_principal_authority(
					 principal_id, role, state, membership_revision, policy_version,
					 capability_digest, display_name, color_seed, change_id
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(principal_id) DO UPDATE SET role=excluded.role, state=excluded.state,
					 membership_revision=excluded.membership_revision, policy_version=excluded.policy_version,
					 capability_digest=excluded.capability_digest, display_name=excluded.display_name,
					 color_seed=excluded.color_seed, change_id=excluded.change_id`, subject.principalId,
					subject.role, subject.state, subject.membershipRevision, subject.policyVersion,
					subject.capabilityDigest, subject.displayName, subject.colorSeed, input.changeId).toArray();
				}
			}
			const activeOwners = this.storage.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM vault_principal_authority WHERE state = 'active' AND role = 'owner'",
			).one().count;
			if (activeOwners !== 1) throw new Error("owner_invariant");
			const orphaned = this.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count
			 FROM vault_principal_authority p
			 WHERE p.state = 'active' AND NOT EXISTS (
			  SELECT 1 FROM vault_device_authority d
			  WHERE d.principal_id = p.principal_id AND d.state = 'active'
			 )`).one().count;
			if (orphaned !== 0) throw new Error("active_membership_without_device");
			const unknownDevices = this.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count
			 FROM vault_device_authority d LEFT JOIN vault_principal_authority p
			 ON p.principal_id = d.principal_id WHERE p.principal_id IS NULL`).one().count;
			if (unknownDevices !== 0) throw new Error("device_principal_missing");
			this.storage.sql.exec(`INSERT INTO vault_authorization_change_receipts(
			 change_id, vault_id, vault_generation, subject_digest, installed_at
			) VALUES (?, ?, ?, ?, ?)`, input.changeId, input.vaultId, input.vaultGeneration,
				input.subjectDigest, installedAt).toArray();
		});
		return { changeId: input.changeId, vaultId: input.vaultId,
			vaultGeneration: input.vaultGeneration, subjectDigest: input.subjectDigest, installedAt };
	}

	committedOperationOutcome(
		actor: Pick<VaultActorContext, "principalId" | "membershipRevision" | "deviceId" | "deviceCredentialRevision">,
		operationId: string,
		requestDigest: string,
	): { operationId: string; requestDigest: string; vaultSequence: number; committed: true } | null {
		this.initialize();
		const outcome = this.storage.sql.exec<{ vault_sequence: number }>(`SELECT vault_sequence
		 FROM vault_operation_outcomes
		 WHERE principal_id = ? AND membership_revision = ? AND device_id = ?
		   AND device_credential_revision = ? AND operation_id = ? AND request_digest = ?
		   AND expires_at > ?
		 LIMIT 1`, actor.principalId, actor.membershipRevision, actor.deviceId,
			actor.deviceCredentialRevision, operationId, requestDigest, Date.now()).toArray()[0];
		if (outcome) return { operationId, requestDigest, vaultSequence: outcome.vault_sequence, committed: true };
		const row = this.storage.sql.exec<{ sequence: number }>(`SELECT sequence
		 FROM vault_mutation_attribution
		 WHERE principal_id = ? AND membership_revision = ? AND device_id = ?
		   AND device_credential_revision = ? AND operation_id = ? AND request_digest = ?
		 ORDER BY sequence DESC LIMIT 1`, actor.principalId, actor.membershipRevision, actor.deviceId,
			actor.deviceCredentialRevision, operationId, requestDigest).toArray()[0];
		return row ? { operationId, requestDigest, vaultSequence: row.sequence, committed: true } : null;
	}

	documentGenerationAtSequence(documentId: string, sequence: number): number | null {
		this.initialize();
		return this.storage.sql.exec<{ generation: number }>(
			"SELECT generation FROM vault_journal WHERE document_id = ? AND sequence = ?",
			documentId,
			sequence,
		).toArray()[0]?.generation ?? null;
	}

	documentHead(documentId: string): { generation: number; latestSequence: number } | null {
		this.initialize();
		const row = this.storage.sql.exec<{ generation: number; latest_sequence: number }>(
			"SELECT generation, latest_sequence FROM vault_document_heads WHERE document_id = ?",
			documentId,
		).toArray()[0];
		return row ? { generation: row.generation, latestSequence: row.latest_sequence } : null;
	}

	documentJournalStats(documentId: string): { entries: number; bytes: number } {
		this.initialize();
		const row = this.storage.sql.exec<{ entries: number; bytes: number }>(
			`SELECT COUNT(*) AS entries, COALESCE(SUM(update_byte_length), 0) AS bytes
			 FROM vault_journal WHERE document_id = ?`,
			documentId,
		).one();
		return row;
	}

	reconstructDocument(documentId: string, throughSequence = this.currentSequence()): ReconstructedDocument {
		this.initialize();
		if (throughSequence < 0) throw new Error("throughSequence must be non-negative");
		let rowsRead = 0;
		const checkpointRows = this.storage.sql.exec<{
			checkpoint_sequence: number; generation: number; chunk_index: number; data: DurableChunkValue;
		}>(
			`SELECT checkpoint_sequence, generation, chunk_index, data
			 FROM vault_checkpoints
			 WHERE document_id = ?
			   AND checkpoint_sequence = (
			     SELECT MAX(checkpoint_sequence) FROM vault_checkpoints
			     WHERE document_id = ? AND checkpoint_sequence <= ?
			   )
			 ORDER BY chunk_index`,
			documentId,
			documentId,
			throughSequence,
		);
		const checkpointChunks = checkpointRows.toArray();
		rowsRead += checkpointRows.rowsRead;
		const checkpoint = checkpointChunks[0];
		const checkpointSequence = checkpoint?.checkpoint_sequence ?? 0;
		let generation = checkpoint?.generation ?? 0;
		const doc = new Y.Doc({ guid: documentId });
		if (checkpoint) {
			const checkpointBytes = decodeSqlChunks(checkpointChunks);
			if (checkpointBytes.byteLength === 0) throw new Error("checkpoint chunks are missing");
			Y.applyUpdate(doc, checkpointBytes, "checkpoint-load");
		}
		const journal = this.storage.sql.exec<{
			sequence: number; generation: number; update_byte_length: number;
			chunk_index: number | null; data: DurableChunkValue | null;
		}>(
			`SELECT j.sequence, j.generation, j.update_byte_length, c.chunk_index, c.data
			 FROM vault_journal j
			 LEFT JOIN vault_journal_chunks c ON c.sequence = j.sequence
			 WHERE j.document_id = ? AND j.sequence > ? AND j.sequence <= ?
			 ORDER BY j.sequence, c.chunk_index`,
			documentId,
			checkpointSequence,
			throughSequence,
		);
		let journalUpdates = 0;
		let journalSequence: number | null = null;
		let journalGeneration = 0;
		let expectedBytes = 0;
		let chunks: Array<{ data: DurableChunkValue }> = [];
		const applyJournal = (): void => {
			if (journalSequence === null) return;
			const update = decodeSqlChunks(chunks);
			if (update.byteLength !== expectedBytes) throw new Error("journal chunk length mismatch");
			if (update.byteLength === 0) throw new Error("journal chunks are missing");
			Y.applyUpdate(doc, update, "journal-load");
			generation = journalGeneration;
			journalUpdates++;
		};
		for (const row of journal) {
			if (journalSequence !== row.sequence) {
				applyJournal();
				journalSequence = row.sequence;
				journalGeneration = row.generation;
				expectedBytes = row.update_byte_length;
				chunks = [];
			}
			if (row.data !== null) chunks.push({ data: row.data });
		}
		applyJournal();
		rowsRead += journal.rowsRead;
		return { documentId, throughSequence, generation, checkpointSequence, journalUpdates, doc, rowsRead };
	}

	writeCheckpoint(documentId: string, throughSequence = this.currentSequence()): {
		status: "written";
		checkpointSequence: number;
		generation: number;
		chunks: number;
		rowsWritten: number;
	} {
		this.initialize();
		const now = Date.now();
		const reconstructed = this.reconstructDocument(documentId, throughSequence);
		const encoded = Y.encodeStateAsUpdate(reconstructed.doc);
		reconstructed.doc.destroy();
		let rowsWritten = 0;
		let chunks = 0;
		this.storage.transactionSync(() => {
			for (let offset = 0; offset < encoded.byteLength || (offset === 0 && encoded.byteLength === 0); offset += SQLITE_BLOB_CHUNK_BYTES) {
				const chunk = encoded.subarray(offset, Math.min(encoded.byteLength, offset + SQLITE_BLOB_CHUNK_BYTES));
				const write = this.storage.sql.exec(
					`INSERT INTO vault_checkpoints(document_id, checkpoint_sequence, generation, chunk_index, data)
					 VALUES (?, ?, ?, ?, ?)`,
					documentId,
					throughSequence,
					reconstructed.generation,
					chunks,
					ownedBuffer(chunk),
				);
				write.toArray();
				rowsWritten += write.rowsWritten;
				chunks++;
				if (encoded.byteLength === 0) break;
			}
			const feedFloor = this.journalFloor();
			const deleteThrough = Math.min(throughSequence, feedFloor);
			const deleteJournalChunks = this.storage.sql.exec(
				`DELETE FROM vault_journal_chunks WHERE sequence IN (
				 SELECT sequence FROM vault_journal WHERE document_id = ? AND sequence <= ?
				)`,
				documentId,
				deleteThrough,
			);
			deleteJournalChunks.toArray();
			rowsWritten += deleteJournalChunks.rowsWritten;
			const deleteJournal = this.storage.sql.exec(
				"DELETE FROM vault_journal WHERE document_id = ? AND sequence <= ?",
				documentId,
				deleteThrough,
			);
			deleteJournal.toArray();
			rowsWritten += deleteJournal.rowsWritten;
			const oldCheckpoints = this.storage.sql.exec(
				`DELETE FROM vault_checkpoints
				 WHERE document_id = ? AND checkpoint_sequence NOT IN (
				   SELECT DISTINCT checkpoint_sequence FROM vault_checkpoints
				   WHERE document_id = ? ORDER BY checkpoint_sequence DESC LIMIT 3
				 )
				 AND NOT EXISTS (
				   SELECT 1 FROM vault_history_pins p
				   WHERE p.hard_expires_at > ?
				     AND vault_checkpoints.checkpoint_sequence = (
				       SELECT MAX(protected.checkpoint_sequence)
				       FROM vault_checkpoints protected
				       WHERE protected.document_id = vault_checkpoints.document_id
				         AND protected.checkpoint_sequence <= p.boundary_sequence
				     )
				 )`,
				documentId,
				documentId,
				now,
			);
			oldCheckpoints.toArray();
			rowsWritten += oldCheckpoints.rowsWritten;
		});
		return { status: "written", checkpointSequence: throughSequence, generation: reconstructed.generation, chunks, rowsWritten };
	}

	listChangesAfter(sequence: number, limit = 1000): JournalFeedEntry[] {
		this.initialize();
		const boundedLimit = Math.min(1000, Math.max(1, limit));
		const rows = this.storage.sql.exec<{
			sequence: number; document_id: string; generation: number; kind: VaultCommitKind;
		}>(
			`SELECT sequence, document_id, generation, kind FROM vault_journal
			 WHERE sequence > ? ORDER BY sequence LIMIT ?`,
			sequence,
			boundedLimit,
		).toArray();
		const catalogs = this.storage.sql.exec<{
			sequence: number; body_id: string; file_id: string; path: string; previous_path: string | null;
			lifecycle: BodyLifecycle; generation: number; content_hash: string | null; size: number | null;
		}>(
			`SELECT c.sequence, c.body_id, c.file_id, c.path, c.previous_path, c.lifecycle,
			        c.generation, c.content_hash, c.size
			 FROM vault_catalog_events c
			 JOIN (
			   SELECT sequence FROM vault_journal
			   WHERE sequence > ? ORDER BY sequence LIMIT ?
			 ) page ON page.sequence = c.sequence
			 ORDER BY c.sequence, c.mutation_index`,
			sequence,
			boundedLimit,
		).toArray();
		const catalogsBySequence = new Map<number, CatalogHeadAtBoundary[]>();
		for (const catalog of catalogs) {
			const mapped: CatalogHeadAtBoundary = {
				sequence: catalog.sequence,
				bodyId: catalog.body_id,
				fileId: catalog.file_id,
				path: catalog.path,
				previousPath: catalog.previous_path,
				lifecycle: catalog.lifecycle,
				generation: catalog.generation,
				contentHash: catalog.content_hash,
				size: catalog.size,
			};
			const entries = catalogsBySequence.get(catalog.sequence);
			if (entries) entries.push(mapped);
			else catalogsBySequence.set(catalog.sequence, [mapped]);
		}
		const semanticCatalogs = this.storage.sql.exec<{
			sequence: number; document_id: string; file_id: string; kind: "canvas"; format: "json-canvas";
			format_version: 1; path: string; previous_path: string | null;
			lifecycle: SemanticCatalogHead["lifecycle"]; generation: number; content_hash: string | null; size: number | null;
		}>(`SELECT c.sequence, c.document_id, c.file_id, c.kind, c.format, c.format_version, c.path,
		          c.previous_path, c.lifecycle, c.generation, c.content_hash, c.size
		   FROM vault_semantic_catalog_events c JOIN (
		     SELECT sequence FROM vault_journal WHERE sequence > ? ORDER BY sequence LIMIT ?
		   ) page ON page.sequence = c.sequence ORDER BY c.sequence, c.mutation_index`, sequence, boundedLimit).toArray();
		const semanticBySequence = new Map<number, SemanticCatalogHead[]>();
		for (const value of semanticCatalogs) {
			const mapped: SemanticCatalogHead = { sequence: value.sequence, documentId: value.document_id,
				fileId: value.file_id, kind: value.kind, format: value.format, formatVersion: value.format_version,
				path: value.path, previousPath: value.previous_path, lifecycle: value.lifecycle,
				generation: value.generation, contentHash: value.content_hash, size: value.size };
			const entries = semanticBySequence.get(value.sequence);
			if (entries) entries.push(mapped); else semanticBySequence.set(value.sequence, [mapped]);
		}
		return rows.map((row) => ({
			sequence: row.sequence,
			documentId: row.document_id,
			generation: row.generation,
			kind: row.kind,
			catalogs: catalogsBySequence.get(row.sequence) ?? [],
			semanticCatalogs: semanticBySequence.get(row.sequence) ?? [],
		}));
	}

	journalFloor(): number {
		this.initialize();
		return this.storage.sql.exec<{ floor: number }>(
			"SELECT floor_sequence AS floor FROM vault_feed_state WHERE id = 1",
		).one().floor;
	}

	changesPageAfter(sequence: number, limit = 1000): JournalFeedPage {
		const floor = this.journalFloor();
		const highWater = this.currentSequence();
		return {
			entries: sequence < floor ? [] : this.listChangesAfter(sequence, limit),
			floor,
			highWater,
			resetRequired: sequence < floor,
		};
	}

	advanceFeedFloor(throughSequence: number, now = Date.now()): { floor: number; rowsWritten: number } {
		this.initialize();
		const current = this.currentSequence();
		if (throughSequence < 0 || throughSequence > current) throw new Error("invalid feed floor");
		if (this.activePins(now).some((pin) => pin.boundarySequence <= throughSequence)) {
			throw new Error("cannot advance feed floor through an active history pin");
		}
		let rowsWritten = 0;
		this.storage.transactionSync(() => {
			const floor = this.storage.sql.exec(
				"UPDATE vault_feed_state SET floor_sequence = MAX(floor_sequence, ?) WHERE id = 1",
				throughSequence,
			);
			floor.toArray();
			rowsWritten += floor.rowsWritten;
			const pruneChunks = this.storage.sql.exec(
				`DELETE FROM vault_journal_chunks WHERE sequence IN (
				   SELECT j.sequence FROM vault_journal j
				   WHERE j.sequence <= ?
				     AND EXISTS (
				       SELECT 1 FROM vault_checkpoints c
				       WHERE c.document_id = j.document_id
				         AND c.checkpoint_sequence >= j.sequence
				     )
				 )`,
				throughSequence,
			);
			pruneChunks.toArray();
			rowsWritten += pruneChunks.rowsWritten;
			const prune = this.storage.sql.exec(
				`DELETE FROM vault_journal
				 WHERE sequence <= ?
				   AND EXISTS (
				     SELECT 1 FROM vault_checkpoints c
				     WHERE c.document_id = vault_journal.document_id
				       AND c.checkpoint_sequence >= vault_journal.sequence
				   )`,
				throughSequence,
			);
			prune.toArray();
			rowsWritten += prune.rowsWritten;
		});
		return { floor: this.journalFloor(), rowsWritten };
	}

	documentEncodedHistoryBytes(documentId: string, throughSequence: number): number {
		this.initialize();
		const checkpoint = this.storage.sql.exec<{ checkpoint_sequence: number }>(
			`SELECT checkpoint_sequence FROM vault_checkpoints
			 WHERE document_id = ? AND checkpoint_sequence <= ? ORDER BY checkpoint_sequence DESC LIMIT 1`,
			documentId,
			throughSequence,
		).toArray()[0];
		const checkpointSequence = checkpoint?.checkpoint_sequence ?? 0;
		let bytes = checkpoint ? this.storage.sql.exec<{ bytes: number }>(
			`SELECT COALESCE(SUM(length(data)), 0) AS bytes FROM vault_checkpoints
			 WHERE document_id = ? AND checkpoint_sequence = ?`,
			documentId,
			checkpointSequence,
		).one().bytes : 0;
		bytes += this.storage.sql.exec<{ bytes: number }>(
			`SELECT COALESCE(SUM(update_byte_length), 0) AS bytes FROM vault_journal
			 WHERE document_id = ? AND sequence > ? AND sequence <= ?`,
			documentId,
			checkpointSequence,
			throughSequence,
		).one().bytes;
		return bytes;
	}

	rawDocumentRecipeChunk(documentId: string, throughSequence: number, cursor: string, maxBytes: number): {
		parts: Array<{ kind: "checkpoint" | "journal"; sequence: number; fragmentIndex: number; fragmentCount: number; bytes: Uint8Array }>;
		nextCursor: string | null;
		encodedBytes: number;
	} {
		this.initialize();
		const offset = Number(cursor);
		if (!Number.isSafeInteger(offset) || offset < 0 || maxBytes <= 0) throw new Error("invalid recipe cursor or byte budget");
		const checkpoint = this.storage.sql.exec<{ checkpoint_sequence: number; chunk_count: number }>(
			`SELECT checkpoint_sequence, COUNT(*) AS chunk_count FROM vault_checkpoints
			 WHERE document_id = ?
			   AND checkpoint_sequence = (
			     SELECT MAX(checkpoint_sequence) FROM vault_checkpoints
			     WHERE document_id = ? AND checkpoint_sequence <= ?
			   )
			 GROUP BY checkpoint_sequence`,
			documentId,
			documentId,
			throughSequence,
		).toArray()[0];
		const checkpointSequence = checkpoint?.checkpoint_sequence ?? 0;
		const checkpointCount = checkpoint?.chunk_count ?? 0;
		const checkpointRows = checkpoint && offset < checkpointCount ? this.storage.sql.exec<{
			chunk_index: number; expected_bytes: number; data: DurableChunkValue;
		}>(
			`WITH candidates AS (
			   SELECT chunk_index, length(data) AS expected_bytes
			   FROM vault_checkpoints
			   WHERE document_id = ? AND checkpoint_sequence = ? AND chunk_index >= ?
			   ORDER BY chunk_index LIMIT 256
			 ), sized AS (
			   SELECT chunk_index, expected_bytes,
			          ROW_NUMBER() OVER (ORDER BY chunk_index) AS ordinal,
			          SUM(expected_bytes) OVER (ORDER BY chunk_index ROWS UNBOUNDED PRECEDING) AS running_bytes
			   FROM candidates
			 )
			 SELECT sized.chunk_index, sized.expected_bytes, checkpoint.data
			 FROM sized
			 JOIN vault_checkpoints checkpoint
			   ON checkpoint.document_id = ? AND checkpoint.checkpoint_sequence = ?
			  AND checkpoint.chunk_index = sized.chunk_index
			 WHERE sized.ordinal = 1 OR sized.running_bytes <= ?
			 ORDER BY sized.chunk_index`,
			documentId, checkpointSequence, offset,
			documentId, checkpointSequence, maxBytes,
		).toArray() : [];
		const journalOffset = Math.max(0, offset - checkpointCount);
		const candidates: Array<{
			kind: "checkpoint" | "journal"; sequence: number; fragmentIndex: number;
			fragmentCount: number; expectedBytes: number; bytes: Uint8Array;
		}> = checkpointRows.map((row) => ({
			kind: "checkpoint", sequence: checkpointSequence, fragmentIndex: row.chunk_index,
			fragmentCount: checkpointCount, expectedBytes: row.expected_bytes, bytes: new Uint8Array(row.data),
		}));
		const checkpointBytes = candidates.reduce((total, candidate) => total + candidate.expectedBytes, 0);
		const checkpointExhausted = offset >= checkpointCount
			|| offset + checkpointRows.length >= checkpointCount;
		const journalLimit = checkpointExhausted ? 256 - checkpointRows.length : 0;
		const remainingBytes = maxBytes - checkpointBytes;
		const forceFirstJournal = checkpointRows.length === 0;
		const journalRows = journalLimit > 0 && (remainingBytes > 0 || forceFirstJournal) ? this.storage.sql.exec<{
			sequence: number; update_byte_length: number; chunk_index: number | null; data: DurableChunkValue | null;
		}>(
			`WITH candidates AS (
			   SELECT sequence, update_byte_length FROM vault_journal
			   WHERE document_id = ? AND sequence > ? AND sequence <= ?
			   ORDER BY sequence LIMIT ? OFFSET ?
			 ), sized AS (
			   SELECT sequence, update_byte_length,
			          ROW_NUMBER() OVER (ORDER BY sequence) AS ordinal,
			          SUM(update_byte_length) OVER (ORDER BY sequence ROWS UNBOUNDED PRECEDING) AS running_bytes
			   FROM candidates
			 ), selected AS (
			   SELECT sequence, update_byte_length FROM sized
			   WHERE running_bytes <= ? OR (? = 1 AND ordinal = 1)
			 )
			 SELECT selected.sequence, selected.update_byte_length, chunks.chunk_index, chunks.data
			 FROM selected
			 LEFT JOIN vault_journal_chunks chunks ON chunks.sequence = selected.sequence
			 ORDER BY selected.sequence, chunks.chunk_index`,
			documentId,
			checkpointSequence,
			throughSequence,
			journalLimit,
			journalOffset,
			Math.max(0, remainingBytes),
			forceFirstJournal ? 1 : 0,
		).toArray() : [];
		for (let start = 0; start < journalRows.length;) {
			const first = journalRows[start]!;
			let end = start + 1;
			while (end < journalRows.length && journalRows[end]!.sequence === first.sequence) end++;
			const bytes = decodeSqlChunks(journalRows.slice(start, end)
				.filter((row): row is typeof row & { data: DurableChunkValue } => row.data !== null)
				.map((row) => ({ data: row.data })));
			candidates.push({
				kind: "journal", sequence: first.sequence, fragmentIndex: 0, fragmentCount: 1,
				expectedBytes: first.update_byte_length, bytes,
			});
			start = end;
		}
		const selected: typeof candidates = [];
		let encodedBytes = 0;
		for (const item of candidates) {
			if (item.bytes.byteLength !== item.expectedBytes) throw new Error("recipe history chunk length mismatch");
			if (selected.length > 0 && encodedBytes + item.expectedBytes > maxBytes) break;
			selected.push(item);
			encodedBytes += item.expectedBytes;
			if (selected.length === 256) break;
		}
		const parts = selected.map(({ kind, sequence, fragmentIndex, fragmentCount, bytes }) =>
			({ kind, sequence, fragmentIndex, fragmentCount, bytes }));
		const consumed = offset + selected.length;
		const total = checkpointCount + this.storage.sql.exec<{ count: number }>(
			`SELECT COUNT(*) AS count FROM vault_journal
			 WHERE document_id = ? AND sequence > ? AND sequence <= ?`,
			documentId,
			checkpointSequence,
			throughSequence,
		).one().count;
		return { parts, nextCursor: consumed < total ? String(consumed) : null, encodedBytes };
	}
}
