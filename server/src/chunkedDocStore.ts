import * as Y from "yjs";
import { sha256Hex } from "./hex";

const CHECKPOINT_FORMAT = "yaos-doc-checkpoint-v2";
const JOURNAL_META_FORMAT = "yaos-doc-journal-v1";
const JOURNAL_ENTRY_FORMAT = "yaos-doc-journal-entry-v1";

const CHECKPOINT_POINTER_KEY = "document:checkpoint:current";
const CHECKPOINT_MANIFEST_PREFIX = "document:checkpoint:manifest:";
const CHECKPOINT_CHUNK_PREFIX = "document:checkpoint:chunk:";
const CHECKPOINT_STATE_VECTOR_PREFIX = "document:checkpoint:state-vector:";

const JOURNAL_META_KEY = "document:journal:meta";
const JOURNAL_MANIFEST_PREFIX = "document:journal:manifest:";
const JOURNAL_CHUNK_PREFIX = "document:journal:chunk:";

const DEFAULT_CHUNK_SIZE_BYTES = 64 * 1024; // 64KB — safe margin under CF DO per-value limit
const DEFAULT_MAX_KEYS_PER_OPERATION = 128;
/** Max keys per put when writing large binary chunks to avoid exceeding per-call size limits. */
const MAX_CHUNK_KEYS_PER_PUT = 16;

interface ManifestPointer {
	version: number;
}

interface CheckpointManifest {
	format: typeof CHECKPOINT_FORMAT;
	version: number;
	chunkSizeBytes: number;
	chunkCount: number;
	byteLength: number;
	sha256: string;
	stateVectorByteLength: number;
	stateVectorSha256: string;
	updatedAt: string;
}

interface StorageLike {
	get<T = unknown>(key: string): Promise<T | undefined>;
	get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	put<T>(entries: Record<string, T>): Promise<void>;
	delete(keys: string[]): Promise<number>;
	transaction<T>(closure: (txn: TransactionLike) => Promise<T>): Promise<T>;
}

interface TransactionLike {
	get<T = unknown>(key: string): Promise<T | undefined>;
	get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	put<T>(entries: Record<string, T>): Promise<void>;
	delete(keys: string[]): Promise<number>;
}

interface JournalMeta {
	format: typeof JOURNAL_META_FORMAT;
	nextSeq: number;
	entryCount: number;
	totalBytes: number;
	updatedAt: string;
}

interface JournalEntryManifest {
	format: typeof JOURNAL_ENTRY_FORMAT;
	seq: number;
	chunkSizeBytes: number;
	chunkCount: number;
	byteLength: number;
	sha256: string;
	updatedAt: string;
}

interface ChunkDescriptor {
	chunkCount: number;
	chunkSizeBytes: number;
	byteLength: number;
	sha256: string;
}

export interface ChunkedDocStoreOptions {
	chunkSizeBytes?: number;
	maxKeysPerOperation?: number;
}

export interface JournalStats {
	entryCount: number;
	totalBytes: number;
	nextSeq: number;
}

export interface LoadedDocState {
	checkpoint: Uint8Array | null;
	checkpointStateVector: Uint8Array | null;
	journalUpdates: Uint8Array[];
	journalStats: JournalStats;
}

function checkpointManifestKey(version: number): string {
	return `${CHECKPOINT_MANIFEST_PREFIX}${version}`;
}

function checkpointChunkKey(version: number, index: number): string {
	return `${CHECKPOINT_CHUNK_PREFIX}${version}:${index}`;
}

function checkpointStateVectorKey(version: number): string {
	return `${CHECKPOINT_STATE_VECTOR_PREFIX}${version}`;
}

function journalManifestKey(seq: number): string {
	return `${JOURNAL_MANIFEST_PREFIX}${seq}`;
}

function journalChunkKey(seq: number, index: number): string {
	return `${JOURNAL_CHUNK_PREFIX}${seq}:${index}`;
}

