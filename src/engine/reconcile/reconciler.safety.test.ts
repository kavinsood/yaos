import { test } from "node:test";
import assert from "node:assert/strict";
import type { VaultPath } from "../../core/types";
import { World } from "./testkit/world";
import { KeyMissingError } from "../keyring/writeGate";
import { HELD_TEXT_MAX_CHARS } from "../../core/limits";

const P = (s: string): VaultPath => s;

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
	assert.equal(w.log.text(live), "v1\nmine\n");
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

test("write gate shut (key-missing): a merge job fails before it edits the replica, so no unframed edit pins it resident; the pass after the gate opens merges", async () => {
	// Soak seed 2006566456: merges while revoked-epoch left their edits in the frame builders (commitEdits refused on
	// the gate), each replica unevictable (DESIGN §d.1), so C held 5 docs on a residency budget of 3.
	const CANVAS0 = '{"nodes":[],"edges":[]}';
	const CANVAS1 = '{"nodes":[{"id":"n1","type":"text","text":"t","x":0,"y":0,"width":10,"height":10}],"edges":[]}';
	for (const [path, before, after] of [["m.md", "one\n", "one\ntwo\n"], ["c.canvas", CANVAS0, CANVAS1]] as const) {
		const { w, id } = await withDoc(path, before);
		w.log.writeGate = "revoked-epoch";
		w.vault.userWrite(path, after);
		await assert.rejects(w.sync(3), KeyMissingError, `${path}: the pass fails on the gate`);
		assert.equal(w.log.view().docsWithPendingBody.has(id), false, `${path}: nothing applied to the replica`);
		assert.equal(w.vault.text(path), after, `${path}: the file keeps the edit`);
		w.log.writeGate = null;
		await w.sync();
		assert.equal(w.log.view().docsWithPendingBody.size, 0, `${path}: merged and framed once writes are back`);
		assert.equal(w.vault.text(path), after);
		if (path === "m.md") assert.equal(w.log.text(id), after);
	}
});

test("write gate shut (key-missing): a create commits no born-empty synced record before the ns op is refused; it is created once writes are back", async () => {
	// Sim suite-1 wipe/revoke/roll seed 40: the born-empty S of a create submitNs refused stayed, an S for a doc no ns
	// op names. The next pass read it as a pruned doc's record at the file's path, which hid the file from rename
	// inference: a frozen doc's renamed file became a delete and a create.
	const w = new World();
	await w.boot();
	w.log.writeGate = "revoked-epoch";
	w.vault.userWrite("notes/new.md", "new\n");
	await assert.rejects(w.sync(3), KeyMissingError, "the pass fails on the gate");
	assert.equal(w.log.submitted.length, 0, "no ns op went out");
	assert.equal([...w.r.ctx.store.synced.values()].some((s) => s.path === "notes/new.md"), false, "no synced record for the refused create");
	w.log.writeGate = null;
	await w.sync();
	const id = [...w.r.ctx.store.synced.values()].find((s) => s.path === "notes/new.md")?.docId;
	assert.ok(id, "created once writes are back");
	assert.equal(w.log.text(id), "new\n");
});

test("write gate shut (key-missing): a bound replica's unframed typing is never materialized under a version without it", async () => {
	// Sim suite-1 wipe/revoke/roll seed 6: a revoked device's typing (refused frames) was in the replica when the doc
	// materialized at the path its rename had just left. S recorded that text at the version without the typing; the
	// restart dropped the typing from the replica, and the file kept it as synced: it never reached another device
	// and the file never converged.
	const w = new World();
	await w.boot();
	const id = w.log.remoteCreate(P("a.md"), "one\n");
	await w.sync();
	w.log.setBound(id, true);
	w.log.writeGate = "revoked-epoch";
	w.log.editorType(id, (t) => t.insert(0, "typed "));
	await w.r.ctx.store.commit({ syncedDrop: [id] }); // as when the store came back without the record
	w.vault.userDelete("a.md");
	await w.sync(3).catch(() => undefined);
	assert.equal(w.vault.text("a.md"), null, "nothing written while the typing cannot be framed");
	assert.equal(w.synced(id), undefined);
	await w.crashAndReboot(); // the unframed typing is gone with the replica
	w.log.writeGate = null;
	await w.sync();
	assert.equal(w.vault.text("a.md"), "one\n", "the doc's text, which every device has");
	assert.equal(w.log.text(id), "one\n");
});

