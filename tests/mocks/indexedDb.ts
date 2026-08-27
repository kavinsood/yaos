/**
 * Cast-free fake IndexedDB for suites that drive src/sync/indexedDbCandidateStore
 * (directly, or transitively through FlightTraceController.start()).
 *
 * The production store takes a `Pick<IDBFactory, "open">`, but `open()` hands
 * back a real `IDBOpenDBRequest`, whose `result` is a real `IDBDatabase`, whose
 * `transaction()` returns a real `IDBTransaction` — so a fake that only carries
 * the four methods the store calls has to be laundered into place with
 * `as unknown as`. Every class here instead `implements` the lib.dom interface it
 * stands in for, which is what makes the boundary castless.
 *
 * The trick that makes that affordable: members production code never reaches
 * are declared `(): never` and throw. `never` is assignable to every return type,
 * so the interface is satisfied without inventing behaviour, and a suite that
 * starts depending on one of them fails loudly at the first call instead of
 * silently observing a fiction.
 *
 * Behaviours that do matter, because suites assert on them:
 *   - `readwrite` transactions serialize per object store (`writeQueues`), which
 *     is what makes two concurrent getOrCreateLocalDeviceId() callers converge on
 *     one UUID rather than both writing.
 *   - `oncomplete` fires a microtask after the last request succeeds, so a write
 *     promise cannot resolve on the request-success tick.
 *   - `abortNextWriteTransaction` aborts *after* request success, the one shape
 *     that proves callers wait for durability and not for the request.
 *   - `failOpen` fails the open request, for the fail-closed load path.
 *   - Keys are strings only, checked rather than assumed: the fake narrows the
 *     real `IDBValidKey | IDBKeyRange` parameter and throws on anything else.
 */

/** Members the code under test never touches. Reached only by a suite that grew a new dependency. */
function unreachable(member: string): never {
	throw new Error(`FakeIndexedDb: ${member} is not implemented`);
}

/** The fake stores everything in `Map<string, unknown>`, so non-string keys are a test bug, not a silent coercion. */
function requireStringKey(query: IDBValidKey | IDBKeyRange | undefined): string {
	if (typeof query !== "string") {
		throw new TypeError(`FakeIndexedDb supports string keys only, received ${Object.prototype.toString.call(query)}`);
	}
	return query;
}

class FakeStringList implements DOMStringList {
	[index: number]: string;

	constructor(private readonly names: () => string[]) {}

	get length(): number {
		return this.names().length;
	}

	contains(value: string): boolean {
		return this.names().includes(value);
	}

	item(index: number): string | null {
		return this.names()[index] ?? null;
	}
}

/** `IDBVersionChangeEvent` has no constructor outside a browser; this is the real shape, built from the real `Event`. */
class FakeVersionChangeEvent extends Event implements IDBVersionChangeEvent {
	readonly oldVersion: number;
	readonly newVersion: number | null;

	constructor(type: string, newVersion: number | null, oldVersion = 0) {
		super(type);
		this.newVersion = newVersion;
		this.oldVersion = oldVersion;
	}
}

export class FakeRequest<T> extends EventTarget implements IDBRequest<T> {
	result!: T;
	error: DOMException | null = null;
	onsuccess: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	private settled = false;

	constructor(private readonly owningTransaction: IDBTransaction | null) {
		super();
	}

	get readyState(): IDBRequestReadyState {
		return this.settled ? "done" : "pending";
	}

	get transaction(): IDBTransaction | null {
		return this.owningTransaction;
	}

	get source(): never {
		return unreachable("IDBRequest.source");
	}

	succeed(result: T): void {
		this.settled = true;
		this.result = result;
		this.onsuccess?.(new Event("success"));
	}

	fail(error: DOMException): void {
		this.settled = true;
		this.error = error;
		this.onerror?.(new Event("error"));
	}
}

export class FakeOpenDbRequest extends FakeRequest<IDBDatabase> implements IDBOpenDBRequest {
	onblocked: ((event: IDBVersionChangeEvent) => void) | null = null;
	onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;

	constructor() {
		super(null);
	}

	/** Fires `onupgradeneeded`; callers must set `result` first, since handlers read it. */
	upgrade(newVersion: number | null): void {
		this.onupgradeneeded?.(new FakeVersionChangeEvent("upgradeneeded", newVersion));
	}
}