function normalizeBytes(data: unknown, label: string): Uint8Array {
	if (data instanceof Uint8Array) {
		return data;
	}
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	throw new Error(`invalid binary payload for ${label}`);
}

function isManifestPointer(value: unknown): value is ManifestPointer {
	return (
		typeof value === "object"
		&& value !== null
		&& Number.isInteger((value as ManifestPointer).version)
		&& (value as ManifestPointer).version > 0
	);
}

function isChunkedManifest(value: unknown): value is CheckpointManifest {
	if (typeof value !== "object" || value === null) return false;
	const m = value as CheckpointManifest;
	if (m.format !== CHECKPOINT_FORMAT) return false;
	if (!Number.isInteger(m.version) || m.version <= 0) return false;
	if (!Number.isInteger(m.chunkSizeBytes) || m.chunkSizeBytes <= 0) return false;
	if (!Number.isInteger(m.chunkCount) || m.chunkCount < 0) return false;
	if (!Number.isInteger(m.byteLength) || m.byteLength < 0) return false;
	if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) return false;
	if (!Number.isInteger(m.stateVectorByteLength) || m.stateVectorByteLength < 0) return false;
	if (typeof m.stateVectorSha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.stateVectorSha256)) return false;
	if (typeof m.updatedAt !== "string" || m.updatedAt.length === 0) return false;
	return true;
}

function isJournalMeta(value: unknown): value is JournalMeta {
	if (typeof value !== "object" || value === null) return false;
	const m = value as JournalMeta;
	if (m.format !== JOURNAL_META_FORMAT) return false;
	if (!Number.isInteger(m.nextSeq) || m.nextSeq < 1) return false;
	if (!Number.isInteger(m.entryCount) || m.entryCount < 0) return false;
	if (!Number.isInteger(m.totalBytes) || m.totalBytes < 0) return false;
	if (typeof m.updatedAt !== "string" || m.updatedAt.length === 0) return false;
	return true;
}

function isJournalEntryManifest(value: unknown): value is JournalEntryManifest {
	if (typeof value !== "object" || value === null) return false;
	const m = value as JournalEntryManifest;
	if (m.format !== JOURNAL_ENTRY_FORMAT) return false;
	if (!Number.isInteger(m.seq) || m.seq < 1) return false;
	if (!Number.isInteger(m.chunkSizeBytes) || m.chunkSizeBytes <= 0) return false;
	if (!Number.isInteger(m.chunkCount) || m.chunkCount < 0) return false;
	if (!Number.isInteger(m.byteLength) || m.byteLength < 0) return false;
	if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) return false;
	if (typeof m.updatedAt !== "string" || m.updatedAt.length === 0) return false;
	return true;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) {
		out.push(arr.slice(i, i + size));
	}
	return out;
}

async function getManyBatched<T>(
	storage: StorageLike | TransactionLike,
	keys: string[],
	maxKeysPerOperation: number,
): Promise<Map<string, T>> {
	const merged = new Map<string, T>();
	for (const batch of chunkArray(keys, maxKeysPerOperation)) {
		const page = await storage.get<T>(batch);
		for (const [key, value] of page) {
			merged.set(key, value);
		}
	}
	return merged;
}

async function putEntriesBatched(
	target: StorageLike | TransactionLike,
	entries: Array<[string, unknown]>,
	maxKeysPerOperation: number,
): Promise<void> {
	for (const batch of chunkArray(entries, maxKeysPerOperation)) {
		const record: Record<string, unknown> = {};
		for (const [key, value] of batch) {
			record[key] = value;
		}
		await target.put(record);
	}
}

async function deleteKeysBatched(
	target: StorageLike | TransactionLike,
	keys: string[],
	maxKeysPerOperation: number,
): Promise<void> {
	if (keys.length === 0) return;
	for (const batch of chunkArray(keys, maxKeysPerOperation)) {
		await target.delete(batch);
	}
}

