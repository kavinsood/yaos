import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { VaultPath } from "../../core/types";
import { standInPathKey } from "../../core/plan/pathRules";
import { canvasToMergeText, parseCanvasText } from "../../core/hash/canvasCanonical";
import { rankCanvasInFileOrder } from "../../core/hash/testkit/canvasRanks";
import { trustedEpochBase } from "./contentSteps";
import type { OldDocDeletes } from "./oldDeletes";
import { World } from "./testkit/world";

const P = (s: string): VaultPath => s;

/** A device right after a vaultEpoch migration (§c.12): old-epoch base at the path, the doc re-created in the new epoch. */
async function migrated(base: string, disk: string, remote: string): Promise<{ w: World; id: ReturnType<World["log"]["remoteCreate"]> }> {
	const w = new World({ pathBases: new Map([[standInPathKey(P("n.md")), base]]) });
	w.vault.userWrite("n.md", disk);
	const id = w.log.remoteCreate(P("n.md"), remote);
	await w.boot();
	await w.sync();
	return { w, id };
}

test("epoch base ahead of the new epoch: the local-only line is kept, not read as a deletion", async () => {
	// The old relay never received "local" (an offline edit), so the peer re-created the doc without it.
	const { w, id } = await migrated("one\nlocal\n", "one\nlocal\n", "one\n");
	const texts = w.vault.paths().map((p) => w.vault.text(p) ?? "");
	assert.ok(texts.some((t) => t.includes("local")), `"local" survives on disk: ${JSON.stringify(w.vault.snapshot())}`);
	assert.equal(w.conflictCopies().length, 1, "kept as a conflict copy of the disk side");
	assert.equal(w.vault.text("n.md"), w.log.text(id));
});

test("epoch base contained in the new epoch's text: clean 3-way merge, no conflict copy", async () => {
	const { w, id } = await migrated("a\nb\n", "a\nb\nmine\n", "top\na\nb\n");
	assert.equal(w.vault.text("n.md"), "top\na\nb\nmine\n");
	assert.equal(w.log.text(id), "top\na\nb\nmine\n");
	assert.deepEqual(w.conflictCopies(), []);
});

/** The delete set of an old doc that had `from` deleted from the text of the remote doc `id` (same item ids). */
function oldTextDeletes(w: World, id: string, from: number, len: number): OldDocDeletes {
	const old = new Y.Doc();
	Y.applyUpdate(old, Y.encodeStateAsUpdate(w.log.canvasDoc(id as never)));
	old.getText("text").delete(from, len);
	return { kind: "markdown", ds: Y.createDeleteSetFromStructStore(old.store) };
}

/**
 * A restore (§c.12) after this device deleted " two": the restored doc is the old doc (same doc and item ids) from
 * before the delete. `sameDoc` false: the old doc was another one (after a reset the ids say nothing).
 */
async function restored(sameDoc: boolean): Promise<{ w: World; id: ReturnType<World["log"]["remoteCreate"]>; deletes: Map<string, OldDocDeletes> }> {
	const deletes = new Map<string, OldDocDeletes>();
	const w = new World({ pathBases: new Map([[standInPathKey(P("n.md")), "a\none three\nb\n"]]), docDeletes: deletes });
	w.vault.userWrite("n.md", "a\none three\nb\nmine\n");
	const id = w.log.remoteCreate(P("n.md"), "a\none two three\nb\n");
	deletes.set(sameDoc ? id : w.log.remoteCreate(P("other.md"), "x\n"), oldTextDeletes(w, id, 5, 4));
	await w.boot();
	await w.sync();
	return { w, id, deletes };
}

test("markdown text deleted before an epoch restore: the restored doc's copy of it is deleted again", async () => {
	const { w, id, deletes } = await restored(true);
	assert.equal(w.vault.text("n.md"), "a\none three\nb\nmine\n");
	assert.equal(w.log.text(id), "a\none three\nb\nmine\n");
	assert.deepEqual(w.conflictCopies(), []);
	assert.equal(deletes.size, 0, "applied and retired");
});

test("markdown text deletes are carried only into the same doc: another doc's ids say nothing", async () => {
	const { w, id } = await restored(false);
	assert.equal(w.vault.text("n.md"), "a\none two three\nb\nmine\n");
	assert.equal(w.log.text(id), "a\none two three\nb\nmine\n");
	assert.deepEqual(w.conflictCopies(), []);
});

