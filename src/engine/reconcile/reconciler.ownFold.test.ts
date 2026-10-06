import { test } from "node:test";
import assert from "node:assert/strict";
import type { VaultPath } from "../../core/types";
import { World } from "./testkit/world";

const P = (s: string): VaultPath => s as VaultPath;

/**
 * S1 timing (§c.13). The vault runtime queues own fold events, and an own op can fold while a pass awaits
 * (intents, hashing) before it plans. That plan must already see the S1 update. Here our restore of x.md folds
 * suffixed to "x (2).md" during the pass's hash reads. A plan that sees the revived entry before S1 renames the
 * file to "x (2).md" and lets the other doc take x.md; the late S1 then put S back on x.md, and the next pass
 * merged the other doc's file into ours.
 */
test("an own restore that folds while a pass hashes gets its S1 update before that pass plans", async () => {
	const w = new World({ deferOwnFold: true });
	await w.boot();
	const d1 = w.log.remoteCreate(P("x.md"), "one\n");
	await w.sync();
	assert.equal(w.vault.text("x.md"), "one\n");
	// Deleted elsewhere while we edited it; another device then creates x.md.
	w.log.holdNs = true;
	w.log.remoteDelete(d1);
	w.vault.userWrite("x.md", "one\nmine\n");
	const d2 = w.log.remoteCreate(P("x.md"), "two\n");
	await w.sync();
	assert.deepEqual(w.log.submitted.filter((o) => o.t === "restore").map((o) => o.t), ["restore"]);
	// The restore folds during the next pass's hash reads (y.md is new).
	let folded = "";
	w.gateway.beforeRead = async () => {
		w.gateway.beforeRead = null;
		w.log.holdNs = false;
		const ev = await w.log.flushNs();
		folded = JSON.stringify(ev.map((e) => e.outcome));
	};
	w.vault.userWrite("y.md", "y\n");
	await w.sync();
	await w.sync();
	assert.equal(folded, JSON.stringify([{ kind: "revived", finalPath: "x (2).md" }]));
	assert.equal(w.vault.text("x.md"), "two\n");
	assert.equal(w.vault.text("x (2).md"), "one\nmine\n");
	assert.equal(w.log.text(d2), "two\n", "the other doc's text stays its own");
	assert.equal(w.log.text(d1), "one\nmine\n");
	assert.equal(w.synced(d1)?.path, "x (2).md");
	assert.equal(w.synced(d2)?.path, "x.md");
});
