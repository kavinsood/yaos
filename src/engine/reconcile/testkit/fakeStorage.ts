/**
 * In-memory StoragePort for WP-B tests (stand-in for WP-A's MemStoragePort).
 * Honest to the port contract where it matters for the disk side:
 *  - tx() is atomic: writes become visible to other txs only on commit;
 *    a rejected/aborted body discards them;
 *  - values are structured-cloned on put and get;
 *  - reads inside a tx see the tx's own earlier writes;
 *  - crash(): every committed tx survives, nothing else (open handles die);
 *  - tx bodies run one at a time (IDB serializes overlapping readwrite txs);
 *  - a tx used after its body settled throws "tx-inactive".
 * Ordering follows IndexedDB: number < string < binary < array.
 */

import type {
	KeyRange, SchemaShape, StorageDb, StorageError, StorageFailure, StorageKey, StoragePort, StorageTx, StoreName, StoreSpec,
} from "../../../ports/storage";
import type { Unsubscribe } from "../../../ports/common";

function storageError(failure: StorageFailure, message: string): StorageError {
	const e = new Error(message) as Error & { failure: StorageFailure };
	e.name = "StorageError";
	e.failure = failure;
	return e as StorageError;
}

function typeRank(k: StorageKey): number {
	if (typeof k === "number") return 1;
	if (typeof k === "string") return 2;
	if (k instanceof Uint8Array) return 3;
	return 4;
}

export function compareKeys(a: StorageKey, b: StorageKey): number {
	const ra = typeRank(a);
	const rb = typeRank(b);
	if (ra !== rb) return ra - rb;
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
	if (a instanceof Uint8Array && b instanceof Uint8Array) {
		const n = Math.min(a.length, b.length);
		for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
		return a.length - b.length;
	}
	const aa = a as readonly StorageKey[];
	const bb = b as readonly StorageKey[];
	const n = Math.min(aa.length, bb.length);
	for (let i = 0; i < n; i++) {
		const c = compareKeys(aa[i]!, bb[i]!);
		if (c !== 0) return c;
	}
	return aa.length - bb.length;
}

function encodeKey(k: StorageKey): string {
	if (typeof k === "number") return `n${k}`;
	if (typeof k === "string") return `s${k}`;
	if (k instanceof Uint8Array) return `b${Array.from(k).join(",")}`;
	return `a[${(k as readonly StorageKey[]).map(encodeKey).join("\u0001")}]`;
}

function extract(record: object, keyPath: string | readonly string[]): StorageKey | undefined {
	const r = record as Record<string, unknown>;
	const one = (p: string): StorageKey | undefined => {
		const v = r[p];
		if (typeof v === "number" || typeof v === "string" || v instanceof Uint8Array) return v;
		if (Array.isArray(v)) return v as StorageKey[];
		return undefined;
	};
	if (typeof keyPath === "string") return one(keyPath);
	const parts: StorageKey[] = [];
	for (const p of keyPath) {
		const v = one(p);
		if (v === undefined) return undefined;
		parts.push(v);
	}
	return parts;
}

function inRange(k: StorageKey, range: KeyRange | undefined): boolean {
	if (!range) return true;
	if (range.lower !== undefined) {
		const c = compareKeys(k, range.lower);
		if (c < 0 || (c === 0 && range.lowerOpen)) return false;
	}
	if (range.upper !== undefined) {
		const c = compareKeys(k, range.upper);
		if (c > 0 || (c === 0 && range.upperOpen)) return false;
	}
	return true;
}

interface Row { key: StorageKey; value: object }
type StoreRows = Map<string, Row>;

interface DbState {
	version: number;
	specs: Record<string, StoreSpec>;
	stores: Map<string, StoreRows>;
}

const DELETED = Symbol("deleted");

export class FakeStorage implements StoragePort {
	private readonly dbs = new Map<string, DbState>();
	private readonly handles = new Set<FakeDb<SchemaShape>>();
	/** Committed transactions so far (crash-point enumeration in tests). */
	commits = 0;
	/** Called after every commit with the running count; throw to simulate a crash right after it. */
	afterCommit: ((n: number) => void) | null = null;
	/** Called before every commit; throw to simulate a crash before it (the tx is lost). */
	beforeCommit: ((n: number) => void) | null = null;

	async open<S extends SchemaShape>(name: string, version: number, stores: Readonly<Record<StoreName<S>, StoreSpec>>): Promise<StorageDb<S>> {
		let st = this.dbs.get(name);
		if (!st || st.version < version) {
			const prev = st;
			st = { version, specs: { ...(stores as Record<string, StoreSpec>) }, stores: new Map() };
			for (const s of Object.keys(stores)) st.stores.set(s, prev?.stores.get(s) ?? new Map());
			this.dbs.set(name, st);
		}
		const db = new FakeDb<S>(name, st, this);
		this.handles.add(db as unknown as FakeDb<SchemaShape>);
		return db;
	}

	async deleteDatabase(name: string): Promise<void> {
		this.dbs.delete(name);
	}

	async listDatabases(): Promise<readonly string[]> {
		return [...this.dbs.keys()].sort();
	}

	async requestPersistence(): Promise<boolean> {
		return true;
	}

	/** Process death: open handles stop working; committed state stays. */
	crash(): void {
		for (const h of this.handles) h.kill();
		this.handles.clear();
	}

	/** Test helper: committed rows of a store (cloned). */
	dump(dbName: string, store: string): object[] {
		const rows = this.dbs.get(dbName)?.stores.get(store);
		if (!rows) return [];
		return [...rows.values()].sort((a, b) => compareKeys(a.key, b.key)).map((r) => structuredClone(r.value));
	}

