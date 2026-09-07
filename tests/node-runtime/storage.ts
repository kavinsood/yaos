import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import {
	NodeDatabaseSet,
	NodeSqliteStorage,
	readSqliteBlob,
} from "../../packages/server-node/src/storage";
import { decodeSqlChunks, SQLITE_BLOB_CHUNK_BYTES } from "../../server/src/vaultDocumentStore";
import { VaultStore } from "../../server/src/vaultStore";
import { suite } from "../harness.ts";

const s = suite("node-runtime-storage");

s.test("ArrayBuffer and offset views bind as exact BLOBs rather than NULL", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-sqlite-"));
	const storage = NodeSqliteStorage.open(join(directory, "state.sqlite"));
	try {
		storage.sql.exec("CREATE TABLE values_table (id INTEGER PRIMARY KEY, value BLOB NOT NULL)");
		const bare = new Uint8Array([1, 2, 3, 4]).buffer;
		const pooled = new Uint8Array([90, 5, 6, 7, 91]);
		assert.equal(storage.sql.exec("INSERT INTO values_table(id, value) VALUES (?, ?)", 1, bare).rowsWritten, 1);
		assert.equal(storage.sql.exec("INSERT INTO values_table(id, value) VALUES (?, ?)", 2, pooled.subarray(1, 4)).rowsWritten, 1);
		const rows = storage.sql.exec<{ id: number; storage_type: string; value: ArrayBuffer }>(
			"SELECT id, typeof(value) AS storage_type, value FROM values_table ORDER BY id",
		).toArray();
		assert.deepEqual(rows.map((row) => row.storage_type), ["blob", "blob"]);
		assert.deepEqual([...new Uint8Array(rows[0]!.value)], [1, 2, 3, 4]);
		assert.deepEqual([...new Uint8Array(rows[1]!.value)], [5, 6, 7]);
	} finally {
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("vault journals and multi-row checkpoints persist exact bounded BLOB bytes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-vault-blobs-"));
	const storage = NodeSqliteStorage.open(join(directory, "state.sqlite"));
	const doc = new Y.Doc({ guid: "root" });
	try {
		doc.getText("bulk").insert(0, "a".repeat(900_000));
		const first = Y.encodeStateAsUpdate(doc);
		const pooled = new Uint8Array(first.byteLength + 2);
		pooled[0] = 90;
		pooled.set(first, 1);
		pooled[pooled.byteLength - 1] = 91;
		const firstView = pooled.subarray(1, pooled.byteLength - 1);

		const store = new VaultStore(storage);
		store.provisionVault("vault-blob-test", "generation-blob-test", firstView, 1);
		const beforeSecond = Y.encodeStateVector(doc);
		doc.getText("bulk").insert(900_000, "b".repeat(900_000));
		const second = Y.encodeStateAsUpdate(doc, beforeSecond);
		store.commitUpdate({ documentId: "root", update: second, kind: "root", now: 2 });

		const journal = storage.sql.exec<{
			sequence: number;
			storage_type: string;
			stored_bytes: number;
			data: ArrayBuffer;
		}>(`SELECT sequence, typeof(data) AS storage_type, length(data) AS stored_bytes, data
		   FROM vault_journal_chunks ORDER BY sequence, chunk_index`).toArray();
		assert.deepEqual(journal.map((row) => row.storage_type), ["blob", "blob"]);
		assert.deepEqual(journal.map((row) => row.stored_bytes), [first.byteLength, second.byteLength]);
		assert.deepEqual(new Uint8Array(journal[0]!.data), first, "offset-backed input leaked padding or changed bytes");
		assert.deepEqual(new Uint8Array(journal[1]!.data), second);

		const expectedCheckpoint = Y.encodeStateAsUpdate(doc);
		const written = store.writeCheckpoint("root", store.currentSequence());
		const checkpoint = storage.sql.exec<{
			chunk_index: number;
			storage_type: string;
			stored_bytes: number;
			data: ArrayBuffer;
		}>(`SELECT chunk_index, typeof(data) AS storage_type, length(data) AS stored_bytes, data
		   FROM vault_checkpoints WHERE document_id = 'root' ORDER BY chunk_index`).toArray();
		assert.equal(written.chunks, checkpoint.length);
		assert.ok(checkpoint.length >= 2, "checkpoint fixture did not cross the SQLite row boundary");
		assert.ok(checkpoint.every((row) => row.storage_type === "blob" && row.stored_bytes <= SQLITE_BLOB_CHUNK_BYTES));
		assert.equal(checkpoint.reduce((total, row) => total + row.stored_bytes, 0), expectedCheckpoint.byteLength);
		assert.deepEqual(decodeSqlChunks(checkpoint), expectedCheckpoint);
	} finally {
		doc.destroy();
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("BLOB reads reuse full-span buffers and own only offset spans", () => {
	const fullBacking = new ArrayBuffer(4);
	const fullView = new Uint8Array(fullBacking);
	assert.strictEqual(readSqliteBlob(fullView), fullBacking);

	const pooledBacking = new ArrayBuffer(8);
	const pooledView = new Uint8Array(pooledBacking, 2, 3);
	pooledView.set([7, 8, 9]);
	const owned = readSqliteBlob(pooledView);
	assert.notStrictEqual(owned, pooledBacking);
	assert.deepEqual([...new Uint8Array(owned)], [7, 8, 9]);
});

s.test("nested savepoint rollback preserves outer transaction writes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-savepoint-"));
	const storage = NodeSqliteStorage.open(join(directory, "state.sqlite"));
	try {
		storage.sql.exec("CREATE TABLE journal (value INTEGER NOT NULL)");
		storage.sql.exec("INSERT INTO journal(value) VALUES (1)");
		storage.transactionSync(() => {
			storage.sql.exec("INSERT INTO journal(value) VALUES (2)");
			assert.throws(() => storage.transactionSync(() => {
				storage.sql.exec("INSERT INTO journal(value) VALUES (3)");
				throw new Error("rollback nested savepoint");
			}), /rollback nested savepoint/);
			storage.sql.exec("INSERT INTO journal(value) VALUES (4)");
		});
		assert.deepEqual(
			storage.sql.exec<{ value: number }>("SELECT value FROM journal ORDER BY value").toArray().map((row) => row.value),
			[1, 2, 4],
		);
	} finally {
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("control-plane transactions remain atomic while actor requests interleave asynchronously", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-kv-transaction-"));
	const databases = new NodeDatabaseSet(directory);
	const store = databases.controlKv("global-config");
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	try {
		await store.put("count", 0);
		const first = store.transaction(async (transaction) => {
			const count = await transaction.get<number>("count");
			markStarted();
			await firstGate;
			await transaction.put("count", (count ?? 0) + 1);
		});
		await started;
		const second = store.transaction(async (transaction) => {
			const count = await transaction.get<number>("count");
			await transaction.put("count", (count ?? 0) + 1);
		});
		releaseFirst();
		await Promise.all([first, second]);
		assert.equal(await store.get<number>("count"), 2);
	} finally {
		databases.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("result cursors remain lazy and report exact row accounting", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-cursor-"));
	const storage = NodeSqliteStorage.open(join(directory, "state.sqlite"));
	try {
		const cursor = storage.sql.exec<{ value: number }>(`
			WITH RECURSIVE numbers(value) AS (
				VALUES (1)
				UNION ALL
				SELECT value + 1 FROM numbers WHERE value < 1000
			)
			SELECT value FROM numbers
		`);
		assert.equal(cursor.rowsRead, 0);
		const iterator = cursor[Symbol.iterator]();
		assert.deepEqual(iterator.next(), { done: false, value: { value: 1 } });
		assert.equal(cursor.rowsRead, 1);
		iterator.return?.();
	} finally {
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});

await s.done();
