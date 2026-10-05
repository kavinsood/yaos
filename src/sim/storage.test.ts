import { test } from "node:test";
import assert from "node:assert/strict";
import type { StorageDb, StorageFailure } from "../ports/storage";
import { isStorageError } from "../ports/storage";
import { MemStoragePort, type CommitInfo, type ForeignAwaitInfo } from "./storage";
import { VirtualClock } from "./clock";

type Schema = {
	readonly a: { readonly record: { id: number; tag?: string; n?: number }; readonly key: number; readonly indexes: "byTag" };
	readonly b: { readonly record: { k: string; v: number }; readonly key: string; readonly indexes: never };
};
const SPECS = {
	a: { keyPath: "id", indexes: { byTag: { keyPath: "tag", unique: false } } },
	b: { keyPath: "k", indexes: {} },
} as const;
const open = (port: MemStoragePort, name = "db"): Promise<StorageDb<Schema>> => port.open<Schema>(name, 1, SPECS);

async function failure(p: Promise<unknown>): Promise<StorageFailure | "ok" | "other"> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return isStorageError(e) ? e.failure : "other";
	}
}

test("storage: idb auto-commit — a body awaiting virtual time commits early writes, later ops are tx-inactive", async () => {
	const clock = new VirtualClock();
	const seen: ForeignAwaitInfo[] = [];
	const port = new MemStoragePort({ onForeignAwait: (i) => seen.push(i), beforeNextTimer: clock.beforeNextTimer });
	const db = await open(port);
	let lateWrite: StorageFailure | null = null;
	const run = failure(db.tx(["a", "b"], "readwrite", async (tx) => {
		tx.put("a", { id: 1 });
		await tx.get("a", 1);
		await clock.sleep(10); // foreign await: IndexedDB would auto-commit here
		try {
			tx.put("a", { id: 2 });
		} catch (e) {
			lateWrite = isStorageError(e) ? e.failure : null;
		}
		return tx.count("a");
	}));
	await clock.runUntilIdle();
	assert.equal(await run, "tx-inactive");
	assert.equal(lateWrite, "tx-inactive");
	assert.deepEqual(await db.tx(["a"], "readonly", (tx) => tx.getAllKeys("a")), [1]);
	assert.equal(port.foreignAwaits, 1);
	assert.deepEqual(seen, [{ db: "db", stores: ["a", "b"], mode: "readwrite" }]);
	assert.equal(port.commitCount, 1);
});

test("storage: microtask-only chains and Promise.all of own reads never trip the idle check", async () => {
	const port = new MemStoragePort();
	const db = await open(port);
	const n = await db.tx(["a"], "readwrite", async (tx) => {
		for (let i = 0; i < 200; i++) {
			tx.put("a", { id: i, tag: i % 2 ? "odd" : "even" });
			await Promise.all([tx.count("a"), tx.get("a", i), Promise.resolve(1)]);
			await null;
		}
		return tx.countByIndex("a", "byTag", { lower: "odd", upper: "odd" });
	});
	assert.equal(n, 100);
	assert.equal(port.foreignAwaits, 0);
});

test("storage: awaiting another tx on the same db inside a readwrite body does not deadlock (auto-commit releases)", async () => {
	const port = new MemStoragePort();
	const db = await open(port);
	const outer = db.tx(["a"], "readwrite", async (tx) => {
		tx.put("a", { id: 1 });
		const inner = await db.tx(["a"], "readonly", (t) => t.count("a")); // sees the auto-committed write
		return inner;
	});
	assert.equal(await outer, 1);
	// "off" mode keeps the stand-in behaviour: no auto-commit, so the same shape would wait forever
	const off = new MemStoragePort({ inactive: "off" });
	const db2 = await open(off);
	let late = false;
	const r = await db2.tx(["a"], "readwrite", async (tx) => {
		tx.put("a", { id: 1 });
		await new Promise((res) => setTimeout(res, 1));
		late = true;
		tx.put("a", { id: 2 });
		return tx.count("a");
	});
	assert.equal(late, true);
	assert.equal(r, 2);
});

