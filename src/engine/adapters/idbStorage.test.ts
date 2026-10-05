/**
 * IndexedDB-specific behaviour of createIdbStoragePort, on fake-indexeddb with
 * a fresh IDBFactory per test. Shared semantics live in
 * storageConformance.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBKeyRange, IDBObjectStore, forceCloseDatabase } from "fake-indexeddb";
import type { StorageDb, StorageError, StorageFailure, StorageKey } from "../../ports/storage";
import { isStorageError } from "../../ports/storage";
import { createIdbStoragePort } from "./idbStorage";

type KvSchema = { readonly kv: { readonly record: { readonly k: StorageKey; readonly v?: unknown }; readonly key: StorageKey; readonly indexes: never } };
const KV = { kv: { keyPath: "k", indexes: {} } } as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function rejectsWith(p: Promise<unknown>, failure: StorageFailure): Promise<StorageError> {
	try {
		await p;
	} catch (e) {
		assert.ok(isStorageError(e), `expected a StorageError, got ${String(e)}`);
		assert.equal(e.failure, failure, `failure (${e.message})`);
		return e;
	}
	return assert.fail(`expected rejection with "${failure}"`);
}

function setup(): { factory: IDBFactory; port: ReturnType<typeof createIdbStoragePort>; open: (name?: string, version?: number) => Promise<StorageDb<KvSchema>> } {
	const factory = new IDBFactory();
	const port = createIdbStoragePort(factory, IDBKeyRange);
	return { factory, port, open: (name = "kv", version = 1) => port.open<KvSchema>(name, version, KV) };
}

/** White-box: the raw IDBDatabase behind an IdbDb handle (for forceCloseDatabase). */
function rawOf(db: StorageDb<KvSchema>): IDBDatabase {
	return (db as unknown as { raw: IDBDatabase }).raw;
}

