/**
 * FU-8 — IndexedDbCandidateStore tests.
 *
 * Uses a small fake IndexedDB surface so the production store can be tested
 * under Node without adding a browser/mock dependency.
 */

import * as Y from "yjs";
import {
	IndexedDbCandidateStore,
	buildCandidateStoreKey,
	getOrCreateLocalDeviceId,
	sha256Hex,
} from "../src/sync/indexedDbCandidateStore";
import { encodeBytesBase64, MAX_SV_ECHO_BASE64_BYTES } from "../src/sync/svEchoMessage";
import type { PersistedCandidateState, ScopeKey, ScopeMetadata } from "../src/sync/candidateStore";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

const BASE_SCOPE: ScopeKey & ScopeMetadata = {
	vaultIdHash: "a".repeat(64),
	serverHostHash: "b".repeat(64),
	localDeviceId: "local-device",
	roomName: "room-1",
	docSchemaVersion: 2,
	pluginVersion: "1.6.1",
	ackStoreVersion: 1,
};

function makeState(scope = BASE_SCOPE): PersistedCandidateState {
	const doc = new Y.Doc();
	doc.getText("t").insert(0, "candidate");
	const candidateSvBase64 = encodeBytesBase64(Y.encodeStateVector(doc));
	doc.destroy();
	return {
		schema: 1,
		...scope,
		candidateSvBase64,
		candidateCapturedAt: 123,
		lastKnownServerReceiptEchoAt: 456,
	};
}

function sameState(a: PersistedCandidateState | null, b: PersistedCandidateState): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

class FakeIndexedDBFactory {
	private readonly databases = new Map<string, FakeDatabaseData>();
	failOpen = false;
	abortNextWriteTransaction = false;

	open(name: string, _version?: number): IDBOpenDBRequest {
		const req = new FakeRequest<FakeDatabase>() as unknown as IDBOpenDBRequest;
		queueMicrotask(() => {
			if (this.failOpen) {
				(req as unknown as FakeRequest<FakeDatabase>).fail(new Error("open failed"));
				return;
			}
			let data = this.databases.get(name);
			const needsUpgrade = !data;
			if (!data) {
				data = { stores: new Map(), writeQueues: new Map() };
				this.databases.set(name, data);
			}
			const db = new FakeDatabase(data, this);
			(req as unknown as { result: FakeDatabase }).result = db;
			if (needsUpgrade && req.onupgradeneeded) req.onupgradeneeded(new Event("upgradeneeded") as IDBVersionChangeEvent);
			(req as unknown as FakeRequest<FakeDatabase>).succeed(db);
		});
		return req;
	}

	putRaw(dbName: string, storeName: string, key: string, value: unknown): void {
		let data = this.databases.get(dbName);
		if (!data) {
			data = { stores: new Map(), writeQueues: new Map() };
			this.databases.set(dbName, data);
		}
		let store = data.stores.get(storeName);
		if (!store) {
			store = new Map();
			data.stores.set(storeName, store);
		}
		store.set(key, value);
	}
}

type FakeDatabaseData = {
	stores: Map<string, Map<string, unknown>>;
	writeQueues: Map<string, Promise<void>>;
};

class FakeDatabase {
	constructor(private readonly data: FakeDatabaseData, private readonly factory: FakeIndexedDBFactory) {}

	get objectStoreNames(): DOMStringList {
		return {
			contains: (name: string) => this.data.stores.has(name),
		} as DOMStringList;
	}

	createObjectStore(name: string): void {
		if (!this.data.stores.has(name)) this.data.stores.set(name, new Map());
	}

	transaction(storeName: string, mode: IDBTransactionMode): FakeTransaction {
		const store = this.data.stores.get(storeName);
		if (!store) throw new Error(`Missing object store ${storeName}`);
		const abortAfterRequestSuccess = mode === "readwrite" && this.factory.abortNextWriteTransaction;
		this.factory.abortNextWriteTransaction = false;
		const waitFor = mode === "readwrite"
			? (this.data.writeQueues.get(storeName) ?? Promise.resolve())
			: Promise.resolve();
		const tx = new FakeTransaction(storeName, store, abortAfterRequestSuccess, waitFor);
		if (mode === "readwrite") this.data.writeQueues.set(storeName, tx.done.catch(() => undefined));
		return tx;
	}
}

class FakeTransaction {
	oncomplete: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onabort: ((event: Event) => void) | null = null;
	error: Error | null = null;
	readonly done: Promise<void>;
	private resolveDone!: () => void;
	private pendingRequests = 0;
	private completed = false;

	constructor(
		private readonly storeName: string,
		private readonly store: Map<string, unknown>,
		private readonly abortAfterRequestSuccess: boolean,
		private readonly waitFor: Promise<void>,
	) {
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
	}

