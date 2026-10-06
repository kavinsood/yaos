/**
 * IndexedDB implementation of StoragePort (DESIGN §e, §i.5). The only file in
 * the engine that touches `indexedDB` / `IDBKeyRange` / `navigator.storage`.
 *
 * Transaction model:
 *  - One IDBTransaction per tx(). Read methods wrap an IDBRequest in a promise
 *    resolved inside `onsuccess`, so `await` continuations run while the
 *    transaction is still active and may issue further requests.
 *  - put/delete/deleteRange are fire-and-forget; an asynchronous request
 *    failure aborts the transaction (IDB default action). A synchronous
 *    failure (DataError, ReadOnlyError, DataCloneError, ...) is thrown as a
 *    StorageError AND aborts the transaction, so a body that swallows it still
 *    commits nothing.
 *  - tx() settles only when both the body has settled and the transaction has
 *    finished (complete/abort). Resolve = body value after `oncomplete`.
 *  - Rejection precedence: explicit abort() -> "aborted"; body threw/rejected
 *    while the tx was live -> the body's original error; failed write ->
 *    that StorageError; otherwise the transaction's own error, mapped.
 *  - Any op after the body settled throws/rejects "tx-inactive" (matches the
 *    in-memory port's best-effort detection), as does any op after the
 *    IDBTransaction finished.
 *  - If the body awaits a non-IDB promise, IndexedDB auto-commits whatever was
 *    already requested; the next op fails "tx-inactive" and tx() rejects with
 *    it, but the earlier writes ARE committed. This is inherent to IndexedDB.
 *
 * Port-level conventions shared with the in-memory port:
 *  - An empty or inverted KeyRange (lower > upper, or lower == upper with an
 *    open bound) matches nothing instead of throwing DataError.
 *  - limit 0 returns [] (raw IDB treats count 0 as "unbounded"); negative/NaN
 *    limits are rejected; limits >= 2^32-1 mean "unbounded".
 *  - deleteRange({}) (no bounds) clears the store.
 *  - Binary keys come back as Uint8Array (IDB returns ArrayBuffer).
 *
 * Error mapping (DOMException name -> StorageFailure):
 *  QuotaExceededError -> quota, TransactionInactiveError -> tx-inactive,
 *  AbortError -> aborted, InvalidStateError -> connection-lost from
 *  db.transaction() / on a closed connection, tx-inactive inside a tx,
 *  UnknownError "connection ... lost" (WebKit) -> connection-lost,
 *  anything else -> unknown.
 */

import type { Unsubscribe } from "../../ports/common";
import type {
	KeyRange, SchemaShape, StorageDb, StorageError, StorageFailure, StorageKey, StoragePort, StorageTx, StoreName, StoreSpec,
} from "../../ports/storage";
import { isStorageError } from "../../ports/storage";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class IdbStorageError extends Error implements StorageError {
	override readonly name = "StorageError" as const;
	readonly failure: StorageFailure;
	readonly cause: unknown;
	constructor(failure: StorageFailure, message: string, cause?: unknown) {
		super(message);
		this.failure = failure;
		this.cause = cause;
	}
}

function storageError(failure: StorageFailure, message: string, cause?: unknown): StorageError {
	return new IdbStorageError(failure, message, cause);
}

function errorName(e: unknown): string {
	if (typeof e === "object" && e !== null) {
		const name = (e as { name?: unknown }).name;
		if (typeof name === "string") return name;
	}
	return "";
}

