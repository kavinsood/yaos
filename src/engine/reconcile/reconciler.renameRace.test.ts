import { test } from "node:test";
import assert from "node:assert/strict";
import type { VaultPath } from "../../core/types";
import { World } from "./testkit/world";

const P = (s: string): VaultPath => s;

/**
 * Sim canvas seed 20701862: a save, then a rename of the file before the pass that hashes the save reads it. The
 * host answers the read after the rename's event (hostRuntime flushes its batch first), so the read says "missing"
 * with the rename already observed, and the target is new and not hashed yet: the plan can only ask for its hash.
 * The observed rename must survive that pass. Dropped, the next pass saw the source gone and the target as a new
 * file whose hash matches nothing synced (the save changed it): the doc was deleted and a new one created, and a
 * peer's concurrent edit then restored the old doc with the records the user had deleted in the save.
 */
test("an observed rename whose target is not hashed yet survives the pass: the doc moves, it is not deleted and re-created", async () => {
	const w = new World();
	await w.boot();
	const d = w.log.remoteCreate(P("a.md"), "one\n");
	await w.sync();
	assert.equal(w.vault.text("a.md"), "one\n");
	w.vault.userWrite("a.md", "two\n");
	// The user renames the file while the pass that hashes the save reads it; the rename's event comes first.
	w.gateway.beforeRead = () => {
		w.gateway.beforeRead = null;
		w.vault.userRename("a.md", "b.md");
		w.flushEvents();
	};
	await w.sync();
	await w.sync();
	assert.deepEqual(w.log.submitted.filter((o) => o.t !== "create" || o.docId !== d).map((o) => o.t), ["rename"], "the doc is renamed, not deleted and re-created");
	assert.equal(w.synced(d)?.path, "b.md");
	assert.equal(w.log.text(d), "two\n", "the save before the rename is the doc's");
	assert.deepEqual(w.vault.paths().sort(), ["b.md"]);
});

/**
 * The other order: the read went out before the rename and returns the file as it was; the rename's event lands
 * before the result. The stale result must not overwrite what the event left (source gone, target pending).
 */
test("a read result is stale for a path hinted while the read was in flight", async () => {
	const w = new World();
	await w.boot();
	const d = w.log.remoteCreate(P("a.md"), "one\n");
	await w.sync();
	w.vault.userWrite("a.md", "two\n");
	w.flushEvents();
	const real = w.gateway.read.bind(w.gateway);
	let once = true;
	w.gateway.read = async (reads) => {
		const res = await real(reads);
		if (once && reads.some((r) => r.path === "a.md")) {
			once = false;
			w.vault.userRename("a.md", "b.md");
			w.flushEvents();
		}
		return res;
	};
	await w.r.scan.hashPending();
	assert.equal(w.r.ctx.local.get("a.md" as never)?.hash ?? null, null, "a.md's stale hash was not written over the rename's hint");
	await w.sync();
	await w.sync();
	assert.equal(w.synced(d)?.path, "b.md");
	assert.equal(w.log.text(d), "two\n");
	assert.deepEqual(w.vault.paths().sort(), ["b.md"]);
});

/**
 * Sim blob seed 1370759151: renames are chained by their stamps, and the stamps came from the wall clock. Set
 * back between seed1 -> r1 -> r5 and n5 -> r1, the last rename sorted first and chained n5 -> r1 -> r5: both docs
 * claimed r5.md, the editor bound to n5's doc followed the file to r1.md, and A's disk stayed stale for good.
 */
test("rename stamps follow event order when the wall clock is set back", async () => {
	const w = new World();
	await w.boot();
	const d1 = w.log.remoteCreate(P("seed1.md"), "one\n");
	const d2 = w.log.remoteCreate(P("n5.md"), "five\n");
	await w.sync();
	w.vault.userRename("seed1.md", "r1.md");
	w.vault.userRename("r1.md", "r5.md");
	w.clock.wall -= 200_000_000;
	w.vault.userRename("n5.md", "r1.md");
	await w.sync();
	await w.sync();
	assert.equal(w.synced(d1)?.path, "r5.md");
	assert.equal(w.synced(d2)?.path, "r1.md");
	assert.equal(w.log.text(d1), "one\n");
	assert.equal(w.log.text(d2), "five\n");
	assert.deepEqual(w.vault.paths().sort(), ["r1.md", "r5.md"]);
	assert.deepEqual(w.log.submitted.filter((o) => o.t !== "create" || (o.docId !== d1 && o.docId !== d2)).map((o) => o.t), ["rename", "rename"]);
});
