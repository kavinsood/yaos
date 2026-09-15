import { VaultDocumentStore } from "./vaultDocumentStore";
import type { DurableCommitResult, VaultCommitKind } from "./vaultDocumentStore";
import { parseSemanticEpoch, type SemanticEpoch } from "./shared/semanticEpoch";
import type { VaultActorContext } from "./collaboration";

export const MAX_CANDIDATE_RECEIPTS_PER_BODY = 256;
export const MAX_CANDIDATE_RECEIPTS_GLOBAL = 4096;
export const MAX_CANDIDATE_RECEIPT_LEDGER_BYTES = 8 * 1024 * 1024;
export const CANDIDATE_RECEIPT_TTL_MS = 30 * 24 * 60 * 60_000;

export type BodyLifecycle = "active" | "tombstoned" | "reaped";

export interface CatalogMutation {
	bodyId: string;
	fileId: string;
	path: string;
	previousPath: string | null;
	lifecycle: BodyLifecycle;
	bodyGeneration: number;
	contentHash?: string | null;
	size?: number | null;
}

export interface SemanticCatalogMutation {
	documentId: string;
	fileId: string;
	kind: "canvas";
	format: "json-canvas";
	formatVersion: 1;
	path: string;
	previousPath: string | null;
	lifecycle: "active" | "tombstoned" | "reaped";
	documentGeneration: number;
	contentHash?: string | null;
	size?: number | null;
}

export interface SemanticCatalogHead {
	sequence: number;
	documentId: string;
	fileId: string;
	kind: "canvas";
	format: "json-canvas";
	formatVersion: 1;
	path: string;
	previousPath: string | null;
	lifecycle: "active" | "tombstoned" | "reaped";
	generation: number;
	bodyEpoch: SemanticEpoch;
	contentHash: string | null;
	size: number | null;
}

export interface ExcalidrawCatalogMutation {
	documentId: string;
	fileId: string;
	kind: "excalidraw";
	format: "excalidraw-native";
	formatVersion: 1;
	path: string;
	previousPath: string | null;
	lifecycle: "active" | "tombstoned" | "reaped";
	documentGeneration: number;
	documentEpoch: SemanticEpoch;
	contentHash?: string | null;
	size?: number | null;
}

export interface ExcalidrawCatalogHead extends ExcalidrawCatalogMutation {
	sequence: number;
	bodyEpoch: SemanticEpoch;
}

export interface SemanticCandidateReceipt {
	documentId: string;
	clientId: string;
	candidateId: string;
	candidateDigest: string;
	bodyEpoch: SemanticEpoch;
	durableGeneration: number;
	vaultSequence: number;
	vaultGeneration: string;
	runtimeEpoch: string;
	contentHash: string;
	size: number;
}

export interface SemanticLifecycleReceipt {
	operationId: string;
	requestDigest: string;
	documentId: string;
	fileId: string;
	kind: "create" | "rename" | "delete" | "revive";
	resultPath: string;
	resultLifecycle: "active" | "tombstoned";
	durableGeneration: number;
	bodyEpoch: SemanticEpoch;
	vaultSequence: number;
	rootGeneration: number;
	rootEpoch: SemanticEpoch;
	vaultGeneration: string;
	runtimeEpoch: string;
}

export interface DurableCandidateReceipt {
	bodyId: string;
	clientId: string;
	candidateId: string;
	candidateDigest: string;
	bodyEpoch: SemanticEpoch;
	durableGeneration: number;
	vaultSequence: number;
	vaultGeneration: string;
	runtimeEpoch: string;
}

export interface PendingCreationCandidate {
	bodyId: string;
	bodyEpoch: SemanticEpoch;
	fileId: string;
	path: string;
	operationId: string;
	candidateId: string;
	candidateDigest: string;
	durableGeneration: number;
	vaultSequence: number;
	vaultGeneration: string;
	runtimeEpoch: string;
}

export interface DurableLifecycleRecord {
	operationId: string;
	kind: Extract<VaultCommitKind, "create" | "rename" | "delete" | "revive">;
	bodyId: string;
	bodyEpoch: SemanticEpoch;
	fileId: string;
	candidateId: string | null;
	candidateDigest: string | null;
	sourcePath: string | null;
	resultPath: string;
	resultLifecycle: "active" | "tombstoned";
	durableGeneration: number;
	rootGeneration: number;
	vaultSequence: number;
	vaultGeneration: string;
	runtimeEpoch: string;
}

export interface DurableRootPublication {
	operationId: string;
	lifecycleSequence: number;
	rootSequence: number;
	rootGeneration: number;
	rootEpoch: SemanticEpoch;
	vaultGeneration: string;
	runtimeEpoch: string;
}

export interface CatalogHeadAtBoundary {
	sequence: number;
	bodyId: string;
	bodyEpoch: SemanticEpoch;
	fileId: string;
	path: string;
	previousPath: string | null;
	lifecycle: BodyLifecycle;
	generation: number;
	contentHash: string | null;
	size: number | null;
}

export interface AttachmentCatalogEvent {
	sequence: number;
	path: string;
	contentHash: string | null;
	size: number | null;
	mime: string | null;
	lifecycle: "active" | "deleted";
	operationId: string;
}

/**
 * Complete durable authority needed to rebuild the root CRDT at one immutable
 * vault sequence. Root semantic compaction must never infer this authority
 * from the resident root: that document can be stale or internally divergent.
 */
export interface RootAuthoritySnapshot {
	boundarySequence: number;
	markdown: CatalogHeadAtBoundary[];
	semantic: SemanticCatalogHead[];
	excalidraw: ExcalidrawCatalogHead[];
	attachments: Array<AttachmentCatalogEvent & { createdAt: number }>;
	blobs: Array<{ contentHash: string; size: number | null; mime: string | null; createdAt: number }>;
}

export interface DurableAttachmentOperation {
	operationId: string;
	requestDigest: string;
	rootSequence: number;
	rootGeneration: number;
	rootEpoch: SemanticEpoch;
}

export interface CatalogDeltaEntry {
	sequence: number;
	order: number;
	kind: "create" | "rename" | "delete" | "revive" | "body-hash" | "attachment-upsert" | "attachment-delete";
	identity: string;
	path: string;
	previousPath: string | null;
	contentHash: string | null;
	size: number | null;
	mime: string | null;
}

