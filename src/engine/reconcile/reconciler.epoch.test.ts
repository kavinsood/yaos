import { test } from "node:test";
import assert from "node:assert/strict";
import type { VaultPath } from "../../core/types";
import { standInPathKey } from "../../core/plan/pathRules";
import { trustedEpochBase } from "./mergeJob";
import { World } from "./testkit/world";

const P = (s: string): VaultPath => s as VaultPath;

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

test("trustedEpochBase: only a subsequence of the crdt text is trusted", () => {
	assert.equal(trustedEpochBase(null, "x"), null);
	assert.equal(trustedEpochBase("", "x"), "");
	assert.equal(trustedEpochBase("a\nc\n", "a\nb\nc\n"), "a\nc\n");
	assert.equal(trustedEpochBase("a\nlocal\n", "a\n"), null);
	assert.equal(trustedEpochBase("ab", "ba"), null);
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
