export const RECOVERY_JOB_SCHEMA_VERSION = 1;

export type RecoveryJobKind = "capture" | "projection" | "restore" | "gc" | "purge";

export type RecoveryJobPhase =
	| "queued"
	| "planning"
	| "materializing"
	| "building"
	| "publishing"
	| "enumerating"
	| "awaiting-results"
	| "marking"
	| "sweeping"
	| "purging"
	| "retrying"
	| "complete"
	| "complete_with_gaps"
	| "failed"
	| "cancelled";

export type RecoveryJobTerminalPhase = "complete" | "complete_with_gaps" | "failed" | "cancelled";

export interface RecoveryJobCounters {
	processedEntries: number;
	totalEntries: number | null;
	contentObjectsWritten: number;
	contentObjectsReused: number;
	manifestNodesWritten: number;
	bytesRead: number;
	bytesWritten: number;
	retryCount: number;
	alarmInvocations: number;
	deletedObjects: number;
	deletedBytes: number;
}

export interface RecoveryJobRecord extends RecoveryJobCounters {
	jobId: string;
	vaultId: string;
	vaultGeneration: string;
	kind: RecoveryJobKind;
	state: RecoveryJobPhase;
	boundarySequence: number | null;
	capability: string | null;
	capabilityExpiresAt: number | null;
	cursor: string | null;
	nextAttemptAt: number | null;
	errorCode: string | null;
	errorRef: string | null;
	internalError: string | null;
	cancelRequested: boolean;
	createdAt: number;
	updatedAt: number;
	completedAt: number | null;
	revision: number;
}

export interface RecoveryJobInitialization {
	jobId: string;
	vaultId: string;
	vaultGeneration: string;
	kind: RecoveryJobKind;
	boundarySequence?: number;
	capability?: string;
	capabilityExpiresAt?: number;
	createdAt: number;
	metadata: Record<string, unknown>;
}

export interface RecoveryJobArtifact {
	artifactKind: string;
	logicalKey: string;
	objectKey: string;
	objectHash: string;
	entries: number | null;
	bytes: number | null;
	metadata: Record<string, unknown> | null;
}

export interface ReconstructionProgress {
	bodyId: string;
	generation: number;
	recipeId: string;
	expectedContentHash: string;
	expectedSize: number;
	cursor: string;
	stagingKey: string | null;
	stagingHash: string | null;
	encodedBytes: number;
	attempts: number;
}

export interface RecoveryDefect {
	logicalKey: string;
	kind: "body" | "attachment" | "manifest";
	code: string;
	reference: string;
	metadata: Record<string, unknown>;
}

export type RestoreItemOutcome = "restored" | "created-fresh" | "skipped-changed" | "failed";

export interface StoredRestoreItem {
	itemId: string;
	cursorOrder: number;
	kind: "markdown" | "attachment";
	path: string;
	contentHash: string;
	size: number;
	outcome: RestoreItemOutcome | null;
	errorCode: string | null;
	metadata: Record<string, unknown>;
}

export interface GcMark {
	epoch: number;
	domain: "recovery" | "blob" | "staging";
	objectKeyHash: string;
}

export interface RecoverySqlCursor<T extends Record<string, SqlStorageValue>> extends Iterable<T> {
	toArray(): T[];
	one(): T;
	readonly rowsWritten: number;
}

export interface RecoverySqlPort {
	exec<T extends Record<string, SqlStorageValue>>(
		query: string,
		...bindings: unknown[]
	): RecoverySqlCursor<T>;
}

export interface RecoveryJobStoragePort {
	sql: RecoverySqlPort;
	transactionSync<T>(closure: () => T): T;
}

export function isTerminalRecoveryState(state: RecoveryJobPhase): state is RecoveryJobTerminalPhase {
	return state === "complete" || state === "complete_with_gaps" || state === "failed" || state === "cancelled";
}

function parseMetadata(serialized: string | null): Record<string, unknown> | null {
	if (serialized === null) return null;
	const parsed: unknown = JSON.parse(serialized);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("corrupt recovery job metadata");
	}
	return Object.fromEntries(Object.entries(parsed));
}

function sanitizeControlCharacters(value: string): string {
	let result = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		result += code <= 0x1f || code === 0x7f ? " " : character;
	}
	return result;
}

