import { canonicalJsonText } from "./recoveryCanonicalJson";
import { decodeSqlChunks } from "./vaultDocumentStore";
import { DEFAULT_SOFT_TTL_MS, VaultBootstrapStore } from "./vaultBootstrapStore";
import type { BodyLifecycle } from "./vaultCatalogStore";

export type RecoveryReason = "initial" | "daily" | "manual" | "pre-bulk-operation";
export type RecoveryCaptureState =
	| "initializing" | "queued" | "planning" | "materializing" | "building" | "publishing" | "retrying"
	| "complete" | "complete_with_gaps" | "failed" | "cancelled";
export type CapturePlanStream = "active" | "deleted" | "attachments";
export type RecoveryTree = CapturePlanStream;
export type RestoreSelection =
	| { kind: "all" }
	| { kind: "markdown-paths"; paths: string[] }
	| { kind: "attachment-paths"; paths: string[] }
	| { kind: "deleted-identities"; bodyIds: string[] };
export type CapturePlanEntry =
	| { kind: "active"; bodyId: string; fileId: string; canonicalPath: string; generation: number; contentHash: string; size: number }
	| { kind: "deleted"; bodyId: string; fileId: string; lastPath: string; generation: number; baselineContentHash: string; baselineSize: number; bodyReaped: boolean; deletedAtSequence: number }
	| { kind: "attachment"; canonicalPath: string; contentHash: string; size: number; mime: string | null };
export type RecoveryRootKind = "restore";
export type RestoreEntryState = "pending" | "body-durable" | "published" | "disk-settled" | "skipped" | "failed";

export interface CaptureDescriptor {
	captureId: string; requestId: string; vaultId: string; vaultGeneration: string; boundarySequence: number; rootGeneration: number; runtimeEpoch: string;
	reason: RecoveryReason; state: RecoveryCaptureState; jobId: string; capabilityHash: string; capabilityExpiresAt: number;
	pinSoftExpiresAt: number; pinHardExpiresAt: number; planDigest: string | null; deltaDigest: string | null;
	planComplete: boolean; gcEpoch: number | null; baseSnapshotId: string | null; plannedActiveFiles: number;
	plannedDeletedFiles: number; plannedAttachments: number; snapshotRootKey: string | null; snapshotRootHash: string | null;
	createdAt: number; updatedAt: number; error: string | null;
}

export interface BodyRecipeDescriptor {
	recipeId: string; bodyId: string; generation: number; expectedContentHash: string; expectedSize: number;
	encodedHistoryBytes: number; firstCursor: string;
}
export interface MaterializationLease { leaseId: string; ownerKind: "capture" | "projection"; ownerId: string; objectKeys: string[]; expiresAt: number }
export interface RecoveryDefectRecord {
	captureId: string; kind: "active" | "deleted" | "attachment"; identity: string; generation: number | null;
	code: string; referenceHash: string; createdAt: number;
}
export interface RecoverySnapshotCatalogEntry {
	snapshotId: string; boundarySequence: number; rootKey: string; rootHash: string; reason: RecoveryReason;
	pinned: boolean; createdAt: number; completedAt: number;
}
export interface RecoverySnapshotDependency { operationKind: "capture" | "restore"; operationId: string; snapshotId: string }
export interface GcEpoch { epoch: number; requestId: string; state: "marking" | "sweeping" | "complete" | "aborted"; markBoundarySequence: number; markStartedAt: number; markCompletedAt: number | null; sweepCompletedAt: number | null; deadlineAt: number }
export interface SweepLease { leaseId: string; epoch: number; ownerId: string; domain: "recovery" | "blob"; approvedKeys: string[]; expiresAt: number }
export interface RecoveryRoot {
	rootId: string; kind: RecoveryRootKind; manifestKey: string; manifestHash: string; state: "active" | "complete" | "failed";
	createdAt: number; updatedAt: number; error: string | null;
}
export interface DurableRestoreEntry {
	restoreId: string; path: string; snapshotContentHash: string; liveFingerprint: string | null; state: RestoreEntryState;
	fileId: string | null; bodyId: string | null; error: string | null; updatedAt: number;
}
export interface RestoreAuthority {
	restoreId: string; requestId: string; vaultId: string; vaultGeneration: string; snapshotId: string; selection: RestoreSelection;
	state: "initializing" | "active" | "complete" | "cancelled" | "failed"; jobId: string;
	capabilityHash: string; capabilityExpiresAt: number; createdAt: number; updatedAt: number;
}
export interface GcAuthority {
	epoch: number; requestId: string; vaultId: string; vaultGeneration: string; jobId: string; capabilityHash: string;
	capabilityExpiresAt: number; state: GcEpoch["state"]; markStartedAt: number; deadlineAt: number;
}

function parseRestoreSelection(value: string): RestoreSelection {
	const parsed: unknown = JSON.parse(value);
	if (!parsed || typeof parsed !== "object" || !("kind" in parsed) || typeof parsed.kind !== "string") {
		throw new Error("corrupt restore selection");
	}
	if (parsed.kind === "all") return { kind: "all" };
	if ((parsed.kind === "markdown-paths" || parsed.kind === "attachment-paths")
		&& "paths" in parsed && Array.isArray(parsed.paths) && parsed.paths.every((item) => typeof item === "string")) {
		return { kind: parsed.kind, paths: parsed.paths };
	}
	if (parsed.kind === "deleted-identities" && "bodyIds" in parsed
		&& Array.isArray(parsed.bodyIds) && parsed.bodyIds.every((item) => typeof item === "string")) {
		return { kind: "deleted-identities", bodyIds: parsed.bodyIds };
	}
	throw new Error("corrupt restore selection");
}

/** Recovery capture, restore, projection, GC, lease, and deletion authority storage. */
export class RecoveryAuthorityStore extends VaultBootstrapStore {
	acquireRecoveryMutex(owner: string, now = Date.now(), ttlMs = 5 * 60_000): boolean {
		this.initialize();
		if (!owner || ttlMs <= 0) throw new Error("invalid recovery mutex");
		return this.storage.transactionSync(() => {
			const existing = this.storage.sql.exec<{ owner: string; expires_at: number }>(
				"SELECT owner, expires_at FROM vault_recovery_mutex WHERE id = 1",
			).toArray()[0];
			if (existing && existing.expires_at > now) return false;
			this.storage.sql.exec(
				`INSERT INTO vault_recovery_mutex(id, owner, expires_at) VALUES (1, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at`,
				owner,
				now + ttlMs,
			).toArray();
			return true;
		});
	}

	releaseRecoveryMutex(owner: string): boolean {
		this.initialize();
		const cursor = this.storage.sql.exec(
			"DELETE FROM vault_recovery_mutex WHERE id = 1 AND owner = ?",
			owner,
		);
		cursor.toArray();
		return cursor.rowsWritten > 0;
	}

	upsertRecoveryRoot(input: {
		rootId: string;
		kind: RecoveryRootKind;
		manifestKey: string;
		manifestHash: string;
		state?: RecoveryRoot["state"];
		now?: number;
		error?: string | null;
	}): RecoveryRoot {
		this.initialize();
		const existing = this.getRecoveryRoot(input.rootId);
		if (existing && (
			existing.kind !== input.kind ||
			existing.manifestKey !== input.manifestKey ||
			existing.manifestHash !== input.manifestHash
		)) {
			throw new Error("recovery root ID reused with different artifact");
		}
		const now = input.now ?? Date.now();
		this.storage.sql.exec(
			`INSERT INTO vault_recovery_roots(
			 root_id, kind, manifest_key, manifest_hash, state, created_at, updated_at, error
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(root_id) DO UPDATE SET
			 kind = excluded.kind,
			 manifest_key = excluded.manifest_key,
			 manifest_hash = excluded.manifest_hash,
			 state = excluded.state,
			 updated_at = excluded.updated_at,
			 error = excluded.error`,
			input.rootId,
			input.kind,
			input.manifestKey,
			input.manifestHash,
			input.state ?? "active",
			now,
			now,
			input.error ?? null,
		).toArray();
		const root = this.getRecoveryRoot(input.rootId);
		if (!root) throw new Error("recovery root disappeared");
		return root;
	}

