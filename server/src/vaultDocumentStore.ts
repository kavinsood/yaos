import * as Y from "yjs";
import { SCHEMA_VERSION, STORAGE_FORMAT_VERSION } from "./shared/productVersions";
import { base64UrlToBytes, bytesToBase64Url } from "./base64url";
import type { BodyLifecycle, CatalogHeadAtBoundary } from "./vaultCatalogStore";
import type { HistoryPin } from "./vaultBootstrapStore";

const CHECKPOINT_CHUNK_BYTES = 1024 * 1024;

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

export type VaultCommitKind = "root" | "body" | "create" | "rename" | "delete" | "revive" | "lifecycle-batch" | "blob" | "restore";

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
}

export interface JournalFeedPage {
	entries: JournalFeedEntry[];
	floor: number;
	highWater: number;
	resetRequired: boolean;
}

export function decodeSqlChunks(rows: Iterable<{ data: string }>): Uint8Array {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (const row of rows) {
		const chunk = base64UrlToBytes(row.data);
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
				data TEXT NOT NULL,
				PRIMARY KEY(sequence, chunk_index)
			);
			CREATE TABLE IF NOT EXISTS vault_checkpoints (
				document_id TEXT NOT NULL,
				checkpoint_sequence INTEGER NOT NULL,
				generation INTEGER NOT NULL,
				chunk_index INTEGER NOT NULL,
				data TEXT NOT NULL,
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
				schema_version INTEGER NOT NULL CHECK(schema_version = 4),
				storage_format_version INTEGER NOT NULL CHECK(storage_format_version = 1),
				provisioned_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_revoked_devices (
				device_id TEXT PRIMARY KEY,
				revoked_at INTEGER NOT NULL
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
		for (let offset = 0; offset < update.byteLength; offset += CHECKPOINT_CHUNK_BYTES) {
			const chunk = update.subarray(offset, Math.min(offset + CHECKPOINT_CHUNK_BYTES, update.byteLength));
			const write = this.storage.sql.exec(
				"INSERT INTO vault_journal_chunks(sequence, chunk_index, data) VALUES (?, ?, ?)",
				sequence,
				chunkIndex++,
				bytesToBase64Url(chunk),
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
		const checkpointHead = this.storage.sql.exec<{ checkpoint_sequence: number; generation: number }>(
			`SELECT checkpoint_sequence, generation
			 FROM vault_checkpoints
			 WHERE document_id = ? AND checkpoint_sequence <= ?
			 ORDER BY checkpoint_sequence DESC LIMIT 1`,
			documentId,
			throughSequence,
		);
		const checkpoint = checkpointHead.toArray()[0];
		rowsRead += checkpointHead.rowsRead;
		const checkpointSequence = checkpoint?.checkpoint_sequence ?? 0;
		let generation = checkpoint?.generation ?? 0;
		const doc = new Y.Doc({ guid: documentId });
		if (checkpoint) {
			const chunks = this.storage.sql.exec<{ data: string }>(
				`SELECT data FROM vault_checkpoints
				 WHERE document_id = ? AND checkpoint_sequence = ?
				 ORDER BY chunk_index`,
				documentId,
				checkpointSequence,
			);
			const checkpointBytes = decodeSqlChunks(chunks);
			if (checkpointBytes.byteLength === 0) throw new Error("checkpoint chunks are missing");
			Y.applyUpdate(doc, checkpointBytes, "checkpoint-load");
			rowsRead += chunks.rowsRead;
		}
		const journal = this.storage.sql.exec<{ sequence: number; generation: number; update_byte_length: number }>(
			`SELECT sequence, generation, update_byte_length FROM vault_journal
			 WHERE document_id = ? AND sequence > ? AND sequence <= ?
			 ORDER BY sequence`,
			documentId,
			checkpointSequence,
			throughSequence,
		);
		let journalUpdates = 0;
		for (const row of journal) {
			const chunks = this.storage.sql.exec<{ data: string }>(
				"SELECT data FROM vault_journal_chunks WHERE sequence = ? ORDER BY chunk_index",
				row.sequence,
			);
			const update = decodeSqlChunks(chunks);
			if (update.byteLength !== row.update_byte_length) throw new Error("journal chunk length mismatch");
			if (update.byteLength === 0) throw new Error("journal chunks are missing");
			Y.applyUpdate(doc, update, "journal-load");
			rowsRead += chunks.rowsRead;
			generation = row.generation;
			journalUpdates++;
		}
		rowsRead += journal.rowsRead;
		return { documentId, throughSequence, generation, checkpointSequence, journalUpdates, doc, rowsRead };
	}

	writeCheckpoint(documentId: string, throughSequence = this.currentSequence()): {
		status: "written" | "blocked-by-pin";
		checkpointSequence: number;
		generation: number;
		chunks: number;
		rowsWritten: number;
	} {
		this.initialize();
		const activePins = this.activePins(Date.now());
		if (activePins.length > 0) {
			return { status: "blocked-by-pin", checkpointSequence: throughSequence, generation: 0, chunks: 0, rowsWritten: 0 };
		}
		const reconstructed = this.reconstructDocument(documentId, throughSequence);
		const encoded = Y.encodeStateAsUpdate(reconstructed.doc);
		reconstructed.doc.destroy();
		let rowsWritten = 0;
		let chunks = 0;
		this.storage.transactionSync(() => {
			for (let offset = 0; offset < encoded.byteLength || (offset === 0 && encoded.byteLength === 0); offset += CHECKPOINT_CHUNK_BYTES) {
				const chunk = encoded.subarray(offset, Math.min(encoded.byteLength, offset + CHECKPOINT_CHUNK_BYTES));
				const write = this.storage.sql.exec(
					`INSERT INTO vault_checkpoints(document_id, checkpoint_sequence, generation, chunk_index, data)
					 VALUES (?, ?, ?, ?, ?)`,
					documentId,
					throughSequence,
					reconstructed.generation,
					chunks,
					bytesToBase64Url(chunk),
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
				   SELECT checkpoint_sequence FROM vault_checkpoints
				   WHERE document_id = ? ORDER BY checkpoint_sequence DESC LIMIT 3
				 )`,
				documentId,
				documentId,
			);
			oldCheckpoints.toArray();
			rowsWritten += oldCheckpoints.rowsWritten;
		});
		return { status: "written", checkpointSequence: throughSequence, generation: reconstructed.generation, chunks, rowsWritten };
	}

	listChangesAfter(sequence: number, limit = 1000): JournalFeedEntry[] {
		const rows = this.storage.sql.exec<{
			sequence: number; document_id: string; generation: number; kind: VaultCommitKind;
		}>(
			`SELECT sequence, document_id, generation, kind FROM vault_journal
			 WHERE sequence > ? ORDER BY sequence LIMIT ?`,
			sequence,
			Math.min(1000, Math.max(1, limit)),
		).toArray();
		return rows.map((row) => ({
			sequence: row.sequence,
			documentId: row.document_id,
			generation: row.generation,
			kind: row.kind,
			catalogs: this.storage.sql.exec<{
				sequence: number; body_id: string; file_id: string; path: string; previous_path: string | null;
				lifecycle: BodyLifecycle; generation: number; content_hash: string | null; size: number | null;
			}>(
				`SELECT sequence, body_id, file_id, path, previous_path, lifecycle, generation, content_hash, size
				 FROM vault_catalog_events WHERE sequence = ? ORDER BY mutation_index`,
				row.sequence,
			).toArray().map((catalog) => ({
				sequence: catalog.sequence,
				bodyId: catalog.body_id,
				fileId: catalog.file_id,
				path: catalog.path,
				previousPath: catalog.previous_path,
				lifecycle: catalog.lifecycle,
				generation: catalog.generation,
				contentHash: catalog.content_hash,
				size: catalog.size,
			})),
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
		let bytes = 0;
		if (checkpoint) {
			for (const row of this.storage.sql.exec<{ data: string }>(
				"SELECT data FROM vault_checkpoints WHERE document_id = ? AND checkpoint_sequence = ? ORDER BY chunk_index",
				documentId,
				checkpointSequence,
			)) {
				const completeQuartets = Math.floor(row.data.length / 4);
				const remainder = row.data.length % 4;
				if (remainder === 1) throw new Error("invalid checkpoint chunk length");
				bytes += completeQuartets * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
			}
		}
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
		parts: Array<{ kind: "checkpoint" | "journal"; sequence: number; update: Uint8Array }>;
		nextCursor: string | null;
		encodedBytes: number;
	} {
		this.initialize();
		const offset = Number(cursor);
		if (!Number.isSafeInteger(offset) || offset < 0 || maxBytes <= 0) throw new Error("invalid recipe cursor or byte budget");
		const checkpoint = this.storage.sql.exec<{ checkpoint_sequence: number }>(
			`SELECT checkpoint_sequence FROM vault_checkpoints
			 WHERE document_id = ? AND checkpoint_sequence <= ? ORDER BY checkpoint_sequence DESC LIMIT 1`,
			documentId,
			throughSequence,
		).toArray()[0];
		const checkpointSequence = checkpoint?.checkpoint_sequence ?? 0;
		const checkpointBytes = checkpoint ? decodeSqlChunks(this.storage.sql.exec<{ data: string }>(
			"SELECT data FROM vault_checkpoints WHERE document_id = ? AND checkpoint_sequence = ? ORDER BY chunk_index",
			documentId,
			checkpointSequence,
		)).byteLength : 0;
		const journalOffset = Math.max(0, offset - (checkpoint ? 1 : 0));
		const metadata: Array<{ kind: "checkpoint" | "journal"; sequence: number; bytes: number }> = [];
		if (checkpoint && offset === 0) metadata.push({ kind: "checkpoint", sequence: checkpointSequence, bytes: checkpointBytes });
		metadata.push(...this.storage.sql.exec<{ sequence: number; update_byte_length: number }>(
			`SELECT sequence, update_byte_length FROM vault_journal
			 WHERE document_id = ? AND sequence > ? AND sequence <= ?
			 ORDER BY sequence LIMIT 257 OFFSET ?`,
			documentId,
			checkpointSequence,
			throughSequence,
			journalOffset,
		).toArray().map((row) => ({ kind: "journal" as const, sequence: row.sequence, bytes: row.update_byte_length })));
		const selected: typeof metadata = [];
		let encodedBytes = 0;
		for (const item of metadata) {
			if (selected.length > 0 && encodedBytes + item.bytes > maxBytes) break;
			selected.push(item);
			encodedBytes += item.bytes;
			if (selected.length === 256) break;
		}
		const parts = selected.map((item) => {
			const rows = item.kind === "checkpoint" ? this.storage.sql.exec<{ data: string }>(
				"SELECT data FROM vault_checkpoints WHERE document_id = ? AND checkpoint_sequence = ? ORDER BY chunk_index",
				documentId,
				item.sequence,
			) : this.storage.sql.exec<{ data: string }>(
				"SELECT data FROM vault_journal_chunks WHERE sequence = ? ORDER BY chunk_index",
				item.sequence,
			);
			const update = decodeSqlChunks(rows);
			if (update.byteLength !== item.bytes) throw new Error("recipe history chunk length mismatch");
			return { kind: item.kind, sequence: item.sequence, update };
		});
		const consumed = offset + selected.length;
		const total = (checkpoint ? 1 : 0) + this.storage.sql.exec<{ count: number }>(
			`SELECT COUNT(*) AS count FROM vault_journal
			 WHERE document_id = ? AND sequence > ? AND sequence <= ?`,
			documentId,
			checkpointSequence,
			throughSequence,
		).one().count;
		return { parts, nextCursor: consumed < total ? String(consumed) : null, encodedBytes };
	}
}
