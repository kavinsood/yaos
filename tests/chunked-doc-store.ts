import { ChunkedDocStore } from "../server/src/chunkedDocStore";
import * as Y from "yjs";

class FakeStorage {
	readonly data = new Map<string, unknown>();
	maxGetBatch = 0;
	maxPutBatch = 0;
	maxDeleteBatch = 0;
	maxPutBytes = 0;

	constructor(
		private readonly maxSerializedValueBytes = Infinity,
		private readonly serializeFullBackingBuffer = false,
	) {}

	private trackGetBatch(n: number) {
		this.maxGetBatch = Math.max(this.maxGetBatch, n);
		if (n > 128) throw new Error(`get batch too large: ${n}`);
	}

	private trackPutBatch(n: number) {
		this.maxPutBatch = Math.max(this.maxPutBatch, n);
		if (n > 128) throw new Error(`put batch too large: ${n}`);
	}

	private trackDeleteBatch(n: number) {
		this.maxDeleteBatch = Math.max(this.maxDeleteBatch, n);
		if (n > 128) throw new Error(`delete batch too large: ${n}`);
	}

	private serializedValueBytes(value: unknown): number {
		if (value instanceof Uint8Array) {
			return this.serializeFullBackingBuffer
				? value.buffer.byteLength
				: value.byteLength;
		}
		return new TextEncoder().encode(JSON.stringify(value)).byteLength;
	}

	async get<T = unknown>(key: string): Promise<T | undefined>;
	async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
		if (Array.isArray(keyOrKeys)) {
			this.trackGetBatch(keyOrKeys.length);
			const out = new Map<string, T>();
			for (const key of keyOrKeys) {
				if (this.data.has(key)) out.set(key, this.data.get(key) as T);
			}
			return out;
		}
		return this.data.get(keyOrKeys) as T | undefined;
	}

	async put<T>(entries: Record<string, T>): Promise<void> {
		const keys = Object.keys(entries);
		this.trackPutBatch(keys.length);
		let bytes = 0;
		for (const key of keys) {
			const value = entries[key];
			const serializedBytes = this.serializedValueBytes(value);
			if (serializedBytes > this.maxSerializedValueBytes) {
				throw new Error(`SQLITE_TOOBIG: ${key} ${serializedBytes} > ${this.maxSerializedValueBytes}`);
			}
			if (value instanceof Uint8Array) {
				bytes += value.byteLength;
			}
			this.data.set(key, value);
		}
		this.maxPutBytes = Math.max(this.maxPutBytes, bytes);
	}

	async delete(keys: string[]): Promise<number> {
		this.trackDeleteBatch(keys.length);
		let deleted = 0;
		for (const key of keys) {
			if (this.data.delete(key)) deleted++;
		}
		return deleted;
	}

	async transaction<T>(closure: (txn: FakeTransaction) => Promise<T>): Promise<T> {
		const txn = new FakeTransaction(this);
		return await closure(txn);
	}
}

class FakeTransaction {
	constructor(private readonly storage: FakeStorage) {}

	async get<T = unknown>(key: string): Promise<T | undefined>;
	async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
		if (Array.isArray(keyOrKeys)) {
			return await this.storage.get<T>(keyOrKeys);
		}
		return await this.storage.get<T>(keyOrKeys);
	}

	async put<T>(entries: Record<string, T>): Promise<void> {
		await this.storage.put(entries);
	}

	async delete(keys: string[]): Promise<number> {
		return await this.storage.delete(keys);
	}
}

function makeBytes(size: number): Uint8Array {
	const out = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		out[i] = i % 251;
	}
	return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function docsEqual(a: Y.Doc, b: Y.Doc): boolean {
	const ua = Y.encodeStateAsUpdate(a);
	const ub = Y.encodeStateAsUpdate(b);
	return equalBytes(ua, ub);
}

