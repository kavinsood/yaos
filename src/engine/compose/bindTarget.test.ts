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
