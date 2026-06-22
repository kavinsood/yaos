/**
 * PersistenceCoordinator: extracted save coordination logic for testability.
 *
 * This module handles the save orchestration that was previously embedded
 * in VaultSyncServer. By extracting it, we can test:
 * - append fails → checkpoint fallback succeeds
 * - append + checkpoint fail → lastPersistedStateVector does not advance
 * - queued saves cannot regress lastPersistedStateVector
 * - health transitions correctly
 */

import * as Y from "yjs";
import type { ChunkedDocStore, ChunkWriteStats, JournalStats } from "./chunkedDocStore.js";
import { bytesToHex } from "./hex.js";

export const CHECKPOINT_FALLBACK_AFTER_FAILURES = 2;
export const JOURNAL_COMPACT_MAX_ENTRIES = 50;
export const JOURNAL_COMPACT_MAX_BYTES = 1 * 1024 * 1024; // 1MB

export type PersistenceStatus = "healthy" | "degraded";

export interface PersistenceCoordinatorOptions {
	/** Number of consecutive append failures before checkpoint fallback. Default: 2 */
	checkpointFallbackAfterFailures?: number;
	/** Max journal entries before compaction. Default: 50 */
	journalCompactMaxEntries?: number;
	/** Max journal bytes before compaction. Default: 1MB */
	journalCompactMaxBytes?: number;
}

export interface PersistenceHealth {
	status: PersistenceStatus;
	lastSaveStartedAt: string | null;
	lastSaveSucceededAt: string | null;
	lastSaveFailedAt: string | null;
	lastSaveError: string | null;
	successfulSaveCount: number;
	failedSaveCount: number;
	consecutiveSaveFailures: number;
	pendingPersistence: boolean;
	queuedSaveCount: number;
	lastDeltaBytes: number | null;
	lastCheckpointUpdateBytes: number | null;
	lastStateVectorBytes: number | null;
	lastEncodeMs: number | null;
	lastStorageWriteMs: number | null;
	lastChunkPutMaxBytes: number | null;
	lastSavePhase: string | null;
	lastFailurePhase: string | null;
	lastPersistedStateVectorHash: string | null;
	journalEntryCount: number | null;
	journalBytes: number | null;
	checkpointFallbackCount: number;
	lastCompactionAt: string | null;
	lastCompactionReason: string | null;
	lastCompactionError: string | null;
}

export interface SaveResult {
	success: boolean;
	method: "append" | "checkpoint-fallback" | "immediate-fallback" | "skipped";
	error?: string;
	journalStats?: JournalStats;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function nowMs(): number {
	return Date.now();
}

/**
 * PersistenceCoordinator manages the save chain for a Y.Doc.
 * Extracted from VaultSyncServer for testability.
 */
export class PersistenceCoordinator {
	private saveChain: Promise<void> = Promise.resolve();
	private pendingUpdates: Uint8Array[] = [];
	private lastPersistedStateVector: Uint8Array | null = null;
	private consecutiveSaveFailures = 0;

	private readonly checkpointFallbackAfterFailures: number;
	private readonly journalCompactMaxEntries: number;
	private readonly journalCompactMaxBytes: number;

	readonly health: PersistenceHealth = {
		status: "healthy",
		lastSaveStartedAt: null,
		lastSaveSucceededAt: null,
		lastSaveFailedAt: null,
		lastSaveError: null,
		successfulSaveCount: 0,
		failedSaveCount: 0,
		consecutiveSaveFailures: 0,
		pendingPersistence: false,
		queuedSaveCount: 0,
		lastDeltaBytes: null,
		lastCheckpointUpdateBytes: null,
		lastStateVectorBytes: null,
		lastEncodeMs: null,
		lastStorageWriteMs: null,
		lastChunkPutMaxBytes: null,
		lastSavePhase: null,
		lastFailurePhase: null,
		lastPersistedStateVectorHash: null,
		journalEntryCount: null,
		journalBytes: null,
		checkpointFallbackCount: 0,
		lastCompactionAt: null,
		lastCompactionReason: null,
		lastCompactionError: null,
	};

	constructor(
		private readonly document: Y.Doc,
		private readonly store: ChunkedDocStore,
		private readonly trace?: (event: string, data: Record<string, unknown>) => void,
		options?: PersistenceCoordinatorOptions,
	) {
		this.checkpointFallbackAfterFailures =
			options?.checkpointFallbackAfterFailures ?? CHECKPOINT_FALLBACK_AFTER_FAILURES;
		this.journalCompactMaxEntries =
			options?.journalCompactMaxEntries ?? JOURNAL_COMPACT_MAX_ENTRIES;
		this.journalCompactMaxBytes =
			options?.journalCompactMaxBytes ?? JOURNAL_COMPACT_MAX_BYTES;
	}