test("storage: commit hook — crash-before / crash-after / quota / lose-connection; crash() keeps exactly the committed state", async () => {
	let port = new MemStoragePort();
	let db = await open(port);
	const infos: CommitInfo[] = [];
	port.setCommitHook((i) => (infos.push(i), "commit"));
	await db.tx(["a"], "readwrite", async (tx) => tx.put("a", { id: 1 }));
	await db.tx(["b"], "readwrite", async () => undefined);
	assert.deepEqual(infos.map((i) => [i.index, i.stores, i.auto]), [[0, ["a"], false], [1, ["b"], false]]);

	port.setCommitHook(() => "quota");
	assert.equal(await failure(db.tx(["a"], "readwrite", async (tx) => tx.put("a", { id: 9 }))), "quota");
	assert.equal(port.dead, false);

	const lostSeen: StorageFailure[] = [];
	db.onLost((f) => lostSeen.push(f));
	port.setCommitHook(() => "lose-connection");
	assert.equal(await failure(db.tx(["a"], "readwrite", async (tx) => tx.put("a", { id: 9 }))), "connection-lost");
	assert.deepEqual(lostSeen, ["connection-lost"]);
	assert.equal(await failure(db.tx(["a"], "readonly", (tx) => tx.count("a"))), "connection-lost");

	port.setCommitHook(null);
	db = await open(port);
	port.crashAtCommit(port.commitCount, "after");
	assert.equal(await failure(db.tx(["a"], "readwrite", async (tx) => tx.put("a", { id: 2 }))), "connection-lost");
	assert.equal(port.dead, true);
	assert.equal(await failure(port.listDatabases()), "connection-lost");
	port = port.crash();
	db = await open(port);
	assert.deepEqual(await db.tx(["a"], "readonly", (tx) => tx.getAllKeys("a")), [1, 2]);

	port.crashAtCommit(0, "before");
	assert.equal(await failure(db.tx(["a"], "readwrite", async (tx) => tx.put("a", { id: 3 }))), "connection-lost");
	port = port.crash();
	assert.deepEqual(port.dump("db")?.a, [{ id: 1 }, { id: 2 }]);
	assert.equal(port.version("db"), 1);
	assert.equal(port.dump("nope"), null);
});

test("storage: an uncommitted tx is lost on crash(); crashing at every commit boundary leaves a consistent prefix", async () => {
	const port = new MemStoragePort();
	const db = await open(port);
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const inFlight = db.tx(["a"], "readwrite", async (tx) => {
		tx.put("a", { id: 7 });
		await gate; // foreign await on a dead port: nothing commits
	});
	const restarted = port.crash();
	release();
	assert.equal(await failure(inFlight), "connection-lost");
	assert.deepEqual(restarted.dump("db")?.a, []);

	// Workflow: 5 txs, each moves one unit from b.src to b.dst (invariant: src + dst = 5).
	const workflow = async (p: MemStoragePort) => {
		const d = await open(p);
		await d.tx(["b"], "readwrite", async (tx) => {
			if ((await tx.get("b", "src")) === undefined) {
				tx.put("b", { k: "src", v: 5 });
				tx.put("b", { k: "dst", v: 0 });
			}
		});
		for (;;) {
			const moved = await d.tx(["b"], "readwrite", async (tx) => {
				const s = (await tx.get("b", "src"))!;
				const t = (await tx.get("b", "dst"))!;
				if (s.v === 0) return false;
				tx.put("b", { k: "src", v: s.v - 1 });
				tx.put("b", { k: "dst", v: t.v + 1 });
				return true;
			});
			if (!moved) return;
		}
	};
	for (let at = 0; at < 7; at++) {
		for (const when of ["before", "after"] as const) {
			const p = new MemStoragePort();
			p.crashAtCommit(at, when);
			await workflow(p).catch(() => undefined);
			const next = p.crash();
			const b = (next.dump("db")?.b ?? []) as { k: string; v: number }[];
			if (b.length > 0) assert.equal(b[0]!.v + b[1]!.v, 5, `crash ${when} #${at}`);
			await workflow(next); // recovery completes the workflow
			assert.deepEqual(next.dump("db")?.b, [{ k: "dst", v: 5 }, { k: "src", v: 0 }]);
		}
	}
});
