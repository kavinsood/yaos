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
