/**
 * Phase 1.5 — Server-state offline handoff test (FU-9a).
 *
 * Validates the **server-persistence layer** of the offline handoff claim:
 * edits written to ChunkedDocStore by Device A can be loaded cold by Device B
 * without A being present.
 *
 * SCOPE — what this test proves:
 *   Y.Doc (A) → delta/checkpoint/journal → ChunkedDocStore → Y.Doc (B)
 *   The YAOS vault schema (pathToId / idToText / meta) survives the round-trip.
 *   B can read A's file content, path mappings, and tombstones without A online.
 *
 * SCOPE — what this test does NOT prove (FU-9b, still open):
 *   - Real WebSocket provider lifecycle (connect, disconnect, reconnect)
 *   - Durable Object hibernation / cold-start behavior
 *   - Auth / session gates during handoff
 *   - IndexedDB client-cache interplay (y-indexeddb persistence)
 *   - Obsidian reconciliation / disk mirror writeback after B receives state
 *   - Provider sync-event ordering and client-side catch-up update counting
 *
 * The server reconstruction step (load checkpoint + journal, apply to Y.Doc)
 * mirrors VaultSyncServer.ensureDocumentLoaded(). The client-side apply step
 * (encode server state, apply to fresh doc) mirrors the initial provider sync.
 */

import { webcrypto } from "node:crypto";

if (typeof globalThis.crypto === "undefined") {
	globalThis.crypto = webcrypto as unknown as Crypto;
}

import * as Y from "yjs";
import { ChunkedDocStore } from "../server/src/chunkedDocStore";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

// ── FakeStorage (mirrors tests/chunked-doc-store.ts) ─────────────────────────

class FakeStorage {
	readonly data = new Map<string, unknown>();

	async get<T = unknown>(key: string): Promise<T | undefined>;
	async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
		if (Array.isArray(keyOrKeys)) {
			const out = new Map<string, T>();
			for (const key of keyOrKeys) {
				if (this.data.has(key)) out.set(key, this.data.get(key) as T);
			}
			return out;
		}
		return this.data.get(keyOrKeys) as T | undefined;
	}

	async put<T>(entries: Record<string, T>): Promise<void> {
		for (const [key, value] of Object.entries(entries)) {
			this.data.set(key, value);
		}
	}

	async delete(keys: string[]): Promise<number> {
		let deleted = 0;
		for (const key of keys) {
			if (this.data.delete(key)) deleted++;
		}
		return deleted;
	}

	async transaction<T>(closure: (txn: FakeTransaction) => Promise<T>): Promise<T> {
		return closure(new FakeTransaction(this));
	}
}

class FakeTransaction {
	constructor(private readonly storage: FakeStorage) {}

	async get<T = unknown>(key: string): Promise<T | undefined>;
	async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
		return this.storage.get(keyOrKeys as string);
	}

	async put<T>(entries: Record<string, T>): Promise<void> {
		return this.storage.put(entries);
	}

	async delete(keys: string[]): Promise<number> {
		return this.storage.delete(keys);
	}
}

// ── YAOS vault schema helpers ─────────────────────────────────────────────────

type FileMeta = { path: string; deleted?: boolean };

interface VaultDoc {
	doc: Y.Doc;
	pathToId: Y.Map<string>;
	idToText: Y.Map<Y.Text>;
	meta: Y.Map<FileMeta>;
	sys: Y.Map<unknown>;
}

function makeVaultDoc(): VaultDoc {
	const doc = new Y.Doc();
	return {
		doc,
		pathToId: doc.getMap<string>("pathToId"),
		idToText: doc.getMap<Y.Text>("idToText"),
		meta: doc.getMap<FileMeta>("meta"),
		sys: doc.getMap<unknown>("sys"),
	};
}

function writeFile(vault: VaultDoc, path: string, content: string, fileId: string): void {
	vault.doc.transact(() => {
		vault.pathToId.set(path, fileId);
		const text = new Y.Text();
		text.insert(0, content);
		vault.idToText.set(fileId, text);
		vault.meta.set(fileId, { path, deleted: false });
	}, "disk-sync");
}

function readFile(vault: VaultDoc, path: string): string | null {
	const fileId = vault.pathToId.get(path);
	if (!fileId) return null;
	const ytext = vault.idToText.get(fileId);
	if (!ytext) return null;
	return ytext.toString();
}

function activePaths(vault: VaultDoc): string[] {
	const paths: string[] = [];
	vault.pathToId.forEach((_, path) => {
		const fileId = vault.pathToId.get(path);
		if (!fileId) return;
		const m = vault.meta.get(fileId);
		if (!m?.deleted) paths.push(path);
	});
	return paths.sort();
}

// ── Server persistence helpers ────────────────────────────────────────────────

/**
 * Apply a device doc's state onto the server doc (delta only), then persist
 * the delta to the store's journal. Returns the number of bytes written.
 */