test("old deletes follow the doc, not the path: a restored doc materialized where this device no longer has it", async () => {
	// Suite-1 seeds 164, 139: this device renamed the doc (or another device did) and deleted from it, then a
	// restore brought the doc back at its old path; the rename went with the old outbox. Keyed by path, the deletes
	// missed it. The doc keeps its id, and so do its records and characters.
	const deletes = new Map<string, OldDocDeletes>();
	const w = new World({ docDeletes: deletes });
	const md = w.log.remoteCreate(P("n.md"), "a\none two three\nb\n");
	const cv = w.log.remoteCreate(P("c.canvas"), board(node("a"), node("b"), node("x")));
	deletes.set(md, oldTextDeletes(w, md, 5, 4));
	deletes.set(cv, { kind: "canvas", keys: new Set(["n:b", "e:gone"]) });
	await w.boot();
	await w.sync();
	assert.equal(w.vault.text("n.md"), "a\none three\nb\n");
	assert.equal(w.log.text(md), "a\none three\nb\n");
	assert.deepEqual(ids(w.vault.text("c.canvas")), ["a@0", "x@0"]);
	assert.deepEqual(ids(w.log.canvasText(cv)), ["a@0", "x@0"]);
	assert.equal(deletes.size, 0);
});

test("trustedEpochBase: only a subsequence of the crdt text is trusted", () => {
	assert.equal(trustedEpochBase(null, "x"), null);
	assert.equal(trustedEpochBase("", "x"), "");
	assert.equal(trustedEpochBase("a\nc\n", "a\nb\nc\n"), "a\nc\n");
	assert.equal(trustedEpochBase("a\nlocal\n", "a\n"), null);
	assert.equal(trustedEpochBase("ab", "ba"), null);
	// Canvas merge text: whole record lines. A record the new epoch changed (or lacks) is not trusted.
	assert.equal(trustedEpochBase("{a}\n{doc}\n", "{a}\n{b}\n{doc}\n", "line"), "{a}\n{doc}\n");
	assert.equal(trustedEpochBase("{a:1}\n{doc}\n", "{a:2}\n{doc}\n", "line"), null);
	assert.equal(trustedEpochBase("{ab}\n", "{a}\n{b}\n", "line"), null, "lines, not characters");
});

// ------------------------------------------------------------------ canvas (§c.12 bases for every text kind)

type Obj = Record<string, unknown>;
const node = (id: string, x = 0): Obj => ({ id, type: "text", text: id.toUpperCase(), x, y: 0, width: 100, height: 50 });
const board = (...nodes: Obj[]): string => JSON.stringify({ nodes, edges: [] }, null, "\t");
/** The base a device stores for a synced canvas: the merge text of its projection. */
function canvasBase(json: string): string {
	const p = parseCanvasText(json);
	assert.equal(p.kind, "valid");
	if (p.kind !== "valid") throw new Error("unreachable");
	return canvasToMergeText(rankCanvasInFileOrder(p.data));
}
const ids = (t: string | null): string[] => (JSON.parse(t ?? "{}") as { nodes: Obj[] }).nodes.map((n) => `${String(n.id)}@${String(n.x)}`);

test("canvas epoch base contained in the new epoch: clean 3-way merge, no conflict copy", async () => {
	// The device moved b while migrating; a peer added c in the new epoch.
	const base = board(node("a"), node("b"));
	const w = new World({ pathBases: new Map([[standInPathKey(P("c.canvas")), canvasBase(base)]]) });
	w.vault.userWrite("c.canvas", board(node("a"), node("b", 40)));
	const id = w.log.remoteCreate(P("c.canvas"), board(node("a"), node("b"), node("c")));
	await w.boot();
	await w.sync();
	assert.deepEqual(ids(w.vault.text("c.canvas")), ["a@0", "b@40", "c@0"]);
	assert.deepEqual(ids(w.log.canvasText(id)), ["a@0", "b@40", "c@0"]);
	assert.deepEqual(w.conflictCopies(), []);
});

test("canvas epoch base ahead of the new epoch: the local-only record is kept in a conflict copy, not read as a deletion", async () => {
	const base = board(node("a"), node("local"));
	const w = new World({ pathBases: new Map([[standInPathKey(P("c.canvas")), canvasBase(base)]]) });
	w.vault.userWrite("c.canvas", base);
	const id = w.log.remoteCreate(P("c.canvas"), board(node("a")));
	await w.boot();
	await w.sync();
	assert.ok(w.vault.paths().some((p) => (w.vault.text(p) ?? "").includes('"local"')), JSON.stringify(w.vault.paths()));
	assert.equal(w.conflictCopies().length, 1);
	assert.deepEqual(ids(w.log.canvasText(id)), ["a@0"]);
});

