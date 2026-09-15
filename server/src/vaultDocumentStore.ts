import * as Y from "yjs";
import { SCHEMA_VERSION, STORAGE_FORMAT_VERSION } from "./shared/productVersions";
import type { BodyLifecycle, CatalogHeadAtBoundary, SemanticCatalogHead } from "./vaultCatalogStore";
import type { HistoryPin } from "./vaultBootstrapStore";
import type { VaultActorContext, VaultRole } from "./collaboration";
import { MAX_DURABLE_UPDATE_BYTES, SQLITE_ROW_SAFE_BYTES } from "./shared/durableLimits";
import {
	INITIAL_SEMANTIC_EPOCH,
	nextSemanticEpoch,
	parseSemanticEpoch,
	type SemanticEpoch,
} from "./shared/semanticEpoch";

/**
 * Durable Object SQLite rows are limited to 2 MB. Durable updates are capped
 * below this value and therefore fit in one binary row. Checkpoints may be
 * larger and are split into independently bounded binary rows.
 */
export const SQLITE_BLOB_CHUNK_BYTES = SQLITE_ROW_SAFE_BYTES;
/** Hard ceiling for checkpoint bytes retained solely by active history pins. */
export const MAX_PIN_RETAINED_CHECKPOINT_BYTES = 128 * 1024 * 1024;
export type DurableChunkValue = ArrayBuffer;

const SHA256_INITIAL = new Uint32Array([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
	0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_ROUND = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits));
}