function assertChunkBackingBuffersBounded(
	storage: FakeStorage,
	prefix: string,
	maxChunkBytes: number,
	msg: string,
): void {
	const chunks = Array.from(storage.data.entries())
		.filter(([key]) => key.startsWith(prefix));
	let failure: string | null = chunks.length === 0 ? "no chunks found" : null;
	for (const [key, value] of chunks) {
		if (!(value instanceof Uint8Array)) {
			failure = `${key} is not Uint8Array`;
			break;
		}
		if (value.byteLength > maxChunkBytes) {
			failure = `${key} byteLength ${value.byteLength} exceeds ${maxChunkBytes}`;
			break;
		}
		if (value.byteOffset !== 0) {
			failure = `${key} byteOffset ${value.byteOffset} is non-zero`;
			break;
		}
		if (value.buffer.byteLength !== value.byteLength) {
			failure = `${key} backing buffer ${value.buffer.byteLength} differs from chunk ${value.byteLength}`;
			break;
		}
	}
	assert(failure === null, failure ? `${msg}: ${failure}` : msg);
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

async function expectThrows(
	fn: () => Promise<unknown>,
	pattern: RegExp,
	msg: string,
) {
	try {
		await fn();
		assert(false, msg);
	} catch (err) {
		assert(pattern.test(String(err)), msg);
	}
}

function expectThrowsSync(
	fn: () => unknown,
	pattern: RegExp,
	msg: string,
) {
	try {
		fn();
		assert(false, msg);
	} catch (err) {
		assert(pattern.test(String(err)), msg);
	}
}

async function writeSubarrayStyleChunks(
	storage: FakeStorage,
	bytes: Uint8Array,
	chunkSizeBytes: number,
): Promise<void> {
	for (let i = 0; i * chunkSizeBytes < bytes.byteLength; i++) {
		const start = i * chunkSizeBytes;
		const end = Math.min(start + chunkSizeBytes, bytes.byteLength);
		await storage.put({
			[`old-style-chunk:${i}`]: bytes.subarray(start, end),
		});
	}
}

console.log("\n--- Test 1: load returns null when no chunked state exists ---");
{
	const storage = new FakeStorage();
	const store = new ChunkedDocStore(storage as unknown as DurableObjectStorage);
	const loaded = await store.loadState();

	assert(loaded.checkpoint === null, "empty store has no checkpoint");
	assert(loaded.checkpointStateVector === null, "empty store has no checkpoint state vector");
	assert(loaded.journalUpdates.length === 0, "empty store has no journal updates");
	assert(loaded.journalStats.entryCount === 0, "empty store journal entry count is zero");
}

console.log("\n--- Test 2: checkpoint save/load works beyond 128 chunk keys ---");
{
	const storage = new FakeStorage();
	const store = new ChunkedDocStore(
		storage as unknown as DurableObjectStorage,
		{
			chunkSizeBytes: 64, // tiny chunk size to force >128 chunks in test
			maxKeysPerOperation: 128,
		},
	);

	const payload = makeBytes(64 * 140 + 17); // 141 chunks
	await store.saveLatest(payload);
	const loaded = await store.loadLatest();
	const state = await store.loadState();

	assert(loaded !== null, "chunked payload loads");
	assert(loaded !== null && equalBytes(loaded, payload), "chunked payload round-trips exactly");
	assert(state.journalStats.entryCount === 0, "checkpoint save resets journal");
	assertChunkBackingBuffersBounded(
		storage,
		"document:checkpoint:chunk:",
		64,
		"checkpoint chunks use bounded backing buffers",
	);
	assert(storage.maxPutBatch <= 128, `put batching capped at 128 (got ${storage.maxPutBatch})`);
	assert(storage.maxGetBatch <= 128, `get batching capped at 128 (got ${storage.maxGetBatch})`);
	assert(storage.maxDeleteBatch <= 128, `delete batching capped at 128 (got ${storage.maxDeleteBatch})`);
}

console.log("\n--- Test 3: checkpoint chunk writes respect byte budget ---");
{
	const storage = new FakeStorage();
	const store = new ChunkedDocStore(
		storage as unknown as DurableObjectStorage,
		{ chunkSizeBytes: 1024 * 1024 },
	);

	await store.rewriteCheckpoint(makeBytes(10 * 1024 * 1024), new Uint8Array([1]));

	assert(
		storage.maxPutBytes <= 4 * 1024 * 1024,
		`chunk put byte budget capped at 4 MiB (got ${storage.maxPutBytes})`,
	);
	assertChunkBackingBuffersBounded(
		storage,
		"document:checkpoint:chunk:",
		1024 * 1024,
		"large checkpoint chunks use bounded backing buffers",
	);
}

console.log("\n--- Test 4: old subarray chunks reproduce backing-buffer SQLITE_TOOBIG ---");
{
	const storage = new FakeStorage(2 * 1024 * 1024, true);
	const payload = makeBytes(3 * 1024 * 1024);

	await expectThrows(
		() => writeSubarrayStyleChunks(storage, payload, 512 * 1024),
		/SQLITE_TOOBIG/,
		"subarray chunks can serialize as the full backing buffer",
	);
}

console.log("\n--- Test 5: copied chunks avoid backing-buffer SQLITE_TOOBIG ---");
{
	const storage = new FakeStorage(2 * 1024 * 1024, true);
	const store = new ChunkedDocStore(
		storage as unknown as DurableObjectStorage,
		{ chunkSizeBytes: 512 * 1024 },
	);

	await store.rewriteCheckpoint(makeBytes(3 * 1024 * 1024), new Uint8Array([1]));

	assert(
		storage.maxPutBytes <= 4 * 1024 * 1024,
		`copied chunk put byte budget capped at 4 MiB (got ${storage.maxPutBytes})`,
	);
	assertChunkBackingBuffersBounded(
		storage,
		"document:checkpoint:chunk:",
		512 * 1024,
		"copied checkpoint chunks serialize below value limit",
	);
}

console.log("\n--- Test 6: large checkpoint state vector uses chunked storage ---");
{
	const storage = new FakeStorage(2 * 1024 * 1024, true);
	const store = new ChunkedDocStore(
		storage as unknown as DurableObjectStorage,
		{ chunkSizeBytes: 512 * 1024 },
	);
	const stateVector = makeBytes(3 * 1024 * 1024);

	await expectThrows(
		() => storage.put({ directStateVector: stateVector }),
		/SQLITE_TOOBIG/,
		"fake storage rejects direct large state vector",
	);
	await store.rewriteCheckpoint(makeBytes(1024), stateVector);

	const loaded = await store.loadState();
	assert(
		loaded.checkpointStateVector !== null
			&& equalBytes(loaded.checkpointStateVector, stateVector),
		"chunked state vector round-trips exactly",
	);
	assert(
		[...storage.data.keys()].some((key) => key.startsWith("document:checkpoint:state-vector-descriptor:")),
		"chunked state vector descriptor is stored",
	);
	assertChunkBackingBuffersBounded(
		storage,
		"document:checkpoint:state-vector-chunk:",
		512 * 1024,
		"large state vector chunks use bounded backing buffers",
	);
}

console.log("\n--- Test 7: invalid chunking options fail fast ---");
{
	const storage = new FakeStorage();
	expectThrowsSync(
		() => new ChunkedDocStore(
			storage as unknown as DurableObjectStorage,
			{ chunkSizeBytes: 0 },
		),
		/positive integer/,
		"chunkSizeBytes must be positive",
	);
	expectThrowsSync(
		() => new ChunkedDocStore(
			storage as unknown as DurableObjectStorage,
			{ maxKeysPerOperation: 0 },
		),
		/positive integer/,
		"maxKeysPerOperation must be positive",
	);
}

console.log("\n--- Test 8: append journal update replays with checkpoint ---");
{
	const storage = new FakeStorage();
	const store = new ChunkedDocStore(
		storage as unknown as DurableObjectStorage,
		{ chunkSizeBytes: 64 },
	);
	const base = new Y.Doc();
	base.getText("t").insert(0, "hello");
	await store.rewriteCheckpoint(
		Y.encodeStateAsUpdate(base),
		Y.encodeStateVector(base),
	);

	const live = new Y.Doc();
	Y.applyUpdate(live, Y.encodeStateAsUpdate(base));
	const baseline = Y.encodeStateVector(live);
	live.getText("t").insert(5, " world".repeat(20));
	const delta = Y.encodeStateAsUpdate(live, baseline);
	const stats = await store.appendUpdate(delta);
	assert(stats.entryCount === 1, "appendUpdate increments journal entry count");
	assert(stats.totalBytes > 0, "appendUpdate tracks journal bytes");
	assertChunkBackingBuffersBounded(
		storage,
		"document:journal:chunk:",
		64,
		"journal chunks use bounded backing buffers",
	);

	const loaded = await store.loadState();
	const restored = new Y.Doc();
	if (loaded.checkpoint) Y.applyUpdate(restored, loaded.checkpoint);
	for (const update of loaded.journalUpdates) Y.applyUpdate(restored, update);
	assert(docsEqual(restored, live), "checkpoint + journal replay reconstructs latest state");
}

console.log("\n--- Test 9: rewriteCheckpoint clears journal and stores state vector ---");
{
	const storage = new FakeStorage();
	const store = new ChunkedDocStore(
		storage as unknown as DurableObjectStorage,
		{ chunkSizeBytes: 64 },
	);

	const doc = new Y.Doc();
	doc.getText("t").insert(0, "a");
	await store.rewriteCheckpoint(
		Y.encodeStateAsUpdate(doc),
		Y.encodeStateVector(doc),
	);

	for (let i = 0; i < 60; i++) {
		const base = Y.encodeStateVector(doc);
		doc.getText("t").insert(doc.getText("t").length, String(i % 10));
		const delta = Y.encodeStateAsUpdate(doc, base);
		await store.appendUpdate(delta);
	}

	await store.rewriteCheckpoint(
		Y.encodeStateAsUpdate(doc),
		Y.encodeStateVector(doc),
	);
	const loaded = await store.loadState();
	assert(loaded.journalStats.entryCount === 0, "rewriteCheckpoint clears journal entry count");
	assert(loaded.journalUpdates.length === 0, "rewriteCheckpoint clears journal payloads");
	assert(
		loaded.checkpointStateVector !== null
			&& equalBytes(loaded.checkpointStateVector, Y.encodeStateVector(doc)),
		"rewriteCheckpoint stores checkpoint state vector",
	);
	assert(storage.maxDeleteBatch <= 128, `journal cleanup delete batching capped at 128 (got ${storage.maxDeleteBatch})`);
}

console.log("\n--- Test 10: fail closed when a checkpoint chunk is missing ---");
{
	const storage = new FakeStorage();
	const store = new ChunkedDocStore(
		storage as unknown as DurableObjectStorage,
		{ chunkSizeBytes: 64 },
	);

	await store.saveLatest(makeBytes(64 * 4 + 9));
	const chunkKey = [...storage.data.keys()].find((key) => key.startsWith("document:checkpoint:chunk:"));
	if (!chunkKey) {
		throw new Error("test setup failed: no chunk key found");
	}
	storage.data.delete(chunkKey);

	await expectThrows(
		() => store.loadState(),
		/checkpoint .*expected .* chunks|checkpoint .*missing chunk/i,
		"load rejects partial checkpoint chunk set",
	);
}

console.log("\n--- Test 11: fail closed when journal chunk bytes are tampered ---");
{
	const storage = new FakeStorage();
	const store = new ChunkedDocStore(
		storage as unknown as DurableObjectStorage,
		{ chunkSizeBytes: 64 },
	);

	const base = new Y.Doc();
	base.getText("t").insert(0, "alpha");
	await store.rewriteCheckpoint(
		Y.encodeStateAsUpdate(base),
		Y.encodeStateVector(base),
	);
	const live = new Y.Doc();
	Y.applyUpdate(live, Y.encodeStateAsUpdate(base));
	const baseline = Y.encodeStateVector(live);
	live.getText("t").insert(5, " beta gamma delta epsilon");
	await store.appendUpdate(Y.encodeStateAsUpdate(live, baseline));

	const chunkKey = [...storage.data.keys()].find((key) => key.startsWith("document:journal:chunk:"));
	if (!chunkKey) {
		throw new Error("test setup failed: no journal chunk key found");
	}
	const chunk = storage.data.get(chunkKey);
	if (!(chunk instanceof Uint8Array)) {
		throw new Error("test setup failed: chunk is not Uint8Array");
	}
	const tampered = chunk.slice();
	tampered[0] ^= 0xff;
	storage.data.set(chunkKey, tampered);

	await expectThrows(
		() => store.loadState(),
		/journal entry .*sha256 mismatch/i,
		"load rejects tampered journal chunk bytes",
	);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