test("canvas record deleted before the epoch change: the new epoch's copy of it is deleted, not read as added", async () => {
	// This device deleted b in the old epoch (its base and disk lack b, its old CRDT holds b deleted). The new epoch
	// holds b again: a restore to a point before the delete, or a peer that never received it re-created the canvas.
	const w = new World({
		pathBases: new Map([[standInPathKey(P("c.canvas")), canvasBase(board(node("a"), node("x")))]]),
		pathDeleted: new Map([[standInPathKey(P("c.canvas")), ["n:b", "n:gone"]]]),
	});
	w.vault.userWrite("c.canvas", board(node("a"), node("x", 40)));
	// b after x keeps the file-order ranks of a and x equal to the base's (a restore keeps the old epoch's ranks).
	const id = w.log.remoteCreate(P("c.canvas"), board(node("a"), node("x"), node("b"), node("c")));
	await w.boot();
	await w.sync();
	// b goes; c (new in the new epoch) and the local move of x stay.
	assert.deepEqual(ids(w.vault.text("c.canvas")), ["a@0", "x@40", "c@0"]);
	assert.deepEqual(ids(w.log.canvasText(id)), ["a@0", "x@40", "c@0"]);
	assert.deepEqual(w.conflictCopies(), []);
});

test("canvas migrated loser: the own re-create that lost the race merges into the winner against the epoch base", async () => {
	const w = new World({ pathBases: new Map([[standInPathKey(P("c.canvas")), canvasBase(board(node("a"), node("b")))]]) });
	w.vault.userWrite("c.canvas", board(node("a"), node("b", 40)));
	await w.boot();
	w.log.holdNs = true;
	await w.sync(); // own re-create, not sequenced yet
	const loser = w.syncedByPath("c.canvas")?.docId;
	assert.ok(loser);
	const win = w.log.remoteCreate(P("c.canvas"), board(node("a"), node("b"), node("c")));
	w.log.holdNs = false;
	await w.log.flushNs();
	await w.sync();
	assert.deepEqual(w.rebinds, [[loser, win]]);
	assert.deepEqual(w.vault.paths().filter((p) => p.endsWith(".canvas")), ["c.canvas"], "no suffixed duplicate");
	assert.deepEqual(ids(w.vault.text("c.canvas")), ["a@0", "b@40", "c@0"]);
	assert.deepEqual(ids(w.log.canvasText(win)), ["a@0", "b@40", "c@0"]);
	assert.deepEqual(w.conflictCopies(), []);
});

/**
 * §c.12 migrated loser: this device's own re-create of the path lost the race to a peer's. The collapse rebinds the
 * loser's synced record to the winner, then merges against the old epoch's base. When that merge does not run in the
 * same pass (a failed read here; a bound editor deferring it in the E7 suite-1 sim, E2EE_FAULTS 4 devices seed 32),
 * the next pass must not read the loser's sync point as the winner's: its base is this device's own text, so the
 * winner's text would merge as the deletion of the local edits.
 */
test("migrated loser whose merge is retried: the next pass still merges against the epoch base", async () => {
	const w = new World({ pathBases: new Map([[standInPathKey(P("n.md")), "a\nb\n"]]) });
	w.vault.userWrite("n.md", "a\nb\nmine\n");
	await w.boot();
	w.log.holdNs = true;
	await w.sync(); // own re-create, not sequenced yet
	const loser = w.syncedByPath("n.md")?.docId;
	assert.ok(loser);
	const win = w.log.remoteCreate(P("n.md"), "top\na\nb\n"); // the peer's create is sequenced first
	w.log.holdNs = false;
	await w.log.flushNs();
	assert.notEqual(w.log.view().remote.get(loser)?.path, "n.md", "the own create was suffixed");
	w.gateway.failReads.set("n.md", 1);
	await w.sync();
	assert.deepEqual(w.rebinds, [[loser, win]]);
	assert.ok(w.vault.paths().map((p) => w.vault.text(p) ?? "").some((t) => t.includes("mine")), `"mine" survives: ${JSON.stringify(w.vault.snapshot())}`);
	assert.equal(w.vault.text("n.md"), "top\na\nb\nmine\n");
	assert.equal(w.log.text(win), "top\na\nb\nmine\n");
	assert.deepEqual(w.conflictCopies(), []);
});

test("epoch migration: own edits only the replica holds, on a stream held for a read, are merged to disk first", async () => {
	// Sim seed 383 (randomized tuning): a skipped row left the stream stale, the device went offline, the user typed in
	// the editor and the app died before the save. The planner holds the doc (body-not-caught-up) and the old epoch's
	// stream can never be read; §c.12 step 5 then drops the outbox on the premise that its edits are on disk.
	const w = new World();
	const id = w.log.remoteCreate(P("n.md"), "one\ntwo\n");
	await w.boot();
	await w.sync();
	assert.equal(w.vault.text("n.md"), "one\ntwo\n");
	w.log.setBound(id, true);
	w.log.editorType(id, (t) => t.insert(4, "mine\n"));
	w.log.setBound(id, false); // the editor died unsaved
	w.log.setCaughtUp(id, false);
	await w.sync();
	assert.equal(w.vault.text("n.md"), "one\ntwo\n", "held for the read");
	assert.equal(await w.r.mergeStrandedEdits(), 1);
	assert.equal(w.vault.text("n.md"), "one\nmine\ntwo\n");
	assert.deepEqual(w.conflictCopies(), []);
});
