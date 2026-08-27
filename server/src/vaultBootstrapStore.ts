import { VaultCatalogStore } from "./vaultCatalogStore";

export const DEFAULT_SOFT_TTL_MS = 60 * 60_000;
export const DEFAULT_HARD_TTL_MS = 24 * 60 * 60_000;

export type HistoryPinKind = "capture" | "bootstrap";
export type VaultOperationKind = "bootstrap";

export interface HistoryPin {
	pinId: string;
	kind: HistoryPinKind;
	boundarySequence: number;
	createdAt: number;
	softExpiresAt: number;
	hardExpiresAt: number;
	lastProgressAt: number;
	progress: number;
}

export interface VaultOperation {
	operationId: string;
	kind: VaultOperationKind;
	boundarySequence: number;
	state: "running" | "complete" | "failed";
	artifactKey: string | null;
	artifactHash: string | null;
	createdAt: number;
	updatedAt: number;
	error: string | null;
	progressCursor: string | null;
}

export interface VaultOperationPage {
	operationId: string;
	pageIndex: number;
	cursor: string;
	artifactKey: string;
	artifactHash: string;
	entryCount: number;
}

export interface ContentObjectRecord {
	contentHash: string;
	artifactKey: string;
	verifiedAt: number;
}

export interface HistoryPinHealth {
	active: number;
	softExpired: number;
	hardExpired: number;
	oldestActiveAgeMs: number | null;
	oldestProgressAgeMs: number | null;
}

function randomId(): string {
	return crypto.randomUUID();
}

