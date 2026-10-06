import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "../../sim/clock";
import { SimDevice } from "../../sim/device";
import { SimNet } from "../../sim/net";

function world(): { clock: VirtualClock; a: SimDevice; b: SimDevice } {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	return { clock, a: new SimDevice({ name: "A", clock, net }), b: new SimDevice({ name: "B", clock, net }) };
}

test("openDoc: a path the remote moved a doc onto, holding a file of this device's the mover never saw, does not bind that doc", async () => {
	const { clock, a, b } = world();
	a.vault.userWrite("n2.md", "two\n");
	a.vault.userWrite("n6.md", "six\n");
	void a.start();
	void b.start();
	await clock.advance(5_000);
	assert.equal(b.vault.textOf("n6.md"), "six\n");
	// A restarts offline: its ns is not caught up, so its own rename below is not submitted until it reconnects.
	a.setOnline(false);
	a.crashApp();
	await clock.advance(100);
	void a.restartApp();
	a.setOnline(false);
	await clock.advance(2_000);
	assert.ok(b.vault.userRename("n6.md", "r7.md"));
	await clock.advance(2_000);
	assert.ok(a.vault.userRename("n2.md", "r7.md"));
	await clock.advance(1_000);
	const v = a.workspace.openFile("r7.md");
	assert.ok(v);
	await clock.advance(500);
	// On reconnect A learns that n6's doc moved to r7.md before it learns its own rename lost the path.
	a.setOnline(true);
	await clock.advance(20_000);
	for (const d of [a, b]) {
		assert.equal(d.vault.textOf("r7.md"), "six\n", d.name);
		assert.equal(d.vault.textOf("r7 (2).md"), "two\n", d.name);
	}
	assert.equal(v.path, "r7 (2).md");
	assert.equal(v.getText(), "two\n");
});

test("bindTarget: a doc whose delete waits (fileGone) does not bind at its synced path; at its remote path the file is its own", async () => {
	const { bindTarget } = await import("./runtimeOps");
	const live = (docId: string, path: string) => ({ docId, path, pathKey: path, state: "live", createHash: "h0", body: { hasContent: true } });
	const fake = (remote: ReturnType<typeof live>[], synced: { docId: string; pathKey: string; fileGone?: true }[], local: string[]) => {
		const s = new Map(synced.map((e) => [e.docId, e]));
		return {
			port: { view: () => ({ remote: new Map(remote.map((r) => [r.docId, r])), remoteByPathKey: new Map(remote.map((r) => [r.pathKey, r.docId])) }) },
			rec: { ctx: { synced: (id: string) => s.get(id), local: new Map(local.map((k) => [k, {}])), store: { synced: s } } },
		} as never;
	};
	// gone at a.md, the doc still live there: a file at a.md is new
	assert.equal(bindTarget(fake([live("d1", "a.md")], [{ docId: "d1", pathKey: "a.md", fileGone: true }], ["a.md"]), "a.md" as never), undefined);
	// gone at a.md, the doc moved to b.md (an own rename marked offline): the file at b.md is the doc's, a new file at a.md does not block it
	const moved = fake([live("d1", "b.md")], [{ docId: "d1", pathKey: "a.md", fileGone: true }], ["a.md", "b.md"]);
	assert.equal(bindTarget(moved, "b.md" as never)?.docId, "d1");
	// not gone: the doc's file still at a.md blocks the bind at b.md (the planner has not moved it yet)
	const notGone = fake([live("d1", "b.md")], [{ docId: "d1", pathKey: "a.md" }], ["a.md", "b.md"]);
	assert.equal(bindTarget(notGone, "b.md" as never), undefined);
});