	getRecoveryRoot(rootId: string): RecoveryRoot | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			root_id: string;
			kind: RecoveryRootKind;
			manifest_key: string;
			manifest_hash: string;
			state: RecoveryRoot["state"];
			created_at: number;
			updated_at: number;
			error: string | null;
		}>("SELECT * FROM vault_recovery_roots WHERE root_id = ?", rootId).toArray()[0];
		return row ? {
			rootId: row.root_id,
			kind: row.kind,
			manifestKey: row.manifest_key,
			manifestHash: row.manifest_hash,
			state: row.state,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			error: row.error,
		} : null;
	}

	listRecoveryRoots(states: RecoveryRoot["state"][] = ["active"]): RecoveryRoot[] {
		this.initialize();
		const wanted = new Set(states);
		return this.storage.sql.exec<{
			root_id: string;
			kind: RecoveryRootKind;
			manifest_key: string;
			manifest_hash: string;
			state: RecoveryRoot["state"];
			created_at: number;
			updated_at: number;
			error: string | null;
		}>("SELECT * FROM vault_recovery_roots ORDER BY created_at").toArray()
			.filter((row) => wanted.has(row.state))
			.map((row) => ({
				rootId: row.root_id,
				kind: row.kind,
				manifestKey: row.manifest_key,
				manifestHash: row.manifest_hash,
				state: row.state,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				error: row.error,
			}));
	}

	setRecoveryRootState(rootId: string, state: RecoveryRoot["state"], error: string | null, now = Date.now()): RecoveryRoot {
		this.initialize();
		const update = this.storage.sql.exec(
			"UPDATE vault_recovery_roots SET state = ?, error = ?, updated_at = ? WHERE root_id = ?",
			state,
			error,
			now,
			rootId,
		);
		update.toArray();
		if (update.rowsWritten === 0) throw new Error("recovery root not found");
		const root = this.getRecoveryRoot(rootId);
		if (!root) throw new Error("recovery root disappeared");
		return root;
	}

	recordRestoreEntry(entry: DurableRestoreEntry): void {
		this.initialize();
		this.storage.sql.exec(
			`INSERT INTO vault_restore_entries(
			 restore_id, path, snapshot_content_hash, live_fingerprint,
			 state, file_id, body_id, error, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(restore_id, path) DO UPDATE SET
			 snapshot_content_hash = excluded.snapshot_content_hash,
			 live_fingerprint = excluded.live_fingerprint,
			 state = excluded.state,
			 file_id = excluded.file_id,
			 body_id = excluded.body_id,
			 error = excluded.error,
			 updated_at = excluded.updated_at`,
			entry.restoreId,
			entry.path,
			entry.snapshotContentHash,
			entry.liveFingerprint,
			entry.state,
			entry.fileId,
			entry.bodyId,
			entry.error,
			entry.updatedAt,
		).toArray();
		this.storage.sql.exec(
			"UPDATE vault_recovery_roots SET updated_at = ? WHERE root_id = ? AND state = 'active'",
			entry.updatedAt,
			entry.restoreId,
		).toArray();
	}

	listRestoreEntries(restoreId: string): DurableRestoreEntry[] {
		this.initialize();
		return this.storage.sql.exec<{
			restore_id: string;
			path: string;
			snapshot_content_hash: string;
			live_fingerprint: string | null;
			state: RestoreEntryState;
			file_id: string | null;
			body_id: string | null;
			error: string | null;
			updated_at: number;
		}>(
			"SELECT * FROM vault_restore_entries WHERE restore_id = ? ORDER BY path",
			restoreId,
		).toArray().map((row) => ({
			restoreId: row.restore_id,
			path: row.path,
			snapshotContentHash: row.snapshot_content_hash,
			liveFingerprint: row.live_fingerprint,
			state: row.state,
			fileId: row.file_id,
			bodyId: row.body_id,
			error: row.error,
			updatedAt: row.updated_at,
		}));
	}

	cleanupStuckRecoveryRoots(now = Date.now(), maxIdleMs = 24 * 60 * 60_000): number {
		this.initialize();
		if (!Number.isFinite(maxIdleMs) || maxIdleMs <= 0) throw new Error("invalid recovery root idle limit");
		const update = this.storage.sql.exec(
			`UPDATE vault_recovery_roots
			 SET state = 'failed', error = 'recovery operation idle-expired', updated_at = ?
			 WHERE state = 'active' AND updated_at <= ?`,
			now,
			now - maxIdleMs,
		);
		update.toArray();
		return update.rowsWritten;
	}

	createRecoveryCapture(input: {
		captureId: string;
		requestId: string;
		vaultId: string;
		vaultGeneration: string;
		boundarySequence: number;
		rootGeneration: number;
		runtimeEpoch: string;
		reason: RecoveryReason;
		jobId: string;
		capabilityHash: string;
		capabilityExpiresAt: number;
		softExpiresAt: number;
		hardExpiresAt: number;
		baseSnapshotId?: string | null;
		gcEpoch?: number | null;
		now?: number;
	}): CaptureDescriptor {
		this.initialize();
		const metadata = this.assertVaultGeneration(input.vaultGeneration);
		if (metadata.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		const existing = this.recoveryCaptureByRequest(input.requestId);
		if (existing) return existing;
		const now = input.now ?? Date.now();
		if (input.boundarySequence < 0 || input.boundarySequence > this.currentSequence()) throw new Error("invalid capture boundary");
		if (input.capabilityExpiresAt !== input.hardExpiresAt || input.softExpiresAt > input.hardExpiresAt || now >= input.softExpiresAt) {
			throw new Error("invalid capture expiry");
		}
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`INSERT INTO vault_history_pins(
				 pin_id, kind, boundary_sequence, created_at, soft_expires_at,
				 hard_expires_at, last_progress_at, progress
				 ) VALUES (?, 'capture', ?, ?, ?, ?, ?, 0)`,
				input.captureId,
				input.boundarySequence,
				now,
				input.softExpiresAt,
				input.hardExpiresAt,
				now,
			).toArray();
			this.storage.sql.exec(
				`INSERT INTO recovery_captures(
				 capture_id, request_id, vault_id, boundary_sequence, root_generation, runtime_epoch, reason,
				 state, job_id, capability_hash, capability_expires_at, gc_epoch, base_snapshot_id, created_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, 'initializing', ?, ?, ?, ?, ?, ?, ?)`,
				input.captureId,
				input.requestId,
				input.vaultId,
				input.boundarySequence,
				input.rootGeneration,
				input.runtimeEpoch,
				input.reason,
				input.jobId,
				input.capabilityHash,
				input.capabilityExpiresAt,
				input.gcEpoch ?? null,
				input.baseSnapshotId ?? null,
				now,
				now,
			).toArray();
			if (input.baseSnapshotId) this.addSnapshotDependency({
				operationKind: "capture",
				operationId: input.captureId,
				snapshotId: input.baseSnapshotId,
			});
		});
		const capture = this.recoveryCapture(input.captureId);
		if (!capture) throw new Error("capture descriptor disappeared");
		return capture;
	}

	recoveryCaptureByRequest(requestId: string): CaptureDescriptor | null {
		this.initialize();
		const row = this.storage.sql.exec<{ capture_id: string }>(
			"SELECT capture_id FROM recovery_captures WHERE request_id = ?",
			requestId,
		).toArray()[0];
		return row ? this.recoveryCapture(row.capture_id) : null;
	}

	recoveryCapture(captureId: string): CaptureDescriptor | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			capture_id: string; request_id: string; vault_id: string; boundary_sequence: number; root_generation: number; runtime_epoch: string;
			reason: RecoveryReason; state: RecoveryCaptureState; job_id: string; capability_hash: string;
			capability_expires_at: number; plan_digest: string | null; delta_digest: string | null; plan_complete: number;
			gc_epoch: number | null; base_snapshot_id: string | null; planned_active_files: number;
			planned_deleted_files: number; planned_attachments: number; snapshot_root_key: string | null;
			snapshot_root_hash: string | null; created_at: number; updated_at: number; error: string | null;
		}>("SELECT * FROM recovery_captures WHERE capture_id = ?", captureId).toArray()[0];
		if (!row) return null;
		const pin = this.getPin(captureId);
		return {
			captureId: row.capture_id,
			requestId: row.request_id,
			vaultId: row.vault_id,
			vaultGeneration: this.currentVaultGeneration(),
			boundarySequence: row.boundary_sequence,
			rootGeneration: row.root_generation,
			runtimeEpoch: row.runtime_epoch,
			reason: row.reason,
			state: row.state,
			jobId: row.job_id,
			capabilityHash: row.capability_hash,
			capabilityExpiresAt: row.capability_expires_at,
			pinSoftExpiresAt: pin?.softExpiresAt ?? 0,
			pinHardExpiresAt: pin?.hardExpiresAt ?? row.capability_expires_at,
			planDigest: row.plan_digest,
			deltaDigest: row.delta_digest,
			planComplete: row.plan_complete === 1,
			gcEpoch: row.gc_epoch,
			baseSnapshotId: row.base_snapshot_id,
			plannedActiveFiles: row.planned_active_files,
			plannedDeletedFiles: row.planned_deleted_files,
			plannedAttachments: row.planned_attachments,
			snapshotRootKey: row.snapshot_root_key,
			snapshotRootHash: row.snapshot_root_hash,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			error: row.error,
		};
	}

	activeRecoveryCapture(): CaptureDescriptor | null {
		this.initialize();
		const row = this.storage.sql.exec<{ capture_id: string }>(
			`SELECT capture_id FROM recovery_captures
			 WHERE state IN ('initializing','queued','planning','materializing','publishing','retrying')
			 ORDER BY created_at LIMIT 1`,
		).toArray()[0];
		return row ? this.recoveryCapture(row.capture_id) : null;
	}

	setRecoveryCaptureState(captureId: string, state: RecoveryCaptureState, error: string | null = null, now = Date.now()): CaptureDescriptor {
		this.initialize();
		const update = this.storage.sql.exec(
			"UPDATE recovery_captures SET state = ?, error = ?, updated_at = ? WHERE capture_id = ?",
			state,
			error,
			now,
			captureId,
		);
		update.toArray();
		if (update.rowsWritten === 0) throw new Error("capture not found");
		const result = this.recoveryCapture(captureId);
		if (!result) throw new Error("capture disappeared");
		return result;
	}

	renewRecoveryCapture(captureId: string, progress: number, now = Date.now()): CaptureDescriptor {
		this.renewPin(captureId, progress, DEFAULT_SOFT_TTL_MS, now);
		this.storage.sql.exec("UPDATE recovery_captures SET updated_at = ? WHERE capture_id = ?", now, captureId).toArray();
		const capture = this.recoveryCapture(captureId);
		if (!capture) throw new Error("capture not found");
		return capture;
	}

	reapExpiredRecoveryCaptures(now = Date.now(), limit = 25): string[] {
		this.initialize();
		const ids = this.storage.sql.exec<{ capture_id: string }>(
			`SELECT c.capture_id FROM recovery_captures c
			 JOIN vault_history_pins p ON p.pin_id = c.capture_id
			 WHERE c.state NOT IN ('complete','failed')
			   AND (p.soft_expires_at <= ? OR p.hard_expires_at <= ? OR c.capability_expires_at <= ?)
			 ORDER BY c.updated_at LIMIT ?`,
			now,
			now,
			now,
			Math.min(100, Math.max(1, limit)),
		).toArray().map((row) => row.capture_id);
		this.storage.transactionSync(() => {
			for (const captureId of ids) {
				this.storage.sql.exec(
					`UPDATE recovery_captures
					 SET state = CASE WHEN state = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
					     capability_hash = '',
					     error = CASE WHEN state = 'cancelled' THEN error ELSE 'capture_authority_expired' END,
					     updated_at = ?
					 WHERE capture_id = ?`,
					now,
					captureId,
				).toArray();
				this.storage.sql.exec("DELETE FROM vault_history_pins WHERE pin_id = ?", captureId).toArray();
				this.storage.sql.exec("DELETE FROM recovery_snapshot_dependencies WHERE operation_kind = 'capture' AND operation_id = ?", captureId).toArray();
			}
		});
		return ids;
	}

	listCapturePlanAt(captureId: string, stream: CapturePlanStream, cursor: string | null, limit: number): CapturePlanEntry[] {
		const capture = this.recoveryCapture(captureId);
		if (!capture) throw new Error("capture not found");
		const bounded = Math.min(1001, Math.max(1, limit));
		const after = cursor ?? "";
		if (stream === "attachments") {
			return this.activeAttachmentCatalogAt(capture.boundarySequence, after, bounded)
				.map((entry) => {
					if (entry.contentHash === null || entry.size === null) throw new Error("attachment catalog entry is missing durable content identity");
					return {
						kind: "attachment" as const,
						canonicalPath: entry.path,
						contentHash: entry.contentHash,
						size: entry.size,
						mime: entry.mime,
					};
				});
		}
		const orderColumn = stream === "active" ? "path" : "body_id";
		const rows = this.storage.sql.exec<{
			sequence: number; body_id: string; file_id: string; path: string; lifecycle: BodyLifecycle;
			generation: number; content_hash: string | null; size: number | null;
		}>(
			`SELECT e.sequence, e.body_id, e.file_id, e.path, e.lifecycle, e.generation, e.content_hash, e.size
			 FROM vault_catalog_events e
			 JOIN (
			   SELECT body_id, MAX(sequence) AS sequence FROM vault_catalog_events
			   WHERE sequence <= ? GROUP BY body_id
			 ) latest ON latest.body_id = e.body_id AND latest.sequence = e.sequence
			 WHERE ((? = 'active' AND e.lifecycle = 'active')
			        OR (? = 'deleted' AND e.lifecycle IN ('tombstoned','reaped')))
			   AND e.${orderColumn} > ?
			 ORDER BY e.${orderColumn}, e.body_id LIMIT ?`,
			capture.boundarySequence,
			stream,
			stream,
			after,
			bounded,
		).toArray();
		return rows.flatMap((row): CapturePlanEntry[] => {
			if (row.content_hash === null || row.size === null) throw new Error("catalog entry is missing durable content identity");
			return stream === "active" ? [{
				kind: "active",
				bodyId: row.body_id,
				fileId: row.file_id,
				canonicalPath: row.path,
				generation: row.generation,
				contentHash: row.content_hash,
				size: row.size,
			}] : [{
				kind: "deleted",
				bodyId: row.body_id,
				fileId: row.file_id,
				lastPath: row.path,
				generation: row.generation,
				baselineContentHash: row.content_hash,
				baselineSize: row.size,
				bodyReaped: row.lifecycle === "reaped",
				deletedAtSequence: row.sequence,
			}];
		});
	}

	recordPlanPage(input: {
		captureId: string; stream: CapturePlanStream; startCursor: string | null; endCursor: string | null;
		pageHash: string; entries: number; terminal: boolean; rollingDigest: string; now?: number;
	}): { digest: string; replay: boolean } {
		this.initialize();
		const start = input.startCursor ?? "";
		const existing = this.storage.sql.exec<{ page_hash: string; end_cursor: string | null; rolling_digest: string }>(
			"SELECT page_hash, end_cursor, rolling_digest FROM recovery_capture_plan_pages WHERE capture_id = ? AND stream = ? AND start_cursor = ?",
			input.captureId,
			input.stream,
			start,
		).toArray()[0];
		if (existing) {
			if (existing.page_hash !== input.pageHash || existing.end_cursor !== input.endCursor || existing.rolling_digest !== input.rollingDigest) {
				throw new Error("capture plan page commitment mismatch");
			}
			return { digest: existing.rolling_digest, replay: true };
		}
		const order = ["active", "deleted", "attachments"] as const;
		const streamIndex = order.indexOf(input.stream);
		for (let index = 0; index < streamIndex; index++) {
			const complete = this.storage.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM recovery_capture_plan_pages WHERE capture_id = ? AND stream = ? AND terminal = 1",
				input.captureId,
				order[index]!,
			).one().count;
			if (complete !== 1) throw new Error("capture plan streams committed out of order");
		}
		if (start !== "") {
			const prior = this.storage.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM recovery_capture_plan_pages WHERE capture_id = ? AND stream = ? AND end_cursor = ?",
				input.captureId,
				input.stream,
				start,
			).one().count;
			if (prior !== 1) throw new Error("capture plan cursor is not contiguous");
		}
		const now = input.now ?? Date.now();
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`INSERT INTO recovery_capture_plan_pages(
				 capture_id, stream, start_cursor, end_cursor, page_hash, entries, terminal, rolling_digest
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				input.captureId,
				input.stream,
				start,
				input.endCursor,
				input.pageHash,
				input.entries,
				input.terminal ? 1 : 0,
				input.rollingDigest,
			).toArray();
			const countColumn = input.stream === "active" ? "planned_active_files"
				: input.stream === "deleted" ? "planned_deleted_files" : "planned_attachments";
			this.storage.sql.exec(
				`UPDATE recovery_captures SET plan_digest = ?, ${countColumn} = ${countColumn} + ?, updated_at = ?
				 WHERE capture_id = ?`,
				input.rollingDigest,
				input.entries,
				now,
				input.captureId,
			).toArray();
			if (input.stream === "attachments" && input.terminal) {
				this.storage.sql.exec(
					"UPDATE recovery_captures SET plan_complete = 1, state = 'materializing', updated_at = ? WHERE capture_id = ?",
					now,
					input.captureId,
				).toArray();
			}
		});
		return { digest: input.rollingDigest, replay: false };
	}

	bindRecipe(captureId: string, bodyId: string, generation: number, recipeId: string): BodyRecipeDescriptor {
		this.initialize();
		const capture = this.recoveryCapture(captureId);
		if (!capture) throw new Error("capture not found");
		const head = this.getCatalogHeadAt(capture.boundarySequence, bodyId);
		if (!head || head.generation !== generation || head.contentHash === null || head.size === null) {
			throw new Error("body generation is outside capture plan");
		}
		const checkpoint = this.storage.sql.exec<{ checkpoint_sequence: number }>(
			`SELECT checkpoint_sequence FROM vault_checkpoints
			 WHERE document_id = ? AND checkpoint_sequence <= ? ORDER BY checkpoint_sequence DESC LIMIT 1`,
			bodyId,
			capture.boundarySequence,
		).toArray()[0];
		const checkpointSequence = checkpoint?.checkpoint_sequence ?? 0;
		let encodedHistoryBytes = 0;
		if (checkpoint) {
			const chunks = this.storage.sql.exec<{ data: string }>(
				"SELECT data FROM vault_checkpoints WHERE document_id = ? AND checkpoint_sequence = ? ORDER BY chunk_index",
				bodyId,
				checkpointSequence,
			);
			encodedHistoryBytes += decodeSqlChunks(chunks).byteLength;
		}
		encodedHistoryBytes += this.storage.sql.exec<{ bytes: number }>(
			`SELECT COALESCE(SUM(update_byte_length), 0) AS bytes FROM vault_journal
			 WHERE document_id = ? AND sequence > ? AND sequence <= ?`,
			bodyId,
			checkpointSequence,
			capture.boundarySequence,
		).one().bytes;
		this.storage.sql.exec(
			`INSERT INTO recovery_recipes(
			 recipe_id, capture_id, body_id, generation, expected_content_hash, expected_size, encoded_history_bytes
			 ) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(capture_id, body_id, generation) DO NOTHING`,
			recipeId,
			captureId,
			bodyId,
			generation,
			head.contentHash,
			head.size,
			encodedHistoryBytes,
		).toArray();
		const row = this.storage.sql.exec<{
			recipe_id: string; body_id: string; generation: number; expected_content_hash: string;
			expected_size: number; encoded_history_bytes: number;
		}>(
			"SELECT * FROM recovery_recipes WHERE capture_id = ? AND body_id = ? AND generation = ?",
			captureId,
			bodyId,
			generation,
		).one();
		return {
			recipeId: row.recipe_id,
			bodyId: row.body_id,
			generation: row.generation,
			expectedContentHash: row.expected_content_hash,
			expectedSize: row.expected_size,
			encodedHistoryBytes: row.encoded_history_bytes,
			firstCursor: "0",
		};
	}

	rawRecipeChunk(recipeId: string, cursor: string, maxBytes: number): {
		parts: Array<{ kind: "checkpoint" | "journal"; sequence: number; update: Uint8Array }>;
		nextCursor: string | null;
		encodedBytes: number;
	} {
		this.initialize();
		const offset = Number(cursor);
		if (!Number.isSafeInteger(offset) || offset < 0 || maxBytes <= 0) throw new Error("invalid recipe cursor or byte budget");
		const recipe = this.storage.sql.exec<{ capture_id: string; body_id: string }>(
			"SELECT capture_id, body_id FROM recovery_recipes WHERE recipe_id = ?",
			recipeId,
		).toArray()[0];
		if (!recipe) throw new Error("recipe not found");
		const capture = this.recoveryCapture(recipe.capture_id);
		if (!capture) throw new Error("capture not found");
		const checkpoint = this.storage.sql.exec<{ checkpoint_sequence: number }>(
			`SELECT checkpoint_sequence FROM vault_checkpoints
			 WHERE document_id = ? AND checkpoint_sequence <= ? ORDER BY checkpoint_sequence DESC LIMIT 1`,
			recipe.body_id,
			capture.boundarySequence,
		).toArray()[0];
		const checkpointSequence = checkpoint?.checkpoint_sequence ?? 0;
		const metadata: Array<{ kind: "checkpoint" | "journal"; sequence: number; bytes: number }> = [];
		if (checkpoint) {
			const bytes = decodeSqlChunks(this.storage.sql.exec<{ data: string }>(
				"SELECT data FROM vault_checkpoints WHERE document_id = ? AND checkpoint_sequence = ? ORDER BY chunk_index",
				recipe.body_id,
				checkpointSequence,
			)).byteLength;
			metadata.push({ kind: "checkpoint", sequence: checkpointSequence, bytes });
		}
		const journal = this.storage.sql.exec<{ sequence: number; update_byte_length: number }>(
			`SELECT sequence, update_byte_length FROM vault_journal
			 WHERE document_id = ? AND sequence > ? AND sequence <= ?
			 ORDER BY sequence LIMIT 257 OFFSET ?`,
			recipe.body_id,
			checkpointSequence,
			capture.boundarySequence,
			Math.max(0, offset - metadata.length),
		).toArray();
		metadata.push(...journal.map((row) => ({ kind: "journal" as const, sequence: row.sequence, bytes: row.update_byte_length })));
		const selected: typeof metadata = [];
		let encodedBytes = 0;
		for (const item of metadata.slice(offset === 0 ? 0 : metadata.length > journal.length ? 1 : 0)) {
			if (selected.length > 0 && encodedBytes + item.bytes > maxBytes) break;
			selected.push(item);
			encodedBytes += item.bytes;
			if (selected.length >= 256) break;
		}
		const parts = selected.map((item) => {
			const rows = item.kind === "checkpoint"
				? this.storage.sql.exec<{ data: string }>(
					"SELECT data FROM vault_checkpoints WHERE document_id = ? AND checkpoint_sequence = ? ORDER BY chunk_index",
					recipe.body_id,
					item.sequence,
				)
				: this.storage.sql.exec<{ data: string }>(
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
			recipe.body_id,
			checkpointSequence,
			capture.boundarySequence,
		).one().count;
		return { parts, nextCursor: consumed < total ? String(consumed) : null, encodedBytes };
	}

	addSnapshotDependency(dependency: RecoverySnapshotDependency): void {
		this.initialize();
		if (!this.snapshot(dependency.snapshotId)) throw new Error("snapshot dependency target not found");
		this.storage.sql.exec(
			`INSERT OR IGNORE INTO recovery_snapshot_dependencies(operation_kind, operation_id, snapshot_id)
			 VALUES (?, ?, ?)`,
			dependency.operationKind,
			dependency.operationId,
			dependency.snapshotId,
		).toArray();
	}

	releaseSnapshotDependencies(operationKind: RecoverySnapshotDependency["operationKind"], operationId: string): number {
		this.initialize();
		const result = this.storage.sql.exec(
			"DELETE FROM recovery_snapshot_dependencies WHERE operation_kind = ? AND operation_id = ?",
			operationKind,
			operationId,
		);
		result.toArray();
		return result.rowsWritten;
	}

	snapshotDependency(operationKind: RecoverySnapshotDependency["operationKind"], operationId: string): RecoverySnapshotDependency | null {
		this.initialize();
		const row = this.storage.sql.exec<{ snapshot_id: string }>(
			`SELECT snapshot_id FROM recovery_snapshot_dependencies
			 WHERE operation_kind = ? AND operation_id = ? ORDER BY snapshot_id LIMIT 1`,

			operationKind,
			operationId,
		).toArray()[0];
		return row ? { operationKind, operationId, snapshotId: row.snapshot_id } : null;
	}

	createRestoreAuthority(input: {
		restoreId: string; requestId: string; vaultId: string; vaultGeneration: string; snapshotId: string; selection: RestoreSelection;
		jobId: string; capabilityHash: string; capabilityExpiresAt: number; now?: number;
	}): RestoreAuthority {
		this.initialize();
		const metadata = this.assertVaultGeneration(input.vaultGeneration);
		if (metadata.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		const existing = this.restoreAuthorityByRequest(input.requestId);
		if (existing) return existing;
		const now = input.now ?? Date.now();
		if (input.capabilityExpiresAt <= now || !this.snapshot(input.snapshotId)) throw new Error("invalid restore authority");
		const selectionJson = canonicalJsonText(input.selection);
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`INSERT INTO recovery_restores(
				 restore_id, request_id, vault_id, snapshot_id, selection_json, state, job_id,
				 capability_hash, capability_expires_at, created_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, 'initializing', ?, ?, ?, ?, ?)`,
				input.restoreId, input.requestId, input.vaultId, input.snapshotId, selectionJson, input.jobId,
				input.capabilityHash, input.capabilityExpiresAt, now, now,
			).toArray();
			this.storage.sql.exec(
				`INSERT INTO recovery_snapshot_dependencies(operation_kind, operation_id, snapshot_id)
				 VALUES ('restore', ?, ?)`,
				input.restoreId,
				input.snapshotId,
			).toArray();
		});
		return this.restoreAuthority(input.restoreId)!;
	}

	restoreAuthorityByRequest(requestId: string): RestoreAuthority | null {
		this.initialize();
		const row = this.storage.sql.exec<{ restore_id: string }>(
			"SELECT restore_id FROM recovery_restores WHERE request_id = ?",
			requestId,
		).toArray()[0];
		return row ? this.restoreAuthority(row.restore_id) : null;
	}

	restoreAuthority(restoreId: string): RestoreAuthority | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			restore_id: string; request_id: string; vault_id: string; snapshot_id: string; selection_json: string;
			state: RestoreAuthority["state"]; job_id: string; capability_hash: string; capability_expires_at: number;
			created_at: number; updated_at: number;
		}>("SELECT * FROM recovery_restores WHERE restore_id = ?", restoreId).toArray()[0];
		if (!row) return null;
		const selection = parseRestoreSelection(row.selection_json);
		return {
			restoreId: row.restore_id, requestId: row.request_id, vaultId: row.vault_id, vaultGeneration: this.currentVaultGeneration(), snapshotId: row.snapshot_id,
			selection, state: row.state, jobId: row.job_id, capabilityHash: row.capability_hash,
			capabilityExpiresAt: row.capability_expires_at, createdAt: row.created_at, updatedAt: row.updated_at,
		};
	}

	activeRestoreAuthority(): RestoreAuthority | null {
		this.initialize();
		const row = this.storage.sql.exec<{ restore_id: string }>(
			"SELECT restore_id FROM recovery_restores WHERE state IN ('initializing','active') ORDER BY created_at LIMIT 1",
		).toArray()[0];
		return row ? this.restoreAuthority(row.restore_id) : null;
	}

	replaceInitializingRestoreCapability(restoreId: string, capabilityHash: string, now = Date.now()): RestoreAuthority {
		const result = this.storage.sql.exec(
			"UPDATE recovery_restores SET capability_hash = ?, updated_at = ? WHERE restore_id = ? AND state = 'initializing'",
			capabilityHash, now, restoreId,
		);
		result.toArray();
		if (result.rowsWritten !== 1) throw new Error("restore capability cannot be replaced");
		return this.restoreAuthority(restoreId)!;
	}

	setRestoreAuthorityState(restoreId: string, state: RestoreAuthority["state"], now = Date.now()): RestoreAuthority {
		this.initialize();
		this.storage.transactionSync(() => {
			const result = this.storage.sql.exec(
				`UPDATE recovery_restores SET state = ?,
				 capability_hash = CASE WHEN ? IN ('complete','cancelled','failed') THEN '' ELSE capability_hash END,
				 updated_at = ? WHERE restore_id = ?`,
				state, state, now, restoreId,
			);
			result.toArray();
			if (result.rowsWritten !== 1) throw new Error("restore authority not found");
			if (state === "complete" || state === "cancelled" || state === "failed") {
				this.storage.sql.exec(
					"DELETE FROM recovery_snapshot_dependencies WHERE operation_kind = 'restore' AND operation_id = ?",
					restoreId,
				).toArray();
			}
		});
		return this.restoreAuthority(restoreId)!;
	}

	reapExpiredRestoreAuthorities(now = Date.now(), limit = 25): string[] {
		this.initialize();
		const ids = this.storage.sql.exec<{ restore_id: string }>(
			`SELECT restore_id FROM recovery_restores
			 WHERE state IN ('initializing','active') AND capability_expires_at <= ?
			 ORDER BY updated_at LIMIT ?`,
			now,
			Math.min(100, Math.max(1, limit)),
		).toArray().map((row) => row.restore_id);
		this.storage.transactionSync(() => {
			for (const restoreId of ids) {
				this.storage.sql.exec(
					"UPDATE recovery_restores SET state = 'failed', capability_hash = '', updated_at = ? WHERE restore_id = ?",
					now, restoreId,
				).toArray();
				this.storage.sql.exec(
					"DELETE FROM recovery_snapshot_dependencies WHERE operation_kind = 'restore' AND operation_id = ?",
					restoreId,
				).toArray();
			}
		});
		return ids;
	}

	activeRestoreDependency(): RecoverySnapshotDependency | null {
		this.initialize();
		const row = this.storage.sql.exec<{ operation_id: string; snapshot_id: string }>(
			`SELECT operation_id, snapshot_id FROM recovery_snapshot_dependencies
			 WHERE operation_kind = 'restore' ORDER BY operation_id LIMIT 1`,
		).toArray()[0];
		return row ? { operationKind: "restore", operationId: row.operation_id, snapshotId: row.snapshot_id } : null;
	}

	recordContentMaterialized(input: {
		captureId: string; bodyId: string; generation: number; contentHash: string; objectKey: string; plainBytes: number; now?: number;
	}): void {
		this.initialize();

		const capture = this.recoveryCapture(input.captureId);
		const head = capture ? this.getCatalogHeadAt(capture.boundarySequence, input.bodyId) : null;
		if (!capture || !head || head.generation !== input.generation || head.contentHash !== input.contentHash || head.size !== input.plainBytes) {
			throw new Error("materialized content does not match capture plan");
		}
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`INSERT INTO recovery_content_index(content_hash, object_key, plain_bytes, verified_at, verified_epoch)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(content_hash) DO UPDATE SET
				 object_key = excluded.object_key, plain_bytes = excluded.plain_bytes,
				 verified_at = excluded.verified_at, verified_epoch = excluded.verified_epoch`,
				input.contentHash,
				input.objectKey,
				input.plainBytes,
				input.now ?? Date.now(),
				capture.gcEpoch,
			).toArray();
			this.storage.sql.exec(
				`INSERT OR IGNORE INTO recovery_capture_content(capture_id, body_id, generation, content_hash)
				 VALUES (?, ?, ?, ?)`,
				input.captureId,
				input.bodyId,
				input.generation,
				input.contentHash,
			).toArray();
		});
	}

	recordProjectedContent(contentHash: string, objectKey: string, plainBytes: number, verifiedEpoch: number | null, now = Date.now()): void {
		this.initialize();
		this.storage.sql.exec(
			`INSERT INTO recovery_content_index(content_hash, object_key, plain_bytes, verified_at, verified_epoch)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(content_hash) DO UPDATE SET
			 object_key = excluded.object_key, plain_bytes = excluded.plain_bytes,
			 verified_at = excluded.verified_at, verified_epoch = excluded.verified_epoch`,
			contentHash,
			objectKey,
			plainBytes,
			now,
			verifiedEpoch,
		).toArray();
	}

	recordManifestNode(input: {
		captureId: string; tree: RecoveryTree; logicalPrefix: string; nodeHash: string; objectKey: string;
		nodeFormat: string; subtreeEntries: number; subtreeNodes: number; provenanceSnapshotId?: string | null; now?: number;
	}): void {
		this.initialize();
		const capture = this.recoveryCapture(input.captureId);
		if (!capture) throw new Error("capture not found");
		const provenance = input.provenanceSnapshotId ?? null;
		if (provenance !== null) {
			if (capture.baseSnapshotId !== provenance) throw new Error("manifest provenance is not the pinned base");
			const member = this.storage.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM recovery_snapshot_manifest_nodes WHERE snapshot_id = ? AND node_hash = ?",
				provenance,
				input.nodeHash,
			).one().count;
			if (member !== 1) throw new Error("manifest node is not reachable from provenance snapshot");
		} else {
			this.storage.sql.exec(
				`INSERT INTO recovery_manifest_index(
				 node_hash, object_key, node_format, subtree_entries, subtree_nodes, verified_at, verified_epoch
				 ) VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(node_hash) DO UPDATE SET
				 verified_at = excluded.verified_at, verified_epoch = excluded.verified_epoch`,
				input.nodeHash,
				input.objectKey,
				input.nodeFormat,
				input.subtreeEntries,
				input.subtreeNodes,
				input.now ?? Date.now(),
				capture.gcEpoch,
			).toArray();
		}
		const existing = this.storage.sql.exec<{ node_hash: string; provenance_snapshot_id: string | null }>(
			`SELECT node_hash, provenance_snapshot_id FROM recovery_capture_manifest_nodes
			 WHERE capture_id = ? AND tree = ? AND logical_prefix = ?`,
			input.captureId,
			input.tree,
			input.logicalPrefix,
		).toArray()[0];
		if (existing && (existing.node_hash !== input.nodeHash || existing.provenance_snapshot_id !== provenance)) {
			throw new Error("manifest logical node acknowledgement mismatch");
		}
		this.storage.sql.exec(
			`INSERT OR IGNORE INTO recovery_capture_manifest_nodes(
			 capture_id, tree, logical_prefix, node_hash, subtree_entries, subtree_nodes, provenance_snapshot_id
			 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			input.captureId,
			input.tree,
			input.logicalPrefix,
			input.nodeHash,
			input.subtreeEntries,
			input.subtreeNodes,
			provenance,
		).toArray();
	}

	missingCoverage(captureId: string, contentHashes: string[], nodeHashes: string[], activeEpoch: number | null): {
		contentHashes: string[]; nodeHashes: string[];
	} {
		this.initialize();
		const missingContent = contentHashes.filter((hash) => {
			const row = this.storage.sql.exec<{ verified_epoch: number | null }>(
				"SELECT verified_epoch FROM recovery_content_index WHERE content_hash = ?",

				hash,
			).toArray()[0];
			return !row || (activeEpoch !== null && (row.verified_epoch ?? -1) < activeEpoch);
		});
		const missingNodes = nodeHashes.filter((hash) => {
			const row = this.storage.sql.exec<{ verified_epoch: number | null }>(
				"SELECT verified_epoch FROM recovery_manifest_index WHERE node_hash = ?",
				hash,
			).toArray()[0];
			return !row || (activeEpoch !== null && (row.verified_epoch ?? -1) < activeEpoch);
		});
		return { contentHashes: missingContent, nodeHashes: missingNodes };
	}

	missingIndexedContent(contentHashes: string[], activeEpoch: number | null = null): string[] {
		this.initialize();
		return contentHashes.filter((hash) => {
			const row = this.storage.sql.exec<{ verified_epoch: number | null }>(
				"SELECT verified_epoch FROM recovery_content_index WHERE content_hash = ?",
				hash,
			).toArray()[0];
			return !row || (activeEpoch !== null && (row.verified_epoch ?? -1) < activeEpoch);
		});
	}

	recoveryProjectionSummary(boundarySequence = this.currentSequence()): {
		totalEntries: number;
		remainingEntries: number;
		lagSequences: number;
	} {
		this.initialize();
		const row = this.storage.sql.exec<{
			total_entries: number;
			remaining_entries: number;
			oldest_missing_sequence: number | null;
		}>(
			`SELECT
			   COUNT(*) AS total_entries,
			   SUM(CASE WHEN i.content_hash IS NULL THEN 1 ELSE 0 END) AS remaining_entries,
			   MIN(CASE WHEN i.content_hash IS NULL THEN e.sequence ELSE NULL END) AS oldest_missing_sequence
			 FROM vault_catalog_events e
			 JOIN (
			   SELECT body_id, MAX(sequence) AS sequence
			   FROM vault_catalog_events
			   WHERE sequence <= ?
			   GROUP BY body_id
			 ) latest ON latest.body_id = e.body_id AND latest.sequence = e.sequence
			 LEFT JOIN recovery_content_index i ON i.content_hash = e.content_hash
			 WHERE e.lifecycle = 'active' AND e.content_hash IS NOT NULL`,
			boundarySequence,
		).one();
		const remainingEntries = row.remaining_entries ?? 0;
		return {
			totalEntries: row.total_entries,
			remainingEntries,
			lagSequences: remainingEntries === 0 || row.oldest_missing_sequence === null
				? 0
				: Math.max(0, boundarySequence - row.oldest_missing_sequence),
		};
	}

	recordRecoveryDefects(defects: RecoveryDefectRecord[]): void {
		this.initialize();
		this.storage.transactionSync(() => {
			for (const defect of defects) {
				this.storage.sql.exec(
					`INSERT INTO recovery_defects(
					 capture_id, kind, identity, generation, code, reference_hash, created_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(capture_id, kind, identity, generation) DO UPDATE SET
					 code = excluded.code, reference_hash = excluded.reference_hash`,
					defect.captureId,
					defect.kind,
					defect.identity,
					defect.generation ?? -1,
					defect.code,
					defect.referenceHash,
					defect.createdAt,
				).toArray();
			}
		});
	}

	acquireMaterializationLease(input: {
		leaseId: string; ownerKind: "capture" | "projection"; ownerId: string; objectKeys: string[]; expiresAt: number; now?: number;
	}): MaterializationLease {
		this.initialize();
		const now = input.now ?? Date.now();
		if (input.objectKeys.length === 0 || input.expiresAt <= now) throw new Error("invalid materialization lease");
		this.storage.transactionSync(() => {
			this.storage.sql.exec("DELETE FROM recovery_key_leases WHERE expires_at <= ?", now).toArray();
			for (const key of input.objectKeys) {
				const conflict = this.storage.sql.exec<{
					lease_kind: string;
					lease_id: string;
					owner_kind: string;
					owner_id: string;
				}>(
					"SELECT lease_kind, lease_id, owner_kind, owner_id FROM recovery_key_leases WHERE object_key = ?",
					key,
				).toArray()[0];
				if (conflict && (
					conflict.lease_kind !== "materialize"
					|| conflict.owner_kind !== input.ownerKind
					|| conflict.owner_id !== input.ownerId
				)) {
					throw new Error("object key is temporarily leased");
				}
				this.storage.sql.exec(
					`INSERT INTO recovery_key_leases(
					 object_key, lease_id, lease_kind, owner_kind, owner_id, expires_at
					 ) VALUES (?, ?, 'materialize', ?, ?, ?)
					 ON CONFLICT(object_key) DO UPDATE SET
					 lease_id = excluded.lease_id,
					 lease_kind = excluded.lease_kind,
					 owner_kind = excluded.owner_kind,
					 owner_id = excluded.owner_id,
					 domain = NULL,
					 expires_at = excluded.expires_at`,
					key,
					input.leaseId,
					input.ownerKind,
					input.ownerId,
					input.expiresAt,
				).toArray();
			}
		});
		return { leaseId: input.leaseId, ownerKind: input.ownerKind, ownerId: input.ownerId, objectKeys: [...input.objectKeys], expiresAt: input.expiresAt };
	}

	releaseKeyLease(leaseId: string): number {
		this.initialize();
		const result = this.storage.sql.exec("DELETE FROM recovery_key_leases WHERE lease_id = ?", leaseId);
		result.toArray();
		return result.rowsWritten;
	}

	acquireSweepLease(input: {
		leaseId: string; epoch: number; ownerId: string; domain: "recovery" | "blob"; objectKeys: string[]; expiresAt: number; now?: number;
	}): SweepLease {
		this.initialize();
		const now = input.now ?? Date.now();
		const epoch = this.gcEpoch(input.epoch);
		if (!epoch || epoch.state !== "sweeping" || input.expiresAt <= now || input.expiresAt > epoch.deadlineAt) {
			throw new Error("GC epoch cannot sweep");
		}
		const approved: string[] = [];
		this.storage.transactionSync(() => {
			this.storage.sql.exec("DELETE FROM recovery_key_leases WHERE expires_at <= ?", now).toArray();
			for (const key of input.objectKeys) {
				const leased = this.storage.sql.exec<{ count: number }>(
					"SELECT COUNT(*) AS count FROM recovery_key_leases WHERE object_key = ?",
					key,
				).one().count > 0;
				const rooted = this.storage.sql.exec<{ count: number }>(
					`SELECT (
					   (SELECT COUNT(*) FROM recovery_snapshot_catalog WHERE root_key = ?) +
					   (SELECT COUNT(*) FROM recovery_snapshot_manifest_nodes s
					    JOIN recovery_manifest_index i ON i.node_hash = s.node_hash
					    WHERE i.object_key = ?) +
					   (SELECT COUNT(*) FROM recovery_capture_manifest_nodes c
					    JOIN recovery_manifest_index i ON i.node_hash = c.node_hash
					    JOIN recovery_captures r ON r.capture_id = c.capture_id
					    WHERE i.object_key = ? AND r.state NOT IN ('complete','complete_with_gaps','failed','cancelled')) +
					   (SELECT COUNT(*) FROM recovery_capture_content cc
					    JOIN recovery_content_index i ON i.content_hash = cc.content_hash
					    JOIN recovery_captures r ON r.capture_id = cc.capture_id
					    WHERE i.object_key = ? AND r.state NOT IN ('complete','complete_with_gaps','failed','cancelled')) +
					   (SELECT COUNT(*) FROM vault_catalog_events e
					    JOIN (
					      SELECT body_id, MAX(sequence) AS sequence
					      FROM vault_catalog_events GROUP BY body_id
					    ) latest ON latest.body_id = e.body_id AND latest.sequence = e.sequence
					    WHERE e.lifecycle IN ('active','tombstoned','reaped')
					      AND e.content_hash IS NOT NULL
					      AND instr(?, e.content_hash) > 0)
					 ) AS count`,
					key,
					key,
					key,
					key,
					key,
				).one().count > 0;
				const attachmentLive = input.domain === "blob" && this.storage.sql.exec<{ count: number }>(
					`SELECT COUNT(*) AS count FROM vault_attachment_catalog_events e
					 JOIN (
					   SELECT path, MAX(sequence) AS sequence FROM vault_attachment_catalog_events GROUP BY path
					 ) latest ON latest.path = e.path AND latest.sequence = e.sequence
					 WHERE e.lifecycle = 'active' AND e.content_hash IS NOT NULL AND instr(?, e.content_hash) > 0`,
					key,
				).one().count > 0;
				if (leased || rooted || attachmentLive) continue;
				this.storage.sql.exec(
					`INSERT INTO recovery_key_leases(
					 object_key, lease_id, lease_kind, owner_kind, owner_id, domain, expires_at
					 ) VALUES (?, ?, 'sweep', 'gc', ?, ?, ?)`,
					key,
					input.leaseId,
					input.ownerId,
					input.domain,
					input.expiresAt,
				).toArray();
				approved.push(key);
			}
		});
		return { leaseId: input.leaseId, epoch: input.epoch, ownerId: input.ownerId, domain: input.domain, approvedKeys: approved, expiresAt: input.expiresAt };
	}

	invalidateDeletedObjects(leaseId: string, objectKeys: string[]): void {
		this.initialize();
		this.storage.transactionSync(() => {
			for (const key of objectKeys) {
				const lease = this.storage.sql.exec<{ lease_kind: string }>(
					"SELECT lease_kind FROM recovery_key_leases WHERE lease_id = ? AND object_key = ?",
					leaseId,
					key,
				).toArray()[0];
				if (lease?.lease_kind !== "sweep") throw new Error("object key is not sweep leased");
				this.storage.sql.exec("DELETE FROM recovery_content_index WHERE object_key = ?", key).toArray();
				this.storage.sql.exec("DELETE FROM recovery_manifest_index WHERE object_key = ?", key).toArray();
			}
			this.storage.sql.exec("DELETE FROM recovery_key_leases WHERE lease_id = ?", leaseId).toArray();
		});
	}

	createGcEpoch(input: {
		requestId: string; vaultId: string; vaultGeneration: string; jobId: string; capabilityHash: string; capabilityExpiresAt: number;
	}, now = Date.now()): GcEpoch {
		this.initialize();
		const metadata = this.assertVaultGeneration(input.vaultGeneration);
		if (metadata.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		if (this.activeRecoveryCapture()) throw new Error("cannot mark during active capture");
		const activeRestore = this.storage.sql.exec<{ count: number }>(
			`SELECT (
			   (SELECT COUNT(*) FROM vault_recovery_roots WHERE state = 'active') +
			   (SELECT COUNT(*) FROM recovery_snapshot_dependencies WHERE operation_kind = 'restore')
			 ) AS count`,
		).one().count;
		const materializers = this.storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM recovery_key_leases WHERE lease_kind = 'materialize' AND expires_at > ?",
			now,
		).one().count;
		if (activeRestore > 0 || materializers > 0) throw new Error("GC mark authority is busy");
		const epoch = this.storage.sql.exec<{ epoch: number }>(
			"SELECT COALESCE(MAX(epoch), 0) + 1 AS epoch FROM recovery_gc_epochs",
		).one().epoch;
		const deadlineAt = now + 24 * 60 * 60_000;
		const projectionWasEnabled = this.projectionLease()?.enabled ?? false;
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`INSERT INTO recovery_gc_epochs(
				 epoch, request_id, vault_id, projection_was_enabled, job_id, capability_hash, capability_expires_at,
				 state, mark_boundary_sequence, mark_started_at, deadline_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, 'marking', ?, ?, ?)`,
				epoch, input.requestId, input.vaultId, projectionWasEnabled ? 1 : 0, input.jobId,
				input.capabilityHash, input.capabilityExpiresAt, this.currentSequence(), now, deadlineAt,
			).toArray();
			this.storage.sql.exec("UPDATE recovery_projection_lease SET enabled = 0, updated_at = ? WHERE id = 1", now).toArray();
		});
		return this.gcEpoch(epoch)!;
	}

	gcAuthority(epoch: number): GcAuthority | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			epoch: number; request_id: string; vault_id: string; job_id: string; capability_hash: string;
			capability_expires_at: number; state: GcEpoch["state"]; mark_started_at: number; deadline_at: number;
		}>("SELECT * FROM recovery_gc_epochs WHERE epoch = ?", epoch).toArray()[0];
		return row ? {
			epoch: row.epoch, requestId: row.request_id, vaultId: row.vault_id, vaultGeneration: this.currentVaultGeneration(), jobId: row.job_id,
			capabilityHash: row.capability_hash, capabilityExpiresAt: row.capability_expires_at,
			state: row.state, markStartedAt: row.mark_started_at, deadlineAt: row.deadline_at,
		} : null;
	}

	replaceMarkingGcCapability(epoch: number, capabilityHash: string): GcAuthority {
		const result = this.storage.sql.exec(
			"UPDATE recovery_gc_epochs SET capability_hash = ? WHERE epoch = ? AND state = 'marking'",
			capabilityHash, epoch,
		);
		result.toArray();
		if (result.rowsWritten !== 1) throw new Error("GC capability cannot be replaced");
		return this.gcAuthority(epoch)!;
	}

	hasMaterializationLease(ownerId: string, objectKey: string, now = Date.now()): boolean {
		this.initialize();
		return this.storage.sql.exec<{ count: number }>(
			`SELECT COUNT(*) AS count FROM recovery_key_leases
			 WHERE owner_id = ? AND object_key = ? AND lease_kind = 'materialize' AND expires_at > ?`,
			ownerId,
			objectKey,
			now,
		).one().count === 1;
	}

	gcEpoch(epoch: number): GcEpoch | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			epoch: number; request_id: string; state: GcEpoch["state"]; mark_boundary_sequence: number; mark_started_at: number;
			mark_completed_at: number | null; sweep_completed_at: number | null; deadline_at: number;
		}>("SELECT * FROM recovery_gc_epochs WHERE epoch = ?", epoch).toArray()[0];
		return row ? {
			epoch: row.epoch,
			requestId: row.request_id,
			state: row.state,
			markBoundarySequence: row.mark_boundary_sequence,
			markStartedAt: row.mark_started_at,
			markCompletedAt: row.mark_completed_at,
			sweepCompletedAt: row.sweep_completed_at,
			deadlineAt: row.deadline_at,
		} : null;
	}

	advanceGcEpoch(epoch: number, state: "sweeping" | "complete" | "aborted", now = Date.now()): GcEpoch {
		this.initialize();
		const current = this.gcEpoch(epoch);
		if (!current || current.deadlineAt <= now) state = "aborted";
		if (state === "sweeping" && current?.state !== "marking") throw new Error("GC mark is not active");
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`UPDATE recovery_gc_epochs SET state = ?,
				 mark_completed_at = CASE WHEN ? = 'sweeping' THEN ? ELSE mark_completed_at END,
				 sweep_completed_at = CASE WHEN ? IN ('complete','aborted') THEN ? ELSE sweep_completed_at END
				 WHERE epoch = ?`,
				state,
				state,
				now,
				state,
				now,
				epoch,
			).toArray();
			if (state === "sweeping" || state === "complete" || state === "aborted") {
				this.storage.sql.exec(
					`UPDATE recovery_projection_lease
					 SET enabled = COALESCE((SELECT projection_was_enabled FROM recovery_gc_epochs WHERE epoch = ?), 0),
					     updated_at = ?
					 WHERE id = 1`,
					epoch,
					now,
				).toArray();
			}
		});
		return this.gcEpoch(epoch)!;
	}

	finalizeRecoveryCapture(input: {
		captureId: string; rootKey: string; rootHash: string; sourcePlanDigest: string; sourceDeltaDigest: string | null;
		manifestNodeCount: number; reason: RecoveryReason; completedAt: number;
	}): RecoverySnapshotCatalogEntry {
		this.initialize();
		const existing = this.snapshot(input.captureId);
		if (existing) {
			if (existing.rootKey !== input.rootKey || existing.rootHash !== input.rootHash) throw new Error("snapshot finalization collision");
			return existing;
		}
		const capture = this.recoveryCapture(input.captureId);
		if (!capture || !capture.planComplete || capture.planDigest !== input.sourcePlanDigest
			|| capture.deltaDigest !== input.sourceDeltaDigest || !this.getPin(input.captureId)) {
			throw new Error("capture is not finalizable");
		}
		const nodeCount = this.storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM recovery_capture_manifest_nodes WHERE capture_id = ?",
			input.captureId,
		).one().count;
		if (nodeCount !== input.manifestNodeCount) throw new Error("manifest inventory count mismatch");
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`INSERT INTO recovery_snapshot_catalog(
				 snapshot_id, boundary_sequence, root_key, root_hash, reason, pinned, created_at, completed_at
				 ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
				input.captureId,
				capture.boundarySequence,
				input.rootKey,
				input.rootHash,
				input.reason,
				capture.createdAt,
				input.completedAt,
			).toArray();
			this.storage.sql.exec(
				`INSERT OR IGNORE INTO recovery_snapshot_manifest_nodes(snapshot_id, node_hash)
				 SELECT ?, node_hash FROM recovery_capture_manifest_nodes WHERE capture_id = ?`,
				input.captureId,
				input.captureId,
			).toArray();
			this.storage.sql.exec(
				`UPDATE recovery_captures SET state = 'complete', snapshot_root_key = ?,
				 snapshot_root_hash = ?, capability_hash = '', updated_at = ?, error = NULL
				 WHERE capture_id = ?`,
				input.rootKey,
				input.rootHash,
				input.completedAt,
				input.captureId,
			).toArray();
			this.storage.sql.exec("DELETE FROM vault_history_pins WHERE pin_id = ?", input.captureId).toArray();
			this.storage.sql.exec(
				"DELETE FROM recovery_snapshot_dependencies WHERE operation_kind = 'capture' AND operation_id = ?",
				input.captureId,
			).toArray();
		});
		return this.snapshot(input.captureId)!;
	}

	snapshot(snapshotId: string): RecoverySnapshotCatalogEntry | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			snapshot_id: string; boundary_sequence: number; root_key: string; root_hash: string;
			reason: RecoveryReason; pinned: number; created_at: number; completed_at: number;
		}>("SELECT * FROM recovery_snapshot_catalog WHERE snapshot_id = ?", snapshotId).toArray()[0];
		return row ? {
			snapshotId: row.snapshot_id,
			boundarySequence: row.boundary_sequence,
			rootKey: row.root_key,
			rootHash: row.root_hash,
			reason: row.reason,
			pinned: row.pinned === 1,
			createdAt: row.created_at,
			completedAt: row.completed_at,
		} : null;
	}

	listSnapshots(cursor: string | null, limit = 100): RecoverySnapshotCatalogEntry[] {
		this.initialize();
		return this.storage.sql.exec<{ snapshot_id: string }>(
			`SELECT snapshot_id FROM recovery_snapshot_catalog
			 WHERE snapshot_id > ? ORDER BY snapshot_id LIMIT ?`,
			cursor ?? "",
			Math.min(1000, Math.max(1, limit)),
		).toArray().map((row) => this.snapshot(row.snapshot_id)!).filter(Boolean);
	}

	recordDeltaPage(input: {
		captureId: string; startCursor: string | null; endCursor: string | null; pageHash: string;
		entries: number; terminal: boolean; rollingDigest: string; now?: number;
	}): { digest: string; replay: boolean } {
		this.initialize();
		const start = input.startCursor ?? "";
		const existing = this.storage.sql.exec<{ page_hash: string; end_cursor: string | null; rolling_digest: string }>(
			"SELECT page_hash, end_cursor, rolling_digest FROM recovery_capture_delta_pages WHERE capture_id = ? AND start_cursor = ?",
			input.captureId,
			start,
		).toArray()[0];
		if (existing) {
			if (existing.page_hash !== input.pageHash || existing.end_cursor !== input.endCursor || existing.rolling_digest !== input.rollingDigest) {
				throw new Error("capture delta page commitment mismatch");
			}
			return { digest: existing.rolling_digest, replay: true };
		}
		if (start !== "") {
			const prior = this.storage.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM recovery_capture_delta_pages WHERE capture_id = ? AND end_cursor = ?",
				input.captureId,
				start,
			).one().count;
			if (prior !== 1) throw new Error("capture delta cursor is not contiguous");
		}
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`INSERT INTO recovery_capture_delta_pages(
				 capture_id, start_cursor, end_cursor, page_hash, entries, terminal, rolling_digest
				 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				input.captureId,
				start,
				input.endCursor,
				input.pageHash,
				input.entries,
				input.terminal ? 1 : 0,
				input.rollingDigest,
			).toArray();
			this.storage.sql.exec(
				"UPDATE recovery_captures SET delta_digest = ?, updated_at = ? WHERE capture_id = ?",
				input.rollingDigest,
				input.now ?? Date.now(),
				input.captureId,
			).toArray();
		});
		return { digest: input.rollingDigest, replay: false };
	}

	resetCaptureDelta(captureId: string, now = Date.now()): void {
		this.initialize();
		const capture = this.recoveryCapture(captureId);
		if (!capture || capture.state === "complete" || capture.state === "failed" || capture.state === "cancelled") {
			throw new Error("capture delta cannot be reset");
		}
		this.storage.transactionSync(() => {
			this.storage.sql.exec("DELETE FROM recovery_capture_delta_pages WHERE capture_id = ?", captureId).toArray();
			this.storage.sql.exec(
				"UPDATE recovery_captures SET delta_digest = NULL, updated_at = ? WHERE capture_id = ?",
				now,
				captureId,
			).toArray();
		});
	}

	latestSnapshotBefore(boundarySequence: number): RecoverySnapshotCatalogEntry | null {
		this.initialize();
		const row = this.storage.sql.exec<{ snapshot_id: string }>(
			`SELECT snapshot_id FROM recovery_snapshot_catalog
			 WHERE boundary_sequence <= ? ORDER BY boundary_sequence DESC, completed_at DESC LIMIT 1`,
			boundarySequence,
		).toArray()[0];
		return row ? this.snapshot(row.snapshot_id) : null;
	}

	rotateProjectionLease(input: {
		vaultId: string; vaultGeneration: string; leaseId: string; capabilityHash: string; expiresAt: number; runtimeEpoch: string; enabled: boolean; now?: number;
	}): void {
		this.initialize();
		const metadata = this.assertVaultGeneration(input.vaultGeneration);
		if (metadata.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		const now = input.now ?? Date.now();
		if (input.expiresAt <= now) throw new Error("invalid projection lease expiry");
		this.storage.sql.exec(
			`INSERT INTO recovery_projection_lease(
			 id, lease_id, capability_hash, expires_at, enabled, runtime_epoch, updated_at
			 ) VALUES (1, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			 lease_id = excluded.lease_id, capability_hash = excluded.capability_hash,
			 expires_at = excluded.expires_at, enabled = excluded.enabled,
			 runtime_epoch = excluded.runtime_epoch, updated_at = excluded.updated_at`,
			input.leaseId,
			input.capabilityHash,
			input.expiresAt,
			input.enabled ? 1 : 0,
			input.runtimeEpoch,
			now,
		).toArray();
	}

	projectionLease(): { vaultGeneration: string; leaseId: string; capabilityHash: string; expiresAt: number; enabled: boolean; runtimeEpoch: string } | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			lease_id: string; capability_hash: string; expires_at: number; enabled: number; runtime_epoch: string;
		}>("SELECT lease_id, capability_hash, expires_at, enabled, runtime_epoch FROM recovery_projection_lease WHERE id = 1").toArray()[0];
		return row ? {
			vaultGeneration: this.currentVaultGeneration(),
			leaseId: row.lease_id,
			capabilityHash: row.capability_hash,
			expiresAt: row.expires_at,
			enabled: row.enabled === 1,
			runtimeEpoch: row.runtime_epoch,
		} : null;
	}

	planPageCommitment(captureId: string, stream: CapturePlanStream, startCursor: string | null): {
		pageHash: string; endCursor: string | null; rollingDigest: string; terminal: boolean;
	} | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			page_hash: string; end_cursor: string | null; rolling_digest: string; terminal: number;
		}>(
			`SELECT page_hash, end_cursor, rolling_digest, terminal
			 FROM recovery_capture_plan_pages WHERE capture_id = ? AND stream = ? AND start_cursor = ?`,
			captureId,
			stream,
			startCursor ?? "",
		).toArray()[0];
		return row ? {
			pageHash: row.page_hash,
			endCursor: row.end_cursor,
			rollingDigest: row.rolling_digest,
			terminal: row.terminal === 1,
		} : null;
	}

	deltaPageCommitment(captureId: string, startCursor: string | null): {
		pageHash: string; endCursor: string | null; rollingDigest: string; terminal: boolean;
	} | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			page_hash: string; end_cursor: string | null; rolling_digest: string; terminal: number;
		}>(
			`SELECT page_hash, end_cursor, rolling_digest, terminal
			 FROM recovery_capture_delta_pages WHERE capture_id = ? AND start_cursor = ?`,
			captureId,
			startCursor ?? "",
		).toArray()[0];
		return row ? {
			pageHash: row.page_hash,
			endCursor: row.end_cursor,
			rollingDigest: row.rolling_digest,
			terminal: row.terminal === 1,
		} : null;
	}

	replaceInitializingCapability(captureId: string, capabilityHash: string, expiresAt: number, now = Date.now()): CaptureDescriptor {
		this.initialize();
		const update = this.storage.sql.exec(
			`UPDATE recovery_captures SET capability_hash = ?, capability_expires_at = ?, updated_at = ?
			 WHERE capture_id = ? AND state = 'initializing'`,
			capabilityHash,
			expiresAt,
			now,
			captureId,
		);
		update.toArray();
		if (update.rowsWritten !== 1) throw new Error("capture capability cannot be replaced");
		const capture = this.recoveryCapture(captureId);
		if (!capture) throw new Error("capture disappeared");
		return capture;
	}

	finalizationCoverage(captureId: string): { missingMarkdown: number; defects: number; manifestNodes: number } {
		this.initialize();

		const capture = this.recoveryCapture(captureId);
		if (!capture) throw new Error("capture not found");
		const missingMarkdown = this.storage.sql.exec<{ count: number }>(
			`SELECT COUNT(*) AS count FROM vault_catalog_events e
			 JOIN (
			   SELECT body_id, MAX(sequence) AS sequence FROM vault_catalog_events
			   WHERE sequence <= ? GROUP BY body_id
			 ) latest ON latest.body_id = e.body_id AND latest.sequence = e.sequence
			 LEFT JOIN recovery_content_index i ON i.content_hash = e.content_hash
			 LEFT JOIN recovery_defects d ON d.capture_id = ? AND d.identity = e.body_id
			   AND d.generation = e.generation
			 WHERE e.lifecycle IN ('active','tombstoned','reaped')
			   AND e.content_hash IS NOT NULL AND i.content_hash IS NULL AND d.identity IS NULL`,
			capture.boundarySequence,
			captureId,
		).one().count;
		const defects = this.storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM recovery_defects WHERE capture_id = ? AND kind IN ('active','deleted')",
			captureId,
		).one().count;
		const manifestNodes = this.storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM recovery_capture_manifest_nodes WHERE capture_id = ?",
			captureId,
		).one().count;
		return { missingMarkdown, defects, manifestNodes };
	}

	deleteSnapshot(snapshotId: string): boolean {
		this.initialize();
		const snapshot = this.snapshot(snapshotId);
		if (!snapshot) return false;
		const dependencies = this.storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM recovery_snapshot_dependencies WHERE snapshot_id = ?",
			snapshotId,

		).one().count;
		if (snapshot.pinned || dependencies > 0) throw new Error("snapshot is retained by policy or dependency");
		let deleted = false;
		this.storage.transactionSync(() => {
			this.storage.sql.exec("DELETE FROM recovery_snapshot_manifest_nodes WHERE snapshot_id = ?", snapshotId).toArray();
			const result = this.storage.sql.exec("DELETE FROM recovery_snapshot_catalog WHERE snapshot_id = ?", snapshotId);
			result.toArray();
			deleted = result.rowsWritten === 1;
		});
		return deleted;
	}

	beginVaultDeletion(deletionId: string, vaultGeneration: string, now = Date.now()): { captureJobIds: string[]; restoreIds: string[] } {
		this.initialize();
		this.assertVaultGeneration(vaultGeneration);
		const existing = this.storage.sql.exec<{ deletion_id: string; vault_generation: string }>(
			"SELECT deletion_id, vault_generation FROM vault_deletion_authority WHERE id = 1",
		).toArray()[0];
		if (existing && (existing.deletion_id !== deletionId || existing.vault_generation !== vaultGeneration)) {
			throw new Error("vault deletion authority mismatch");
		}
		const captureJobIds = this.storage.sql.exec<{ job_id: string }>(
			`SELECT job_id FROM recovery_captures
			 WHERE state IN ('initializing','queued','planning','materializing','publishing','retrying')`,
		).toArray().map((row) => row.job_id);
		const restoreIds = this.storage.sql.exec<{ operation_id: string }>(
			"SELECT DISTINCT operation_id FROM recovery_snapshot_dependencies WHERE operation_kind = 'restore'",
		).toArray().map((row) => row.operation_id);
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				"INSERT OR IGNORE INTO vault_deletion_authority(id, deletion_id, vault_generation, begun_at) VALUES (1, ?, ?, ?)",
				deletionId,
				vaultGeneration,
				now,
			).toArray();
			for (const jobId of captureJobIds) {
				this.storage.sql.exec("INSERT OR IGNORE INTO vault_deletion_jobs(job_id, kind) VALUES (?, 'capture')", jobId).toArray();
			}
			for (const restoreId of restoreIds) {
				this.storage.sql.exec("INSERT OR IGNORE INTO vault_deletion_jobs(job_id, kind) VALUES (?, 'restore')", restoreId).toArray();
			}
			this.storage.sql.exec(
				`UPDATE recovery_captures SET state = 'cancelled', capability_hash = '',
				 error = 'vault_deleting', updated_at = ?
				 WHERE state IN ('initializing','queued','planning','materializing','publishing','retrying')`,
				now,
			).toArray();
			this.storage.sql.exec(
				`UPDATE recovery_restores SET state = 'cancelled', capability_hash = '', updated_at = ?
				 WHERE state IN ('initializing','active')`,
				now,
			).toArray();
			this.storage.sql.exec("DELETE FROM vault_history_pins WHERE kind = 'capture'").toArray();
			this.storage.sql.exec("UPDATE recovery_projection_lease SET enabled = 0, capability_hash = '', updated_at = ? WHERE id = 1", now).toArray();
			this.storage.sql.exec(
				"UPDATE recovery_gc_epochs SET state = 'aborted', capability_hash = '' WHERE state IN ('marking','sweeping')",
			).toArray();
			this.storage.sql.exec("DELETE FROM recovery_snapshot_dependencies").toArray();
			this.storage.sql.exec("DELETE FROM recovery_key_leases").toArray();
		});
		return {
			captureJobIds: this.storage.sql.exec<{ job_id: string }>(
				"SELECT job_id FROM vault_deletion_jobs WHERE kind = 'capture' ORDER BY job_id",
			).toArray().map((row) => row.job_id),
			restoreIds: this.storage.sql.exec<{ job_id: string }>(
				"SELECT job_id FROM vault_deletion_jobs WHERE kind = 'restore' ORDER BY job_id",
			).toArray().map((row) => row.job_id),
		};
	}

	vaultDeletionBegun(vaultGeneration: string): boolean {
		this.initialize();
		this.assertVaultGeneration(vaultGeneration);
		return this.storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM vault_deletion_authority WHERE id = 1 AND vault_generation = ?",
			vaultGeneration,
		).one().count === 1;
	}

	setSnapshotPinned(snapshotId: string, pinned: boolean): void {
		this.initialize();
		const result = this.storage.sql.exec(
			"UPDATE recovery_snapshot_catalog SET pinned = ? WHERE snapshot_id = ?",
			pinned ? 1 : 0,
			snapshotId,
		);
		result.toArray();
		if (result.rowsWritten !== 1) throw new Error("snapshot not found");
	}

	latestGcEpoch(): GcEpoch | null {
		this.initialize();
		const row = this.storage.sql.exec<{ epoch: number }>(
			"SELECT epoch FROM recovery_gc_epochs ORDER BY epoch DESC LIMIT 1",
		).toArray()[0];
		return row ? this.gcEpoch(row.epoch) : null;
	}
}
