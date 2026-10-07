import { test } from "node:test";
import assert from "node:assert/strict";
import type { VaultPath } from "../../core/types";
import { sha256Hex } from "../../core/hash/sha256";
import { World } from "./testkit/world";

const P = (s: string): VaultPath => s as VaultPath;
const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

test("planner brake: mass remote delete is held until approved", async () => {
	const w = new World({ brake: { minCount: 2, ratio: 0 } });
	await w.boot();
	const ids = ["a", "b", "c", "d"].map((n) => w.log.remoteCreate(P(`${n}.md`), `${n}\n`));
	await w.sync();
	for (const id of ids.slice(0, 3)) w.log.remoteDelete(id);
	await w.sync();
	assert.equal(w.vault.paths().length, 4, "nothing trashed while held");
	const report = w.brakes.at(-1)!;
	assert.equal(report.reason, "mass-delete-remote");
	assert.equal(report.heldCount, 3);
	await w.sync();
	assert.equal(w.vault.trashed.length, 0, "still held on the next pass");
	w.r.approveBrake(report.id);
	await w.sync();
	assert.deepEqual(Object.keys(w.vault.snapshot()), ["d.md"]);
	assert.equal(w.vault.trashed.length, 3);
});

test("planner brake: mass local delete is held until approved", async () => {
	const w = new World({ brake: { minCount: 2, ratio: 0 } });
	await w.boot();
	const ids = ["a", "b", "c"].map((n) => w.log.remoteCreate(P(`${n}.md`), `${n}\n`));
	await w.sync();
	for (const n of ["a", "b", "c"]) w.vault.userDelete(`${n}.md`);
	await w.sync();
	assert.equal(w.log.submitted.filter((o) => o.t === "delete").length, 0);
	const report = w.brakes.at(-1)!;
	assert.equal(report.reason, "mass-delete-local");
	w.r.approveBrake(report.id);
	await w.sync();
	assert.equal(w.log.submitted.filter((o) => o.t === "delete").length, 3);
	for (const id of ids) assert.equal(w.log.entry(id)?.state, "deleted");
});

test("job-level brake: shrinking md overwrite is held until approved", async () => {
	const w = new World({ brake: { minCount: 0, ratio: 0, overwriteMinBytes: 10, overwriteShrinkRatio: 0.5 } });
	await w.boot();
	const long = "a fairly long line of text\n".repeat(4);
	const id = w.log.remoteCreate(P("big.md"), long);
	await w.sync();
	assert.equal(w.vault.text("big.md"), long);
	w.log.remoteEdit(id, (t) => {
		t.delete(0, t.length);
		t.insert(0, "x\n");
	});
	await w.sync();
	assert.equal(w.vault.text("big.md"), long, "held");
	const report = w.brakes.at(-1)!;
	assert.equal(report.reason, "mass-overwrite");
	assert.deepEqual(report.samplePaths, ["big.md"]);
	w.r.approveBrake(report.id);
	await w.sync();
	assert.equal(w.vault.text("big.md"), "x\n");
	assert.equal(w.log.text(id), "x\n");
});

test("blob: local edit -> upload then setBlob; remote edit -> download", async () => {
	const w = new World();
	w.vault.userWrite("f.bin", bytes(1, 1, 1));
	await w.boot();
	await w.sync();
	const id = w.log.liveByPath(P("f.bin"))!;
	w.vault.userWrite("f.bin", bytes(2, 2, 2, 2));
	await w.sync();
	assert.equal(w.log.entry(id)!.blob!.hash, sha256Hex(bytes(2, 2, 2, 2)));
	assert.ok(w.blobs!.server.has(sha256Hex(bytes(2, 2, 2, 2))));
	assert.equal(w.synced(id)!.blobRev, w.log.entry(id)!.blob!.rev);
	const next = bytes(3, 3);
	w.blobs!.put(next);
	w.log.remoteSetBlob(id, next);
	await w.sync();
	assert.deepEqual(w.vault.bytesOf("f.bin"), next);
	assert.equal(w.synced(id)!.blobRev, w.log.entry(id)!.blob!.rev);
	assert.equal(w.r.scan.dirty.size, 0);
});

test("blob: upload failure defers the nsCreate (no doc without bytes on the server)", async () => {
	const w = new World();
	w.vault.userWrite("g.bin", bytes(5, 6));
	await w.boot();
	w.blobs!.uploadOk = false;
	await w.sync();
	assert.equal(w.log.submitted.length, 0);
	assert.equal(w.log.liveByPath(P("g.bin")), undefined);
	assert.equal(w.syncedByPath("g.bin"), undefined);
	w.blobs!.uploadOk = true;
	await w.sync();
	const id = w.log.liveByPath(P("g.bin"));
	assert.ok(id);
	assert.equal(w.syncedByPath("g.bin")?.docId, id);
});