function errorMessage(e: unknown): string {
	if (typeof e === "object" && e !== null) {
		const message = (e as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return String(e);
}

/** Where the error was raised: affects how InvalidStateError is read. */
type ErrorSite = "db" | "tx";

function toStorageError(e: unknown, site: ErrorSite): StorageError {
	if (isStorageError(e)) return e;
	const name = errorName(e);
	const detail = `${name || "Error"}: ${errorMessage(e)}`;
	switch (name) {
		case "QuotaExceededError":
			return storageError("quota", detail, e);
		case "TransactionInactiveError":
			return storageError("tx-inactive", detail, e);
		case "AbortError":
			return storageError("aborted", detail, e);
		case "InvalidStateError":
			// db.transaction(): the connection is closed/closing. Inside a tx:
			// objectStore()/index() on a finished transaction.
			return storageError(site === "db" ? "connection-lost" : "tx-inactive", detail, e);
		case "UnknownError":
			// WebKit: "Connection to Indexed Database server lost. Refresh the page to try again".
			if (/connection.*lost/i.test(errorMessage(e))) return storageError("connection-lost", detail, e);
			return storageError("unknown", detail, e);
		default:
			return storageError("unknown", detail, e);
	}
}

// ---------------------------------------------------------------------------
// Keys, ranges, limits
// ---------------------------------------------------------------------------

const MAX_IDB_COUNT = 0xffffffff;

/** undefined = unbounded; 0 = return nothing. */
function normalizeLimit(limit: number | undefined): number | undefined {
	if (limit === undefined) return undefined;
	if (typeof limit !== "number" || Number.isNaN(limit) || limit < 0) {
		throw storageError("unknown", `invalid limit: ${String(limit)}`);
	}
	if (limit >= MAX_IDB_COUNT) return undefined;
	return Math.floor(limit);
}

function toKeyPath(keyPath: string | readonly string[]): string | string[] {
	return typeof keyPath === "string" ? keyPath : keyPath.slice();
}

/** IDB returns binary keys as ArrayBuffer; the port speaks Uint8Array. */
function normalizeKey(key: unknown): unknown {
	if (Array.isArray(key)) return key.map(normalizeKey);
	if (key instanceof Uint8Array) return key;
	if (key instanceof ArrayBuffer) return new Uint8Array(key);
	if (ArrayBuffer.isView(key)) return new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
	return key;
}

const EMPTY = Symbol("empty-range");
type IdbRange = IDBKeyRange | null | typeof EMPTY;

interface Env {
	readonly factory: IDBFactory;
	readonly keyRange: typeof IDBKeyRange;
}

function toIdbRange(env: Env, range: KeyRange | undefined): IdbRange {
	if (range === undefined) return null;
	const hasLower = range.lower !== undefined;
	const hasUpper = range.upper !== undefined;
	const lowerOpen = range.lowerOpen === true;
	const upperOpen = range.upperOpen === true;
	try {
		if (hasLower && hasUpper) {
			const c = env.factory.cmp(range.lower, range.upper);
			if (c > 0 || (c === 0 && (lowerOpen || upperOpen))) return EMPTY;
			return env.keyRange.bound(range.lower, range.upper, lowerOpen, upperOpen);
		}
		if (hasLower) return env.keyRange.lowerBound(range.lower, lowerOpen);
		if (hasUpper) return env.keyRange.upperBound(range.upper, upperOpen);
		return null;
	} catch (e) {
		throw toStorageError(e, "tx");
	}
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

/** Untyped view of StorageTx; cast to StorageTx<S> at the boundary. */
interface LooseTx {
	get(store: string, key: StorageKey): Promise<unknown>;
	getAll(store: string, range?: KeyRange, limit?: number): Promise<unknown[]>;
	getAllKeys(store: string, range?: KeyRange, limit?: number): Promise<unknown[]>;
	getAllByIndex(store: string, index: string, range?: KeyRange, limit?: number): Promise<unknown[]>;
	count(store: string, range?: KeyRange): Promise<number>;
	countByIndex(store: string, index: string, range?: KeyRange): Promise<number>;
	put(store: string, record: object): void;
	delete(store: string, key: StorageKey): void;
	deleteRange(store: string, range: KeyRange): void;
	abort(): void;
}

type ReadPlan<R> = { readonly request: IDBRequest; readonly map?: (result: unknown) => R } | { readonly immediate: R };

function runTx<T>(
	owner: IdbDb<SchemaShape>,
	stores: readonly string[],
	mode: "readonly" | "readwrite",
	body: (tx: LooseTx) => Promise<T>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let idbTx: IDBTransaction;
		const handles = new Map<string, IDBObjectStore>();
		try {
			idbTx = owner.raw.transaction(stores.slice(), mode);
			// Fetch store handles while the tx is surely active: objectStore()
			// on a finished tx throws InvalidStateError, while requests on a
			// cached handle throw the more precise TransactionInactiveError.
			for (const s of stores) handles.set(s, idbTx.objectStore(s));
		} catch (e) {
			const err = toStorageError(e, "db");
			if (err.failure === "connection-lost") owner.markLost();
			reject(err);
			return;
		}

		let txDone: "complete" | "abort" | null = null;
		let aborting = false;
		let abortCause: "explicit" | "body" | "failed" | null = null;
		let failError: StorageError | null = null;
		let bodySettled = false;
		let bodyOk = false;
		let bodyValue: T | undefined;
		let bodyError: unknown;
		let settled = false;

		const tryAbort = (): boolean => {
			try {
				idbTx.abort();
				aborting = true;
				return true;
			} catch {
				return false; // already finished (committed, or auto-aborted by a failed request)
			}
		};

		const abortReason = (): unknown => {
			if (abortCause === "explicit") return storageError("aborted", "transaction aborted");
			if (abortCause === "body") return bodyError;
			if (abortCause === "failed" && failError) return failError;
			const e = idbTx.error;
			if (e) {
				const err = toStorageError(e, "tx");
				if (err.failure === "connection-lost") owner.markLost();
				return err;
			}
			return storageError(owner.lost ? "connection-lost" : "aborted", "transaction aborted");
		};

		const settle = (): void => {
			if (settled || txDone === null || !bodySettled) return;
			settled = true;
			if (txDone === "complete") {
				if (bodyOk) resolve(bodyValue as T);
				else reject(bodyError);
				return;
			}
			reject(abortReason());
		};

		idbTx.oncomplete = () => {
			txDone = "complete";
			settle();
		};
		idbTx.onabort = () => {
			txDone = "abort";
			settle();
		};

		const guard = (): void => {
			if (bodySettled) throw storageError("tx-inactive", "transaction body already settled");
			if (txDone !== null || aborting) {
				throw storageError("tx-inactive", `transaction already ${txDone === "complete" ? "committed" : "aborted"}`);
			}
		};

		const store = (name: string): IDBObjectStore => {
			const h = handles.get(name);
			if (!h) throw storageError("unknown", `NotFoundError: store "${name}" is not in this transaction's scope`);
			return h;
		};

		const read = <R>(plan: () => ReadPlan<R>): Promise<R> => {
			let p: ReadPlan<R>;
			try {
				guard();
				p = plan();
			} catch (e) {
				return Promise.reject(toStorageError(e, "tx"));
			}
			if ("immediate" in p) return Promise.resolve(p.immediate);
			const { request, map } = p;
			return new Promise<R>((res, rej) => {
				request.onsuccess = () => {
					res(map ? map(request.result) : (request.result as R));
				};
				request.onerror = () => {
					// No preventDefault: a failed request aborts the tx.
					rej(toStorageError(request.error, "tx"));
				};
			});
		};

		const write = (op: () => void): void => {
			guard();
			try {
				op();
			} catch (e) {
				const err = toStorageError(e, "tx");
				// Abort when still possible (also for TransactionInactiveError on
				// an inactive-but-unfinished tx), so nothing of this tx commits.
				if (tryAbort()) {
					abortCause = "failed";
					failError = err;
				}
				throw err;
			}
		};

		const api: LooseTx = {
			get: (s, key) => read(() => ({ request: store(s).get(key as IDBValidKey) })),
			getAll: (s, range, limit) =>
				read<unknown[]>(() => {
					const os = store(s);
					const r = toIdbRange(owner.env, range);
					const n = normalizeLimit(limit);
					if (r === EMPTY || n === 0) return { immediate: [] };
					return { request: os.getAll(r, n) };
				}),
			getAllKeys: (s, range, limit) =>
				read<unknown[]>(() => {
					const os = store(s);
					const r = toIdbRange(owner.env, range);
					const n = normalizeLimit(limit);
					if (r === EMPTY || n === 0) return { immediate: [] };
					return { request: os.getAllKeys(r, n), map: (keys) => (keys as unknown[]).map(normalizeKey) };
				}),
			getAllByIndex: (s, index, range, limit) =>
				read<unknown[]>(() => {
					const ix = store(s).index(index);
					const r = toIdbRange(owner.env, range);
					const n = normalizeLimit(limit);
					if (r === EMPTY || n === 0) return { immediate: [] };
					return { request: ix.getAll(r, n) };
				}),
			count: (s, range) =>
				read<number>(() => {
					const os = store(s);
					const r = toIdbRange(owner.env, range);
					if (r === EMPTY) return { immediate: 0 };
					return { request: os.count(r ?? undefined) };
				}),
			countByIndex: (s, index, range) =>
				read<number>(() => {
					const ix = store(s).index(index);
					const r = toIdbRange(owner.env, range);
					if (r === EMPTY) return { immediate: 0 };
					return { request: ix.count(r ?? undefined) };
				}),
			put: (s, record) =>
				write(() => {
					store(s).put(record);
				}),
			delete: (s, key) =>
				write(() => {
					store(s).delete(key as IDBValidKey);
				}),
			deleteRange: (s, range) =>
				write(() => {
					const os = store(s);
					const r = toIdbRange(owner.env, range);
					if (r === EMPTY) return;
					if (r === null) os.clear();
					else os.delete(r);
				}),
			abort: () => {
				if (bodySettled) throw storageError("tx-inactive", "transaction body already settled");
				if (aborting || txDone === "abort") return;
				if (txDone === "complete") throw storageError("tx-inactive", "transaction already committed");
				if (tryAbort()) abortCause = "explicit";
			},
		};

		let bodyPromise: Promise<T>;
		try {
			bodyPromise = Promise.resolve(body(api));
		} catch (e) {
			bodyPromise = Promise.reject(e);
		}
		bodyPromise.then(
			(value) => {
				bodySettled = true;
				bodyOk = true;
				bodyValue = value;
				settle();
			},
			(error: unknown) => {
				bodySettled = true;
				bodyError = error;
				if (txDone === null && !aborting && tryAbort()) abortCause = "body";
				settle();
			},
		);
	});
}

// ---------------------------------------------------------------------------
// Database handle
// ---------------------------------------------------------------------------

class IdbDb<S extends SchemaShape> implements StorageDb<S> {
	readonly name: string;
	readonly raw: IDBDatabase;
	readonly env: Env;
	/** close() was called by the owner: no onLost. */
	private userClosed = false;
	/** The connection was taken away (versionchange, abnormal close, WebKit loss). */
	lost = false;
	private readonly listeners = new Set<(failure: StorageFailure) => void>();

	constructor(raw: IDBDatabase, env: Env) {
		this.raw = raw;
		this.env = env;
		this.name = raw.name;
		raw.onversionchange = () => this.markLost();
		raw.onclose = () => this.markLost();
	}

	markLost(): void {
		if (this.userClosed || this.lost) return;
		this.lost = true;
		try {
			this.raw.close();
		} catch {
			// already closed
		}
		for (const listener of Array.from(this.listeners)) {
			try {
				listener("connection-lost");
			} catch (e) {
				queueMicrotask(() => {
					throw e;
				});
			}
		}
	}

	tx<T>(stores: readonly StoreName<S>[], mode: "readonly" | "readwrite", body: (tx: StorageTx<S>) => Promise<T>): Promise<T> {
		if (this.userClosed || this.lost) {
			return Promise.reject(storageError("connection-lost", `database "${this.name}" connection is closed`));
		}
		return runTx(this as unknown as IdbDb<SchemaShape>, stores, mode, body as unknown as (tx: LooseTx) => Promise<T>);
	}

	close(): void {
		if (this.userClosed) return;
		this.userClosed = true;
		this.raw.close();
	}

	onLost(listener: (failure: StorageFailure) => void): Unsubscribe {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

function upgrade(db: IDBDatabase, tx: IDBTransaction, specs: Readonly<Record<string, StoreSpec>>): void {
	for (const [storeName, spec] of Object.entries(specs)) {
		const os = db.objectStoreNames.contains(storeName)
			? tx.objectStore(storeName)
			: db.createObjectStore(storeName, { keyPath: toKeyPath(spec.keyPath) });
		for (const [indexName, ix] of Object.entries(spec.indexes)) {
			if (!os.indexNames.contains(indexName)) os.createIndex(indexName, toKeyPath(ix.keyPath), { unique: ix.unique });
		}
	}
}

/**
 * @param factory  defaults to the global `indexedDB`.
 * @param keyRange defaults to the global `IDBKeyRange`; pass the one matching
 *                 `factory` when it is not the global (fake-indexeddb in tests).
 */
export function createIdbStoragePort(factory?: IDBFactory, keyRange?: typeof IDBKeyRange): StoragePort {
	const f = factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
	if (!f) throw new Error("createIdbStoragePort: IndexedDB is not available");
	const kr = keyRange ?? (typeof IDBKeyRange !== "undefined" ? IDBKeyRange : undefined);
	if (!kr) throw new Error("createIdbStoragePort: IDBKeyRange is not available");
	const env: Env = { factory: f, keyRange: kr };

	return {
		open<S extends SchemaShape>(name: string, version: number, stores: Readonly<Record<StoreName<S>, StoreSpec>>): Promise<StorageDb<S>> {
			return new Promise<StorageDb<S>>((resolve, reject) => {
				let req: IDBOpenDBRequest;
				try {
					req = f.open(name, version);
				} catch (e) {
					reject(toStorageError(e, "db"));
					return;
				}
				let settled = false;
				let upgradeError: StorageError | null = null;
				const fail = (err: StorageError): void => {
					if (settled) return;
					settled = true;
					reject(err);
				};
				req.onupgradeneeded = () => {
					const tx = req.transaction;
					if (settled) {
						// Already rejected (blocked); do not upgrade behind the caller's back.
						tx?.abort();
						return;
					}
					try {
						if (!tx) throw new Error("upgradeneeded without a versionchange transaction");
						// An asynchronous upgrade failure (e.g. ConstraintError building a
						// unique index over existing data) surfaces on the open request as
						// a bare AbortError; keep the real cause.
						tx.addEventListener("abort", () => {
							if (upgradeError === null && tx.error) upgradeError = toStorageError(tx.error, "tx");
						});
						upgrade(req.result, tx, stores);
					} catch (e) {
						upgradeError = toStorageError(e, "tx");
						try {
							tx?.abort();
						} catch {
							// already finished
						}
					}
				};
				req.onsuccess = () => {
					const raw = req.result;
					if (settled) {
						raw.close(); // late success after we rejected (blocked)
						return;
					}
					settled = true;
					resolve(new IdbDb<S>(raw, env));
				};
				req.onerror = (event) => {
					event.preventDefault();
					fail(upgradeError ?? toStorageError(req.error, "db"));
				};
				req.onblocked = () => {
					fail(storageError("unknown", `open "${name}" v${version} blocked by another open connection`));
				};
			});
		},

		deleteDatabase(name: string): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				let req: IDBOpenDBRequest;
				try {
					req = f.deleteDatabase(name);
				} catch (e) {
					reject(toStorageError(e, "db"));
					return;
				}
				req.onsuccess = () => resolve();
				req.onerror = (event) => {
					event.preventDefault();
					reject(toStorageError(req.error, "db"));
				};
				// onblocked: the request stays queued and succeeds once the
				// other connections close; our own handles close on versionchange.
			});
		},

		async listDatabases(): Promise<readonly string[]> {
			if (typeof f.databases !== "function") return [];
			try {
				const infos = await f.databases();
				const names: string[] = [];
				for (const info of infos) if (typeof info.name === "string") names.push(info.name);
				return names;
			} catch (e) {
				throw toStorageError(e, "db");
			}
		},

		async requestPersistence(): Promise<boolean> {
			try {
				if (typeof navigator === "undefined") return false;
				const storage = (navigator as { storage?: { persist?: () => Promise<boolean> } }).storage;
				if (!storage || typeof storage.persist !== "function") return false;
				return (await storage.persist()) === true;
			} catch {
				return false;
			}
		},
	};
}
