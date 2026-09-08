import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Y from "yjs";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";
import { suite } from "../harness.ts";

const s = suite("vault-document-store-hotpaths");

function update(doc: Y.Doc, mutate: () => void): Uint8Array {
	const vector = Y.encodeStateVector(doc);
	mutate();
	return Y.encodeStateAsUpdate(doc, vector);
}

async function withStore(check: (
	store: VaultStore,
	sqlite: NodeSqliteStorage,
	queries: { value: number },
) => void | Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-document-hotpaths-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	const queries = { value: 0 };
	const storage = {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				queries.value++;
				return sqlite.sql.exec(query, ...bindings);
			},
		},
		transactionSync<T>(closure: () => T): T {
			return sqlite.transactionSync(closure);
		},
	} as unknown as VaultStoragePort;
	try {
		await check(new VaultStore(storage), sqlite, queries);
	} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

s.test("reconstruction, recipes, and feed catalogs use a constant number of SQL statements", async () => {
	await withStore((store, _sqlite, queries) => {
		const doc = new Y.Doc({ guid: "hot-body" });
		for (let index = 0; index < 80; index++) {
			const bytes = update(doc, () => doc.getText("body").insert(doc.getText("body").length, String(index % 10)));
			store.commitUpdate({
				documentId: "hot-body",
				update: bytes,
				kind: "body",
				catalog: index === 79 ? [{
					bodyId: "catalog-a", fileId: "catalog-a", path: "a.md", previousPath: null,
					lifecycle: "active", bodyGeneration: 1,
				}, {
					bodyId: "catalog-b", fileId: "catalog-b", path: "b.md", previousPath: null,
					lifecycle: "active", bodyGeneration: 1,
				}] : undefined,
			});
		}
		const boundary = store.currentSequence();

		queries.value = 0;
		const reconstructed = store.reconstructDocument("hot-body", boundary);
		assert.equal(queries.value, 2, "journal length must not affect reconstruction statement count");
		assert.equal(reconstructed.journalUpdates, 80);
		assert.equal(reconstructed.doc.getText("body").toString(), doc.getText("body").toString());
		reconstructed.doc.destroy();

		queries.value = 0;
		const feed = store.listChangesAfter(0, 1000);
		assert.equal(queries.value, 3, "Markdown and semantic catalog lookups must each be one batched statement, not one per feed row");
		assert.deepEqual(feed.at(-1)?.catalogs.map((entry) => entry.path), ["a.md", "b.md"]);

		queries.value = 0;
		const recipe = store.rawDocumentRecipeChunk("hot-body", boundary, "0", Number.MAX_SAFE_INTEGER);
		assert.ok(queries.value <= 4, `recipe used ${queries.value} SQL statements for ${recipe.parts.length} parts`);
		assert.equal(recipe.parts.length, 80);
		assert.equal(recipe.nextCursor, null);
		assert.equal(recipe.encodedBytes, recipe.parts.reduce((total, part) => total + part.bytes.byteLength, 0));

		queries.value = 0;
		const onePart = store.rawDocumentRecipeChunk("hot-body", boundary, "0", recipe.parts[0]!.bytes.byteLength);
		assert.equal(queries.value, 3, "a bounded recipe page must still use a constant number of statements");
		assert.equal(onePart.parts.length, 1);
		assert.equal(onePart.nextCursor, "1");
		assert.equal(onePart.encodedBytes, onePart.parts[0]!.bytes.byteLength);
		doc.destroy();
	});
});

