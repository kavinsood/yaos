import { test } from "node:test";
import assert from "node:assert/strict";
import type { PathKey, VaultPath } from "../../core/types";
import { World } from "./testkit/world";

const P = (s: string): VaultPath => s as VaultPath;

/**
 * §c.5 / §c.13 merged alias: our create of n.md is still pending when another
 * device's identical create (same hash) wins the fold. We edited the file in
 * between; that edit only lived in our held initial frames, which the merged
 * fold drops. The winner's body arrives later.
 */
async function editedLoser(): Promise<{ w: World; win: ReturnType<World["log"]["remoteCreate"]> }> {
	const w = new World();
	await w.boot();
	w.log.holdNs = true;
	w.log.mergeIdentical = true;
	w.vault.userWrite("n.md", "c\n");
	await w.sync();
	w.vault.userWrite("n.md", "c\nmine\n");
	await w.sync();
	const win = w.log.remoteCreateBodyless(P("n.md"), "c\n");
	const folded = await w.log.flushNs();
	assert.deepEqual(folded.map((e) => e.outcome.kind), ["merged"]);
	return { w, win };
}

test("merged alias with a local edit in the dropped frames: the edit is kept, never written over", async () => {
	const { w, win } = await editedLoser();
	await w.sync();
	assert.equal(w.vault.text("n.md"), "c\nmine\n", "nothing written while the winner's body is in flight");
	assert.equal(w.synced(win)?.hasBase, false, "the loser's base (with the dropped edit) is not the winner's");
	w.log.remoteEdit(win, (t) => t.insert(0, "c\n"));
	await w.sync();
	// The winner still holds its create text: that is the sync point, so the edit merges in cleanly.
	assert.equal(w.vault.text("n.md"), "c\nmine\n");
	assert.equal(w.log.text(win), "c\nmine\n");
	assert.deepEqual(w.conflictCopies(), []);
});

test("merged alias, winner edited too: the dropped local edit survives as a conflict copy", async () => {
	const { w, win } = await editedLoser();
	await w.sync();
	w.log.remoteEdit(win, (t) => t.insert(0, "c\n"));
	w.log.remoteEdit(win, (t) => t.insert(t.length, "theirs\n"));
	await w.sync();
	const texts = w.vault.paths().map((p) => w.vault.text(p) ?? "");
	assert.ok(texts.some((t) => t.includes("mine")), `the edit survives: ${JSON.stringify(w.vault.snapshot())}`);
	assert.equal(w.vault.text("n.md"), w.log.text(win));
	assert.ok(w.log.text(win).includes("theirs"));
});

test("merged alias without local edits (E3): zero disk ops, zero conflict copies", async () => {
	const w = new World();
	await w.boot();
	w.log.holdNs = true;
	w.log.mergeIdentical = true;
	w.vault.userWrite("n.md", "c\n");
	await w.sync();
	const win = w.log.remoteCreateBodyless(P("n.md"), "c\n");
	await w.log.flushNs();
	const writes = w.gateway.executed.length;
	await w.sync();
	w.log.remoteEdit(win, (t) => t.insert(0, "c\n"));
	await w.sync();
	assert.equal(w.vault.text("n.md"), "c\n");
	assert.deepEqual(w.conflictCopies(), []);
	assert.equal(w.gateway.executed.length, writes, "no disk ops");
	assert.equal(w.synced(win)?.hasBase, true);
});

test("merged alias rebind reports the move, so an editor bound to the loser re-opens on the winner", async () => {
	// Sim seeds 924 / 668: the planner's rebind moved S to the winner but nobody told the bound editor, whose
	// typing kept going to the loser's stream while the merge job of the loser stayed "deferred".
	const w = new World();
	await w.boot();
	w.log.holdNs = true;
	w.log.mergeIdentical = true;
	w.vault.userWrite("n.md", "c\n");
	await w.sync();
	const loser = w.log.view().remoteByPathKey.get("n.md" as PathKey);
	assert.ok(loser);
	const win = w.log.remoteCreateBodyless(P("n.md"), "c\n");
	await w.log.flushNs();
	await w.sync();
	assert.equal(w.synced(win)?.path, "n.md");
	assert.deepEqual(w.rebinds, [[loser, win]]);
});