test("blob: an upload the store refuses by size (413) holds the doc: no nsCreate, not a failure, never re-sent", async () => {
	const w = new World();
	w.vault.userWrite("big.bin", bytes(1, 2, 3));
	await w.boot();
	w.blobs!.refuseUploads = true;
	const started = await w.r.pass();
	assert.equal(started.transferring >= 1 && started.failed === 0, true, "the upload runs in the background");
	await w.blobs!.settle();
	const first = await w.r.pass();
	assert.equal(first.held, 1);
	assert.equal(first.failed, 0, "held, not failed: the scheduler arms no retry (passScheduler.ts)");
	assert.equal(w.blobs!.uploads.length, 1);
	const again = await w.r.pass();
	assert.equal(again.held, 1);
	assert.equal(w.blobs!.uploads.length, 1, "refused bytes are not read or sent again");
	assert.equal(w.log.submitted.length, 0);
	assert.equal(w.syncedByPath("big.bin"), undefined);
	// Changed bytes are a new hash: tried, and synced once the store takes them.
	w.blobs!.refuseUploads = false;
	w.vault.userWrite("big.bin", bytes(4, 5, 6));
	await w.sync();
	assert.ok(w.log.liveByPath(P("big.bin")));
	assert.equal(w.blobs!.uploads.length, 2);
});

test("blob: download unavailable -> retried on a later sync", async () => {
	const w = new World();
	await w.boot();
	const b = bytes(7, 7, 7);
	const id = w.log.remoteCreate(P("h.bin"), b);
	await w.sync();
	assert.equal(w.vault.has("h.bin"), false);
	assert.equal(w.synced(id), undefined);
	w.blobs!.put(b);
	await w.sync();
	assert.deepEqual(w.vault.bytesOf("h.bin"), b);
});

test("blob keep-both: concurrent edits keep the remote bytes at the path and the local bytes as a new doc", async () => {
	const w = new World();
	w.vault.userWrite("k.png", bytes(1));
	await w.boot();
	await w.sync();
	const id = w.log.liveByPath(P("k.png"))!;
	const mine = bytes(2, 2);
	const theirs = bytes(3, 3, 3);
	w.vault.userWrite("k.png", mine);
	w.blobs!.put(theirs);
	w.log.remoteSetBlob(id, theirs);
	await w.sync();
	assert.deepEqual(w.vault.bytesOf("k.png"), theirs);
	const copies = w.conflictCopies();
	assert.equal(copies.length, 1);
	assert.match(copies[0]!, /^k \(conflict laptop .*\)\.png$/);
	assert.deepEqual(w.vault.bytesOf(copies[0]!), mine);
	const copyId = w.log.liveByPath(P(copies[0]!));
	assert.ok(copyId && copyId !== id);
	assert.equal(w.log.entry(copyId!)!.blob!.hash, sha256Hex(mine));
	assert.ok(w.blobs!.server.has(sha256Hex(mine)));
	assert.equal(w.intents(), 0);
	await w.sync();
	assert.equal(w.conflictCopies().length, 1);
	assert.deepEqual(w.notices.filter((n) => n.code === "conflict-copy").map((n) => n.message), [
		`YAOS could not merge two versions of “k.png”; the other version is saved as “${copies[0]!}”.`,
	]);
});

test("excluded and config paths are never synced", async () => {
	const w = new World({ settings: { excludePatterns: ["private/**"] } });
	w.vault.userWrite("private/s.md", "secret\n");
	w.vault.userWrite(".obsidian/app.json", "{}");
	w.vault.userWrite("ok.md", "ok\n");
	await w.boot();
	await w.sync();
	assert.equal(w.log.submitted.length, 1);
	assert.ok(w.log.liveByPath(P("ok.md")));
	assert.equal(w.log.liveByPath(P("private/s.md")), undefined);
});

test("blob S1: an own setBlob folding in one batch with a later remote setBlob keeps its own rev, so the remote bytes still land", async () => {
	const w = new World();
	w.vault.userWrite("m.png", bytes(1));
	await w.boot();
	await w.sync();
	const id = w.log.liveByPath(P("m.png"))!;
	const mine = bytes(2, 2);
	const theirs = bytes(3, 3, 3);
	w.vault.userWrite("m.png", mine);
	const hook = w.log.onOwnFold!;
	w.log.onOwnFold = async (events) => {
		// Catch-up folds a remote setBlob on top in the same batch: the committed entry the bridge reports is theirs.
		w.blobs!.put(theirs);
		w.log.remoteSetBlob(id, theirs);
		await hook(events.map((e) => ({ ...e, entry: w.log.entry(id) })));
	};
	await w.sync();
	w.log.onOwnFold = hook;
	await w.sync();
	assert.deepEqual(w.vault.bytesOf("m.png"), theirs);
	assert.equal(w.synced(id)!.contentHash, sha256Hex(theirs));
	assert.equal(w.synced(id)!.blobRev, w.log.entry(id)!.blob!.rev);
});
