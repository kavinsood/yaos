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
import { MemSideFiles } from "../runtime/testHarness";
import type { SyncedRecord } from "../store/schema";
import { SyncedMirrorWriter } from "./syncedMirror";

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