	/** Set initial state vector from loaded state. */
	setInitialStateVector(sv: Uint8Array): void {
		this.lastPersistedStateVector = sv;
		this.health.lastPersistedStateVectorHash = bytesToHex(sv.slice(0, 16));
	}

	/** Get the last successfully persisted state vector. */
	getLastPersistedStateVector(): Uint8Array | null {
		return this.lastPersistedStateVector;
	}

	recordIncrementalUpdate(update: Uint8Array): void {
		if (update.byteLength === 0) return;
		this.pendingUpdates.push(update);
		this.health.pendingPersistence = true;
	}

	private setPhase(phase: string): void {
		this.health.lastSavePhase = phase;
	}

	private updateLastChunkWriteStats(): ChunkWriteStats | null {
		const stats = this.store.getLastWriteStats?.() ?? null;
		this.health.lastChunkPutMaxBytes = stats?.maxPutBytes ?? null;
		return stats;
	}

	private chunkTraceFields(stats: ChunkWriteStats | null): Record<string, number | null> {
		return {
			chunkCount: stats?.chunkCount ?? null,
			chunkMaxBytes: stats?.maxChunkBytes ?? null,
			chunkBackingBufferMaxBytes: stats?.maxBackingBufferBytes ?? null,
			chunkPutMaxBytes: stats?.maxPutBytes ?? null,
			chunkPutCount: stats?.putCount ?? null,
		};
	}

	private drainPendingUpdates(): Uint8Array[] {
		const updates = this.pendingUpdates;
		this.pendingUpdates = [];
		return updates;
	}

	private restorePendingUpdates(updates: Uint8Array[]): void {
		if (updates.length === 0) return;
		this.pendingUpdates = updates.concat(this.pendingUpdates);
		this.health.pendingPersistence = true;
	}

	/**
	 * Enqueue a save operation. Returns a promise that resolves when the save
	 * completes (successfully or not).
	 */
	enqueueSave(): Promise<SaveResult> {
		// Set pendingPersistence immediately at enqueue time
		this.health.queuedSaveCount++;
		this.health.pendingPersistence = true;

		const run = this.saveChain.then(async (): Promise<SaveResult> => {
			try {
				return await this.executeSave();
			} finally {
				this.health.queuedSaveCount = Math.max(0, this.health.queuedSaveCount - 1);
				// pendingPersistence is true if:
				// - more saves are queued, OR
				// - we're in degraded state (document has unpersisted state)
				// - incremental updates arrived while this save was running
				this.health.pendingPersistence =
					this.health.queuedSaveCount > 0
					|| this.health.status === "degraded"
					|| this.pendingUpdates.length > 0;
			}
		});

		// Keep chain resolved so future saves aren't blocked
		this.saveChain = run.then(() => {}).catch(() => {});
		return run;
	}