test("write gate shut (key-missing): an edit the gate refused is kept on the synced record (held) and pairs the file renamed while the app was down", async () => {
	// Sim suite-1 wipe/revoke/roll seed 112: key-missing after a revoke, B deleted a canvas record (the merge refused);
	// the canvas was then renamed while the app was down. By S's content the renamed file was new: a delete + a create,
	// and a peer's edit restored the doc at its old path with the record B had deleted.
	const w = new World();
	await w.boot();
	const id = w.log.remoteCreate(P("a.md"), "one\ntwo\nthree\nfour\n");
	await w.sync();
	const base = w.synced(id)!.contentHash;
	w.log.writeGate = "revoked-epoch";
	w.vault.userWrite("a.md", "one\nthree\nfour\n");
	await assert.rejects(w.sync(3), KeyMissingError);
	const held = w.synced(id)!;
	assert.equal(held.contentHash, base, "S stays the merge base");
	assert.ok(held.held !== undefined && held.held.hash !== base, "the refused content is kept");
	w.vault.userRename("a.md", "b.md"); // the event dies with the app
	await w.crashAndReboot();
	w.log.writeGate = null;
	await w.sync();
	assert.equal(w.vault.text("a.md"), null, "the doc is not back at the old path");
	assert.equal(w.vault.text("b.md"), "one\nthree\nfour\n");
	assert.equal(w.log.view().remote.get(id)?.path, "b.md");
	assert.equal(w.log.text(id), "one\nthree\nfour\n", "the delete merged against the synced base");
	assert.deepEqual(w.conflictCopies(), []);
	assert.equal([...w.log.view().remote.values()].filter((r) => r.state === "live").length, 1, "no new doc");
	assert.equal(w.synced(id)!.held, undefined, "dropped with the next sync point");
});

/** Gate shut, the user's edit refused, the store wiped (mirrors kept), the file renamed and edited again while down. */
async function heldThenRenamedAndEdited(path: string, text: string, edit: string, moved: string, again: string) {
	const w = new World();
	await w.boot();
	const id = w.log.remoteCreate(P(path), text);
	await w.sync();
	const base = w.synced(id)!.contentHash;
	w.log.writeGate = "revoked-epoch";
	w.vault.userWrite(path, edit);
	await assert.rejects(w.sync(3), KeyMissingError);
	const kept = w.synced(id)!.held;
	assert.equal(w.synced(id)!.contentHash, base, "S stays the merge base");
	await w.wipeAndRebootFromMirror();
	assert.deepEqual(w.synced(id)!.held, kept, "the held edit, text and base, came back from the synced mirror");
	assert.equal(w.synced(id)!.hasBase, false, "no stored base after the wipe: the held edit carries its own");
	await assert.rejects(w.sync(3), KeyMissingError); // still key-missing: nothing is decided about the gone file
	w.vault.userRename(path, moved);
	w.vault.userWrite(moved, again);
	await w.crashAndReboot(); // the events die with the app
	return { w, id, kept };
}

test("held edit (markdown): the refused edit's text and base are kept, survive a wipe, and publish once the gate opens", async () => {
	// Sim suite-1 wipe/revoke/roll seed 112, as a note. The file renamed and edited again pairs with nothing (neither
	// S's hash nor the held one): a delete + a create. A peer's edit makes it edit beats delete, which put the doc back
	// at its old path with the line the user had removed.
	const { w, id, kept } = await heldThenRenamedAndEdited("a.md", "one\ntwo\nthree\nfour\n", "one\nthree\nfour\n", "b.md", "one\nthree\nfour\nfive\n");
	assert.equal(kept?.text, "one\nthree\nfour\n");
	assert.equal(kept?.base, "one\ntwo\nthree\nfour\n");
	w.log.writeGate = null;
	w.log.remoteEdit(id, (t) => t.insert(t.length, "peer\n"));
	await w.sync();
	assert.equal(w.log.text(id), "one\nthree\nfour\npeer\n", "the held edit is in the doc: the removed line stays removed");
	assert.equal(w.vault.text("a.md"), "one\nthree\nfour\npeer\n", "edit beats delete, with the held edit");
	assert.equal(w.vault.text("b.md"), "one\nthree\nfour\nfive\n");
	assert.deepEqual(w.conflictCopies(), []);
	assert.equal(w.synced(id)!.held, undefined, "cleared by the publish");
});

test("held edit (markdown): published with no peer edit, the gone file is the user's delete; nothing is put back", async () => {
	const { w, id } = await heldThenRenamedAndEdited("a.md", "one\ntwo\nthree\n", "one\nthree\n", "b.md", "one\nthree\nmore\n");
	w.log.writeGate = null;
	await w.sync();
	assert.equal(w.log.text(id), "one\nthree\n", "the held edit was published before the delete");
	assert.equal(w.log.view().remote.get(id)?.state, "deleted");
	assert.equal(w.vault.text("a.md"), null);
	assert.equal(w.vault.text("b.md"), "one\nthree\nmore\n");
	assert.equal(w.synced(id), undefined);
});

