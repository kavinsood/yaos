import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContentHash, DocId, NsOp, PathKey, RemoteEntry, SyncedEntry, VaultPath } from "../../core/types";
import { applyOwnFold } from "./ownFold";
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

/**
 * Hot canvas seed 503 (suite 1): B renamed n4 to r2, then (the first still unsequenced) back to r5, and its pass
 * moved S to r5. The late fold of the r2 rename came back suffixed. S had "moved on" to the pending rename, but that
 * was judged against the overlay's projection of it, which suffixed it ("r5 (2)": another doc held r5 in the
 * committed fold), so S went back to r2: the next pass merged another doc's file into n4. A pending own move is
 * judged by its requested path.
 */
test("S follows a pending own rename by its requested path, not by the overlay's suffixed projection of it", async () => {
	const d1 = "d1" as DocId;
	const s: SyncedEntry = {
		docId: d1, path: P("r5.md"), pathKey: "r5.md" as PathKey, kind: "markdown", contentHash: "h" as ContentHash, fingerprint: "f" as SyncedEntry["fingerprint"],
		size: 1, mtimeMs: 1, bodyVersion: null, blobRev: 0, nsTouchSeq: 3, hasBase: true,
	};
	const puts: SyncedEntry[] = [];
	const remote = new Map([[d1, { docId: d1, pendingLocal: true, path: P("r5 (2).md"), pathKey: "r5 (2).md" as PathKey } as unknown as RemoteEntry]]);
	const pending: NsOp = { t: "rename", docId: d1, path: P("r5.md") };
	const ctx = {
		synced: (id: DocId) => (id === d1 ? s : undefined),
		pk: (p: VaultPath) => p.toLowerCase() as PathKey,
		localAt: () => undefined,
		record: (e: SyncedEntry) => e,
		commit: async (c: { syncedPut: SyncedEntry[] }) => void puts.push(...c.syncedPut),
		log: { view: () => ({ remote, pendingMoves: new Map([[d1, new Set(["r5.md" as PathKey])]]), pendingOps: [pending] }) },
	};
	await applyOwnFold(ctx as never, [{ op: { t: "rename", docId: d1, path: P("r2.md") }, seq: 9, outcome: { kind: "suffixed", requestedPath: P("r2.md"), finalPath: P("r2 (2).md") }, entry: null }]);
	assert.deepEqual(puts.map((e) => e.path), [], "S stays at r5.md");
});
