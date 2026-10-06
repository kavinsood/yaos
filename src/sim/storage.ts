/**
 * In-memory StoragePort with IndexedDB semantics and crash injection
 * (DESIGN §e, §m). Implements the frozen src/ports/storage.ts; API-compatible
 * superset of the former WP-C memStorage stand-in; passes the storage
 * conformance suite.
 *
 * Data semantics:
 *  - tx() is atomic: a readwrite body writes into a copy-on-write working copy
 *    of each store it touches; the copy is installed all-or-nothing at commit.
 *  - Values are structured-cloned on put and on every read.
 *  - IndexedDB key order: number < Date < string < binary < array.
 *  - Indexes with string or array keyPaths and a unique flag. A record whose
 *    index keyPath does not yield a valid key is not in that index. A unique
 *    violation aborts the tx with failure "unknown" (put itself returns, like
 *    IDB's asynchronous ConstraintError).
 *  - A synchronous write failure (no valid primary key, readonly tx, store not
 *    in scope, uncloneable value) throws a StorageError "unknown" AND aborts.
 *  - Empty/inverted ranges match nothing; limit 0 returns []; deleteRange({})
 *    clears the store; negative/NaN limits reject "unknown".
 *  - Scheduling per database as if every scope overlapped: a readwrite tx
 *    waits for every earlier tx, a readonly tx for earlier readwrite txs. The
 *    whole body is deferred (IDB defers only its requests; no body can observe
 *    another's uncommitted state either way).
 *  - Rejection precedence: port dead / connection lost -> "connection-lost";
 *    explicit abort() -> "aborted"; failed write or unique violation -> that
 *    error; commit failure ("quota") -> that error; body threw -> the body's
 *    original error.
 *
 * Inactive transactions (option `inactive`, default "idb"):
 *  - "idb" reproduces IndexedDB auto-commit. A read's result is delivered in a
 *    microtask; after every op (and at body start) a REAL macrotask check is
 *    scheduled. If, when it runs, the body has not settled and issued no op
 *    since the check was armed, the body is awaiting something that is not
 *    this tx (a timer, another tx, a port call): exactly when IDB commits.
 *    The tx then auto-commits what it has written so far (through the commit
 *    hook, `auto: true`), releases its place in the queue (so a body awaiting
 *    another tx on the same db does not deadlock), calls onForeignAwait, and
 *    every later op throws (writes) / rejects (reads) "tx-inactive". tx()
 *    settles when the body does: the body's error if it threw (typically the
 *    tx-inactive error), else its value; the early writes STAY committed, as
 *    with IndexedDB. Awaiting only microtasks (Promise.resolve, the tx's own
 *    reads, Promise.all of them) never trips the check.
 *  - "off": only ops after the body settled (or after abort) are rejected
 *    "tx-inactive" (the WP-C stand-in behaviour).
 *  The check runs on a real macrotask (setImmediate where available) and,
 *  with options.beforeNextTimer = clock.beforeNextTimer, also right before
 *  the VirtualClock fires its next timer, so awaiting clock.yieldNow()/sleep()
 *  inside a body is always detected before virtual time moves.
 *
 * Crash simulation:
 *  - commitCount counts committed readwrite txs (including empty ones) across
 *    all databases of this port.
 *  - setCommitHook(fn) is called just before each readwrite commit with
 *    { db, index, stores, auto }, index = commitCount at that moment.
 *    Decisions: "commit"; "crash-before" (not committed, port dead);
 *    "crash-after" (committed, port dead); "quota" (not committed, tx rejects
 *    "quota", port alive); "lose-connection" (not committed, every handle of
 *    that db fires onLost("connection-lost") and dies; tx rejects
 *    "connection-lost").
 *  - A dead port rejects every later call with "connection-lost"; in-flight
 *    txs never commit; death does not fire onLost (nobody is left to see it).
 *  - crash() kills this port and returns a NEW live port holding a deep copy
 *    of exactly the committed state (commitCount 0, no hook, no handles, same
 *    options). Callers reopen to simulate a restart.
 *  - loseConnection(name): abnormal close of every handle on `name` (WebKit
 *    connection loss): onLost("connection-lost"), in-flight txs fail.
 *  - Upgrades (open with a higher version) do not count as commits.
 */