type FakeDatabaseData = {
	stores: Map<string, Map<string, unknown>>;
	/** Per-store tail of committed `readwrite` transactions, so writes cannot interleave. */
	writeQueues: Map<string, Promise<void>>;
};

export class FakeTransaction extends EventTarget implements IDBTransaction {
	oncomplete: ((event: Event) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onabort: ((event: Event) => void) | null = null;
	error: DOMException | null = null;
	readonly done: Promise<void>;
	private resolveDone!: () => void;
	private pendingRequests = 0;
	private completed = false;

	constructor(
		readonly db: IDBDatabase,
		private readonly storeName: string,
		private readonly store: Map<string, unknown>,
		readonly mode: IDBTransactionMode,
		private readonly abortAfterRequestSuccess: boolean,
		private readonly waitFor: Promise<void>,
	) {
		super();
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
	}

	get objectStoreNames(): DOMStringList {
		return new FakeStringList(() => [this.storeName]);
	}

	get durability(): never {
		return unreachable("IDBTransaction.durability");
	}

	abort(): never {
		return unreachable("IDBTransaction.abort");
	}

	commit(): never {
		return unreachable("IDBTransaction.commit");
	}

	objectStore(name: string): FakeObjectStore {
		if (name !== this.storeName) throw new Error(`Missing object store ${name}`);
		return new FakeObjectStore(name, this.store, this);
	}

	enqueue<T>(work: () => T): FakeRequest<T> {
		const req = new FakeRequest<T>(this);
		this.pendingRequests++;
		void this.waitFor.then(() => {
			try {
				req.succeed(work());
			} catch (err) {
				this.error = new DOMException(err instanceof Error ? err.message : String(err));
				req.fail(this.error);
				this.onerror?.(new Event("error"));
				this.onabort?.(new Event("abort"));
			} finally {
				this.pendingRequests--;
				this.maybeComplete();
			}
		});
		return req;
	}

	private maybeComplete(): void {
		if (this.pendingRequests !== 0 || this.completed) return;
		this.completed = true;
		queueMicrotask(() => {
			if (this.abortAfterRequestSuccess) {
				this.error = new DOMException("transaction aborted", "AbortError");
				this.onabort?.(new Event("abort"));
				this.resolveDone();
				return;
			}
			this.oncomplete?.(new Event("complete"));
			this.resolveDone();
		});
	}
}

export class FakeObjectStore implements IDBObjectStore {
	constructor(
		readonly name: string,
		private readonly store: Map<string, unknown>,
		readonly transaction: FakeTransaction,
	) {}

	get autoIncrement(): boolean {
		return false;
	}

	// lib.dom types keyPath as `string | string[]`, but a store created without
	// one really has null, so there is no honest value to return here.
	get keyPath(): never {
		return unreachable("IDBObjectStore.keyPath");
	}

	get indexNames(): DOMStringList {
		return new FakeStringList(() => []);
	}

	get(query: IDBValidKey | IDBKeyRange): FakeRequest<unknown> {
		const key = requireStringKey(query);
		return this.transaction.enqueue(() => this.store.get(key));
	}

	put(value: unknown, key?: IDBValidKey): FakeRequest<IDBValidKey> {
		const stringKey = requireStringKey(key);
		return this.transaction.enqueue(() => {
			this.store.set(stringKey, value);
			return stringKey;
		});
	}

	delete(query: IDBValidKey | IDBKeyRange): FakeRequest<undefined> {
		const key = requireStringKey(query);
		return this.transaction.enqueue(() => {
			this.store.delete(key);
			return undefined;
		});
	}

	add(): never {
		return unreachable("IDBObjectStore.add");
	}

	clear(): never {
		return unreachable("IDBObjectStore.clear");
	}

	count(): never {
		return unreachable("IDBObjectStore.count");
	}

	createIndex(): never {
		return unreachable("IDBObjectStore.createIndex");
	}

	deleteIndex(): never {
		return unreachable("IDBObjectStore.deleteIndex");
	}

	getAll(): never {
		return unreachable("IDBObjectStore.getAll");
	}

	getAllKeys(): never {
		return unreachable("IDBObjectStore.getAllKeys");
	}

	getKey(): never {
		return unreachable("IDBObjectStore.getKey");
	}

