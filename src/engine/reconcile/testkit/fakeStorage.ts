/**
 * The engine unit tests' StoragePort: the sim's MemStoragePort (held to the IndexedDB contract by
 * adapters/storageConformance.test.ts, as is this class) plus the crash-point hooks and the survivable
 * crash() the reconcile/settings/blob-queue tests use. It used to be a separate in-memory store that
 * accepted what IndexedDB refuses (unique-index violations, ops after the tx settled, invalid index keys).
 *  - crash(): every committed tx survives, nothing else; open handles die, this port stays usable.
 *  - beforeCommit / afterCommit: throw to crash just before / just after commit #n (1-based); the tx()
 *    that hit the hook rejects with what the hook threw.
 */

import type { SchemaShape, StorageDb, StorageFailure, StoragePort, StorageTx, StoreName, StoreSpec } from "../../../ports/storage";
import type { Unsubscribe } from "../../../ports/common";
import { MemStoragePort, type CommitInfo, type CommitDecision } from "../../../sim/storage";

export class FakeStorage implements StoragePort {
	private inner = new MemStoragePort();
	/** Committed readwrite transactions so far (crash-point enumeration in tests). */
	commits = 0;
	/** Called after every commit with the running count; throw to simulate a crash right after it. */
	afterCommit: ((n: number) => void) | null = null;
	/** Called before every commit; throw to simulate a crash before it (the tx is lost). */
	beforeCommit: ((n: number) => void) | null = null;
	/** What a hook threw: the tx that hit it rejects with this instead of the port's connection-lost. */
	private pending: { readonly e: unknown } | null = null;

	constructor() {
		this.hook();
	}

	private hook(): void {
		this.inner.setCommitHook((info: CommitInfo): CommitDecision => {
			const n = info.index + 1;
			try {
				this.beforeCommit?.(n);
			} catch (e) {
				this.pending = { e };
				return "crash-before";
			}
			this.commits = n;
			try {
				this.afterCommit?.(n);
			} catch (e) {
				this.pending = { e };
				return "crash-after";
			}
			return "commit";
		});
	}

	/** @internal The hook error for a tx that failed, if one is pending. */
	rethrow(e: unknown): never {
		const p = this.pending;
		this.pending = null;
		throw p ? p.e : e;
	}

	async open<S extends SchemaShape>(name: string, version: number, stores: Readonly<Record<StoreName<S>, StoreSpec>>): Promise<StorageDb<S>> {
		return new FakeDb(await this.inner.open<S>(name, version, stores), this);
	}

	deleteDatabase(name: string): Promise<void> {
		return this.inner.deleteDatabase(name);
	}

	listDatabases(): Promise<readonly string[]> {
		return this.inner.listDatabases();
	}

	requestPersistence(): Promise<boolean> {
		return this.inner.requestPersistence();
	}

	/** Process death: open handles stop working; committed state stays. */
	crash(): void {
		this.inner = this.inner.crash();
		this.pending = null;
		this.hook();
	}

	/** Test helper: committed rows of a store (cloned), in key order. */
	dump(dbName: string, store: string): object[] {
		return (this.inner.dump(dbName)?.[store] ?? []) as object[];
	}
}

class FakeDb<S extends SchemaShape> implements StorageDb<S> {
	constructor(private readonly db: StorageDb<S>, private readonly owner: FakeStorage) {}

	get name(): string {
		return this.db.name;
	}

	tx<T>(stores: readonly StoreName<S>[], mode: "readonly" | "readwrite", body: (tx: StorageTx<S>) => Promise<T>): Promise<T> {
		return this.db.tx(stores, mode, body).catch((e: unknown) => this.owner.rethrow(e));
	}

	close(): void {
		this.db.close();
	}

	onLost(listener: (failure: StorageFailure) => void): Unsubscribe {
		return this.db.onLost(listener);
	}
}
