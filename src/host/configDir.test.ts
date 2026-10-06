import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeObsidianVault } from "../sim/fakeObsidian";
import { ObsidianConfigDir } from "./configDir";
import { ObsidianSideFiles } from "./sideFiles";

const enc = new TextEncoder();

test("config dir: config-relative paths, atomic replace, missing -> null", async () => {
	const fake = new FakeObsidianVault();
	const cfg = new ObsidianConfigDir(fake.adapter, ".obsidian");
	assert.equal(await cfg.readBytes("app.json"), null);
	await cfg.writeBytes("plugins/x/data.json", enc.encode("{}"));
	await cfg.writeBytes("plugins/x/data.json", enc.encode('{"a":1}'));
	assert.deepEqual(new TextDecoder().decode((await cfg.readBytes("plugins/x/data.json")) ?? new Uint8Array()), '{"a":1}');
	assert.equal(fake.raw.has(".obsidian/plugins/x/data.json.yaos-tmp"), false);
	await cfg.writeBytes("app.json", enc.encode("[]"));
	const top = await cfg.list("");
	assert.deepEqual(top.map((e) => `${e.path}:${e.isFolder}`).sort(), ["app.json:false", "plugins:true"]);
	const inner = await cfg.list("plugins/x");
	assert.deepEqual(inner.map((e) => e.path), ["plugins/x/data.json"]);
	await cfg.remove("app.json");
	assert.equal(await cfg.readBytes("app.json"), null);
	assert.deepEqual(await cfg.list("nope"), []);
});

test("side files live under <pluginDir>/state and list snapshots", async () => {
	const fake = new FakeObsidianVault();
	const side = new ObsidianSideFiles(fake.adapter, ".obsidian/plugins/yaos");
	assert.equal(await side.read("outbox-a.bin"), null);
	await side.write("outbox-a.bin", new Uint8Array([1, 2]));
	await side.write("snapshots/2026-01-01.snap", new Uint8Array([3]));
	assert.ok(fake.raw.has(".obsidian/plugins/yaos/state/outbox-a.bin"));
	assert.deepEqual([...((await side.read("outbox-a.bin")) ?? [])], [1, 2]);
	assert.deepEqual(await side.list("snapshots/"), ["snapshots/2026-01-01.snap"]);
	await side.remove("outbox-a.bin");
	assert.equal(await side.read("outbox-a.bin"), null);
});
