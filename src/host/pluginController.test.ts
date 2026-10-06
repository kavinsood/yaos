import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "../sim/clock";
import { SimNet } from "../sim/net";
import { SimDevice } from "../sim/device";
import type { HostUiSink } from "./hostRuntime";
import { hostNotice, YaosController } from "./pluginController";
import { defaultPluginData, type PairedIdentity, type YaosPluginData } from "./ui/api";

const ID: PairedIdentity = { host: "https://relay.example", vaultId: "v1", deviceId: "dev-A", deviceToken: "secret-token", deviceName: "A", vaultGeneration: null };

function setup(initial: YaosPluginData = defaultPluginData("A")) {
	const clock = new VirtualClock();
	const net = new SimNet(clock, { linkMs: 10 });
	const dev = new SimDevice({ name: "A", clock, net });
	const saved: YaosPluginData[] = [];
	const notices: string[] = [];
	const logs: string[] = [];
	const sinks: HostUiSink[] = [];
	const ctl = new YaosController(initial, {
		makeRuntime: (identity, settings, ui) => {
			sinks.push(ui);
			return dev.runtimeFor(identity, settings, ui);
		},
		saveData: async (d) => {
			saved.push(d);
		},
		notice: (level, m, timeoutMs) => notices.push(`${level}:${m}${timeoutMs ? `@${timeoutMs}` : ""}`),
		log: (l) => logs.push(l),
	});
	let changes = 0;
	ctl.onChange(() => changes++);
	return { clock, dev, ctl, saved, notices, logs, sinks, changes: () => changes };
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

test("hostNotice: settings-reload is surfaced with friendly text; other info stays in the status", () => {
	assert.deepEqual(hostNotice("info", "settings-reload", "app.json, hotkeys.json"), {
		text: "YAOS: synced settings changed (app.json, hotkeys.json). Reload Obsidian to apply them.",
		timeoutMs: 15_000,
	});
	assert.equal(hostNotice("info", "recovered-from-mirror", "recovered-from-mirror"), null);
	assert.deepEqual(hostNotice("warn", "daily-limit", "limit"), { text: "limit", timeoutMs: 20_000 });
	assert.deepEqual(hostNotice("error", "x", "boom"), { text: "boom" });
});

test("engine notices reach the env through hostNotice; a replaced runtime's notices are dropped", async () => {
	const { clock, ctl, notices, sinks } = setup({ ...defaultPluginData("A"), identity: ID });
	const s = ctl.start();
	await clock.advance(1_000);
	await s;
	const ui = sinks[0];
	assert.ok(ui);
	ui.onNotice("info", "settings-reload", "app.json");
	ui.onNotice("info", "something", "quiet");
	ui.onNotice("warn", "daily-limit", "limit reached");
	assert.deepEqual(notices, ["info:YAOS: synced settings changed (app.json). Reload Obsidian to apply them.@15000", "warn:limit reached@20000"]);
	const r = ctl.restartEngine();
	await clock.advance(5_000);
	await r;
	ui.onNotice("info", "settings-reload", "app.json");
	assert.equal(notices.length, 2, "stale runtime is ignored");
});
