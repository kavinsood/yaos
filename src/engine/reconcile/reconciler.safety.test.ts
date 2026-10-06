import { test } from "node:test";
import assert from "node:assert/strict";
import type { VaultPath } from "../../core/types";
import { World } from "./testkit/world";

const P = (s: string): VaultPath => s as VaultPath;

async function withDoc(path: string, text: string): Promise<{ w: World; id: ReturnType<World["log"]["remoteCreate"]> }> {
	const w = new World();
	await w.boot();
	const id = w.log.remoteCreate(P(path), text);
	await w.sync();
	return { w, id };
}

test("echo suppression: own writes produce no dirty marks; a user write does", async () => {
	const { w, id } = await withDoc("a.md", "one\n");
	w.log.remoteEdit(id, (t) => t.insert(t.length, "two\n"));
	w.r.onVaultEvents([]); // nothing pending
	await w.r.runUntilQuiet();
	assert.ok(w.pending.length > 0, "the write produced vault events");
	w.flushEvents();
	assert.equal(w.r.scan.dirty.size, 0, "own write recognized as an echo");
	w.vault.userWrite("a.md", "one\ntwo\nthree\n");
	w.flushEvents();
	assert.equal(w.r.scan.dirty.size, 1);
	await w.sync();
	assert.equal(w.log.text(id), "one\ntwo\nthree\n");
});

test("echo of a rename and of a trash are suppressed too", async () => {
	const { w, id } = await withDoc("x/a.md", "a\n");
	const id2 = w.log.remoteCreate(P("b.md"), "b\n");
	await w.sync();
	w.log.remoteRename(id, P("y/a.md"));
	w.log.remoteDelete(id2);
	await w.r.runUntilQuiet();
	w.flushEvents();
	assert.equal(w.r.scan.dirty.size, 0);
	assert.equal(w.r.ctx.renames.length, 0, "own rename is not an observed user rename");
	assert.equal(w.log.submitted.length, 0, "no ns ops echoed back to the log");
});

test("remote move: plain vault rename, never fileManager.renameFile; emptied folder removed", async () => {
	const { w, id } = await withDoc("old/dir/n.md", "body\n");
	w.log.remoteRename(id, P("new/n.md"));
	await w.sync();
	assert.equal(w.vault.text("new/n.md"), "body\n");
	assert.equal(w.vault.has("old/dir/n.md"), false);
	assert.equal(w.vault.fileManagerRenames, 0);
	const renames = w.gateway.executed.filter((o) => o.t === "rename");
	assert.equal(renames.length, 1);
	assert.equal(renames[0]!.t === "rename" && renames[0]!.purpose, "remote-move");
	assert.equal(w.vault.hasFolder("old/dir"), false);
	assert.equal(w.vault.hasFolder("old"), false);
	assert.equal(w.synced(id)?.path, "new/n.md");
	assert.equal(w.log.submitted.length, 0);
});

test("remote move + remote edit in one sync: renamed then merged", async () => {
	const { w, id } = await withDoc("a.md", "a\n");
	w.log.remoteRename(id, P("b.md"));
	w.log.remoteEdit(id, (t) => t.insert(t.length, "b\n"));
	await w.sync();
	assert.equal(w.vault.text("b.md"), "a\nb\n");
	assert.equal(w.vault.has("a.md"), false);
});

test("remote delete goes to the trash only; S dropped", async () => {
	const { w, id } = await withDoc("d/gone.md", "bye\n");
	w.log.remoteDelete(id);
	await w.sync();
	assert.equal(w.vault.has("d/gone.md"), false);
	assert.equal(w.vault.trashed.length, 1);
	assert.equal(w.vault.trashed[0]!.path, "d/gone.md");
	assert.equal(new TextDecoder().decode(w.vault.trashed[0]!.bytes), "bye\n");
	assert.equal(w.synced(id), undefined);
	for (const op of w.gateway.executed) assert.ok(["write", "rename", "trash", "removeEmptyFolder"].includes(op.t));
	assert.ok(w.gateway.executed.filter((o) => o.t === "trash").every((o) => o.t === "trash" && o.purpose === "remote-delete"));
});

