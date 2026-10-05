/**
 * StoragePort conformance suite, run against both implementations:
 *  - createIdbStoragePort over a fresh fake-indexeddb IDBFactory per test;
 *  - MemStoragePort (src/engine/sync/__standins__/memStorage.ts).
 * Implementation-specific behaviour lives in idbStorage.test.ts and
 * memStorage.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { KeyRange, StorageDb, StorageError, StorageFailure, StorageKey, StoragePort } from "../../ports/storage";
import { isStorageError } from "../../ports/storage";
import type { ClientFrameId, DeviceId, StreamName } from "../../core/types";
import {
	DB_SCHEMA_VERSION, INDEX, STORE, STORE_SPECS, tailRange,
	type MetaRecord, type OutboxRecord, type OutboxState, type SnapshotRecord, type StreamRecord, type TailRecord,
	type YaosSchema as YaosSchemaInterface,
} from "../store/schema";
import { createIdbStoragePort } from "./idbStorage";
import { MemStoragePort } from "../sync/__standins__/memStorage";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * `YaosSchema` is declared as an `interface`, and interfaces get no implicit
 * index signature, so it does not satisfy `SchemaShape` directly. A mapped
 * type alias over it does.
 */
type YaosSchema = { readonly [K in keyof YaosSchemaInterface]: YaosSchemaInterface[K] };

const S = (s: string): StreamName => s as StreamName;
const F = (s: string): ClientFrameId => s as ClientFrameId;
const MAX = Number.MAX_SAFE_INTEGER;

function outbox(id: string, order: number, state: OutboxState = "pending", stream = "b:doc1"): OutboxRecord {
	return {
		clientFrameId: F(id), order, stream: S(stream), kind: "bodyUpdate", state,
		sealed: new Uint8Array([order & 255, 1, 2, 3]), content: new Uint8Array([order & 255]),
		authorNsSeq: 0, flags: 0, dependsOn: null, adoptOf: null, attempts: 0, createdAtMs: 1000 + order, lastSentAtMs: 0,
	};
}

function tail(stream: string, seq: number): TailRecord {
	return {
		stream: S(stream), seq, deviceId: "dev1" as DeviceId, clientFrameId: F(`cf:${stream}:${seq}`), kind: "bodyUpdate",
		authorNsSeq: 0, flags: 0, content: new Uint8Array([seq & 255, 0xaa, 0xbb]),
	};
}

function streamRec(stream: string, stale: 0 | 1, priority: number, lastAccessMs = 0): StreamRecord {
	return {
		stream: S(stream), cls: "body", docId: null, appliedSeq: 0, remoteHeadSeq: stale, stale, priority, snapshotCoversSeq: 0,
		tailRows: 0, tailBytes: 0, remoteCheckpointCoversSeq: 0, rowsSinceRemoteCheckpoint: 0, bytesSinceRemoteCheckpoint: 0,
		lastOwnSeq: 0, bodyVersion: { remoteSeq: 0, localOrder: 0 }, quarantinedRows: 0, frozen: 0, frozenReason: null,
		disputedCheckpointCoversSeq: 0, lastAccessMs, textHash: null,
	};
}

/** Small custom schema for key-ordering / index-validity cases. */
type KvRecord = { readonly k: StorageKey; readonly v?: unknown; readonly u?: unknown };
type KvSchema = { readonly kv: { readonly record: KvRecord; readonly key: StorageKey; readonly indexes: "byV" | "byU" } };
const KV_SPECS = { kv: { keyPath: "k", indexes: { byV: { keyPath: "v", unique: false }, byU: { keyPath: "u", unique: true } } } } as const;
const KV_SPECS_NO_INDEX = { kv: { keyPath: "k", indexes: {} } } as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function throwsWith(fn: () => void, failure: StorageFailure): StorageError {
	try {
		fn();
	} catch (e) {
		assert.ok(isStorageError(e), `expected a StorageError, got ${String(e)}`);
		assert.equal(e.failure, failure, `failure (${e.message})`);
		return e;
	}
	return assert.fail(`expected a throw with "${failure}"`);
}

const DB = "yaos2:vault:epoch:device";

function openYaos(port: StoragePort, name = DB): Promise<StorageDb<YaosSchema>> {
	return port.open<YaosSchema>(name, DB_SCHEMA_VERSION, STORE_SPECS);
}

function openKv(port: StoragePort, name = "kv", version = 1): Promise<StorageDb<KvSchema>> {
	return port.open<KvSchema>(name, version, KV_SPECS);
}

const ALL_STORES = Object.keys(STORE_SPECS) as (keyof YaosSchema)[];

