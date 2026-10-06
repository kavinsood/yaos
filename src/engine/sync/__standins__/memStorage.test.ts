/**
 * MemStoragePort-specific behaviour: commit counting, the commit hook, crash
 * simulation, connection loss. Shared StoragePort semantics are covered by
 * src/engine/adapters/storageConformance.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { StorageDb, StorageError, StorageFailure, StorageKey } from "../../../ports/storage";
import { isStorageError } from "../../../ports/storage";
import { MemStoragePort, type CommitDecision, type CommitInfo } from "./memStorage";

type Rec = { readonly id: StorageKey; readonly n?: number; readonly tag?: string; readonly bytes?: Uint8Array };
type Schema = {
	readonly a: { readonly record: Rec; readonly key: StorageKey; readonly indexes: "byTag" };
	readonly b: { readonly record: Rec; readonly key: StorageKey; readonly indexes: never };
};
const SPECS = {
	a: { keyPath: "id", indexes: { byTag: { keyPath: ["tag", "n"], unique: false } } },
	b: { keyPath: "id", indexes: {} },
} as const;

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

function open(port: MemStoragePort, name = "db"): Promise<StorageDb<Schema>> {
	return port.open<Schema>(name, 1, SPECS);
}

function put(db: StorageDb<Schema>, store: "a" | "b", ...recs: Rec[]): Promise<void> {
	return db.tx([store], "readwrite", async (tx) => {
		for (const r of recs) tx.put(store, r);
	});
}

/** Everything observable through the port: records, keys and index order of every store. */
async function dump(db: StorageDb<Schema>): Promise<unknown> {
	return db.tx(["a", "b"], "readonly", async (tx) => ({
		a: await tx.getAll("a"),
		aKeys: await tx.getAllKeys("a"),
		aByTag: await tx.getAllByIndex("a", "byTag"),
		b: await tx.getAll("b"),
	}));
}