test("own rename suffixed, then a later own rename of the same doc applied in one fold: S stays at the later path", async () => {
	const w = new World();
	await w.boot();
	const d = w.log.remoteCreate(P("a.md"), "a\n");
	const x = w.log.remoteCreate(P("x.md"), "x\n");
	await w.sync();
	w.log.holdNs = true;
	w.vault.userRename("a.md", "r7.md");
	await w.sync();
	w.vault.userRename("r7.md", "r2.md");
	await w.sync();
	// Another device takes r7.md before our renames fold; our disk follows it (r7.md is free here).
	w.log.remoteRename(x, P("r7.md"));
	await w.sync();
	assert.equal(w.vault.text("r7.md"), "x\n");
	const folded = await w.log.flushNs();
	assert.deepEqual(folded.map((e) => e.outcome.kind), ["suffixed", "applied"]);
	const res = await w.sync();
	assert.equal(w.synced(d)?.path, "r2.md", "the suffixed rename's requested path is not where the file is");
	assert.equal(w.synced(x)?.path, "r7.md");
	assert.deepEqual(w.vault.snapshot(), { "r2.md": "a\n", "r7.md": "x\n" });
	assert.ok(res.quiet, "no retried disk rename");
});

test("own rename suffixed, S1 lands after a pass already moved the file to the final path: S is not pointed back", async () => {
	const w = new World();
	await w.boot();
	const d = w.log.remoteCreate(P("a.md"), "a\n");
	const x = w.log.remoteCreate(P("x.md"), "x\n");
	await w.sync();
	w.log.holdNs = true;
	w.vault.userRename("a.md", "r0.md");
	await w.sync();
	w.log.remoteRename(x, P("r0.md"));
	// The fold commits before its S1 batch runs (the runtime queues own events for the next pass).
	const s1 = w.log.onOwnFold;
	w.log.onOwnFold = null;
	const folded = await w.log.flushNs();
	assert.deepEqual(folded.map((e) => e.outcome.kind), ["suffixed"]);
	await w.sync();
	assert.equal(w.synced(d)?.path, "r0 (2).md");
	await s1?.(folded);
	const res = await w.sync();
	assert.equal(w.synced(d)?.path, "r0 (2).md", "S stays where the file is");
	assert.equal(w.synced(x)?.path, "r0.md");
	assert.deepEqual(w.vault.snapshot(), { "r0 (2).md": "a\n", "r0.md": "x\n" });
	assert.ok(res.quiet, "no retried disk rename");
});

test("own rename applied while S is still at the old path (synced mirror restored after IDB loss): S follows the op", async () => {
	const w = new World();
	await w.boot();
	const d = w.log.remoteCreate(P("a.md"), "a\n");
	await w.sync();
	const before = w.synced(d)!;
	w.log.holdNs = true;
	w.vault.userRename("a.md", "b.md");
	await w.sync();
	const s1 = w.log.onOwnFold;
	w.log.onOwnFold = null;
	const folded = await w.log.flushNs();
	assert.deepEqual(folded.map((e) => e.outcome.kind), ["applied"]);
	// The restored mirror predates the rename job: S is back at a.md with the older touch seq. A new file sits there.
	await w.r.ctx.commit({ syncedPut: [w.r.ctx.record(before)] });
	w.vault.userWrite("a.md", "new\n");
	await s1?.(folded);
	const res = await w.sync();
	assert.equal(w.synced(d)?.path, "b.md", "S follows its own committed rename");
	assert.notEqual(w.syncedByPath("a.md")?.docId, d, "the file at the old path is a new doc");
	assert.deepEqual(w.vault.snapshot(), { "a.md": "new\n", "b.md": "a\n" });
	assert.ok(res.quiet);
});
