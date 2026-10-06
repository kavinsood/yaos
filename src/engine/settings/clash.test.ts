import { test } from "node:test";
import assert from "node:assert/strict";
import { utf8Encode } from "../../core/hash/utf8";
import { clashMessage, detectCfgClash } from "./clash";
import { Device, SharedCfgLog } from "./testkit";

const j = (v: unknown): Uint8Array => utf8Encode(JSON.stringify(v));

test("detectCfgClash: Obsidian Sync in either core-plugins.json form", () => {
	assert.deepEqual(detectCfgClash(j({ sync: true, graph: true }), null), { id: "sync", name: "Obsidian Sync", core: true });
	assert.deepEqual(detectCfgClash(j(["graph", "sync"]), null), { id: "sync", name: "Obsidian Sync", core: true });
	assert.equal(detectCfgClash(j({ sync: false, graph: true }), null), null);
	assert.equal(detectCfgClash(j({ sync: "yes" }), null), null);
});

test("detectCfgClash: known community sync plugins; Obsidian Sync wins", () => {
	assert.deepEqual(detectCfgClash(null, j(["dataview", "remotely-save"])), { id: "remotely-save", name: "Remotely Save", core: false });
	assert.deepEqual(detectCfgClash(j({}), j(["obsidian-livesync"])), { id: "obsidian-livesync", name: "Self-hosted LiveSync", core: false });
	assert.deepEqual(detectCfgClash(j({}), j(["system3-relay"])), { id: "system3-relay", name: "Relay", core: false });
	assert.equal(detectCfgClash(j({ sync: true }), j(["remotely-save"]))?.id, "sync");
	assert.equal(detectCfgClash(null, j(["dataview"])), null);
});

test("detectCfgClash: missing or unparseable files are no clash", () => {
	assert.equal(detectCfgClash(null, null), null);
	assert.equal(detectCfgClash(utf8Encode("{ sync"), utf8Encode("[")), null);
	assert.equal(detectCfgClash(j(null), j({ "remotely-save": true })), null);
	assert.equal(detectCfgClash(new Uint8Array([0xff, 0xfe]), null), null);
});

test("clashMessage names the clashing mechanism", () => {
	assert.equal(clashMessage({ id: "sync", name: "Obsidian Sync", core: true }),
		"YAOS settings sync is paused because Obsidian Sync is enabled for this vault. Turn one of them off. Note sync is not affected.");
	assert.equal(clashMessage({ id: "remotely-save", name: "Remotely Save", core: false }),
		"YAOS settings sync is paused because the Remotely Save plugin is enabled. Turn one of them off. Note sync is not affected.");
});

test("cfgSync: paused while Obsidian Sync is enabled, one warn, resumes on its own", async () => {
	const log = new SharedCfgLog();
	const a = new Device("A", log);
	const b = new Device("B", log);
	a.config.set("app.json", { vimMode: true });
	await a.pass();
	b.config.set("core-plugins.json", { sync: true, graph: true });
	b.config.set("hotkeys.json", { x: [] });
	const r = await b.pass();
	assert.equal(r.paused, "sync");
	assert.deepEqual([r.plan.actions.length, r.emitted, r.written.length], [0, 0, 0]);
	assert.equal(b.config.text("app.json"), null, "nothing applied");
	assert.equal(log.opsBy("B").length, 0, "nothing emitted");
	assert.deepEqual(b.bases(), []);
	assert.deepEqual(b.warnings, [{
		code: "settings-clash",
		message: "YAOS settings sync is paused because Obsidian Sync is enabled for this vault. Turn one of them off. Note sync is not affected.",
	}]);
	assert.equal((await b.pass()).paused, "sync");
	assert.equal(b.warnings.length, 1, "a steady clash is shown once");
	b.config.set("core-plugins.json", { sync: false, graph: true });
	const resumed = await b.pass();
	assert.equal(resumed.paused, null);
	assert.deepEqual(b.config.json("app.json"), { vimMode: true });
	assert.ok(log.opsBy("B").some((o) => o.t === "jsonSet" && o.file === "hotkeys.json"));
	// Another clash later is shown again.
	b.config.set("community-plugins.json", ["remotely-save"]);
	b.plugin("remotely-save", "1.0.0");
	const again = await b.pass();
	assert.equal(again.paused, "remotely-save");
	assert.equal(again.emitted, 0);
	assert.equal(b.warnings[1]?.message,
		"YAOS settings sync is paused because the Remotely Save plugin is enabled. Turn one of them off. Note sync is not affected.");
	assert.equal(b.warnings.length, 2);
});
