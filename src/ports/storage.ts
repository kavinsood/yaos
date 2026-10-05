/**
 * StoragePort: transactional object store (IndexedDB in production, an
 * in-memory implementation with identical semantics in simulation).
 * DESIGN §e. The schema is a type parameter so this port has no dependency on
 * the engine; src/engine/store/schema.ts supplies YaosSchema.
 *
 * Semantics every implementation must provide:
 *  - tx() is atomic: all writes in the body commit together or not at all.
 *  - The body may only await operations of its own tx (IndexedDB auto-commits
 *    when it goes idle); awaiting anything else aborts with "tx-inactive".
 *  - Values are structured-cloned on put and get (no aliasing).
 *  - A crash is modelled as "every committed tx survives, nothing else".
 */

import type { Unsubscribe } from "./common";

export type StorageKey = number | string | Uint8Array | readonly StorageKey[];

export interface KeyRange {
	readonly lower?: StorageKey;
	readonly upper?: StorageKey;
	readonly lowerOpen?: boolean;
	readonly upperOpen?: boolean;
}

export interface StoreSpec {
	readonly keyPath: string | readonly string[];
	readonly indexes: Readonly<Record<string, { readonly keyPath: string | readonly string[]; readonly unique: boolean }>>;
}

/** Maps store name -> record type, key type and index names. */
export interface SchemaShape {
	readonly [store: string]: {
		readonly record: object;
		readonly key: StorageKey;
		readonly indexes: string;
	};
}

export type StoreName<S extends SchemaShape> = keyof S & string;

export interface StorageTx<S extends SchemaShape> {
	get<N extends StoreName<S>>(store: N, key: S[N]["key"]): Promise<S[N]["record"] | undefined>;
	getAll<N extends StoreName<S>>(store: N, range?: KeyRange, limit?: number): Promise<S[N]["record"][]>;
	getAllKeys<N extends StoreName<S>>(store: N, range?: KeyRange, limit?: number): Promise<S[N]["key"][]>;
	getAllByIndex<N extends StoreName<S>>(store: N, index: S[N]["indexes"], range?: KeyRange, limit?: number): Promise<S[N]["record"][]>;
	count<N extends StoreName<S>>(store: N, range?: KeyRange): Promise<number>;
	countByIndex<N extends StoreName<S>>(store: N, index: S[N]["indexes"], range?: KeyRange): Promise<number>;
	/** Enqueued; failure aborts the whole tx. */
	put<N extends StoreName<S>>(store: N, record: S[N]["record"]): void;
	delete<N extends StoreName<S>>(store: N, key: S[N]["key"]): void;
	deleteRange<N extends StoreName<S>>(store: N, range: KeyRange): void;
	/** Abort explicitly; tx() rejects with "aborted". */
	abort(): void;
}

export type StorageFailure =
	| "tx-inactive"
	| "aborted"
	| "quota"
	/** WebKit "connection lost" / versionchange / origin eviction: reopen and verify identity. */
	| "connection-lost"
	| "unknown";

/** Rejection value of tx()/open() failures. name === "StorageError". */
export interface StorageError extends Error {
	readonly name: "StorageError";
	readonly failure: StorageFailure;
}

export function isStorageError(error: unknown): error is StorageError {
	return error instanceof Error && error.name === "StorageError" && "failure" in error;
}

export interface StorageDb<S extends SchemaShape> {
	readonly name: string;
	tx<T>(stores: readonly StoreName<S>[], mode: "readonly" | "readwrite", body: (tx: StorageTx<S>) => Promise<T>): Promise<T>;
	close(): void;
	/** Fired when the connection becomes unusable (DESIGN §i.5). */
	onLost(listener: (failure: StorageFailure) => void): Unsubscribe;
}

export interface StoragePort {
	open<S extends SchemaShape>(name: string, version: number, stores: Readonly<Record<StoreName<S>, StoreSpec>>): Promise<StorageDb<S>>;
	deleteDatabase(name: string): Promise<void>;
	/** Database names visible to this origin (indexedDB.databases()). */
	listDatabases(): Promise<readonly string[]>;
	/** navigator.storage.persist() where available; false otherwise. */
	requestPersistence(): Promise<boolean>;
}