import type { Unsubscribe } from "../ports/common";
import type {
	KeyRange,
	SchemaShape,
	StorageDb,
	StorageError,
	StorageFailure,
	StorageKey,
	StoragePort,
	StorageTx,
	StoreName,
	StoreSpec,
} from "../ports/storage";
import { isStorageError } from "../ports/storage";
import { realMacrotaskCallback } from "./clock";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CommitInfo {
	readonly db: string;
	/** 0-based index of this readwrite commit on this port (== commitCount before it). */
	readonly index: number;
	readonly stores: readonly string[];
	/** True when the commit is an IDB-style auto-commit (the body awaited something foreign). */
	readonly auto: boolean;
}
export type CommitDecision = "commit" | "crash-before" | "crash-after" | "quota" | "lose-connection";
export type CommitHook = (info: CommitInfo) => CommitDecision;

export interface ForeignAwaitInfo {
	readonly db: string;
	readonly stores: readonly string[];
	readonly mode: "readonly" | "readwrite";
}

export interface MemStorageOptions {
	/** "idb" (default): emulate IndexedDB auto-commit on a foreign await. "off": post-settle detection only. */
	readonly inactive?: "idb" | "off";
	/** Real macrotask used by the idle check. Default: setImmediate / MessageChannel / setTimeout 0. */
	readonly macrotask?: (fn: () => void) => void;
	/**
	 * Extra idle-check trigger, e.g. VirtualClock.beforeNextTimer: guarantees the
	 * check runs before virtual time moves even when the clock loop's own real
	 * macrotask was queued first. Pass it in every simulation.
	 */
	readonly beforeNextTimer?: (fn: () => void) => void;
	/** Called whenever a tx auto-commits/finishes because its body awaited something foreign. */
	readonly onForeignAwait?: (info: ForeignAwaitInfo) => void;
}

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

export function memStorageError(failure: StorageFailure, message: string, cause?: unknown): StorageError {
	return new MemStorageError(failure, message, cause);
}

const err = memStorageError;

function asStorageError(e: unknown): StorageError {
	if (isStorageError(e)) return e;
	const o = typeof e === "object" && e !== null ? (e as { name?: unknown; message?: unknown }) : {};
	const name = typeof o.name === "string" ? o.name : "Error";
	const message = typeof o.message === "string" ? o.message : String(e);
	return err(name === "QuotaExceededError" ? "quota" : "unknown", `${name}: ${message}`, e);
}

const lost = (message: string): StorageError => err("connection-lost", message);
const DEAD = "storage port is dead (simulated crash)";

// ---------------------------------------------------------------------------
// Keys (indexedDB.cmp semantics)
// ---------------------------------------------------------------------------

type Key = number | string | Date | Uint8Array | readonly Key[];

function keyType(k: Key): number {
	if (typeof k === "number") return 0;
	if (k instanceof Date) return 1;
	if (typeof k === "string") return 2;
	if (k instanceof Uint8Array) return 3;
	return 4;
}

