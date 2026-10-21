import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "../../sim/clock";
import { SimDevice } from "../../sim/device";
import { SimNet } from "../../sim/net";
import { fromMirrorEntry } from "./syncedMirror";
import type { ContentHash, DocId } from "../../core/types";

test("fromMirrorEntry: no CRDT sync point (§i.5 step 3), no base", () => {
	const e = { docId: "d1" as DocId, path: "a.md", kind: "markdown" as const, contentHash: "h" as ContentHash, nsTouchSeq: 7, bodyRemoteSeq: 29, blobRev: 0 };
	const r = fromMirrorEntry(e, (p) => p as never, 1);
	assert.equal(r.bodyVersion, null);
	assert.equal(r.hasBase, false);
});

test("IndexedDB lost with an unsaved editor buffer: own edits the relay has reach the disk after mirror recovery", async () => {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const a = new SimDevice({ name: "A", clock, net });
	const b = new SimDevice({ name: "B", clock, net });
	a.vault.userWrite("x.md", "one\n");
	void a.start();
	void b.start();
	await clock.advance(10_000); // synced, mirrors written
	assert.equal(b.vault.textOf("x.md"), "one\n");
	const v = a.workspace.openFile("x.md");
	assert.ok(v);
	await clock.advance(500);
	assert.equal(v.isBound(), true);
	v.edit(3, 0, " typed");
	await clock.advance(300); // frames sequenced; the editor has not saved yet
	assert.equal(a.vault.textOf("x.md"), "one\n");
	a.crashApp({ wipe: true });
	await clock.advance(1_000);
	assert.equal(b.vault.textOf("x.md"), "one typed\n");
	void a.restartApp();
	await clock.advance(20_000);
	for (const d of [a, b]) assert.equal(d.vault.textOf("x.md"), "one typed\n", d.name);
	// identity-per-store phase 2: the new store (a new deviceId) does not read the lost store's mirror, so the stale disk
	// text is kept as a conflict copy; phase 3's predecessor recovery (§5.2 step 5) imports the mirror and leaves x.md
	// alone, as this test asserted before.
	assert.deepEqual([...a.vault.snapshot().keys()].sort(), ["x (conflict A 2026-01-01 0000).md", "x.md"]);
	assert.equal(a.vault.textOf("x (conflict A 2026-01-01 0000).md"), "one\n");
});