function rawOpen(factory: IDBFactory, name: string, version?: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = version === undefined ? factory.open(name) : factory.open(name, version);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function count(db: StorageDb<KvSchema>): Promise<number> {
	return db.tx(["kv"], "readonly", (tx) => tx.count("kv"));
}

describe("createIdbStoragePort (fake-indexeddb)", () => {
	it("awaiting a timer inside the body auto-commits the tx; later ops fail tx-inactive", async () => {
		const { open } = setup();
		const db = await open();
		let putError: unknown = null;
		await rejectsWith(
			db.tx(["kv"], "readwrite", async (tx) => {
				tx.put("kv", { k: 1 });
				await sleep(5); // not an IDB request: IndexedDB commits what it has
				try {
					tx.put("kv", { k: 2 });
				} catch (e) {
					putError = e;
				}
				return tx.get("kv", 1); // rejects tx-inactive, so the body rejects
			}),
			"tx-inactive",
		);
		assert.ok(isStorageError(putError) && putError.failure === "tx-inactive", String(putError));
		// The write issued before the await WAS committed; the one after was not.
		assert.deepEqual(await db.tx(["kv"], "readonly", (tx) => tx.getAllKeys("kv")), [1]);
	});

	it("even a zero-delay timer is enough to lose the tx; a body that swallows the error resolves", async () => {
		const { open } = setup();
		const db = await open();
		const out = await db.tx(["kv"], "readwrite", async (tx) => {
			tx.put("kv", { k: "a" });
			await sleep(0);
			const r = await tx.count("kv").then(
				() => "still active",
				(e: unknown) => (isStorageError(e) ? e.failure : "other"),
			);
			try {
				tx.abort();
				return `${r}, abort ok`;
			} catch (e) {
				return `${r}, abort ${isStorageError(e) ? e.failure : "other"}`;
			}
		});
		assert.equal(out, "tx-inactive, abort tx-inactive");
		assert.equal(await count(db), 1);
	});

	it("maps synchronous DOMExceptions from requests and aborts the tx", async () => {
		const cases: readonly [string, StorageFailure][] = [
			["QuotaExceededError", "quota"],
			["TransactionInactiveError", "tx-inactive"],
			["AbortError", "aborted"],
			["InvalidStateError", "tx-inactive"],
			["DataCloneError", "unknown"],
			["SomethingNew", "unknown"],
		];
		const proto = IDBObjectStore.prototype as unknown as { put: (...args: unknown[]) => unknown };
		const original = proto.put;
		try {
			for (const [name, failure] of cases) {
				const { open } = setup();
				const db = await open();
				let thrown: unknown = null;
				proto.put = function patched(this: unknown, ...args: unknown[]) {
					const rec = args[0] as { k?: unknown };
					if (rec.k === "boom") throw new DOMException(`simulated ${name}`, name);
					return original.apply(this, args);
				};
				const err = await rejectsWith(
					db.tx(["kv"], "readwrite", async (tx) => {
						tx.put("kv", { k: "ok" });
						try {
							tx.put("kv", { k: "boom" });
						} catch (e) {
							thrown = e;
						}
						return "body swallowed it";
					}),
					failure,
				);
				proto.put = original;
				assert.equal(err, thrown, `${name}: tx() rejects with the thrown error`);
				assert.equal((err as { cause?: { name?: string } }).cause?.name, name);
				assert.equal(await count(db), 0, `${name}: nothing committed`);
				db.close();
			}
		} finally {
			proto.put = original;
		}
	});

	it("forced close (browser closed the connection) fires onLost; later tx() rejects connection-lost", async () => {
		const { open } = setup();
		const db = await open();
		const lost: StorageFailure[] = [];
		const unsubscribe = db.onLost((f) => lost.push(f));
		const removed: StorageFailure[] = [];
		db.onLost((f) => removed.push(f))();
		// fake-indexeddb types the parameter oddly (the FDBDatabase constructor type).
		forceCloseDatabase(rawOf(db) as unknown as Parameters<typeof forceCloseDatabase>[0]);
		await sleep(5);
		assert.deepEqual(lost, ["connection-lost"]);
		assert.deepEqual(removed, []);
		await rejectsWith(count(db), "connection-lost");
		unsubscribe();
	});

	it("a versionchange from another connection (another tab) closes our handle so the upgrade is not blocked", async () => {
		const { factory, open } = setup();
		const db = await open();
		await db.tx(["kv"], "readwrite", async (tx) => {
			tx.put("kv", { k: 1 });
		});
		const lost: StorageFailure[] = [];
		db.onLost((f) => lost.push(f));
		const other = await rawOpen(factory, "kv", 2); // would hang on "blocked" if we did not close
		assert.equal(other.version, 2);
		assert.deepEqual(lost, ["connection-lost"]);
		await rejectsWith(count(db), "connection-lost");
		other.close();
	});

	it("an open blocked by a connection that ignores versionchange rejects; the late upgrade is abandoned", async () => {
		const { factory, port } = setup();
		const stubborn = await rawOpen(factory, "kv", 1);
		stubborn.onversionchange = () => undefined; // never closes
		await rejectsWith(port.open<KvSchema>("kv", 2, KV), "unknown");
		stubborn.close(); // the queued open now proceeds; we abort its upgrade
		await sleep(10);
		const raw = await rawOpen(factory, "kv");
		assert.equal(raw.version, 1);
		assert.equal(raw.objectStoreNames.contains("kv"), false);
		raw.close();
	});

	it("tx() on a connection closed underneath it rejects connection-lost and marks the handle lost", async () => {
		const { open } = setup();
		const db = await open();
		const lost: StorageFailure[] = [];
		db.onLost((f) => lost.push(f));
		rawOf(db).close(); // closed without our close(): db.transaction() throws InvalidStateError
		await rejectsWith(count(db), "connection-lost");
		assert.deepEqual(lost, ["connection-lost"]);
	});

	it("listDatabases falls back to [] without IDBFactory.databases(); requestPersistence is false without navigator.storage", async () => {
		const factory = new IDBFactory();
		Object.defineProperty(factory, "databases", { value: undefined, configurable: true });
		const port = createIdbStoragePort(factory, IDBKeyRange);
		const db = await port.open<KvSchema>("kv", 1, KV);
		assert.deepEqual(await port.listDatabases(), []);
		db.close();
		assert.equal(await port.requestPersistence(), false);
	});

	it("requestPersistence uses navigator.storage.persist() when present and never throws", async () => {
		const port = setup().port;
		const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		const stub = (persist: unknown): void => {
			Object.defineProperty(globalThis, "navigator", { value: { storage: { persist } }, configurable: true, writable: true });
		};
		try {
			stub(() => Promise.resolve(true));
			assert.equal(await port.requestPersistence(), true);
			stub(() => Promise.resolve(false));
			assert.equal(await port.requestPersistence(), false);
			stub(() => Promise.reject(new Error("denied")));
			assert.equal(await port.requestPersistence(), false);
			stub(() => {
				throw new Error("sync throw");
			});
			assert.equal(await port.requestPersistence(), false);
			stub("not a function");
			assert.equal(await port.requestPersistence(), false);
		} finally {
			if (desc) Object.defineProperty(globalThis, "navigator", desc);
			else delete (globalThis as { navigator?: unknown }).navigator;
		}
	});

	it("without a global indexedDB the default factory is unavailable", () => {
		assert.equal(typeof (globalThis as { indexedDB?: unknown }).indexedDB, "undefined");
		assert.throws(() => createIdbStoragePort(), /IndexedDB is not available/);
		assert.throws(() => createIdbStoragePort(new IDBFactory()), /IDBKeyRange is not available/);
	});
});