export function compareKeys(a: Key, b: Key): number {
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

/** Valid IDB key (normalized copy: binary -> plain Uint8Array, arrays copied), or undefined. */
function toKey(v: unknown, seen: Set<unknown> = new Set()): Key | undefined {
	if (typeof v === "number") return Number.isNaN(v) ? undefined : v;
	if (typeof v === "string") return v;
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : new Date(v.getTime());
	if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
	if (ArrayBuffer.isView(v)) {
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
	if (k === undefined) throw err("unknown", `DataError: ${what} is not a valid key`);
	return k;
}

function evalPath(value: unknown, path: string): unknown {
	if (path === "") return value;
	let cur = value;
	for (const part of path.split(".")) {
		if ((typeof cur === "string" || Array.isArray(cur)) && part === "length") cur = cur.length;
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

function normLimit(limit: number | undefined): number | undefined {
	if (limit === undefined) return undefined;
	if (typeof limit !== "number" || Number.isNaN(limit) || limit < 0) throw err("unknown", `invalid limit: ${String(limit)}`);
	return limit >= MAX_IDB_COUNT ? undefined : Math.floor(limit);
}

/** First i in [0, n] with pred(arr[i]); pred monotone false..true. */
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

/** [start, end) of the key-sorted elements inside the range. */
function rangeBounds<T>(arr: readonly T[], keyOf: (x: T) => Key, range: NormRange | null): [number, number] {
	const lower = range?.lower;
	const upper = range?.upper;
	const start = lower === undefined ? 0 : bisect(arr, (x) => (range!.lowerOpen ? compareKeys(keyOf(x), lower) > 0 : compareKeys(keyOf(x), lower) >= 0));
	const end = upper === undefined ? arr.length : bisect(arr, (x) => (range!.upperOpen ? compareKeys(keyOf(x), upper) >= 0 : compareKeys(keyOf(x), upper) > 0));
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
// Data model (plain data: structuredClone-able for crash())
// ---------------------------------------------------------------------------

interface IndexDef {
	readonly name: string;
	readonly keyPath: string | readonly string[];
	readonly unique: boolean;
}
interface NormSpec {
	readonly keyPath: string | readonly string[];
	readonly indexes: readonly IndexDef[];
}
interface Rec {
	readonly key: Key;
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

const copyStore = (sd: StoreData): StoreData => ({ spec: sd.spec, records: sd.records.slice(), indexes: sd.indexes.map((a) => a.slice()) });
const cmpEntry = (a: IndexEntry, b: IndexEntry): number => compareKeys(a.key, b.key) || compareKeys(a.primary, b.primary);

function insertEntry(arr: IndexEntry[], e: IndexEntry): void {
	arr.splice(bisect(arr, (x) => cmpEntry(x, e) >= 0), 0, e);
}

function removeEntry(arr: IndexEntry[], e: IndexEntry): void {
	const i = bisect(arr, (x) => cmpEntry(x, e) >= 0);
	const at = arr[i];
	if (at && cmpEntry(at, e) === 0) arr.splice(i, 1);
}

function findRecord(sd: StoreData, key: Key): number {
	const i = bisect(sd.records, (r) => compareKeys(r.key, key) >= 0);
	const at = sd.records[i];
	return at && compareKeys(at.key, key) === 0 ? i : -1;
}

function uniqueViolation(sd: StoreData, rec: Rec): string | null {
	for (let slot = 0; slot < sd.spec.indexes.length; slot++) {
		const def = sd.spec.indexes[slot] as IndexDef;
		const k = rec.ikeys[slot];
		if (!def.unique || k === undefined) continue;
		const arr = sd.indexes[slot] as IndexEntry[];
		const [s, e] = rangeBounds(arr, (x) => x.key, { lower: k, upper: k, lowerOpen: false, upperOpen: false });
		for (let i = s; i < e; i++) if (compareKeys((arr[i] as IndexEntry).primary, rec.key) !== 0) return `ConstraintError: unique index "${def.name}" already has this key`;
	}
	return null;
}

function removeRecordAt(sd: StoreData, i: number): void {
	const old = sd.records[i] as Rec;
	old.ikeys.forEach((k, slot) => {
		if (k !== undefined) removeEntry(sd.indexes[slot] as IndexEntry[], { key: k, primary: old.key });
	});
	sd.records.splice(i, 1);
}

function insertRecord(sd: StoreData, rec: Rec): void {
	const i = findRecord(sd, rec.key);
	if (i >= 0) removeRecordAt(sd, i);
	sd.records.splice(bisect(sd.records, (r) => compareKeys(r.key, rec.key) >= 0), 0, rec);
	rec.ikeys.forEach((k, slot) => {
		if (k !== undefined) insertEntry(sd.indexes[slot] as IndexEntry[], { key: k, primary: rec.key });
	});
}

/** A store with a fresh index set built from existing records; a message on unique violation. */
function buildStore(spec: NormSpec, records: readonly Rec[]): StoreData | string {
	const sd: StoreData = { spec, records: [], indexes: spec.indexes.map(() => []) };
	for (const r of records) {
		const rec: Rec = { key: r.key, value: r.value, ikeys: spec.indexes.map((ix) => keyFromPath(r.value, ix.keyPath)) };
		const v = uniqueViolation(sd, rec);
		if (v) return v;
		insertRecord(sd, rec);
	}
	return sd;
}

/** Creates missing stores and indexes (version 0 base = new DB). Throws StorageError. */
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
		if (typeof built === "string") throw err("unknown", `upgrade of "${base.name}" store "${name}" failed: ${built}`);
		stores.set(name, built);
	}
	return { name: base.name, version, stores };
}

// ---------------------------------------------------------------------------
// Transaction
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
	readonly queue: Ticket[];
}
interface Ticket {
	readonly mode: "readonly" | "readwrite";
	readonly done: Promise<void>;
	release(): void;
}

function newTicket(mode: "readonly" | "readwrite"): Ticket {
	let r!: () => void;
	const done = new Promise<void>((res) => (r = res));
	let released = false;
	return {
		mode,
		done,
		release() {
			if (released) return;
			released = true;
			r();
		},
	};
}

class MemTx implements LooseTx {
	/** Body settled. */
	settled = false;
	/** Finished early by the idle check (auto-commit / auto-finish). */
	finished = false;
	/** Commit failure of an auto-commit (quota, crash, lost connection). */
	finishError: StorageError | null = null;
	/** "explicit" = abort(); a StorageError = failed write / unique violation. */
	abortState: "explicit" | StorageError | null = null;
	readonly working = new Map<string, StoreData>();
	private ops = 0;
	private pending = 0;
	private armed = false;

	constructor(
		private readonly port: MemStoragePort,
		private readonly handle: MemDb<SchemaShape>,
		private readonly state: DbState,
		readonly scope: readonly string[],
		readonly mode: "readonly" | "readwrite",
		private readonly onIdle: (() => void) | null,
	) {}

	private check(): void {
		if (this.port.dead) throw lost(DEAD);
		if (this.handle.broken) throw lost(`database "${this.handle.name}" connection lost`);
		if (this.settled) throw err("tx-inactive", "transaction body already settled");
		if (this.finished) throw err("tx-inactive", "transaction already committed: the body awaited something that is not this transaction (IndexedDB auto-commit)");
		if (this.abortState !== null) throw err("tx-inactive", "transaction already aborted");
	}

	/** Arms the idle check (idb mode). */
	arm(): void {
		if (this.onIdle === null || this.armed) return;
		this.armed = true;
		const at = this.ops;
		let fired = false;
		const fire = () => {
			if (fired) return;
			fired = true;
			this.armed = false;
			if (this.settled || this.finished) return;
			if (this.pending > 0 || this.ops !== at) {
				this.arm();
				return;
			}
			this.onIdle!();
		};
		this.port.macrotask(fire);
		this.port.beforeNextTimer?.(fire);
	}

	private touch(): void {
		this.ops++;
		this.arm();
	}

	private readStore(name: string): StoreData {
		if (!this.scope.includes(name)) throw err("unknown", `NotFoundError: store "${name}" is not in this transaction's scope`);
		const sd = this.working.get(name) ?? this.state.data.stores.get(name);
		if (!sd) throw err("unknown", `NotFoundError: no store "${name}"`);
		return sd;
	}

	private writeStore(name: string): StoreData {
		if (this.mode !== "readwrite") throw err("unknown", "ReadOnlyError: write in a readonly transaction");
		const w = this.working.get(name);
		if (w) return w;
		const copy = copyStore(this.readStore(name));
		this.working.set(name, copy);
		return copy;
	}

	private slot(sd: StoreData, index: string): number {
		const s = sd.spec.indexes.findIndex((d) => d.name === index);
		if (s < 0) throw err("unknown", `NotFoundError: no index "${index}"`);
		return s;
	}

	/** Executes the request now (requests run in issue order), delivers the result in a microtask. */
	private read<R>(fn: () => R): Promise<R> {
		let result: { ok: true; v: R } | { ok: false; e: StorageError };
		try {
			this.check();
			result = { ok: true, v: fn() };
		} catch (e) {
			result = { ok: false, e: asStorageError(e) };
		}
		this.pending++;
		this.ops++;
		return Promise.resolve().then(() => {
			this.pending--;
			this.arm();
			if (!result.ok) throw result.e;
			return result.v;
		});
	}

	private write(fn: () => void): void {
		this.check();
		this.touch();
		try {
			fn();
		} catch (e) {
			const se = asStorageError(e);
			this.fail(se);
			throw se;
		}
	}

	fail(se: StorageError): void {
		if (this.abortState !== null) return;
		this.abortState = se;
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
			const n = normLimit(limit);
			return sd.records.slice(s, n === undefined ? e : Math.min(e, s + n)).map((r) => clone(r.value));
		});
	}

	getAllKeys(store: string, range?: KeyRange, limit?: number): Promise<unknown[]> {
		return this.read(() => {
			const sd = this.readStore(store);
			const [s, e] = rangeBounds(sd.records, (r) => r.key, normRange(range));
			const n = normLimit(limit);
			return sd.records.slice(s, n === undefined ? e : Math.min(e, s + n)).map((r) => clone(r.key));
		});
	}

	getAllByIndex(store: string, index: string, range?: KeyRange, limit?: number): Promise<unknown[]> {
		return this.read(() => {
			const sd = this.readStore(store);
			const arr = sd.indexes[this.slot(sd, index)] as IndexEntry[];
			const [s, e] = rangeBounds(arr, (x) => x.key, normRange(range));
			const n = normLimit(limit);
			return arr.slice(s, n === undefined ? e : Math.min(e, s + n)).map((entry) => clone((sd.records[findRecord(sd, entry.primary)] as Rec).value));
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
			const arr = sd.indexes[this.slot(sd, index)] as IndexEntry[];
			const [s, e] = rangeBounds(arr, (x) => x.key, normRange(range));
			return e - s;
		});
	}

	put(store: string, record: object): void {
		this.write(() => {
			const sd = this.writeStore(store);
			const value = clone(record);
			const key = keyFromPath(value, sd.spec.keyPath);
			if (key === undefined) throw err("unknown", `DataError: record has no valid key at keyPath ${JSON.stringify(sd.spec.keyPath)}`);
			const rec: Rec = { key, value, ikeys: sd.spec.indexes.map((ix) => keyFromPath(value, ix.keyPath)) };
			const v = uniqueViolation(sd, rec);
			if (v) {
				this.fail(err("unknown", v));
				return;
			}
			insertRecord(sd, rec);
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
			if (s === 0 && e === sd.records.length) {
				sd.records.length = 0;
				for (const a of sd.indexes) a.length = 0;
				return;
			}
			for (let i = e - 1; i >= s; i--) removeRecordAt(sd, i);
		});
	}

	abort(): void {
		if (this.port.dead) throw lost(DEAD);
		if (this.settled) throw err("tx-inactive", "transaction body already settled");
		if (this.finished) throw err("tx-inactive", "transaction already committed (IndexedDB auto-commit)");
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

	/** versionchange / delete (abnormal = false) or connection loss (abnormal = true). */
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

const idle = (st: DbState): Promise<void> => Promise.all(st.queue.map((t) => t.done)).then(() => undefined);

export class MemStoragePort implements StoragePort {
	/** Committed readwrite txs across all databases of this port. */
	commitCount = 0;
	/** Txs finished early because their body awaited something foreign (idb mode). */
	foreignAwaits = 0;
	/** @internal */
	readonly macrotask: (fn: () => void) => void;
	/** @internal */
	readonly beforeNextTimer: ((fn: () => void) => void) | undefined;
	private deadFlag = false;
	private hook: CommitHook | null = null;
	private readonly dbs = new Map<string, DbState>();
	private readonly connQueues = new Map<string, Promise<void>>();

	constructor(private readonly options: MemStorageOptions = {}) {
		this.macrotask = options.macrotask ?? realMacrotaskCallback();
		this.beforeNextTimer = options.beforeNextTimer;
	}

	/** True after a simulated crash (commit hook or crash()). */
	get dead(): boolean {
		return this.deadFlag;
	}

	setCommitHook(fn: CommitHook | null): void {
		this.hook = fn;
	}

	/** Crash just before (not committed) or just after (committed) the readwrite commit with this index. */
	crashAtCommit(index: number, when: "before" | "after" = "before"): void {
		this.hook = (info) => (info.index === index ? (when === "before" ? "crash-before" : "crash-after") : "commit");
	}

	/** Kills this port; returns a new live port with a deep copy of every database's committed state. */
	crash(): MemStoragePort {
		this.deadFlag = true;
		const next = new MemStoragePort(this.options);
		for (const [name, st] of this.dbs) next.dbs.set(name, { data: structuredClone(st.data), handles: new Set(), queue: [] });
		return next;
	}

	/** Abnormal close (WebKit "connection lost") of every open handle on `name`. */
	loseConnection(name: string): void {
		const st = this.dbs.get(name);
		if (!st) return;
		for (const h of Array.from(st.handles)) h.lose(true);
	}

	/** Committed records of every store of `name` in key order (clones); null if no such database. */
	dump(name: string): Record<string, unknown[]> | null {
		const st = this.dbs.get(name);
		if (!st) return null;
		const out: Record<string, unknown[]> = {};
		for (const [store, sd] of st.data.stores) out[store] = sd.records.map((r) => clone(r.value));
		return out;
	}

	/** Committed version of `name`, or 0. */
	version(name: string): number {
		return this.dbs.get(name)?.data.version ?? 0;
	}

	private alive(): void {
		if (this.deadFlag) throw lost(DEAD);
	}

	/** open/delete requests on one name run one at a time (IDB connection queue). */
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
		this.alive();
		if (!Number.isInteger(version) || version < 1) throw err("unknown", `TypeError: invalid database version ${String(version)}`);
		return this.serial(name, async () => {
			this.alive();
			let st = this.dbs.get(name);
			if (st && st.data.version > version) throw err("unknown", `VersionError: "${name}" is at version ${st.data.version} > requested ${version}`);
			if (!st || st.data.version < version) {
				if (st) {
					for (const h of Array.from(st.handles)) h.lose(false);
					await idle(st);
					this.alive();
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
		this.alive();
		await this.serial(name, async () => {
			this.alive();
			const st = this.dbs.get(name);
			if (!st) return;
			for (const h of Array.from(st.handles)) h.lose(false);
			await idle(st);
			this.alive();
			if (this.dbs.get(name) === st) this.dbs.delete(name);
		});
	}

	async listDatabases(): Promise<readonly string[]> {
		this.alive();
		return Array.from(this.dbs.keys()).sort();
	}

	async requestPersistence(): Promise<boolean> {
		this.alive();
		return true;
	}

	/** @internal Used by MemDb.tx. */
	async runTx<T>(handle: MemDb<SchemaShape>, stores: readonly string[], mode: "readonly" | "readwrite", body: (tx: LooseTx) => Promise<T>): Promise<T> {
		this.alive();
		if (handle.closed) throw lost(`database "${handle.name}" connection is closed`);
		const st = handle.state;
		if (stores.length === 0) throw err("unknown", "InvalidAccessError: empty transaction scope");
		for (const s of stores) if (!st.data.stores.has(s)) throw err("unknown", `NotFoundError: no store "${s}" in "${handle.name}"`);

		const deps = st.queue.filter((t) => mode === "readwrite" || t.mode === "readwrite").map((t) => t.done);
		const ticket = newTicket(mode);
		st.queue.push(ticket);
		const dequeue = () => {
			const i = st.queue.indexOf(ticket);
			if (i >= 0) st.queue.splice(i, 1);
			ticket.release();
		};
		try {
			if (deps.length > 0) await Promise.all(deps);
			this.alive();
			if (handle.broken) throw lost(`database "${handle.name}" connection lost`);

			let tx: MemTx | null = null;
			const onIdle = this.options.inactive === "off" ? null : () => this.autoFinish(handle, tx!, dequeue);
			tx = new MemTx(this, handle, st, stores.slice(), mode, onIdle);
			let outcome: { ok: true; v: T } | { ok: false; e: unknown };
			let p: Promise<T>;
			try {
				p = Promise.resolve(body(tx));
			} catch (e) {
				p = Promise.reject(e);
			}
			tx.arm();
			outcome = await p.then(
				(v) => ({ ok: true as const, v }),
				(e: unknown) => ({ ok: false as const, e }),
			);
			tx.settled = true;

			this.alive();
			if (handle.broken) throw lost(`database "${handle.name}" connection lost`);
			if (tx.abortState === "explicit") throw err("aborted", "transaction aborted");
			if (tx.abortState !== null) throw tx.abortState;
			if (tx.finished) {
				if (tx.finishError) throw tx.finishError;
				if (!outcome.ok) throw outcome.e;
				return outcome.v;
			}
			if (!outcome.ok) throw outcome.e;
			if (mode === "readwrite") this.commit(st, tx, false);
			return outcome.v;
		} finally {
			dequeue();
		}
	}

	/** The body awaited something foreign: finish the tx the way IndexedDB would. */
	private autoFinish(handle: MemDb<SchemaShape>, tx: MemTx, dequeue: () => void): void {
		const st = handle.state;
		tx.finished = true;
		this.foreignAwaits++;
		if (handle.broken) tx.finishError = lost(`database "${handle.name}" connection lost`);
		else if (!this.deadFlag && tx.abortState === null && tx.mode === "readwrite") {
			try {
				this.commit(st, tx, true);
			} catch (e) {
				tx.finishError = asStorageError(e);
			}
		}
		dequeue();
		this.options.onForeignAwait?.({ db: st.data.name, stores: tx.scope, mode: tx.mode });
	}

	private commit(st: DbState, tx: MemTx, auto: boolean): void {
		const info: CommitInfo = { db: st.data.name, index: this.commitCount, stores: tx.scope.slice(), auto };
		const decision = this.hook ? this.hook(info) : "commit";
		switch (decision) {
			case "crash-before":
				this.deadFlag = true;
				throw lost(`simulated crash before commit #${info.index} on "${info.db}"`);
			case "quota":
				throw err("quota", `QuotaExceededError: simulated quota failure at commit #${info.index} on "${info.db}"`);
			case "lose-connection":
				for (const h of Array.from(st.handles)) h.lose(true);
				throw lost(`simulated connection loss at commit #${info.index} on "${info.db}"`);
			default:
				break;
		}
		for (const [name, sd] of tx.working) st.data.stores.set(name, sd);
		this.commitCount++;
		if (decision === "crash-after") {
			this.deadFlag = true;
			throw lost(`simulated crash after commit #${info.index} on "${info.db}"`);
		}
	}
}
