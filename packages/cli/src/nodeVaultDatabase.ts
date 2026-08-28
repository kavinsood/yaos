import { chmodSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
	StoredAttachmentPublicationOperation,
	StoredBodyCandidate,
	StoredBodyReceipt,
	StoredBootstrapProgress,
	StoredDocument,
	StoredFeedCursor,
	StoredLifecycleOperation,
	StoredOutstandingBody,
} from "../../../src/sync/vaultIndexedDb";
import {
	PendingWorkError,
	assertResetAllowed,
	type PendingWorkSummary,
} from "../../../src/sync/vaultIndexedDb";
import type { VaultDatabasePort } from "../../../src/sync/vaultSync";
import type { BootstrapDatabasePort } from "../../../src/sync/bootstrapClient";
import type {
	LocalVaultImportState,
	LocalVaultImportStateStore,
} from "../../../src/onboarding/localVaultImport";
import type { PreservedUnresolvedEntry } from "../../../src/sync/preservedUnresolved";
import type { DiskIndex } from "../../../src/sync/diskIndex";

/**
 * Convert a binary binding without allocating or copying its bytes.
 * node:sqlite accepts Uint8Array and retains the bytes for the duration of run().
 */
export function sqliteBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function storedArrayBuffer(value: unknown, field: string): ArrayBuffer {
	if (!(value instanceof Uint8Array)) throw new Error(`SQLite ${field} is not binary`);
	return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function jsonValue<T>(value: unknown, field: string): T {
	if (typeof value !== "string") throw new Error(`SQLite ${field} is not text`);
	try {
		return JSON.parse(value) as T;
	} catch (error) {
		throw new Error(`SQLite ${field} contains invalid JSON`, { cause: error });
	}
}

function optionalInteger(value: number | undefined): number | null {
	return value === undefined ? null : value;
}


type SqlRow = Record<string, unknown>;
export interface NodeVaultDatabaseIdentity {
	readonly host: string;
	readonly realVaultPath: string;
	readonly vaultId: string;
	readonly vaultGeneration: string;
	readonly deviceId: string;
	readonly folderKey: string;
}

export class NodeVaultDatabaseIdentityError extends Error {
	readonly fatal: boolean;

	constructor(readonly field: keyof NodeVaultDatabaseIdentity) {
		super(`SQLite client identity mismatch: ${field}`);
		this.name = "NodeVaultDatabaseIdentityError";
		this.fatal = field === "vaultId" || field === "vaultGeneration" || field === "deviceId";
	}
}


/**
 * Durable schema-4 client persistence for Node 24.
 *
 * The database owns no sync policy. It is the SQLite implementation of the
 * client database ports, plus the two small daemon-only ledgers that replace
 * Obsidian's data.json (initial import and preserved unresolved files).
 */
export class NodeVaultDatabase implements VaultDatabasePort, BootstrapDatabasePort, LocalVaultImportStateStore {
	private readonly database: DatabaseSync;
	private readonly statements = new Map<string, StatementSync>();
	private closed = false;

	constructor(readonly path: string, identity?: NodeVaultDatabaseIdentity) {
		this.database = new DatabaseSync(path);
		chmodSync(path, 0o600);
		this.database.exec("PRAGMA journal_mode = WAL");
		this.database.exec("PRAGMA synchronous = FULL");
		this.database.exec("PRAGMA foreign_keys = ON");
		this.database.exec("PRAGMA busy_timeout = 5000");
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS client_identity (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				host TEXT NOT NULL,
				real_vault_path TEXT NOT NULL,
				vault_id TEXT NOT NULL,
				vault_generation TEXT NOT NULL,
				device_id TEXT NOT NULL,
				folder_key TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS documents (
				document_id TEXT PRIMARY KEY,
				generation INTEGER NOT NULL,
				encoded_state BLOB NOT NULL,
				dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
				pending_local_updates INTEGER,
				updated_at INTEGER NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS pending_candidates (
				candidate_id TEXT PRIMARY KEY,
				vault_id TEXT NOT NULL,
				body_id TEXT NOT NULL,
				candidate_digest TEXT NOT NULL,
				encoded_update BLOB NOT NULL,
				captured_at INTEGER NOT NULL,
				captured_local_updates INTEGER,
				attempts INTEGER,
				last_attempt_at INTEGER
			) STRICT;
			CREATE INDEX IF NOT EXISTS pending_candidates_body ON pending_candidates(body_id);
			CREATE TABLE IF NOT EXISTS lifecycle_operations (
				operation_id TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL,
				value_json TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS attachment_operations (
				operation_id TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL,
				value_json TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS bootstrap_progress (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				value_json TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS feed_cursor (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				sequence INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS outstanding_settlements (
				body_id TEXT PRIMARY KEY,
				value_json TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS materialized_paths (
				body_id TEXT PRIMARY KEY,
				path TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS recovery_state (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				value_json TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS initial_import (
				vault_id TEXT PRIMARY KEY,
				value_json TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS disk_index (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				updated_at INTEGER NOT NULL,
				value_json TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS preserved_unresolved (
				path TEXT PRIMARY KEY,
				last_seen_at INTEGER NOT NULL,
				value_json TEXT NOT NULL
			) STRICT;
		`);
		if (identity) this.bindIdentity(identity);
	}

	private bindIdentity(identity: NodeVaultDatabaseIdentity): void {
		const row = this.statement("SELECT * FROM client_identity WHERE singleton = 1").get() as SqlRow | undefined;
		if (!row) {
			this.statement(`INSERT INTO client_identity
				(singleton, host, real_vault_path, vault_id, vault_generation, device_id, folder_key)
				VALUES (1, ?, ?, ?, ?, ?, ?)`).run(
				identity.host,
				identity.realVaultPath,
				identity.vaultId,
				identity.vaultGeneration,
				identity.deviceId,
				identity.folderKey,
			);
			return;
		}
		const stored: NodeVaultDatabaseIdentity = {
			host: String(row.host),
			realVaultPath: String(row.real_vault_path),
			vaultId: String(row.vault_id),
			vaultGeneration: String(row.vault_generation),
			deviceId: String(row.device_id),
			folderKey: String(row.folder_key),
		};
		for (const field of Object.keys(identity) as Array<keyof NodeVaultDatabaseIdentity>) {
			if (stored[field] !== identity[field]) throw new NodeVaultDatabaseIdentityError(field);
		}
	}

	private statement(sql: string): StatementSync {
		if (this.closed) throw new Error("NodeVaultDatabase is closed");
		const existing = this.statements.get(sql);
		if (existing) return existing;
		const statement = this.database.prepare(sql);
		this.statements.set(sql, statement);
		return statement;
	}

	private transaction<T>(work: () => T): T {
		if (this.closed) throw new Error("NodeVaultDatabase is closed");
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = work();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {
				// Preserve the error that made the transaction fail.
			}
			throw error;
		}
	}

	async getDocument(documentId: string): Promise<StoredDocument | null> {
		const row = this.statement("SELECT * FROM documents WHERE document_id = ?").get(documentId) as SqlRow | undefined;
		if (!row) return null;
		return {
			documentId: String(row.document_id),
			generation: Number(row.generation),
			encodedState: storedArrayBuffer(row.encoded_state, "documents.encoded_state"),
			dirty: row.dirty === 1,
			...(row.pending_local_updates === null ? {} : { pendingLocalUpdates: Number(row.pending_local_updates) }),
			updatedAt: Number(row.updated_at),
		};
	}

	async putDocument(document: StoredDocument): Promise<void> {
		this.statement(`INSERT INTO documents
			(document_id, generation, encoded_state, dirty, pending_local_updates, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(document_id) DO UPDATE SET generation=excluded.generation,
			encoded_state=excluded.encoded_state, dirty=excluded.dirty,
			pending_local_updates=excluded.pending_local_updates, updated_at=excluded.updated_at`)
			.run(document.documentId, document.generation, sqliteBytes(document.encodedState), document.dirty ? 1 : 0,
				optionalInteger(document.pendingLocalUpdates), document.updatedAt);
	}

	async deleteDocument(documentId: string): Promise<void> {
		this.statement("DELETE FROM documents WHERE document_id = ?").run(documentId);
	}

	async putPendingCandidate(candidate: StoredBodyCandidate): Promise<void> {
		this.statement(`INSERT INTO pending_candidates
			(candidate_id, vault_id, body_id, candidate_digest, encoded_update, captured_at,
			 captured_local_updates, attempts, last_attempt_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(candidate_id) DO UPDATE SET vault_id=excluded.vault_id,
			body_id=excluded.body_id, candidate_digest=excluded.candidate_digest,
			encoded_update=excluded.encoded_update, captured_at=excluded.captured_at,
			captured_local_updates=excluded.captured_local_updates, attempts=excluded.attempts,
			last_attempt_at=excluded.last_attempt_at`)
			.run(candidate.candidateId, candidate.vaultId, candidate.bodyId, candidate.candidateDigest,
				sqliteBytes(candidate.encodedUpdate), candidate.capturedAt,
				optionalInteger(candidate.capturedLocalUpdates), optionalInteger(candidate.attempts),
				candidate.lastAttemptAt ?? null);
	}

	async putCandidate(candidate: StoredBodyCandidate): Promise<void> {
		await this.putPendingCandidate(candidate);
	}

	private candidateFromRow(row: SqlRow): StoredBodyCandidate {
		return {
			candidateId: String(row.candidate_id),
			vaultId: String(row.vault_id),
			bodyId: String(row.body_id),
			candidateDigest: String(row.candidate_digest),
			encodedUpdate: storedArrayBuffer(row.encoded_update, "pending_candidates.encoded_update"),
			capturedAt: Number(row.captured_at),
			...(row.captured_local_updates === null ? {} : { capturedLocalUpdates: Number(row.captured_local_updates) }),
			...(row.attempts === null ? {} : { attempts: Number(row.attempts) }),
			...(row.last_attempt_at === null ? {} : { lastAttemptAt: Number(row.last_attempt_at) }),
		};
	}

	async getPendingCandidate(candidateId: string): Promise<StoredBodyCandidate | null> {
		const row = this.statement("SELECT * FROM pending_candidates WHERE candidate_id = ?").get(candidateId) as SqlRow | undefined;
		return row ? this.candidateFromRow(row) : null;
	}

	async listPendingCandidates(): Promise<StoredBodyCandidate[]> {
		return (this.statement("SELECT * FROM pending_candidates ORDER BY captured_at, candidate_id").all() as SqlRow[])
			.map((row) => this.candidateFromRow(row));
	}

	async listCandidates(): Promise<StoredBodyCandidate[]> {
		return this.listPendingCandidates();
	}

	async deletePendingCandidate(candidateId: string): Promise<void> {
		this.statement("DELETE FROM pending_candidates WHERE candidate_id = ?").run(candidateId);
	}

	async deleteCandidate(bodyId: string, candidateId: string): Promise<void> {
		this.transaction(() => {
			const row = this.statement("SELECT body_id FROM pending_candidates WHERE candidate_id = ?").get(candidateId) as SqlRow | undefined;
			if (row && row.body_id !== bodyId) throw new Error(`Candidate ${candidateId} belongs to a different body`);
			this.statement("DELETE FROM pending_candidates WHERE candidate_id = ?").run(candidateId);
		});
	}

	async confirmPendingCandidate(receipt: StoredBodyReceipt): Promise<void> {
		if (!receipt.runtimeEpoch || !receipt.vaultGeneration || !Number.isSafeInteger(receipt.durableGeneration) || receipt.durableGeneration < 0) {
			throw new Error(`Invalid durable receipt for candidate ${receipt.candidateId}`);
		}
		this.transaction(() => {
			const row = this.statement("SELECT * FROM pending_candidates WHERE candidate_id = ?").get(receipt.candidateId) as SqlRow | undefined;
			if (!row) throw new Error(`Unknown candidate ${receipt.candidateId}`);
			const stored = this.candidateFromRow(row);
			if (stored.vaultId !== receipt.vaultId || stored.bodyId !== receipt.bodyId || stored.candidateDigest !== receipt.candidateDigest) {
				throw new Error(`Receipt identity mismatch for candidate ${receipt.candidateId}`);
			}
			const remaining = Number((this.statement(
				"SELECT COUNT(*) AS count FROM pending_candidates WHERE body_id = ? AND candidate_id <> ?",
			).get(receipt.bodyId, receipt.candidateId) as SqlRow).count) > 0;
			const document = this.statement("SELECT * FROM documents WHERE document_id = ?").get(receipt.bodyId) as SqlRow | undefined;
			if (document) {
				const pending = Math.max(0, Number(document.pending_local_updates ?? 0) - (stored.capturedLocalUpdates ?? 0));
				this.statement(`UPDATE documents SET generation = ?, dirty = ?, pending_local_updates = ?, updated_at = ?
					WHERE document_id = ?`).run(Math.max(Number(document.generation), receipt.durableGeneration),
					remaining || pending > 0 ? 1 : 0, pending, Date.now(), receipt.bodyId);
			}
			this.statement("DELETE FROM pending_candidates WHERE candidate_id = ?").run(receipt.candidateId);
		});
	}

	async putLifecycleOperation(operation: StoredLifecycleOperation): Promise<void> {
		this.statement(`INSERT INTO lifecycle_operations(operation_id, created_at, value_json) VALUES (?, ?, ?)
			ON CONFLICT(operation_id) DO UPDATE SET created_at=excluded.created_at, value_json=excluded.value_json`)
			.run(operation.operationId, operation.createdAt, JSON.stringify(operation));
	}

	async getLifecycleOperation(operationId: string): Promise<StoredLifecycleOperation | null> {
		const row = this.statement("SELECT value_json FROM lifecycle_operations WHERE operation_id = ?").get(operationId) as SqlRow | undefined;
		return row ? jsonValue<StoredLifecycleOperation>(row.value_json, "lifecycle_operations.value_json") : null;
	}

	async listLifecycleOperations(): Promise<StoredLifecycleOperation[]> {
		return (this.statement("SELECT value_json FROM lifecycle_operations ORDER BY created_at, operation_id").all() as SqlRow[])
			.map((row) => jsonValue<StoredLifecycleOperation>(row.value_json, "lifecycle_operations.value_json"));
	}

	async deleteLifecycleOperation(operationId: string): Promise<void> {
		this.statement("DELETE FROM lifecycle_operations WHERE operation_id = ?").run(operationId);
	}

	async deleteLifecycleOperations(operationIds: readonly string[]): Promise<void> {
		if (operationIds.length === 0) return;
		this.transaction(() => {
			const statement = this.statement("DELETE FROM lifecycle_operations WHERE operation_id = ?");
			for (const operationId of operationIds) statement.run(operationId);
		});
	}

	async putAttachmentOperation(operation: StoredAttachmentPublicationOperation): Promise<void> {
		this.statement(`INSERT INTO attachment_operations(operation_id, created_at, value_json) VALUES (?, ?, ?)
			ON CONFLICT(operation_id) DO UPDATE SET created_at=excluded.created_at, value_json=excluded.value_json`)
			.run(operation.mutation.operationId, operation.createdAt, JSON.stringify(operation));
	}

	async listAttachmentOperations(): Promise<StoredAttachmentPublicationOperation[]> {
		return (this.statement("SELECT value_json FROM attachment_operations ORDER BY created_at, operation_id").all() as SqlRow[])
			.map((row) => jsonValue<StoredAttachmentPublicationOperation>(row.value_json, "attachment_operations.value_json"));
	}

	async deleteAttachmentOperation(operationId: string): Promise<void> {
		this.statement("DELETE FROM attachment_operations WHERE operation_id = ?").run(operationId);
	}

	async getBootstrapProgress(): Promise<StoredBootstrapProgress | null> {
		const row = this.statement("SELECT value_json FROM bootstrap_progress WHERE singleton = 1").get() as SqlRow | undefined;
		return row ? jsonValue<StoredBootstrapProgress>(row.value_json, "bootstrap_progress.value_json") : null;
	}

	async putBootstrapProgress(progress: StoredBootstrapProgress): Promise<void> {
		this.statement(`INSERT INTO bootstrap_progress(singleton, value_json) VALUES (1, ?)
			ON CONFLICT(singleton) DO UPDATE SET value_json=excluded.value_json`).run(JSON.stringify(progress));
	}

	async getFeedCursor(): Promise<StoredFeedCursor | null> {
		const row = this.statement("SELECT sequence, updated_at FROM feed_cursor WHERE singleton = 1").get() as SqlRow | undefined;
		return row ? { sequence: Number(row.sequence), updatedAt: Number(row.updated_at) } : null;
	}

	async putFeedCursor(cursor: StoredFeedCursor): Promise<void> {
		this.statement(`INSERT INTO feed_cursor(singleton, sequence, updated_at) VALUES (1, ?, ?)
			ON CONFLICT(singleton) DO UPDATE SET sequence=excluded.sequence, updated_at=excluded.updated_at`)
			.run(cursor.sequence, cursor.updatedAt);
	}

	async putOutstanding(entry: StoredOutstandingBody): Promise<void> {
		this.statement(`INSERT INTO outstanding_settlements(body_id, value_json) VALUES (?, ?)
			ON CONFLICT(body_id) DO UPDATE SET value_json=excluded.value_json`).run(entry.bodyId, JSON.stringify(entry));
	}

	async deleteOutstanding(bodyId: string): Promise<void> {
		this.statement("DELETE FROM outstanding_settlements WHERE body_id = ?").run(bodyId);
	}

	async getOutstanding(bodyId: string): Promise<StoredOutstandingBody | null> {
		const row = this.statement("SELECT value_json FROM outstanding_settlements WHERE body_id = ?").get(bodyId) as SqlRow | undefined;
		return row ? jsonValue<StoredOutstandingBody>(row.value_json, "outstanding_settlements.value_json") : null;
	}

	async listOutstanding(): Promise<StoredOutstandingBody[]> {
		return (this.statement("SELECT value_json FROM outstanding_settlements ORDER BY body_id").all() as SqlRow[])
			.map((row) => jsonValue<StoredOutstandingBody>(row.value_json, "outstanding_settlements.value_json"));
	}

	async getMaterializedPath(bodyId: string): Promise<string | null> {
		const row = this.statement("SELECT path FROM materialized_paths WHERE body_id = ?").get(bodyId) as SqlRow | undefined;
		return row ? String(row.path) : null;
	}

	async setMaterializedPath(bodyId: string, path: string): Promise<void> {
		this.statement(`INSERT INTO materialized_paths(body_id, path) VALUES (?, ?)
			ON CONFLICT(body_id) DO UPDATE SET path=excluded.path`).run(bodyId, path);
	}

	async deleteMaterializedPath(bodyId: string): Promise<void> {
		this.statement("DELETE FROM materialized_paths WHERE body_id = ?").run(bodyId);
	}

	async setMaterializedPaths(moves: readonly { bodyId: string; path: string }[]): Promise<void> {
		if (moves.length === 0) return;
		this.transaction(() => {
			const statement = this.statement(`INSERT INTO materialized_paths(body_id, path) VALUES (?, ?)
				ON CONFLICT(body_id) DO UPDATE SET path=excluded.path`);
			for (const move of moves) statement.run(move.bodyId, move.path);
		});
	}

	async listMaterializedPaths(): Promise<Array<{ bodyId: string; path: string }>> {
		return (this.statement("SELECT body_id, path FROM materialized_paths ORDER BY body_id").all() as SqlRow[])
			.map((row) => ({ bodyId: String(row.body_id), path: String(row.path) }));
	}

	async load(vaultId: string): Promise<LocalVaultImportState | null> {
		const row = this.statement("SELECT value_json FROM initial_import WHERE vault_id = ?").get(vaultId) as SqlRow | undefined;
		return row ? jsonValue<LocalVaultImportState>(row.value_json, "initial_import.value_json") : null;
	}

	async save(state: LocalVaultImportState): Promise<void> {
		this.statement(`INSERT INTO initial_import(vault_id, value_json) VALUES (?, ?)
			ON CONFLICT(vault_id) DO UPDATE SET value_json=excluded.value_json`).run(state.vaultId, JSON.stringify(state));
	}

	async clear(vaultId: string): Promise<void> {
		this.statement("DELETE FROM initial_import WHERE vault_id = ?").run(vaultId);
	}

	async loadDiskIndex(): Promise<{ index: DiskIndex; updatedAt: number }> {
		const row = this.statement(
			"SELECT updated_at, value_json FROM disk_index WHERE singleton = 1",
		).get() as SqlRow | undefined;
		return row
			? {
				index: jsonValue<DiskIndex>(row.value_json, "disk_index.value_json"),
				updatedAt: Number(row.updated_at),
			}
			: { index: {}, updatedAt: 0 };
	}

	async saveDiskIndex(index: DiskIndex, updatedAt = Date.now()): Promise<void> {
		this.statement(`INSERT INTO disk_index(singleton, updated_at, value_json) VALUES (1, ?, ?)
			ON CONFLICT(singleton) DO UPDATE SET
			updated_at=excluded.updated_at, value_json=excluded.value_json`)
			.run(updatedAt, JSON.stringify(index));
	}

	async loadPreservedUnresolved(): Promise<PreservedUnresolvedEntry[]> {
		return (this.statement("SELECT value_json FROM preserved_unresolved ORDER BY last_seen_at DESC, path").all() as SqlRow[])
			.map((row) => jsonValue<PreservedUnresolvedEntry>(row.value_json, "preserved_unresolved.value_json"));
	}

	async replacePreservedUnresolved(entries: readonly PreservedUnresolvedEntry[]): Promise<void> {
		this.transaction(() => {
			this.statement("DELETE FROM preserved_unresolved").run();
			const statement = this.statement("INSERT INTO preserved_unresolved(path, last_seen_at, value_json) VALUES (?, ?, ?)");
			for (const entry of entries) statement.run(entry.path, entry.lastSeenAt, JSON.stringify(entry));
		});
	}

	async retirePreservedUnresolvedPath(path: string): Promise<void> {
		this.statement("DELETE FROM preserved_unresolved WHERE path = ?").run(path);
	}

	async getRecoveryState(): Promise<unknown> {
		const row = this.statement("SELECT value_json FROM recovery_state WHERE singleton = 1").get() as SqlRow | undefined;
		return row ? jsonValue<unknown>(row.value_json, "recovery_state.value_json") : null;
	}

	async putRecoveryState(state: object): Promise<void> {
		this.statement(`INSERT INTO recovery_state(singleton, value_json) VALUES (1, ?)
			ON CONFLICT(singleton) DO UPDATE SET value_json=excluded.value_json`).run(JSON.stringify(state));
	}

	async clearRecoveryState(): Promise<void> {
		this.statement("DELETE FROM recovery_state WHERE singleton = 1").run();
	}

	async getPendingWorkSummary(): Promise<PendingWorkSummary> {
		const scalar = (sql: string): number => Number((this.statement(sql).get() as SqlRow).count);
		const recovery = await this.getRecoveryState() as { activeCaptureId?: unknown; activeRestore?: unknown } | null;
		return {
			dirtyDocuments: scalar("SELECT COUNT(*) AS count FROM documents WHERE dirty = 1"),
			pendingCandidates: scalar("SELECT COUNT(*) AS count FROM pending_candidates"),
			lifecycleOperations: scalar("SELECT COUNT(*) AS count FROM lifecycle_operations"),
			attachmentOperations: scalar("SELECT COUNT(*) AS count FROM attachment_operations"),
			outstandingSettlements: scalar("SELECT COUNT(*) AS count FROM outstanding_settlements"),
			activeRecoveryOperations: (typeof recovery?.activeCaptureId === "string" ? 1 : 0)
				+ (typeof recovery?.activeRestore === "object" && recovery.activeRestore !== null ? 1 : 0),
		};
	}

	async hasPendingWork(): Promise<boolean> {
		return Object.values(await this.getPendingWorkSummary()).some((count) => count > 0);
	}

	async clearLocalCache(options: { discardPendingWork?: boolean } = {}): Promise<PendingWorkSummary> {
		const summary = await this.getPendingWorkSummary();
		assertResetAllowed(summary, options.discardPendingWork);
		this.transaction(() => {
			for (const table of ["documents", "pending_candidates", "lifecycle_operations", "attachment_operations",
				"bootstrap_progress", "feed_cursor", "outstanding_settlements", "materialized_paths", "recovery_state",
				"initial_import", "disk_index", "preserved_unresolved"]) {
				this.database.exec(`DELETE FROM ${table}`);
			}
		});
		return summary;
	}

	async getDiagnosticsSnapshot(): Promise<{
		pending: PendingWorkSummary;
		bootstrap: StoredBootstrapProgress | null;
		feedCursor: StoredFeedCursor | null;
	}> {
		const [pending, bootstrap, feedCursor] = await Promise.all([
			this.getPendingWorkSummary(), this.getBootstrapProgress(), this.getFeedCursor(),
		]);
		return { pending, bootstrap, feedCursor };
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.statements.clear();
		this.database.close();
	}
}

export { PendingWorkError };