/** Synchronous, allocation-bounded SHA-256 for storage transactions. */
function sha256HexSync(bytes: Uint8Array): string {
	const state = SHA256_INITIAL.slice();
	const words = new Uint32Array(64);
	const processBlock = (block: Uint8Array): void => {
		for (let index = 0; index < 16; index++) {
			const offset = index * 4;
			words[index] = ((block[offset]! << 24) | (block[offset + 1]! << 16)
				| (block[offset + 2]! << 8) | block[offset + 3]!) >>> 0;
		}
		for (let index = 16; index < 64; index++) {
			const a = words[index - 15]!;
			const b = words[index - 2]!;
			const sigma0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
			const sigma1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
			words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = state;
		for (let index = 0; index < 64; index++) {
			const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
			const choice = (e! & f!) ^ (~e! & g!);
			const temp1 = (h! + sum1 + choice + SHA256_ROUND[index]! + words[index]!) >>> 0;
			const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
			const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
			const temp2 = (sum0 + majority) >>> 0;
			h = g; g = f; f = e; e = (d! + temp1) >>> 0;
			d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
		}
		state[0] = (state[0]! + a!) >>> 0; state[1] = (state[1]! + b!) >>> 0;
		state[2] = (state[2]! + c!) >>> 0; state[3] = (state[3]! + d!) >>> 0;
		state[4] = (state[4]! + e!) >>> 0; state[5] = (state[5]! + f!) >>> 0;
		state[6] = (state[6]! + g!) >>> 0; state[7] = (state[7]! + h!) >>> 0;
	};
	let offset = 0;
	while (offset + 64 <= bytes.byteLength) {
		processBlock(bytes.subarray(offset, offset + 64));
		offset += 64;
	}
	const remainder = bytes.byteLength - offset;
	const tail = new Uint8Array(remainder < 56 ? 64 : 128);
	tail.set(bytes.subarray(offset));
	tail[remainder] = 0x80;
	const bitHigh = Math.floor(bytes.byteLength / 0x20000000);
	const bitLow = (bytes.byteLength << 3) >>> 0;
	const lengthOffset = tail.byteLength - 8;
	tail[lengthOffset] = bitHigh >>> 24; tail[lengthOffset + 1] = bitHigh >>> 16;
	tail[lengthOffset + 2] = bitHigh >>> 8; tail[lengthOffset + 3] = bitHigh;
	tail[lengthOffset + 4] = bitLow >>> 24; tail[lengthOffset + 5] = bitLow >>> 16;
	tail[lengthOffset + 6] = bitLow >>> 8; tail[lengthOffset + 7] = bitLow;
	for (let tailOffset = 0; tailOffset < tail.byteLength; tailOffset += 64) {
		processBlock(tail.subarray(tailOffset, tailOffset + 64));
	}
	return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

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
	| "lifecycle-batch" | "blob" | "restore" | "semantic-reset";

export interface DurableCommitResult {
	vaultSequence: number;
	documentId: string;
	generation: number;
	semanticEpoch: SemanticEpoch;
	kind: VaultCommitKind;
	rowsRead: number;
	rowsWritten: number;
}

export interface ReconstructedDocument {
	documentId: string;
	throughSequence: number;
	generation: number;
	semanticEpoch: SemanticEpoch;
	checkpointSequence: number;
	journalUpdates: number;
	doc: Y.Doc;
	rowsRead: number;
}

export interface CheckpointExpectedHead {
	throughSequence: number;
	generation: number;
	semanticEpoch: SemanticEpoch;
}

export interface CheckpointWriteResult {
	status: "written";
	checkpointSequence: number;
	generation: number;
	semanticEpoch: SemanticEpoch;
	chunks: number;
	totalBytes: number;
	stateSha256: string;
	rowsWritten: number;
}

export interface SemanticResetResult extends CheckpointWriteResult {
	vaultSequence: number;
	previousSemanticEpoch: SemanticEpoch;
}

export interface DurableSemanticCompactionState {
	documentId: string;
	lastCompactedAt: number | null;
	postCompactionEncodedStateBytes: number | null;
}

export interface JournalFeedEntry {
	sequence: number;
	documentId: string;
	generation: number;
	documentEpoch: SemanticEpoch;
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

interface CheckpointStorageRow extends Record<string, SqlStorageValue> {
	checkpoint_sequence: number;
	manifest_generation: number | null;
	manifest_semantic_epoch: number | null;
	chunk_count: number | null;
	total_byte_length: number | null;
	state_sha256: string | null;
	complete: number | null;
	chunk_generation: number | null;
	chunk_semantic_epoch: number | null;
	chunk_index: number | null;
	chunk_byte_length: number | null;
	chunk_sha256: string | null;
	data: DurableChunkValue | null;
}

function checkpointIntegrityError(reason: string): Error {
	return new Error(`checkpoint integrity failure: ${reason}`);
}

function decodeVerifiedCheckpoint(rows: CheckpointStorageRow[]): {
	checkpointSequence: number;
	generation: number;
	semanticEpoch: SemanticEpoch;
	bytes: Uint8Array;
} | null {
	if (rows.length === 0) return null;
	const first = rows[0]!;
	if (first.manifest_generation === null || first.manifest_semantic_epoch === null || first.chunk_count === null
		|| first.total_byte_length === null || first.state_sha256 === null || first.complete !== 1) {
		throw checkpointIntegrityError("missing or incomplete manifest");
	}
	if (!Number.isSafeInteger(first.checkpoint_sequence) || first.checkpoint_sequence < 0
		|| !Number.isSafeInteger(first.manifest_generation) || first.manifest_generation < 0
		|| !Number.isSafeInteger(first.manifest_semantic_epoch) || first.manifest_semantic_epoch < INITIAL_SEMANTIC_EPOCH
		|| !Number.isSafeInteger(first.chunk_count) || first.chunk_count < 1
		|| !Number.isSafeInteger(first.total_byte_length) || first.total_byte_length < 1
		|| !/^[a-f0-9]{64}$/.test(first.state_sha256)) {
		throw checkpointIntegrityError("invalid manifest metadata");
	}
	if (rows.length !== first.chunk_count) throw checkpointIntegrityError("chunk count mismatch");
	const chunks: Array<{ data: DurableChunkValue }> = [];
	let total = 0;
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index]!;
		if (row.checkpoint_sequence !== first.checkpoint_sequence
			|| row.manifest_generation !== first.manifest_generation
			|| row.manifest_semantic_epoch !== first.manifest_semantic_epoch
			|| row.chunk_count !== first.chunk_count
			|| row.total_byte_length !== first.total_byte_length
			|| row.state_sha256 !== first.state_sha256 || row.complete !== 1) {
			throw checkpointIntegrityError("inconsistent manifest metadata");
		}
		if (row.chunk_index !== index) throw checkpointIntegrityError("chunk indices are not contiguous");
		if (row.chunk_generation !== first.manifest_generation) throw checkpointIntegrityError("chunk generation mismatch");
		if (row.chunk_semantic_epoch !== first.manifest_semantic_epoch) throw checkpointIntegrityError("chunk semantic epoch mismatch");
		if (row.data === null || row.chunk_byte_length === null || row.chunk_sha256 === null) {
			throw checkpointIntegrityError("checkpoint chunk is missing");
		}
		const chunk = new Uint8Array(row.data);
		if (chunk.byteLength < 1 || chunk.byteLength > SQLITE_BLOB_CHUNK_BYTES
			|| chunk.byteLength !== row.chunk_byte_length) {
			throw checkpointIntegrityError("chunk length mismatch");
		}
		if (!/^[a-f0-9]{64}$/.test(row.chunk_sha256) || sha256HexSync(chunk) !== row.chunk_sha256) {
			throw checkpointIntegrityError("chunk digest mismatch");
		}
		total += chunk.byteLength;
		chunks.push({ data: row.data });
	}
	if (total !== first.total_byte_length) throw checkpointIntegrityError("total byte length mismatch");
	const bytes = decodeSqlChunks(chunks);
	if (sha256HexSync(bytes) !== first.state_sha256) throw checkpointIntegrityError("state digest mismatch");
	return {
		checkpointSequence: first.checkpoint_sequence,
		generation: first.manifest_generation,
		semanticEpoch: parseSemanticEpoch(first.manifest_semantic_epoch),
		bytes,
	};
}

interface CheckpointSummaryRow extends Record<string, SqlStorageValue> {
	checkpoint_sequence: number;
	generation: number | null;
	semantic_epoch: number | null;
	chunk_count: number | null;
	total_byte_length: number | null;
	state_sha256: string | null;
	complete: number | null;
	physical_chunks: number;
	physical_bytes: number;
	first_index: number;
	last_index: number;
	minimum_chunk_epoch: number;
	maximum_chunk_epoch: number;
}

function assertCheckpointSummary(row: CheckpointSummaryRow): void {
	if (row.generation === null || row.semantic_epoch === null || row.chunk_count === null || row.total_byte_length === null
		|| row.state_sha256 === null || row.complete !== 1) {
		throw checkpointIntegrityError("missing or incomplete manifest");
	}
	if (!Number.isSafeInteger(row.chunk_count) || row.chunk_count < 1
		|| !Number.isSafeInteger(row.semantic_epoch) || row.semantic_epoch < INITIAL_SEMANTIC_EPOCH
		|| !Number.isSafeInteger(row.total_byte_length) || row.total_byte_length < 1
		|| !/^[a-f0-9]{64}$/.test(row.state_sha256)
		|| row.physical_chunks !== row.chunk_count || row.physical_bytes !== row.total_byte_length
		|| row.first_index !== 0 || row.last_index !== row.chunk_count - 1
		|| row.minimum_chunk_epoch !== row.semantic_epoch || row.maximum_chunk_epoch !== row.semantic_epoch) {
		throw checkpointIntegrityError("manifest does not match physical chunks");
	}
}

/** Document metadata, journal, reconstruction, checkpoint, and feed storage. */
export abstract class VaultDocumentStore {
	private initialized = false;

	constructor(protected readonly storage: VaultStoragePort) {}

	abstract activePins(now?: number): HistoryPin[];

	/** Override only in bounded storage tests; production always uses the exported hard ceiling. */
	protected historyPinRetainedCheckpointByteLimit(): number {
		return MAX_PIN_RETAINED_CHECKPOINT_BYTES;
	}

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
				semantic_epoch INTEGER NOT NULL CHECK(semantic_epoch >= 1),
				latest_sequence INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_semantic_compaction_state (
				document_id TEXT PRIMARY KEY,
				last_compacted_at INTEGER CHECK(last_compacted_at IS NULL OR last_compacted_at >= 0),
				post_compaction_encoded_state_bytes INTEGER
					CHECK(post_compaction_encoded_state_bytes IS NULL OR post_compaction_encoded_state_bytes >= 0)
			);
			CREATE TABLE IF NOT EXISTS vault_journal (
				sequence INTEGER PRIMARY KEY,
				document_id TEXT NOT NULL,
				generation INTEGER NOT NULL,
				semantic_epoch INTEGER NOT NULL CHECK(semantic_epoch >= 1),
				kind TEXT NOT NULL,
				update_byte_length INTEGER NOT NULL
					CHECK(update_byte_length >= 0 AND update_byte_length <= ${MAX_DURABLE_UPDATE_BYTES}),
				data BLOB NOT NULL
					CHECK(typeof(data) = 'blob' AND length(data) = update_byte_length
						AND length(data) <= ${MAX_DURABLE_UPDATE_BYTES}),
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS vault_journal_document_sequence
				ON vault_journal(document_id, sequence);
			CREATE TABLE IF NOT EXISTS vault_checkpoints (
				document_id TEXT NOT NULL,
				checkpoint_sequence INTEGER NOT NULL,
				generation INTEGER NOT NULL,
				semantic_epoch INTEGER NOT NULL CHECK(semantic_epoch >= 1),
				chunk_index INTEGER NOT NULL,
				chunk_byte_length INTEGER NOT NULL CHECK(chunk_byte_length > 0 AND chunk_byte_length <= ${SQLITE_BLOB_CHUNK_BYTES}),
				chunk_sha256 TEXT NOT NULL CHECK(length(chunk_sha256) = 64),
				data BLOB NOT NULL
					CHECK(typeof(data) = 'blob' AND length(data) = chunk_byte_length
						AND length(data) <= ${SQLITE_BLOB_CHUNK_BYTES}),
				PRIMARY KEY(document_id, checkpoint_sequence, chunk_index)
			);
			CREATE INDEX IF NOT EXISTS vault_checkpoint_lookup
				ON vault_checkpoints(document_id, checkpoint_sequence DESC);
			CREATE TABLE IF NOT EXISTS vault_checkpoint_manifests (
				document_id TEXT NOT NULL,
				checkpoint_sequence INTEGER NOT NULL,
				generation INTEGER NOT NULL,
				semantic_epoch INTEGER NOT NULL CHECK(semantic_epoch >= 1),
				chunk_count INTEGER NOT NULL CHECK(chunk_count > 0),
				total_byte_length INTEGER NOT NULL CHECK(total_byte_length > 0),
				state_sha256 TEXT NOT NULL CHECK(length(state_sha256) = 64),
				complete INTEGER NOT NULL CHECK(complete = 1),
				created_at INTEGER NOT NULL,
				PRIMARY KEY(document_id, checkpoint_sequence)
			);
			CREATE INDEX IF NOT EXISTS vault_checkpoint_manifest_lookup
				ON vault_checkpoint_manifests(document_id, checkpoint_sequence DESC);
			CREATE TABLE IF NOT EXISTS vault_catalog_events (
				sequence INTEGER NOT NULL,
				body_id TEXT NOT NULL,
				file_id TEXT NOT NULL,
				path TEXT NOT NULL,
				previous_path TEXT,
				lifecycle TEXT NOT NULL,
				generation INTEGER NOT NULL,
				body_epoch INTEGER NOT NULL CHECK(body_epoch >= 1),
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
				schema_version INTEGER NOT NULL CHECK(schema_version = ${SCHEMA_VERSION}),
				storage_format_version INTEGER NOT NULL CHECK(storage_format_version = ${STORAGE_FORMAT_VERSION}),
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
				body_epoch INTEGER NOT NULL CHECK(body_epoch >= 1),
				durable_generation INTEGER NOT NULL,
				vault_sequence INTEGER NOT NULL,
				runtime_epoch TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY(body_id, client_id, candidate_id)
			);
			CREATE TABLE IF NOT EXISTS vault_creation_candidates (
				body_id TEXT PRIMARY KEY,
				body_epoch INTEGER NOT NULL CHECK(body_epoch >= 1),
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
				document_epoch INTEGER NOT NULL CHECK (document_epoch >= 1),
				content_hash TEXT,
				size INTEGER,
				mutation_index INTEGER NOT NULL,
				PRIMARY KEY(sequence, document_id)
			);
			CREATE INDEX IF NOT EXISTS vault_semantic_catalog_document_sequence
				ON vault_semantic_catalog_events(document_id, sequence DESC);
			CREATE TABLE IF NOT EXISTS vault_excalidraw_prepares (
				operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, drawing_id TEXT NOT NULL,
				path TEXT NOT NULL, source_json TEXT NOT NULL, initialization_request_digest TEXT NOT NULL,
				prepare_permit_id TEXT NOT NULL UNIQUE,
				principal_id TEXT NOT NULL, membership_revision INTEGER NOT NULL, device_id TEXT NOT NULL,
				device_credential_revision INTEGER NOT NULL, created_at INTEGER NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS vault_excalidraw_prepare_drawing ON vault_excalidraw_prepares(drawing_id);
			CREATE TABLE IF NOT EXISTS vault_excalidraw_drawings (
				drawing_id TEXT PRIMARY KEY, file_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
				drawing_epoch INTEGER NOT NULL, lifecycle TEXT NOT NULL, room_sequence INTEGER NOT NULL,
				initialized_operation_id TEXT NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_excalidraw_permits (
				operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, drawing_id TEXT NOT NULL,
				drawing_epoch INTEGER NOT NULL, kind TEXT NOT NULL, permit_json TEXT NOT NULL, created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_excalidraw_finalize_receipts (
				operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_semantic_candidate_receipts (
				document_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				candidate_id TEXT NOT NULL,
				candidate_digest TEXT NOT NULL,
				body_epoch INTEGER NOT NULL CHECK (body_epoch >= 1),
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
				body_epoch INTEGER NOT NULL CHECK (body_epoch >= 1),
				vault_sequence INTEGER NOT NULL,
				root_generation INTEGER NOT NULL,
				root_epoch INTEGER NOT NULL CHECK (root_epoch >= 1),
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
				body_epoch INTEGER NOT NULL CHECK (body_epoch >= 1),
				root_sequence INTEGER NOT NULL,
				root_generation INTEGER NOT NULL,
				root_epoch INTEGER NOT NULL CHECK (root_epoch >= 1),
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
				body_epoch INTEGER NOT NULL CHECK(body_epoch >= 1),
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
				root_epoch INTEGER NOT NULL CHECK(root_epoch >= 1),
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
				root_epoch INTEGER NOT NULL CHECK(root_epoch >= 1),
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

	protected assertActorCurrent(actor: VaultActorContext): void {
		if (this.validateActor(actor) !== "allowed") throw new Error("authority_superseded");
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

	documentHead(documentId: string): { generation: number; semanticEpoch: SemanticEpoch; latestSequence: number } | null {
		this.initialize();
		const row = this.storage.sql.exec<{ generation: number; semantic_epoch: number; latest_sequence: number }>(
			"SELECT generation, semantic_epoch, latest_sequence FROM vault_document_heads WHERE document_id = ?",
			documentId,
		).toArray()[0];
		return row ? {
			generation: row.generation,
			semanticEpoch: parseSemanticEpoch(row.semantic_epoch),
			latestSequence: row.latest_sequence,
		} : null;
	}

	semanticCompactionState(documentId: string): DurableSemanticCompactionState | null {
		this.initialize();
		const row = this.storage.sql.exec<{
			document_id: string; last_compacted_at: number | null;
			post_compaction_encoded_state_bytes: number | null;
		}>(`SELECT document_id, last_compacted_at, post_compaction_encoded_state_bytes
		   FROM vault_semantic_compaction_state WHERE document_id = ?`, documentId).toArray()[0];
		return row ? {
			documentId: row.document_id,
			lastCompactedAt: row.last_compacted_at,
			postCompactionEncodedStateBytes: row.post_compaction_encoded_state_bytes,
		} : null;
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
		const checkpointRows = this.storage.sql.exec<CheckpointStorageRow>(
			`WITH target AS (
			   SELECT MAX(checkpoint_sequence) AS checkpoint_sequence FROM (
			     SELECT checkpoint_sequence FROM vault_checkpoints
			      WHERE document_id = ? AND checkpoint_sequence <= ?
			     UNION ALL
			     SELECT checkpoint_sequence FROM vault_checkpoint_manifests
			      WHERE document_id = ? AND checkpoint_sequence <= ?
			   )
			 )
			 SELECT target.checkpoint_sequence,
			        manifest.generation AS manifest_generation,
			        manifest.semantic_epoch AS manifest_semantic_epoch, manifest.chunk_count,
			        manifest.total_byte_length, manifest.state_sha256, manifest.complete,
			        chunk.generation AS chunk_generation, chunk.semantic_epoch AS chunk_semantic_epoch, chunk.chunk_index,
			        chunk.chunk_byte_length, chunk.chunk_sha256, chunk.data
			 FROM target
			 LEFT JOIN vault_checkpoint_manifests manifest
			   ON manifest.document_id = ? AND manifest.checkpoint_sequence = target.checkpoint_sequence
			 LEFT JOIN vault_checkpoints chunk
			   ON chunk.document_id = ? AND chunk.checkpoint_sequence = target.checkpoint_sequence
			 WHERE target.checkpoint_sequence IS NOT NULL
			 ORDER BY chunk.chunk_index`,
			documentId, throughSequence,
			documentId, throughSequence,
			documentId, documentId,
		);
		const checkpointChunks = checkpointRows.toArray();
		rowsRead += checkpointRows.rowsRead;
		const checkpoint = decodeVerifiedCheckpoint(checkpointChunks);
		const checkpointSequence = checkpoint?.checkpointSequence ?? 0;
		let generation = checkpoint?.generation ?? 0;
		let semanticEpoch = checkpoint?.semanticEpoch ?? INITIAL_SEMANTIC_EPOCH;
		const doc = new Y.Doc({ guid: documentId });
		if (checkpoint) {
			Y.applyUpdate(doc, checkpoint.bytes, "checkpoint-load");
		}
		const journal = this.storage.sql.exec<{
			sequence: number; generation: number; semantic_epoch: number;
			update_byte_length: number; data: DurableChunkValue;
		}>(
			`SELECT sequence, generation, semantic_epoch, update_byte_length, data
			 FROM vault_journal
			 WHERE document_id = ? AND sequence > ? AND sequence <= ?
			 ORDER BY sequence`,
			documentId,
			checkpointSequence,
			throughSequence,
		);
		let journalUpdates = 0;
		for (const row of journal) {
			const update = new Uint8Array(row.data);
			if (update.byteLength !== row.update_byte_length || update.byteLength === 0) {
				throw new Error("journal update length mismatch");
			}
			if (parseSemanticEpoch(row.semantic_epoch) !== semanticEpoch) {
				throw new Error("journal crosses a semantic epoch without a checkpoint");
			}
			Y.applyUpdate(doc, update, "journal-load");
			generation = row.generation;
			journalUpdates++;
		}
		rowsRead += journal.rowsRead;
		return { documentId, throughSequence, generation, semanticEpoch, checkpointSequence, journalUpdates, doc, rowsRead };
	}

	writeCheckpoint(documentId: string, throughSequence = this.currentSequence()): CheckpointWriteResult {
		this.initialize();
		const reconstructed = this.reconstructDocument(documentId, throughSequence);
		const encoded = Y.encodeStateAsUpdate(reconstructed.doc);
		reconstructed.doc.destroy();
		return this.persistCheckpoint(documentId, encoded, {
			throughSequence,
			generation: reconstructed.generation,
			semanticEpoch: reconstructed.semanticEpoch,
		}, false);
	}

	/** Checkpoints an already-resident authoritative document without reconstructing its history. */
	writeCheckpointFromDocument(
		documentId: string,
		doc: Y.Doc,
		expectedHead: CheckpointExpectedHead,
	): CheckpointWriteResult {
		this.initialize();
		this.assertExactCheckpointHead(documentId, expectedHead);
		return this.persistCheckpoint(documentId, Y.encodeStateAsUpdate(doc), expectedHead, true);
	}

	/** Persists an exact encoded authoritative state, fenced against the current durable document head. */
	writeCheckpointFromEncodedState(
		documentId: string,
		encodedState: Uint8Array,
		expectedHead: CheckpointExpectedHead,
	): CheckpointWriteResult {
		this.initialize();
		this.assertExactCheckpointHead(documentId, expectedHead);
		return this.persistCheckpoint(documentId, encodedState, expectedHead, true);
	}

	/**
	 * Atomically abandons the current CRDT lineage and installs a caller-built,
	 * fresh state. Content generation is deliberately unchanged; only semantic
	 * identity and the durable sequence advance.
	 */
	semanticResetFromEncodedState(
		documentId: string,
		freshEncodedState: Uint8Array,
		expectedHead: CheckpointExpectedHead,
		now = Date.now(),
	): SemanticResetResult {
		this.initialize();
		this.assertExactCheckpointHead(documentId, expectedHead);
		if (freshEncodedState.byteLength < 1) throw new Error("invalid semantic reset state");
		const semanticEpoch = nextSemanticEpoch(expectedHead.semanticEpoch);
		const stateSha256 = sha256HexSync(freshEncodedState);
		const chunks: Array<{ offset: number; byteLength: number; sha256: string }> = [];
		for (let offset = 0; offset < freshEncodedState.byteLength; offset += SQLITE_BLOB_CHUNK_BYTES) {
			const chunk = freshEncodedState.subarray(offset,
				Math.min(freshEncodedState.byteLength, offset + SQLITE_BLOB_CHUNK_BYTES));
			chunks.push({ offset, byteLength: chunk.byteLength, sha256: sha256HexSync(chunk) });
		}
		let sequence = 0;
		let rowsWritten = 0;
		this.storage.transactionSync(() => {
			this.assertExactCheckpointHead(documentId, expectedHead);
			if (documentId !== "root") {
				const pendingCreation = this.storage.sql.exec<{ operation_id: string }>(
					"SELECT operation_id FROM vault_creation_candidates WHERE body_id = ? LIMIT 1",
					documentId,
				).toArray()[0];
				const unpublishedLifecycle = this.storage.sql.exec<{ operation_id: string }>(
					`SELECT receipt.operation_id
					   FROM vault_lifecycle_receipts receipt
					   LEFT JOIN vault_lifecycle_publications publication
					     ON publication.operation_id = receipt.operation_id
					  WHERE receipt.body_id = ? AND publication.operation_id IS NULL
					  LIMIT 1`,
					documentId,
				).toArray()[0];
				if (pendingCreation || unpublishedLifecycle) {
					throw new Error("semantic_reset_blocked_by_unpublished_lifecycle");
				}
			}
			const clock = this.storage.sql.exec<{ sequence: number }>(
				"UPDATE vault_clock SET sequence = sequence + 1 WHERE id = 1 RETURNING sequence",
			);
			sequence = clock.one().sequence;
			rowsWritten += clock.rowsWritten;
			const journal = this.storage.sql.exec(
				`INSERT INTO vault_journal(sequence, document_id, generation, semantic_epoch, kind,
				 update_byte_length, data, created_at) VALUES (?, ?, ?, ?, 'semantic-reset', 0, zeroblob(0), ?)`,
				sequence, documentId, expectedHead.generation, semanticEpoch, now,
			);
			journal.toArray();
			rowsWritten += journal.rowsWritten;
			for (let index = 0; index < chunks.length; index++) {
				const metadata = chunks[index]!;
				const bytes = freshEncodedState.subarray(metadata.offset, metadata.offset + metadata.byteLength);
				const write = this.storage.sql.exec(
					`INSERT INTO vault_checkpoints(document_id, checkpoint_sequence, generation, semantic_epoch,
					 chunk_index, chunk_byte_length, chunk_sha256, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					documentId, sequence, expectedHead.generation, semanticEpoch,
					index, metadata.byteLength, metadata.sha256, ownedBuffer(bytes),
				);
				write.toArray();
				rowsWritten += write.rowsWritten;
			}
			const physical = this.storage.sql.exec<{
				chunks: number; total_bytes: number; first_index: number; last_index: number;
				minimum_epoch: number; maximum_epoch: number;
			}>(`SELECT COUNT(*) AS chunks, COALESCE(SUM(length(data)), 0) AS total_bytes,
			          COALESCE(MIN(chunk_index), -1) AS first_index,
			          COALESCE(MAX(chunk_index), -1) AS last_index,
			          COALESCE(MIN(semantic_epoch), -1) AS minimum_epoch,
			          COALESCE(MAX(semantic_epoch), -1) AS maximum_epoch
			   FROM vault_checkpoints WHERE document_id = ? AND checkpoint_sequence = ?`,
				documentId, sequence).one();
			if (physical.chunks !== chunks.length || physical.total_bytes !== freshEncodedState.byteLength
				|| physical.first_index !== 0 || physical.last_index !== chunks.length - 1
				|| physical.minimum_epoch !== semanticEpoch || physical.maximum_epoch !== semanticEpoch) {
				throw checkpointIntegrityError("semantic reset checkpoint is incomplete");
			}
			const manifest = this.storage.sql.exec(
				`INSERT INTO vault_checkpoint_manifests(document_id, checkpoint_sequence, generation,
				 semantic_epoch, chunk_count, total_byte_length, state_sha256, complete, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
				documentId, sequence, expectedHead.generation, semanticEpoch,
				chunks.length, freshEncodedState.byteLength, stateSha256, now,
			);
			manifest.toArray();
			rowsWritten += manifest.rowsWritten;
			this.assertActivePinRetainedCheckpointCapacity(now);
			const head = this.storage.sql.exec(
				`UPDATE vault_document_heads
				 SET semantic_epoch = ?, latest_sequence = ?
				 WHERE document_id = ? AND generation = ? AND semantic_epoch = ? AND latest_sequence = ?`,
				semanticEpoch, sequence, documentId, expectedHead.generation,
				expectedHead.semanticEpoch, expectedHead.throughSequence,
			);
			head.toArray();
			if (head.rowsWritten !== 1) throw new Error("checkpoint head mismatch");
			rowsWritten += head.rowsWritten;
			if (documentId !== "root") {
				// Publish the new body lineage as catalog authority in the same
				// transaction. Catalog epochs must not be reconstructed from journal
				// rows because retired history is intentionally prunable.
				const catalog = this.storage.sql.exec(
					`INSERT INTO vault_catalog_events(
					 sequence, body_id, file_id, path, previous_path, lifecycle, generation,
					 body_epoch, content_hash, size, mutation_index
					)
					SELECT ?, body_id, file_id, path, NULL, lifecycle, generation,
					       ?, content_hash, size, 0
					  FROM vault_catalog_events
					 WHERE body_id = ?
					 ORDER BY sequence DESC LIMIT 1`,
					sequence, semanticEpoch, documentId,
				);
				catalog.toArray();
				rowsWritten += catalog.rowsWritten;
				const semanticCatalog = this.storage.sql.exec(
					`INSERT INTO vault_semantic_catalog_events(
					 sequence, document_id, file_id, kind, format, format_version, path,
					 previous_path, lifecycle, generation, document_epoch, content_hash, size, mutation_index
					)
					SELECT ?, document_id, file_id, kind, format, format_version, path,
					       NULL, lifecycle, generation, ?, content_hash, size, 0
					  FROM vault_semantic_catalog_events
					 WHERE document_id = ?
					 ORDER BY sequence DESC LIMIT 1`,
					sequence, semanticEpoch, documentId,
				);
				semanticCatalog.toArray();
				rowsWritten += semanticCatalog.rowsWritten;
			} else {
				// The fresh root was rebuilt from SQL catalog authority, so every
				// lifecycle receipt at-or-before that immutable boundary is now
				// represented by this root lineage. Rebase both missing publications
				// and existing exact-replay proofs to the new root epoch. The latter
				// matters when a client crashed after server publication but before
				// deleting its local queue: returning an old-epoch proof would make
				// that otherwise exact retry immortal after root compaction.
				const migratedPublications = this.storage.sql.exec(
					`INSERT INTO vault_lifecycle_publications(
					 operation_id, lifecycle_sequence, root_sequence, root_generation,
					 root_epoch, runtime_epoch, created_at
					)
					SELECT receipt.operation_id, receipt.vault_sequence, ?, ?, ?,
					       receipt.runtime_epoch, ?
					  FROM vault_lifecycle_receipts receipt
					 WHERE receipt.vault_sequence <= ?
					 ON CONFLICT(operation_id) DO UPDATE SET
					   lifecycle_sequence=excluded.lifecycle_sequence,
					   root_sequence=excluded.root_sequence,
					   root_generation=excluded.root_generation,
					   root_epoch=excluded.root_epoch,
					   runtime_epoch=excluded.runtime_epoch,
					   created_at=excluded.created_at`,
					sequence,
					expectedHead.generation,
					semanticEpoch,
					now,
					expectedHead.throughSequence,
				);
				migratedPublications.toArray();
				rowsWritten += migratedPublications.rowsWritten;
			}
			const compactionState = this.storage.sql.exec(`INSERT INTO vault_semantic_compaction_state(
			 document_id, last_compacted_at, post_compaction_encoded_state_bytes
			) VALUES (?, ?, ?)
			ON CONFLICT(document_id) DO UPDATE SET
			 last_compacted_at=excluded.last_compacted_at,
			 post_compaction_encoded_state_bytes=excluded.post_compaction_encoded_state_bytes`,
				documentId, now, freshEncodedState.byteLength);
			compactionState.toArray();
			rowsWritten += compactionState.rowsWritten;
			rowsWritten += this.pruneUnpinnedDocumentHistory(now, documentId);
		});
		return {
			status: "written",
			vaultSequence: sequence,
			checkpointSequence: sequence,
			generation: expectedHead.generation,
			previousSemanticEpoch: expectedHead.semanticEpoch,
			semanticEpoch,
			chunks: chunks.length,
			totalBytes: freshEncodedState.byteLength,
			stateSha256,
			rowsWritten,
		};
	}

	/**
	 * Retire storage which belongs to an abandoned semantic lineage.  An active
	 * history pin protects the exact recipe needed at its boundary: the newest
	 * complete checkpoint at-or-before the boundary and every later journal row
	 * through that boundary.  Pins after a reset therefore do not accidentally
	 * retain the older lineage.
	 *
	 * Current-lineage checkpoints keep the ordinary three-generation safety
	 * window. Retired-lineage checkpoints have no implicit grace period: once
	 * their final relevant pin disappears they are removed immediately.
	 */
	protected pruneUnpinnedDocumentHistory(now: number, documentId: string | null = null): number {
		let rowsWritten = 0;
		const journal = this.storage.sql.exec(
			`DELETE FROM vault_journal AS journal
			 WHERE (? IS NULL OR journal.document_id = ?)
			   AND EXISTS (
			     SELECT 1 FROM vault_document_heads head
			      WHERE head.document_id = journal.document_id
			        AND journal.semantic_epoch < head.semantic_epoch
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM vault_history_pins pin
			      WHERE pin.soft_expires_at > ? AND pin.hard_expires_at > ?
			        AND journal.sequence <= pin.boundary_sequence
			        AND journal.sequence > COALESCE((
			          SELECT MAX(manifest.checkpoint_sequence)
			            FROM vault_checkpoint_manifests manifest
			           WHERE manifest.document_id = journal.document_id
			             AND manifest.complete = 1
			             AND manifest.checkpoint_sequence <= pin.boundary_sequence
			        ), 0)
			   )`,
			documentId,
			documentId,
			now,
			now,
		);
		journal.toArray();
		rowsWritten += journal.rowsWritten;

		const checkpoints = this.storage.sql.exec(
			`DELETE FROM vault_checkpoints AS checkpoint
			 WHERE (? IS NULL OR checkpoint.document_id = ?)
			   AND EXISTS (
			     SELECT 1 FROM vault_document_heads head
			      WHERE head.document_id = checkpoint.document_id
			        AND (
			          checkpoint.semantic_epoch < head.semantic_epoch
			          OR checkpoint.checkpoint_sequence NOT IN (
			            SELECT recent.checkpoint_sequence
			              FROM vault_checkpoint_manifests recent
			             WHERE recent.document_id = checkpoint.document_id
			               AND recent.semantic_epoch = head.semantic_epoch
			               AND recent.complete = 1
			             ORDER BY recent.checkpoint_sequence DESC LIMIT 3
			          )
			        )
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM vault_history_pins pin
			      WHERE pin.soft_expires_at > ? AND pin.hard_expires_at > ?
			        AND checkpoint.checkpoint_sequence = (
			          SELECT MAX(protected.checkpoint_sequence)
			            FROM vault_checkpoint_manifests protected
			           WHERE protected.document_id = checkpoint.document_id
			             AND protected.complete = 1
			             AND protected.checkpoint_sequence <= pin.boundary_sequence
			        )
			   )`,
			documentId,
			documentId,
			now,
			now,
		);
		checkpoints.toArray();
		rowsWritten += checkpoints.rowsWritten;

		const manifests = this.storage.sql.exec(
			`DELETE FROM vault_checkpoint_manifests AS manifest
			 WHERE (? IS NULL OR manifest.document_id = ?)
			   AND EXISTS (
			     SELECT 1 FROM vault_document_heads head
			      WHERE head.document_id = manifest.document_id
			        AND (
			          manifest.semantic_epoch < head.semantic_epoch
			          OR manifest.checkpoint_sequence NOT IN (
			            SELECT recent.checkpoint_sequence
			              FROM vault_checkpoint_manifests recent
			             WHERE recent.document_id = manifest.document_id
			               AND recent.semantic_epoch = head.semantic_epoch
			               AND recent.complete = 1
			             ORDER BY recent.checkpoint_sequence DESC LIMIT 3
			          )
			        )
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM vault_history_pins pin
			      WHERE pin.soft_expires_at > ? AND pin.hard_expires_at > ?
			        AND manifest.checkpoint_sequence = (
			          SELECT MAX(protected.checkpoint_sequence)
			            FROM vault_checkpoint_manifests protected
			           WHERE protected.document_id = manifest.document_id
			             AND protected.complete = 1
			             AND protected.checkpoint_sequence <= pin.boundary_sequence
			        )
			   )`,
			documentId,
			documentId,
			now,
			now,
		);
		manifests.toArray();
		rowsWritten += manifests.rowsWritten;
		return rowsWritten;
	}

	private assertExactCheckpointHead(documentId: string, expectedHead: CheckpointExpectedHead): void {
		const head = this.storage.sql.exec<{ generation: number; semantic_epoch: number; latest_sequence: number }>(
			"SELECT generation, semantic_epoch, latest_sequence FROM vault_document_heads WHERE document_id = ?",
			documentId,
		).toArray()[0];
		if (!head || head.generation !== expectedHead.generation
			|| head.semantic_epoch !== expectedHead.semanticEpoch
			|| head.latest_sequence !== expectedHead.throughSequence) {
			throw new Error("checkpoint head mismatch");
		}
	}

	/**
	 * Counts the union of complete logical checkpoints retained by active pins.
	 * A candidate boundary is used while admitting a new pin; checkpoint/reset
	 * writers call this after inserting their manifest but before committing.
	 */
	protected retainedCheckpointBytes(now: number, candidateBoundary: number | null = null): number {
		const row = this.storage.sql.exec<{ bytes: number }>(
			`WITH logical_checkpoint AS (
			   SELECT checkpoint.document_id, checkpoint.checkpoint_sequence,
			          SUM(length(checkpoint.data)) AS bytes
			     FROM vault_checkpoints checkpoint
			     JOIN vault_checkpoint_manifests manifest
			       ON manifest.document_id = checkpoint.document_id
			      AND manifest.checkpoint_sequence = checkpoint.checkpoint_sequence
			    WHERE manifest.complete = 1
			    GROUP BY checkpoint.document_id, checkpoint.checkpoint_sequence
			 )
			 SELECT COALESCE(SUM(checkpoint.bytes), 0) AS bytes
			   FROM logical_checkpoint checkpoint
			  WHERE EXISTS (
			    SELECT 1 FROM vault_history_pins pin
			     WHERE pin.soft_expires_at > ? AND pin.hard_expires_at > ?
			       AND checkpoint.checkpoint_sequence = (
			         SELECT MAX(candidate.checkpoint_sequence)
			           FROM logical_checkpoint candidate
			          WHERE candidate.document_id = checkpoint.document_id
			            AND candidate.checkpoint_sequence <= pin.boundary_sequence
			       )
			  ) OR (? IS NOT NULL AND checkpoint.checkpoint_sequence = (
			    SELECT MAX(candidate.checkpoint_sequence)
			      FROM logical_checkpoint candidate
			     WHERE candidate.document_id = checkpoint.document_id
			       AND candidate.checkpoint_sequence <= ?
			  ))`,
			now,
			now,
			candidateBoundary,
			candidateBoundary,
		).toArray()[0];
		return row?.bytes ?? 0;
	}

	private assertActivePinRetainedCheckpointCapacity(now: number): void {
		if (this.retainedCheckpointBytes(now) > this.historyPinRetainedCheckpointByteLimit()) {
			throw new Error("history_pin_retained_checkpoint_bytes_limit");
		}
	}

	private persistCheckpoint(
		documentId: string,
		encoded: Uint8Array,
		expectedHead: CheckpointExpectedHead,
		requireExactHead: boolean,
	): CheckpointWriteResult {
		if (!documentId || encoded.byteLength < 1
			|| !Number.isSafeInteger(expectedHead.throughSequence) || expectedHead.throughSequence < 0
			|| !Number.isSafeInteger(expectedHead.generation) || expectedHead.generation < 0
			|| !Number.isSafeInteger(expectedHead.semanticEpoch)
			|| expectedHead.semanticEpoch < INITIAL_SEMANTIC_EPOCH) {
			throw new Error("invalid checkpoint input");
		}
		const now = Date.now();
		const stateSha256 = sha256HexSync(encoded);
		const chunkMetadata: Array<{ offset: number; byteLength: number; sha256: string }> = [];
		for (let offset = 0; offset < encoded.byteLength; offset += SQLITE_BLOB_CHUNK_BYTES) {
			const chunk = encoded.subarray(offset, Math.min(encoded.byteLength, offset + SQLITE_BLOB_CHUNK_BYTES));
			chunkMetadata.push({ offset, byteLength: chunk.byteLength, sha256: sha256HexSync(chunk) });
		}
		let rowsWritten = 0;
		this.storage.transactionSync(() => {
			if (requireExactHead) this.assertExactCheckpointHead(documentId, expectedHead);
			for (let index = 0; index < chunkMetadata.length; index++) {
				const metadata = chunkMetadata[index]!;
				const chunk = encoded.subarray(metadata.offset, metadata.offset + metadata.byteLength);
				const write = this.storage.sql.exec(
					`INSERT INTO vault_checkpoints(document_id, checkpoint_sequence, generation, semantic_epoch, chunk_index,
					                                  chunk_byte_length, chunk_sha256, data)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					documentId,
					expectedHead.throughSequence,
					expectedHead.generation,
					expectedHead.semanticEpoch,
					index,
					metadata.byteLength,
					metadata.sha256,
					ownedBuffer(chunk),
				);
				write.toArray();
				rowsWritten += write.rowsWritten;
			}
			const physical = this.storage.sql.exec<{
				chunks: number; total_bytes: number; first_index: number; last_index: number;
			}>(`SELECT COUNT(*) AS chunks, COALESCE(SUM(length(data)), 0) AS total_bytes,
			          COALESCE(MIN(chunk_index), -1) AS first_index, COALESCE(MAX(chunk_index), -1) AS last_index
			   FROM vault_checkpoints WHERE document_id = ? AND checkpoint_sequence = ?`,
				documentId, expectedHead.throughSequence).one();
			if (physical.chunks !== chunkMetadata.length || physical.total_bytes !== encoded.byteLength
				|| physical.first_index !== 0 || physical.last_index !== chunkMetadata.length - 1) {
				throw checkpointIntegrityError("new checkpoint is incomplete");
			}
			const manifest = this.storage.sql.exec(
				`INSERT INTO vault_checkpoint_manifests(document_id, checkpoint_sequence, generation, semantic_epoch,
				 chunk_count, total_byte_length, state_sha256, complete, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
				documentId, expectedHead.throughSequence, expectedHead.generation, expectedHead.semanticEpoch,
				chunkMetadata.length, encoded.byteLength, stateSha256, now,
			);
			manifest.toArray();
			rowsWritten += manifest.rowsWritten;
			this.assertActivePinRetainedCheckpointCapacity(now);
			const feedFloor = this.journalFloor();
			const deleteThrough = Math.min(expectedHead.throughSequence, feedFloor);
			const deleteJournal = this.storage.sql.exec(
				"DELETE FROM vault_journal WHERE document_id = ? AND sequence <= ?",
				documentId,
				deleteThrough,
			);
			deleteJournal.toArray();
			rowsWritten += deleteJournal.rowsWritten;
			rowsWritten += this.pruneUnpinnedDocumentHistory(now, documentId);
		});
		return {
			status: "written",
			checkpointSequence: expectedHead.throughSequence,
			generation: expectedHead.generation,
			semanticEpoch: expectedHead.semanticEpoch,
			chunks: chunkMetadata.length,
			totalBytes: encoded.byteLength,
			stateSha256,
			rowsWritten,
		};
	}

	listChangesAfter(sequence: number, limit = 1000): JournalFeedEntry[] {
		this.initialize();
		const boundedLimit = Math.min(1000, Math.max(1, limit));
		const rows = this.storage.sql.exec<{
			sequence: number; document_id: string; generation: number; semantic_epoch: number; kind: VaultCommitKind;
		}>(
			`SELECT sequence, document_id, generation, semantic_epoch, kind FROM vault_journal
			 WHERE sequence > ? ORDER BY sequence LIMIT ?`,
			sequence,
			boundedLimit,
		).toArray();
		const catalogs = this.storage.sql.exec<{
			sequence: number; body_id: string; file_id: string; path: string; previous_path: string | null;
			lifecycle: BodyLifecycle; generation: number; body_epoch: number; content_hash: string | null; size: number | null;
		}>(
			`SELECT c.sequence, c.body_id, c.file_id, c.path, c.previous_path, c.lifecycle,
			        c.generation, c.body_epoch,
			        c.content_hash, c.size
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
				bodyEpoch: parseSemanticEpoch(catalog.body_epoch, "feed catalog body epoch"),
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
			lifecycle: SemanticCatalogHead["lifecycle"]; generation: number; document_epoch: number;
			content_hash: string | null; size: number | null;
		}>(`SELECT c.sequence, c.document_id, c.file_id, c.kind, c.format, c.format_version, c.path,
		          c.previous_path, c.lifecycle, c.generation, c.document_epoch, c.content_hash, c.size
		   FROM vault_semantic_catalog_events c JOIN (
		     SELECT sequence FROM vault_journal WHERE sequence > ? ORDER BY sequence LIMIT ?
		   ) page ON page.sequence = c.sequence ORDER BY c.sequence, c.mutation_index`, sequence, boundedLimit).toArray();
		const semanticBySequence = new Map<number, SemanticCatalogHead[]>();
		for (const value of semanticCatalogs) {
			const mapped: SemanticCatalogHead = { sequence: value.sequence, documentId: value.document_id,
				fileId: value.file_id, kind: value.kind, format: value.format, formatVersion: value.format_version,
				path: value.path, previousPath: value.previous_path, lifecycle: value.lifecycle,
				generation: value.generation,
				bodyEpoch: parseSemanticEpoch(value.document_epoch, "feed semantic document epoch"),
				contentHash: value.content_hash, size: value.size };
			const entries = semanticBySequence.get(value.sequence);
			if (entries) entries.push(mapped); else semanticBySequence.set(value.sequence, [mapped]);
		}
		return rows.map((row) => ({
			sequence: row.sequence,
			documentId: row.document_id,
			generation: row.generation,
			documentEpoch: parseSemanticEpoch(row.semantic_epoch),
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
			const prune = this.storage.sql.exec(
				`DELETE FROM vault_journal
				 WHERE sequence <= ?
				   AND EXISTS (
				     SELECT 1 FROM vault_checkpoints c
				     JOIN vault_checkpoint_manifests manifest
				       ON manifest.document_id = c.document_id
				      AND manifest.checkpoint_sequence = c.checkpoint_sequence
				      AND manifest.complete = 1
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
		const checkpoint = this.storage.sql.exec<CheckpointSummaryRow>(
			`WITH target AS (
			   SELECT MAX(checkpoint_sequence) AS checkpoint_sequence FROM (
			     SELECT checkpoint_sequence FROM vault_checkpoints WHERE document_id = ? AND checkpoint_sequence <= ?
			     UNION ALL
			     SELECT checkpoint_sequence FROM vault_checkpoint_manifests WHERE document_id = ? AND checkpoint_sequence <= ?
			   )
			 )
			 SELECT target.checkpoint_sequence, manifest.generation, manifest.semantic_epoch, manifest.chunk_count,
			        manifest.total_byte_length, manifest.state_sha256, manifest.complete,
			        COUNT(chunk.chunk_index) AS physical_chunks,
			        COALESCE(SUM(length(chunk.data)), 0) AS physical_bytes,
			        COALESCE(MIN(chunk.chunk_index), -1) AS first_index,
			        COALESCE(MAX(chunk.chunk_index), -1) AS last_index,
			        COALESCE(MIN(chunk.semantic_epoch), -1) AS minimum_chunk_epoch,
			        COALESCE(MAX(chunk.semantic_epoch), -1) AS maximum_chunk_epoch
			 FROM target
			 LEFT JOIN vault_checkpoint_manifests manifest
			   ON manifest.document_id = ? AND manifest.checkpoint_sequence = target.checkpoint_sequence
			 LEFT JOIN vault_checkpoints chunk
			   ON chunk.document_id = ? AND chunk.checkpoint_sequence = target.checkpoint_sequence
			 WHERE target.checkpoint_sequence IS NOT NULL
			 GROUP BY target.checkpoint_sequence, manifest.generation, manifest.semantic_epoch, manifest.chunk_count,
			          manifest.total_byte_length, manifest.state_sha256, manifest.complete`,
			documentId, throughSequence, documentId, throughSequence, documentId, documentId,
		).toArray()[0];
		if (checkpoint) assertCheckpointSummary(checkpoint);
		const checkpointSequence = checkpoint?.checkpoint_sequence ?? 0;
		let bytes = checkpoint?.total_byte_length ?? 0;
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
		const checkpoint = this.storage.sql.exec<CheckpointSummaryRow>(
			`WITH target AS (
			   SELECT MAX(checkpoint_sequence) AS checkpoint_sequence FROM (
			     SELECT checkpoint_sequence FROM vault_checkpoints WHERE document_id = ? AND checkpoint_sequence <= ?
			     UNION ALL
			     SELECT checkpoint_sequence FROM vault_checkpoint_manifests WHERE document_id = ? AND checkpoint_sequence <= ?
			   )
			 )
			 SELECT target.checkpoint_sequence, manifest.generation, manifest.semantic_epoch, manifest.chunk_count,
			        manifest.total_byte_length, manifest.state_sha256, manifest.complete,
			        COUNT(chunk.chunk_index) AS physical_chunks,
			        COALESCE(SUM(length(chunk.data)), 0) AS physical_bytes,
			        COALESCE(MIN(chunk.chunk_index), -1) AS first_index,
			        COALESCE(MAX(chunk.chunk_index), -1) AS last_index,
			        COALESCE(MIN(chunk.semantic_epoch), -1) AS minimum_chunk_epoch,
			        COALESCE(MAX(chunk.semantic_epoch), -1) AS maximum_chunk_epoch
			 FROM target
			 LEFT JOIN vault_checkpoint_manifests manifest
			   ON manifest.document_id = ? AND manifest.checkpoint_sequence = target.checkpoint_sequence
			 LEFT JOIN vault_checkpoints chunk
			   ON chunk.document_id = ? AND chunk.checkpoint_sequence = target.checkpoint_sequence
			 WHERE target.checkpoint_sequence IS NOT NULL
			 GROUP BY target.checkpoint_sequence, manifest.generation, manifest.semantic_epoch, manifest.chunk_count,
			          manifest.total_byte_length, manifest.state_sha256, manifest.complete`,
			documentId, throughSequence, documentId, throughSequence, documentId, documentId,
		).toArray()[0];
		if (checkpoint) assertCheckpointSummary(checkpoint);
		const checkpointSequence = checkpoint?.checkpoint_sequence ?? 0;
		const checkpointCount = checkpoint?.chunk_count ?? 0;
		const checkpointRows = checkpoint && offset < checkpointCount ? this.storage.sql.exec<{
			chunk_index: number; expected_bytes: number; chunk_sha256: string; data: DurableChunkValue;
		}>(
			`WITH candidates AS (
			   SELECT chunk_index, chunk_byte_length AS expected_bytes, chunk_sha256
			   FROM vault_checkpoints
			   WHERE document_id = ? AND checkpoint_sequence = ? AND chunk_index >= ?
			   ORDER BY chunk_index LIMIT 256
			 ), sized AS (
			   SELECT chunk_index, expected_bytes,
			          ROW_NUMBER() OVER (ORDER BY chunk_index) AS ordinal,
			          SUM(expected_bytes) OVER (ORDER BY chunk_index ROWS UNBOUNDED PRECEDING) AS running_bytes
			   FROM candidates
			 )
			 SELECT sized.chunk_index, sized.expected_bytes, checkpoint.chunk_sha256, checkpoint.data
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
			fragmentCount: number; expectedBytes: number; expectedSha256?: string; bytes: Uint8Array;
		}> = checkpointRows.map((row) => ({
			kind: "checkpoint", sequence: checkpointSequence, fragmentIndex: row.chunk_index,
			fragmentCount: checkpointCount, expectedBytes: row.expected_bytes,
			expectedSha256: row.chunk_sha256, bytes: new Uint8Array(row.data),
		}));
		for (let index = 0; index < candidates.length; index++) {
			const candidate = candidates[index]!;
			if (candidate.fragmentIndex !== offset + index
				|| candidate.expectedSha256 === undefined
				|| sha256HexSync(candidate.bytes) !== candidate.expectedSha256) {
				throw checkpointIntegrityError("recipe checkpoint chunk mismatch");
			}
		}
		const checkpointBytes = candidates.reduce((total, candidate) => total + candidate.expectedBytes, 0);
		const checkpointExhausted = offset >= checkpointCount
			|| offset + checkpointRows.length >= checkpointCount;
		const journalLimit = checkpointExhausted ? 256 - checkpointRows.length : 0;
		const remainingBytes = maxBytes - checkpointBytes;
		const forceFirstJournal = checkpointRows.length === 0;
		const journalRows = journalLimit > 0 && (remainingBytes > 0 || forceFirstJournal) ? this.storage.sql.exec<{
			sequence: number; update_byte_length: number; data: DurableChunkValue;
		}>(
			`WITH candidates AS (
			   SELECT sequence, update_byte_length, data FROM vault_journal
			   WHERE document_id = ? AND sequence > ? AND sequence <= ?
			   ORDER BY sequence LIMIT ? OFFSET ?
			 ), sized AS (
			   SELECT sequence, update_byte_length, data,
			          ROW_NUMBER() OVER (ORDER BY sequence) AS ordinal,
			          SUM(update_byte_length) OVER (ORDER BY sequence ROWS UNBOUNDED PRECEDING) AS running_bytes
			   FROM candidates
			 ), selected AS (
			   SELECT sequence, update_byte_length, data FROM sized
			   WHERE running_bytes <= ? OR (? = 1 AND ordinal = 1)
			 )
			 SELECT sequence, update_byte_length, data FROM selected ORDER BY sequence`,
			documentId,
			checkpointSequence,
			throughSequence,
			journalLimit,
			journalOffset,
			Math.max(0, remainingBytes),
			forceFirstJournal ? 1 : 0,
		).toArray() : [];
		for (const row of journalRows) {
			candidates.push({
				kind: "journal", sequence: row.sequence, fragmentIndex: 0, fragmentCount: 1,
				expectedBytes: row.update_byte_length, bytes: new Uint8Array(row.data),
			});
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