	private async executeSave(): Promise<SaveResult> {
		this.health.lastSaveStartedAt = new Date().toISOString();
		this.health.lastFailurePhase = null;
		this.health.lastEncodeMs = null;
		this.health.lastStorageWriteMs = null;
		this.health.lastCheckpointUpdateBytes = null;
		this.health.lastChunkPutMaxBytes = null;

		// Compute delta inside serialized save task
		const baseStateVector = this.lastPersistedStateVector;
		this.setPhase("encode_state_vector");
		const stateVectorStartedAt = nowMs();
		const currentStateVector = Y.encodeStateVector(this.document);
		this.health.lastStateVectorBytes = currentStateVector.byteLength;
		this.health.lastEncodeMs = nowMs() - stateVectorStartedAt;

		const pendingUpdates = this.drainPendingUpdates();
		if (baseStateVector && equalBytes(baseStateVector, currentStateVector) && pendingUpdates.length === 0) {
			this.setPhase("skipped_equal_sv");
			this.trace?.("save.skipped_equal_sv", {});
			return { success: true, method: "skipped" };
		}

		let delta: Uint8Array;
		if (pendingUpdates.length > 0) {
			this.setPhase("delta_incremental");
			const pendingBytes = pendingUpdates.reduce((sum, update) => sum + update.byteLength, 0);
			const mergeStartedAt = nowMs();
			delta = pendingUpdates.length === 1 ? pendingUpdates[0]! : Y.mergeUpdates(pendingUpdates);
			this.health.lastEncodeMs = (this.health.lastEncodeMs ?? 0) + (nowMs() - mergeStartedAt);
			this.trace?.("save.delta_computed", {
				source: "pending_incremental",
				pendingUpdateCount: pendingUpdates.length,
				pendingBytes,
				deltaBytes: delta.byteLength,
			});
		} else {
			this.setPhase("delta_fallback");
			const fallbackStartedAt = nowMs();
			delta = baseStateVector
				? Y.encodeStateAsUpdate(this.document, baseStateVector)
				: Y.encodeStateAsUpdate(this.document);
			this.health.lastEncodeMs = (this.health.lastEncodeMs ?? 0) + (nowMs() - fallbackStartedAt);
			this.trace?.("save.delta_fallback", { deltaBytes: delta.byteLength });
		}

		if (delta.byteLength === 0) {
			this.setPhase("skipped_empty_delta");
			this.trace?.("save.skipped_empty_delta", {});
			return { success: true, method: "skipped" };
		}

		this.health.lastDeltaBytes = delta.byteLength;

		// Strategy: checkpoint fallback only after repeated append failures.
		const useCheckpointFallback =
			this.consecutiveSaveFailures >= this.checkpointFallbackAfterFailures;

		if (useCheckpointFallback) {
			const result = await this.executeCheckpointFallback(delta);
			if (!result.success) {
				this.restorePendingUpdates(pendingUpdates);
			}
			return result;
		}

		// Normal path: journal append
		const result = await this.executeAppend(delta, currentStateVector);
		if (!result.success) {
			this.restorePendingUpdates(pendingUpdates);
		}
		return result;
	}

	private async executeCheckpointFallback(delta: Uint8Array): Promise<SaveResult> {
		const reason = "consecutive_failures";

		this.trace?.("save.checkpoint_fallback", {
			reason,
			deltaBytes: delta.byteLength,
			consecutiveFailures: this.consecutiveSaveFailures,
		});

		let chunkStats: ChunkWriteStats | null = null;
		try {
			this.setPhase("checkpoint_fallback_encode");
			const encodeStartedAt = nowMs();
			const checkpointUpdate = Y.encodeStateAsUpdate(this.document);
			const checkpointStateVector = Y.encodeStateVector(this.document);
			this.health.lastCheckpointUpdateBytes = checkpointUpdate.byteLength;
			this.health.lastStateVectorBytes = checkpointStateVector.byteLength;
			this.health.lastEncodeMs = (this.health.lastEncodeMs ?? 0) + (nowMs() - encodeStartedAt);
			const checkpointSvHash = bytesToHex(checkpointStateVector.slice(0, 16));

			this.setPhase("checkpoint_fallback_write");
			const storageStartedAt = nowMs();
			await this.store.rewriteCheckpoint(checkpointUpdate, checkpointStateVector);
			this.health.lastStorageWriteMs = nowMs() - storageStartedAt;
			chunkStats = this.updateLastChunkWriteStats();

			// Success — update state
			this.lastPersistedStateVector = checkpointStateVector;
			this.consecutiveSaveFailures = 0;
			this.health.status = "healthy";
			this.health.lastSaveSucceededAt = new Date().toISOString();
			this.health.lastSaveError = null; // Clear stale error on recovery
			this.health.successfulSaveCount++;
			this.health.lastDeltaBytes = delta.byteLength;
			this.health.lastPersistedStateVectorHash = checkpointSvHash;
			this.health.checkpointFallbackCount++;
			this.health.consecutiveSaveFailures = 0;

			const stats = await this.store.getJournalStats();
			this.health.journalEntryCount = stats.entryCount;
			this.health.journalBytes = stats.totalBytes;

			this.trace?.("save.checkpoint_fallback_succeeded", {
				persistedStateVectorHash: checkpointSvHash,
				checkpointUpdateBytes: checkpointUpdate.byteLength,
				stateVectorBytes: checkpointStateVector.byteLength,
				storageWriteMs: this.health.lastStorageWriteMs,
				...this.chunkTraceFields(chunkStats),
			});

			return { success: true, method: "checkpoint-fallback", journalStats: stats };
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			const errorClass = err instanceof Error ? err.constructor.name : typeof err;

			this.consecutiveSaveFailures++;
			this.health.lastSaveFailedAt = new Date().toISOString();
			this.health.lastSaveError = `${errorClass}: ${errorMessage} (checkpoint fallback)`;
			this.health.failedSaveCount++;
			this.health.consecutiveSaveFailures = this.consecutiveSaveFailures;
			this.health.status = "degraded";
			this.health.lastFailurePhase = this.health.lastSavePhase;

			this.trace?.("save.checkpoint_fallback_failed", {
				errorClass,
				message: errorMessage,
			});

			return { success: false, method: "checkpoint-fallback", error: errorMessage };
		}
	}

