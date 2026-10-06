import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "./clock";
import { SimDevice, type SimDeviceOptions } from "./device";
import { SimNet } from "./net";

function world(opts: Partial<SimDeviceOptions> = {}, names = ["A", "B"]): { clock: VirtualClock; net: SimNet; devs: SimDevice[] } {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const devs = names.map((name) => new SimDevice({ name, clock, net, ...opts }));
	return { clock, net, devs };
}

async function boot(clock: VirtualClock, devs: SimDevice[]): Promise<void> {
	for (const d of devs) void d.start();
	await clock.advance(500);
}

function dev(devs: SimDevice[], i: number): SimDevice {
	const d = devs[i];
	if (!d) throw new Error("no device");
	return d;
}

test("existing file on A appears on B; edits on disk propagate", async () => {
	const { clock, devs } = world();
	const a = dev(devs, 0);
	const b = dev(devs, 1);
	a.vault.userWrite("notes/a.md", "hello\n");
	await boot(clock, devs);
	await clock.advance(2_000);
	assert.equal(b.vault.textOf("notes/a.md"), "hello\n");
	assert.equal(a.runtime.engine.carrierKind, "worker");
	a.vault.externalWrite("notes/a.md", "hello\nworld\n");
	await clock.advance(3_000);
	assert.equal(b.vault.textOf("notes/a.md"), "hello\nworld\n");
	b.vault.userWrite("notes/b.md", "from b");
	await clock.advance(3_000);
	assert.equal(a.vault.textOf("notes/b.md"), "from b");
	assert.equal(a.vault.trashed.length + b.vault.trashed.length, 0);
});

test("bound editor typing reaches the other device's disk and editor without echo", async () => {
	const { clock, devs } = world();
	const a = dev(devs, 0);
	const b = dev(devs, 1);
	a.vault.userWrite("a.md", "abc");
	await boot(clock, devs);
	await clock.advance(2_000);
	const va = a.workspace.openFile("a.md");
	const vb = b.workspace.openFile("a.md");
	assert.ok(va && vb);
	await clock.advance(500);
	assert.equal(va.isBound(), true);
	assert.equal(vb.isBound(), true);
	va.edit(3, 0, " from A");
	await clock.advance(30);
	vb.edit(0, 0, "B: ");
	await clock.advance(5_000);
	assert.equal(va.getText(), "B: abc from A");
	assert.equal(vb.getText(), "B: abc from A");
	assert.equal(a.vault.textOf("a.md"), "B: abc from A");
	assert.equal(b.vault.textOf("a.md"), "B: abc from A");
	assert.equal(va.counters.defaultReloadWhileBound + vb.counters.defaultReloadWhileBound, 0);
	assert.equal(va.counters.localTx, 1, "remote changes are not re-sent as local edits");
	assert.equal(vb.counters.localTx, 1);
	const before = a.runtime.bindings.stats.pushes;
	await clock.advance(10_000);
	assert.equal(a.runtime.bindings.stats.pushes, before, "quiet after convergence (no echo loop)");
});

test("pagehide flushes the coalesce buffer synchronously (acceptance 4)", async () => {
	const { clock, devs } = world();
	const a = dev(devs, 0);
	a.vault.userWrite("a.md", "x");
	await boot(clock, devs);
	const va = a.workspace.openFile("a.md");
	assert.ok(va);
	await clock.advance(500);
	assert.equal(va.isBound(), true);
	const posted = a.runtime.bindings.stats.pushes;
	va.edit(1, 0, "y");
	assert.equal(a.runtime.bindings.stats.pushes, posted, "still coalescing");
	a.platform.emit("pagehide");
	assert.equal(a.runtime.bindings.stats.pushes, posted + 1, "flushed before pagehide returns");
	assert.equal(a.runtime.stats.lifecycleFlushes, 1);
	await clock.advance(100);
	assert.equal(a.engineText("a.md"), "xy");
});

test("engine killed mid-typing loses nothing (re-attach with the durable base after restart)", async () => {
	const { clock, devs } = world();
	const a = dev(devs, 0);
	const b = dev(devs, 1);
	a.vault.userWrite("a.md", "start");
	await boot(clock, devs);
	await clock.advance(2_000);
	const va = a.workspace.openFile("a.md");
	assert.ok(va);
	await clock.advance(500);
	b.setOnline(false); // nothing escapes to the hub copy on B while A crashes
	va.edit(5, 0, " one");
	await clock.advance(20); // posted + applied in the engine, not persisted
	va.edit(9, 0, " two"); // still in the coalesce buffer
	a.crashEngine();
	va.edit(13, 0, " three"); // typed while the engine is down
	await clock.advance(3_000);
	assert.equal(a.engineStarts, 2);
	assert.equal(a.runtime.engine.isReady, true);
	assert.equal(a.engineText("a.md"), "start one two three");
	b.setOnline(true);
	await clock.advance(5_000);
	assert.equal(b.vault.textOf("a.md"), "start one two three");
	assert.equal(va.getText(), "start one two three");
});

test("worker storage failure falls back to inline and still syncs (OR-1 fallback)", async () => {
	const { clock, devs } = world({ workerMode: "storage-fails" });
	const a = dev(devs, 0);
	const b = dev(devs, 1);
	a.vault.userWrite("x.md", "1");
	await boot(clock, devs);
	await clock.advance(2_000);
	assert.equal(a.runtime.engine.carrierKind, "inline");
	assert.equal(a.runtime.currentDeviceClass, "tablet");
	assert.equal(b.vault.textOf("x.md"), "1");
});

test("same path created on both devices while offline: one keeps the doc, the other's text goes to a conflict copy", async () => {
	const { clock, devs } = world();
	const a = dev(devs, 0);
	const b = dev(devs, 1);
	await boot(clock, devs);
	b.setOnline(false);
	a.vault.userWrite("same.md", "from A");
	b.vault.userWrite("same.md", "from B");
	await clock.advance(2_000);
	b.setOnline(true);
	await clock.advance(5_000);
	assert.equal(a.vault.textOf("same.md"), b.vault.textOf("same.md"));
	const all = [...a.vault.snapshot().values(), ...b.vault.snapshot().values()].join("|");
	assert.ok(all.includes("from A") && all.includes("from B"), "no text lost");
	assert.deepEqual([...a.vault.snapshot().keys()].sort(), [...b.vault.snapshot().keys()].sort());
});