test("held edit (canvas): a record deleted while key-missing stays deleted after a wipe, an unobserved rename + edit and a peer's edit", async () => {
	// Sim suite-1 wipe/revoke/roll seed 112 (src/sim/regressions/gated-edit-renamed-and-edited-unobserved.json).
	const node = (id: string, text: string): Record<string, unknown> => ({ id, type: "text", text, x: 0, y: 0, width: 100, height: 50 });
	const board = (...ids: string[]): string => JSON.stringify({ nodes: ids.map((i) => node(i, i.toUpperCase())), edges: [] }, null, "\t");
	const { w, id, kept } = await heldThenRenamedAndEdited("c0.canvas", board("a", "b", "c"), board("a", "c"), "c5.canvas", board("a", "c", "d"));
	assert.ok(kept?.text !== undefined && kept.base !== undefined, "canvas: the file text and the base merge text are kept");
	w.log.writeGate = null;
	w.log.remoteEditCanvas(id, (d) => {
		const m = d.getMap<unknown>("nodes").get("a") as { get(k: string): { insert(i: number, s: string): void; length: number } };
		const t = m.get("text");
		t.insert(t.length, "!");
	});
	await w.sync();
	const ids = (path: string): string[] => (JSON.parse(w.vault.text(path) ?? "{\"nodes\":[]}") as { nodes: { id: string }[] }).nodes.map((n) => n.id).sort();
	assert.deepEqual(ids("c0.canvas"), ["a", "c"], "the record B deleted is not back in the doc");
	assert.match(w.vault.text("c0.canvas")!, /A!/, "with the peer's edit");
	assert.deepEqual(ids("c5.canvas"), ["a", "c", "d"]);
	assert.deepEqual(w.conflictCopies(), []);
});

test("held edit: the texts are kept within HELD_TEXT_MAX_CHARS over all records; past it the hash alone, the file untouched", async () => {
	const w = new World();
	await w.boot();
	// a's text + base fill the bound but for a char: with b's small held edit kept first, a's no longer fits.
	const big = "x".repeat(Math.floor((HELD_TEXT_MAX_CHARS - 5) / 2) - 1) + "\n";
	const a = w.log.remoteCreate(P("a.md"), big);
	const b = w.log.remoteCreate(P("b.md"), "one\ntwo\n");
	await w.sync();
	w.log.writeGate = "revoked-epoch";
	w.vault.userWrite("b.md", "one\n");
	await assert.rejects(w.sync(3), KeyMissingError);
	assert.deepEqual(w.synced(b)!.held?.text, "one\n", "within the bound: kept with its text");
	w.vault.userWrite("a.md", big + "tail\n");
	await assert.rejects(w.sync(3), KeyMissingError);
	const ha = w.synced(a)!.held;
	assert.ok(ha !== undefined && ha.text === undefined && ha.base === undefined, "past the bound: the hash alone");
	assert.equal(w.vault.text("a.md"), big + "tail\n", "nothing is lost: the file holds the edit");
	w.log.writeGate = null;
	await w.sync();
	assert.equal(w.log.text(a), big + "tail\n");
	assert.equal(w.log.text(b), "one\n", "published by the ordinary merge once the gate opened");
	assert.equal(w.synced(a)!.held, undefined);
	assert.equal(w.synced(b)!.held, undefined);
});

test("write gate shut (key-missing): a pass the gate stops at another doc's ns op still marks a file gone from its record", async () => {
	// Sim suite-1 wipe/revoke/roll seed 40: a frozen canvas renamed while a note's rename waited on the gate. The plan
	// marked the canvas's record (fileGone, renamedTo), but the mark came after the refused ns ops: no pass reached it,
	// and the rename was lost with the store.
	const w = new World();
	await w.boot();
	const a = w.log.remoteCreate(P("a.md"), "one\n");
	const b = w.log.remoteCreate(P("b.md"), "two\n");
	await w.sync();
	w.log.writeGate = "revoked-epoch";
	w.log.setCaughtUp(b, false);
	w.vault.userWrite("c.md", "new\n"); // an nsCreate: refused at the gate
	w.vault.userDelete("b.md"); // its delete waits for the body: a mark only
	await assert.rejects(w.sync(3), KeyMissingError);
	assert.equal(w.synced(b)?.fileGone, true, "the delete is decided");
	assert.equal(w.synced(a)?.fileGone, undefined);
});

test("write gate shut (key-missing): an observed rename the gate refused survives an engine restart, kept on the synced record", async () => {
	// Sim suite-1 wipe/revoke/roll seed 112: key-missing after a revoke, the user deleted a canvas record and renamed the
	// file; the engine crashed. The restart had no rename to pair the edited file with: a new doc, and the doc came
	// back at the old path with the record.
	const w = new World();
	await w.boot();
	const id = w.log.remoteCreate(P("a.md"), "one\ntwo\nthree\nfour\n");
	await w.sync();
	w.log.writeGate = "revoked-epoch";
	w.vault.userWrite("a.md", "one\nthree\nfour\n");
	w.vault.userRename("a.md", "b.md");
	await assert.rejects(w.sync(3), KeyMissingError);
	assert.deepEqual({ gone: w.synced(id)?.fileGone, to: w.synced(id)?.renamedTo?.to }, { gone: true, to: "b.md" });
	await w.crashAndReboot();
	w.log.writeGate = null;
	await w.sync();
	assert.equal(w.vault.text("a.md"), null, "the doc is not back at the old path");
	assert.equal(w.vault.text("b.md"), "one\nthree\nfour\n");
	assert.equal(w.log.view().remote.get(id)?.path, "b.md");
	assert.equal(w.log.text(id), "one\nthree\nfour\n", "the delete merged against the synced base");
	assert.deepEqual(w.conflictCopies(), []);
	assert.equal([...w.log.view().remote.values()].filter((r) => r.state === "live").length, 1, "no new doc");
});
