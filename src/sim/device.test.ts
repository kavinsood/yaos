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

test("engine killed mid-typing: the runtime stops, the editor keeps every keystroke, the user's restart loses nothing", async () => {
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
	const dead = a.runtime;
	a.crashEngine();
	va.edit(13, 0, " three"); // typed while the engine is down
	await clock.advance(3_000);
	// The dead worker stopped its runtime for good: one fatal, and the next engine is the user's restart (a new
	// runtime), never a background one.
	assert.equal(dead.engine.isStopped, true);
	assert.deepEqual(a.ui.crashFatals.map((e) => e.message), ["the sync engine failed: sim crash"]);
	assert.deepEqual(a.ui.fatals, []);
	assert.notEqual(a.runtime, dead);
	assert.equal(a.engineStarts, 2);
	assert.equal(a.runtime.engine.isReady, true);
	b.setOnline(true);
	await clock.advance(5_000);
	// The new runtime binds the view as at a first open: the engine's replica holds " one" (it reached the relay),
	// the editor " one two three", the disk neither. Nothing is lost: the editor side is kept as a conflict copy.
	const want = "start one two three";
	assert.equal(va.getText(), a.engineText("a.md"));
	assert.equal(b.vault.textOf("a.md"), a.engineText("a.md"));
	assert.ok([...b.vault.snapshot().values()].includes(want), "every keystroke reached B");
	assert.ok([...a.vault.snapshot().values()].includes(want), "every keystroke is on A's disk");
});

test("engine dies with a dirty view, then a second view loads the older disk text during the restart: the edit survives (sim seed 62)", async () => {
	const { clock, devs } = world();
	const a = dev(devs, 0);
	const b = dev(devs, 1);
	a.vault.userWrite("a.md", "start [Z]\n");
	await boot(clock, devs);
	await clock.advance(2_000);
	const va = a.workspace.openFile("a.md");
	assert.ok(va);
	await clock.advance(500);
	va.edit(6, 0, "[A] "); // typed, not saved yet (2 s debounce)
	await clock.advance(400);
	va.edit(10, 3, ""); // and deleted the seed token
	await clock.advance(400); // pushed, framed, committed, on the relay
	assert.equal(a.vault.textOf("a.md"), "start [Z]\n", "the editor has not saved");
	a.crashEngine();
	// While the next runtime starts, a second view of the file loads what is on disk. The re-bind of the dirty view
	// must tell the engine which text is on disk (`saved`), or the second view's older text reads as an edit
	// against the first view's unsaved one and reverts it.
	const vb = a.workspace.openFile("a.md");
	assert.ok(vb);
	await clock.advance(10_000);
	assert.equal(a.engineStarts, 2);
	const want = "start [A] \n";
	assert.equal(a.engineText("a.md"), want);
	assert.equal(va.getText(), want);
	assert.equal(vb.getText(), want);
	assert.equal(b.vault.textOf("a.md"), want);
});

test("worker storage failure stops the runtime: storage-lost fatal, one engine, no fallback (OR-1)", async () => {
	const { clock, devs } = world({ workerMode: "storage-fails" });
	const a = dev(devs, 0);
	const b = dev(devs, 1);
	a.vault.userWrite("x.md", "1");
	await boot(clock, devs);
	await clock.advance(60_000);
	assert.equal(a.runtime.engine.isStopped, true);
	assert.equal(a.runtime.engine.carrierKind, null);
	assert.deepEqual(a.ui.fatals.map((e) => e.code), ["storage-lost"]);
	assert.match(a.ui.fatals[0]?.message ?? "", /^the sync engine could not start: engine ports: IndexedDB unavailable in worker$/);
	assert.equal(a.engineStarts, 1, "no second engine");
	assert.deepEqual(a.ui.carriers, [{ carrier: null, ready: false }], "never ready; the UI shows no carrier");
	assert.equal(b.vault.textOf("x.md"), null, "nothing synced from A");
});

test("no Worker: the runtime stops before any engine runs", async () => {
	const { clock, devs } = world({ workerMode: "unavailable" });
	const a = dev(devs, 0);
	await boot(clock, devs);
	await clock.advance(60_000);
	assert.equal(a.runtime.engine.isStopped, true);
	assert.deepEqual(a.ui.fatals.map((e) => e.message), ["the sync engine could not start: Worker is not available (sim)"]);
	assert.equal(a.engineStarts, 0);
	assert.deepEqual(a.ui.carriers, [{ carrier: null, ready: false }]);
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