describe("MemStoragePort crash simulation", () => {
	it("commitCount counts committed readwrite txs across databases, including empty ones", async () => {
		const port = new MemStoragePort();
		const one = await open(port, "one");
		const two = await open(port, "two");
		assert.equal(port.commitCount, 0, "upgrades are not commits");
		await put(one, "a", { id: 1 });
		await put(two, "b", { id: 1 });
		await one.tx(["a"], "readwrite", async () => undefined); // wrote nothing: still a commit
		await one.tx(["a"], "readonly", (tx) => tx.count("a"));
		await rejectsWith(one.tx(["a"], "readwrite", async (tx) => tx.abort()), "aborted");
		await assert.rejects(one.tx(["a"], "readwrite", async () => Promise.reject(new Error("x"))), /x/);
		assert.equal(port.commitCount, 3);
	});

	it("the hook sees { db, index, stores } for every readwrite commit, in FIFO order", async () => {
		const port = new MemStoragePort();
		const one = await open(port, "one");
		const two = await open(port, "two");
		const seen: CommitInfo[] = [];
		port.setCommitHook((info) => {
			seen.push(info);
			return "commit";
		});
		await Promise.all([
			one.tx(["a", "b"], "readwrite", async (tx) => {
				await tx.get("a", 0);
				tx.put("a", { id: 1 });
			}),
			one.tx(["b"], "readwrite", async (tx) => tx.put("b", { id: 1 })),
			two.tx(["a"], "readwrite", async (tx) => tx.put("a", { id: 1 })),
			one.tx(["a"], "readonly", (tx) => tx.count("a")),
			one.tx(["a"], "readwrite", async (tx) => tx.put("a", { id: 2 })),
		]);
		assert.deepEqual(
			seen.map((i) => `${i.db}#${i.index}:${i.stores.join("+")}`),
			// "two" does not wait for "one": its tx has no earlier tx on its own db.
			["two#0:a", "one#1:a+b", "one#2:b", "one#3:a"],
		);
		assert.equal(port.commitCount, 4);
		port.setCommitHook(null);
		await put(one, "a", { id: 3 });
		assert.equal(seen.length, 4);
	});

	it("crash-before: nothing committed, the port is dead, crash() restores the committed state", async () => {
		const port = new MemStoragePort();
		const db = await open(port);
		await put(db, "a", { id: 1, tag: "t", n: 1 });
		port.setCommitHook((info) => (info.index === 1 ? "crash-before" : "commit"));
		await rejectsWith(put(db, "a", { id: 2, tag: "t", n: 2 }), "connection-lost");
		assert.equal(port.dead, true);
		assert.equal(port.commitCount, 1);

		const next = port.crash();
		assert.equal(next.dead, false);
		assert.equal(next.commitCount, 0);
		const db2 = await open(next);
		assert.deepEqual(await db2.tx(["a"], "readonly", (tx) => tx.getAllKeys("a")), [1]);
		// the restarted port has no hook
		await put(db2, "a", { id: 2 });
		assert.equal(next.commitCount, 1);
	});

	it("crash-after: committed, the port is dead, the commit survives the restart", async () => {
		const port = new MemStoragePort();
		const db = await open(port);
		await put(db, "a", { id: 1 });
		port.setCommitHook(() => "crash-after");
		const err = await rejectsWith(put(db, "a", { id: 2 }), "connection-lost");
		assert.equal(err.name, "StorageError");
		assert.equal(port.dead, true);
		assert.equal(port.commitCount, 2);
		const db2 = await open(port.crash());
		assert.deepEqual(await db2.tx(["a"], "readonly", (tx) => tx.getAllKeys("a")), [1, 2]);
	});

	it("a dead port rejects open / tx / deleteDatabase / listDatabases / requestPersistence and in-flight work", async () => {
		const port = new MemStoragePort();
		const db = await open(port, "one");
		const other = await open(port, "two");
		const lost: StorageFailure[] = [];
		db.onLost((f) => lost.push(f));
		other.onLost((f) => lost.push(f));

		let inFlightOp: unknown = null;
		let inFlightAbort: unknown = null;
		const inFlight = other.tx(["a"], "readwrite", async (tx) => {
			tx.put("a", { id: "inflight" });
			await sleep(5); // the crash happens here
			try {
				tx.put("a", { id: "late" });
			} catch (e) {
				inFlightOp = e;
			}
			try {
				tx.abort();
			} catch (e) {
				inFlightAbort = e;
			}
		});
		port.setCommitHook((info) => (info.db === "one" ? "crash-before" : "commit"));
		const crashing = put(db, "a", { id: "x" });
		const queuedBehindCrash = put(db, "a", { id: "queued" });
		await rejectsWith(crashing, "connection-lost");
		assert.equal(port.dead, true);
		await rejectsWith(queuedBehindCrash, "connection-lost");

		await rejectsWith(inFlight, "connection-lost");
		assert.ok(isStorageError(inFlightOp) && inFlightOp.failure === "connection-lost");
		assert.ok(isStorageError(inFlightAbort) && inFlightAbort.failure === "connection-lost");
		await rejectsWith(db.tx(["a"], "readonly", (tx) => tx.count("a")), "connection-lost");
		await rejectsWith(other.tx(["a"], "readonly", (tx) => tx.count("a")), "connection-lost");
		await rejectsWith(open(port, "one"), "connection-lost");
		await rejectsWith(open(port, "fresh"), "connection-lost");
		await rejectsWith(port.deleteDatabase("one"), "connection-lost");
		await rejectsWith(port.listDatabases(), "connection-lost");
		await rejectsWith(port.requestPersistence(), "connection-lost");
		assert.deepEqual(lost, [], "death is not observed through onLost");

		const next = port.crash();
		assert.deepEqual(await next.listDatabases(), ["one", "two"]);
		assert.equal(await (await open(next, "two")).tx(["a"], "readonly", (tx) => tx.count("a")), 0);
		assert.equal(await (await open(next, "one")).tx(["a"], "readonly", (tx) => tx.count("a")), 0);
	});

	it("crash() is a deep copy of exactly the committed state", async () => {
		const port = new MemStoragePort();
		const db = await open(port);
		const bytes = new Uint8Array([1, 2, 3]);
		await put(db, "a", { id: 3, tag: "x", n: 2, bytes }, { id: 1, tag: "x", n: 1 }, { id: [1, "k"], tag: "a", n: 9 }, { id: "s" });
		await put(db, "b", { id: new Uint8Array([7]) }, { id: 0.5 });
		await db.tx(["a"], "readwrite", async (tx) => {
			tx.delete("a", 1);
			tx.put("a", { id: 4, tag: "x", n: 0 });
		});
		const before = await dump(db);
		const other = await open(port, "other");
		await put(other, "b", { id: "o" });

		// an uncommitted tx in progress at crash time is not part of the copy
		const pending = db.tx(["a"], "readwrite", async (tx) => {
			tx.put("a", { id: "uncommitted" });
			await sleep(5);
		});
		const next = port.crash();
		await rejectsWith(pending, "connection-lost");

		const restored = await open(next);
		const after = await dump(restored);
		assert.deepEqual(after, before);
		assert.ok(((after as { a: Rec[] }).a.find((r) => r.id === 3)?.bytes) instanceof Uint8Array);
		assert.deepEqual(await (await open(next, "other")).tx(["b"], "readonly", (tx) => tx.getAllKeys("b")), ["o"]);

		// independent from the source: mutating the caller's objects or the new port changes nothing else
		bytes[0] = 99;
		await put(restored, "a", { id: "new" });
		const again = await open(next.crash());
		const final = (await dump(again)) as { a: Rec[] };
		assert.equal(final.a.find((r) => r.id === 3)?.bytes?.[0], 1);
		assert.ok(final.a.some((r) => r.id === "new"));
	});

	it("crash at every commit boundary of a multi-step workflow leaves a consistent prefix", async () => {
		// A workflow of 4 readwrite txs. Each step moves one unit from "a" (queue)
		// to "b" (done) atomically; the invariant is a + b == 4 and b == steps done.
		const STEPS = 4;
		const workflow = async (db: StorageDb<Schema>): Promise<void> => {
			for (let i = 0; i < STEPS; i++) {
				await db.tx(["a", "b"], "readwrite", async (tx) => {
					const next = (await tx.getAll("a", undefined, 1))[0];
					if (!next) return;
					tx.delete("a", next.id);
					tx.put("b", next);
				});
			}
		};
		const seed = async (port: MemStoragePort): Promise<StorageDb<Schema>> => {
			const db = await open(port);
			await put(db, "a", ...Array.from({ length: STEPS }, (_, i) => ({ id: i })));
			return db;
		};

		for (let index = 0; index < STEPS; index++) {
			for (const decision of ["crash-before", "crash-after"] as const satisfies readonly CommitDecision[]) {
				const port = new MemStoragePort();
				const db = await seed(port); // commit #0
				port.setCommitHook((info) => (info.index === index + 1 ? decision : "commit"));
				await rejectsWith(workflow(db), "connection-lost");
				const restarted = port.crash();
				const db2 = await open(restarted);
				const [a, b] = await db2.tx(["a", "b"], "readonly", async (tx) => Promise.all([tx.getAllKeys("a"), tx.getAllKeys("b")]));
				const done = decision === "crash-before" ? index : index + 1;
				assert.equal(a.length + b.length, STEPS, `${decision}@${index}`);
				assert.deepEqual(b, Array.from({ length: done }, (_, i) => i), `${decision}@${index}`);
				// recovery: rerunning the workflow completes it
				await workflow(db2);
				assert.equal(await db2.tx(["b"], "readonly", (tx) => tx.count("b")), STEPS);
			}
		}
	});

	it("a throwing commit hook rejects the tx with its error, commits nothing, and keeps the port alive", async () => {
		const port = new MemStoragePort();
		const db = await open(port);
		const boom = new Error("hook failed");
		port.setCommitHook(() => {
			throw boom;
		});
		await assert.rejects(put(db, "a", { id: 1 }), (e) => e === boom);
		assert.equal(port.dead, false);
		assert.equal(port.commitCount, 0);
		port.setCommitHook(null);
		assert.equal(await db.tx(["a"], "readonly", (tx) => tx.count("a")), 0);
	});
});

