import * as Y from "yjs";
import { sha256Hex } from "./hex";

const CHECKPOINT_FORMAT = "yaos-doc-checkpoint-v2";
const JOURNAL_META_FORMAT = "yaos-doc-journal-v1";
const JOURNAL_ENTRY_FORMAT = "yaos-doc-journal-entry-v1";

const CHECKPOINT_POINTER_KEY = "document:checkpoint:current";
const CHECKPOINT_MANIFEST_PREFIX = "document:checkpoint:manifest:";
const CHECKPOINT_CHUNK_PREFIX = "document:checkpoint:chunk:";
const CHECKPOINT_STATE_VECTOR_PREFIX = "document:checkpoint:state-vector:";
const CHECKPOINT_STATE_VECTOR_DESCRIPTOR_PREFIX = "document:checkpoint:state-vector-descriptor:";
const CHECKPOINT_STATE_VECTOR_CHUNK_PREFIX = "document:checkpoint:state-vector-chunk:";

const JOURNAL_META_KEY = "document:journal:meta";
const JOURNAL_MANIFEST_PREFIX = "document:journal:manifest:";
const JOURNAL_CHUNK_PREFIX = "document:journal:chunk:";

const DEFAULT_CHUNK_SIZE_BYTES = 512 * 1024;
const DEFAULT_MAX_KEYS_PER_OPERATION = 128;
const MAX_CHUNK_BYTES_PER_PUT = 4 * 1024 * 1024;
const DIRECT_STATE_VECTOR_MAX_BYTES = 1024 * 1024;

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
	stateVectorStorage?: "direct" | "chunked";
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

