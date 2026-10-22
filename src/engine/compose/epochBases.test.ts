/** epochBases.ts: the previous epoch's unpublished renames (MetaPathMove, DESIGN §c.12 "Renames"). */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeviceId, DocId, PathKey, RemoteEntry, VaultId } from "../../core/types";
import { R, S } from "../../core/plan/testkit/planFixtures";
import { createWebHash } from "../adapters/webHash";
import { MemStoragePort } from "../../sim/storage";
import type { RemoteView } from "../reconcile/deps";
import { Repo } from "../store/repo";
import type { MetaPathMove } from "../store/schema";
import { EpochBases, pathMoveKey } from "./epochBases";

const IDENT = { vaultId: "vault-test" as VaultId, vaultEpoch: "e2", deviceId: "dev-a" as DeviceId, clientVersion: "test" };
const move = (from: string, to: string): MetaPathMove => ({ key: pathMoveKey(from as PathKey), from, to, atMs: 5 });

function view(remote: Record<string, string>, nsReady = true): Pick<RemoteView, "remote" | "remoteByPathKey" | "nsReady"> {
	const m = new Map<DocId, RemoteEntry>();
	const byKey = new Map<PathKey, DocId>();
	for (const [id, path] of Object.entries(remote)) {
		const r = R(id, path);
		m.set(r.docId, r);
		byKey.set(r.pathKey, r.docId);
	}
	return { remote: m, remoteByPathKey: byKey, nsReady };
}

test("unpublished renames are stored with the new DB, read as observed renames, and retired once their source is settled", async () => {
	const storage = new MemStoragePort();
	const o = await Repo.open(storage, IDENT, 1, { pathMoves: [move("c/c3.canvas", "b/c5.canvas"), move("x.md", "y.md"), move("k.md", "l.md")] });
	assert.ok(o.repo);
	const bases = await EpochBases.load(o.repo, createWebHash());
	assert.deepEqual(bases.renames().map((r) => r.from).sort(), ["c/c3.canvas", "k.md", "x.md"]);
	// ns not ready: nothing is decided.
	assert.equal(await bases.settle(view({}, false), [], () => false), 0);
	// c3: the doc is still there, not synced here (the move has not run): kept. x.md: nothing there: retired.
	// k.md: the doc there is synced here (the file came back to it): retired.
	const n = await bases.settle(view({ d1: "c/c3.canvas", d2: "k.md" }), [S("d2", "k.md")], () => false);
	assert.equal(n, 2);
	assert.deepEqual(bases.renames().map((r) => r.from), ["c/c3.canvas"]);
	// A restart reads what is left.
	const again = await EpochBases.load(o.repo, createWebHash());
	assert.deepEqual(again.renames(), [{ from: "c/c3.canvas", to: "b/c5.canvas", atMs: 5 }]);
	// The doc moved with the file (nsRename): nothing left at the source.
	assert.equal(await again.settle(view({ d1: "b/c5.canvas" }), [S("d1", "b/c5.canvas")], () => true), 1);
	assert.deepEqual(again.renames(), []);
	assert.deepEqual(await o.repo.pathMoves(), []);
	o.db.close();
});