	objectStore(name: string): FakeObjectStore {
		if (name !== this.storeName) throw new Error(`Missing object store ${name}`);
		return new FakeObjectStore(this.store, this);
	}

	enqueue<T>(work: () => T): IDBRequest<T> {
		const req = new FakeRequest<T>();
		this.pendingRequests++;
		void this.waitFor.then(() => {
			try {
				req.succeed(work());
			} catch (err) {
				this.error = err instanceof Error ? err : new Error(String(err));
				req.fail(this.error);
				this.onerror?.(new Event("error"));
				this.onabort?.(new Event("abort"));
			} finally {
				this.pendingRequests--;
				this.maybeComplete();
			}
		});
		return req as unknown as IDBRequest<T>;
	}

	private maybeComplete(): void {
		if (this.pendingRequests !== 0 || this.completed) return;
		this.completed = true;
		queueMicrotask(() => {
			if (this.abortAfterRequestSuccess) {
				this.error = new Error("transaction aborted");
				this.onabort?.(new Event("abort"));
				this.resolveDone();
				return;
			}
			this.oncomplete?.(new Event("complete"));
			this.resolveDone();
		});
	}
}

class FakeObjectStore {
	constructor(private readonly store: Map<string, unknown>, private readonly tx: FakeTransaction) {}

	get(key: string): IDBRequest<unknown> {
		return this.tx.enqueue(() => this.store.get(key));
	}

	put(value: unknown, key: string): IDBRequest<IDBValidKey> {
		return this.tx.enqueue(() => {
			this.store.set(key, value);
			return key;
		});
	}

	delete(key: string): IDBRequest<undefined> {
		return this.tx.enqueue(() => {
			this.store.delete(key);
			return undefined;
		});
	}
}

class FakeRequest<T> {
	result!: T;
	error: Error | null = null;
	onsuccess: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;

	succeed(result: T): void {
		this.result = result;
		this.onsuccess?.(new Event("success"));
	}

	fail(error: Error): void {
		this.error = error;
		this.onerror?.(new Event("error"));
	}
}

console.log("\n--- Test 1: key shape and hash helper ---");
{
	assert(
		buildCandidateStoreKey(BASE_SCOPE) === `yaos-ack-v1:${"b".repeat(64)}:${"a".repeat(64)}:local-device`,
		"candidate key uses serverHostHash, vaultIdHash, localDeviceId",
	);
	const hash = await sha256Hex("YAOS");
	assert(/^[0-9a-f]{64}$/.test(hash), "sha256Hex returns lowercase 64-char hex");
}

console.log("\n--- Test 2: save/load survives store re-instantiation ---");
{
	const fake = new FakeIndexedDBFactory();
	const store1 = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-1");
	const state = makeState();
	await store1.save(state);

	const store2 = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-1");
	const loaded = await store2.load(BASE_SCOPE);
	assert(sameState(loaded, state), "saved state loads from a new store instance");
}

console.log("\n--- Test 3: scope mismatch fails closed ---");
{
	const fake = new FakeIndexedDBFactory();
	const store = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-2");
	await store.save(makeState());

	const wrongScope = { ...BASE_SCOPE, roomName: "room-2" };
	const loaded = await store.load(wrongScope);
	assert(loaded === null, "wrong roomName returns null");
}

console.log("\n--- Test 4: clear deletes candidate state ---");
{
	const fake = new FakeIndexedDBFactory();
	const store = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-3");
	await store.save(makeState());
	await store.clear();
	const loaded = await store.load(BASE_SCOPE);
	assert(loaded === null, "clear removes stored candidate");
}