/** File, body, attachment, candidate, and lifecycle catalog storage. */
export abstract class VaultCatalogStore extends VaultDocumentStore {
	rootAuthoritySnapshotAt(boundarySequence: number): RootAuthoritySnapshot {
		this.initialize();
		if (!Number.isSafeInteger(boundarySequence) || boundarySequence < 0) {
			throw new Error("invalid root authority boundary");
		}
		const markdown = this.storage.sql.exec<{
			sequence: number; body_id: string; file_id: string; path: string; previous_path: string | null;
			lifecycle: BodyLifecycle; generation: number; body_epoch: number; content_hash: string | null; size: number | null;
		}>(`SELECT e.sequence, e.body_id, e.file_id, e.path, e.previous_path, e.lifecycle,
		          e.generation, e.body_epoch, e.content_hash, e.size
		   FROM vault_catalog_events e JOIN (
		     SELECT body_id, MAX(sequence) AS sequence FROM vault_catalog_events
		     WHERE sequence <= ? GROUP BY body_id
		   ) latest ON latest.body_id = e.body_id AND latest.sequence = e.sequence
		   ORDER BY e.body_id`, boundarySequence).toArray().map((row) => ({
			sequence: row.sequence,
			bodyId: row.body_id,
			bodyEpoch: parseSemanticEpoch(row.body_epoch, "root authority body epoch"),
			fileId: row.file_id,
			path: row.path,
			previousPath: row.previous_path,
			lifecycle: row.lifecycle,
			generation: row.generation,
			contentHash: row.content_hash,
			size: row.size,
		}));
		const semantic = this.storage.sql.exec<{
			sequence: number; document_id: string; file_id: string; kind: "canvas"; format: "json-canvas";
			format_version: 1; path: string; previous_path: string | null; lifecycle: SemanticCatalogHead["lifecycle"];
			generation: number; document_epoch: number; content_hash: string | null; size: number | null;
		}>(`SELECT e.sequence, e.document_id, e.file_id, e.kind, e.format, e.format_version,
		          e.path, e.previous_path, e.lifecycle, e.generation, e.document_epoch,
		          e.content_hash, e.size
		   FROM vault_semantic_catalog_events e JOIN (
		     SELECT document_id, MAX(sequence) AS sequence FROM vault_semantic_catalog_events
		     WHERE sequence <= ? AND kind = 'canvas' GROUP BY document_id
		   ) latest ON latest.document_id = e.document_id AND latest.sequence = e.sequence
		   WHERE e.kind = 'canvas' ORDER BY e.document_id`, boundarySequence).toArray().map((row) => ({
			sequence: row.sequence,
			documentId: row.document_id,
			fileId: row.file_id,
			kind: row.kind,
			format: row.format,
			formatVersion: row.format_version,
			path: row.path,
			previousPath: row.previous_path,
			lifecycle: row.lifecycle,
			generation: row.generation,
			bodyEpoch: parseSemanticEpoch(row.document_epoch, "root authority semantic epoch"),
			contentHash: row.content_hash,
			size: row.size,
		}));
		const excalidraw = this.listActiveExcalidrawAt(boundarySequence, "", 1000);
		const attachments = this.storage.sql.exec<{
			sequence: number; path: string; content_hash: string | null; size: number | null;
			mime: string | null; lifecycle: AttachmentCatalogEvent["lifecycle"]; operation_id: string;
			created_at: number;
		}>(`SELECT e.sequence, e.path, e.content_hash, e.size, e.mime, e.lifecycle,
		          e.operation_id, COALESCE(a.created_at, s.created_at, 0) AS created_at
		   FROM vault_attachment_catalog_events e JOIN (
		     SELECT path, MAX(sequence) AS sequence FROM vault_attachment_catalog_events
		     WHERE sequence <= ? GROUP BY path
		   ) latest ON latest.path = e.path AND latest.sequence = e.sequence
		   LEFT JOIN vault_attachment_operations a ON a.operation_id = e.operation_id
		   LEFT JOIN vault_semantic_authority_receipts s ON s.operation_id = e.operation_id
		   ORDER BY e.path`, boundarySequence).toArray().map((row) => ({
			sequence: row.sequence,
			path: row.path,
			contentHash: row.content_hash,
			size: row.size,
			mime: row.mime,
			lifecycle: row.lifecycle,
			operationId: row.operation_id,
			createdAt: row.created_at,
		}));
		const blobs = this.storage.sql.exec<{
			content_hash: string; size: number | null; mime: string | null; created_at: number;
		}>(`WITH current_paths AS (
		     SELECT e.content_hash FROM vault_attachment_catalog_events e JOIN (
		       SELECT path, MAX(sequence) AS sequence FROM vault_attachment_catalog_events
		       WHERE sequence <= ? GROUP BY path
		     ) latest ON latest.path = e.path AND latest.sequence = e.sequence
		     WHERE e.content_hash IS NOT NULL
		   ), first_blob AS (
		     SELECT e.content_hash, MIN(e.sequence) AS sequence
		     FROM vault_attachment_catalog_events e JOIN current_paths c ON c.content_hash = e.content_hash
		     WHERE e.sequence <= ? AND e.lifecycle = 'active' GROUP BY e.content_hash
		   ), first_blob_row AS (
		     SELECT e.content_hash, e.sequence, MIN(e.path) AS path
		     FROM vault_attachment_catalog_events e JOIN first_blob f
		       ON f.content_hash = e.content_hash AND f.sequence = e.sequence
		     WHERE e.lifecycle = 'active' GROUP BY e.content_hash, e.sequence
		   )
		   SELECT e.content_hash, e.size, e.mime,
		          COALESCE(a.created_at, s.created_at, 0) AS created_at
		   FROM vault_attachment_catalog_events e JOIN first_blob_row f
		     ON f.content_hash = e.content_hash AND f.sequence = e.sequence AND f.path = e.path
		   LEFT JOIN vault_attachment_operations a ON a.operation_id = e.operation_id
		   LEFT JOIN vault_semantic_authority_receipts s ON s.operation_id = e.operation_id
		   ORDER BY e.content_hash`, boundarySequence, boundarySequence).toArray().map((row) => ({
			contentHash: row.content_hash,
			size: row.size,
			mime: row.mime,
			createdAt: row.created_at,
		}));
		return { boundarySequence, markdown, semantic, excalidraw, attachments, blobs };
	}