async function syncDeviceToServer(
	deviceDoc: Y.Doc,
	serverDoc: Y.Doc,
	store: ChunkedDocStore,
): Promise<number> {
	const serverSV = Y.encodeStateVector(serverDoc);
	const delta = Y.encodeStateAsUpdate(deviceDoc, serverSV);
	if (delta.byteLength === 0) return 0;
	Y.applyUpdate(serverDoc, delta);
	await store.appendUpdate(delta);
	return delta.byteLength;
}

/**
 * Checkpoint the current server doc state into the store, clearing the
 * journal. Mirrors VaultSyncServer.enqueueSave() compaction path.
 */
async function checkpointServer(serverDoc: Y.Doc, store: ChunkedDocStore): Promise<void> {
	const update = Y.encodeStateAsUpdate(serverDoc);
	const stateVector = Y.encodeStateVector(serverDoc);
	await store.rewriteCheckpoint(update, stateVector);
}

/**
 * Cold-start Device B: load all persisted state from the store, reconstruct
 * the server Y.Doc, then apply the full server state to a fresh vault doc.
 * Mirrors VaultSyncServer.ensureDocumentLoaded() + initial provider sync.
 */
async function coldStartDevice(store: ChunkedDocStore): Promise<VaultDoc> {
	const state = await store.loadState();

	// Reconstruct server doc exactly as VaultSyncServer does on load
	const serverDoc = new Y.Doc();
	if (state.checkpoint) {
		Y.applyUpdate(serverDoc, state.checkpoint);
	}
	for (const journalUpdate of state.journalUpdates) {
		Y.applyUpdate(serverDoc, journalUpdate);
	}

	// Apply full server state to fresh device doc (initial provider sync)
	const deviceVault = makeVaultDoc();
	const fullState = Y.encodeStateAsUpdate(serverDoc);
	Y.applyUpdate(deviceVault.doc, fullState);

	return deviceVault;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("\n--- Test 1: basic handoff — A writes and checkpoints, B cold-starts ---");
{
	// Device A writes a note
	const deviceA = makeVaultDoc();
	writeFile(deviceA, "Inbox/note.md", "# Hello from A", "file-001");

	// Server starts empty; A syncs to it; server checkpoints
	const serverDoc = new Y.Doc();
	const store = new ChunkedDocStore(new FakeStorage());
	await syncDeviceToServer(deviceA.doc, serverDoc, store);
	await checkpointServer(serverDoc, store);

	// A goes offline. B cold-starts from checkpoint.
	const deviceB = await coldStartDevice(store);

	assert(readFile(deviceB, "Inbox/note.md") === "# Hello from A", "B has A's note content");
	assert(activePaths(deviceB).includes("Inbox/note.md"), "B sees the path in its vault");
	assert(deviceB.pathToId.get("Inbox/note.md") === "file-001", "B has the stable file ID");
}

console.log("\n--- Test 2: offline edit handoff — A edits while disconnected, then syncs, B gets it ---");
{
	// Phase 1: Establish baseline on server.
	const serverDoc = new Y.Doc();
	const store = new ChunkedDocStore(new FakeStorage());

	const deviceA = makeVaultDoc();
	writeFile(deviceA, "Daily/2026-05-01.md", "# May 1 baseline", "file-daily");
	await syncDeviceToServer(deviceA.doc, serverDoc, store);
	await checkpointServer(serverDoc, store);

	// Phase 2: A goes offline and makes a new note.
	writeFile(deviceA, "Projects/idea.md", "# New idea (offline)", "file-idea");
	// A's local doc now has two files; server still only has one.
	assert(activePaths(deviceA).length === 2, "A has 2 files locally");
	assert(readFile(deviceA, "Projects/idea.md") !== null, "A's offline note exists locally");

	// Phase 3: A reconnects and syncs the offline edit to server.
	await syncDeviceToServer(deviceA.doc, serverDoc, store);
	await checkpointServer(serverDoc, store);

	// Phase 4: A goes offline again. B cold-starts with the new server state.
	const deviceB = await coldStartDevice(store);

	assert(readFile(deviceB, "Daily/2026-05-01.md") === "# May 1 baseline", "B has baseline file");
	assert(readFile(deviceB, "Projects/idea.md") === "# New idea (offline)", "B has A's offline edit");
	assert(activePaths(deviceB).length === 2, "B sees both files");
}

console.log("\n--- Test 3: no simultaneous presence required ---");
{
	// The entire test proves this, but this variant makes it explicit:
	// after A syncs, A is never touched again. B connects to a different
	// object (new store load) to simulate a fresh device.

	const serverDoc = new Y.Doc();
	const store = new ChunkedDocStore(new FakeStorage());

	const deviceA = makeVaultDoc();
	writeFile(deviceA, "vault-root.md", "This is the vault root", "file-root");
	writeFile(deviceA, "Folder/sub.md", "A sub-note", "file-sub");

	await syncDeviceToServer(deviceA.doc, serverDoc, store);
	await checkpointServer(serverDoc, store);

	// A is now completely out of scope. B bootstraps independently.
	const deviceA_ref = null; // intentionally discard
	void deviceA_ref;

	const deviceB = await coldStartDevice(store);
	assert(readFile(deviceB, "vault-root.md") === "This is the vault root", "B has root note without A present");
	assert(readFile(deviceB, "Folder/sub.md") === "A sub-note", "B has subfolder note without A present");
	assert(activePaths(deviceB).length === 2, "B has complete vault without A");
}

console.log("\n--- Test 4: journal-based handoff (no explicit checkpoint) ---");
{
	// Verify that journal entries alone — without a full rewriteCheckpoint call —
	// are sufficient for B to receive A's edits. This mirrors the path where
	// A's updates are in the journal but haven't triggered compaction yet.

	const serverDoc = new Y.Doc();
	const store = new ChunkedDocStore(new FakeStorage());

	const deviceA = makeVaultDoc();
	writeFile(deviceA, "Journal/entry.md", "Day 1", "file-j1");
	await syncDeviceToServer(deviceA.doc, serverDoc, store);
	// No checkpointServer here — state lives only in the journal

	const deviceB = await coldStartDevice(store);
	assert(readFile(deviceB, "Journal/entry.md") === "Day 1", "B gets journal-only state without checkpoint");
}

console.log("\n--- Test 5: incremental offline edits over multiple sync cycles ---");
{
	// A makes three separate offline edit sessions, each followed by a sync.
	// B connects after the third sync and should have all of A's content.
	const serverDoc = new Y.Doc();
	const store = new ChunkedDocStore(new FakeStorage());
	const deviceA = makeVaultDoc();

	// Session 1
	writeFile(deviceA, "s1.md", "session 1", "file-s1");
	await syncDeviceToServer(deviceA.doc, serverDoc, store);
	await checkpointServer(serverDoc, store);

	// Session 2: A goes offline again, makes more edits
	writeFile(deviceA, "s2.md", "session 2", "file-s2");
	await syncDeviceToServer(deviceA.doc, serverDoc, store);

	// Session 3: another offline edit, sync via journal (no checkpoint)
	writeFile(deviceA, "s3.md", "session 3", "file-s3");
	await syncDeviceToServer(deviceA.doc, serverDoc, store);

	// B cold-starts from mixed checkpoint + journal state
	const deviceB = await coldStartDevice(store);
	assert(readFile(deviceB, "s1.md") === "session 1", "B has session 1 content");
	assert(readFile(deviceB, "s2.md") === "session 2", "B has session 2 content");
	assert(readFile(deviceB, "s3.md") === "session 3", "B has session 3 content");
	assert(activePaths(deviceB).length === 3, "B has all three files");
}

console.log("\n--- Test 6: content edit (not just file creation) survives handoff ---");
{
	// A creates a file, syncs, then edits the content offline, syncs again.
	// B should have the latest content, not the original.
	const serverDoc = new Y.Doc();
	const store = new ChunkedDocStore(new FakeStorage());
	const deviceA = makeVaultDoc();

	// Create initial version
	writeFile(deviceA, "evolving.md", "version 1", "file-ev");
	await syncDeviceToServer(deviceA.doc, serverDoc, store);
	await checkpointServer(serverDoc, store);

	// Edit the content (simulate a user editing the note while offline)
	const fileId = deviceA.pathToId.get("evolving.md")!;
	const ytext = deviceA.idToText.get(fileId)!;
	deviceA.doc.transact(() => {
		ytext.delete(0, ytext.length);
		ytext.insert(0, "version 2 — updated offline");
	}, "editor-edit");
	await syncDeviceToServer(deviceA.doc, serverDoc, store);
	await checkpointServer(serverDoc, store);

	const deviceB = await coldStartDevice(store);
	assert(
		readFile(deviceB, "evolving.md") === "version 2 — updated offline",
		"B has the updated content, not the original",
	);
}

console.log("\n--- Test 7: deleted file does not appear on B ---");
{
	// A creates a file, syncs, then deletes it (tombstone), syncs again.
	// B cold-starts and should not see the deleted file as active.
	const serverDoc = new Y.Doc();
	const store = new ChunkedDocStore(new FakeStorage());
	const deviceA = makeVaultDoc();

	writeFile(deviceA, "to-delete.md", "ephemeral", "file-del");
	await syncDeviceToServer(deviceA.doc, serverDoc, store);

	// Mark as deleted (tombstone via meta — mirrors VaultSync delete path)
	const fileId = deviceA.pathToId.get("to-delete.md")!;
	deviceA.doc.transact(() => {
		deviceA.meta.set(fileId, { path: "to-delete.md", deleted: true });
	}, "disk-sync");
	await syncDeviceToServer(deviceA.doc, serverDoc, store);
	await checkpointServer(serverDoc, store);

	const deviceB = await coldStartDevice(store);
	// activePaths() filters out deleted entries
	assert(!activePaths(deviceB).includes("to-delete.md"), "B does not see deleted file in active paths");
	// File ID still exists (CRDT tombstone) but is flagged as deleted
	const bFileId = deviceB.pathToId.get("to-delete.md");
	if (bFileId) {
		assert(deviceB.meta.get(bFileId)?.deleted === true, "B has the tombstone flag");
	}
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
