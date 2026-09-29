// Relay v2 spike (brief §5.2 / §5.5): durable relay-body operations over the
// existing vault tables. Only reached when `YAOS_RELAY_BODIES === "true"`.
//
// - `appendRelayBodyUpdate`: lean single-transaction journal append. It fences
//   on the body epoch only (D5.1: no head CAS, appends commute).
// - Compaction leases: `relay_compaction_leases`, created lazily so the
//   flag-off schema is untouched.
// - Semantic reset through a lease (wrapper over `semanticResetFromEncodedState`).
// - In-place backfill of an unknown (NULL) catalog content hash.
import type { VaultActorContext } from "./collaboration";
import { parseSemanticEpoch, type SemanticEpoch } from "./shared/semanticEpoch";
import type { SemanticResetResult, VaultStoragePort } from "./vaultDocumentStore";
import type { VaultStore } from "./vaultStore";

export type RelayAppendFailure = "epoch_mismatch" | "body_not_active";

export class RelayAppendError extends Error {
	constructor(readonly reason: RelayAppendFailure, readonly currentEpoch: SemanticEpoch | null) {
		super(reason);
	}
}

export interface RelayAppendInput {
	bodyId: string;
	expectedEpoch: SemanticEpoch;
	/** One journal row: the (possibly micro-batch merged) update. */
	update: Uint8Array;
	/** One attribution row per frame (`mutation_index` = index). */
	attributions: Array<{ actor: VaultActorContext; requestDigest?: string }>;
	/** Recorded only when the D6 SV rule accepted the client's claim; NULL otherwise. */
	catalogContent: { contentHash: string; size: number } | null;
	receipts: Array<{ clientId: string; candidateId: string; candidateDigest: string; runtimeEpoch: string }>;
	now?: number;
}

export interface RelayAppendResult {
	vaultSequence: number;
	generation: number;
	semanticEpoch: SemanticEpoch;
	fileId: string;
	path: string;
	contentHash: string | null;
	size: number | null;
	rowsRead: number;
	rowsWritten: number;
}

export type RelayLeaseResult =
	| { granted: true; leaseId: string; expiresAt: number; epoch: SemanticEpoch; headSequence: number; generation: number }
	| { granted: false; reason: "held" | "epoch_mismatch" | "not_found"; epoch: SemanticEpoch | null;
		headSequence: number | null; holderDeviceId?: string; expiresAt?: number };

export type RelayResetOutcome =
	| { ok: true; result: SemanticResetResult }
	| { ok: false; reason: "lease_invalid" | "lease_expired" | "epoch_mismatch" | "head_advanced";
		epoch: SemanticEpoch | null; headSequence: number | null };

export const RELAY_LEASE_DEFAULT_TTL_MS = 120_000;
export const RELAY_LEASE_MIN_TTL_MS = 1_000;
export const RELAY_LEASE_MAX_TTL_MS = 600_000;

export class RelayBodyStore {
	private leaseTableReady = false;

	constructor(private readonly storage: VaultStoragePort, private readonly store: VaultStore) {}

