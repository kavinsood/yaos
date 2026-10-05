/**
 * STAND-IN for WP-A src/sim/storage.ts; replace at integration.
 *
 * In-memory StoragePort with the same semantics as the IndexedDB adapter
 * (src/engine/adapters/idbStorage.ts), plus crash simulation for repository
 * tests. The shared conformance suite is
 * src/engine/adapters/storageConformance.test.ts.
 *
 * Data semantics:
 *  - tx() is atomic: the body runs against a copy-on-write working copy of the
 *    stores it writes; it is installed all-or-nothing after the body resolves.
 *  - Values are structured-cloned on put and on get.
 *  - Keys follow IndexedDB ordering: number < Date < string < binary
 *    (Uint8Array / BufferSource) < array (element-wise, then length).
 *  - Indexes (string or array keyPaths, unique flag). A record whose index
 *    keyPath does not yield a valid key is simply not in that index. A unique
 *    violation aborts the tx with failure "unknown" (like IDB's async
 *    ConstraintError: put itself does not throw).
 *  - A synchronous write failure (no valid key at the keyPath, readonly tx,
 *    store not in scope, uncloneable value) throws a StorageError "unknown"
 *    AND aborts the tx.
 *  - Empty/inverted ranges match nothing; limit 0 returns []; deleteRange({})
 *    clears the store (same port conventions as the IDB adapter).
 *  - Scheduling per DB as in IDB with "every scope overlaps": a readwrite tx
 *    waits for every earlier tx; a readonly tx waits for earlier readwrite
 *    txs. Readwrite txs are therefore serialized FIFO.
 *  - Rejection precedence: explicit abort() -> "aborted"; failed write or
 *    unique violation -> that StorageError; body threw/rejected -> the body's
 *    original error.
 *  - Best-effort tx-inactive detection: any op after the body promise settled
 *    (or after the tx aborted) throws (writes) / rejects (reads) a
 *    StorageError "tx-inactive". Awaiting a foreign promise inside the body is
 *    NOT detected here (IndexedDB would auto-commit); only the IDB adapter
 *    reproduces that.
 *  - open(): creates missing stores/indexes on a version increase (existing
 *    connections get onLost("connection-lost") and are closed first, as with
 *    IDB versionchange); a lower version rejects "unknown" (VersionError).
 *    deleteDatabase() likewise closes and notifies open handles. Upgrades do
 *    not count as commits and do not call the commit hook.
 *
 * Crash simulation:
 *  - commitCount counts committed readwrite txs (including ones that wrote
 *    nothing) across all databases of this port.
 *  - setCommitHook(fn) is called just before each readwrite commit with
 *    { db, index, stores }, index = commitCount at that moment (0-based).
 *    "crash-before": not committed, port dead, tx() rejects connection-lost.
 *    "crash-after": committed, port dead, tx() rejects connection-lost.
 *  - A dead port rejects every later open/tx/deleteDatabase/listDatabases/
 *    requestPersistence and every op of an in-flight tx with a StorageError
 *    "connection-lost"; in-flight txs never commit. Death does NOT fire onLost
 *    (the process is gone; nobody observes it).
 *  - crash() kills this port and returns a NEW live port holding a deep copy
 *    of exactly the committed state of every database (commitCount 0, no
 *    hook, no open handles). Callers reopen to simulate a restart.
 *  - Crashes are reported with the port's StorageError (name "StorageError",
 *    failure "connection-lost"); there is no separate CrashError class.
 *  - loseConnection(name) simulates an abnormal close (WebKit connection
 *    loss): handles fire onLost("connection-lost"), in-flight txs fail.
 */

import type { Unsubscribe } from "../../../ports/common";
import type {
	KeyRange, SchemaShape, StorageDb, StorageError, StorageFailure, StorageKey, StoragePort, StorageTx, StoreName, StoreSpec,
} from "../../../ports/storage";
import { isStorageError } from "../../../ports/storage";

// ---------------------------------------------------------------------------
// Public crash-simulation types
// ---------------------------------------------------------------------------

export interface CommitInfo {
	readonly db: string;
	/** 0-based index of this readwrite commit on this port (== commitCount before it). */
	readonly index: number;
	readonly stores: readonly string[];
}
export type CommitDecision = "commit" | "crash-before" | "crash-after";
export type CommitHook = (info: CommitInfo) => CommitDecision;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class MemStorageError extends Error implements StorageError {
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
	return new MemStorageError(failure, message, cause);
}