	private async executeAppend(
		delta: Uint8Array,
		currentStateVector: Uint8Array,
	): Promise<SaveResult> {
		let journalStats: JournalStats;
		let chunkStats: ChunkWriteStats | null = null;

		try {
			this.setPhase("append");
			const storageStartedAt = nowMs();
			journalStats = await this.store.appendUpdate(delta);
			this.health.lastStorageWriteMs = nowMs() - storageStartedAt;
			chunkStats = this.updateLastChunkWriteStats();
		} catch (appendErr) {
			const errorMessage = appendErr instanceof Error ? appendErr.message : String(appendErr);
			const errorClass = appendErr instanceof Error ? appendErr.constructor.name : typeof appendErr;

			this.consecutiveSaveFailures++;
			this.health.lastSaveFailedAt = new Date().toISOString();
			this.health.lastSaveError = `${errorClass}: ${errorMessage}`;
			this.health.failedSaveCount++;
			this.health.consecutiveSaveFailures = this.consecutiveSaveFailures;
			this.health.status = "degraded";
			this.health.lastFailurePhase = this.health.lastSavePhase;

			this.trace?.("save.append_failed", {
				errorClass,
				message: errorMessage,
				consecutiveFailures: this.consecutiveSaveFailures,
			});

			// Immediately attempt checkpoint fallback if threshold is reached
			if (this.consecutiveSaveFailures >= this.checkpointFallbackAfterFailures) {
				this.trace?.("save.immediate_checkpoint_fallback", {
					reason: "consecutive_failures_after_append",
					consecutiveFailures: this.consecutiveSaveFailures,
				});

				const fallbackResult = await this.executeImmediateFallback(delta);
				if (fallbackResult.success) {
					return fallbackResult;
				}
				// Fallback also failed — return fallback result (which has method: "immediate-fallback")
				return fallbackResult;
			}

			return { success: false, method: "append", error: errorMessage };
		}

		// Success — advance persisted state vector
		const svHash = bytesToHex(currentStateVector.slice(0, 16));
		this.lastPersistedStateVector = currentStateVector;
		this.consecutiveSaveFailures = 0;
		this.health.status = "healthy";
		this.health.lastSaveSucceededAt = new Date().toISOString();
		this.health.lastSaveError = null; // Clear stale error on recovery
		this.health.successfulSaveCount++;
		this.health.lastDeltaBytes = delta.byteLength;
		this.health.lastPersistedStateVectorHash = svHash;
		this.health.journalEntryCount = journalStats.entryCount;
		this.health.journalBytes = journalStats.totalBytes;
		this.health.consecutiveSaveFailures = 0;

		this.trace?.("save.append_succeeded", {
			journalEntryCount: journalStats.entryCount,
			journalBytes: journalStats.totalBytes,
			deltaBytes: delta.byteLength,
			persistedStateVectorHash: svHash,
			storageWriteMs: this.health.lastStorageWriteMs,
			...this.chunkTraceFields(chunkStats),
		});

		// Compaction if needed
		if (
			journalStats.entryCount > this.journalCompactMaxEntries ||
			journalStats.totalBytes > this.journalCompactMaxBytes
		) {
			this.scheduleCompaction(journalStats);
		}

		return { success: true, method: "append", journalStats };
	}