	appendRelayBodyUpdate(input: RelayAppendInput): RelayAppendResult {
		if (input.update.byteLength === 0) throw new Error("empty relay update is not a commit");
		if (input.attributions.length === 0) throw new Error("relay append requires attribution");
		this.store.initialize();
		const now = input.now ?? Date.now();
		let rowsRead = 0;
		let rowsWritten = 0;
		let result!: RelayAppendResult;
		this.storage.transactionSync(() => {
			const headCursor = this.storage.sql.exec<{ generation: number; semantic_epoch: number; latest_sequence: number }>(
				"SELECT generation, semantic_epoch, latest_sequence FROM vault_document_heads WHERE document_id = ?",
				input.bodyId,
			);
			const head = headCursor.toArray()[0];
			rowsRead += headCursor.rowsRead;
			if (!head) throw new RelayAppendError("body_not_active", null);
			const semanticEpoch = parseSemanticEpoch(head.semantic_epoch);
			if (semanticEpoch !== input.expectedEpoch) throw new RelayAppendError("epoch_mismatch", semanticEpoch);
			const catalogCursor = this.storage.sql.exec<{
				file_id: string; path: string; lifecycle: string; content_hash: string | null; size: number | null;
				pending: number;
			}>(
				`SELECT file_id, path, lifecycle, content_hash, size,
				        EXISTS(SELECT 1 FROM vault_creation_candidates WHERE body_id = ?) AS pending
				   FROM vault_catalog_events WHERE body_id = ? ORDER BY sequence DESC LIMIT 1`,
				input.bodyId, input.bodyId,
			);
			const catalog = catalogCursor.toArray()[0];
			rowsRead += catalogCursor.rowsRead;
			if (!catalog || catalog.lifecycle !== "active" || catalog.file_id !== input.bodyId || catalog.pending) {
				throw new RelayAppendError("body_not_active", semanticEpoch);
			}
			const clock = this.storage.sql.exec<{ sequence: number }>(
				"UPDATE vault_clock SET sequence = sequence + 1 WHERE id = 1 RETURNING sequence",
			);
			const sequence = clock.one().sequence;
			rowsWritten += clock.rowsWritten;
			const generation = head.generation + 1;
			const journal = this.storage.sql.exec(
				`INSERT INTO vault_journal(sequence, document_id, generation, semantic_epoch, kind,
				 update_byte_length, data, created_at) VALUES (?, ?, ?, ?, 'body', ?, ?, ?)`,
				sequence, input.bodyId, generation, semanticEpoch, input.update.byteLength,
				input.update.slice().buffer, now,
			);
			journal.toArray();
			rowsWritten += journal.rowsWritten;
			for (const [mutationIndex, attribution] of input.attributions.entries()) {
				const actor = attribution.actor;
				const written = this.storage.sql.exec(`INSERT INTO vault_mutation_attribution(
				 sequence, mutation_index, principal_id, membership_revision, device_id,
				 device_credential_revision, operation_id, request_digest
				) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`, sequence, mutationIndex, actor.principalId,
					actor.membershipRevision, actor.deviceId, actor.deviceCredentialRevision,
					attribution.requestDigest ?? null);
				written.toArray();
				rowsWritten += written.rowsWritten;
			}
			const writeHead = this.storage.sql.exec(
				"UPDATE vault_document_heads SET generation = ?, latest_sequence = ? WHERE document_id = ?",
				generation, sequence, input.bodyId,
			);
			writeHead.toArray();
			rowsWritten += writeHead.rowsWritten;
			const contentHash = input.catalogContent?.contentHash ?? null;
			const size = input.catalogContent?.size ?? null;
			const catalogWrite = this.storage.sql.exec(
				`INSERT INTO vault_catalog_events(
				 sequence, body_id, file_id, path, previous_path, lifecycle, generation, body_epoch,
				 content_hash, size, mutation_index
				) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?, ?, ?, 0)`,
				sequence, input.bodyId, catalog.file_id, catalog.path, generation, semanticEpoch, contentHash, size,
			);
			catalogWrite.toArray();
			rowsWritten += catalogWrite.rowsWritten;
			for (const receipt of input.receipts) {
				const written = this.storage.sql.exec(`INSERT INTO vault_candidate_receipts(
				 body_id, client_id, candidate_id, candidate_digest, body_epoch, durable_generation,
				 vault_sequence, runtime_epoch, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(body_id, client_id, candidate_id) DO NOTHING`, input.bodyId, receipt.clientId,
					receipt.candidateId, receipt.candidateDigest, semanticEpoch, generation, sequence,
					receipt.runtimeEpoch, now);
				written.toArray();
				rowsWritten += written.rowsWritten;
			}
			result = { vaultSequence: sequence, generation, semanticEpoch, fileId: catalog.file_id, path: catalog.path,
				contentHash, size, rowsRead, rowsWritten };
		});
		return result;
	}

	/** Records a lazily materialised hash on the catalog event it describes, only if still unknown. */
	backfillCatalogHash(bodyId: string, sequence: number, contentHash: string, size: number): boolean {
		const cursor = this.storage.sql.exec(
			`UPDATE vault_catalog_events SET content_hash = ?, size = ?
			  WHERE body_id = ? AND sequence = ? AND content_hash IS NULL`,
			contentHash, size, bodyId, sequence,
		);
		cursor.toArray();
		return cursor.rowsWritten > 0;
	}