test("remote delete of a locally edited file is not trashed (edit wins: restore)", async () => {
	const { w, id } = await withDoc("keep.md", "v1\n");
	w.log.remoteDelete(id);
	w.vault.userWrite("keep.md", "v1\nmine\n");
	await w.sync();
	assert.equal(w.vault.text("keep.md"), "v1\nmine\n");
	assert.equal(w.vault.trashed.length, 0);
	const live = w.log.liveByPath(P("keep.md"));
	assert.ok(live, "the file is live in the namespace again");
	assert.equal(w.log.text(live!), "v1\nmine\n");
});

test("local delete -> nsDelete; local rename -> nsRename (no disk ops)", async () => {
	const { w, id } = await withDoc("r/a.md", "a\n");
	const id2 = w.log.remoteCreate(P("b.md"), "b\n");
	await w.sync();
	const ops = w.gateway.executed.length;
	w.vault.userRename("r/a.md", "s/a2.md");
	w.vault.userDelete("b.md");
	await w.sync();
	const sub = w.log.submitted;
	assert.ok(sub.some((o) => o.t === "rename" && o.docId === id && o.path === "s/a2.md"), JSON.stringify(sub));
	assert.ok(sub.some((o) => o.t === "delete" && o.docId === id2));
	assert.equal(w.log.entry(id)?.path, "s/a2.md");
	assert.equal(w.log.entry(id2)?.state, "deleted");
	assert.equal(w.synced(id)?.path, "s/a2.md");
	assert.equal(w.synced(id2), undefined);
	assert.equal(w.gateway.executed.slice(ops).filter((o) => o.t !== "removeEmptyFolder").length, 0);
	assert.equal(w.vault.trashed.length, 0);
});

/** Sim seed 21 (3 devices): renames while ns was not ready were undone or forgotten. */
test("local rename while ns is not ready: no re-materialize, the observed rename is kept until ns is ready", async () => {
	const { w, id } = await withDoc("a.md", "a\n");
	w.log.nsReady = false;
	w.log.remoteEdit(id, (t) => t.insert(0, "R")); // edit-beats-delete would bring a.md back
	w.vault.userRename("a.md", "b.md");
	await w.sync();
	assert.deepEqual(w.vault.paths(), ["b.md"]);
	w.vault.userWrite("a.md", "new\n"); // a new note at the old path
	await w.sync();
	w.log.nsReady = true;
	await w.sync();
	assert.equal(w.log.entry(id)?.path, "b.md", "the doc follows the observed rename");
	assert.equal(w.vault.text("b.md"), "Ra\n");
	const fresh = w.log.liveByPath(P("a.md"));
	assert.ok(fresh && fresh !== id);
	assert.equal(w.log.text(fresh), "new\n");
	assert.deepEqual(w.conflictCopies(), []);
});

/** Sim seed 723 (2 devices, no faults): a rename observed mid-pass was cleared with the pass's own (none). */
test("a rename observed while a pass runs is kept for the next pass: nsRename, not a copy", async () => {
	const { w, id } = await withDoc("a.md", "a\n");
	const id2 = w.log.remoteCreate(P("b.md"), "b\n");
	await w.sync();
	w.log.remoteEdit(id2, (t) => t.insert(0, "R"));
	let fired = false;
	w.gateway.beforeOp = (op) => {
		if (!fired && op.t === "write" && op.path === "b.md") {
			fired = true;
			w.vault.userRename("a.md", "c.md"); // with an edit: only the observed event pairs them
			w.vault.userWrite("c.md", "a\nmore\n");
			w.flushEvents(); // the host posts the events while the write is in flight
		}
	};
	await w.sync();
	assert.ok(fired);
	await w.sync();
	assert.equal(w.log.entry(id)?.path, "c.md", "the doc follows the rename");
	assert.equal(w.log.liveByPath(P("a.md")), undefined, "no doc left at the old path");
	assert.deepEqual(w.vault.paths(), ["b.md", "c.md"], "the old path is not re-materialized");
	assert.equal(w.log.liveByPath(P("c.md")), id, "no fresh doc for the target");
	assert.equal(w.log.text(id), "a\nmore\n");
});