interface StateVectorDescriptor extends ChunkDescriptor {
	format: "yaos-doc-state-vector-v1";
	version: number;
	updatedAt: string;
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

export interface ChunkWriteStats {
	chunkCount: number;
	maxChunkBytes: number;
	maxBackingBufferBytes: number;
	maxPutBytes: number;
	putCount: number;
}

export interface CheckpointCompactionResult {
	stateVector: Uint8Array;
	journalStats: JournalStats;
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

function checkpointStateVectorDescriptorKey(version: number): string {
	return `${CHECKPOINT_STATE_VECTOR_DESCRIPTOR_PREFIX}${version}`;
}

function checkpointStateVectorChunkKey(version: number, index: number): string {
	return `${CHECKPOINT_STATE_VECTOR_CHUNK_PREFIX}${version}:${index}`;
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
	if (
		m.stateVectorStorage !== undefined
		&& m.stateVectorStorage !== "direct"
		&& m.stateVectorStorage !== "chunked"
	) return false;
	if (typeof m.updatedAt !== "string" || m.updatedAt.length === 0) return false;
	return true;
}

function isStateVectorDescriptor(value: unknown): value is StateVectorDescriptor {
	if (typeof value !== "object" || value === null) return false;
	const d = value as StateVectorDescriptor;
	if (d.format !== "yaos-doc-state-vector-v1") return false;
	if (!Number.isInteger(d.version) || d.version <= 0) return false;
	if (!Number.isInteger(d.chunkSizeBytes) || d.chunkSizeBytes <= 0) return false;
	if (!Number.isInteger(d.chunkCount) || d.chunkCount < 0) return false;
	if (!Number.isInteger(d.byteLength) || d.byteLength < 0) return false;
	if (typeof d.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(d.sha256)) return false;
	if (typeof d.updatedAt !== "string" || d.updatedAt.length === 0) return false;
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

function copyChunk(bytes: Uint8Array, start: number, end: number): Uint8Array {
	const chunk = new Uint8Array(end - start);
	chunk.set(bytes.subarray(start, end));
	return chunk;
}

async function putChunkedPayloadBatched(
	target: StorageLike | TransactionLike,
	bytes: Uint8Array,
	chunkSizeBytes: number,
	chunkKeyForIndex: (index: number) => string,
	maxKeysPerOperation: number,
): Promise<ChunkWriteStats> {
	const chunkCount = bytes.byteLength === 0
		? 0
		: Math.ceil(bytes.byteLength / chunkSizeBytes);
	const stats: ChunkWriteStats = {
		chunkCount,
		maxChunkBytes: 0,
		maxBackingBufferBytes: 0,
		maxPutBytes: 0,
		putCount: 0,
	};

	if (chunkCount === 0) return stats;

	let chunkStart = 0;
	while (chunkStart < chunkCount) {
		const record: Record<string, Uint8Array> = {};
		let recordBytes = 0;
		let recordKeys = 0;
		while (chunkStart < chunkCount && recordKeys < maxKeysPerOperation) {
			const i = chunkStart;
			const start = i * chunkSizeBytes;
			const end = Math.min(start + chunkSizeBytes, bytes.byteLength);
			const chunkBytes = end - start;
			if (recordKeys > 0 && recordBytes + chunkBytes > MAX_CHUNK_BYTES_PER_PUT) {
				break;
			}
			// Storage serialization must never retain the full backing buffer
			// of a large update.
			const chunk = copyChunk(bytes, start, end);
			record[chunkKeyForIndex(i)] = chunk;
			stats.maxChunkBytes = Math.max(stats.maxChunkBytes, chunk.byteLength);
			stats.maxBackingBufferBytes = Math.max(
				stats.maxBackingBufferBytes,
				chunk.buffer.byteLength,
			);
			recordBytes += chunkBytes;
			recordKeys++;
			chunkStart++;
		}
		stats.maxPutBytes = Math.max(stats.maxPutBytes, recordBytes);
		stats.putCount++;
		await target.put(record);
	}

	return stats;
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

function emptyChunkWriteStats(): ChunkWriteStats {
	return {
		chunkCount: 0,
		maxChunkBytes: 0,
		maxBackingBufferBytes: 0,
		maxPutBytes: 0,
		putCount: 0,
	};
}

function combineChunkWriteStats(...items: ChunkWriteStats[]): ChunkWriteStats {
	const out = emptyChunkWriteStats();
	for (const item of items) {
		out.chunkCount += item.chunkCount;
		out.maxChunkBytes = Math.max(out.maxChunkBytes, item.maxChunkBytes);
		out.maxBackingBufferBytes = Math.max(
			out.maxBackingBufferBytes,
			item.maxBackingBufferBytes,
		);
		out.maxPutBytes = Math.max(out.maxPutBytes, item.maxPutBytes);
		out.putCount += item.putCount;
	}
	return out;
}

function assertPositiveInteger(value: number, label: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
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
	private lastWriteStats: ChunkWriteStats | null = null;

	constructor(
		private readonly storage: StorageLike,
		options: ChunkedDocStoreOptions = {},
	) {
		this.chunkSizeBytes = assertPositiveInteger(
			options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES,
			"chunkSizeBytes",
		);
		this.maxKeysPerOperation = assertPositiveInteger(
			options.maxKeysPerOperation ?? DEFAULT_MAX_KEYS_PER_OPERATION,
			"maxKeysPerOperation",
		);
	}

	getLastWriteStats(): ChunkWriteStats | null {
		return this.lastWriteStats;
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

			const writeStats = await putChunkedPayloadBatched(
				txn,
				bytes,
				this.chunkSizeBytes,
				(i) => journalChunkKey(seq, i),
				this.maxKeysPerOperation,
			);
			this.lastWriteStats = writeStats;

			const manifest: JournalEntryManifest = {
				format: JOURNAL_ENTRY_FORMAT,
				seq,
				chunkSizeBytes: this.chunkSizeBytes,
				chunkCount: writeStats.chunkCount,
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

		await this.storage.transaction(async (txn) => {
			const cleanupKeys = new Set<string>();
			const existingPointerRaw = await txn.get<unknown>(CHECKPOINT_POINTER_KEY);
			const existingPointer = existingPointerRaw === undefined
				? null
				: isManifestPointer(existingPointerRaw)
					? existingPointerRaw
					: (() => {
						throw new Error("checkpoint pointer is invalid");
					})();

			if (existingPointer) {
				const oldManifestKey = checkpointManifestKey(existingPointer.version);
				const oldManifestRaw = await txn.get<unknown>(oldManifestKey);
				if (!isChunkedManifest(oldManifestRaw)) {
					throw new Error(`checkpoint manifest missing or invalid for version ${existingPointer.version}`);
				}
				cleanupKeys.add(oldManifestKey);
				cleanupKeys.add(checkpointStateVectorKey(existingPointer.version));
				if ((oldManifestRaw.stateVectorStorage ?? "direct") === "chunked") {
					const descriptorKey = checkpointStateVectorDescriptorKey(existingPointer.version);
					const rawDescriptor = await txn.get<unknown>(descriptorKey);
					if (!isStateVectorDescriptor(rawDescriptor)) {
						throw new Error(
							`checkpoint state vector descriptor missing or invalid for version ${existingPointer.version}`,
						);
					}
					cleanupKeys.add(descriptorKey);
					for (let i = 0; i < rawDescriptor.chunkCount; i++) {
						cleanupKeys.add(checkpointStateVectorChunkKey(existingPointer.version, i));
					}
				}
				for (let i = 0; i < oldManifestRaw.chunkCount; i++) {
					cleanupKeys.add(checkpointChunkKey(oldManifestRaw.version, i));
				}
			}

			const journalMeta = await this.readJournalMeta(txn);
			if (journalMeta.entryCount > 0) {
				const seqs = expectedJournalSeqs(journalMeta);
				const manifestKeys = seqs.map((seq) => journalManifestKey(seq));
				const manifestMap = await getManyBatched<unknown>(txn, manifestKeys, this.maxKeysPerOperation);
				if (manifestMap.size !== manifestKeys.length) {
					throw new Error(
						`journal compact failed: expected ${manifestKeys.length} manifests, found ${manifestMap.size}`,
					);
				}
				for (const seq of seqs) {
					const key = journalManifestKey(seq);
					const manifestRaw = manifestMap.get(key);
					if (!isJournalEntryManifest(manifestRaw) || manifestRaw.seq !== seq) {
						throw new Error(`journal compact failed: invalid manifest for seq ${seq}`);
					}
					cleanupKeys.add(key);
					for (let i = 0; i < manifestRaw.chunkCount; i++) {
						cleanupKeys.add(journalChunkKey(seq, i));
					}
				}
			}

			const newVersion = existingPointer
				? existingPointer.version + 1
				: 1;
			const now = new Date().toISOString();
			const updateWriteStats = await putChunkedPayloadBatched(
				txn,
				updateBytes,
				this.chunkSizeBytes,
				(i) => checkpointChunkKey(newVersion, i),
				this.maxKeysPerOperation,
			);
			let stateVectorStorage: "direct" | "chunked" = "direct";
			let stateVectorWriteStats = emptyChunkWriteStats();

			const entries: Array<[string, unknown]> = [];
			if (stateVectorBytes.byteLength > DIRECT_STATE_VECTOR_MAX_BYTES) {
				stateVectorStorage = "chunked";
				stateVectorWriteStats = await putChunkedPayloadBatched(
					txn,
					stateVectorBytes,
					this.chunkSizeBytes,
					(i) => checkpointStateVectorChunkKey(newVersion, i),
					this.maxKeysPerOperation,
				);
				const stateVectorDescriptor: StateVectorDescriptor = {
					format: "yaos-doc-state-vector-v1",
					version: newVersion,
					chunkSizeBytes: this.chunkSizeBytes,
					chunkCount: stateVectorWriteStats.chunkCount,
					byteLength: stateVectorBytes.byteLength,
					sha256: stateVectorHash,
					updatedAt: now,
				};
				entries.push([checkpointStateVectorDescriptorKey(newVersion), stateVectorDescriptor]);
			} else {
				entries.push([
					checkpointStateVectorKey(newVersion),
					copyChunk(stateVectorBytes, 0, stateVectorBytes.byteLength),
				]);
			}
			this.lastWriteStats = combineChunkWriteStats(updateWriteStats, stateVectorWriteStats);
			const manifest: CheckpointManifest = {
				format: CHECKPOINT_FORMAT,
				version: newVersion,
				chunkSizeBytes: this.chunkSizeBytes,
				chunkCount: updateWriteStats.chunkCount,
				byteLength: updateBytes.byteLength,
				sha256: updateHash,
				stateVectorByteLength: stateVectorBytes.byteLength,
				stateVectorSha256: stateVectorHash,
				stateVectorStorage,
				updatedAt: now,
			};
			entries.push([checkpointManifestKey(newVersion), manifest]);
			entries.push([CHECKPOINT_POINTER_KEY, { version: newVersion } satisfies ManifestPointer]);
			entries.push([JOURNAL_META_KEY, emptyJournalMeta(now)]);

			await putEntriesBatched(txn, entries, this.maxKeysPerOperation);
			await deleteKeysBatched(txn, Array.from(cleanupKeys), this.maxKeysPerOperation);
		});
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

	async compactJournalToCheckpoint(): Promise<CheckpointCompactionResult> {
		const state = await this.loadState();
		const updates: Uint8Array[] = [];
		if (state.checkpoint) updates.push(state.checkpoint);
		updates.push(...state.journalUpdates);
		if (updates.length === 0) {
			const emptyDoc = new Y.Doc();
			const stateVector = Y.encodeStateVector(emptyDoc);
			emptyDoc.destroy();
			return {
				stateVector,
				journalStats: state.journalStats,
			};
		}
		const merged = updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates);
		const stateVector = Y.encodeStateVectorFromUpdate(merged);
		await this.rewriteCheckpoint(merged, stateVector);
		return {
			stateVector,
			journalStats: await this.getJournalStats(),
		};
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

		const stateVectorStorage = rawManifest.stateVectorStorage ?? "direct";
		let stateVector: Uint8Array;
		if (stateVectorStorage === "chunked") {
			const descriptorKey = checkpointStateVectorDescriptorKey(rawManifest.version);
			const rawDescriptor = await this.storage.get<unknown>(descriptorKey);
			if (!isStateVectorDescriptor(rawDescriptor)) {
				throw new Error(`checkpoint state vector descriptor missing or invalid for version ${rawManifest.version}`);
			}
			if (rawDescriptor.byteLength !== rawManifest.stateVectorByteLength) {
				throw new Error(
					`checkpoint state vector descriptor length mismatch (expected ${rawManifest.stateVectorByteLength}, got ${rawDescriptor.byteLength})`,
				);
			}
			if (rawDescriptor.sha256 !== rawManifest.stateVectorSha256) {
				throw new Error("checkpoint state vector descriptor sha256 mismatch");
			}
			stateVector = await readChunkedPayload(
				this.storage,
				rawDescriptor,
				(i) => checkpointStateVectorChunkKey(rawManifest.version, i),
				"checkpoint state vector",
				this.maxKeysPerOperation,
			);
		} else {
			const rawStateVector = await this.storage.get<unknown>(checkpointStateVectorKey(rawManifest.version));
			if (rawStateVector === undefined) {
				throw new Error(`checkpoint state vector missing for version ${rawManifest.version}`);
			}
			stateVector = normalizeBytes(rawStateVector, checkpointStateVectorKey(rawManifest.version));
		}
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