interface Impl {
	readonly name: string;
	readonly make: () => StoragePort;
}

const IMPLS: readonly Impl[] = [
	{ name: "IdbStoragePort (fake-indexeddb)", make: () => createIdbStoragePort(new IDBFactory(), IDBKeyRange) },
	{ name: "MemStoragePort", make: () => new MemStoragePort() },
];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

for (const impl of IMPLS) {
	describe(`StoragePort conformance: ${impl.name}`, () => {
		it("opens the real schema, reopens at the same version, lists and deletes databases", async () => {
			const port = impl.make();
			const db = await openYaos(port);
			assert.equal(db.name, DB);
			assert.ok((await port.listDatabases()).includes(DB));
			const counts = await db.tx(ALL_STORES, "readonly", async (tx) => Promise.all(ALL_STORES.map((s) => tx.count(s))));
			assert.deepEqual(counts, ALL_STORES.map(() => 0));
			await db.tx([STORE.meta], "readwrite", async (tx) => {
				tx.put(STORE.meta, { key: "cursor", vaultSeq: 7, headSeqSeen: 9 });
			});
			db.close();

			const again = await openYaos(port);
			assert.deepEqual(await again.tx([STORE.meta], "readonly", (tx) => tx.get(STORE.meta, "cursor")), { key: "cursor", vaultSeq: 7, headSeqSeen: 9 });
			again.close();

			await port.deleteDatabase(DB);
			assert.ok(!(await port.listDatabases()).includes(DB));
			const fresh = await openYaos(port);
			assert.equal(await fresh.tx([STORE.meta], "readonly", (tx) => tx.count(STORE.meta)), 0);
			fresh.close();
			assert.equal(typeof (await port.requestPersistence()), "boolean");
		});

		it("put / get / delete round-trip", async () => {
			const db = await openYaos(impl.make());
			const o = outbox("f1", 1);
			await db.tx([STORE.outbox, STORE.meta], "readwrite", async (tx) => {
				tx.put(STORE.outbox, o);
				tx.put(STORE.meta, { key: "outboxOrder", next: 2 });
			});
			const [got, missing, meta] = await db.tx([STORE.outbox, STORE.meta], "readonly", async (tx) =>
				Promise.all([tx.get(STORE.outbox, F("f1")), tx.get(STORE.outbox, F("nope")), tx.get(STORE.meta, "outboxOrder")]),
			);
			assert.deepEqual(got, o);
			assert.equal(missing, undefined);
			assert.deepEqual(meta, { key: "outboxOrder", next: 2 });

			// put replaces by key
			await db.tx([STORE.outbox], "readwrite", async (tx) => {
				tx.put(STORE.outbox, { ...o, state: "sent", attempts: 1 });
			});
			assert.equal((await db.tx([STORE.outbox], "readonly", (tx) => tx.get(STORE.outbox, F("f1"))))?.state, "sent");
			assert.equal(await db.tx([STORE.outbox], "readonly", (tx) => tx.count(STORE.outbox)), 1);

			await db.tx([STORE.outbox], "readwrite", async (tx) => {
				tx.delete(STORE.outbox, F("f1"));
				tx.delete(STORE.outbox, F("never-existed"));
			});
			assert.equal(await db.tx([STORE.outbox], "readonly", (tx) => tx.get(STORE.outbox, F("f1"))), undefined);
		});

		it("reads see the tx's own writes; long await chains keep the tx alive", async () => {
			const db = await openYaos(impl.make());
			const result = await db.tx([STORE.meta, STORE.outbox], "readwrite", async (tx) => {
				tx.put(STORE.meta, { key: "outboxOrder", next: 1 });
				for (let i = 0; i < 25; i++) {
					const m = (await tx.get(STORE.meta, "outboxOrder")) as Extract<MetaRecord, { key: "outboxOrder" }>;
					await Promise.resolve(); // microtasks are fine
					tx.put(STORE.outbox, outbox(`f${m.next}`, m.next));
					tx.put(STORE.meta, { key: "outboxOrder", next: m.next + 1 });
				}
				return tx.count(STORE.outbox);
			});
			assert.equal(result, 25);
			assert.deepEqual(await db.tx([STORE.meta], "readonly", (tx) => tx.get(STORE.meta, "outboxOrder")), { key: "outboxOrder", next: 26 });
		});

		it("tail: getAll with tailRange and limit, getAllKeys, count, empty ranges", async () => {
			const db = await openYaos(impl.make());
			await db.tx([STORE.tail], "readwrite", async (tx) => {
				// insertion order deliberately scrambled
				for (const seq of [5, 1, 3, 2, 4]) tx.put(STORE.tail, tail("b:a", seq));
				tx.put(STORE.tail, tail("b:b", 4));
				tx.put(STORE.tail, tail("b:aa", 1));
				tx.put(STORE.tail, tail("b:b", 2));
			});
			const seqs = (rows: TailRecord[]): number[] => rows.map((r) => r.seq);
			await db.tx([STORE.tail], "readonly", async (tx) => {
				assert.deepEqual(seqs(await tx.getAll(STORE.tail, tailRange(S("b:a")))), [1, 2, 3, 4, 5]);
				assert.deepEqual(seqs(await tx.getAll(STORE.tail, tailRange(S("b:a"), 2))), [3, 4, 5]);
				assert.deepEqual(seqs(await tx.getAll(STORE.tail, tailRange(S("b:a"), 1, 3))), [2, 3]);
				assert.deepEqual(seqs(await tx.getAll(STORE.tail, tailRange(S("b:a"), 1), 2)), [2, 3]);
				assert.deepEqual(seqs(await tx.getAll(STORE.tail, tailRange(S("b:a")), 0)), []);
				assert.deepEqual(await tx.getAllKeys(STORE.tail, tailRange(S("b:b"))), [["b:b", 2], ["b:b", 4]]);
				assert.deepEqual(await tx.getAllKeys(STORE.tail, tailRange(S("b:a"), 0), 1), [["b:a", 1]]);
				assert.equal(await tx.count(STORE.tail, tailRange(S("b:a"))), 5);
				assert.equal(await tx.count(STORE.tail), 8);
				// whole store in key order: "b:a" < "b:aa" < "b:b"
				assert.deepEqual(
					(await tx.getAll(STORE.tail)).map((r) => `${r.stream}/${r.seq}`),
					["b:a/1", "b:a/2", "b:a/3", "b:a/4", "b:a/5", "b:aa/1", "b:b/2", "b:b/4"],
				);
				// empty and inverted ranges match nothing (instead of IDB's DataError)
				assert.deepEqual(await tx.getAll(STORE.tail, tailRange(S("b:a"), 3, 3)), []);
				assert.deepEqual(await tx.getAllKeys(STORE.tail, tailRange(S("b:a"), 4, 2)), []);
				assert.equal(await tx.count(STORE.tail, tailRange(S("b:a"), 3, 3)), 0);
				assert.deepEqual(seqs(await tx.getAll(STORE.tail, tailRange(S("b:zz")))), []);
			});
		});

		it("outbox indexes: byStateOrder / byStreamOrder / byOrder ranges and countByIndex", async () => {
			const db = await openYaos(impl.make());
			const recs = [
				outbox("a", 1, "pending", "b:x"),
				outbox("b", 2, "sent", "b:y"),
				outbox("c", 3, "pending", "b:y"),
				outbox("d", 4, "held", "b:x"),
				outbox("e", 5, "pending", "b:x"),
				outbox("f", 6, "sent", "b:x"),
			];
			await db.tx([STORE.outbox], "readwrite", async (tx) => {
				for (const r of [...recs].reverse()) tx.put(STORE.outbox, r);
			});
			const ids = (rows: OutboxRecord[]): string[] => rows.map((r) => r.clientFrameId);
			const state = (s: OutboxState, from = 0, lowerOpen = false): KeyRange => ({ lower: [s, from], upper: [s, MAX], lowerOpen });
			await db.tx([STORE.outbox], "readonly", async (tx) => {
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByState, state("pending"))), ["a", "c", "e"]);
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByState, state("pending", 1, true))), ["c", "e"]);
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByState, state("pending"), 2)), ["a", "c"]);
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByState, state("sent"))), ["b", "f"]);
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByState, state("poisoned"))), []);
				// whole index: "held" < "pending" < "sent"
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByState)), ["d", "a", "c", "e", "b", "f"]);
				assert.equal(await tx.countByIndex(STORE.outbox, INDEX.outboxByState, state("pending")), 3);
				assert.equal(await tx.countByIndex(STORE.outbox, INDEX.outboxByState), 6);

				const stream = (s: string): KeyRange => ({ lower: [s, 0], upper: [s, MAX] });
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByStream, stream("b:x"))), ["a", "d", "e", "f"]);
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByStream, stream("b:y"))), ["b", "c"]);
				assert.equal(await tx.countByIndex(STORE.outbox, INDEX.outboxByStream, stream("b:x")), 4);

				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByOrder, { lower: 4 })), ["d", "e", "f"]);
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByOrder, { lower: 4, lowerOpen: true })), ["e", "f"]);
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByOrder, { upper: 2 })), ["a", "b"]);
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByOrder, { upper: 2, upperOpen: true })), ["a"]);
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByOrder, { lower: 2, upper: 4, lowerOpen: true, upperOpen: true })), ["c"]);
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByOrder, { lower: 5, upper: 5, upperOpen: true })), []);
			});

			// index entries follow updates and deletes
			await db.tx([STORE.outbox], "readwrite", async (tx) => {
				tx.put(STORE.outbox, { ...recs[0]!, state: "sent" });
				tx.delete(STORE.outbox, F("c"));
			});
			await db.tx([STORE.outbox], "readonly", async (tx) => {
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByState, state("pending"))), ["e"]);
				assert.deepEqual(ids(await tx.getAllByIndex(STORE.outbox, INDEX.outboxByState, state("sent"))), ["a", "b", "f"]);
				assert.equal(await tx.countByIndex(STORE.outbox, INDEX.outboxByStream, stream2("b:y")), 1);
			});
			function stream2(s: string): KeyRange {
				return { lower: [s, 0], upper: [s, MAX] };
			}
		});

		it("non-unique index: streams byStalePriority orders by (index key, primary key)", async () => {
			const db = await openYaos(impl.make());
			await db.tx([STORE.streams], "readwrite", async (tx) => {
				tx.put(STORE.streams, streamRec("b:z", 1, 5, 30));
				tx.put(STORE.streams, streamRec("b:m", 1, 5, 10));
				tx.put(STORE.streams, streamRec("ns", 1, 0, 20));
				tx.put(STORE.streams, streamRec("b:a", 0, 0, 40));
				tx.put(STORE.streams, streamRec("b:q", 1, 9, 10));
			});
			await db.tx([STORE.streams], "readonly", async (tx) => {
				// [1] < [1, x] < [2]: all stale streams by priority, ties by stream name
				const stale = await tx.getAllByIndex(STORE.streams, INDEX.streamsByStale, { lower: [1], upper: [2], upperOpen: true });
				assert.deepEqual(stale.map((r) => r.stream), ["ns", "b:m", "b:z", "b:q"]);
				assert.equal(await tx.countByIndex(STORE.streams, INDEX.streamsByStale, { lower: [1], upper: [2], upperOpen: true }), 4);
				const first = await tx.getAllByIndex(STORE.streams, INDEX.streamsByStale, { lower: [1], upper: [2], upperOpen: true }, 1);
				assert.deepEqual(first.map((r) => r.stream), ["ns"]);
				const byAccess = await tx.getAllByIndex(STORE.streams, INDEX.streamsByAccess, { upper: 20 });
				assert.deepEqual(byAccess.map((r) => r.stream), ["b:m", "b:q", "ns"]);
			});
		});

		it("deleteRange: one stream's tail up to a seq; an unbounded range clears the store", async () => {
			const db = await openYaos(impl.make());
			await db.tx([STORE.tail], "readwrite", async (tx) => {
				for (let seq = 1; seq <= 6; seq++) tx.put(STORE.tail, tail("b:a", seq));
				tx.put(STORE.tail, tail("b:b", 1));
				tx.put(STORE.tail, tail("ns", 3));
			});
			await db.tx([STORE.tail], "readwrite", async (tx) => {
				tx.deleteRange(STORE.tail, tailRange(S("b:a"), 0, 4));
				tx.deleteRange(STORE.tail, tailRange(S("b:a"), 9, 3)); // empty: no-op
				assert.deepEqual((await tx.getAll(STORE.tail, tailRange(S("b:a")))).map((r) => r.seq), [5, 6]);
			});
			assert.deepEqual(await db.tx([STORE.tail], "readonly", (tx) => tx.getAllKeys(STORE.tail)), [["b:a", 5], ["b:a", 6], ["b:b", 1], ["ns", 3]]);
			await db.tx([STORE.tail], "readwrite", async (tx) => {
				tx.deleteRange(STORE.tail, {});
			});
			assert.equal(await db.tx([STORE.tail], "readonly", (tx) => tx.count(STORE.tail)), 0);
		});

		it("a unique index violation aborts the whole tx with failure unknown", async () => {
			const db = await openYaos(impl.make());
			await db.tx([STORE.outbox], "readwrite", async (tx) => {
				tx.put(STORE.outbox, outbox("one", 1));
			});
			// violation discovered after the body resolved
			await rejectsWith(
				db.tx([STORE.outbox, STORE.meta], "readwrite", async (tx) => {
					tx.put(STORE.meta, { key: "outboxOrder", next: 3 });
					tx.put(STORE.outbox, outbox("two", 2));
					tx.put(STORE.outbox, outbox("dup", 1)); // byOrder (and byStreamOrder/byStateOrder) collide with "one"
					return "body done";
				}),
				"unknown",
			);
			// violation observed by a later read inside the body
			await rejectsWith(
				db.tx([STORE.outbox], "readwrite", async (tx) => {
					tx.put(STORE.outbox, outbox("three", 3));
					tx.put(STORE.outbox, outbox("dup2", 1, "sent", "b:other"));
					await tx.get(STORE.outbox, F("one"));
					return "unreachable?";
				}),
				"unknown",
			);
			const [keys, meta] = await db.tx([STORE.outbox, STORE.meta], "readonly", async (tx) =>
				Promise.all([tx.getAllKeys(STORE.outbox), tx.get(STORE.meta, "outboxOrder")]),
			);
			assert.deepEqual(keys, ["one"]);
			assert.equal(meta, undefined);
			// re-putting the same record under its own key is not a violation
			await db.tx([STORE.outbox], "readwrite", async (tx) => {
				tx.put(STORE.outbox, { ...outbox("one", 1), attempts: 2 });
			});
		});

		it("a throwing body commits nothing and propagates the original error", async () => {
			const db = await openYaos(impl.make());
			const boom = new Error("boom");
			await assert.rejects(
				db.tx([STORE.meta], "readwrite", (tx) => {
					tx.put(STORE.meta, { key: "outboxOrder", next: 1 });
					throw boom; // synchronous throw
				}),
				(e) => e === boom,
			);
			const later = new TypeError("later");
			await assert.rejects(
				db.tx([STORE.meta, STORE.tail], "readwrite", async (tx) => {
					tx.put(STORE.tail, tail("b:a", 1));
					await tx.get(STORE.meta, "cursor");
					tx.put(STORE.meta, { key: "cursor", vaultSeq: 1, headSeqSeen: 1 });
					await tx.count(STORE.tail);
					throw later; // after awaits
				}),
				(e) => e === later,
			);
			const counts = await db.tx([STORE.meta, STORE.tail], "readonly", async (tx) => Promise.all([tx.count(STORE.meta), tx.count(STORE.tail)]));
			assert.deepEqual(counts, [0, 0]);
		});

		it("abort() rejects with aborted and commits nothing; later ops are tx-inactive", async () => {
			const db = await openYaos(impl.make());
			let afterAbortRead: Promise<unknown> | null = null;
			let afterAbortWrite: StorageError | null = null;
			await rejectsWith(
				db.tx([STORE.meta], "readwrite", async (tx) => {
					tx.put(STORE.meta, { key: "outboxOrder", next: 1 });
					await tx.get(STORE.meta, "outboxOrder");
					tx.abort();
					tx.abort(); // idempotent
					afterAbortRead = tx.get(STORE.meta, "outboxOrder");
					afterAbortRead.catch(() => undefined);
					afterAbortWrite = throwsWith(() => tx.put(STORE.meta, { key: "cursor", vaultSeq: 1, headSeqSeen: 1 }), "tx-inactive");
					return "returned normally";
				}),
				"aborted",
			);
			assert.ok(afterAbortWrite);
			await rejectsWith(afterAbortRead!, "tx-inactive");
			assert.equal(await db.tx([STORE.meta], "readonly", (tx) => tx.count(STORE.meta)), 0);
			// the body throwing after abort() still reports "aborted"
			await rejectsWith(
				db.tx([STORE.meta], "readwrite", async (tx) => {
					tx.abort();
					throw new Error("after abort");
				}),
				"aborted",
			);
		});

		it("Uint8Array values (and binary keys) round-trip", async () => {
			const port = impl.make();
			const db = await openYaos(port);
			const snap: SnapshotRecord = { stream: S("b:a"), coversSeq: 12, encoding: 1, bytes: new Uint8Array([0, 1, 254, 255]), createdAtMs: 5 };
			await db.tx([STORE.snapshots, STORE.tail], "readwrite", async (tx) => {
				tx.put(STORE.snapshots, snap);
				tx.put(STORE.tail, tail("b:a", 300));
			});
			const [s, t] = await db.tx([STORE.snapshots, STORE.tail], "readonly", async (tx) =>
				Promise.all([tx.get(STORE.snapshots, S("b:a")), tx.get(STORE.tail, [S("b:a"), 300])]),
			);
			assert.ok(s?.bytes instanceof Uint8Array);
			assert.deepEqual(s, snap);
			assert.ok(t?.content instanceof Uint8Array);
			assert.deepEqual(Array.from(t.content), [300 & 255, 0xaa, 0xbb]);

			const kv = await openKv(port);
			const bin = new Uint8Array([9, 8, 7]);
			await kv.tx(["kv"], "readwrite", async (tx) => {
				tx.put("kv", { k: bin, v: new Uint8Array([1]) });
				tx.put("kv", { k: ["x", new Uint8Array([2])] });
			});
			await kv.tx(["kv"], "readonly", async (tx) => {
				const keys = await tx.getAllKeys("kv");
				assert.deepEqual(keys, [new Uint8Array([9, 8, 7]), ["x", new Uint8Array([2])]]);
				assert.ok(keys[0] instanceof Uint8Array);
				assert.deepEqual(await tx.get("kv", new Uint8Array([9, 8, 7])), { k: bin, v: new Uint8Array([1]) });
				assert.deepEqual(await tx.getAllByIndex("kv", "byV", { lower: new Uint8Array([1]), upper: new Uint8Array([1]) }), [{ k: bin, v: new Uint8Array([1]) }]);
			});
		});

		it("structured-clone isolation: no aliasing on put or get", async () => {
			const db = await openYaos(impl.make());
			const rec = tail("b:a", 1) as { -readonly [K in keyof TailRecord]: TailRecord[K] };
			await db.tx([STORE.tail], "readwrite", async (tx) => {
				tx.put(STORE.tail, rec);
				rec.flags = 99; // mutate after put, before commit
				rec.content[0] = 42;
				const inTx = await tx.get(STORE.tail, [S("b:a"), 1]);
				assert.equal(inTx?.flags, 0);
				(inTx as { flags: number }).flags = 77;
				assert.equal((await tx.get(STORE.tail, [S("b:a"), 1]))?.flags, 0);
			});
			const got = (await db.tx([STORE.tail], "readonly", (tx) => tx.get(STORE.tail, [S("b:a"), 1]))) as { flags: number; content: Uint8Array };
			assert.equal(got.flags, 0);
			assert.equal(got.content[0], 1);
			got.flags = 5;
			got.content[0] = 200;
			const all = await db.tx([STORE.tail], "readonly", (tx) => tx.getAll(STORE.tail));
			assert.equal(all[0]?.flags, 0);
			assert.equal(all[0]?.content[0], 1);
			(all[0] as { flags: number }).flags = 6;
			const viaKeys = await db.tx([STORE.tail], "readonly", (tx) => tx.getAllKeys(STORE.tail));
			(viaKeys[0] as unknown as unknown[])[1] = 1000;
			assert.deepEqual(await db.tx([STORE.tail], "readonly", (tx) => tx.getAllKeys(STORE.tail)), [["b:a", 1]]);
			assert.equal((await db.tx([STORE.tail], "readonly", (tx) => tx.get(STORE.tail, [S("b:a"), 1])))?.flags, 0);
		});

		it("synchronous write failures throw StorageError and abort the tx", async () => {
			const port = impl.make();
			const db = await openYaos(port);
			// no valid key at the keyPath; the body swallows the error, the tx still aborts
			await rejectsWith(
				db.tx([STORE.meta, STORE.tail], "readwrite", async (tx) => {
					tx.put(STORE.tail, tail("b:a", 1));
					throwsWith(() => tx.put(STORE.meta, { vaultSeq: 1 } as unknown as MetaRecord), "unknown");
					return "swallowed";
				}),
				"unknown",
			);
			assert.equal(await db.tx([STORE.tail], "readonly", (tx) => tx.count(STORE.tail)), 0);
			// write in a readonly tx
			await rejectsWith(
				db.tx([STORE.meta], "readonly", async (tx) => {
					tx.put(STORE.meta, { key: "outboxOrder", next: 1 });
				}),
				"unknown",
			);
			// store outside the tx scope
			await rejectsWith(
				db.tx([STORE.meta], "readwrite", async (tx) => {
					tx.put(STORE.tail, tail("b:a", 1));
				}),
				"unknown",
			);
			await rejectsWith(db.tx([STORE.meta], "readonly", (tx) => tx.get(STORE.tail, [S("b:a"), 1])), "unknown");
			// unknown store in the scope / unknown index
			await rejectsWith(db.tx(["nope" as keyof YaosSchema], "readonly", async () => 1), "unknown");
			await rejectsWith(db.tx([STORE.outbox], "readonly", (tx) => tx.getAllByIndex(STORE.outbox, "noSuchIndex" as never)), "unknown");
			// invalid key / limit in reads reject without killing the body
			const v = await db.tx([STORE.meta], "readonly", async (tx) => {
				await rejectsWith(tx.get(STORE.meta, null as unknown as "cursor"), "unknown");
				await rejectsWith(tx.getAll(STORE.meta, undefined, -1), "unknown");
				return "ok";
			});
			assert.equal(v, "ok");
		});

		it("ops on a tx after its body settled fail tx-inactive", async () => {
			const db = await openYaos(impl.make());
			type Tx = Parameters<Parameters<StorageDb<YaosSchema>["tx"]>[2]>[0];
			let leaked: Tx | null = null;
			await db.tx([STORE.meta], "readwrite", async (tx) => {
				leaked = tx;
				tx.put(STORE.meta, { key: "outboxOrder", next: 1 });
			});
			const tx = leaked as unknown as Tx;
			await rejectsWith(tx.get(STORE.meta, "outboxOrder"), "tx-inactive");
			await rejectsWith(tx.getAll(STORE.meta), "tx-inactive");
			throwsWith(() => tx.put(STORE.meta, { key: "outboxOrder", next: 2 }), "tx-inactive");
			throwsWith(() => tx.delete(STORE.meta, "outboxOrder"), "tx-inactive");
			throwsWith(() => tx.abort(), "tx-inactive");
			assert.deepEqual(await db.tx([STORE.meta], "readonly", (t) => t.get(STORE.meta, "outboxOrder")), { key: "outboxOrder", next: 1 });
		});

		it("tx on a closed db rejects connection-lost; close() does not fire onLost", async () => {
			const db = await openYaos(impl.make());
			const lost: StorageFailure[] = [];
			db.onLost((f) => lost.push(f));
			db.close();
			await rejectsWith(db.tx([STORE.meta], "readonly", (tx) => tx.count(STORE.meta)), "connection-lost");
			assert.deepEqual(lost, []);
		});

		it("opening a higher version closes older handles with onLost and upgrades existing data", async () => {
			const port = impl.make();
			const v1 = await port.open<KvSchema>("kv", 1, KV_SPECS_NO_INDEX);
			const lost: StorageFailure[] = [];
			const unsubscribed: StorageFailure[] = [];
			v1.onLost((f) => lost.push(f));
			v1.onLost((f) => unsubscribed.push(f))();
			await v1.tx(["kv"], "readwrite", async (tx) => {
				tx.put("kv", { k: 1, v: "b", u: 10 });
				tx.put("kv", { k: 2, v: "a", u: 20 });
				tx.put("kv", { k: 3, v: false });
			});
			const v2 = await openKv(port, "kv", 2);
			assert.deepEqual(lost, ["connection-lost"]);
			assert.deepEqual(unsubscribed, []);
			await rejectsWith(v1.tx(["kv"], "readonly", (tx) => tx.count("kv")), "connection-lost");
			await v2.tx(["kv"], "readonly", async (tx) => {
				assert.deepEqual((await tx.getAllByIndex("kv", "byV")).map((r) => r.k), [2, 1]);
				assert.equal(await tx.countByIndex("kv", "byU"), 2);
			});
			// lower version than the existing one
			await rejectsWith(port.open<KvSchema>("kv", 1, KV_SPECS), "unknown");
			v2.close();
		});

		it("an upgrade that cannot build a unique index rejects open and keeps the old version", async () => {
			const port = impl.make();
			const v1 = await port.open<KvSchema>("kv", 1, KV_SPECS_NO_INDEX);
			await v1.tx(["kv"], "readwrite", async (tx) => {
				tx.put("kv", { k: 1, u: 5 });
				tx.put("kv", { k: 2, u: 5 });
			});
			v1.close();
			await rejectsWith(port.open<KvSchema>("kv", 2, KV_SPECS), "unknown");
			const again = await port.open<KvSchema>("kv", 1, KV_SPECS_NO_INDEX);
			assert.equal(await again.tx(["kv"], "readonly", (tx) => tx.count("kv")), 2);
			again.close();
		});

		it("deleteDatabase notifies open handles", async () => {
			const port = impl.make();
			const db = await openYaos(port);
			const lost: StorageFailure[] = [];
			db.onLost((f) => lost.push(f));
			await port.deleteDatabase(DB);
			assert.deepEqual(lost, ["connection-lost"]);
			await rejectsWith(db.tx([STORE.meta], "readonly", (tx) => tx.count(STORE.meta)), "connection-lost");
			await port.deleteDatabase("never-existed");
		});

		it("key ordering: number < string < binary < array, with open/closed and one-sided bounds", async () => {
			const db = await openKv(impl.make());
			const ordered: StorageKey[] = [
				-1, 0, 2.5, Number.MAX_SAFE_INTEGER,
				"", "A", "a", "ab", "b",
				// No empty Uint8Array: fake-indexeddb treats a zero-length view as
				// "detached" and throws DataError (real IDB and MemStoragePort accept it).
				new Uint8Array([0]), new Uint8Array([0, 1]), new Uint8Array([1]),
				[], [0], [0, 0], [1], ["a"], [new Uint8Array([1])], [[]], [[0]],
			];
			const shuffled = ordered.map((k, i) => ({ k, i: (i * 7) % ordered.length })).sort((x, y) => x.i - y.i).map((x) => x.k);
			await db.tx(["kv"], "readwrite", async (tx) => {
				for (const k of shuffled) tx.put("kv", { k });
			});
			const keysIn = (range?: KeyRange, limit?: number): Promise<StorageKey[]> => db.tx(["kv"], "readonly", (tx) => tx.getAllKeys("kv", range, limit));
			const idx = (k: StorageKey): number => ordered.findIndex((x) => JSON.stringify(x) === JSON.stringify(k) && typeof x === typeof k && x instanceof Uint8Array === k instanceof Uint8Array);
			assert.deepEqual(await keysIn(), ordered);
			assert.deepEqual(await keysIn({ lower: "a" }), ordered.slice(idx("a")));
			assert.deepEqual(await keysIn({ lower: "a", lowerOpen: true, upper: new Uint8Array([0, 1]), upperOpen: true }), ordered.slice(idx("a") + 1, idx(new Uint8Array([0, 1]))));
			assert.deepEqual(await keysIn({ upper: 0 }), [-1, 0]);
			assert.deepEqual(await keysIn({ upper: 0, upperOpen: true }), [-1]);
			assert.deepEqual(await keysIn({ lower: [], upper: [1] }), [[], [0], [0, 0], [1]]);
			assert.deepEqual(await keysIn({ lower: [0], upper: [0, MAX] }), [[0], [0, 0]]);
			assert.deepEqual(await keysIn({ lower: "", upper: "b" }, 3), ["", "A", "a"]);
			assert.equal(await db.tx(["kv"], "readonly", (tx) => tx.count("kv", { lower: new Uint8Array([0]), upper: [], upperOpen: true })), 3);
		});

		it("records whose index keyPath is not a valid key are not indexed", async () => {
			const db = await openKv(impl.make());
			await db.tx(["kv"], "readwrite", async (tx) => {
				tx.put("kv", { k: 1, v: null });
				tx.put("kv", { k: 2, v: true });
				tx.put("kv", { k: 3, v: "x" });
				tx.put("kv", { k: 4 });
				tx.put("kv", { k: 5, v: { nested: 1 } });
				tx.put("kv", { k: 6, v: [1, null] });
				tx.put("kv", { k: 7, v: [1, "y"] });
			});
			await db.tx(["kv"], "readonly", async (tx) => {
				assert.equal(await tx.count("kv"), 7);
				assert.equal(await tx.countByIndex("kv", "byV"), 2);
				assert.deepEqual((await tx.getAllByIndex("kv", "byV")).map((r) => r.k), [3, 7]);
				assert.equal(await tx.countByIndex("kv", "byU"), 0);
			});
		});

		it("readwrite txs on one db are serialized FIFO", async () => {
			const db = await openYaos(impl.make());
			await db.tx([STORE.meta], "readwrite", async (tx) => {
				tx.put(STORE.meta, { key: "outboxOrder", next: 0 });
			});
			const log: string[] = [];
			const bump = (label: string): Promise<number> =>
				db.tx([STORE.meta], "readwrite", async (tx) => {
					log.push(`start ${label}`);
					const m = (await tx.get(STORE.meta, "outboxOrder")) as Extract<MetaRecord, { key: "outboxOrder" }>;
					await tx.count(STORE.meta);
					tx.put(STORE.meta, { key: "outboxOrder", next: m.next + 1 });
					log.push(`end ${label}`);
					return m.next;
				});
			const results = await Promise.all([bump("a"), bump("b"), bump("c")]);
			assert.deepEqual(results, [0, 1, 2]);
			// IDB runs every body immediately and only defers the *requests* of an
			// overlapping readwrite tx; MemStoragePort defers the whole body. Either
			// way no body observes another's uncommitted state, so the ends are FIFO.
			assert.deepEqual(log.filter((l) => l.startsWith("end")), ["end a", "end b", "end c"]);
			const reader = await db.tx([STORE.meta], "readonly", (tx) => tx.get(STORE.meta, "outboxOrder"));
			assert.deepEqual(reader, { key: "outboxOrder", next: 3 });
		});
	});
}