async function putChunkedPayloadBatched(
	target: StorageLike | TransactionLike,
	bytes: Uint8Array,
	chunkSizeBytes: number,
	chunkKeyForIndex: (index: number) => string,
	_maxKeysPerOperation: number,
): Promise<number> {
	const chunkCount = bytes.byteLength === 0
		? 0
		: Math.ceil(bytes.byteLength / chunkSizeBytes);

	if (chunkCount === 0) return 0;

	// Use a smaller batch size for binary chunk writes to avoid exceeding
	// per-call total size limits (e.g., 16 * 64KB = 1MB per put call).
	const batchSize = MAX_CHUNK_KEYS_PER_PUT;
	for (let chunkStart = 0; chunkStart < chunkCount; chunkStart += batchSize) {
		const chunkEnd = Math.min(chunkStart + batchSize, chunkCount);
		const record: Record<string, Uint8Array> = {};
		for (let i = chunkStart; i < chunkEnd; i++) {
			const start = i * chunkSizeBytes;
			const end = Math.min(start + chunkSizeBytes, bytes.byteLength);
			// .slice() creates an independent copy — avoids issues with
			// structured clone of views sharing a large underlying buffer.
			record[chunkKeyForIndex(i)] = bytes.slice(start, end);
		}
		await target.put(record);
	}

	return chunkCount;
}

function emptyJournalMeta(now = new Date().toISOString()): JournalMeta {
	return {
		format: JOURNAL_META_FORMAT,
		nextSeq: 1,
		entryCount: 0,
		totalBytes: 0,
		updatedAt: now,
	};
}

function journalStatsFromMeta(meta: JournalMeta): JournalStats {
	return {
		entryCount: meta.entryCount,
		totalBytes: meta.totalBytes,
		nextSeq: meta.nextSeq,
	};
}

function expectedJournalSeqs(meta: JournalMeta): number[] {
	const firstSeq = meta.nextSeq - meta.entryCount;
	if (firstSeq < 1) {
		throw new Error(
			`journal metadata is inconsistent (nextSeq=${meta.nextSeq}, entryCount=${meta.entryCount})`,
		);
	}
	const out: number[] = [];
	for (let seq = firstSeq; seq < meta.nextSeq; seq++) {
		out.push(seq);
	}
	return out;
}

async function readChunkedPayload(
	storage: StorageLike | TransactionLike,
	descriptor: ChunkDescriptor,
	chunkKeyForIndex: (index: number) => string,
	contextLabel: string,
	maxKeysPerOperation: number,
): Promise<Uint8Array> {
	const keys: string[] = [];
	for (let i = 0; i < descriptor.chunkCount; i++) {
		keys.push(chunkKeyForIndex(i));
	}
	const chunks = await getManyBatched<unknown>(storage, keys, maxKeysPerOperation);
	if (chunks.size !== descriptor.chunkCount) {
		throw new Error(
			`${contextLabel} load failed: expected ${descriptor.chunkCount} chunks, found ${chunks.size}`,
		);
	}

	const fullUpdate = new Uint8Array(descriptor.byteLength);
	let offset = 0;
	for (let i = 0; i < descriptor.chunkCount; i++) {
		const key = chunkKeyForIndex(i);
		const rawChunk = chunks.get(key);
		if (rawChunk === undefined) {
			throw new Error(`${contextLabel} load failed: missing chunk ${i}`);
		}
		const bytes = normalizeBytes(rawChunk, key);
		if (i < descriptor.chunkCount - 1 && bytes.byteLength !== descriptor.chunkSizeBytes) {
			throw new Error(
				`${contextLabel} load failed: chunk ${i} has invalid length ${bytes.byteLength}`,
			);
		}
		if (i === descriptor.chunkCount - 1 && bytes.byteLength > descriptor.chunkSizeBytes) {
			throw new Error(
				`${contextLabel} load failed: final chunk is too large (${bytes.byteLength})`,
			);
		}
		if (offset + bytes.byteLength > descriptor.byteLength) {
			throw new Error(`${contextLabel} load failed: chunk bytes exceed manifest size`);
		}
		fullUpdate.set(bytes, offset);
		offset += bytes.byteLength;
	}

	if (offset !== descriptor.byteLength) {
		throw new Error(
			`${contextLabel} load failed: expected ${descriptor.byteLength} bytes, reconstructed ${offset}`,
		);
	}

	const hash = await sha256Hex(fullUpdate);
	if (hash !== descriptor.sha256) {
		throw new Error(`${contextLabel} load failed: sha256 mismatch`);
	}
	return fullUpdate;
}