	private async executeImmediateFallback(delta: Uint8Array): Promise<SaveResult> {
		let chunkStats: ChunkWriteStats | null = null;
		try {
			this.setPhase("immediate_checkpoint_fallback_encode");
			const encodeStartedAt = nowMs();
			const checkpointUpdate = Y.encodeStateAsUpdate(this.document);
			const checkpointStateVector = Y.encodeStateVector(this.document);
			this.health.lastCheckpointUpdateBytes = checkpointUpdate.byteLength;
			this.health.lastStateVectorBytes = checkpointStateVector.byteLength;
			this.health.lastEncodeMs = (this.health.lastEncodeMs ?? 0) + (nowMs() - encodeStartedAt);
			const checkpointSvHash = bytesToHex(checkpointStateVector.slice(0, 16));

			this.setPhase("immediate_checkpoint_fallback_write");
			const storageStartedAt = nowMs();
			await this.store.rewriteCheckpoint(checkpointUpdate, checkpointStateVector);
			this.health.lastStorageWriteMs = nowMs() - storageStartedAt;
			chunkStats = this.updateLastChunkWriteStats();

			// Success
			this.lastPersistedStateVector = checkpointStateVector;
			this.consecutiveSaveFailures = 0;
			this.health.status = "healthy";
			this.health.lastSaveSucceededAt = new Date().toISOString();
			this.health.lastSaveError = null; // Clear stale error on recovery
			this.health.successfulSaveCount++;
			this.health.lastDeltaBytes = delta.byteLength;
			this.health.lastPersistedStateVectorHash = checkpointSvHash;
			this.health.checkpointFallbackCount++;
			this.health.consecutiveSaveFailures = 0;

			const stats = await this.store.getJournalStats();
			this.health.journalEntryCount = stats.entryCount;
			this.health.journalBytes = stats.totalBytes;

			this.trace?.("save.immediate_checkpoint_fallback_succeeded", {
				persistedStateVectorHash: checkpointSvHash,
				checkpointUpdateBytes: checkpointUpdate.byteLength,
				stateVectorBytes: checkpointStateVector.byteLength,
				storageWriteMs: this.health.lastStorageWriteMs,
				...this.chunkTraceFields(chunkStats),
			});

			return { success: true, method: "immediate-fallback", journalStats: stats };
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			const errorClass = err instanceof Error ? err.constructor.name : typeof err;
			this.health.lastFailurePhase = this.health.lastSavePhase;

			this.trace?.("save.immediate_checkpoint_fallback_failed", {
				errorClass,
				message: errorMessage,
			});

			return { success: false, method: "immediate-fallback", error: errorMessage };
		}
	}

	private scheduleCompaction(journalStats: JournalStats): void {
		this.saveChain = this.saveChain.then(async () => {
			await this.executeCompaction(journalStats);
		}).catch(() => {});
	}

	private async executeCompaction(journalStats: JournalStats): Promise<void> {
		const compactionReason =
			journalStats.entryCount > this.journalCompactMaxEntries
				? "entry_count_exceeded"
				: "byte_size_exceeded";

		try {
			this.setPhase("compaction_binary");
			const storageStartedAt = nowMs();
			const result = await this.store.compactJournalToCheckpoint();
			this.health.lastStorageWriteMs = nowMs() - storageStartedAt;
			const chunkStats = this.updateLastChunkWriteStats();
			const checkpointStateVector = result.stateVector;
			const checkpointSvHash = bytesToHex(checkpointStateVector.slice(0, 16));

			this.lastPersistedStateVector = checkpointStateVector;
			this.consecutiveSaveFailures = 0;
			this.health.status = "healthy";
			this.health.lastPersistedStateVectorHash = checkpointSvHash;
			this.health.lastCompactionAt = new Date().toISOString();
			this.health.lastCompactionReason = compactionReason;
			this.health.lastCompactionError = null;

			this.health.journalEntryCount = result.journalStats.entryCount;
			this.health.journalBytes = result.journalStats.totalBytes;

			this.trace?.("save.compaction_succeeded", {
				reason: compactionReason,
				persistedStateVectorHash: checkpointSvHash,
				stateVectorBytes: checkpointStateVector.byteLength,
				storageWriteMs: this.health.lastStorageWriteMs,
				...this.chunkTraceFields(chunkStats),
			});
		} catch (err) {
			// Compaction failure after successful append is NOT a data-loss event
			const errorMessage = err instanceof Error ? err.message : String(err);
			const errorClass = err instanceof Error ? err.constructor.name : typeof err;

			this.health.lastCompactionAt = new Date().toISOString();
			this.health.lastCompactionReason = compactionReason;
			this.health.lastCompactionError = `${errorClass}: ${errorMessage}`;
			this.health.lastFailurePhase = this.health.lastSavePhase;

			this.trace?.("save.compaction_failed", {
				reason: compactionReason,
				errorClass,
				message: errorMessage,
				note: "append was successful, data is durable, compaction can be retried",
			});
		}
	}
}
