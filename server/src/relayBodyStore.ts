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
import {
	decodeTailRecords, encodeTailRecords, parseReceiptRing, RELAY_RECEIPT_RING, RELAY_TAIL_HARD_MAX_BYTES,
	type RelayReceiptEntry,
} from "./relayTail";
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
	/**
	 * One attribution row per frame (`mutation_index` = index). Candidate frames
	 * carry `operationId` = candidateId and `requestDigest` = candidateDigest, as
	 * the base candidate commit does, so `committedOperationOutcome` finds them
	 * (G14) without a `vault_operation_outcomes` row.
	 */
	attributions: Array<{ actor: VaultActorContext; requestDigest?: string; operationId?: string }>;
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

/** Relay v3 group commit: one merged update for a buffered group of frames. */
export interface RelayGroupCommitInput {
	bodyId: string;
	expectedEpoch: SemanticEpoch;
	/** The group's frames merged into one update (one tail record). */
	update: Uint8Array;
	/** Actor of the group's last frame (recorded on the tail row). */
	lastActor: VaultActorContext;
	catalogContent: { contentHash: string; size: number } | null;
	receipts: Array<{ actor: VaultActorContext; candidateId: string; candidateDigest: string; runtimeEpoch: string }>;
	/** Receipt TTL (entries older than this leave the ring). */
	receiptTtlMs: number;
	now?: number;
}

export interface RelayGroupCommitResult extends RelayAppendResult {
	/** True when the group did not fit the tail (hard max) and became a lean journal row. */
	journalFallback: boolean;
	tailFrames: number;
	tailBytes: number;
}

/** Server-side reset policy state, returned with every lease response. */
export interface RelayResetPolicyState {
	/** Last semantic reset of this body (relay or server compaction), or null. */
	lastResetAt: number | null;
	cooldownMs: number;
	/** 0 when a reset is allowed now. */
	cooldownRemainingMs: number;
	nextResetAllowedAt: number | null;
}

export type RelayLeaseResult =
	| { granted: true; leaseId: string; expiresAt: number; epoch: SemanticEpoch; headSequence: number; generation: number;
		policy: RelayResetPolicyState }
	| { granted: false; reason: "held" | "epoch_mismatch" | "not_found" | "cooldown" | "authority_superseded"; epoch: SemanticEpoch | null;
		headSequence: number | null; holderDeviceId?: string; expiresAt?: number; policy?: RelayResetPolicyState };

export type RelayResetOutcome =
	| { ok: true; result: SemanticResetResult }
	| { ok: false; reason: RelayResetFailure; epoch: SemanticEpoch | null; headSequence: number | null };

export type RelayResetFailure =
	| "lease_invalid" | "lease_expired" | "epoch_mismatch" | "head_advanced" | "cooldown" | "authority_superseded";

export const RELAY_LEASE_DEFAULT_TTL_MS = 120_000;
export const RELAY_LEASE_MIN_TTL_MS = 1_000;
export const RELAY_LEASE_MAX_TTL_MS = 600_000;

