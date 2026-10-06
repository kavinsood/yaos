import { test } from "node:test";
import assert from "node:assert/strict";
import type { CfgOp } from "../../core/types";
import { Device, SharedCfgLog } from "./testkit";

const describe = (o: CfgOp): string => `${o.t} ${"file" in o ? o.file : o.pluginId}${"key" in o ? `#${o.key}` : ""}`;

/** The vault (written by A) and a device B that has its own settings before turning settings sync on. */
async function vaultAndNewcomer(seed: "device" | "vault" | undefined): Promise<{ log: SharedCfgLog; a: Device; b: Device }> {
	const log = new SharedCfgLog();
	const a = new Device("A", log);
	a.config.set("app.json", { vimMode: true, tabSize: 4 });
	a.config.set("snippets/look.css", ".a{}");
	a.config.set("snippets/extra.css", ".x{}");
	a.plugin("dv", "1.0.0", { refresh: 5 });
	a.plugin("tasks", "1.0.0");
	a.config.set("community-plugins.json", ["dv"]);
	await a.pass();
	const b = new Device("B", log);
	b.seed = seed;
	b.config.set("app.json", { vimMode: false, spellcheck: true });
	b.config.set("snippets/look.css", ".b{}");
	b.plugin("dv", "1.0.0", { refresh: 1 });
	b.plugin("tasks", "1.0.0");
	b.config.set("community-plugins.json", ["tasks"]);
	return { log, a, b };
}

test("seed vault (default): with no base yet, the vault's settings win on this device", async () => {
	for (const seed of [undefined, "vault"] as const) {
		const { log, b } = await vaultAndNewcomer(seed);
		await b.pass();
		assert.deepEqual(b.config.json("app.json"), { vimMode: true, spellcheck: true, tabSize: 4 });
		assert.equal(b.config.text("snippets/look.css"), ".a{}");
		assert.deepEqual(b.config.json("plugins/dv/data.json"), { refresh: 5 });
		assert.deepEqual(b.config.json("community-plugins.json"), ["tasks", "dv"], "tasks has no register: the vault has no say");
		assert.deepEqual(log.opsBy("B").map(describe).sort(), ["jsonSet app.json#spellcheck", "pluginSet tasks"]);
	}
});

test("seed device: this device's values win on the first pass; what only the vault has is still taken", async () => {
	const { log, a, b } = await vaultAndNewcomer("device");
	await b.pass();
	assert.deepEqual(b.config.json("app.json"), { vimMode: false, spellcheck: true, tabSize: 4 });
	assert.equal(b.config.text("snippets/look.css"), ".b{}");
	assert.equal(b.config.text("snippets/extra.css"), ".x{}");
	assert.deepEqual(b.config.json("plugins/dv/data.json"), { refresh: 1 });
	assert.deepEqual(b.config.json("community-plugins.json"), ["tasks", "dv"]);
	assert.deepEqual(log.opsBy("B").map(describe).sort(), [
		"filePut plugins/dv/data.json", "filePut snippets/look.css", "jsonSet app.json#spellcheck", "jsonSet app.json#vimMode", "pluginSet tasks",
	]);
	// The other devices take this device's settings.
	await a.pass();
	assert.deepEqual(a.config.json("app.json"), { vimMode: false, tabSize: 4, spellcheck: true });
	assert.equal(a.config.text("snippets/look.css"), ".b{}");
	assert.deepEqual(a.config.json("plugins/dv/data.json"), { refresh: 1 });
	assert.deepEqual(a.config.json("community-plugins.json"), ["dv", "tasks"]);
});

test("seed device applies only while cfgBase is empty: later first contacts take the vault's value", async () => {
	const { a, b } = await vaultAndNewcomer("device");
	await b.pass();
	a.config.set("hotkeys.json", { "editor:save": [] });
	await a.pass();
	b.config.set("hotkeys.json", { "editor:save": [{ key: "S" }] });
	await b.pass();
	assert.deepEqual(b.config.json("hotkeys.json"), { "editor:save": [] });
});