function asStorageError(e: unknown): StorageError {
	if (isStorageError(e)) return e;
	const name = typeof e === "object" && e !== null && typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : "Error";
	const message = typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : String(e);
	return storageError(name === "QuotaExceededError" ? "quota" : "unknown", `${name}: ${message}`, e);
}

function connectionLost(message: string): StorageError {
	return storageError("connection-lost", message);
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

type Key = number | string | Date | Uint8Array | readonly Key[];

function keyType(k: Key): number {
	if (typeof k === "number") return 0;
	if (k instanceof Date) return 1;
	if (typeof k === "string") return 2;
	if (k instanceof Uint8Array) return 3;
	return 4;
}

/** IndexedDB key comparison (indexedDB.cmp). */
function compareKeys(a: Key, b: Key): number {
	const ta = keyType(a);
	const tb = keyType(b);
	if (ta !== tb) return ta < tb ? -1 : 1;
	switch (ta) {
		case 0:
		case 2:
			return a < b ? -1 : a > b ? 1 : 0;
		case 1: {
			const x = (a as Date).getTime();
			const y = (b as Date).getTime();
			return x < y ? -1 : x > y ? 1 : 0;
		}
		case 3: {
			const x = a as Uint8Array;
			const y = b as Uint8Array;
			const n = Math.min(x.length, y.length);
			for (let i = 0; i < n; i++) {
				const d = (x[i] as number) - (y[i] as number);
				if (d !== 0) return d < 0 ? -1 : 1;
			}
			return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
		}
		default: {
			const x = a as readonly Key[];
			const y = b as readonly Key[];
			const n = Math.min(x.length, y.length);
			for (let i = 0; i < n; i++) {
				const c = compareKeys(x[i] as Key, y[i] as Key);
				if (c !== 0) return c;
			}
			return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
		}
	}
}

/** Validates and normalizes a value into a key (copying binary/arrays); undefined if not a valid key. */
function toKey(v: unknown, seen: Set<unknown> = new Set()): Key | undefined {
	if (typeof v === "number") return Number.isNaN(v) ? undefined : v;
	if (typeof v === "string") return v;
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : new Date(v.getTime());
	if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
	if (ArrayBuffer.isView(v)) {
		// Copy into a plain Uint8Array (Buffer#slice would alias).
		const out = new Uint8Array(v.byteLength);
		out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
		return out;
	}
	if (Array.isArray(v)) {
		if (seen.has(v)) return undefined;
		seen.add(v);
		const out: Key[] = [];
		for (let i = 0; i < v.length; i++) {
			if (!(i in v)) return undefined;
			const k = toKey(v[i], seen);
			if (k === undefined) return undefined;
			out.push(k);
		}
		seen.delete(v);
		return out;
	}
	return undefined;
}

function requireKey(v: unknown, what: string): Key {
	const k = toKey(v);
	if (k === undefined) throw storageError("unknown", `DataError: ${what} is not a valid key`);
	return k;
}

function evalPath(value: unknown, path: string): unknown {
	if (path === "") return value;
	let cur = value;
	for (const part of path.split(".")) {
		if (typeof cur === "string" && part === "length") cur = cur.length;
		else if (Array.isArray(cur) && part === "length") cur = cur.length;
		else if (typeof cur === "object" && cur !== null && Object.prototype.hasOwnProperty.call(cur, part)) cur = (cur as Record<string, unknown>)[part];
		else return undefined;
	}
	return cur;
}

function keyFromPath(value: unknown, keyPath: string | readonly string[]): Key | undefined {
	if (typeof keyPath === "string") return toKey(evalPath(value, keyPath));
	const out: Key[] = [];
	for (const p of keyPath) {
		const k = toKey(evalPath(value, p));
		if (k === undefined) return undefined;
		out.push(k);
	}
	return out;
}

interface NormRange {
	readonly lower: Key | undefined;
	readonly upper: Key | undefined;
	readonly lowerOpen: boolean;
	readonly upperOpen: boolean;
}

function normRange(range: KeyRange | undefined): NormRange | null {
	if (range === undefined) return null;
	return {
		lower: range.lower === undefined ? undefined : requireKey(range.lower, "range lower bound"),
		upper: range.upper === undefined ? undefined : requireKey(range.upper, "range upper bound"),
		lowerOpen: range.lowerOpen === true,
		upperOpen: range.upperOpen === true,
	};
}

const MAX_IDB_COUNT = 0xffffffff;

function normalizeLimit(limit: number | undefined): number | undefined {
	if (limit === undefined) return undefined;
	if (typeof limit !== "number" || Number.isNaN(limit) || limit < 0) throw storageError("unknown", `invalid limit: ${String(limit)}`);
	if (limit >= MAX_IDB_COUNT) return undefined;
	return Math.floor(limit);
}

/** First index i in [0, arr.length] with pred(arr[i]) true; pred must be monotone (false..., true...). */
function bisect<T>(arr: readonly T[], pred: (x: T) => boolean): number {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (pred(arr[mid] as T)) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/** [start, end) of the elements of a key-sorted array inside the range. */
function rangeBounds<T>(arr: readonly T[], keyOf: (x: T) => Key, range: NormRange | null): [number, number] {
	const lower = range?.lower;
	const upper = range?.upper;
	const start =
		lower === undefined ? 0 : range?.lowerOpen ? bisect(arr, (x) => compareKeys(keyOf(x), lower) > 0) : bisect(arr, (x) => compareKeys(keyOf(x), lower) >= 0);
	const end =
		upper === undefined ? arr.length : range?.upperOpen ? bisect(arr, (x) => compareKeys(keyOf(x), upper) >= 0) : bisect(arr, (x) => compareKeys(keyOf(x), upper) > 0);
	return [start, Math.max(start, end)];
}

function clone<T>(v: T): T {
	try {
		return structuredClone(v);
	} catch (e) {
		throw asStorageError(e);
	}
}

// ---------------------------------------------------------------------------
// Data model (plain data only: structuredClone-able for crash())
// ---------------------------------------------------------------------------

interface IndexDef {
	readonly name: string;
	readonly keyPath: string | readonly string[];
	readonly unique: boolean;
}
interface NormSpec {
	readonly keyPath: string | readonly string[];
	/** Order defines the slot of each index in Rec.ikeys and StoreData.indexes. */
	readonly indexes: readonly IndexDef[];
}
interface Rec {
	readonly key: Key;
	/** Private clone; never handed out. */
	readonly value: unknown;
	readonly ikeys: readonly (Key | undefined)[];
}
interface IndexEntry {
	readonly key: Key;
	readonly primary: Key;
}
interface StoreData {
	readonly spec: NormSpec;
	/** Sorted by key. Committed arrays are never mutated; txs copy on write. */
	readonly records: Rec[];
	/** Per index slot, sorted by (key, primary). */
	readonly indexes: IndexEntry[][];
}
interface DbData {
	readonly name: string;
	readonly version: number;
	readonly stores: Map<string, StoreData>;
}

function copyStore(sd: StoreData): StoreData {
	return { spec: sd.spec, records: sd.records.slice(), indexes: sd.indexes.map((a) => a.slice()) };
}

function compareIndexEntry(a: IndexEntry, b: IndexEntry): number {
	return compareKeys(a.key, b.key) || compareKeys(a.primary, b.primary);
}

function insertIndexEntry(arr: IndexEntry[], e: IndexEntry): void {
	arr.splice(
		bisect(arr, (x) => compareIndexEntry(x, e) >= 0),
		0,
		e,
	);
}

function removeIndexEntry(arr: IndexEntry[], e: IndexEntry): void {
	const i = bisect(arr, (x) => compareIndexEntry(x, e) >= 0);
	const at = arr[i];
	if (at && compareIndexEntry(at, e) === 0) arr.splice(i, 1);
}

function findRecord(sd: StoreData, key: Key): number {
	const i = bisect(sd.records, (r) => compareKeys(r.key, key) >= 0);
	const at = sd.records[i];
	return at && compareKeys(at.key, key) === 0 ? i : -1;
}

/** Builds a store with a fresh index set from existing records (upgrade). Returns a message on unique violation. */
function buildStore(spec: NormSpec, records: readonly Rec[]): StoreData | string {
	const sd: StoreData = { spec, records: [], indexes: spec.indexes.map(() => []) };
	for (const r of records) {
		const rec: Rec = { key: r.key, value: r.value, ikeys: spec.indexes.map((ix) => keyFromPath(r.value, ix.keyPath)) };
		const violation = uniqueViolation(sd, rec);
		if (violation) return violation;
		sd.records.push(rec);
		rec.ikeys.forEach((k, slot) => {
			if (k !== undefined) insertIndexEntry(sd.indexes[slot] as IndexEntry[], { key: k, primary: rec.key });
		});
	}
	return sd;
}

function uniqueViolation(sd: StoreData, rec: Rec): string | null {
	for (let slot = 0; slot < sd.spec.indexes.length; slot++) {
		const def = sd.spec.indexes[slot] as IndexDef;
		const k = rec.ikeys[slot];
		if (!def.unique || k === undefined) continue;
		const arr = sd.indexes[slot] as IndexEntry[];
		const [s, e] = rangeBounds(arr, (x) => x.key, { lower: k, upper: k, lowerOpen: false, upperOpen: false });
		for (let i = s; i < e; i++) {
			if (compareKeys((arr[i] as IndexEntry).primary, rec.key) !== 0) return `ConstraintError: unique index "${def.name}" already has this key`;
		}
	}
	return null;
}

function removeRecordAt(sd: StoreData, i: number): void {
	const old = sd.records[i] as Rec;
	old.ikeys.forEach((k, slot) => {
		if (k !== undefined) removeIndexEntry(sd.indexes[slot] as IndexEntry[], { key: k, primary: old.key });
	});
	sd.records.splice(i, 1);
}

/** Upgrades `base` (version 0 = new DB) by creating missing stores and indexes. Throws StorageError on failure. */
function upgradeDb(base: DbData, version: number, specs: Readonly<Record<string, StoreSpec>>): DbData {
	const stores = new Map(base.stores);
	for (const [name, spec] of Object.entries(specs)) {
		const existing = stores.get(name);
		const defs: IndexDef[] = existing ? existing.spec.indexes.slice() : [];
		let changed = !existing;
		for (const [ixName, ix] of Object.entries(spec.indexes)) {
			if (defs.some((d) => d.name === ixName)) continue;
			defs.push({ name: ixName, keyPath: typeof ix.keyPath === "string" ? ix.keyPath : ix.keyPath.slice(), unique: ix.unique });
			changed = true;
		}
		if (!changed) continue;
		const keyPath = existing ? existing.spec.keyPath : typeof spec.keyPath === "string" ? spec.keyPath : spec.keyPath.slice();
		const built = buildStore({ keyPath, indexes: defs }, existing ? existing.records : []);
		if (typeof built === "string") throw storageError("unknown", `upgrade of "${base.name}" store "${name}" failed: ${built}`);
		stores.set(name, built);
	}
	return { name: base.name, version, stores };
}

// ---------------------------------------------------------------------------
// Transaction context
// ---------------------------------------------------------------------------

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

interface DbState {
	data: DbData;
	readonly handles: Set<MemDb<SchemaShape>>;
	readonly queue: TxTicket[];
}
interface TxTicket {
	readonly mode: "readonly" | "readwrite";
	readonly done: Promise<void>;
}

class MemTx implements LooseTx {
	settled = false;
	/** "explicit" = abort(); a StorageError = failed write / unique violation. */
	abortState: "explicit" | StorageError | null = null;
	readonly working = new Map<string, StoreData>();

	constructor(
		private readonly port: MemStoragePort,
		private readonly handle: MemDb<SchemaShape>,
		private readonly state: DbState,
		private readonly scope: ReadonlySet<string>,
		private readonly mode: "readonly" | "readwrite",
	) {}

	private check(): void {
		if (this.port.dead) throw connectionLost("storage port is dead (simulated crash)");
		if (this.handle.broken) throw connectionLost(`database "${this.handle.name}" connection lost`);
		if (this.settled) throw storageError("tx-inactive", "transaction body already settled");
		if (this.abortState !== null) throw storageError("tx-inactive", "transaction already aborted");
	}

	private readStore(name: string): StoreData {
		if (!this.scope.has(name)) throw storageError("unknown", `NotFoundError: store "${name}" is not in this transaction's scope`);
		const sd = this.working.get(name) ?? this.state.data.stores.get(name);
		if (!sd) throw storageError("unknown", `NotFoundError: no store "${name}"`);
		return sd;
	}

	private writeStore(name: string): StoreData {
		if (this.mode !== "readwrite") throw storageError("unknown", "ReadOnlyError: write in a readonly transaction");
		const w = this.working.get(name);
		if (w) return w;
		const copy = copyStore(this.readStore(name));
		this.working.set(name, copy);
		return copy;
	}

	private indexSlot(sd: StoreData, index: string): number {
		const slot = sd.spec.indexes.findIndex((d) => d.name === index);
		if (slot < 0) throw storageError("unknown", `NotFoundError: no index "${index}"`);
		return slot;
	}

	private read<R>(fn: () => R): Promise<R> {
		try {
			this.check();
			return Promise.resolve(fn());
		} catch (e) {
			return Promise.reject(asStorageError(e));
		}
	}

	private write(fn: () => void): void {
		this.check();
		try {
			fn();
		} catch (e) {
			const err = asStorageError(e);
			this.fail(err);
			throw err;
		}
	}

	private fail(err: StorageError): void {
		if (this.abortState !== null) return;
		this.abortState = err;
		this.working.clear();
	}

	get(store: string, key: StorageKey): Promise<unknown> {
		return this.read(() => {
			const sd = this.readStore(store);
			const i = findRecord(sd, requireKey(key, "key"));
			return i < 0 ? undefined : clone((sd.records[i] as Rec).value);
		});
	}

	getAll(store: string, range?: KeyRange, limit?: number): Promise<unknown[]> {
		return this.read(() => {
			const sd = this.readStore(store);
			const [s, e] = rangeBounds(sd.records, (r) => r.key, normRange(range));
			const n = normalizeLimit(limit);
			return sd.records.slice(s, n === undefined ? e : Math.min(e, s + n)).map((r) => clone(r.value));
		});
	}

	getAllKeys(store: string, range?: KeyRange, limit?: number): Promise<unknown[]> {
		return this.read(() => {
			const sd = this.readStore(store);
			const [s, e] = rangeBounds(sd.records, (r) => r.key, normRange(range));
			const n = normalizeLimit(limit);
			return sd.records.slice(s, n === undefined ? e : Math.min(e, s + n)).map((r) => clone(r.key));
		});
	}

	getAllByIndex(store: string, index: string, range?: KeyRange, limit?: number): Promise<unknown[]> {
		return this.read(() => {
			const sd = this.readStore(store);
			const arr = sd.indexes[this.indexSlot(sd, index)] as IndexEntry[];
			const [s, e] = rangeBounds(arr, (x) => x.key, normRange(range));
			const n = normalizeLimit(limit);
			return arr.slice(s, n === undefined ? e : Math.min(e, s + n)).map((entry) => {
				const i = findRecord(sd, entry.primary);
				return clone((sd.records[i] as Rec).value);
			});
		});
	}

	count(store: string, range?: KeyRange): Promise<number> {
		return this.read(() => {
			const sd = this.readStore(store);
			const [s, e] = rangeBounds(sd.records, (r) => r.key, normRange(range));
			return e - s;
		});
	}

	countByIndex(store: string, index: string, range?: KeyRange): Promise<number> {
		return this.read(() => {
			const sd = this.readStore(store);
			const arr = sd.indexes[this.indexSlot(sd, index)] as IndexEntry[];
			const [s, e] = rangeBounds(arr, (x) => x.key, normRange(range));
			return e - s;
		});
	}

	put(store: string, record: object): void {
		this.write(() => {
			const sd = this.writeStore(store);
			const value = clone(record);
			const key = keyFromPath(value, sd.spec.keyPath);
			if (key === undefined) throw storageError("unknown", `DataError: record has no valid key at keyPath ${JSON.stringify(sd.spec.keyPath)}`);
			const rec: Rec = { key, value, ikeys: sd.spec.indexes.map((ix) => keyFromPath(value, ix.keyPath)) };
			const violation = uniqueViolation(sd, rec);
			if (violation) {
				// Like IDB's asynchronous ConstraintError: put returns, the tx is aborted.
				this.fail(storageError("unknown", violation));
				return;
			}
			const i = findRecord(sd, key);
			if (i >= 0) removeRecordAt(sd, i);
			sd.records.splice(
				bisect(sd.records, (r) => compareKeys(r.key, key) >= 0),
				0,
				rec,
			);
			rec.ikeys.forEach((k, slot) => {
				if (k !== undefined) insertIndexEntry(sd.indexes[slot] as IndexEntry[], { key: k, primary: key });
			});
		});
	}

	delete(store: string, key: StorageKey): void {
		this.write(() => {
			const sd = this.writeStore(store);
			const i = findRecord(sd, requireKey(key, "key"));
			if (i >= 0) removeRecordAt(sd, i);
		});
	}

	deleteRange(store: string, range: KeyRange): void {
		this.write(() => {
			const sd = this.writeStore(store);
			const [s, e] = rangeBounds(sd.records, (r) => r.key, normRange(range));
			for (let i = e - 1; i >= s; i--) removeRecordAt(sd, i);
		});
	}

	abort(): void {
		if (this.port.dead) throw connectionLost("storage port is dead (simulated crash)");
		if (this.settled) throw storageError("tx-inactive", "transaction body already settled");
		if (this.abortState !== null) return;
		this.abortState = "explicit";
		this.working.clear();
	}
}

// ---------------------------------------------------------------------------
// Database handle
// ---------------------------------------------------------------------------

class MemDb<S extends SchemaShape> implements StorageDb<S> {
	/** No new txs (close(), versionchange, abnormal loss). */
	closed = false;
	/** Abnormal loss: in-flight txs fail too. */
	broken = false;
	private readonly listeners = new Set<(failure: StorageFailure) => void>();

	constructor(
		private readonly port: MemStoragePort,
		readonly state: DbState,
	) {}

	get name(): string {
		return this.state.data.name;
	}

	tx<T>(stores: readonly StoreName<S>[], mode: "readonly" | "readwrite", body: (tx: StorageTx<S>) => Promise<T>): Promise<T> {
		return this.port.runTx(this as unknown as MemDb<SchemaShape>, stores, mode, body as unknown as (tx: LooseTx) => Promise<T>);
	}

	close(): void {
		this.closed = true;
		this.state.handles.delete(this as unknown as MemDb<SchemaShape>);
	}

	onLost(listener: (failure: StorageFailure) => void): Unsubscribe {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** versionchange (abnormal = false) or connection loss (abnormal = true). */
	lose(abnormal: boolean): void {
		if (this.closed) return;
		this.closed = true;
		if (abnormal) this.broken = true;
		this.state.handles.delete(this as unknown as MemDb<SchemaShape>);
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
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

function idle(state: DbState): Promise<void> {
	return Promise.all(state.queue.map((t) => t.done)).then(() => undefined);
}

export class MemStoragePort implements StoragePort {
	/** Committed readwrite txs across all databases of this port. */
	commitCount = 0;
	private deadFlag = false;
	private hook: CommitHook | null = null;
	private readonly dbs = new Map<string, DbState>();
	private readonly connQueues = new Map<string, Promise<void>>();

	/** True after a simulated crash (commit hook or crash()). */
	get dead(): boolean {
		return this.deadFlag;
	}

	setCommitHook(fn: CommitHook | null): void {
		this.hook = fn;
	}

	/** Kills this port; returns a new live port with a deep copy of every database's committed state. */
	crash(): MemStoragePort {
		this.deadFlag = true;
		const next = new MemStoragePort();
		for (const [name, st] of this.dbs) {
			next.dbs.set(name, { data: structuredClone(st.data), handles: new Set(), queue: [] });
		}
		return next;
	}

	/** Simulates an abnormal close (e.g. WebKit "connection lost") of every open handle on `name`. */
	loseConnection(name: string): void {
		const st = this.dbs.get(name);
		if (!st) return;
		for (const h of Array.from(st.handles)) h.lose(true);
	}

	private assertAlive(): void {
		if (this.deadFlag) throw connectionLost("storage port is dead (simulated crash)");
	}

	/** open/delete requests on one name run one at a time, like IDB's connection queue. */
	private serial<T>(name: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.connQueues.get(name) ?? Promise.resolve();
		const run = prev.then(fn);
		this.connQueues.set(
			name,
			run.then(
				() => undefined,
				() => undefined,
			),
		);
		return run;
	}

	async open<S extends SchemaShape>(name: string, version: number, stores: Readonly<Record<StoreName<S>, StoreSpec>>): Promise<StorageDb<S>> {
		this.assertAlive();
		if (!Number.isInteger(version) || version < 1) throw storageError("unknown", `TypeError: invalid database version ${String(version)}`);
		return this.serial(name, async () => {
			this.assertAlive();
			let st = this.dbs.get(name);
			if (st && st.data.version > version) {
				throw storageError("unknown", `VersionError: "${name}" is at version ${st.data.version} > requested ${version}`);
			}
			if (!st || st.data.version < version) {
				if (st) {
					for (const h of Array.from(st.handles)) h.lose(false);
					await idle(st);
					this.assertAlive();
				}
				const upgraded = upgradeDb(st ? st.data : { name, version: 0, stores: new Map() }, version, stores);
				if (st) st.data = upgraded;
				else {
					st = { data: upgraded, handles: new Set(), queue: [] };
					this.dbs.set(name, st);
				}
			}
			const handle = new MemDb<S>(this, st);
			st.handles.add(handle as unknown as MemDb<SchemaShape>);
			return handle;
		});
	}

	async deleteDatabase(name: string): Promise<void> {
		this.assertAlive();
		await this.serial(name, async () => {
			this.assertAlive();
			const st = this.dbs.get(name);
			if (!st) return;
			for (const h of Array.from(st.handles)) h.lose(false);
			await idle(st);
			this.assertAlive();
			if (this.dbs.get(name) === st) this.dbs.delete(name);
		});
	}

	async listDatabases(): Promise<readonly string[]> {
		this.assertAlive();
		return Array.from(this.dbs.keys()).sort();
	}

	async requestPersistence(): Promise<boolean> {
		this.assertAlive();
		return true;
	}

	/** @internal Used by MemDb.tx. */
	async runTx<T>(handle: MemDb<SchemaShape>, stores: readonly string[], mode: "readonly" | "readwrite", body: (tx: LooseTx) => Promise<T>): Promise<T> {
		this.assertAlive();
		if (handle.closed) throw connectionLost(`database "${handle.name}" connection is closed`);
		const st = handle.state;
		if (stores.length === 0) throw storageError("unknown", "InvalidAccessError: empty transaction scope");
		for (const s of stores) if (!st.data.stores.has(s)) throw storageError("unknown", `NotFoundError: no store "${s}" in "${handle.name}"`);

		const deps = st.queue.filter((t) => mode === "readwrite" || t.mode === "readwrite").map((t) => t.done);
		let release!: () => void;
		const ticket: TxTicket = { mode, done: new Promise<void>((r) => (release = r)) };
		st.queue.push(ticket);
		try {
			if (deps.length > 0) await Promise.all(deps);
			this.assertAlive();
			if (handle.broken) throw connectionLost(`database "${handle.name}" connection lost`);

			const tx = new MemTx(this, handle, st, new Set(stores), mode);
			let ok = false;
			let value: T | undefined;
			let error: unknown;
			try {
				value = await body(tx);
				ok = true;
			} catch (e) {
				error = e;
			}
			tx.settled = true;

			this.assertAlive();
			if (handle.broken) throw connectionLost(`database "${handle.name}" connection lost`);
			if (tx.abortState === "explicit") throw storageError("aborted", "transaction aborted");
			if (tx.abortState !== null) throw tx.abortState;
			if (!ok) throw error;
			if (mode === "readwrite") this.commit(st, tx, stores);
			return value as T;
		} finally {
			const i = st.queue.indexOf(ticket);
			if (i >= 0) st.queue.splice(i, 1);
			release();
		}
	}

	private commit(st: DbState, tx: MemTx, stores: readonly string[]): void {
		const info: CommitInfo = { db: st.data.name, index: this.commitCount, stores: stores.slice() };
		const decision = this.hook ? this.hook(info) : "commit";
		if (decision === "crash-before") {
			this.deadFlag = true;
			throw connectionLost(`simulated crash before commit #${info.index} on "${info.db}"`);
		}
		for (const [name, sd] of tx.working) st.data.stores.set(name, sd);
		this.commitCount++;
		if (decision === "crash-after") {
			this.deadFlag = true;
			throw connectionLost(`simulated crash after commit #${info.index} on "${info.db}"`);
		}
	}
}