s.test("checkpoint accounting stays in SQL and live pins retain their historical checkpoint", async () => {
	await withStore((store, sqlite, queries) => {
		const doc = new Y.Doc({ guid: "pin-body" });
		store.commitUpdate({
			documentId: "pin-body",
			update: update(doc, () => doc.getText("body").insert(0, "boundary")),
			kind: "body",
		});
		const pinBoundary = store.currentSequence();
		const pin = store.createPin({ kind: "capture", boundarySequence: pinBoundary, pinId: "hotpath-pin" });
		assert.equal(store.writeCheckpoint("pin-body", pinBoundary).status, "written");

		const newerCheckpoints: number[] = [];
		let laterPinId = "";
		for (let index = 0; index < 5; index++) {
			store.commitUpdate({
				documentId: "pin-body",
				update: update(doc, () => doc.getText("body").insert(doc.getText("body").length, String(index))),
				kind: "body",
			});
			const sequence = store.currentSequence();
			newerCheckpoints.push(sequence);
			store.writeCheckpoint("pin-body", sequence);
			if (index === 1) {
				laterPinId = store.createPin({
					kind: "bootstrap", boundarySequence: sequence, pinId: "hotpath-later-pin",
				}).pinId;
			}
		}

		const retained = sqlite.sql.exec<{ checkpoint_sequence: number }>(
			`SELECT DISTINCT checkpoint_sequence FROM vault_checkpoints
			 WHERE document_id = 'pin-body' ORDER BY checkpoint_sequence`,
		).toArray().map((row) => row.checkpoint_sequence);
		assert.deepEqual(retained, [pinBoundary, newerCheckpoints[1], ...newerCheckpoints.slice(-3)],
			"pruning must retain every pin boundary checkpoint in addition to the latest three");

		queries.value = 0;
		const historical = store.reconstructDocument("pin-body", pinBoundary);
		assert.equal(queries.value, 2, "checkpoint reconstruction must be one checkpoint read plus one joined journal read");
		assert.equal(historical.doc.getText("body").toString(), "boundary");
		historical.doc.destroy();

		const latest = newerCheckpoints.at(-1)!;
		const physicalCheckpointBytes = sqlite.sql.exec<{ bytes: number }>(
			`SELECT SUM(length(data)) AS bytes FROM vault_checkpoints
			 WHERE document_id = 'pin-body' AND checkpoint_sequence = ?`, latest,
		).one().bytes;
		queries.value = 0;
		assert.equal(store.documentEncodedHistoryBytes("pin-body", latest), physicalCheckpointBytes);
		assert.equal(queries.value, 3, "checkpoint size accounting must use one aggregate row, not read every BLOB");
		assert.equal(store.releasePin(pin.pinId), true);
		assert.equal(store.releasePin(laterPinId), true);
		doc.destroy();
	});
});

s.test("fragmented checkpoints retain three logical checkpoint generations", async () => {
	await withStore((store, sqlite) => {
		const documentId = "fragmented-checkpoint-pruning";
		const doc = new Y.Doc({ guid: documentId });
		const checkpointSequences: number[] = [];
		const commitAndCheckpoint = (mutation: () => void): void => {
			store.commitUpdate({ documentId, update: update(doc, mutation), kind: "body" });
			const sequence = store.currentSequence();
			checkpointSequences.push(sequence);
			store.writeCheckpoint(documentId, sequence);
		};
		try {
			commitAndCheckpoint(() => doc.getText("body").insert(0, "a"));
			commitAndCheckpoint(() => doc.getText("body").insert(1, "b"));
			commitAndCheckpoint(() => doc.getMap<Uint8Array>("checkpoint-padding").set("first", new Uint8Array(900_000)));
			commitAndCheckpoint(() => doc.getMap<Uint8Array>("checkpoint-padding").set("second", new Uint8Array(900_000)));

			const physicalRows = sqlite.sql.exec<{ checkpoint_sequence: number; fragments: number }>(
				`SELECT checkpoint_sequence, COUNT(*) AS fragments FROM vault_checkpoints
				 WHERE document_id = ? GROUP BY checkpoint_sequence ORDER BY checkpoint_sequence`,
				documentId,
			).toArray();
			assert.ok(physicalRows.at(-1)!.fragments > 1, "fixture did not create a fragmented checkpoint");
			assert.deepEqual(
				physicalRows.map((row) => row.checkpoint_sequence),
				checkpointSequences.slice(-3),
				"fragment rows must not consume the three-logical-checkpoint retention budget",
			);
		} finally {
			doc.destroy();
		}
	});
});

await s.done();