export class ChunkedDocStore {
	private readonly chunkSizeBytes: number;
	private readonly maxKeysPerOperation: number;

	constructor(
		private readonly storage: StorageLike,
		options: ChunkedDocStoreOptions = {},
	) {
		this.chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
		this.maxKeysPerOperation = options.maxKeysPerOperation ?? DEFAULT_MAX_KEYS_PER_OPERATION;
	}

	async loadState(): Promise<LoadedDocState> {
		const checkpoint = await this.loadCheckpoint();
		const journal = await this.loadJournal();
		return {
			checkpoint: checkpoint?.update ?? null,
			checkpointStateVector: checkpoint?.stateVector ?? null,
			journalUpdates: journal.entries,
			journalStats: journalStatsFromMeta(journal.meta),
		};
	}

	async getJournalStats(): Promise<JournalStats> {
		const meta = await this.readJournalMeta(this.storage);
		return journalStatsFromMeta(meta);
	}

	async appendUpdate(update: Uint8Array): Promise<JournalStats> {
		const bytes = normalizeBytes(update, "appendUpdate(update)");
		await this.storage.transaction(async (txn) => {
			const now = new Date().toISOString();
			const meta = await this.readJournalMeta(txn);
			if (bytes.byteLength === 0) {
				return;
			}
			const seq = meta.nextSeq;
			const hash = await sha256Hex(bytes);

			const chunkCount = await putChunkedPayloadBatched(
				txn,
				bytes,
				this.chunkSizeBytes,
				(i) => journalChunkKey(seq, i),
				this.maxKeysPerOperation,
			);

			const manifest: JournalEntryManifest = {
				format: JOURNAL_ENTRY_FORMAT,
				seq,
				chunkSizeBytes: this.chunkSizeBytes,
				chunkCount,
				byteLength: bytes.byteLength,
				sha256: hash,
				updatedAt: now,
			};
			const updatedMeta: JournalMeta = {
				format: JOURNAL_META_FORMAT,
				nextSeq: seq + 1,
				entryCount: meta.entryCount + 1,
				totalBytes: meta.totalBytes + bytes.byteLength,
				updatedAt: now,
			};
			await putEntriesBatched(
				txn,
				[
					[journalManifestKey(seq), manifest],
					[JOURNAL_META_KEY, updatedMeta],
				],
				this.maxKeysPerOperation,
			);
		});

		const meta = await this.readJournalMeta(this.storage);
		return journalStatsFromMeta(meta);
	}