export function isValidOperationId(value: string): boolean {
	return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

/** Bootstrap operations, pages, history pins, and content-object boundaries. */
export class VaultBootstrapStore extends VaultCatalogStore {
	createPin(input: {
		kind: HistoryPinKind;
		boundarySequence?: number;
		softTtlMs?: number;
		hardTtlMs?: number;
		now?: number;
		pinId?: string;
	}): HistoryPin {
		this.initialize();
		const now = input.now ?? Date.now();
		const softTtl = input.softTtlMs ?? DEFAULT_SOFT_TTL_MS;
		const hardTtl = input.hardTtlMs ?? DEFAULT_HARD_TTL_MS;
		if (softTtl <= 0 || hardTtl < softTtl) throw new Error("invalid pin TTLs");
		const pin: HistoryPin = {
			pinId: input.pinId ?? randomId(),
			kind: input.kind,
			boundarySequence: input.boundarySequence ?? this.currentSequence(),
			createdAt: now,
			softExpiresAt: now + softTtl,
			hardExpiresAt: now + hardTtl,
			lastProgressAt: now,
			progress: 0,
		};
		this.storage.sql.exec(
			`INSERT INTO vault_history_pins(
			 pin_id, kind, boundary_sequence, created_at, soft_expires_at,
			 hard_expires_at, last_progress_at, progress
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			pin.pinId,
			pin.kind,
			pin.boundarySequence,
			pin.createdAt,
			pin.softExpiresAt,
			pin.hardExpiresAt,
			pin.lastProgressAt,
			pin.progress,
		).toArray();
		return pin;
	}

	renewPin(pinId: string, progress: number, softTtlMs = DEFAULT_SOFT_TTL_MS, now = Date.now()): HistoryPin {
		this.initialize();
		const existing = this.getPin(pinId);
		if (!existing) throw new Error("pin not found");
		if (now >= existing.hardExpiresAt) throw new Error("pin hard-expired");
		if (progress <= existing.progress) return existing;
		const softExpiresAt = Math.min(existing.hardExpiresAt, now + softTtlMs);
		this.storage.sql.exec(
			`UPDATE vault_history_pins
			 SET progress = ?, last_progress_at = ?, soft_expires_at = ?
			 WHERE pin_id = ?`,
			progress,
			now,
			softExpiresAt,
			pinId,
		).toArray();
		return { ...existing, progress, lastProgressAt: now, softExpiresAt };
	}

	releasePin(pinId: string): boolean {
		this.initialize();
		const cursor = this.storage.sql.exec("DELETE FROM vault_history_pins WHERE pin_id = ?", pinId);
		cursor.toArray();
		return cursor.rowsWritten > 0;
	}

	getPin(pinId: string): HistoryPin | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			pin_id: string; kind: HistoryPinKind; boundary_sequence: number; created_at: number;
			soft_expires_at: number; hard_expires_at: number; last_progress_at: number; progress: number;
		}>("SELECT * FROM vault_history_pins WHERE pin_id = ?", pinId).toArray()[0];
		return row ? this.mapPin(row) : null;
	}

	activePins(now = Date.now()): HistoryPin[] {
		this.initialize();
		return this.storage.sql.exec<{
			pin_id: string; kind: HistoryPinKind; boundary_sequence: number; created_at: number;
			soft_expires_at: number; hard_expires_at: number; last_progress_at: number; progress: number;
		}>(
			"SELECT * FROM vault_history_pins WHERE hard_expires_at > ? ORDER BY boundary_sequence",
			now,
		).toArray().map((row) => this.mapPin(row));
	}

	pruneExpiredPins(now = Date.now()): number {
		return this.cleanupStuckPins(now).released;
	}

	beginPinnedOperation(input: {
		operationId?: string;
		kind: VaultOperationKind;
		boundarySequence?: number;
		softTtlMs?: number;
		hardTtlMs?: number;
		now?: number;
	}): { operation: VaultOperation; pin: HistoryPin } {
		this.initialize();
		const now = input.now ?? Date.now();
		const softTtl = input.softTtlMs ?? DEFAULT_SOFT_TTL_MS;
		const hardTtl = input.hardTtlMs ?? DEFAULT_HARD_TTL_MS;
		if (softTtl <= 0 || hardTtl < softTtl) throw new Error("invalid operation TTLs");
		const operationId = input.operationId ?? randomId();
		if (!isValidOperationId(operationId)) throw new Error("invalid operation ID");
		const boundarySequence = input.boundarySequence ?? this.currentSequence();
		const existing = this.getOperation(operationId);
		if (existing) {
			if (existing.kind !== input.kind) throw new Error("operation ID belongs to a different operation kind");
			const pin = this.getPin(operationId);
			if (!pin) throw new Error("operation exists without its history pin");
			if (pin.kind !== input.kind) throw new Error("operation pin kind mismatch");
			return { operation: existing, pin };
		}
		const pin: HistoryPin = {
			pinId: operationId,
			kind: input.kind,
			boundarySequence,
			createdAt: now,
			softExpiresAt: now + softTtl,
			hardExpiresAt: now + hardTtl,
			lastProgressAt: now,
			progress: 0,
		};
		const operation: VaultOperation = {
			operationId,
			kind: input.kind,
			boundarySequence,
			state: "running",
			artifactKey: null,
			artifactHash: null,
			createdAt: now,
			updatedAt: now,
			error: null,
			progressCursor: null,
		};
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`INSERT INTO vault_history_pins(
				 pin_id, kind, boundary_sequence, created_at, soft_expires_at,
				 hard_expires_at, last_progress_at, progress
				) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
				operationId,
				input.kind,
				boundarySequence,
				now,
				pin.softExpiresAt,
				pin.hardExpiresAt,
				now,
			).toArray();
			this.storage.sql.exec(
				`INSERT INTO vault_operations(
				 operation_id, kind, boundary_sequence, state, created_at, updated_at
				) VALUES (?, ?, ?, 'running', ?, ?)`,
				operationId,
				input.kind,
				boundarySequence,
				now,
				now,
			).toArray();
		});
		return { operation, pin };
	}

	getOperation(operationId: string): VaultOperation | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			operation_id: string; kind: VaultOperationKind; boundary_sequence: number;
			state: "running" | "complete" | "failed"; artifact_key: string | null;
			artifact_hash: string | null; created_at: number; updated_at: number; error: string | null;
			progress_cursor: string | null;
		}>("SELECT * FROM vault_operations WHERE operation_id = ?", operationId).toArray()[0];
		return row ? {
			operationId: row.operation_id,
			kind: row.kind,
			boundarySequence: row.boundary_sequence,
			state: row.state,
			artifactKey: row.artifact_key,
			artifactHash: row.artifact_hash,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			error: row.error,
			progressCursor: row.progress_cursor,
		} : null;
	}

	runningOperation(kind: VaultOperationKind): VaultOperation | null {
		this.initialize();
		const row = this.storage.sql.exec<{ operation_id: string }>(
			"SELECT operation_id FROM vault_operations WHERE kind = ? AND state = 'running' ORDER BY created_at LIMIT 1",
			kind,
		).toArray()[0];
		return row ? this.getOperation(row.operation_id) : null;
	}

	resumeFailedOperation(operationId: string, now = Date.now()): VaultOperation {
		this.initialize();
		const pin = this.getPin(operationId);
		if (!pin || now >= pin.hardExpiresAt) throw new Error("operation cannot resume without an active pin");
		const update = this.storage.sql.exec(
			"UPDATE vault_operations SET state = 'running', error = NULL, updated_at = ? WHERE operation_id = ? AND state = 'failed'",
			now,
			operationId,
		);
		update.toArray();
		const operation = this.getOperation(operationId);
		if (!operation) throw new Error("operation not found");
		return operation;
	}

	stageOperationArtifact(operationId: string, artifactKey: string, artifactHash: string, now = Date.now()): VaultOperation {
		this.initialize();
		const update = this.storage.sql.exec(
			`UPDATE vault_operations
			 SET artifact_key = ?, artifact_hash = ?, updated_at = ?
			 WHERE operation_id = ? AND state IN ('running', 'failed')`,
			artifactKey,
			artifactHash,
			now,
			operationId,
		);
		update.toArray();
		if (update.rowsWritten === 0) throw new Error("operation not found or already complete");
		const operation = this.getOperation(operationId);
		if (!operation) throw new Error("staged operation disappeared");
		return operation;
	}

	listOperations(kind?: VaultOperationKind): VaultOperation[] {
		this.initialize();
		const rows = kind
			? this.storage.sql.exec<{ operation_id: string }>(
				"SELECT operation_id FROM vault_operations WHERE kind = ? ORDER BY created_at",
				kind,
			).toArray()
			: this.storage.sql.exec<{ operation_id: string }>(
				"SELECT operation_id FROM vault_operations ORDER BY created_at",
			).toArray();
		return rows.map((row) => this.getOperation(row.operation_id)).filter((operation): operation is VaultOperation => operation !== null);
	}

	deleteCompletedOperation(operationId: string, kind: VaultOperationKind): boolean {
		this.initialize();
		let deleted = false;
		this.storage.transactionSync(() => {
			const operation = this.getOperation(operationId);
			if (!operation || operation.kind !== kind || operation.state !== "complete") return;
			this.storage.sql.exec(
				"DELETE FROM vault_operation_pages WHERE operation_id = ?",
				operationId,
			).toArray();
			const cursor = this.storage.sql.exec(
				"DELETE FROM vault_operations WHERE operation_id = ? AND kind = ? AND state = 'complete'",
				operationId,
				kind,
			);
			cursor.toArray();
			deleted = cursor.rowsWritten > 0;
		});
		return deleted;
	}

	deleteFailedOperation(operationId: string, kind: VaultOperationKind): boolean {
		this.initialize();
		let deleted = false;
		this.storage.transactionSync(() => {
			const operation = this.getOperation(operationId);
			if (!operation || operation.kind !== kind || operation.state !== "failed" || this.getPin(operationId)) return;
			this.storage.sql.exec(
				"DELETE FROM vault_operation_pages WHERE operation_id = ?",
				operationId,
			).toArray();
			const cursor = this.storage.sql.exec(
				"DELETE FROM vault_operations WHERE operation_id = ? AND kind = ? AND state = 'failed'",
				operationId,
				kind,
			);
			cursor.toArray();
			deleted = cursor.rowsWritten > 0;
		});
		return deleted;
	}

	completePinnedOperation(operationId: string, artifactKey: string, artifactHash: string, now = Date.now()): VaultOperation {
		this.initialize();
		this.storage.transactionSync(() => {
			const update = this.storage.sql.exec(

				`UPDATE vault_operations SET state = 'complete', artifact_key = ?,
				 artifact_hash = ?, updated_at = ?, error = NULL WHERE operation_id = ?`,
				artifactKey,
				artifactHash,
				now,
				operationId,
			);
			update.toArray();
			if (update.rowsWritten === 0) throw new Error("operation not found");
			this.storage.sql.exec("DELETE FROM vault_history_pins WHERE pin_id = ?", operationId).toArray();
		});
		const operation = this.getOperation(operationId);
		if (!operation) throw new Error("completed operation disappeared");
		return operation;
	}

	failPinnedOperation(operationId: string, error: string, now = Date.now()): VaultOperation {
		this.initialize();
		const update = this.storage.sql.exec(
			"UPDATE vault_operations SET state = 'failed', error = ?, updated_at = ? WHERE operation_id = ?",
			error,
			now,
			operationId,
		);
		update.toArray();
		if (update.rowsWritten === 0) throw new Error("operation not found");
		const operation = this.getOperation(operationId);
		if (!operation) throw new Error("failed operation disappeared");
		return operation;
	}

	recordOperationPage(page: VaultOperationPage, progress: number, now = Date.now()): void {
		this.initialize();
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`INSERT OR IGNORE INTO vault_operation_pages(
				 operation_id, page_index, cursor, artifact_key, artifact_hash, entry_count
				) VALUES (?, ?, ?, ?, ?, ?)`,
				page.operationId,
				page.pageIndex,
				page.cursor,
				page.artifactKey,
				page.artifactHash,
				page.entryCount,
			).toArray();
			this.storage.sql.exec(
				"UPDATE vault_operations SET progress_cursor = ?, updated_at = ? WHERE operation_id = ?",
				page.cursor,
				now,
				page.operationId,
			).toArray();
		});
		this.renewPin(page.operationId, progress, DEFAULT_SOFT_TTL_MS, now);
	}

	listOperationPages(operationId: string): VaultOperationPage[] {
		this.initialize();
		return this.storage.sql.exec<{
			operation_id: string; page_index: number; cursor: string;
			artifact_key: string; artifact_hash: string; entry_count: number;
		}>(
			"SELECT * FROM vault_operation_pages WHERE operation_id = ? ORDER BY page_index",
			operationId,
		).toArray().map((row) => ({
			operationId: row.operation_id,
			pageIndex: row.page_index,
			cursor: row.cursor,
			artifactKey: row.artifact_key,
			artifactHash: row.artifact_hash,
			entryCount: row.entry_count,
		}));
	}

	contentObjectKey(contentHash: string): string | null {
		this.initialize();
		return this.storage.sql.exec<{ artifact_key: string }>(
			"SELECT artifact_key FROM vault_content_objects WHERE content_hash = ?",
			contentHash,
		).toArray()[0]?.artifact_key ?? null;
	}

	hasContentObject(contentHash: string): boolean {
		return this.contentObjectKey(contentHash) !== null;
	}

	recordContentObject(contentHash: string, artifactKey: string, verifiedAt = Date.now()): void {
		this.initialize();
		this.storage.sql.exec(
			`INSERT INTO vault_content_objects(content_hash, artifact_key, verified_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(content_hash) DO UPDATE SET
			 artifact_key = excluded.artifact_key,
			 verified_at = excluded.verified_at`,
			contentHash,
			artifactKey,
			verifiedAt,
		).toArray();
	}

	contentObjects(): ContentObjectRecord[] {
		this.initialize();
		return this.storage.sql.exec<{
			content_hash: string;
			artifact_key: string;
			verified_at: number;
		}>(
			"SELECT content_hash, artifact_key, verified_at FROM vault_content_objects ORDER BY content_hash",
		).toArray().map((row) => ({
			contentHash: row.content_hash,
			artifactKey: row.artifact_key,
			verifiedAt: row.verified_at,
		}));
	}

	forgetContentObject(contentHash: string): boolean {
		this.initialize();
		const cursor = this.storage.sql.exec(
			"DELETE FROM vault_content_objects WHERE content_hash = ?",
			contentHash,
		);
		cursor.toArray();
		return cursor.rowsWritten > 0;
	}

	historyPinHealth(now = Date.now()): HistoryPinHealth {
		this.initialize();
		const pins = this.storage.sql.exec<{
			pin_id: string;
			kind: HistoryPinKind;
			boundary_sequence: number;
			created_at: number;
			soft_expires_at: number;
			hard_expires_at: number;
			last_progress_at: number;
			progress: number;
		}>("SELECT * FROM vault_history_pins").toArray().map((row) => this.mapPin(row));
		const active = pins.filter((pin) => pin.hardExpiresAt > now);
		return {
			active: active.length,
			softExpired: active.filter((pin) => pin.softExpiresAt <= now).length,
			hardExpired: pins.length - active.length,
			oldestActiveAgeMs: active.length > 0 ? Math.max(...active.map((pin) => now - pin.createdAt)) : null,
			oldestProgressAgeMs: active.length > 0 ? Math.max(...active.map((pin) => now - pin.lastProgressAt)) : null,
		};
	}

	cleanupStuckPins(now = Date.now()): { released: number; failedOperations: number } {
		this.initialize();
		let released = 0;
		let failedOperations = 0;
		this.storage.transactionSync(() => {
			const fail = this.storage.sql.exec(
				`UPDATE vault_operations
				 SET state = 'failed', error = 'history pin hard-expired', updated_at = ?
				 WHERE state = 'running' AND operation_id IN (
				   SELECT pin_id FROM vault_history_pins WHERE hard_expires_at <= ?
				 )`,
				now,
				now,
			);
			fail.toArray();
			failedOperations = fail.rowsWritten;
			const remove = this.storage.sql.exec(
				"DELETE FROM vault_history_pins WHERE hard_expires_at <= ?",
				now,
			);
			remove.toArray();
			released = remove.rowsWritten;
		});
		return { released, failedOperations };
	}

	private mapPin(row: {
		pin_id: string; kind: HistoryPinKind; boundary_sequence: number; created_at: number;
		soft_expires_at: number; hard_expires_at: number; last_progress_at: number; progress: number;
	}): HistoryPin {
		return {
			pinId: row.pin_id,
			kind: row.kind,
			boundarySequence: row.boundary_sequence,
			createdAt: row.created_at,
			softExpiresAt: row.soft_expires_at,
			hardExpiresAt: row.hard_expires_at,
			lastProgressAt: row.last_progress_at,
			progress: row.progress,
		};
	}
}