function safeInternalError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return sanitizeControlCharacters(message).slice(0, 512);
}

interface JobRow extends Record<string, SqlStorageValue> {
	job_id: string;
	vault_id: string;
	vault_generation: string;
	kind: RecoveryJobKind;
	state: RecoveryJobPhase;
	boundary_sequence: number | null;
	capability: string | null;
	capability_expires_at: number | null;
	cursor: string | null;
	processed_entries: number;
	total_entries: number | null;
	content_objects_written: number;
	content_objects_reused: number;
	manifest_nodes_written: number;
	bytes_read: number;
	bytes_written: number;
	retry_count: number;
	next_attempt_at: number | null;
	error_code: string | null;
	error_ref: string | null;
	internal_error: string | null;
	cancel_requested: number;
	alarm_invocations: number;
	deleted_objects: number;
	deleted_bytes: number;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
	revision: number;
}

function fromJobRow(row: JobRow): RecoveryJobRecord {
	return {
		jobId: row.job_id,
		vaultId: row.vault_id,
		vaultGeneration: row.vault_generation,
		kind: row.kind,
		state: row.state,
		boundarySequence: row.boundary_sequence,
		capability: row.capability,
		capabilityExpiresAt: row.capability_expires_at,
		cursor: row.cursor,
		processedEntries: row.processed_entries,
		totalEntries: row.total_entries,
		contentObjectsWritten: row.content_objects_written,
		contentObjectsReused: row.content_objects_reused,
		manifestNodesWritten: row.manifest_nodes_written,
		bytesRead: row.bytes_read,
		bytesWritten: row.bytes_written,
		retryCount: row.retry_count,
		nextAttemptAt: row.next_attempt_at,
		errorCode: row.error_code,
		errorRef: row.error_ref,
		internalError: row.internal_error,
		cancelRequested: row.cancel_requested !== 0,
		alarmInvocations: row.alarm_invocations,
		deletedObjects: row.deleted_objects,
		deletedBytes: row.deleted_bytes,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
		revision: row.revision,
	};
}

/** SQLite persistence owned by one deterministic RecoveryJob Durable Object. */
export class RecoveryJobStateStore {
	private initialized = false;

	constructor(private readonly storage: RecoveryJobStoragePort) {}

	resetAfterDeleteAll(): void {
		this.initialized = false;
	}