	/** @internal */
	noteCommit(phase: "before" | "after"): void {
		if (phase === "before") this.beforeCommit?.(this.commits + 1);
		else {
			this.commits++;
			this.afterCommit?.(this.commits);
		}
	}
}

class FakeDb<S extends SchemaShape> implements StorageDb<S> {
	private dead = false;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly lostListeners = new Set<(f: StorageFailure) => void>();

	constructor(readonly name: string, private readonly state: DbState, private readonly owner: FakeStorage) {}

	kill(): void {
		this.dead = true;
		for (const l of this.lostListeners) l("connection-lost");
	}

	close(): void {
		this.dead = true;
	}

	onLost(listener: (failure: StorageFailure) => void): Unsubscribe {
		this.lostListeners.add(listener);
		return () => this.lostListeners.delete(listener);
	}

	tx<T>(stores: readonly StoreName<S>[], mode: "readonly" | "readwrite", body: (tx: StorageTx<S>) => Promise<T>): Promise<T> {
		const run = async (): Promise<T> => {
			if (this.dead) throw storageError("connection-lost", "db closed");
			for (const s of stores) if (!this.state.stores.has(s)) throw storageError("unknown", `no store ${s}`);
			const overlay = new Map<string, Map<string, Row | typeof DELETED>>();
			let active = true;
			let aborted = false;
			const check = (store: string, write: boolean): StoreRows => {
				if (!active) throw storageError("tx-inactive", "transaction is not active");
				if (aborted) throw storageError("aborted", "aborted");
				if (!(stores as readonly string[]).includes(store)) throw storageError("unknown", `store ${store} not in tx scope`);
				if (write && mode !== "readwrite") throw storageError("unknown", "readonly tx");
				return this.state.stores.get(store)!;
			};
			const view = (store: string): Row[] => {
				const base = this.state.stores.get(store)!;
				const ov = overlay.get(store);
				const out = new Map<string, Row>(base);
				if (ov) for (const [k, v] of ov) v === DELETED ? out.delete(k) : out.set(k, v);
				return [...out.values()].sort((a, b) => compareKeys(a.key, b.key));
			};
			const indexKeyPath = (store: string, index: string): string | readonly string[] => {
				const spec = this.state.specs[store]!;
				const ix = spec.indexes[index];
				if (!ix) throw storageError("unknown", `no index ${index}`);
				return ix.keyPath;
			};
			const tx: StorageTx<S> = {
				get: async (store, key) => {
					check(store, false);
					const ov = overlay.get(store)?.get(encodeKey(key));
					if (ov === DELETED) return undefined;
					const row = ov ?? this.state.stores.get(store)!.get(encodeKey(key));
					return row ? (structuredClone(row.value) as S[typeof store]["record"]) : undefined;
				},
				getAll: async (store, range, limit) => {
					check(store, false);
					const rows = view(store).filter((r) => inRange(r.key, range));
					return rows.slice(0, limit ?? rows.length).map((r) => structuredClone(r.value) as S[typeof store]["record"]);
				},
				getAllKeys: async (store, range, limit) => {
					check(store, false);
					const rows = view(store).filter((r) => inRange(r.key, range));
					return rows.slice(0, limit ?? rows.length).map((r) => structuredClone(r.key) as S[typeof store]["key"]);
				},
				getAllByIndex: async (store, index, range, limit) => {
					check(store, false);
					const kp = indexKeyPath(store, index);
					const rows = view(store)
						.map((r) => ({ r, ik: extract(r.value, kp) }))
						.filter((x): x is { r: Row; ik: StorageKey } => x.ik !== undefined && inRange(x.ik, range))
						.sort((a, b) => compareKeys(a.ik, b.ik) || compareKeys(a.r.key, b.r.key));
					return rows.slice(0, limit ?? rows.length).map((x) => structuredClone(x.r.value) as S[typeof store]["record"]);
				},
				count: async (store, range) => {
					check(store, false);
					return view(store).filter((r) => inRange(r.key, range)).length;
				},
				countByIndex: async (store, index, range) => {
					check(store, false);
					const kp = indexKeyPath(store, index);
					return view(store).filter((r) => {
						const ik = extract(r.value, kp);
						return ik !== undefined && inRange(ik, range);
					}).length;
				},
				put: (store, record) => {
					check(store, true);
					const key = extract(record, this.state.specs[store]!.keyPath);
					if (key === undefined) throw storageError("unknown", `record has no key for ${store}`);
					let ov = overlay.get(store);
					if (!ov) overlay.set(store, (ov = new Map()));
					ov.set(encodeKey(key), { key: structuredClone(key), value: structuredClone(record) });
				},
				delete: (store, key) => {
					check(store, true);
					let ov = overlay.get(store);
					if (!ov) overlay.set(store, (ov = new Map()));
					ov.set(encodeKey(key), DELETED);
				},
				deleteRange: (store, range) => {
					check(store, true);
					let ov = overlay.get(store);
					if (!ov) overlay.set(store, (ov = new Map()));
					for (const r of view(store)) if (inRange(r.key, range)) ov.set(encodeKey(r.key), DELETED);
				},
				abort: () => {
					aborted = true;
				},
			};
			let result: T;
			try {
				result = await body(tx);
			} finally {
				active = false;
			}
			if (aborted) throw storageError("aborted", "aborted");
			if (this.dead) throw storageError("connection-lost", "db closed during tx");
			if (mode === "readwrite" && overlay.size > 0) {
				this.owner.noteCommit("before");
				for (const [store, ov] of overlay) {
					const rows = this.state.stores.get(store)!;
					for (const [k, v] of ov) v === DELETED ? rows.delete(k) : rows.set(k, v);
				}
				this.owner.noteCommit("after");
			}
			return result;
		};
		const p = this.queue.then(run, run);
		this.queue = p.catch(() => undefined);
		return p;
	}
}