	index(): never {
		return unreachable("IDBObjectStore.index");
	}

	openCursor(): never {
		return unreachable("IDBObjectStore.openCursor");
	}

	openKeyCursor(): never {
		return unreachable("IDBObjectStore.openKeyCursor");
	}
}

export class FakeDatabase extends EventTarget implements IDBDatabase {
	readonly onabort = null;
	readonly onclose = null;
	readonly onerror = null;
	readonly onversionchange = null;

	constructor(
		readonly name: string,
		readonly version: number,
		private readonly data: FakeDatabaseData,
		private readonly factory: FakeIndexedDb,
	) {
		super();
	}

	get objectStoreNames(): DOMStringList {
		return new FakeStringList(() => [...this.data.stores.keys()]);
	}

	createObjectStore(name: string): FakeObjectStore {
		let store = this.data.stores.get(name);
		if (!store) {
			store = new Map();
			this.data.stores.set(name, store);
		}
		// Real createObjectStore returns the store bound to the versionchange
		// transaction. Built directly rather than through transaction() so it
		// never enters writeQueues: no caller uses it, and an unused queue entry
		// would never complete and would stall every later write to this store.
		const upgradeTx = new FakeTransaction(this, name, store, "versionchange", false, Promise.resolve());
		return upgradeTx.objectStore(name);
	}

	transaction(storeNames: string | string[], mode: IDBTransactionMode = "readonly"): FakeTransaction {
		// The fake opens one object store per transaction; a multi-store request is a test bug.
		const storeName = typeof storeNames === "string"
			? storeNames
			: storeNames.length === 1 ? storeNames[0] : undefined;
		if (storeName === undefined) {
			throw new TypeError(`FakeIndexedDb supports single-store transactions only, received ${JSON.stringify(storeNames)}`);
		}
		const store = this.data.stores.get(storeName);
		if (!store) throw new Error(`Missing object store ${storeName}`);
		const abortAfterRequestSuccess = mode === "readwrite" && this.factory.abortNextWriteTransaction;
		this.factory.abortNextWriteTransaction = false;
		const waitFor = mode === "readwrite"
			? (this.data.writeQueues.get(storeName) ?? Promise.resolve())
			: Promise.resolve();
		const tx = new FakeTransaction(this, storeName, store, mode, abortAfterRequestSuccess, waitFor);
		if (mode === "readwrite") this.data.writeQueues.set(storeName, tx.done.catch(() => undefined));
		return tx;
	}

	close(): void {
		// Closing a real handle does not delete the database; later opens must
		// observe the same persisted stores.
	}

	deleteObjectStore(): never {
		return unreachable("IDBDatabase.deleteObjectStore");
	}
}

export class FakeIndexedDb implements IDBFactory {
	private readonly stored = new Map<string, FakeDatabaseData>();

	/** Fail every open request, for fail-closed load and rejected save paths. */
	failOpen = false;

	/** Abort the next `readwrite` transaction after its requests have already succeeded. */
	abortNextWriteTransaction = false;

	open(name: string, version = 1): FakeOpenDbRequest {
		const req = new FakeOpenDbRequest();
		queueMicrotask(() => {
			if (this.failOpen) {
				req.fail(new DOMException("open failed"));
				return;
			}
			const existing = this.stored.get(name);
			const data = existing ?? { stores: new Map(), writeQueues: new Map() };
			if (!existing) this.stored.set(name, data);
			const db = new FakeDatabase(name, version, data, this);
			req.result = db;
			if (!existing) req.upgrade(version);
			req.succeed(db);
		});
		return req;
	}

	/** Seed a record straight into storage, bypassing the store's own validation, to test corrupt reads. */
	putRaw(dbName: string, storeName: string, key: string, value: unknown): void {
		let data = this.stored.get(dbName);
		if (!data) {
			data = { stores: new Map(), writeQueues: new Map() };
			this.stored.set(dbName, data);
		}
		let store = data.stores.get(storeName);
		if (!store) {
			store = new Map();
			data.stores.set(storeName, store);
		}
		store.set(key, value);
	}

	cmp(): never {
		return unreachable("IDBFactory.cmp");
	}

	databases(): never {
		return unreachable("IDBFactory.databases");
	}

	deleteDatabase(): never {
		return unreachable("IDBFactory.deleteDatabase");
	}
}
