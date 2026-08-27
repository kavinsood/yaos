import type { DocStoreCoalesceResult, DocStoreJournalStats } from "../../server/src/persistenceCoordinator";
import type { LoadedDocState } from "../../server/src/sqlDocStore";
import { ROOM_META_KEY } from "../../server/src/roomMeta";
import { VaultSyncServer } from "../../server/src/server";
import { suite } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { FakeR2Bucket, makeEnv } from "../mocks/workerEnv.ts";

const s = suite("server-destroy-fence");

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
	return {
		promise,
		resolve() {
			if (!resolvePromise) throw new Error("deferred resolver unavailable");
			resolvePromise();
		},
	};
}

class ControlledDocStore {
	readonly rows: Uint8Array[] = [];
	private appendGate: { started: Deferred; release: Deferred } | null = null;

	armAppend(): { started: Promise<void>; release(): void } {
		const started = deferred();
		const release = deferred();
		this.appendGate = { started, release };
		return { started: started.promise, release: () => release.resolve() };
	}

	loadState(): LoadedDocState {
		return {
			snapshot: null,
			journalUpdates: this.rows.map((row) => row.slice()),
			journalStats: this.getJournalStats(),
		};
	}

	async appendUpdate(update: Uint8Array): Promise<DocStoreJournalStats> {
		const gate = this.appendGate;
		if (gate) {
			this.appendGate = null;
			gate.started.resolve();
			await gate.release.promise;
		}
		this.rows.push(update.slice());
		return this.getJournalStats();
	}

	rewriteCheckpoint(update: Uint8Array): void {
		this.rows.length = 0;
		this.rows.push(update.slice());
	}

	getJournalStats(): DocStoreJournalStats {
		return {
			entryCount: this.rows.length,
			totalBytes: this.rows.reduce((total, row) => total + row.byteLength, 0),
		};
	}

	coalesceJournal(): DocStoreCoalesceResult {
		return { status: "noop", stats: this.getJournalStats() };
	}

	getSnapshotBytes(): number {
		return 0;
	}

	clear(): void {
		this.rows.length = 0;
	}
}

class ControlledStorage implements Pick<DurableObjectStorage, "get" | "list" | "put" | "delete" | "deleteAll"> {
	readonly values = new Map<string, unknown>();
	deleteAllCalls = 0;
	private roomMetaGate: { started: Deferred; release: Deferred } | null = null;

	constructor(private readonly docStore: ControlledDocStore) {}

	armRoomMetaPut(): { started: Promise<void>; release(): void } {
		const started = deferred();
		const release = deferred();
		this.roomMetaGate = { started, release };
		return { started: started.promise, release: () => release.resolve() };
	}

	get<T = unknown>(key: string, _options?: DurableObjectGetOptions): Promise<T | undefined>;
	get<T = unknown>(keys: string[], _options?: DurableObjectGetOptions): Promise<Map<string, T>>;
	async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
		if (typeof keyOrKeys === "string") return this.values.get(keyOrKeys) as T | undefined;
		const result = new Map<string, T>();
		for (const key of keyOrKeys) {
			if (this.values.has(key)) result.set(key, this.values.get(key) as T);
		}
		return result;
	}

	async list<T = unknown>(options?: DurableObjectListOptions): Promise<Map<string, T>> {
		const result = new Map<string, T>();
		for (const [key, value] of this.values) {
			if (options?.prefix && !key.startsWith(options.prefix)) continue;
			result.set(key, value as T);
		}
		return result;
	}

	put<T>(key: string, value: T, _options?: DurableObjectPutOptions): Promise<void>;
	put<T>(entries: Record<string, T>, _options?: DurableObjectPutOptions): Promise<void>;
	async put<T>(keyOrEntries: string | Record<string, T>, valueOrOptions?: T | DurableObjectPutOptions): Promise<void> {
		if (typeof keyOrEntries !== "string") {
			for (const [key, value] of Object.entries(keyOrEntries)) this.values.set(key, value);
			return;
		}
		if (keyOrEntries === ROOM_META_KEY && this.roomMetaGate) {
			const gate = this.roomMetaGate;
			this.roomMetaGate = null;
			gate.started.resolve();
			await gate.release.promise;
		}
		this.values.set(keyOrEntries, valueOrOptions);
	}

	delete(key: string, _options?: DurableObjectPutOptions): Promise<boolean>;
	delete(keys: string[], _options?: DurableObjectPutOptions): Promise<number>;
	async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
		if (typeof keyOrKeys === "string") return this.values.delete(keyOrKeys);
		let removed = 0;
		for (const key of keyOrKeys) if (this.values.delete(key)) removed++;
		return removed;
	}

	async deleteAll(): Promise<void> {
		this.deleteAllCalls++;
		this.values.clear();
		this.docStore.clear();
	}
}

type R2PutValue = Parameters<R2Bucket["put"]>[1];

class ControlledR2Bucket implements R2Bucket {
	private readonly base = new FakeR2Bucket();
	private putGate: { started: Deferred; release: Deferred } | null = null;

	get objects(): Map<string, Uint8Array> { return this.base.objects; }
	get puts(): Array<{ key: string; bytes: Uint8Array }> { return this.base.puts; }

	armPut(): { started: Promise<void>; release(): void } {
		const started = deferred();
		const release = deferred();
		this.putGate = { started, release };
		return { started: started.promise, release: () => release.resolve() };
	}