	async rewriteCheckpoint(update: Uint8Array, stateVector: Uint8Array): Promise<void> {
		const updateBytes = normalizeBytes(update, "rewriteCheckpoint(update)");
		const stateVectorBytes = normalizeBytes(stateVector, "rewriteCheckpoint(stateVector)");
		const updateHash = await sha256Hex(updateBytes);
		const stateVectorHash = await sha256Hex(stateVectorBytes);

		// ── Pre-compute: determine new version and collect cleanup keys ──────
		const existingPointerRaw = await this.storage.get<unknown>(CHECKPOINT_POINTER_KEY);
		const existingPointer = existingPointerRaw === undefined
			? null
			: isManifestPointer(existingPointerRaw)
				? existingPointerRaw
				: (() => { throw new Error("checkpoint pointer is invalid"); })();

		const newVersion = existingPointer ? existingPointer.version + 1 : 1;

		// Collect cleanup keys (old checkpoint + journal entries)
		const cleanupKeys = new Set<string>();
		if (existingPointer) {
			const oldManifestRaw = await this.storage.get<unknown>(checkpointManifestKey(existingPointer.version));
			if (isChunkedManifest(oldManifestRaw)) {
				cleanupKeys.add(checkpointManifestKey(existingPointer.version));
				cleanupKeys.add(checkpointStateVectorKey(existingPointer.version));
				for (let i = 0; i < oldManifestRaw.chunkCount; i++) {
					cleanupKeys.add(checkpointChunkKey(oldManifestRaw.version, i));
				}
			}
		}

		const journalMeta = await this.readJournalMeta(this.storage);
		if (journalMeta.entryCount > 0) {
			const seqs = expectedJournalSeqs(journalMeta);
			for (const seq of seqs) {
				cleanupKeys.add(journalManifestKey(seq));
				cleanupKeys.add(journalChunkKey(seq, 0));
			}
		}

		// ── Phase 1: Write new checkpoint chunks (non-transactional) ─────────
		// These keys are not referenced by anything yet — safe to write outside
		// a transaction.  If we crash here, they're orphaned (harmless).
		const chunkCount = await putChunkedPayloadBatched(
			this.storage,
			updateBytes,
			this.chunkSizeBytes,
			(i) => checkpointChunkKey(newVersion, i),
			this.maxKeysPerOperation,
		);

		// ── Phase 2: Atomic pointer swap (small transaction) ─────────────────
		// This is the critical section.  It atomically:
		// - Publishes the new checkpoint (manifest + pointer)
		// - Resets the journal to empty
		// If this fails, the chunks from Phase 1 are orphaned (harmless).
		const now = new Date().toISOString();
		const manifest: CheckpointManifest = {
			format: CHECKPOINT_FORMAT,
			version: newVersion,
			chunkSizeBytes: this.chunkSizeBytes,
			chunkCount,
			byteLength: updateBytes.byteLength,
			sha256: updateHash,
			stateVectorByteLength: stateVectorBytes.byteLength,
			stateVectorSha256: stateVectorHash,
			updatedAt: now,
		};

		await this.storage.transaction(async (txn) => {
			await putEntriesBatched(
				txn,
				[
					[checkpointManifestKey(newVersion), manifest],
					[checkpointStateVectorKey(newVersion), stateVectorBytes],
					[CHECKPOINT_POINTER_KEY, { version: newVersion } satisfies ManifestPointer],
					[JOURNAL_META_KEY, emptyJournalMeta(now)],
				],
				this.maxKeysPerOperation,
			);
		});

		// ── Phase 3: Non-transactional cleanup ───────────────────────────────
		// Delete orphaned keys.  Safe to fail — they're unreachable.
		if (cleanupKeys.size > 0) {
			await deleteKeysBatched(this.storage, Array.from(cleanupKeys), this.maxKeysPerOperation);
		}
	}

	async loadLatest(): Promise<Uint8Array | null> {
		const state = await this.loadState();
		const updates: Uint8Array[] = [];
		if (state.checkpoint) {
			updates.push(state.checkpoint);
		}
		updates.push(...state.journalUpdates);
		if (updates.length === 0) return null;
			if (updates.length === 1) return updates[0] ?? null;
		return Y.mergeUpdates(updates);
	}

	async saveLatest(update: Uint8Array): Promise<void> {
		const bytes = normalizeBytes(update, "saveLatest(update)");
		const doc = new Y.Doc();
		if (bytes.byteLength > 0) {
			Y.applyUpdate(doc, bytes);
		}
		await this.rewriteCheckpoint(bytes, Y.encodeStateVector(doc));
	}