console.log("\n--- Test 5: corrupt records fail closed ---");
{
	const fake = new FakeIndexedDBFactory();
	const key = buildCandidateStoreKey(BASE_SCOPE);

	fake.putRaw("ack-test-4", "candidateStates", key, { ...makeState(), schema: 2 });
	const schemaStore = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-4");
	assert(await schemaStore.load(BASE_SCOPE) === null, "wrong schema returns null");

	fake.putRaw("ack-test-5", "candidateStates", key, { ...makeState(), candidateSvBase64: encodeBytesBase64(new Uint8Array(0)) });
	const corruptSvStore = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-5");
	assert(await corruptSvStore.load(BASE_SCOPE) === null, "invalid candidate SV returns null");

	fake.putRaw("ack-test-5b", "candidateStates", key, { ...makeState(), ackStoreVersion: 2 });
	const versionStore = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-5b");
	assert(await versionStore.load(BASE_SCOPE) === null, "unsupported ackStoreVersion returns null");

	fake.putRaw("ack-test-5c", "candidateStates", key, { ...makeState(), candidateSvBase64: "A".repeat(MAX_SV_ECHO_BASE64_BYTES + 1) });
	const oversizedStore = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-5c");
	assert(await oversizedStore.load(BASE_SCOPE) === null, "oversized candidate SV returns null");

	fake.putRaw("ack-test-5d", "candidateStates", key, { ...makeState(), candidateCapturedAt: Number.NaN });
	const nanStore = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-5d");
	assert(await nanStore.load(BASE_SCOPE) === null, "NaN timestamp returns null");

	fake.putRaw("ack-test-5e", "candidateStates", key, { ...makeState(), candidateSvBase64: null, candidateCapturedAt: 123 });
	const nullCandidateWithCaptureStore = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-5e");
	assert(await nullCandidateWithCaptureStore.load(BASE_SCOPE) === null, "null candidate with capturedAt returns null");

	fake.putRaw("ack-test-5f", "candidateStates", key, { ...makeState(), candidateCapturedAt: null });
	const candidateWithoutCaptureStore = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-5f");
	assert(await candidateWithoutCaptureStore.load(BASE_SCOPE) === null, "candidate without capturedAt returns null");

	fake.putRaw("ack-test-5g", "candidateStates", key, { ...makeState(), candidateSvBase64: null, candidateCapturedAt: null });
	const nullCandidateWithHistoryStore = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-5g");
	assert(await nullCandidateWithHistoryStore.load(BASE_SCOPE) !== null, "null candidate with historical receipt is allowed");
}

console.log("\n--- Test 6: open failures fail closed on load and reject save ---");
{
	const fake = new FakeIndexedDBFactory();
	fake.failOpen = true;
	const store = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-6");
	assert(await store.load(BASE_SCOPE) === null, "load open failure returns null");
	try {
		await store.save(makeState());
		assert(false, "save open failure rejects");
	} catch {
		assert(true, "save open failure rejects");
	}
}

console.log("\n--- Test 7: localDeviceId is stable once created ---");
{
	const fake = new FakeIndexedDBFactory();
	let created = 0;
	const randomUuid = () => {
		created++;
		return `uuid-${created}`;
	};
	const first = await getOrCreateLocalDeviceId(fake as unknown as IDBFactory, randomUuid, "ack-test-7");
	const second = await getOrCreateLocalDeviceId(fake as unknown as IDBFactory, randomUuid, "ack-test-7");
	assert(first === "uuid-1", "first localDeviceId is generated");
	assert(second === first, "second localDeviceId reuses stored value");
	assert(created === 1, "random UUID called only once");
}

console.log("\n--- Test 8: save rejects mismatched or invalid scope ---");
{
	const fake = new FakeIndexedDBFactory();
	const store = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-8");
	try {
		await store.save(makeState({ ...BASE_SCOPE, roomName: "other-room" }));
		assert(false, "mismatched save rejects");
	} catch {
		assert(true, "mismatched save rejects");
	}
	try {
		await store.save(makeState({ ...BASE_SCOPE, vaultIdHash: "not-a-hash" }));
		assert(false, "invalid persisted state rejects");
	} catch {
		assert(true, "invalid persisted state rejects");
	}
}

console.log("\n--- Test 9: writes resolve only after transaction completion ---");
{
	const fake = new FakeIndexedDBFactory();
	const store = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-9");
	let resolved = false;
	const savePromise = store.save(makeState()).then(() => { resolved = true; });
	await Promise.resolve();
	assert(!resolved, "save not resolved at request success tick");
	await savePromise;
	assert(resolved, "save resolves after transaction completion");
}

console.log("\n--- Test 10: transaction abort after request success rejects save/delete ---");
{
	const fake = new FakeIndexedDBFactory();
	const store = new IndexedDbCandidateStore(BASE_SCOPE, fake as unknown as IDBFactory, "ack-test-10");
	fake.abortNextWriteTransaction = true;
	try {
		await store.save(makeState());
		assert(false, "save abort rejects");
	} catch {
		assert(true, "save abort rejects");
	}

	await store.save(makeState());
	fake.abortNextWriteTransaction = true;
	try {
		await store.clear();
		assert(false, "clear abort rejects");
	} catch {
		assert(true, "clear abort rejects");
	}
}

console.log("\n--- Test 11: concurrent localDeviceId creation converges ---");
{
	const fake = new FakeIndexedDBFactory();
	let created = 0;
	const randomUuid = () => {
		created++;
		return `uuid-${created}`;
	};
	const [first, second] = await Promise.all([
		getOrCreateLocalDeviceId(fake as unknown as IDBFactory, randomUuid, "ack-test-11"),
		getOrCreateLocalDeviceId(fake as unknown as IDBFactory, randomUuid, "ack-test-11"),
	]);
	assert(first === second, "concurrent callers return the same localDeviceId");
	assert(created === 1, "concurrent callers generate one UUID");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
