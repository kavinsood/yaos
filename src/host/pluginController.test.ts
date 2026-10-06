import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "../sim/clock";
import { SimNet } from "../sim/net";
import { SimDevice } from "../sim/device";
import { YaosController } from "./pluginController";
import { defaultPluginData, type PairedIdentity, type YaosPluginData } from "./ui/api";

const ID: PairedIdentity = { host: "https://relay.example", vaultId: "v1", deviceId: "dev-A", deviceToken: "secret-token", deviceName: "A", vaultGeneration: null };

function setup(initial: YaosPluginData = defaultPluginData("A")) {
	const clock = new VirtualClock();
	const net = new SimNet(clock, { linkMs: 10 });
	const dev = new SimDevice({ name: "A", clock, net });
	const saved: YaosPluginData[] = [];
	const notices: string[] = [];
	const logs: string[] = [];
	const ctl = new YaosController(initial, {
		makeRuntime: (identity, settings, ui) => dev.runtimeFor(identity, settings, ui),
		saveData: async (d) => {
			saved.push(d);
		},
		notice: (level, m) => notices.push(`${level}:${m}`),
		log: (l) => logs.push(l),
	});
	let changes = 0;
	ctl.onChange(() => changes++);
	return { clock, dev, ctl, saved, notices, logs, changes: () => changes };
}

test("unpaired: no runtime, commands refuse with a safe message", async () => {
	const { ctl } = setup();
	await ctl.start();
	assert.equal(ctl.runState().phase, "unpaired");
	assert.equal(ctl.activeRuntime, null);
	await assert.rejects(ctl.command({ t: "pause" }), /not running/);
});

test("pairing starts the engine; status, commands, settings and unpairing flow through", async () => {
	const { clock, dev, ctl, saved, changes, logs } = setup();
	dev.vault.userWrite("a.md", "hello");
	await ctl.start();
	const pair = ctl.updateData((d) => ({ ...d, identity: ID }));
	await clock.advance(1_000);
	await pair;
	assert.equal(saved.length, 1);
	assert.equal(ctl.runState().phase, "running");
	assert.equal(ctl.runState().transport, "worker");
	assert.ok(ctl.status(), "status snapshot received");
	assert.ok(changes() >= 3);
	const ok = ctl.command({ t: "pause" });
	await clock.advance(10);
	assert.deepEqual(await ok, { t: "ok" });
	const engineBefore = dev.engine;
	const upd = ctl.updateData((d) => ({ ...d, engine: { ...d.engine, excludePatterns: ["private/**"] } }));
	await clock.advance(10);
	await upd;
	assert.equal(ctl.runState().phase, "running", "settings change does not restart");
	assert.equal(dev.engineStarts, 1);
	assert.equal(dev.engine, engineBefore, "same engine instance");
	const relabel = ctl.updateData((d) => ({ ...d, deviceLabel: "Laptop" }));
	await clock.advance(5_000);
	await relabel;
	assert.equal(dev.engineStarts, 2, "label change restarts with the new label");
	assert.equal(dev.engine?.config?.deviceLabel, "Laptop");
	const unpair = ctl.updateData((d) => ({ ...d, identity: null }));
	await clock.advance(5_000);
	await unpair;
	assert.equal(ctl.runState().phase, "unpaired");
	assert.equal(ctl.activeRuntime, null);
	assert.equal(logs.join("\n").includes("secret-token"), false, "credential never logged");
});

test("identical data is a no-op; restartEngine replaces the runtime", async () => {
	const { clock, dev, ctl, saved } = setup({ ...defaultPluginData("A"), identity: ID });
	const s = ctl.start();
	await clock.advance(1_000);
	await s;
	await ctl.updateData((d) => d);
	assert.equal(saved.length, 0);
	const first = ctl.activeRuntime;
	const r = ctl.restartEngine();
	await clock.advance(5_000);
	await r;
	assert.notEqual(ctl.activeRuntime, first);
	assert.equal(ctl.runState().phase, "running");
	assert.equal(dev.engineStarts, 2);
	const st = ctl.stop();
	await clock.advance(5_000);
	await st;
	assert.equal(ctl.runState().phase, "stopped");
});
