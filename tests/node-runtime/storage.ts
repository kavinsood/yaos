import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import {
	NodeDatabaseSet,
	NodeSqliteStorage,
	readSqliteBlob,
} from "../../packages/server-node/src/storage";
import { decodeSqlChunks, SQLITE_BLOB_CHUNK_BYTES } from "../../server/src/vaultDocumentStore";
import { MAX_DURABLE_UPDATE_BYTES } from "../../server/src/shared/durableLimits";
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
		   FROM vault_journal ORDER BY sequence`).toArray();
		assert.deepEqual(journal.map((row) => row.storage_type), ["blob", "blob"]);
		assert.deepEqual(journal.map((row) => row.stored_bytes), [first.byteLength, second.byteLength]);
		assert.deepEqual(new Uint8Array(journal[0]!.data), first, "offset-backed input leaked padding or changed bytes");
		assert.deepEqual(new Uint8Array(journal[1]!.data), second);
		assert.equal(storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'vault_journal_chunks'",
		).one().count, 0, "ordinary updates must not retain a chunk side table");
		const invalidJournalInsert = "INSERT INTO vault_journal(sequence, document_id, generation, semantic_epoch, kind, update_byte_length, data, created_at) VALUES (?, 'invalid', 1, 1, 'body', ?, ?, 3)";
		assert.throws(() => storage.sql.exec(invalidJournalInsert, 101, 1, new Uint8Array([1, 2]).buffer).toArray(),
			/constraint/i, "declared and actual journal lengths must match");
		assert.throws(() => storage.sql.exec(invalidJournalInsert, 102, 4, "text").toArray(),
			/constraint/i, "journal data must be a SQLite BLOB");
		assert.throws(() => storage.sql.exec(invalidJournalInsert, 103, MAX_DURABLE_UPDATE_BYTES + 1,
			new ArrayBuffer(MAX_DURABLE_UPDATE_BYTES + 1)).toArray(), /constraint/i,
		"the database must reject oversized journal values even when application admission is bypassed");

		const expectedCheckpoint = Y.encodeStateAsUpdate(doc);
		const written = store.writeCheckpoint("root", store.currentSequence());
		const checkpoint = storage.sql.exec<{
			chunk_index: number;
			semantic_epoch: number;
			chunk_byte_length: number;
			chunk_sha256: string;
			storage_type: string;
			stored_bytes: number;
			data: ArrayBuffer;
		}>(`SELECT chunk_index, semantic_epoch, chunk_byte_length, chunk_sha256,
		          typeof(data) AS storage_type, length(data) AS stored_bytes, data
		   FROM vault_checkpoints WHERE document_id = 'root' ORDER BY chunk_index`).toArray();
		const manifest = storage.sql.exec<{
			generation: number; semantic_epoch: number; chunk_count: number; total_byte_length: number;
			state_sha256: string; complete: number;
		}>(`SELECT generation, semantic_epoch, chunk_count, total_byte_length, state_sha256, complete
		   FROM vault_checkpoint_manifests WHERE document_id = 'root'`).one();
		const expectedDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", expectedCheckpoint))]
			.map((byte) => byte.toString(16).padStart(2, "0")).join("");
		assert.equal(written.chunks, checkpoint.length);
		assert.ok(checkpoint.length >= 2, "checkpoint fixture did not cross the SQLite row boundary");
		assert.ok(checkpoint.every((row) => row.storage_type === "blob" && row.stored_bytes <= SQLITE_BLOB_CHUNK_BYTES));
		assert.ok(checkpoint.every((row) => row.chunk_byte_length === row.stored_bytes));
		assert.ok(checkpoint.every((row) => row.semantic_epoch === written.semanticEpoch));
		assert.equal(checkpoint.reduce((total, row) => total + row.stored_bytes, 0), expectedCheckpoint.byteLength);
		assert.deepEqual(decodeSqlChunks(checkpoint), expectedCheckpoint);
		const invalidCheckpointInsert = `INSERT INTO vault_checkpoints(
			document_id, checkpoint_sequence, generation, semantic_epoch, chunk_index,
			chunk_byte_length, chunk_sha256, data
		) VALUES ('invalid-checkpoint', 999, 1, 1, 0, ?, ?, ?)`;
		assert.throws(() => storage.sql.exec(invalidCheckpointInsert, 1, "0".repeat(64), new Uint8Array([1, 2])).toArray(),
			/constraint/i, "checkpoint chunks reject declared/actual length mismatches at SQLite");
		assert.throws(() => storage.sql.exec(invalidCheckpointInsert, SQLITE_BLOB_CHUNK_BYTES, "0".repeat(64),
			new ArrayBuffer(SQLITE_BLOB_CHUNK_BYTES + 1)).toArray(), /constraint/i,
		"checkpoint chunks cannot bypass the safe row limit through direct SQL");
		assert.throws(() => storage.sql.exec(
			`INSERT INTO vault_checkpoints(document_id, checkpoint_sequence, generation, semantic_epoch,
			 chunk_index, chunk_byte_length, chunk_sha256, data)
			 SELECT document_id, checkpoint_sequence, generation, semantic_epoch, chunk_index,
			        chunk_byte_length, chunk_sha256, data
			 FROM vault_checkpoints WHERE document_id = 'root' AND chunk_index = 0`,
		).toArray(), /constraint/i, "duplicate checkpoint chunk indices are impossible");
		assert.deepEqual(manifest, {
			generation: written.generation,
			semantic_epoch: written.semanticEpoch,
			chunk_count: checkpoint.length,
			total_byte_length: expectedCheckpoint.byteLength,
			state_sha256: expectedDigest,
			complete: 1,
		});
		assert.equal(written.stateSha256, expectedDigest);
	} finally {
		doc.destroy();
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("oversized ordinary updates are rejected before storage initialization", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-vault-oversized-"));
	const storage = NodeSqliteStorage.open(join(directory, "state.sqlite"));
	try {
		const store = new VaultStore(storage);
		assert.throws(() => store.commitUpdate({
			documentId: "oversized-body",
			update: new Uint8Array(MAX_DURABLE_UPDATE_BYTES + 1),
			kind: "body",
		}), /exceeds durable value limit/);
		assert.equal(storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'vault_journal'",
		).one().count, 0, "rejection must happen before the first durable SQL write");
	} finally {
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("live-state checkpoints use exact-head CAS and corrupt checkpoint sets fail closed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-checkpoint-integrity-"));
	const storage = NodeSqliteStorage.open(join(directory, "state.sqlite"));
	const documentId = "checkpoint-integrity-body";
	const doc = new Y.Doc({ guid: documentId });
	try {
		const store = new VaultStore(storage);
		const firstVector = Y.encodeStateVector(doc);
		doc.getText("body").insert(0, "a".repeat(900_000));
		const firstCommit = store.commitUpdate({
			documentId,
			update: Y.encodeStateAsUpdate(doc, firstVector),
			kind: "body",
		});
		const firstLive = crdtEngine.openDocument(documentId, Y.encodeStateAsUpdate(doc));
		const firstCheckpoint = (() => {
			try {
				return store.writeCheckpointFromDocument(documentId, firstLive, {
					throughSequence: firstCommit.vaultSequence,
					generation: firstCommit.generation,
					semanticEpoch: firstCommit.semanticEpoch,
				});
			} finally { crdtEngine.destroyDocument(firstLive); }
		})();
		assert.equal(firstCheckpoint.chunks, 1);

		const secondVector = Y.encodeStateVector(doc);
		doc.getText("body").insert(doc.getText("body").length, `${"b".repeat(900_000)}new-head`);
		const secondCommit = store.commitUpdate({
			documentId,
			update: Y.encodeStateAsUpdate(doc, secondVector),
			kind: "body",
		});
		assert.throws(() => store.writeCheckpointFromEncodedState(documentId, Y.encodeStateAsUpdate(doc), {
			throughSequence: firstCommit.vaultSequence,
			generation: firstCommit.generation,
			semanticEpoch: firstCommit.semanticEpoch,
		}), /checkpoint head mismatch/);
		const secondCheckpoint = store.writeCheckpointFromEncodedState(documentId, Y.encodeStateAsUpdate(doc), {
			throughSequence: secondCommit.vaultSequence,
			generation: secondCommit.generation,
			semanticEpoch: secondCommit.semanticEpoch,
		});
		assert.equal(secondCheckpoint.checkpointSequence, secondCommit.vaultSequence);

		const chunkRows = storage.sql.exec<{
			chunk_index: number; chunk_byte_length: number; chunk_sha256: string; data: ArrayBuffer;
		}>(`SELECT chunk_index, chunk_byte_length, chunk_sha256, data FROM vault_checkpoints
		   WHERE document_id = ? AND checkpoint_sequence = ? ORDER BY chunk_index`,
		documentId, secondCommit.vaultSequence).toArray();
		assert.ok(chunkRows.length >= 2);
		const rollback = new Error("rollback corruption fixture");
		const rejectsCorruption = (mutate: () => void): void => {
			assert.throws(() => storage.transactionSync(() => {
				mutate();
				assert.throws(() => store.reconstructDocument(documentId), /checkpoint integrity failure/);
				throw rollback;
			}), /rollback corruption fixture/);
		};
		rejectsCorruption(() => storage.sql.exec(
			"DELETE FROM vault_checkpoints WHERE document_id = ? AND checkpoint_sequence = ? AND chunk_index = 1",
			documentId, secondCommit.vaultSequence,
		).toArray());
		rejectsCorruption(() => storage.sql.exec(
			"UPDATE vault_checkpoints SET chunk_index = 9 WHERE document_id = ? AND checkpoint_sequence = ? AND chunk_index = 1",
			documentId, secondCommit.vaultSequence,
		).toArray());
		rejectsCorruption(() => storage.sql.exec(
			`UPDATE vault_checkpoints SET data = ?, chunk_byte_length = ?, chunk_sha256 = ?
			 WHERE document_id = ? AND checkpoint_sequence = ? AND chunk_index = 1`,
			chunkRows[0]!.data, chunkRows[0]!.chunk_byte_length, chunkRows[0]!.chunk_sha256,
			documentId, secondCommit.vaultSequence,
		).toArray());
		const corrupt = new Uint8Array(chunkRows[0]!.data.slice(0));
		corrupt[Math.floor(corrupt.byteLength / 2)]! ^= 0xff;
		rejectsCorruption(() => storage.sql.exec(
			"UPDATE vault_checkpoints SET data = ? WHERE document_id = ? AND checkpoint_sequence = ? AND chunk_index = 0",
			corrupt, documentId, secondCommit.vaultSequence,
		).toArray());
		rejectsCorruption(() => storage.sql.exec(
			"UPDATE vault_checkpoint_manifests SET state_sha256 = ? WHERE document_id = ? AND checkpoint_sequence = ?",
			"0".repeat(64), documentId, secondCommit.vaultSequence,
		).toArray());
		rejectsCorruption(() => storage.sql.exec(
			"UPDATE vault_checkpoints SET semantic_epoch = semantic_epoch + 1 WHERE document_id = ? AND checkpoint_sequence = ? AND chunk_index = 0",
			documentId, secondCommit.vaultSequence,
		).toArray());
		rejectsCorruption(() => storage.sql.exec(
			"DELETE FROM vault_checkpoint_manifests WHERE document_id = ? AND checkpoint_sequence = ?",
			documentId, secondCommit.vaultSequence,
		).toArray());

		const reconstructed = store.reconstructDocument(documentId);
		assert.equal(crdtEngine.readText(reconstructed.doc, "body"), doc.getText("body").toString());
		crdtEngine.destroyDocument(reconstructed.doc);
	} finally {
		doc.destroy();
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("checkpoint manifest failure rolls back chunks and preserves the journal", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-checkpoint-rollback-"));
	const storage = NodeSqliteStorage.open(join(directory, "state.sqlite"));
	const documentId = "checkpoint-rollback-body";
	const doc = new Y.Doc({ guid: documentId });
	try {
		const store = new VaultStore(storage);
		doc.getText("body").insert(0, "must remain reconstructable");
		const commit = store.commitUpdate({
			documentId,
			update: Y.encodeStateAsUpdate(doc),
			kind: "body",
		});
		storage.sql.exec(`CREATE TRIGGER reject_checkpoint_manifest
		 BEFORE INSERT ON vault_checkpoint_manifests
		 BEGIN SELECT RAISE(ABORT, 'injected manifest failure'); END`).toArray();
		const live = crdtEngine.openDocument(documentId, Y.encodeStateAsUpdate(doc));
		try {
			assert.throws(() => store.writeCheckpointFromDocument(documentId, live, {
				throughSequence: commit.vaultSequence,
				generation: commit.generation,
				semanticEpoch: commit.semanticEpoch,
			}), /injected manifest failure/);
		} finally { crdtEngine.destroyDocument(live); }
		assert.equal(storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM vault_checkpoints WHERE document_id = ?", documentId,
		).one().count, 0);
		assert.equal(storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM vault_checkpoint_manifests WHERE document_id = ?", documentId,
		).one().count, 0);
		assert.equal(storage.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM vault_journal WHERE document_id = ?", documentId,
		).one().count, 1);
		const reconstructed = store.reconstructDocument(documentId);
		assert.equal(crdtEngine.readText(reconstructed.doc, "body"), "must remain reconstructable");
		crdtEngine.destroyDocument(reconstructed.doc);
	} finally {
		doc.destroy();
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("semantic reset atomically replaces CRDT identity and advances only its epoch", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-semantic-reset-"));
	const storage = NodeSqliteStorage.open(join(directory, "state.sqlite"));
	const documentId = "semantic-reset-body";
	const historical = new Y.Doc({ guid: documentId });
	const fresh = new Y.Doc({ guid: documentId });
	try {
		const store = new VaultStore(storage);
		const text = historical.getText("body");
		for (let index = 0; index < 2_000; index++) {
			text.insert(text.length, "discarded-history");
			text.delete(Math.max(0, text.length - 17), 17);
		}
		text.insert(0, "canonical current text");
		const commit = store.commitUpdate({
			documentId,
			update: Y.encodeStateAsUpdate(historical),
			kind: "body",
			catalog: { bodyId: documentId, fileId: documentId, path: "semantic-reset.md",
				previousPath: null, lifecycle: "active", bodyGeneration: 1,
				contentHash: null, size: text.length },
		});
		assert.equal(commit.semanticEpoch, 1);
		fresh.getText("body").insert(0, text.toString());
		const freshState = Y.encodeStateAsUpdate(fresh);
		const expectedHead = {
			throughSequence: commit.vaultSequence,
			generation: commit.generation,
			semanticEpoch: commit.semanticEpoch,
		};

		storage.sql.exec(`CREATE TRIGGER reject_semantic_reset_manifest
		 BEFORE INSERT ON vault_checkpoint_manifests
		 BEGIN SELECT RAISE(ABORT, 'injected semantic reset failure'); END`).toArray();
		assert.throws(() => store.semanticResetFromEncodedState(documentId, freshState, expectedHead),
			/injected semantic reset failure/);
		assert.deepEqual(store.documentHead(documentId), {
			generation: commit.generation,
			semanticEpoch: 1,
			latestSequence: commit.vaultSequence,
		});
		assert.equal(store.currentSequence(), commit.vaultSequence);
		storage.sql.exec("DROP TRIGGER reject_semantic_reset_manifest").toArray();

		const reset = store.semanticResetFromEncodedState(documentId, freshState, expectedHead);
		assert.equal(reset.previousSemanticEpoch, 1);
		assert.equal(reset.semanticEpoch, 2);
		assert.equal(reset.generation, commit.generation, "identity reset must not invent a content generation");
		assert.equal(store.getCatalogHeadAt(reset.vaultSequence, documentId)?.bodyEpoch, 2,
			"catalog currentness advances atomically with the body lineage");
		assert.equal(reset.vaultSequence, commit.vaultSequence + 1);
		assert.deepEqual(store.documentHead(documentId), {
			generation: commit.generation,
			semanticEpoch: 2,
			latestSequence: reset.vaultSequence,
		});
		const reconstructed = store.reconstructDocument(documentId);
		assert.equal(reconstructed.semanticEpoch, 2);
		assert.equal(reconstructed.generation, commit.generation);
		assert.equal(reconstructed.checkpointSequence, reset.vaultSequence);
		assert.equal(reconstructed.journalUpdates, 0);
		assert.equal(crdtEngine.readText(reconstructed.doc, "body"), text.toString());
		assert.deepEqual(crdtEngine.encodeStateAsUpdate(reconstructed.doc), freshState,
			"reset baseline must contain only the caller's fresh identities");
		crdtEngine.destroyDocument(reconstructed.doc);
		const resetFeed = store.listChangesAfter(commit.vaultSequence);
		assert.deepEqual(resetFeed.map((entry) => ({
			kind: entry.kind, generation: entry.generation, semanticEpoch: entry.documentEpoch,
		})), [{ kind: "semantic-reset", generation: commit.generation, semanticEpoch: 2 }]);
		assert.throws(() => store.semanticResetFromEncodedState(documentId, freshState, expectedHead),
			/checkpoint head mismatch/);
	} finally {
		historical.destroy();
		fresh.destroy();
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