describe("MemStoragePort connection handling and tx lifetime", () => {
	it("loseConnection fires onLost, fails in-flight txs, and leaves data reopenable", async () => {
		const port = new MemStoragePort();
		const db = await open(port);
		await put(db, "a", { id: 1 });
		const lost: StorageFailure[] = [];
		db.onLost((f) => lost.push(f));
		const inFlight = db.tx(["a"], "readwrite", async (tx) => {
			tx.put("a", { id: 2 });
			await sleep(5);
			return tx.count("a");
		});
		port.loseConnection("db");
		port.loseConnection("no-such-db");
		assert.deepEqual(lost, ["connection-lost"]);
		await rejectsWith(inFlight, "connection-lost");
		await rejectsWith(db.tx(["a"], "readonly", (tx) => tx.count("a")), "connection-lost");
		assert.equal(port.dead, false);
		const db2 = await open(port);
		assert.deepEqual(await db2.tx(["a"], "readonly", (tx) => tx.getAllKeys("a")), [1]);
	});

	it("ops on a leaked tx fail tx-inactive after commit, abort and body rejection", async () => {
		const port = new MemStoragePort();
		const db = await open(port);
		type Tx = Parameters<Parameters<StorageDb<Schema>["tx"]>[2]>[0];
		const leaked: Tx[] = [];
		await db.tx(["a"], "readwrite", async (tx) => {
			leaked.push(tx);
		});
		await rejectsWith(
			db.tx(["a"], "readwrite", async (tx) => {
				leaked.push(tx);
				tx.abort();
			}),
			"aborted",
		);
		await assert.rejects(
			db.tx(["a"], "readonly", async (tx) => {
				leaked.push(tx);
				throw new Error("body failed");
			}),
			/body failed/,
		);
		for (const tx of leaked) {
			await rejectsWith(tx.get("a", 1), "tx-inactive");
			await rejectsWith(tx.countByIndex("a", "byTag"), "tx-inactive");
			assert.throws(() => tx.put("a", { id: 1 }), (e) => isStorageError(e) && e.failure === "tx-inactive");
			assert.throws(() => tx.deleteRange("a", {}), (e) => isStorageError(e) && e.failure === "tx-inactive");
			assert.throws(() => tx.abort(), (e) => isStorageError(e) && e.failure === "tx-inactive");
		}
		// the aborted tx's own writes after abort() are tx-inactive too, and nothing leaked into the store
		assert.equal(await db.tx(["a"], "readonly", (tx) => tx.count("a")), 0);
	});

	it("a readonly tx sees a consistent snapshot while a readwrite tx is queued behind it", async () => {
		const port = new MemStoragePort();
		const db = await open(port);
		await put(db, "a", { id: 1 });
		const reads: number[] = [];
		const reader = db.tx(["a"], "readonly", async (tx) => {
			reads.push(await tx.count("a"));
			await sleep(5); // allowed in the stand-in (IDB would end the tx here)
			reads.push(await tx.count("a"));
		});
		const writer = put(db, "a", { id: 2 });
		await Promise.all([reader, writer]);
		assert.deepEqual(reads, [1, 1]);
		assert.equal(await db.tx(["a"], "readonly", (tx) => tx.count("a")), 2);
	});
});