	head(key: string): Promise<R2Object | null> { return this.base.head(key); }
	get(key: string, options: R2GetOptions & { onlyIf: R2Conditional | Headers }): Promise<R2ObjectBody | R2Object | null>;
	get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
	get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null> {
		return this.base.get(key, options ?? {});
	}
	put(key: string, value: R2PutValue, options?: R2PutOptions & { onlyIf: R2Conditional | Headers }): Promise<R2Object | null>;
	put(key: string, value: R2PutValue, options?: R2PutOptions): Promise<R2Object>;
	async put(key: string, value: R2PutValue, options?: R2PutOptions): Promise<R2Object | null> {
		const gate = this.putGate;
		if (gate) {
			this.putGate = null;
			gate.started.resolve();
			await gate.release.promise;
		}
		return await this.base.put(key, value, options);
	}
	delete(keys: string | string[]): Promise<void> { return this.base.delete(keys); }
	list(options?: R2ListOptions): Promise<R2Objects> { return this.base.list(options); }
	createMultipartUpload(): never { throw new Error("multipart upload not expected"); }
	resumeMultipartUpload(): never { throw new Error("multipart upload not expected"); }
}

function makeServer(bucket?: R2Bucket): {
	server: VaultSyncServer;
	storage: ControlledStorage;
	store: ControlledDocStore;
} {
	const store = new ControlledDocStore();
	const storage = new ControlledStorage(store);
	const server = new VaultSyncServer(
		partialOf<DurableObjectState>({ storage: partialOf<DurableObjectStorage>(storage) }),
		makeEnv(bucket ? { YAOS_BUCKET: bucket } : {}),
	);
	Object.defineProperty(server, "sqlDocStore", { configurable: true, value: store });
	return { server, storage, store };
}

function roomRequest(path: string): Request {
	return new Request(`https://internal${path}`, {
		method: "POST",
		headers: { "x-partykit-room": "destroy-fence-vault", "content-type": "application/json" },
		body: path.endsWith("snapshot-maybe") ? "{}" : undefined,
	});
}

function callRoomMetaSync(server: VaultSyncServer): Promise<unknown> {
	const method: unknown = Reflect.get(server, "syncRoomMetaFromDocument");
	if (typeof method !== "function") throw new Error("room-meta sync method unavailable");
	const result: unknown = Reflect.apply(method, server, []);
	if (!(result instanceof Promise)) throw new Error("room-meta sync did not return a promise");
	return result;
}

s.section("destroy drains a cold load blocked in room-meta persistence before deleting storage");
{
	const { server, storage, store } = makeServer();
	const roomMeta = storage.armRoomMetaPut();
	const load = server.onLoad().then(
		() => "loaded",
		(error: unknown) => error instanceof Error ? error.message : String(error),
	);
	await roomMeta.started;

	const destroy = server.fetch(roomRequest("/__yaos/delete-all"));
	s.check(storage.deleteAllCalls === 0, "delete-all waits for the in-flight load and room-meta write");

	roomMeta.release();
	const [loadResult, response] = await Promise.all([load, destroy]);
	s.check(loadResult.includes("vault destroyed"), "load rechecks the terminal fence after room-meta await");
	s.check(response.status === 200, "destroy remains an internal successful endpoint");
	s.check(storage.values.size === 0 && store.rows.length === 0, "storage is empty when delete-all returns");

	await server.onSave();
	const repeated = await server.fetch(roomRequest("/__yaos/delete-all"));
	s.check(repeated.status === 200 && storage.deleteAllCalls === 1, "destroy is terminal and idempotent");
	server.document.destroy();
}

s.section("destroy drains save, room-meta, and serialized R2 snapshot work before deletion returns");
{
	const bucket = new ControlledR2Bucket();
	const { server, storage, store } = makeServer(bucket);
	await server.onLoad();
	server.document.getText("note").insert(0, "must not resurrect");
	server.document.getMap("sys").set("schemaVersion", 7);

	const saveGate = store.armAppend();
	const metaGate = storage.armRoomMetaPut();
	const snapshotGate = bucket.armPut();
	const save = server.onSave();
	const meta = callRoomMetaSync(server);
	const snapshot = server.fetch(roomRequest("/__yaos/snapshot-maybe"));
	await Promise.all([saveGate.started, metaGate.started, snapshotGate.started]);

	const destroy = server.fetch(roomRequest("/__yaos/delete-all"));
	s.check(storage.deleteAllCalls === 0, "delete-all is fenced behind every active writer");

	saveGate.release();
	metaGate.release();
	snapshotGate.release();
	const response = await destroy;
	s.check(response.status === 200, "concurrent destroy succeeds after draining writers");

	const prefixKeys = [...bucket.objects.keys()].filter((key) => key.startsWith("v1/destroy-fence-vault/"));
	await bucket.delete(prefixKeys);
	const putsAfterOperatorDelete = bucket.puts.length;
	await Promise.allSettled([save, meta, snapshot]);
	s.check(store.rows.length === 0, "SQLite data written by the old save is deleted last");
	s.check(!storage.values.has(ROOM_META_KEY), "room metadata written by the old operation is deleted last");
	s.check(bucket.objects.size === 0, "operator prefix deletion leaves no R2 snapshot objects");

	await server.onSave();
	const postDestroySnapshot = server.fetch(roomRequest("/__yaos/snapshot-maybe"));
	await postDestroySnapshot.then(
		() => s.check(false, "post-destroy snapshot unexpectedly succeeded"),
		() => s.check(true, "post-destroy snapshot is fenced"),
	);
	s.check(store.rows.length === 0, "post-destroy save cannot recreate SQLite data");
	s.check(!storage.values.has(ROOM_META_KEY), "post-destroy work cannot recreate room metadata");
	s.check(bucket.puts.length === putsAfterOperatorDelete && bucket.objects.size === 0, "post-destroy work cannot recreate R2 data");
	server.document.destroy();
}

await s.done();
