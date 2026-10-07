import { test } from "node:test";
import assert from "node:assert/strict";
import type { NsOp, VaultPath } from "../../core/types";
import { World } from "./testkit/world";

const P = (s: string): VaultPath => s as VaultPath;
const bytesOf = (n: number, seed: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

async function booted(): Promise<World> {
	const w = new World();
	await w.boot();
	return w;
}

/** Every blob ns op (create of a blob doc, setBlob) the log receives must name a hash the store already holds. */
function guardNs(w: World): NsOp[] {
	const blobOps: NsOp[] = [];
	const submit = w.log.submitNs.bind(w.log);
	w.log.submitNs = async (ops, opts) => {
		for (const op of ops) {
			const hash = op.t === "create" && op.kind === "blob" ? op.contentHash : op.t === "setBlob" ? op.hash : null;
			if (hash === null) continue;
			assert.ok(w.blobs!.server.has(hash), `ns ${op.t} for ${hash.slice(0, 8)} submitted before the store held it`);
			blobOps.push(op);
		}
		return submit(ops, opts);
	};
	return blobOps;
}

/** The pass a settled transfer's wake requests (vaultRuntime: sched.request docs). */
async function wakePass(w: World): Promise<void> {
	const who = w.blobs!.woken.splice(0);
	w.flushEvents();
	await w.r.pass({ t: "docs", docIds: who.map((c) => c.docId), pathKeys: who.map((c) => w.r.ctx.pk(c.path)) });
	w.flushEvents();
}

test("an upload in flight holds up no other doc: notes are created, edited and materialized meanwhile; the attachment's ns create waits for the store", async () => {
	const w = new World();
	const pic = bytesOf(4096, 1);
	w.vault.userWrite("img/big.png", pic);
	w.vault.userWrite("notes/a.md", "# A\n");
	await w.boot();
	const blobOps = guardNs(w);
	const blobs = w.blobs!;

	const first = await w.r.runUntilQuiet();
	assert.equal(first.quiet, true, "a transfer in flight is not actionable work");
	assert.equal(blobs.inFlight, 1, "the upload runs in the background");
	const a = w.log.liveByPath(P("notes/a.md"));
	assert.ok(a, "the note was created by the pass that started the upload");
	assert.equal(w.log.text(a), "# A\n");
	assert.equal(w.log.liveByPath(P("img/big.png")), undefined, "no ns entry for a blob readers cannot fetch");
	assert.equal(w.syncedByPath("img/big.png"), undefined, "S untouched: L != S until the store confirms");
	assert.ok(first.last.transferring >= 2, "the upload and its deferred ns create wait on the transfer");

	// Still in flight: an edit to the note and a remote note both land.
	w.vault.userWrite("notes/a.md", "# A\nedited\n");
	const b = w.log.remoteCreate(P("notes/b.md"), "from b\n");
	w.flushEvents();
	await w.r.runUntilQuiet();
	w.flushEvents();
	assert.equal(w.log.text(a), "# A\nedited\n");
	assert.equal(w.vault.text("notes/b.md"), "from b\n");
	assert.equal(w.synced(b)?.path, "notes/b.md");
	assert.equal(blobs.inFlight, 1, "joined, not restarted");
	assert.equal(blobs.uploads.length, 0);

	// The store confirms: the wake's pass submits the deferred create, after the bytes are stored.
	assert.equal(await blobs.settle(), 1);
	assert.ok(blobs.server.has(blobs.uploads[0]!.hash));
	await wakePass(w);
	const p = w.log.liveByPath(P("img/big.png"));
	assert.ok(p, "created once stored");
	assert.equal(w.syncedByPath("img/big.png")?.docId, p);
	assert.equal(blobOps.length, 1);
	assert.equal(blobs.uploads.length, 1);
});

test("a download in flight holds up no other doc: the note beside it is written first", async () => {
	const w = await booted();
	const blobs = w.blobs!;
	const pic = bytesOf(4096, 2);
	blobs.put(pic);
	w.log.remoteCreate(P("att/pic.bin"), pic);
	w.log.remoteCreate(P("att/note.md"), "beside\n");
	await w.r.runUntilQuiet();
	assert.equal(blobs.inFlight, 1);
	assert.equal(w.vault.text("att/note.md"), "beside\n");
	assert.equal(w.vault.has("att/pic.bin"), false);
	await blobs.settle();
	await wakePass(w);
	assert.deepEqual(w.vault.bytesOf("att/pic.bin"), pic);
});

test("the deferred ns op waits for the store: a failed upload submits nothing; the retry after its backoff does; a setBlob waits the same way", async () => {
	const w = new World();
	const v1 = bytesOf(2048, 3);
	w.vault.userWrite("img/p.png", v1);
	await w.boot();
	const blobOps = guardNs(w);
	const blobs = w.blobs!;
	blobs.uploadOk = false;
	await w.r.runUntilQuiet();
	await blobs.settle();
	const failed = await w.r.runUntilQuiet();
	assert.equal(failed.last.failed, 1, "backing off: the job fails now and the blob retry is armed");
	assert.equal(blobs.inFlight, 0, "nothing restarted while backing off");
	assert.equal(w.log.liveByPath(P("img/p.png")), undefined);
	assert.equal(w.log.submitted.length, 0);

	blobs.uploadOk = true;
	await w.sync(); // time passes: the backoff is over
	const p = w.log.liveByPath(P("img/p.png"));
	assert.ok(p);
	assert.equal(w.log.entry(p)!.blob!.hash, blobs.uploads.at(-1)!.hash);

	// New bytes: nsSetBlob is deferred behind its upload; the log keeps the old hash until the store holds the new one.
	const v2 = bytesOf(2048, 4);
	w.vault.userWrite("img/p.png", v2);
	w.flushEvents();
	const oldHash = w.log.entry(p)!.blob!.hash;
	await w.r.runUntilQuiet();
	assert.equal(blobs.inFlight, 1);
	assert.equal(w.log.entry(p)!.blob!.hash, oldHash);
	await blobs.settle();
	await wakePass(w);
	assert.notEqual(w.log.entry(p)!.blob!.hash, oldHash);
	assert.equal(w.syncedByPath("img/p.png")?.contentHash, w.log.entry(p)!.blob!.hash);
	assert.deepEqual(blobOps.map((o) => o.t), ["create", "setBlob"]);
});

test("a crash mid-upload re-plans: no ns entry, no synced record; the next start uploads again and creates once", async () => {
	const w = new World();
	const pic = bytesOf(3000, 5);
	w.vault.userWrite("img/c.png", pic);
	w.vault.userWrite("n.md", "note\n");
	await w.boot();
	guardNs(w);
	await w.r.runUntilQuiet();
	assert.equal(w.blobs!.inFlight, 1);
	await w.crashAndReboot();
	assert.equal(w.blobs!.inFlight, 0, "the transfer died with the process");
	assert.equal(w.syncedByPath("img/c.png"), undefined, "L != S: nothing recorded the upload");
	assert.equal(w.log.liveByPath(P("img/c.png")), undefined);
	await w.sync();
	const p = w.log.liveByPath(P("img/c.png"));
	assert.ok(p, "re-planned and created");
	assert.equal(w.syncedByPath("img/c.png")?.docId, p);
	assert.equal(w.log.submitted.filter((o) => o.t === "create" && o.path === "img/c.png").length, 1, "one create");
	assert.equal(w.blobs!.uploads.length, 1, "the crashed attempt never reached the store; one PUT");
});

test("a download for a hash the doc no longer wants is never written: the next pass takes the current blob and drops the stale bytes", async () => {
	const w = await booted();
	const blobs = w.blobs!;
	const v1 = bytesOf(2048, 6), v2 = bytesOf(2048, 7);
	const h1 = blobs.put(v1);
	blobs.put(v2);
	const d = w.log.remoteCreate(P("b.bin"), v1);
	await w.r.runUntilQuiet();
	assert.equal(blobs.inFlight, 1, "downloading v1");
	w.log.remoteSetBlob(d, v2); // the doc moves on while v1 downloads
	await blobs.settle();
	assert.deepEqual(blobs.readyHashes, [h1]);
	await wakePass(w);
	assert.deepEqual(blobs.dropped, [h1], "v1 bytes dropped by the pass that wanted v2");
	assert.deepEqual(blobs.readyHashes, []);
	assert.equal(w.vault.has("b.bin"), false);
	await blobs.settle();
	await wakePass(w);
	assert.deepEqual(w.vault.bytesOf("b.bin"), v2);
	const writes = w.gateway.executed.filter((op) => op.t === "write" && op.path === "b.bin");
	assert.equal(writes.length, 1, "one write, of v2");
	assert.equal(w.synced(d)?.blobRev, w.log.entry(d)!.blob!.rev);
});

test("downloaded bytes wait for a pass that began after they arrived: a pass already running when they land keeps them", async () => {
	const w = await booted();
	const blobs = w.blobs!;
	const v = bytesOf(1024, 8);
	blobs.put(v);
	const d = w.log.remoteCreate(P("k.bin"), v);
	await w.r.runUntilQuiet();
	// A pass begins, then the download lands, then that pass ends without taking them (it planned before they arrived).
	const token = blobs.beginPass();
	await blobs.settle();
	blobs.endPass(token, () => true);
	assert.equal(blobs.dropped.length, 0);
	await wakePass(w);
	assert.deepEqual(w.vault.bytesOf("k.bin"), v);
	assert.equal(w.synced(d)?.path, "k.bin");
});

test("a doc whose transfer is in flight is skipped, not failed: its later ops wait for the wake and count as transferring", async () => {
	const w = new World();
	w.vault.userWrite("img/r.png", bytesOf(1500, 9));
	await w.boot();
	const r1 = await w.r.pass();
	assert.equal(r1.failed, 0);
	assert.equal(r1.actionable, 0, "nothing actionable: the scheduler does not spin on a transfer");
	assert.ok(r1.transferring >= 2);
	await w.blobs!.settle();
	assert.deepEqual(w.blobs!.woken.map((c) => c.path), ["img/r.png"], "the transfer's end names its doc and path");
});