export class RelayBodyStore {
	private leaseTableReady = false;
	private budgetTableReady = false;

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
			const lean = this.store.leanRows;
			if (lean) this.store.initialize(); // adds the inline columns (no-op once initialised)
			const contentHash = input.catalogContent?.contentHash ?? null;
			const size = input.catalogContent?.size ?? null;
			let sequence: number;
			if (lean) {
				// §6.4: no clock write. MAX(clock, journal head) + 1; every other allocator
				// and `currentSequence` take the same MAX in lean mode.
				const next = this.storage.sql.exec<{ sequence: number }>(
					`SELECT MAX((SELECT sequence FROM vault_clock WHERE id = 1),
					            (SELECT COALESCE(MAX(sequence), 0) FROM vault_journal)) + 1 AS sequence`,
				);
				sequence = next.one().sequence;
				rowsRead += next.rowsRead;
			} else {
				const clock = this.storage.sql.exec<{ sequence: number }>(
					"UPDATE vault_clock SET sequence = sequence + 1 WHERE id = 1 RETURNING sequence",
				);
				sequence = clock.one().sequence;
				rowsWritten += clock.rowsWritten;
			}
			const generation = head.generation + 1;
			if (lean) {
				const first = input.attributions[0]!;
				const journal = this.storage.sql.exec(
					`INSERT INTO vault_journal(sequence, document_id, generation, semantic_epoch, kind,
					 update_byte_length, data, created_at, attr_principal_id, attr_membership_revision, attr_device_id,
					 attr_device_credential_revision, attr_operation_id, attr_request_digest, relay_content_hash, relay_size)
					 VALUES (?, ?, ?, ?, 'body', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					sequence, input.bodyId, generation, semanticEpoch, input.update.byteLength,
					input.update.slice().buffer, now, first.actor.principalId, first.actor.membershipRevision,
					first.actor.deviceId, first.actor.deviceCredentialRevision, first.operationId ?? null,
					first.requestDigest ?? null, contentHash, size,
				);
				journal.toArray();
				rowsWritten += journal.rowsWritten;
			}
			const journal = lean ? null : this.storage.sql.exec(
				`INSERT INTO vault_journal(sequence, document_id, generation, semantic_epoch, kind,
				 update_byte_length, data, created_at) VALUES (?, ?, ?, ?, 'body', ?, ?, ?)`,
				sequence, input.bodyId, generation, semanticEpoch, input.update.byteLength,
				input.update.slice().buffer, now,
			);
			if (journal) {
				journal.toArray();
				rowsWritten += journal.rowsWritten;
			}
			for (const [mutationIndex, attribution] of input.attributions.entries()) {
				// Lean: frame 0 is inline on the journal row; only micro-batch extras get rows.
				if (lean && mutationIndex === 0) continue;
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
			const writeHead = this.storage.sql.exec(
				"UPDATE vault_document_heads SET generation = ?, latest_sequence = ? WHERE document_id = ?",
				generation, sequence, input.bodyId,
			);
			writeHead.toArray();
			rowsWritten += writeHead.rowsWritten;
			if (!lean) {
				const catalogWrite = this.storage.sql.exec(
					`INSERT INTO vault_catalog_events(
					 sequence, body_id, file_id, path, previous_path, lifecycle, generation, body_epoch,
					 content_hash, size, mutation_index
					) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?, ?, ?, 0)`,
					sequence, input.bodyId, catalog.file_id, catalog.path, generation, semanticEpoch, contentHash, size,
				);
				catalogWrite.toArray();
				rowsWritten += catalogWrite.rowsWritten;
			}
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

	/**
	 * Relay v3 (B1-B4): commits one buffered group in one transaction. Rows
	 * written (WITHOUT ROWID tables, no secondary indexes; see SERVER-NOTES):
	 *   1. `relay_body_tail` UPSERT (the body's tail row, record appended)  = 1
	 *   2. `vault_document_heads` UPDATE (generation, latest_sequence)       = 1
	 *   3. `relay_device_receipts` UPSERT per device with a candidate frame = 1 each
	 * No clock write (lean allocation over journal and tail heads), no journal
	 * row, no attribution rows, no catalog event, no candidate receipt rows.
	 * Fences on the body epoch only (appends commute, as v2 D5.1).
	 */
	appendRelayGroupCommit(input: RelayGroupCommitInput): RelayGroupCommitResult {
		if (input.update.byteLength === 0) throw new Error("empty relay update is not a commit");
		if (!this.store.relayTail) throw new Error("relay group commit requires the relay tail");
		this.store.initialize();
		const now = input.now ?? Date.now();
		let rowsRead = 0;
		let rowsWritten = 0;
		let result!: RelayGroupCommitResult;
		this.storage.transactionSync(() => {
			const headCursor = this.storage.sql.exec<{ generation: number; semantic_epoch: number }>(
				"SELECT generation, semantic_epoch FROM vault_document_heads WHERE document_id = ?", input.bodyId);
			const head = headCursor.toArray()[0];
			rowsRead += headCursor.rowsRead;
			if (!head) throw new RelayAppendError("body_not_active", null);
			const semanticEpoch = parseSemanticEpoch(head.semantic_epoch);
			if (semanticEpoch !== input.expectedEpoch) throw new RelayAppendError("epoch_mismatch", semanticEpoch);
			const catalogCursor = this.storage.sql.exec<{ file_id: string; path: string; lifecycle: string; pending: number }>(
				`SELECT file_id, path, lifecycle,
				        EXISTS(SELECT 1 FROM vault_creation_candidates WHERE body_id = ?) AS pending
				   FROM vault_catalog_events WHERE body_id = ? ORDER BY sequence DESC LIMIT 1`,
				input.bodyId, input.bodyId,
			);
			const catalog = catalogCursor.toArray()[0];
			rowsRead += catalogCursor.rowsRead;
			if (!catalog || catalog.lifecycle !== "active" || catalog.file_id !== input.bodyId || catalog.pending) {
				throw new RelayAppendError("body_not_active", semanticEpoch);
			}
			const next = this.store.leanNextSequence();
			const sequence = next.sequence;
			rowsRead += next.rowsRead;
			const generation = head.generation + 1;
			const contentHash = input.catalogContent?.contentHash ?? null;
			const size = input.catalogContent?.size ?? null;
			const tail = this.store.relayTailRow(input.bodyId);
			rowsRead += tail ? 1 : 0;
			if (tail && tail.epoch !== semanticEpoch) throw new Error("relay tail crosses a semantic epoch");
			const records = tail ? decodeTailRecords(tail.data) : [];
			records.push({ sequence, generation, update: input.update });
			const data = encodeTailRecords(records);
			const tailBytes = (tail?.byteLength ?? 0) + input.update.byteLength;
			let journalFallback = false;
			if (data.byteLength > RELAY_TAIL_HARD_MAX_BYTES) {
				// The tail cannot take this group (its checkpoint is not progressing):
				// fall back to one lean journal row, the v2 shape; readers merge both.
				journalFallback = true;
				const journal = this.storage.sql.exec(
					`INSERT INTO vault_journal(sequence, document_id, generation, semantic_epoch, kind,
					 update_byte_length, data, created_at, attr_principal_id, attr_membership_revision, attr_device_id,
					 attr_device_credential_revision, relay_content_hash, relay_size)
					 VALUES (?, ?, ?, ?, 'body', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					sequence, input.bodyId, generation, semanticEpoch, input.update.byteLength,
					input.update.slice().buffer, now, input.lastActor.principalId, input.lastActor.membershipRevision,
					input.lastActor.deviceId, input.lastActor.deviceCredentialRevision, contentHash, size,
				);
				journal.toArray();
				rowsWritten += journal.rowsWritten;
			} else {
				const write = this.storage.sql.exec(
					`INSERT INTO relay_body_tail(body_id, body_epoch, base_sequence, latest_sequence, generation, frames,
					 byte_length, data, content_hash, size, attr_principal_id, attr_device_id, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(body_id) DO UPDATE SET body_epoch = excluded.body_epoch,
					   latest_sequence = excluded.latest_sequence, generation = excluded.generation,
					   frames = excluded.frames, byte_length = excluded.byte_length, data = excluded.data,
					   content_hash = excluded.content_hash, size = excluded.size,
					   attr_principal_id = excluded.attr_principal_id, attr_device_id = excluded.attr_device_id,
					   updated_at = excluded.updated_at`,
					input.bodyId, semanticEpoch, records[0]!.sequence, sequence, generation, records.length, tailBytes,
					data.slice().buffer, contentHash, size, input.lastActor.principalId, input.lastActor.deviceId, now,
				);
				write.toArray();
				rowsWritten += write.rowsWritten;
			}
			const writeHead = this.storage.sql.exec(
				"UPDATE vault_document_heads SET generation = ?, latest_sequence = ? WHERE document_id = ?",
				generation, sequence, input.bodyId,
			);
			writeHead.toArray();
			rowsWritten += writeHead.rowsWritten;
			const ring = this.writeReceiptRings(input.bodyId, semanticEpoch, generation, sequence, input.receipts,
				input.receiptTtlMs, now);
			rowsRead += ring.rowsRead;
			rowsWritten += ring.rowsWritten;
			result = { vaultSequence: sequence, generation, semanticEpoch, fileId: catalog.file_id, path: catalog.path,
				contentHash, size, rowsRead, rowsWritten, journalFallback,
				tailFrames: journalFallback ? tail?.frames ?? 0 : records.length,
				tailBytes: journalFallback ? tail?.byteLength ?? 0 : tailBytes };
		});
		return result;
	}

	/**
	 * v3: rewrites each receiving device's receipt ring (newest first, TTL and
	 * RELAY_RECEIPT_RING bounded): one UPSERT = 1 written row per device. Runs
	 * inside the caller's transaction.
	 */
	private writeReceiptRings(bodyId: string, semanticEpoch: SemanticEpoch, generation: number, sequence: number,
		receipts: RelayGroupCommitInput["receipts"], receiptTtlMs: number, now: number): { rowsRead: number; rowsWritten: number } {
		let rowsRead = 0;
		let rowsWritten = 0;
		const byDevice = new Map<string, RelayReceiptEntry[]>();
		for (const receipt of receipts) {
			const entries = byDevice.get(receipt.actor.deviceId) ?? [];
			entries.push({ b: bodyId, c: receipt.candidateId, d: receipt.candidateDigest, e: semanticEpoch,
				g: generation, s: sequence, r: receipt.runtimeEpoch, t: now, p: receipt.actor.principalId,
				m: receipt.actor.membershipRevision, k: receipt.actor.deviceCredentialRevision });
			byDevice.set(receipt.actor.deviceId, entries);
		}
		for (const [clientId, entries] of byDevice) {
			const previous = this.storage.sql.exec<{ recent: string }>(
				"SELECT recent FROM relay_device_receipts WHERE client_id = ?", clientId);
			const prior = parseReceiptRing(previous.toArray()[0]?.recent);
			rowsRead += previous.rowsRead;
			const fresh = new Set(entries.map((entry) => `${entry.b}\u0000${entry.c}`));
			const ring = [...entries.reverse(), ...prior.filter((entry) => entry.t > now - receiptTtlMs
				&& !fresh.has(`${entry.b}\u0000${entry.c}`))].slice(0, RELAY_RECEIPT_RING);
			const write = this.storage.sql.exec(
				`INSERT INTO relay_device_receipts(client_id, last_sequence, recent, updated_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT(client_id) DO UPDATE SET last_sequence = MAX(last_sequence, excluded.last_sequence),
				   recent = excluded.recent, updated_at = excluded.updated_at`,
				clientId, sequence, JSON.stringify(ring), now,
			);
			write.toArray();
			rowsWritten += write.rowsWritten;
		}
		return { rowsRead, rowsWritten };
	}

	/**
	 * v3 HTTP save: records a candidate that changed nothing (its bytes are
	 * already durable) in the device's receipt ring only (1 row), so replay,
	 * digest-reuse detection and the operation-outcome lookup behave as for a
	 * committed candidate. Fences on the body epoch.
	 */
	recordRelayReceipts(input: { bodyId: string; expectedEpoch: SemanticEpoch;
		receipts: RelayGroupCommitInput["receipts"]; receiptTtlMs: number; now?: number }):
		{ generation: number; vaultSequence: number; semanticEpoch: SemanticEpoch; rowsWritten: number } {
		if (!this.store.relayTail) throw new Error("relay receipts require the relay tail");
		this.store.initialize();
		const now = input.now ?? Date.now();
		let result!: { generation: number; vaultSequence: number; semanticEpoch: SemanticEpoch; rowsWritten: number };
		this.storage.transactionSync(() => {
			const head = this.storage.sql.exec<{ generation: number; semantic_epoch: number; latest_sequence: number }>(
				"SELECT generation, semantic_epoch, latest_sequence FROM vault_document_heads WHERE document_id = ?",
				input.bodyId).toArray()[0];
			if (!head) throw new RelayAppendError("body_not_active", null);
			const semanticEpoch = parseSemanticEpoch(head.semantic_epoch);
			if (semanticEpoch !== input.expectedEpoch) throw new RelayAppendError("epoch_mismatch", semanticEpoch);
			const ring = this.writeReceiptRings(input.bodyId, semanticEpoch, head.generation, head.latest_sequence,
				input.receipts, input.receiptTtlMs, now);
			result = { generation: head.generation, vaultSequence: head.latest_sequence, semanticEpoch, rowsWritten: ring.rowsWritten };
		});
		return result;
	}

	/** v3: bodies whose tail row is at or over the cap (alarm pass). */
	tailCheckpointCandidates(bytes: number, frames: number, limit: number): string[] {
		if (!this.store.relayTail) return [];
		this.store.initialize();
		return this.storage.sql.exec<{ body_id: string }>(
			`SELECT body_id FROM relay_body_tail WHERE byte_length >= ? OR frames >= ? ORDER BY base_sequence LIMIT ?`,
			bytes, frames, limit,
		).toArray().map((row) => row.body_id);
	}

	/** Records a lazily materialised hash on the catalog event it describes, only if still unknown. */
	backfillCatalogHash(bodyId: string, sequence: number, contentHash: string, size: number): boolean {
		if (this.store.relayTail) {
			// v3: the overlaid head names the tail's last commit; backfill it on the tail row.
			const tailed = this.storage.sql.exec(
				`UPDATE relay_body_tail SET content_hash = ?, size = ?
				  WHERE body_id = ? AND latest_sequence = ? AND content_hash IS NULL`,
				contentHash, size, bodyId, sequence,
			);
			tailed.toArray();
			if (tailed.rowsWritten > 0) return true;
		}
		if (this.store.leanRows) {
			// Lean: the overlaid catalog head names the journal row; backfill it inline.
			const inline = this.storage.sql.exec(
				`UPDATE vault_journal SET relay_content_hash = ?, relay_size = ?
				  WHERE document_id = ? AND sequence = ? AND relay_content_hash IS NULL`,
				contentHash, size, bodyId, sequence,
			);
			inline.toArray();
			if (inline.rowsWritten > 0) return true;
		}
		const cursor = this.storage.sql.exec(
			`UPDATE vault_catalog_events SET content_hash = ?, size = ?
			  WHERE body_id = ? AND sequence = ? AND content_hash IS NULL`,
			contentHash, size, bodyId, sequence,
		);
		cursor.toArray();
		return cursor.rowsWritten > 0;
	}

	/**
	 * Lean mode (§6.4): one catalog event per body whose journal head is newer
	 * than its latest catalog event, carrying the head generation and the head
	 * row's inline hash (NULL when unknown). Run by the alarm (coalescing delay)
	 * and before a semantic reset. Also raises the clock to the journal head so
	 * pruning can never free a sequence. Returns bodies coalesced and rows written.
	 */
	coalesceLeanCatalog(options: { bodyId?: string; limit?: number } = {}): { bodies: number; rowsWritten: number } {
		if (!this.store.leanRows) return { bodies: 0, rowsWritten: 0 };
		let bodies = 0;
		let rowsWritten = 0;
		this.storage.transactionSync(() => {
			rowsWritten += this.store.syncLeanClock();
			const pending = this.storage.sql.exec<{ document_id: string; generation: number; semantic_epoch: number }>(
				`SELECT h.document_id, h.generation, h.semantic_epoch FROM vault_document_heads h
				  WHERE h.document_id <> 'root' ${options.bodyId !== undefined ? "AND h.document_id = ?" : ""}
				    AND h.latest_sequence > COALESCE(
				      (SELECT MAX(c.sequence) FROM vault_catalog_events c WHERE c.body_id = h.document_id), 9007199254740991)
				  LIMIT ?`,
				...(options.bodyId !== undefined ? [options.bodyId] : []), options.limit ?? 100,
			).toArray();
			for (const head of pending) {
				const catalog = this.storage.sql.exec<{ file_id: string; path: string; lifecycle: string }>(
					"SELECT file_id, path, lifecycle FROM vault_catalog_events WHERE body_id = ? ORDER BY sequence DESC LIMIT 1",
					head.document_id,
				).toArray()[0];
				if (!catalog || catalog.lifecycle !== "active") continue;
				const row = this.storage.sql.exec<{ generation: number; relay_content_hash: string | null; relay_size: number | null }>(
					`SELECT generation, relay_content_hash, relay_size FROM vault_journal
					  WHERE document_id = ? ORDER BY sequence DESC LIMIT 1`, head.document_id,
				).toArray()[0];
				let known = row && row.generation === head.generation && row.relay_content_hash !== null;
				let tailHash: { hash: string | null; size: number | null } | null = null;
				const tail = this.store.relayTailRow(head.document_id);
				if (tail && tail.generation === head.generation) {
					// v3: the head commit is the tail's last record.
					tailHash = { hash: tail.contentHash, size: tail.size };
					known = false;
				}
				const clock = this.store.advanceClock();
				rowsWritten += clock.rowsWritten;
				const event = this.storage.sql.exec(
					`INSERT INTO vault_catalog_events(
					 sequence, body_id, file_id, path, previous_path, lifecycle, generation, body_epoch,
					 content_hash, size, mutation_index
					) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?, ?, ?, 0)`,
					clock.sequence, head.document_id, catalog.file_id, catalog.path, head.generation, head.semantic_epoch,
					tailHash ? tailHash.hash : known ? row!.relay_content_hash : null,
					tailHash ? tailHash.size : known ? row!.relay_size : null,
				);
				event.toArray();
				rowsWritten += event.rowsWritten;
				bodies++;
			}
		});
		return { bodies, rowsWritten };
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

	/**
	 * Cooldown state from `vault_semantic_compaction_state.last_compacted_at`,
	 * which every semantic reset (relay or base compaction) already writes in
	 * its own transaction, so no extra row is written per reset.
	 */
	resetPolicy(bodyId: string, cooldownMs: number, now = Date.now()): RelayResetPolicyState {
		const lastResetAt = this.store.semanticCompactionState(bodyId)?.lastCompactedAt ?? null;
		const nextResetAllowedAt = lastResetAt === null ? null : lastResetAt + cooldownMs;
		return { lastResetAt, cooldownMs, nextResetAllowedAt,
			cooldownRemainingMs: nextResetAllowedAt === null ? 0 : Math.max(0, nextResetAllowedAt - now) };
	}

	acquireLease(bodyId: string, actor: VaultActorContext, expectedEpoch: number, ttlMs: number | undefined,
		now = Date.now(), cooldownMs = 0): RelayLeaseResult {
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
			const policy = this.resetPolicy(bodyId, cooldownMs, now);
			if (head.semanticEpoch !== expectedEpoch) {
				outcome = { granted: false, reason: "epoch_mismatch", epoch: head.semanticEpoch, headSequence: head.latestSequence,
					policy };
				return;
			}
			if (policy.cooldownRemainingMs > 0) {
				outcome = { granted: false, reason: "cooldown", epoch: head.semanticEpoch, headSequence: head.latestSequence,
					policy };
				return;
			}
			const existing = this.storage.sql.exec<{ device_id: string; expires_at: number }>(
				"SELECT device_id, expires_at FROM relay_compaction_leases WHERE body_id = ?", bodyId,
			).toArray()[0];
			if (existing && existing.expires_at > now && existing.device_id !== actor.deviceId) {
				outcome = { granted: false, reason: "held", epoch: head.semanticEpoch, headSequence: head.latestSequence,
					holderDeviceId: existing.device_id, expiresAt: existing.expires_at, policy };
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
				generation: head.generation, policy };
		});
		return outcome;
	}

	/**
	 * G19: drops every lease held by these devices / principals (called after an
	 * authority change touches them). The install path re-checks authority anyway;
	 * this frees the body for other devices at once instead of at lease expiry.
	 */
	releaseLeasesFor(subjects: { deviceIds?: Iterable<string>; principalIds?: Iterable<string> }): number {
		this.ensureLeaseTable();
		let released = 0;
		for (const deviceId of subjects.deviceIds ?? []) {
			const cursor = this.storage.sql.exec("DELETE FROM relay_compaction_leases WHERE device_id = ?", deviceId);
			cursor.toArray();
			released += cursor.rowsWritten;
		}
		for (const principalId of subjects.principalIds ?? []) {
			const cursor = this.storage.sql.exec("DELETE FROM relay_compaction_leases WHERE principal_id = ?", principalId);
			cursor.toArray();
			released += cursor.rowsWritten;
		}
		return released;
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
		snapshot: Uint8Array; contentHash: string; contentBytes: number; now?: number; cooldownMs?: number;
		/** G19: authority re-check at install time (after the possibly long body read). */
		authorize?: () => boolean;
	}): RelayResetOutcome {
		this.store.initialize();
		this.ensureLeaseTable();
		const now = input.now ?? Date.now();
		const head = this.store.documentHead(input.bodyId);
		const fail = (reason: RelayResetFailure): RelayResetOutcome =>
			({ ok: false, reason, epoch: head?.semanticEpoch ?? null, headSequence: head?.latestSequence ?? null });
		// Everything below is synchronous in the DO: nothing interleaves between this
		// check and the reset transaction, so it is equivalent to checking inside it.
		if (input.authorize && !input.authorize()) {
			this.storage.sql.exec("DELETE FROM relay_compaction_leases WHERE device_id = ?", input.actor.deviceId).toArray();
			return fail("authority_superseded");
		}
		const lease = this.storage.sql.exec<{ lease_id: string; device_id: string; body_epoch: number; expires_at: number }>(
			"SELECT lease_id, device_id, body_epoch, expires_at FROM relay_compaction_leases WHERE body_id = ?", input.bodyId,
		).toArray()[0];
		if (!lease || lease.lease_id !== input.leaseId || lease.device_id !== input.actor.deviceId) return fail("lease_invalid");
		if (lease.expires_at <= now) return fail("lease_expired");
		if (!head || head.semanticEpoch !== input.expectedEpoch || lease.body_epoch !== input.expectedEpoch) {
			return fail("epoch_mismatch");
		}
		// Currency proof (round 2): epoch CAS + valid lease + coveredSequence == head.latest_sequence
		// exactly. No state-vector check: SV coverage is not currency (a delete-only
		// update leaves the SV unchanged) and a lineage-fresh snapshot never covers
		// the old lineage's client ids.
		if (head.latestSequence !== input.coveredSequence) return fail("head_advanced");
		if (this.resetPolicy(input.bodyId, input.cooldownMs ?? 0, now).cooldownRemainingMs > 0) return fail("cooldown");
		// Lean: the reset's catalog event copies the latest one; publish the head first.
		this.coalesceLeanCatalog({ bodyId: input.bodyId });
		const result = this.store.semanticResetFromEncodedState(input.bodyId, input.snapshot, {
			throughSequence: head.latestSequence, generation: head.generation, semanticEpoch: head.semanticEpoch,
		}, now, { contentHash: input.contentHash, size: input.contentBytes });
		this.storage.sql.exec("DELETE FROM relay_compaction_leases WHERE body_id = ?", input.bodyId).toArray();
		return { ok: true, result };
	}

	/** TEST-ONLY diagnostics: row counts of every table. */
	/** Attribution rows plus lean inline attributions (journal rows carrying `attr_*`). */
	attributionCount(): number {
		const table = this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vault_mutation_attribution").one().count;
		if (!this.store.leanRows) return table;
		return table + this.storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM vault_journal WHERE attr_principal_id IS NOT NULL").one().count;
	}

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

	/** Byte length of a stored checkpoint (manifest total, else the sum of its chunks); 0 when none. */
	checkpointByteLength(bodyId: string, checkpointSequence: number): number {
		if (checkpointSequence <= 0) return 0;
		return this.storage.sql.exec<{ bytes: number | null }>(
			`SELECT COALESCE(
			   (SELECT total_byte_length FROM vault_checkpoint_manifests WHERE document_id = ? AND checkpoint_sequence = ?),
			   (SELECT SUM(chunk_byte_length) FROM vault_checkpoints WHERE document_id = ? AND checkpoint_sequence = ?),
			   0) AS bytes`,
			bodyId, checkpointSequence, bodyId, checkpointSequence,
		).one().bytes ?? 0;
	}

	/**
	 * G20: the last journal sequence of the longest tail prefix after
	 * `afterSequence` with at most `maxRows` rows and at most `maxBytes` summed
	 * update bytes. `null` when even the first row does not fit (or no rows).
	 */
	tailPrefixBounded(bodyId: string, afterSequence: number, maxRows: number, maxBytes: number):
		{ sequence: number; rows: number; bytes: number } | null {
		const rows = this.storage.sql.exec<{ sequence: number; update_byte_length: number }>(
			`SELECT sequence, update_byte_length FROM vault_journal WHERE document_id = ? AND sequence > ?
			 ORDER BY sequence LIMIT ?`,
			bodyId, afterSequence, Math.max(1, maxRows),
		).toArray();
		let best: { sequence: number; rows: number; bytes: number } | null = null;
		let bytes = 0;
		for (const [index, row] of rows.entries()) {
			bytes += row.update_byte_length;
			if (bytes > maxBytes) break;
			best = { sequence: row.sequence, rows: index + 1, bytes };
		}
		return best;
	}

	private ensureBudgetTable(): void {
		if (this.budgetTableReady) return;
		this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_body_budget (
			body_id TEXT PRIMARY KEY,
			body_epoch INTEGER NOT NULL,
			input_bytes INTEGER NOT NULL,
			marked_at INTEGER NOT NULL
		)`).toArray();
		this.budgetTableReady = true;
	}

	/** G20: persists "checkpoint cannot progress within the merge budget" for this epoch. */
	markOverBudget(bodyId: string, bodyEpoch: number, inputBytes: number, now = Date.now()): void {
		this.ensureBudgetTable();
		this.storage.sql.exec(`INSERT INTO relay_body_budget(body_id, body_epoch, input_bytes, marked_at)
			VALUES (?, ?, ?, ?) ON CONFLICT(body_id) DO UPDATE SET body_epoch = excluded.body_epoch,
			input_bytes = excluded.input_bytes, marked_at = excluded.marked_at`,
		bodyId, bodyEpoch, inputBytes, now).toArray();
	}

	clearOverBudget(bodyId: string): void {
		this.ensureBudgetTable();
		this.storage.sql.exec("DELETE FROM relay_body_budget WHERE body_id = ?", bodyId).toArray();
	}

	/** Every persisted over-budget marker (read once per runtime; valid only while the epoch matches). */
	overBudgetMarkers(): Map<string, number> {
		this.ensureBudgetTable();
		const rows = this.storage.sql.exec<{ body_id: string; body_epoch: number }>(
			"SELECT body_id, body_epoch FROM relay_body_budget").toArray();
		return new Map(rows.map((row) => [row.body_id, row.body_epoch]));
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

	/** COUNT(*) over the whole journal: diagnostics/debug routes and tests only (G15), never a hot path. */
	journalRowCount(): number {
		return this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vault_journal").one().count;
	}
}