	private async loadCheckpoint(): Promise<{
		update: Uint8Array;
		stateVector: Uint8Array;
	} | null> {
		const rawPointer = await this.storage.get<unknown>(CHECKPOINT_POINTER_KEY);
		if (rawPointer === undefined) {
			return null;
		}
		if (!isManifestPointer(rawPointer)) {
			throw new Error("checkpoint pointer is invalid");
		}

		const rawManifest = await this.storage.get<unknown>(checkpointManifestKey(rawPointer.version));
		if (!isChunkedManifest(rawManifest)) {
			throw new Error(`checkpoint manifest missing or invalid for version ${rawPointer.version}`);
		}
		if (rawManifest.version !== rawPointer.version) {
			throw new Error(
				`checkpoint version mismatch (pointer=${rawPointer.version}, manifest=${rawManifest.version})`,
			);
		}

		const update = await readChunkedPayload(
			this.storage,
			rawManifest,
			(i) => checkpointChunkKey(rawManifest.version, i),
			"checkpoint",
			this.maxKeysPerOperation,
		);

		const rawStateVector = await this.storage.get<unknown>(checkpointStateVectorKey(rawManifest.version));
		if (rawStateVector === undefined) {
			throw new Error(`checkpoint state vector missing for version ${rawManifest.version}`);
		}
		const stateVector = normalizeBytes(rawStateVector, checkpointStateVectorKey(rawManifest.version));
		if (stateVector.byteLength !== rawManifest.stateVectorByteLength) {
			throw new Error(
				`checkpoint state vector length mismatch (expected ${rawManifest.stateVectorByteLength}, got ${stateVector.byteLength})`,
			);
		}
		const stateVectorHash = await sha256Hex(stateVector);
		if (stateVectorHash !== rawManifest.stateVectorSha256) {
			throw new Error("checkpoint state vector sha256 mismatch");
		}

		return { update, stateVector };
	}

	private async loadJournal(): Promise<{
		meta: JournalMeta;
		entries: Uint8Array[];
	}> {
		const meta = await this.readJournalMeta(this.storage);
		if (meta.entryCount === 0) {
			if (meta.totalBytes !== 0) {
				throw new Error("journal metadata is inconsistent (entryCount=0 but totalBytes>0)");
			}
			return { meta, entries: [] };
		}

		const seqs = expectedJournalSeqs(meta);
		const manifestKeys = seqs.map((seq) => journalManifestKey(seq));
		const manifestMap = await getManyBatched<unknown>(this.storage, manifestKeys, this.maxKeysPerOperation);
		if (manifestMap.size !== manifestKeys.length) {
			throw new Error(
				`journal load failed: expected ${manifestKeys.length} manifests, found ${manifestMap.size}`,
			);
		}

		const entries: Uint8Array[] = [];
		let totalBytes = 0;
		for (const seq of seqs) {
			const key = journalManifestKey(seq);
			const rawManifest = manifestMap.get(key);
			if (!isJournalEntryManifest(rawManifest) || rawManifest.seq !== seq) {
				throw new Error(`journal load failed: invalid manifest for seq ${seq}`);
			}
			const entry = await readChunkedPayload(
				this.storage,
				rawManifest,
				(i) => journalChunkKey(seq, i),
				`journal entry ${seq}`,
				this.maxKeysPerOperation,
			);
			totalBytes += entry.byteLength;
			entries.push(entry);
		}

		if (totalBytes !== meta.totalBytes) {
			throw new Error(
				`journal load failed: metadata totalBytes mismatch (expected ${meta.totalBytes}, got ${totalBytes})`,
			);
		}

		return { meta, entries };
	}

	private async readJournalMeta(source: StorageLike | TransactionLike): Promise<JournalMeta> {
		const raw = await source.get<unknown>(JOURNAL_META_KEY);
		if (raw === undefined) {
			return emptyJournalMeta();
		}
		if (!isJournalMeta(raw)) {
			throw new Error("journal metadata is invalid");
		}
		return raw;
	}
}
