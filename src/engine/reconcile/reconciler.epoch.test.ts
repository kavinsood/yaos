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