	initializeSchema(): void {
		if (this.initialized) return;
		this.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS recovery_job_schema (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT OR IGNORE INTO recovery_job_schema(id, version) VALUES (1, ${RECOVERY_JOB_SCHEMA_VERSION});
			CREATE TABLE IF NOT EXISTS job_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				job_id TEXT NOT NULL,
				vault_id TEXT NOT NULL,
				vault_generation TEXT NOT NULL,
				kind TEXT NOT NULL,
				state TEXT NOT NULL,
				boundary_sequence INTEGER,
				capability TEXT,
				capability_expires_at INTEGER,
				cursor TEXT,
				processed_entries INTEGER NOT NULL DEFAULT 0,
				total_entries INTEGER,
				content_objects_written INTEGER NOT NULL DEFAULT 0,
				content_objects_reused INTEGER NOT NULL DEFAULT 0,
				manifest_nodes_written INTEGER NOT NULL DEFAULT 0,
				bytes_read INTEGER NOT NULL DEFAULT 0,
				bytes_written INTEGER NOT NULL DEFAULT 0,
				retry_count INTEGER NOT NULL DEFAULT 0,
				next_attempt_at INTEGER,
				error_code TEXT,
				error_ref TEXT,
				internal_error TEXT,
				cancel_requested INTEGER NOT NULL DEFAULT 0,
				alarm_invocations INTEGER NOT NULL DEFAULT 0,
				deleted_objects INTEGER NOT NULL DEFAULT 0,
				deleted_bytes INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				revision INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS job_metadata (
				key TEXT PRIMARY KEY,
				value_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS job_artifacts (
				artifact_kind TEXT NOT NULL,
				logical_key TEXT NOT NULL,
				object_key TEXT NOT NULL,
				object_hash TEXT NOT NULL,
				entries INTEGER,
				bytes INTEGER,
				metadata_json TEXT,
				PRIMARY KEY (artifact_kind, logical_key)
			);
			CREATE TABLE IF NOT EXISTS reconstruction_progress (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				body_id TEXT NOT NULL,
				generation INTEGER NOT NULL,
				recipe_id TEXT NOT NULL,
				expected_content_hash TEXT NOT NULL,
				expected_size INTEGER NOT NULL,
				cursor TEXT NOT NULL,
				staging_key TEXT,
				staging_hash TEXT,
				encoded_bytes INTEGER NOT NULL,
				attempts INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS job_defects (
				logical_key TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				code TEXT NOT NULL,
				reference TEXT NOT NULL,
				metadata_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS gc_marks (
				epoch INTEGER NOT NULL,
				domain TEXT NOT NULL,
				object_key_hash TEXT NOT NULL,
				PRIMARY KEY (epoch, domain, object_key_hash)
			);
			CREATE TABLE IF NOT EXISTS gc_frontier (
				object_key TEXT PRIMARY KEY,
				domain TEXT NOT NULL,
				tree TEXT,
				processed INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS gc_frontier_pending
				ON gc_frontier(processed, object_key);
			CREATE TABLE IF NOT EXISTS manifest_frontier (
				tree TEXT NOT NULL,
				logical_prefix TEXT NOT NULL,
				node_hash TEXT NOT NULL,
				processed INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (tree, logical_prefix)
			);
			CREATE INDEX IF NOT EXISTS manifest_frontier_pending
				ON manifest_frontier(processed, tree, logical_prefix);
			CREATE TABLE IF NOT EXISTS restore_items (
				item_id TEXT PRIMARY KEY,
				cursor_order INTEGER NOT NULL UNIQUE,
				kind TEXT NOT NULL,
				path TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				size INTEGER NOT NULL,
				outcome TEXT,
				error_code TEXT,
				metadata_json TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS restore_items_outcome_order
				ON restore_items(outcome, cursor_order);
		`);
		const version = this.storage.sql.exec<{ version: number }>(
			"SELECT version FROM recovery_job_schema WHERE id = 1",
		).one().version;
		if (version !== RECOVERY_JOB_SCHEMA_VERSION) throw new Error("unsupported recovery job schema");
		this.initialized = true;
	}

	load(): RecoveryJobRecord | null {
		this.initializeSchema();
		const row = this.storage.sql.exec<JobRow>("SELECT * FROM job_state WHERE id = 1").toArray()[0];
		return row ? fromJobRow(row) : null;
	}

	initialize(input: RecoveryJobInitialization): { record: RecoveryJobRecord; created: boolean } {
		this.initializeSchema();
		return this.storage.transactionSync(() => {
			const current = this.load();
			if (current) {
				const same = current.jobId === input.jobId
					&& current.vaultId === input.vaultId
					&& current.vaultGeneration === input.vaultGeneration
					&& current.kind === input.kind
					&& current.boundarySequence === (input.boundarySequence ?? null)
					&& current.capability === (input.capability ?? null)
					&& current.capabilityExpiresAt === (input.capabilityExpiresAt ?? null)
					&& JSON.stringify(this.getMetadata("descriptor") ?? {}) === JSON.stringify(input.metadata);
				if (!same) throw new Error("recovery_job_initialization_mismatch");
				return { record: current, created: false };
			}
			this.storage.sql.exec(
				`INSERT INTO job_state(
					id, job_id, vault_id, vault_generation, kind, state, boundary_sequence, capability,
					capability_expires_at, created_at, updated_at
				) VALUES (1, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
				input.jobId, input.vaultId, input.vaultGeneration, input.kind, input.boundarySequence ?? null,
				input.capability ?? null, input.capabilityExpiresAt ?? null, input.createdAt, input.createdAt,
			);
			this.setMetadata("descriptor", input.metadata);
			const created = this.load();
			if (!created) throw new Error("failed to initialize recovery job");
			return { record: created, created: true };
		});
	}

	getMetadata(key: string): Record<string, unknown> | null {
		this.initializeSchema();
		const row = this.storage.sql.exec<{ value_json: string }>(
			"SELECT value_json FROM job_metadata WHERE key = ? LIMIT 1", key,
		).toArray()[0];
		return row ? parseMetadata(row.value_json) : null;
	}

	getParsedMetadata<T>(key: string, parser: (value: unknown) => T): T | null {
		const metadata = this.getMetadata(key);
		return metadata === null ? null : parser(metadata);
	}

	setMetadata(key: string, value: object): void {
		this.initializeSchema();
		this.storage.sql.exec(
			`INSERT INTO job_metadata(key, value_json) VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
			key, JSON.stringify(value),
		);
	}

	deleteMetadata(key: string): void {
		this.initializeSchema();
		this.storage.sql.exec("DELETE FROM job_metadata WHERE key = ?", key);
	}

	update(expectedRevision: number, patch: Partial<Omit<RecoveryJobRecord, "jobId" | "vaultId" | "vaultGeneration" | "kind" | "createdAt" | "revision">> & { updatedAt: number }): RecoveryJobRecord | null {
		this.initializeSchema();
		const current = this.load();
		if (!current) return null;
		if (current.revision !== expectedRevision) return null;
		const next: RecoveryJobRecord = { ...current, ...patch, revision: current.revision + 1 };
		const result = this.storage.sql.exec(
			`UPDATE job_state SET state = ?, boundary_sequence = ?, capability = ?, capability_expires_at = ?,
			 cursor = ?, processed_entries = ?, total_entries = ?, content_objects_written = ?,
			 content_objects_reused = ?, manifest_nodes_written = ?, bytes_read = ?, bytes_written = ?,

			 retry_count = ?, next_attempt_at = ?, error_code = ?, error_ref = ?, internal_error = ?,
			 cancel_requested = ?, alarm_invocations = ?, deleted_objects = ?, deleted_bytes = ?,
			 updated_at = ?, completed_at = ?, revision = ? WHERE id = 1 AND revision = ?`,
			next.state, next.boundarySequence, next.capability, next.capabilityExpiresAt,
			next.cursor, next.processedEntries, next.totalEntries, next.contentObjectsWritten,
			next.contentObjectsReused, next.manifestNodesWritten, next.bytesRead, next.bytesWritten,
			next.retryCount, next.nextAttemptAt, next.errorCode, next.errorRef, next.internalError,
			next.cancelRequested ? 1 : 0, next.alarmInvocations, next.deletedObjects, next.deletedBytes,
			next.updatedAt, next.completedAt, next.revision, expectedRevision,
		);
		return result.rowsWritten === 1 ? next : null;
	}

	requestCancellation(now: number): RecoveryJobRecord | null {
		for (;;) {
			const current = this.load();
			if (!current || isTerminalRecoveryState(current.state)) return current;
			const updated = this.update(current.revision, { cancelRequested: true, updatedAt: now });
			if (updated) return updated;
		}
	}

	putArtifact(artifact: RecoveryJobArtifact): RecoveryJobArtifact {
		this.initializeSchema();
		return this.storage.transactionSync(() => {
			const existing = this.getArtifact(artifact.artifactKind, artifact.logicalKey);
			if (existing) {
				if (JSON.stringify(existing) !== JSON.stringify(artifact)) {
					throw new Error("recovery_artifact_identity_collision");
				}
				return existing;
			}
			this.storage.sql.exec(
				`INSERT INTO job_artifacts(artifact_kind, logical_key, object_key, object_hash, entries, bytes, metadata_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				artifact.artifactKind, artifact.logicalKey, artifact.objectKey, artifact.objectHash,
				artifact.entries, artifact.bytes, artifact.metadata === null ? null : JSON.stringify(artifact.metadata),
			);
			return artifact;
		});
	}

	getArtifact(artifactKind: string, logicalKey: string): RecoveryJobArtifact | null {
		this.initializeSchema();
		const row = this.storage.sql.exec<{
			artifact_kind: string; logical_key: string; object_key: string; object_hash: string;
			entries: number | null; bytes: number | null; metadata_json: string | null;
		}>(
			"SELECT * FROM job_artifacts WHERE artifact_kind = ? AND logical_key = ? LIMIT 1",
			artifactKind, logicalKey,
		).toArray()[0];
		return row ? {
			artifactKind: row.artifact_kind,
			logicalKey: row.logical_key,
			objectKey: row.object_key,
			objectHash: row.object_hash,
			entries: row.entries,
			bytes: row.bytes,
			metadata: parseMetadata(row.metadata_json),
		} : null;
	}

	listArtifacts(artifactKind: string): RecoveryJobArtifact[] {
		this.initializeSchema();
		return this.storage.sql.exec<{
			artifact_kind: string; logical_key: string; object_key: string; object_hash: string;
			entries: number | null; bytes: number | null; metadata_json: string | null;
		}>(
			"SELECT * FROM job_artifacts WHERE artifact_kind = ? ORDER BY logical_key", artifactKind,
		).toArray().map((row) => ({
			artifactKind: row.artifact_kind, logicalKey: row.logical_key, objectKey: row.object_key,
			objectHash: row.object_hash, entries: row.entries, bytes: row.bytes,
			metadata: parseMetadata(row.metadata_json),
		}));
	}

	getReconstruction(): ReconstructionProgress | null {
		this.initializeSchema();
		const row = this.storage.sql.exec<{
			body_id: string; generation: number; recipe_id: string; expected_content_hash: string;
			expected_size: number; cursor: string; staging_key: string | null; staging_hash: string | null;
			encoded_bytes: number; attempts: number;
		}>("SELECT * FROM reconstruction_progress WHERE id = 1").toArray()[0];
		return row ? {
			bodyId: row.body_id, generation: row.generation, recipeId: row.recipe_id,
			expectedContentHash: row.expected_content_hash, expectedSize: row.expected_size,
			cursor: row.cursor, stagingKey: row.staging_key, stagingHash: row.staging_hash,
			encodedBytes: row.encoded_bytes, attempts: row.attempts,
		} : null;
	}

	setReconstruction(progress: ReconstructionProgress): void {
		this.initializeSchema();
		this.storage.sql.exec(
			`INSERT INTO reconstruction_progress(
			 id, body_id, generation, recipe_id, expected_content_hash, expected_size, cursor,
			 staging_key, staging_hash, encoded_bytes, attempts
			) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET body_id = excluded.body_id, generation = excluded.generation,
			 recipe_id = excluded.recipe_id, expected_content_hash = excluded.expected_content_hash,
			 expected_size = excluded.expected_size, cursor = excluded.cursor, staging_key = excluded.staging_key,
			 staging_hash = excluded.staging_hash, encoded_bytes = excluded.encoded_bytes, attempts = excluded.attempts`,
			progress.bodyId, progress.generation, progress.recipeId, progress.expectedContentHash,
			progress.expectedSize, progress.cursor, progress.stagingKey, progress.stagingHash,
			progress.encodedBytes, progress.attempts,
		);
	}

	clearReconstruction(): void {
		this.initializeSchema();
		this.storage.sql.exec("DELETE FROM reconstruction_progress WHERE id = 1");
	}

	putDefect(defect: RecoveryDefect): void {
		this.initializeSchema();
		this.storage.sql.exec(
			`INSERT INTO job_defects(logical_key, kind, code, reference, metadata_json) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(logical_key) DO UPDATE SET kind = excluded.kind, code = excluded.code,
			 reference = excluded.reference, metadata_json = excluded.metadata_json`,
			defect.logicalKey, defect.kind, defect.code, defect.reference, JSON.stringify(defect.metadata),
		);
	}

	getDefect(logicalKey: string): RecoveryDefect | null {
		this.initializeSchema();
		const row = this.storage.sql.exec<{
			logical_key: string; kind: RecoveryDefect["kind"]; code: string; reference: string; metadata_json: string;
		}>(
			"SELECT logical_key, kind, code, reference, metadata_json FROM job_defects WHERE logical_key = ? LIMIT 1",
			logicalKey,
		).toArray()[0];
		return row ? {
			logicalKey: row.logical_key,
			kind: row.kind,
			code: row.code,
			reference: row.reference,
			metadata: parseMetadata(row.metadata_json) ?? {},
		} : null;
	}

	defectCount(): number {
		this.initializeSchema();
		return this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM job_defects").one().count;
	}

	addGcMarks(marks: readonly GcMark[]): number {
		this.initializeSchema();
		return this.storage.transactionSync(() => {
			let added = 0;
			for (const mark of marks) {
				added += this.storage.sql.exec(
					"INSERT OR IGNORE INTO gc_marks(epoch, domain, object_key_hash) VALUES (?, ?, ?)",
					mark.epoch, mark.domain, mark.objectKeyHash,
				).rowsWritten;
			}
			return added;
		});
	}

	isGcMarked(epoch: number, domain: GcMark["domain"], objectKeyHash: string): boolean {
		this.initializeSchema();
		return this.storage.sql.exec<{ found: number }>(
			"SELECT 1 AS found FROM gc_marks WHERE epoch = ? AND domain = ? AND object_key_hash = ? LIMIT 1",
			epoch, domain, objectKeyHash,
		).toArray().length === 1;
	}

	clearGcMarks(epoch: number): void {
		this.initializeSchema();
		this.storage.sql.exec("DELETE FROM gc_marks WHERE epoch = ?", epoch);
	}

	enqueueGcFrontier(entries: ReadonlyArray<{ objectKey: string; domain: GcMark["domain"]; tree?: "active" | "deleted" | "attachments" }>): number {
		this.initializeSchema();
		return this.storage.transactionSync(() => {
			let inserted = 0;
			for (const entry of entries) {
				inserted += this.storage.sql.exec(
					"INSERT OR IGNORE INTO gc_frontier(object_key, domain, tree, processed) VALUES (?, ?, ?, 0)",
					entry.objectKey, entry.domain, entry.tree ?? null,
				).rowsWritten;
			}
			return inserted;
		});
	}

	nextGcFrontier(): { objectKey: string; domain: GcMark["domain"]; tree?: "active" | "deleted" | "attachments" } | null {
		this.initializeSchema();
		const row = this.storage.sql.exec<{
			object_key: string; domain: GcMark["domain"]; tree: "active" | "deleted" | "attachments" | null;
		}>(
			"SELECT object_key, domain, tree FROM gc_frontier WHERE processed = 0 ORDER BY object_key LIMIT 1",
		).toArray()[0];
		return row ? {
			objectKey: row.object_key,
			domain: row.domain,
			...(row.tree === null ? {} : { tree: row.tree }),
		} : null;
	}

	completeGcFrontier(objectKey: string): void {
		this.initializeSchema();
		this.storage.sql.exec("UPDATE gc_frontier SET processed = 1 WHERE object_key = ?", objectKey);
	}

	clearGcFrontier(): void {
		this.initializeSchema();
		this.storage.sql.exec("DELETE FROM gc_frontier");
	}

	enqueueManifestFrontier(entries: ReadonlyArray<{ tree: "active" | "deleted" | "attachments"; logicalPrefix: string; nodeHash: string }>): number {
		this.initializeSchema();
		return this.storage.transactionSync(() => {
			let inserted = 0;
			for (const entry of entries) {
				inserted += this.storage.sql.exec(
					`INSERT OR IGNORE INTO manifest_frontier(tree, logical_prefix, node_hash, processed)
					 VALUES (?, ?, ?, 0)`,
					entry.tree, entry.logicalPrefix, entry.nodeHash,
				).rowsWritten;
			}
			return inserted;
		});
	}

	listManifestFrontier(limit: number): Array<{ tree: "active" | "deleted" | "attachments"; logicalPrefix: string; nodeHash: string }> {
		this.initializeSchema();
		if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 128) throw new Error("invalid manifest frontier limit");
		return this.storage.sql.exec<{
			tree: "active" | "deleted" | "attachments"; logical_prefix: string; node_hash: string;
		}>(
			`SELECT tree, logical_prefix, node_hash FROM manifest_frontier
			 WHERE processed = 0 ORDER BY tree, logical_prefix LIMIT ?`,
			limit,
		).toArray().map((row) => ({ tree: row.tree, logicalPrefix: row.logical_prefix, nodeHash: row.node_hash }));
	}

	nextManifestFrontier(): { tree: "active" | "deleted" | "attachments"; logicalPrefix: string; nodeHash: string } | null {
		return this.listManifestFrontier(1)[0] ?? null;
	}

	completeManifestFrontier(tree: string, logicalPrefix: string): void {
		this.initializeSchema();
		this.storage.sql.exec(
			"UPDATE manifest_frontier SET processed = 1 WHERE tree = ? AND logical_prefix = ?",
			tree, logicalPrefix,
		);
	}

	clearManifestFrontier(): void {
		this.initializeSchema();
		this.storage.sql.exec("DELETE FROM manifest_frontier");
	}

	putRestoreItems(items: readonly StoredRestoreItem[]): number {
		this.initializeSchema();
		return this.storage.transactionSync(() => {
			let inserted = 0;
			for (const item of items) {
				const existing = this.getRestoreItem(item.itemId);
				if (existing) {
					const immutableExisting = { ...existing, outcome: null, errorCode: null };
					const immutableInput = { ...item, outcome: null, errorCode: null };
					if (JSON.stringify(immutableExisting) !== JSON.stringify(immutableInput)) {
						throw new Error("restore_item_identity_collision");
					}
					continue;
				}
				inserted += this.storage.sql.exec(
					`INSERT INTO restore_items(item_id, cursor_order, kind, path, content_hash, size, outcome, error_code, metadata_json)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					item.itemId, item.cursorOrder, item.kind, item.path, item.contentHash, item.size,
					item.outcome, item.errorCode, JSON.stringify(item.metadata),
				).rowsWritten;
			}
			return inserted;
		});
	}

	getRestoreItem(itemId: string): StoredRestoreItem | null {
		this.initializeSchema();
		const row = this.storage.sql.exec<{
			item_id: string; cursor_order: number; kind: "markdown" | "attachment"; path: string;
			content_hash: string; size: number; outcome: RestoreItemOutcome | null; error_code: string | null;
			metadata_json: string;
		}>("SELECT * FROM restore_items WHERE item_id = ? LIMIT 1", itemId).toArray()[0];
		return row ? {
			itemId: row.item_id, cursorOrder: row.cursor_order, kind: row.kind, path: row.path,
			contentHash: row.content_hash, size: row.size, outcome: row.outcome, errorCode: row.error_code,
			metadata: parseMetadata(row.metadata_json) ?? {},
		} : null;
	}

	listRestoreItems(afterOrder: number, limit: number, onlyPending = false): StoredRestoreItem[] {
		this.initializeSchema();
		const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
		const where = onlyPending ? "AND outcome IS NULL" : "";
		return this.storage.sql.exec<{
			item_id: string; cursor_order: number; kind: "markdown" | "attachment"; path: string;
			content_hash: string; size: number; outcome: RestoreItemOutcome | null; error_code: string | null;
			metadata_json: string;
		}>(
			`SELECT * FROM restore_items WHERE cursor_order > ? ${where} ORDER BY cursor_order LIMIT ?`,
			afterOrder, bounded,
		).toArray().map((row) => ({
			itemId: row.item_id, cursorOrder: row.cursor_order, kind: row.kind, path: row.path,
			contentHash: row.content_hash, size: row.size, outcome: row.outcome, errorCode: row.error_code,
			metadata: parseMetadata(row.metadata_json) ?? {},
		}));
	}

	acknowledgeRestoreItem(itemId: string, outcome: RestoreItemOutcome, errorCode: string | null): boolean {
		this.initializeSchema();
		return this.storage.transactionSync(() => {
			const current = this.getRestoreItem(itemId);
			if (!current) return false;
			if (current.outcome !== null) return current.outcome === outcome && current.errorCode === errorCode;
			const update = this.storage.sql.exec(
				"UPDATE restore_items SET outcome = ?, error_code = ? WHERE item_id = ? AND outcome IS NULL",
				outcome, errorCode, itemId,
			);
			update.toArray();
			const persisted = this.getRestoreItem(itemId);
			return !!persisted && persisted.outcome === outcome && persisted.errorCode === errorCode;
		});
	}

	restoreCounts(): { total: number; terminal: number } {
		this.initializeSchema();
		return this.storage.sql.exec<{ total: number; terminal: number }>(
			"SELECT COUNT(*) AS total, COUNT(outcome) AS terminal FROM restore_items",
		).one();
	}

	deleteOperationalState(): void {
		this.initializeSchema();
		this.storage.transactionSync(() => {
			for (const table of ["reconstruction_progress", "job_defects", "job_artifacts", "gc_marks", "gc_frontier", "manifest_frontier", "restore_items", "job_metadata"]) {
				this.storage.sql.exec(`DELETE FROM ${table}`);
			}
		});
	}

	static safeInternalError = safeInternalError;
}