	semanticHeadAt(boundarySequence: number, documentId: string): SemanticCatalogHead | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			sequence: number; document_id: string; file_id: string; kind: "canvas"; format: "json-canvas";
			format_version: 1; path: string; previous_path: string | null; lifecycle: SemanticCatalogHead["lifecycle"];
			generation: number; document_epoch: number; content_hash: string | null; size: number | null;
		}>(`SELECT sequence, document_id, file_id, kind, format, format_version, path, previous_path,
		          lifecycle, generation, document_epoch, content_hash, size
		   FROM vault_semantic_catalog_events
		   WHERE document_id = ? AND kind = 'canvas' AND sequence <= ? ORDER BY sequence DESC LIMIT 1`, documentId, boundarySequence).toArray()[0];
		return row ? { sequence: row.sequence, documentId: row.document_id, fileId: row.file_id, kind: row.kind,
			format: row.format, formatVersion: row.format_version, path: row.path, previousPath: row.previous_path,
			lifecycle: row.lifecycle, generation: row.generation,
			bodyEpoch: parseSemanticEpoch(row.document_epoch, "semantic catalog document epoch"),
			contentHash: row.content_hash, size: row.size } : null;
	}

	listActiveSemanticAt(boundarySequence: number, afterDocumentId = "", limit = 1000): SemanticCatalogHead[] {
		this.initialize();
		return this.storage.sql.exec<{
			sequence: number; document_id: string; file_id: string; kind: "canvas"; format: "json-canvas";
			format_version: 1; path: string; previous_path: string | null; lifecycle: "active";
			generation: number; document_epoch: number; content_hash: string | null; size: number | null;
		}>(`SELECT e.sequence, e.document_id, e.file_id, e.kind, e.format, e.format_version, e.path,
		          e.previous_path, e.lifecycle, e.generation, e.document_epoch, e.content_hash, e.size
		   FROM vault_semantic_catalog_events e JOIN (
		     SELECT document_id, MAX(sequence) AS sequence FROM vault_semantic_catalog_events
		     WHERE sequence <= ? AND kind = 'canvas' GROUP BY document_id
		   ) latest ON latest.document_id = e.document_id AND latest.sequence = e.sequence
		 WHERE e.lifecycle = 'active' AND e.kind = 'canvas' AND e.document_id > ? ORDER BY e.document_id LIMIT ?`,
		boundarySequence, afterDocumentId, Math.min(1000, Math.max(1, limit))).toArray().map((row) => ({
			sequence: row.sequence, documentId: row.document_id, fileId: row.file_id, kind: row.kind,
			format: row.format, formatVersion: row.format_version, path: row.path, previousPath: row.previous_path,
			lifecycle: row.lifecycle, generation: row.generation,
			bodyEpoch: parseSemanticEpoch(row.document_epoch, "semantic catalog document epoch"),
			contentHash: row.content_hash, size: row.size,
		}));
	}

	countActiveSemanticAt(boundarySequence: number): number {
		this.initialize();
		return this.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count
		 FROM vault_semantic_catalog_events e JOIN (
		   SELECT document_id, MAX(sequence) AS sequence FROM vault_semantic_catalog_events
		   WHERE sequence <= ? AND kind = 'canvas' GROUP BY document_id
		 ) latest ON latest.document_id = e.document_id AND latest.sequence = e.sequence
		 WHERE e.lifecycle = 'active' AND e.kind = 'canvas'`, boundarySequence).one().count;
	}

	excalidrawHeadAt(boundarySequence: number, documentId: string): ExcalidrawCatalogHead | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			sequence: number; document_id: string; file_id: string; path: string; previous_path: string | null;
			lifecycle: ExcalidrawCatalogHead["lifecycle"]; generation: number; document_epoch: number;
			content_hash: string | null; size: number | null;
		}>(`SELECT sequence, document_id, file_id, path, previous_path, lifecycle, generation,
		          document_epoch, content_hash, size
		   FROM vault_semantic_catalog_events
		   WHERE document_id = ? AND kind = 'excalidraw' AND sequence <= ?
		   ORDER BY sequence DESC LIMIT 1`, documentId, boundarySequence).toArray()[0];
		return row ? { sequence: row.sequence, documentId: row.document_id, fileId: row.file_id,
			kind: "excalidraw", format: "excalidraw-native", formatVersion: 1, path: row.path,
			previousPath: row.previous_path, lifecycle: row.lifecycle, documentGeneration: row.generation,
			documentEpoch: parseSemanticEpoch(row.document_epoch, "Excalidraw catalog document epoch"),
			bodyEpoch: parseSemanticEpoch(row.document_epoch, "Excalidraw catalog document epoch"),
			contentHash: row.content_hash, size: row.size } : null;
	}

	listActiveExcalidrawAt(boundarySequence: number, afterDocumentId = "", limit = 1000): ExcalidrawCatalogHead[] {
		this.initialize();
		return this.storage.sql.exec<{
			sequence: number; document_id: string; file_id: string; path: string; previous_path: string | null;
			lifecycle: "active"; generation: number; document_epoch: number; content_hash: string | null; size: number | null;
		}>(`SELECT e.sequence, e.document_id, e.file_id, e.path, e.previous_path, e.lifecycle,
		          e.generation, e.document_epoch, e.content_hash, e.size
		   FROM vault_semantic_catalog_events e JOIN (
		     SELECT document_id, MAX(sequence) AS sequence FROM vault_semantic_catalog_events
		     WHERE sequence <= ? AND kind = 'excalidraw' GROUP BY document_id
		   ) latest ON latest.document_id = e.document_id AND latest.sequence = e.sequence
		   WHERE e.lifecycle = 'active' AND e.kind = 'excalidraw' AND e.document_id > ?
		   ORDER BY e.document_id LIMIT ?`, boundarySequence, afterDocumentId,
		Math.min(1000, Math.max(1, limit))).toArray().map((row) => ({ sequence: row.sequence,
			documentId: row.document_id, fileId: row.file_id, kind: "excalidraw", format: "excalidraw-native",
			formatVersion: 1, path: row.path, previousPath: row.previous_path, lifecycle: row.lifecycle,
			documentGeneration: row.generation,
			documentEpoch: parseSemanticEpoch(row.document_epoch, "Excalidraw catalog document epoch"),
			bodyEpoch: parseSemanticEpoch(row.document_epoch, "Excalidraw catalog document epoch"),
			contentHash: row.content_hash, size: row.size }));
	}

	semanticCandidateReceipt(documentId: string, clientId: string, candidateId: string): SemanticCandidateReceipt | null {
		this.initialize();
		const row = this.storage.sql.exec<{ document_id: string; client_id: string; candidate_id: string;
			candidate_digest: string; body_epoch: number; durable_generation: number; vault_sequence: number; runtime_epoch: string;
			content_hash: string; size: number }>(
			`SELECT document_id, client_id, candidate_id, candidate_digest, body_epoch, durable_generation,
			        vault_sequence, runtime_epoch, content_hash, size FROM vault_semantic_candidate_receipts
			 WHERE document_id = ? AND client_id = ? AND candidate_id = ?`, documentId, clientId, candidateId).toArray()[0];
		return row ? { documentId: row.document_id, clientId: row.client_id, candidateId: row.candidate_id,
			candidateDigest: row.candidate_digest, bodyEpoch: parseSemanticEpoch(row.body_epoch, "semantic candidate body epoch"),
			durableGeneration: row.durable_generation,
			vaultSequence: row.vault_sequence, vaultGeneration: this.currentVaultGeneration(), runtimeEpoch: row.runtime_epoch,
			contentHash: row.content_hash, size: row.size } : null;
	}

	recordSemanticCandidateReceipt(
		receipt: SemanticCandidateReceipt,
		actor: VaultActorContext,
		expectedDocumentHead: { generation: number; semanticEpoch: SemanticEpoch; latestSequence: number } | null,
		expectedSemanticHead: SemanticCatalogHead,
		now = Date.now(),
	): void {
		this.initialize();
		this.storage.transactionSync(() => {
			this.assertActorCurrent(actor);
			this.assertVaultGeneration(receipt.vaultGeneration);
			const currentDocumentHead = this.documentHead(receipt.documentId);
			if (expectedDocumentHead === null ? currentDocumentHead !== null
				: !currentDocumentHead || currentDocumentHead.generation !== expectedDocumentHead.generation
					|| currentDocumentHead.semanticEpoch !== expectedDocumentHead.semanticEpoch
					|| currentDocumentHead.latestSequence !== expectedDocumentHead.latestSequence) {
				throw new Error("document_head_changed");
			}
			this.assertSemanticHead(expectedSemanticHead.documentId, expectedSemanticHead);
			this.storage.sql.exec(`INSERT INTO vault_semantic_candidate_receipts(
			 document_id, client_id, candidate_id, candidate_digest, body_epoch, durable_generation, vault_sequence, runtime_epoch,
			 content_hash, size, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, receipt.documentId, receipt.clientId, receipt.candidateId,
			receipt.candidateDigest, receipt.bodyEpoch, receipt.durableGeneration, receipt.vaultSequence, receipt.runtimeEpoch,
			receipt.contentHash, receipt.size, now).toArray();
		});
	}

	protected assertSemanticHead(documentId: string, expected: SemanticCatalogHead | null): void {
		const current = this.semanticHeadAt(this.currentSequence(), documentId);
		if (expected === null) {
			if (current !== null) throw new Error("semantic_catalog_head_changed");
			return;
		}
		if (expected.documentId !== documentId || !current
			|| current.documentId !== expected.documentId
			|| current.sequence !== expected.sequence
			|| current.path !== expected.path
			|| current.lifecycle !== expected.lifecycle
			|| current.generation !== expected.generation
			|| current.bodyEpoch !== expected.bodyEpoch) {
			throw new Error("semantic_catalog_head_changed");
		}
	}

	semanticLifecycleReceipt(operationId: string): SemanticLifecycleReceipt | null {
		this.initialize();
		const row = this.storage.sql.exec<{ operation_id: string; request_digest: string; document_id: string;
			file_id: string; kind: SemanticLifecycleReceipt["kind"]; result_path: string;
			result_lifecycle: SemanticLifecycleReceipt["resultLifecycle"]; durable_generation: number;
			body_epoch: number; vault_sequence: number; root_generation: number; root_epoch: number; runtime_epoch: string }>(
			`SELECT operation_id, request_digest, document_id, file_id, kind, result_path, result_lifecycle,
			        durable_generation, body_epoch, vault_sequence, root_generation, root_epoch, runtime_epoch
			 FROM vault_semantic_lifecycle_receipts WHERE operation_id = ?`, operationId).toArray()[0];
		return row ? { operationId: row.operation_id, requestDigest: row.request_digest, documentId: row.document_id,
			fileId: row.file_id, kind: row.kind, resultPath: row.result_path, resultLifecycle: row.result_lifecycle,
			durableGeneration: row.durable_generation,
			bodyEpoch: parseSemanticEpoch(row.body_epoch, "semantic lifecycle body epoch"),
			vaultSequence: row.vault_sequence, rootGeneration: row.root_generation,
			rootEpoch: parseSemanticEpoch(row.root_epoch, "semantic lifecycle root epoch"),
			vaultGeneration: this.currentVaultGeneration(), runtimeEpoch: row.runtime_epoch } : null;
	}
	candidateReceipt(bodyId: string, clientId: string, candidateId: string): DurableCandidateReceipt | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			body_id: string; client_id: string; candidate_id: string; candidate_digest: string;
			body_epoch: number; durable_generation: number; vault_sequence: number; runtime_epoch: string; created_at: number;
		}>(
			`SELECT body_id, client_id, candidate_id, candidate_digest,
			        body_epoch, durable_generation, vault_sequence, runtime_epoch, created_at
			 FROM vault_candidate_receipts
			 WHERE body_id = ? AND client_id = ? AND candidate_id = ?`,
			bodyId,
			clientId,
			candidateId,
		).toArray()[0];
		if (row && row.created_at <= Date.now() - CANDIDATE_RECEIPT_TTL_MS) {
			this.storage.sql.exec(
				"DELETE FROM vault_candidate_receipts WHERE body_id = ? AND client_id = ? AND candidate_id = ?",
				bodyId,
				clientId,
				candidateId,
			).toArray();
			return null;
		}
		return row ? {
			bodyId: row.body_id,
			clientId: row.client_id,
			candidateId: row.candidate_id,
			candidateDigest: row.candidate_digest,
			bodyEpoch: parseSemanticEpoch(row.body_epoch, "candidate receipt body epoch"),
			durableGeneration: row.durable_generation,
			vaultSequence: row.vault_sequence,
			vaultGeneration: this.currentVaultGeneration(),
			runtimeEpoch: row.runtime_epoch,
		} : null;
	}

	hasCandidateReceipt(bodyId: string, candidateId: string, candidateDigest: string): boolean {
		this.initialize();
		return this.storage.sql.exec<{ found: number }>(
			`SELECT 1 AS found FROM vault_candidate_receipts
			 WHERE body_id = ? AND candidate_id = ? AND candidate_digest = ?
			   AND created_at > ? LIMIT 1`,
			bodyId,
			candidateId,
			candidateDigest,
			Date.now() - CANDIDATE_RECEIPT_TTL_MS,
		).toArray().length > 0;
	}

	creationCandidate(bodyId: string): PendingCreationCandidate | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			body_id: string; file_id: string; path: string; operation_id: string;
			candidate_id: string; candidate_digest: string; durable_generation: number;
			body_epoch: number; vault_sequence: number; runtime_epoch: string;
		}>(
			`SELECT body_id, file_id, path, operation_id, candidate_id, candidate_digest,
			        body_epoch, durable_generation, vault_sequence, runtime_epoch
			 FROM vault_creation_candidates WHERE body_id = ?`,
			bodyId,
		).toArray()[0];
		return row ? {
			bodyId: row.body_id,
			bodyEpoch: parseSemanticEpoch(row.body_epoch, "creation candidate body epoch"),
			fileId: row.file_id,
			path: row.path,
			operationId: row.operation_id,
			candidateId: row.candidate_id,
			candidateDigest: row.candidate_digest,
			durableGeneration: row.durable_generation,
			vaultSequence: row.vault_sequence,
			vaultGeneration: this.currentVaultGeneration(),
			runtimeEpoch: row.runtime_epoch,
		} : null;
	}

	expectCreationCandidate(input: PendingCreationCandidate): PendingCreationCandidate {
		this.initialize();
		this.assertVaultGeneration(input.vaultGeneration);
		const existing = this.creationCandidate(input.bodyId);
		if (existing) {
			if (existing.operationId !== input.operationId || existing.fileId !== input.fileId
				|| existing.path !== input.path || existing.candidateId !== input.candidateId
				|| existing.candidateDigest !== input.candidateDigest
				|| existing.bodyEpoch !== input.bodyEpoch
				|| existing.durableGeneration !== input.durableGeneration
				|| existing.vaultSequence !== input.vaultSequence
				|| existing.vaultGeneration !== input.vaultGeneration
				|| existing.runtimeEpoch !== input.runtimeEpoch) {
				throw new Error("creation candidate fence mismatch");
			}
			return existing;
		}
		this.storage.sql.exec(
			`INSERT INTO vault_creation_candidates(
			 body_id, file_id, path, operation_id, candidate_id, candidate_digest,
			 body_epoch, durable_generation, vault_sequence, runtime_epoch
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			input.bodyId,
			input.fileId,
			input.path,
			input.operationId,
			input.candidateId,
			input.candidateDigest,
			parseSemanticEpoch(input.bodyEpoch, "creation candidate body epoch"),
			input.durableGeneration,
			input.vaultSequence,
			input.runtimeEpoch,
		).toArray();
		return input;
	}

	completeCreationCandidate(bodyId: string, candidateId: string, candidateDigest: string): boolean {
		this.initialize();
		const existing = this.creationCandidate(bodyId);
		if (!existing) return false;
		if (existing.candidateId !== candidateId || existing.candidateDigest !== candidateDigest) {
			throw new Error("candidate does not match creation fence");
		}
		const deleted = this.storage.sql.exec(
			"DELETE FROM vault_creation_candidates WHERE body_id = ?",
			bodyId,
		);
		deleted.toArray();
		return deleted.rowsWritten > 0;
	}

	pendingCreationCount(): number {
		this.initialize();
		return this.storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM vault_creation_candidates",
		).one().count;
	}

	candidateReceiptCount(bodyId?: string): number {
		this.initialize();
		return bodyId
			? this.storage.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM vault_candidate_receipts WHERE body_id = ?",
				bodyId,
			).one().count
			: this.storage.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM vault_candidate_receipts",
			).one().count;
	}

	pruneCandidateReceipts(now = Date.now()): number {
		this.initialize();
		let rowsWritten = 0;
		for (const cursor of [
			this.storage.sql.exec(
				"DELETE FROM vault_operation_outcomes WHERE expires_at <= ?",
				now,
			),
			this.storage.sql.exec(
				`DELETE FROM vault_operation_outcomes WHERE rowid IN (
				   SELECT rowid FROM vault_operation_outcomes
				   ORDER BY committed_at DESC, rowid DESC LIMIT -1 OFFSET ?
				 )`,
				MAX_CANDIDATE_RECEIPTS_GLOBAL - 1,
			),
			this.storage.sql.exec(
				"DELETE FROM vault_candidate_receipts WHERE created_at <= ?",
				now - CANDIDATE_RECEIPT_TTL_MS,
			),
			this.storage.sql.exec(
				`DELETE FROM vault_candidate_receipts WHERE rowid IN (
				   SELECT rowid FROM vault_candidate_receipts
				   ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
				 )`,
				MAX_CANDIDATE_RECEIPTS_GLOBAL - 1,
			),
		]) {
			cursor.toArray();
			rowsWritten += cursor.rowsWritten;
		}
		return rowsWritten;
	}

	lifecycleRecord(operationId: string): DurableLifecycleRecord | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			operation_id: string;
			kind: DurableLifecycleRecord["kind"];
			body_id: string;
			body_epoch: number;
			file_id: string;
			durable_generation: number;
			vault_sequence: number;
			runtime_epoch: string;
			candidate_id: string | null;
			candidate_digest: string | null;
			source_path: string | null;
			result_path: string;
			result_lifecycle: "active" | "tombstoned";
			root_generation: number;
		}>(
			`SELECT operation_id, kind, body_id, body_epoch, file_id, durable_generation,
			        vault_sequence, runtime_epoch, candidate_id, candidate_digest,
			        source_path, result_path, result_lifecycle, root_generation
			 FROM vault_lifecycle_receipts WHERE operation_id = ?`,
			operationId,
		).toArray()[0];
		return row ? {
			operationId: row.operation_id,
			kind: row.kind,
			bodyId: row.body_id,
			bodyEpoch: parseSemanticEpoch(row.body_epoch, "lifecycle receipt body epoch"),
			fileId: row.file_id,
			durableGeneration: row.durable_generation,
			vaultSequence: row.vault_sequence,
			vaultGeneration: this.currentVaultGeneration(),
			runtimeEpoch: row.runtime_epoch,
			candidateId: row.candidate_id,
			candidateDigest: row.candidate_digest,
			sourcePath: row.source_path,
			resultPath: row.result_path,
			resultLifecycle: row.result_lifecycle,
			rootGeneration: row.root_generation,
		} : null;
	}

	lifecyclePublication(operationId: string): DurableRootPublication | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			operation_id: string;
			lifecycle_sequence: number;
			root_sequence: number;
			root_generation: number;
			root_epoch: number;
			runtime_epoch: string;
		}>(
			`SELECT operation_id, lifecycle_sequence, root_sequence, root_generation, root_epoch, runtime_epoch
			 FROM vault_lifecycle_publications WHERE operation_id = ?`,
			operationId,
		).toArray()[0];
		return row ? {
			operationId: row.operation_id,
			lifecycleSequence: row.lifecycle_sequence,
			rootSequence: row.root_sequence,
			rootGeneration: row.root_generation,
			rootEpoch: parseSemanticEpoch(row.root_epoch, "root publication epoch"),
			vaultGeneration: this.currentVaultGeneration(),
			runtimeEpoch: row.runtime_epoch,
		} : null;
	}

	recordLifecycle(input: {
		operationId: string;
		kind: DurableLifecycleRecord["kind"];
		bodyId: string;
		bodyEpoch: SemanticEpoch;
		fileId: string;
		sourcePath: string | null;
		resultPath: string;
		resultLifecycle: "active" | "tombstoned";
		commit: DurableCommitResult;
		candidateId?: string | null;
		candidateDigest?: string | null;
		durableGeneration?: number;
		rootGeneration?: number;
		vaultGeneration: string;
		runtimeEpoch: string;
		now?: number;
	}): DurableLifecycleRecord {
		this.initialize();
		this.assertVaultGeneration(input.vaultGeneration);
		const existing = this.lifecycleRecord(input.operationId);
		if (existing) {
			if (existing.kind !== input.kind || existing.bodyId !== input.bodyId || existing.fileId !== input.fileId
				|| existing.bodyEpoch !== input.bodyEpoch
				|| existing.candidateId !== (input.candidateId ?? null)
				|| existing.candidateDigest !== (input.candidateDigest ?? null)
				|| existing.sourcePath !== input.sourcePath || existing.resultPath !== input.resultPath
				|| existing.resultLifecycle !== input.resultLifecycle) {
				throw new Error("operation ID reused with different lifecycle data");
			}
			return existing;
		}
		const record: DurableLifecycleRecord = {
			operationId: input.operationId,
			kind: input.kind,
			bodyId: input.bodyId,
			bodyEpoch: parseSemanticEpoch(input.bodyEpoch, "lifecycle body epoch"),
			fileId: input.fileId,
			candidateId: input.candidateId ?? null,
			candidateDigest: input.candidateDigest ?? null,
			sourcePath: input.sourcePath,
			resultPath: input.resultPath,
			resultLifecycle: input.resultLifecycle,
			durableGeneration: input.durableGeneration ?? input.commit.generation,
			rootGeneration: input.rootGeneration ?? input.commit.generation,
			vaultSequence: input.commit.vaultSequence,
			vaultGeneration: input.vaultGeneration,
			runtimeEpoch: input.runtimeEpoch,
		};
		this.storage.sql.exec(
			`INSERT INTO vault_lifecycle_receipts(
			 operation_id, kind, body_id, body_epoch, file_id, durable_generation,
			 vault_sequence, runtime_epoch, candidate_id, candidate_digest,
			 source_path, result_path, result_lifecycle, root_generation, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			record.operationId,
			record.kind,
			record.bodyId,
			record.bodyEpoch,
			record.fileId,
			record.durableGeneration,
			record.vaultSequence,
			record.runtimeEpoch,
			record.candidateId,
			record.candidateDigest,
			record.sourcePath,
			record.resultPath,
			record.resultLifecycle,
			record.rootGeneration,
			input.now ?? Date.now(),
		).toArray();
		return record;
	}

	listCatalogAt(boundarySequence: number, afterBodyId = "", limit = 1000): CatalogHeadAtBoundary[] {
		this.initialize();
		const boundedLimit = Math.min(1000, Math.max(1, limit));
		return this.storage.sql.exec<{
			sequence: number; body_id: string; file_id: string; path: string; previous_path: string | null;
			lifecycle: BodyLifecycle; generation: number; body_epoch: number; content_hash: string | null; size: number | null;
		}>(
			`SELECT e.sequence, e.body_id, e.file_id, e.path, e.previous_path, e.lifecycle,
			        e.generation, e.body_epoch, e.content_hash, e.size
			 FROM vault_catalog_events e
			 JOIN (
			   SELECT body_id, MAX(sequence) AS sequence
			   FROM vault_catalog_events
			   WHERE sequence <= ? GROUP BY body_id
			 ) latest ON latest.body_id = e.body_id AND latest.sequence = e.sequence
			 WHERE e.body_id > ?
			 ORDER BY e.body_id LIMIT ?`,
			boundarySequence,
			afterBodyId,
			boundedLimit,
		).toArray().map((row) => ({
			sequence: row.sequence,
			bodyId: row.body_id,
			bodyEpoch: parseSemanticEpoch(row.body_epoch, "catalog body epoch"),
			fileId: row.file_id,
			path: row.path,
			previousPath: row.previous_path,
			lifecycle: row.lifecycle,
			generation: row.generation,
			contentHash: row.content_hash,
			size: row.size,
		}));
	}

	getCatalogHeadAt(boundarySequence: number, bodyId: string): CatalogHeadAtBoundary | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			sequence: number; body_id: string; file_id: string; path: string; previous_path: string | null;
			lifecycle: BodyLifecycle; generation: number; body_epoch: number; content_hash: string | null; size: number | null;
		}>(
			`SELECT catalog.sequence, catalog.body_id, catalog.file_id, catalog.path, catalog.previous_path,
			        catalog.lifecycle, catalog.generation, catalog.body_epoch,
			        catalog.content_hash, catalog.size
			 FROM vault_catalog_events catalog
			 WHERE catalog.body_id = ? AND catalog.sequence <= ?
			 ORDER BY catalog.sequence DESC LIMIT 1`,
			bodyId,
			boundarySequence,
		).toArray()[0];
		return row ? {
			sequence: row.sequence,
			bodyId: row.body_id,
			bodyEpoch: parseSemanticEpoch(row.body_epoch, "catalog body epoch"),
			fileId: row.file_id,
			path: row.path,
			previousPath: row.previous_path,
			lifecycle: row.lifecycle,
			generation: row.generation,
			contentHash: row.content_hash,
			size: row.size,
		} : null;
	}

	activeCatalogHeadAtPath(boundarySequence: number, path: string): CatalogHeadAtBoundary | null {
		this.initialize();
		const owner = this.activeBodiesAtPath(boundarySequence, path)[0];
		return owner ? this.getCatalogHeadAt(boundarySequence, owner) : null;
	}

	listActiveCatalogAt(boundarySequence: number, afterBodyId = "", limit = 1000): CatalogHeadAtBoundary[] {
		const result: CatalogHeadAtBoundary[] = [];
		let cursor = afterBodyId;
		const boundedLimit = Math.min(1000, Math.max(1, limit));
		while (result.length < boundedLimit) {
			const page = this.listCatalogAt(boundarySequence, cursor, 1000);
			for (const entry of page) {
				if (entry.lifecycle === "active") {
					result.push(entry);
					if (result.length === boundedLimit) return result;
				}
			}
			if (page.length < 1000) break;
			cursor = page.at(-1)!.bodyId;
		}
		return result;
	}

	countActiveCatalogAt(boundarySequence: number): number {
		this.initialize();
		return this.storage.sql.exec<{ count: number }>(
			`SELECT COUNT(*) AS count FROM vault_catalog_events e
			 JOIN (
			   SELECT body_id, MAX(sequence) AS sequence
			   FROM vault_catalog_events
			   WHERE sequence <= ? GROUP BY body_id
			 ) latest ON latest.body_id = e.body_id AND latest.sequence = e.sequence
			 WHERE e.lifecycle = 'active'`,
			boundarySequence,
		).one().count;
	}

	attachmentCatalogAt(boundarySequence: number, afterPath = "", limit = 1000): AttachmentCatalogEvent[] {
		this.initialize();
		const bounded = Math.min(1000, Math.max(1, limit));
		return this.storage.sql.exec<{
			sequence: number; path: string; content_hash: string | null; size: number | null;
			mime: string | null; lifecycle: AttachmentCatalogEvent["lifecycle"]; operation_id: string;
		}>(
			`SELECT e.sequence, e.path, e.content_hash, e.size, e.mime, e.lifecycle, e.operation_id
			 FROM vault_attachment_catalog_events e
			 JOIN (
			   SELECT path, MAX(sequence) AS sequence
			   FROM vault_attachment_catalog_events WHERE sequence <= ? GROUP BY path
			 ) latest ON latest.path = e.path AND latest.sequence = e.sequence
			 WHERE e.path > ? ORDER BY e.path LIMIT ?`,
			boundarySequence,
			afterPath,
			bounded,
		).toArray().map((row) => ({
			sequence: row.sequence,
			path: row.path,
			contentHash: row.content_hash,
			size: row.size,
			mime: row.mime,
			lifecycle: row.lifecycle,
			operationId: row.operation_id,
		}));
	}

	activeAttachmentCatalogAt(boundarySequence: number, afterPath = "", limit = 1000): AttachmentCatalogEvent[] {
		this.initialize();
		return this.storage.sql.exec<{
			sequence: number; path: string; content_hash: string | null; size: number | null; mime: string | null; operation_id: string;
		}>(
			`SELECT e.sequence, e.path, e.content_hash, e.size, e.mime, e.operation_id
			 FROM vault_attachment_catalog_events e
			 JOIN (
			   SELECT path, MAX(sequence) AS sequence
			   FROM vault_attachment_catalog_events WHERE sequence <= ? GROUP BY path
			 ) latest ON latest.path = e.path AND latest.sequence = e.sequence
			 WHERE e.lifecycle = 'active' AND e.path > ? ORDER BY e.path LIMIT ?`,
			boundarySequence,
			afterPath,
			Math.min(1001, Math.max(1, limit)),
		).toArray().map((row) => ({
			sequence: row.sequence,
			path: row.path,
			contentHash: row.content_hash,
			size: row.size,
			mime: row.mime,
			lifecycle: "active",
			operationId: row.operation_id,
		}));
	}

	attachmentEventsForOperation(operationId: string): AttachmentCatalogEvent[] {
		this.initialize();
		return this.storage.sql.exec<{
			sequence: number; path: string; content_hash: string | null; size: number | null;
			mime: string | null; lifecycle: AttachmentCatalogEvent["lifecycle"]; operation_id: string;
		}>(
			`SELECT sequence, path, content_hash, size, mime, lifecycle, operation_id
			 FROM vault_attachment_catalog_events WHERE operation_id = ? ORDER BY path`,
			operationId,
		).toArray().map((row) => ({
			sequence: row.sequence,
			path: row.path,
			contentHash: row.content_hash,
			size: row.size,
			mime: row.mime,
			lifecycle: row.lifecycle,
			operationId: row.operation_id,
		}));
	}

	attachmentHead(path: string): AttachmentCatalogEvent | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			sequence: number; path: string; content_hash: string | null; size: number | null;
			mime: string | null; lifecycle: AttachmentCatalogEvent["lifecycle"]; operation_id: string;
		}>(
			`SELECT sequence, path, content_hash, size, mime, lifecycle, operation_id
			 FROM vault_attachment_catalog_events WHERE path = ? ORDER BY sequence DESC LIMIT 1`,
			path,
		).toArray()[0];
		return row ? {
			sequence: row.sequence,
			path: row.path,
			contentHash: row.content_hash,
			size: row.size,
			mime: row.mime,
			lifecycle: row.lifecycle,
			operationId: row.operation_id,
		} : null;
	}

	attachmentOperation(operationId: string): DurableAttachmentOperation | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			operation_id: string; request_digest: string; root_sequence: number; root_generation: number; root_epoch: number;
		}>(
			`SELECT operation_id, request_digest, root_sequence, root_generation, root_epoch
			 FROM vault_attachment_operations WHERE operation_id = ?`,
			operationId,
		).toArray()[0];
		return row ? {
			operationId: row.operation_id,
			requestDigest: row.request_digest,
			rootSequence: row.root_sequence,
			rootGeneration: row.root_generation,
			rootEpoch: parseSemanticEpoch(row.root_epoch, "attachment operation root epoch"),
		} : null;
	}

	catalogDeltaAt(afterSequence: number, throughSequence: number, cursor: string | null, limit: number): Array<{
		sequence: number; order: number; kind: "create" | "rename" | "delete" | "revive" | "body-hash" | "attachment-upsert" | "attachment-delete";
		identity: string; path: string; previousPath: string | null; contentHash: string | null; size: number | null; mime: string | null;
	}> {
		this.initialize();
		const parsed = cursor?.split(":") ?? [];
		const cursorSequence = parsed.length === 2 ? Number(parsed[0]) : afterSequence;
		const cursorOrder = parsed.length === 2 ? Number(parsed[1]) : -1;
		if (!Number.isSafeInteger(cursorSequence) || !Number.isSafeInteger(cursorOrder)) throw new Error("invalid delta cursor");
		const bounded = Math.min(1001, Math.max(1, limit));
		const markdown = this.storage.sql.exec<{
			sequence: number; mutation_index: number; body_id: string; path: string; previous_path: string | null;
			lifecycle: BodyLifecycle; content_hash: string | null; size: number | null;
		}>(
			`SELECT sequence, mutation_index, body_id, path, previous_path, lifecycle, content_hash, size
			 FROM vault_catalog_events
			 WHERE sequence > ? AND sequence <= ?
			   AND (sequence > ? OR (sequence = ? AND mutation_index > ?))
			 ORDER BY sequence, mutation_index LIMIT ?`,
			afterSequence,
			throughSequence,
			cursorSequence,
			cursorSequence,
			cursorOrder,
			bounded,
		).toArray().map((row): CatalogDeltaEntry => ({
			sequence: row.sequence,
			order: row.mutation_index,
			kind: row.previous_path !== null && row.lifecycle === "active" ? "rename"
				: row.lifecycle === "tombstoned" || row.lifecycle === "reaped" ? "delete"
					: row.content_hash !== null ? "body-hash" : "create",
			identity: row.body_id,
			path: row.path,
			previousPath: row.previous_path,
			contentHash: row.content_hash,
			size: row.size,
			mime: null,
		}));
		const attachments = this.storage.sql.exec<{
			sequence: number; event_order: number; path: string; content_hash: string | null;
			size: number | null; mime: string | null; lifecycle: string;
		}>(
			`SELECT sequence, event_order, path, content_hash, size, mime, lifecycle FROM (
			   SELECT sequence, path, content_hash, size, mime, lifecycle,
			          1000000 + ROW_NUMBER() OVER (PARTITION BY sequence ORDER BY path) AS event_order
			   FROM vault_attachment_catalog_events
			   WHERE sequence > ? AND sequence <= ?
			 )
			 WHERE sequence > ? OR (sequence = ? AND event_order > ?)
			 ORDER BY sequence, event_order LIMIT ?`,
			afterSequence,
			throughSequence,
			cursorSequence,
			cursorSequence,
			cursorOrder,
			bounded,
		).toArray().map((row): CatalogDeltaEntry => ({
			sequence: row.sequence,
			order: row.event_order,
			kind: row.lifecycle === "active" ? "attachment-upsert" : "attachment-delete",
			identity: row.path,
			path: row.path,
			previousPath: null,
			contentHash: row.content_hash,
			size: row.size,
			mime: row.mime,
		}));
		return [...markdown, ...attachments]
			.sort((left, right) => left.sequence - right.sequence || left.order - right.order || left.identity.localeCompare(right.identity))
			.slice(0, bounded);
	}

	protected assertCatalogPathUniqueness(mutations: CatalogMutation[], boundarySequence: number): void {
		if (mutations.length === 0) return;
		const byBody = new Map(mutations.map((mutation) => [mutation.bodyId, mutation]));
		const finalOwnerByPath = new Map<string, string>();
		for (const mutation of mutations) {
			if (mutation.lifecycle !== "active") continue;
			const duplicate = finalOwnerByPath.get(mutation.path);
			if (duplicate && duplicate !== mutation.bodyId) throw new Error("active_path_conflict");
			finalOwnerByPath.set(mutation.path, mutation.bodyId);
		}
		for (const [path, bodyId] of finalOwnerByPath) {
			for (const existingOwner of this.activeBodiesAtPath(boundarySequence, path)) {
				if (existingOwner === bodyId) continue;
				const displaced = byBody.get(existingOwner);
				if (!displaced || (displaced.lifecycle === "active" && displaced.path === path)) {
					throw new Error("active_path_conflict");
				}
			}
		}
	}

	protected activeBodiesAtPath(boundarySequence: number, path: string): string[] {
		return this.storage.sql.exec<{ body_id: string }>(
			`SELECT e.body_id FROM vault_catalog_events e
			 JOIN (
			   SELECT body_id, MAX(sequence) AS sequence
			   FROM vault_catalog_events
			   WHERE sequence <= ? GROUP BY body_id
			 ) latest ON latest.body_id = e.body_id AND latest.sequence = e.sequence
			 WHERE e.path = ? AND e.lifecycle = 'active'`,
			boundarySequence,
			path,
		).toArray().map((row) => row.body_id);
	}
}
