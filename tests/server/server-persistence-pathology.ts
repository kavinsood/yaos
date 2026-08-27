/**
 * Regression for the Issue #24 reporter shape: a Durable Object cold-loads a
 * two-row, near-empty journal, receives a complete vault from one client, and
 * must make that refill durable for the next client.
 *
 * Threshold/fallback behavior lives in sql-oversized-delta-e2e.ts. Failure,
 * retry, and delete-only behavior lives in persistence-delete-only.ts. Keeping
 * those contracts in focused suites avoids repeating coordinator simulations
 * here.
 */
import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined") {
	Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

import * as Y from "yjs";
import { PersistenceCoordinator } from "../../server/src/persistenceCoordinator";
import { SqlDocStore } from "../../server/src/sqlDocStore";
import { FakeDurableObjectStorage } from "../mocks/sqlStorage";
import { suite } from "../harness.ts";

const s = suite("server-persistence-pathology");

interface VaultDoc {
	readonly doc: Y.Doc;
	readonly pathToId: Y.Map<string>;
	readonly idToText: Y.Map<Y.Text>;
	readonly meta: Y.Map<{ path: string; deleted?: boolean }>;
}

function makeVaultDoc(): VaultDoc {
	const doc = new Y.Doc();
	return {
		doc,
		pathToId: doc.getMap<string>("pathToId"),
		idToText: doc.getMap<Y.Text>("idToText"),
		meta: doc.getMap("meta"),
	};
}

function populateReporterVault(vault: VaultDoc): void {
	vault.doc.transact(() => {
		vault.doc.getMap("sys").set("schemaVersion", 8);
		vault.doc.getMap("sys").set("initialized", true);
		for (let index = 0; index < 666; index++) {
			const path = `folder-${Math.floor(index / 50)}/note-${index}.md`;
			const fileId = `file-${String(index).padStart(5, "0")}`;
			let content = `# Note ${index}\n\n`;
			while (content.length < 500) {
				content += `Line ${content.length}: reporter persistence payload.\n`;
			}
			const text = new Y.Text();
			text.insert(0, content.slice(0, 500));
			vault.pathToId.set(path, fileId);
			vault.idToText.set(fileId, text);
			vault.meta.set(fileId, { path, deleted: false });
		}
	}, "disk-sync");
}

function coldStartClient(storage: FakeDurableObjectStorage): VaultDoc {
	const persisted = new SqlDocStore(storage).loadState();
	const serverDoc = new Y.Doc();
	if (persisted.snapshot) Y.applyUpdate(serverDoc, persisted.snapshot);
	for (const update of persisted.journalUpdates) Y.applyUpdate(serverDoc, update);
	const client = makeVaultDoc();
	Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(serverDoc));
	serverDoc.destroy();
	return client;
}

function readFile(vault: VaultDoc, path: string): string | null {
	const fileId = vault.pathToId.get(path);
	return fileId ? vault.idToText.get(fileId)?.toString() ?? null : null;
}

s.section("Reporter pathology: two tiny rows accept a 666-file refill that survives cold load");
{
	const storage = new FakeDurableObjectStorage();
	const store = new SqlDocStore(storage);

	const sentinel = new Y.Doc();
	sentinel.getMap("sys").set("schemaVersion", 8);
	const firstStateVector = Y.encodeStateVector(sentinel);
	store.appendUpdate(Y.encodeStateAsUpdate(sentinel));
	sentinel.getMap("sys").set("initialized", true);
	store.appendUpdate(Y.encodeStateAsUpdate(sentinel, firstStateVector));

	const before = store.getJournalStats();
	s.check(before.entryCount === 2, `reporter-like journal has exactly 2 rows (got ${before.entryCount})`);
	s.check(before.totalBytes < 200, `reporter-like journal is near-empty (${before.totalBytes} bytes)`);

	const persisted = store.loadState();
	const serverDoc = new Y.Doc();
	if (persisted.snapshot) Y.applyUpdate(serverDoc, persisted.snapshot);
	for (const update of persisted.journalUpdates) Y.applyUpdate(serverDoc, update);

	const coordinator = new PersistenceCoordinator(serverDoc, store);
	coordinator.setInitialStateVector(Y.encodeStateVector(serverDoc));
	const clientA = makeVaultDoc();
	populateReporterVault(clientA);
	Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(clientA.doc, Y.encodeStateVector(serverDoc)));

	const save = await coordinator.enqueueSave();
	s.check(save.success, `real coordinator persisted the refill (method=${save.method}, error=${save.error ?? "none"})`);
	s.check(save.method === "append", `reporter-sized refill used the journal append path (got ${save.method})`);
	const after = store.getJournalStats();
	s.check(after.entryCount === 3, `refill added one durable journal row (got ${after.entryCount})`);
	s.check(after.totalBytes > 100_000, `journal bytes reflect the full vault (got ${after.totalBytes})`);

	const clientB = coldStartClient(storage);
	s.check(clientB.pathToId.size === 666, `fresh Device B receives all 666 paths (got ${clientB.pathToId.size})`);
	s.check(readFile(clientB, "folder-0/note-0.md")?.startsWith("# Note 0") === true, "Device B receives the first file content");
	s.check(readFile(clientB, "folder-13/note-665.md")?.startsWith("# Note 665") === true, "Device B receives the last file content");

	coordinator.dispose();
	sentinel.destroy();
	serverDoc.destroy();
	clientA.doc.destroy();
	clientB.doc.destroy();
}

await s.done();