	private ensureLeaseTable(): void {
		if (this.leaseTableReady) return;
		this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_compaction_leases (
			body_id TEXT PRIMARY KEY,
			lease_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			principal_id TEXT NOT NULL,
			body_epoch INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		)`).toArray();
		this.leaseTableReady = true;
	}

	acquireLease(bodyId: string, actor: VaultActorContext, expectedEpoch: number, ttlMs: number | undefined,
		now = Date.now()): RelayLeaseResult {
		this.store.initialize();
		this.ensureLeaseTable();
		const ttl = Math.min(RELAY_LEASE_MAX_TTL_MS, Math.max(RELAY_LEASE_MIN_TTL_MS,
			Number.isFinite(ttlMs) ? Math.floor(ttlMs!) : RELAY_LEASE_DEFAULT_TTL_MS));
		let outcome!: RelayLeaseResult;
		this.storage.transactionSync(() => {
			const head = this.store.documentHead(bodyId);
			if (!head) {
				outcome = { granted: false, reason: "not_found", epoch: null, headSequence: null };
				return;
			}
			if (head.semanticEpoch !== expectedEpoch) {
				outcome = { granted: false, reason: "epoch_mismatch", epoch: head.semanticEpoch, headSequence: head.latestSequence };
				return;
			}
			const existing = this.storage.sql.exec<{ device_id: string; expires_at: number }>(
				"SELECT device_id, expires_at FROM relay_compaction_leases WHERE body_id = ?", bodyId,
			).toArray()[0];
			if (existing && existing.expires_at > now && existing.device_id !== actor.deviceId) {
				outcome = { granted: false, reason: "held", epoch: head.semanticEpoch, headSequence: head.latestSequence,
					holderDeviceId: existing.device_id, expiresAt: existing.expires_at };
				return;
			}
			const leaseId = crypto.randomUUID();
			const expiresAt = now + ttl;
			this.storage.sql.exec(`INSERT INTO relay_compaction_leases(
				body_id, lease_id, device_id, principal_id, body_epoch, expires_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(body_id) DO UPDATE SET lease_id = excluded.lease_id, device_id = excluded.device_id,
			  principal_id = excluded.principal_id, body_epoch = excluded.body_epoch,
			  expires_at = excluded.expires_at, created_at = excluded.created_at`,
			bodyId, leaseId, actor.deviceId, actor.principalId, head.semanticEpoch, expiresAt, now).toArray();
			outcome = { granted: true, leaseId, expiresAt, epoch: head.semanticEpoch, headSequence: head.latestSequence,
				generation: head.generation };
		});
		return outcome;
	}

	releaseLease(bodyId: string, leaseId: string, actor: VaultActorContext): boolean {
		this.ensureLeaseTable();
		const cursor = this.storage.sql.exec(
			"DELETE FROM relay_compaction_leases WHERE body_id = ? AND lease_id = ? AND device_id = ?",
			bodyId, leaseId, actor.deviceId,
		);
		cursor.toArray();
		return cursor.rowsWritten > 0;
	}

	/**
	 * Installs a client-built GC'd snapshot. Lease, epoch and exact covered
	 * sequence are checked, then `semanticResetFromEncodedState` runs its own
	 * exact-head CAS transaction. Everything is synchronous in the DO, so
	 * nothing interleaves between these checks and the reset transaction.
	 */
	semanticReset(input: {
		bodyId: string; actor: VaultActorContext; leaseId: string; expectedEpoch: number; coveredSequence: number;
		snapshot: Uint8Array; contentHash: string; contentBytes: number; now?: number;
	}): RelayResetOutcome {
		this.store.initialize();
		this.ensureLeaseTable();
		const now = input.now ?? Date.now();
		const head = this.store.documentHead(input.bodyId);
		const fail = (reason: "lease_invalid" | "lease_expired" | "epoch_mismatch" | "head_advanced"): RelayResetOutcome =>
			({ ok: false, reason, epoch: head?.semanticEpoch ?? null, headSequence: head?.latestSequence ?? null });
		const lease = this.storage.sql.exec<{ lease_id: string; device_id: string; body_epoch: number; expires_at: number }>(
			"SELECT lease_id, device_id, body_epoch, expires_at FROM relay_compaction_leases WHERE body_id = ?", input.bodyId,
		).toArray()[0];
		if (!lease || lease.lease_id !== input.leaseId || lease.device_id !== input.actor.deviceId) return fail("lease_invalid");
		if (lease.expires_at <= now) return fail("lease_expired");
		if (!head || head.semanticEpoch !== input.expectedEpoch || lease.body_epoch !== input.expectedEpoch) {
			return fail("epoch_mismatch");
		}
		if (head.latestSequence !== input.coveredSequence) return fail("head_advanced");
		const result = this.store.semanticResetFromEncodedState(input.bodyId, input.snapshot, {
			throughSequence: head.latestSequence, generation: head.generation, semanticEpoch: head.semanticEpoch,
		}, now, { contentHash: input.contentHash, size: input.contentBytes });
		this.storage.sql.exec("DELETE FROM relay_compaction_leases WHERE body_id = ?", input.bodyId).toArray();
		return { ok: true, result };
	}

	/** TEST-ONLY diagnostics: row counts of every table. */
	tableCounts(): Record<string, number> {
		const tables = this.storage.sql.exec<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
		).toArray();
		const counts: Record<string, number> = {};
		for (const { name } of tables) {
			if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
			counts[name] = this.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM "${name}"`).one().count;
		}
		return counts;
	}

	/** Sequence of the `maxRows`-th journal row after `afterSequence`, or null when the tail is shorter. */
	tailPrefixSequence(bodyId: string, afterSequence: number, maxRows: number): number | null {
		const row = this.storage.sql.exec<{ sequence: number }>(
			`SELECT sequence FROM vault_journal WHERE document_id = ? AND sequence > ?
			 ORDER BY sequence LIMIT 1 OFFSET ?`,
			bodyId, afterSequence, Math.max(0, maxRows - 1),
		).toArray()[0];
		return row ? row.sequence : null;
	}

	journalRowCount(): number {
		return this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vault_journal").one().count;
	}
}
