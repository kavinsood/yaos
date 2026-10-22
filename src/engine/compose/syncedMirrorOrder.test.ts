/**
 * Synced mirror vs outbox mirror ordering (DESIGN §e.4, §i.5): the synced
 * mirror is written only after the outbox mirror holds the outbox, so it never
 * records a sync point resting on own frames recovery could not resend.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentHash, DiskFingerprint, DocId, PathKey, Seq, VaultPath } from "../../core/types";
import { createWebClock } from "../adapters/webClock";
import { createWebHash } from "../adapters/webHash";
import { MemStoragePort } from "../../sim/storage";
import { encodeOutboxMirror, UNTRUSTED_CONTENT_HASH, type MirrorIdentity } from "../runtime/mirrors";
import { MemSideFiles } from "../runtime/testHarness";
import type { DiskSchema } from "../reconcile/store";
import { DB_SCHEMA_VERSION, STORE, STORE_SPECS, type SyncedRecord } from "../store/schema";
import { importSyncedMirror, SyncedMirrorWriter } from "./syncedMirror";

const rec: SyncedRecord = {
	docId: "ovKII8dvM_BlX4o2D6nFKw" as DocId, path: "a.md" as VaultPath, pathKey: "a.md" as PathKey, kind: "markdown", contentHash: "ab".repeat(32) as ContentHash,
	fingerprint: "" as DiskFingerprint, size: 3, mtimeMs: 0, bodyVersion: { remoteSeq: 4 as Seq, localOrder: 7 }, blobRev: 0 as Seq,
	nsTouchSeq: 2 as Seq, hasBase: true, syncedAtMs: 0,
};

function writer(before: () => Promise<boolean>, events: string[]): { w: SyncedMirrorWriter; side: MemSideFiles } {
	const side = new MemSideFiles();
	const orig = side.write.bind(side);
	side.write = async (n, b) => {
		events.push(`write ${n}`);
		await orig(n, b);
	};
	const w = new SyncedMirrorWriter({
		side, hash: createWebHash(), clock: createWebClock(), identity: () => ({ vaultId: "v", vaultEpoch: "e", deviceId: "dev" }) as never,
		entries: () => {
			events.push("entries");
			return [rec];
		},
		nsCoversSeq: () => 2 as Seq, debounceMs: 60_000, before,
	});
	return { w, side };
}

test("synced mirror: entries are taken, then the outbox mirror is flushed, then the synced mirror is written", async () => {
	const events: string[] = [];
	const { w } = writer(async () => {
		events.push("outbox flushed");
		return true;
	}, events);
	w.markDirty();
	await w.flush();
	assert.deepEqual(events, ["entries", "outbox flushed", "write synced-a.bin"]);
	assert.equal(w.stats.writes, 1);
});

test("synced mirror: not written while the outbox mirror is behind; written once it caught up", async () => {
	const events: string[] = [];
	let ok = false;
	const { w, side } = writer(async () => ok, events);
	w.markDirty();
	await w.flush();
	assert.equal(side.files.size, 0, "no synced mirror ahead of the outbox mirror");
	assert.equal(w.stats.failures, 1);
	ok = true;
	await w.flush(); // still dirty
	assert.equal(w.stats.writes, 1);
	assert.ok(side.files.has("synced-a.bin"));
});

test("recovery: a doc the outbox mirror lists as unmirrored is imported with no trusted content hash (sim suite 1 seed 197)", async () => {
	const other: SyncedRecord = { ...rec, docId: "Qp-d2zcQZkXoWhSso7XJ7A" as DocId, path: "b.md" as VaultPath, pathKey: "b.md" as PathKey };
	const identity = { vaultId: "v", vaultEpoch: "e", deviceId: "dev" } as MirrorIdentity;
	const hash = createWebHash();
	const run = async (unmirrored: readonly DocId[] | undefined): Promise<Map<string, ContentHash>> => {
		const side = new MemSideFiles();
		const w = new SyncedMirrorWriter({ side, hash, clock: createWebClock(), identity: () => identity, entries: () => [rec, other], nsCoversSeq: () => 2 as Seq, debounceMs: 60_000 });
		w.markDirty();
		await w.flush();
		// The store's outbox held an own record of `rec`'s doc it could not mirror (an unsealed stale copy): listed.
		await side.write("outbox-a.bin", await encodeOutboxMirror({ ...identity, generation: 1, writtenAtMs: 0, frames: [], ...(unmirrored ? { unmirrored } : {}) }, hash));
		const storage = new MemStoragePort();
		const db = await storage.open<DiskSchema>("fresh", DB_SCHEMA_VERSION, STORE_SPECS);
		const n = await importSyncedMirror({ db, side, hash, identity, pathKey: (p) => p as PathKey, nowMs: 1 });
		assert.equal(n, 2);
		const rows = await db.tx([STORE.synced], "readonly", (tx) => tx.getAll(STORE.synced));
		db.close();
		return new Map(rows.map((r) => [r.docId, r.contentHash]));
	};
	const listed = await run([rec.docId]);
	assert.equal(listed.get(rec.docId), UNTRUSTED_CONTENT_HASH, "its sync point rests on a record recovery lost");
	assert.equal(listed.get(other.docId), other.contentHash);
	const none = await run(undefined);
	assert.equal(none.get(rec.docId), rec.contentHash);
});

test("recovery: a record's decided delete, kept rename and held edit (hash, text, base) come back with it", async () => {
	// Sim suite-1 wipe/revoke/roll seeds 40 and 112: a store lost after the user renamed (or edited, then renamed) a
	// file this device could not publish came back as a plain sync point; the moved file read as a new doc and the
	// old one was put back at its path.
	const marked: SyncedRecord = {
		...rec, fileGone: true, renamedTo: { to: "b/renamed.md" as VaultPath, atMs: 1_759_600_000_123 }, held: { hash: "cd".repeat(32) as ContentHash, bytes: 24 },
	};
	const texts = { docId: rec.docId, hash: "cd".repeat(32) as ContentHash, text: "one\nthree\n", base: "one\ntwo\nthree\n" };
	const identity = { vaultId: "v", vaultEpoch: "e", deviceId: "dev" } as MirrorIdentity;
	const hash = createWebHash();
	const side = new MemSideFiles();
	const w = new SyncedMirrorWriter({ side, hash, clock: createWebClock(), identity: () => identity, entries: () => [marked], heldTexts: async () => new Map([[rec.docId, texts]]), nsCoversSeq: () => 2 as Seq, debounceMs: 60_000 });
	w.markDirty();
	await w.flush();
	const storage = new MemStoragePort();
	const db = await storage.open<DiskSchema>("fresh", DB_SCHEMA_VERSION, STORE_SPECS);
	assert.equal(await importSyncedMirror({ db, side, hash, identity, pathKey: (p) => p as PathKey, nowMs: 1 }), 1);
	const [row] = await db.tx([STORE.synced], "readonly", (tx) => tx.getAll(STORE.synced));
	const held = await db.tx([STORE.heldText], "readonly", (tx) => tx.getAll(STORE.heldText));
	db.close();
	assert.deepEqual(held, [texts], "the held texts are back in the heldText store");
	assert.deepEqual({ gone: row?.fileGone, to: row?.renamedTo, held: row?.held }, { gone: true, to: marked.renamedTo, held: marked.held });
	assert.equal(row?.contentHash, rec.contentHash);
	assert.equal(row?.bodyVersion, null, "still no CRDT sync point (§i.5 step 3)");
});

test("recovery: the previous epoch's unpublished renames ride the mirror and come back into meta (MetaPathMove), entries or not", async () => {
	// Sim suite-1 wipe/revoke/roll seed 40 (8 steps): the user's rename the old epoch's record kept, carried over the
	// migration into the new DB, was lost with that DB's store; the doc came back at the old path beside the file.
	const identity = { vaultId: "v", vaultEpoch: "e2", deviceId: "dev" } as MirrorIdentity;
	const hash = createWebHash();
	const moves = [{ from: "c/c3.canvas" as VaultPath, to: "boards/c5.canvas" as VaultPath, atMs: 1_759_600_000_123 }];
	for (const entries of [[], [rec]]) {
		const side = new MemSideFiles();
		const w = new SyncedMirrorWriter({ side, hash, clock: createWebClock(), identity: () => identity, entries: () => entries, nsCoversSeq: () => 0 as Seq, moves: () => moves, debounceMs: 60_000 });
		w.markDirty();
		await w.flush();
		const storage = new MemStoragePort();
		const db = await storage.open<DiskSchema>("fresh", DB_SCHEMA_VERSION, STORE_SPECS);
		assert.equal(await importSyncedMirror({ db, side, hash, identity, pathKey: (p) => p as PathKey, nowMs: 1 }), entries.length);
		const meta = await db.tx([STORE.meta], "readonly", (tx) => tx.getAll(STORE.meta));
		db.close();
		assert.deepEqual(meta.filter((m) => m.key.startsWith("pathMove:")), [{ key: "pathMove:c/c3.canvas", ...moves[0] }], `${entries.length} entries`);
	}
});