test("fingerprint precondition: user types during the merge write -> nothing lost, converges", async () => {
	const { w, id } = await withDoc("m.md", "a\nb\nc\n");
	w.log.remoteEdit(id, (t) => t.insert(0, "R\n"));
	w.vault.userWrite("m.md", "a\nb\nc\nL1\n");
	let fired = false;
	w.gateway.beforeOp = (op) => {
		if (!fired && op.t === "write" && op.path === "m.md") {
			fired = true;
			w.vault.userWrite("m.md", "a\nb\nc\nL1\nL2\n");
		}
	};
	await w.sync();
	assert.ok(fired);
	await w.sync();
	assert.equal(w.vault.text("m.md"), "R\na\nb\nc\nL1\nL2\n");
	assert.equal(w.log.text(id), "R\na\nb\nc\nL1\nL2\n");
	assert.deepEqual(w.conflictCopies(), [], "continued typing is not a conflict");
});

test("CAS miss once: a remote edit lands in the async gap -> retried, merged", async () => {
	const { w, id } = await withDoc("c.md", "1\n2\n3\n");
	w.vault.userWrite("c.md", "1\n2\n3\n4\n");
	let n = 0;
	w.clock.onYield = () => {
		if (n++ === 0) w.log.remoteEdit(id, (t) => t.insert(0, "0\n"));
	};
	await w.sync();
	assert.ok(n >= 2, "the job yielded again after the miss");
	assert.equal(w.log.text(id), "0\n1\n2\n3\n4\n");
	assert.equal(w.vault.text("c.md"), "0\n1\n2\n3\n4\n");
});

test("CAS miss persistently: job fails after MAX attempts, CRDT untouched; converges once the remote settles", async () => {
	const { w, id } = await withDoc("p.md", "x\n");
	w.vault.userWrite("p.md", "x\nlocal\n");
	let k = 0;
	w.clock.onYield = () => {
		w.log.remoteEdit(id, (t) => t.insert(0, `r${k++}\n`));
	};
	const before = w.log.frames.length;
	await w.sync(2);
	assert.equal(w.log.frames.length, before, "no merge frame was committed");
	assert.ok(!w.log.text(id).includes("local"));
	w.clock.onYield = null;
	await w.sync();
	assert.ok(w.log.text(id).endsWith("x\nlocal\n"));
	assert.equal(w.vault.text("p.md"), w.log.text(id));
});

test("transient read error: the new file is reported unread (not quiet); the retry pass imports it", async () => {
	const w = new World();
	await w.boot();
	w.gateway.failReads.set("notes/n.md", 1);
	w.vault.userWrite("notes/n.md", "new\n");
	const first = await w.sync();
	assert.equal(first.quiet, false, "an unread file keeps the reconciler from being quiet");
	assert.equal(w.log.liveByPath("notes/n.md" as VaultPath), undefined);
	const retry = await w.r.pass({ t: "full" });
	assert.equal(retry.unread, 0);
	await w.sync();
	const id = w.log.liveByPath("notes/n.md" as VaultPath);
	assert.ok(id, "imported after the read succeeded");
	assert.equal(w.log.text(id), "new\n");
});

test("transient read error outside the pass scope still reports unread", async () => {
	const w = new World();
	await w.boot();
	w.gateway.failReads.set("notes/x.md", 1);
	w.vault.userWrite("notes/x.md", "x\n");
	w.flushEvents();
	const r = await w.r.pass({ t: "docs", docIds: [], pathKeys: [] });
	assert.equal(r.unread, 1);
});
