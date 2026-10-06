import { test } from "node:test";
import assert from "node:assert/strict";
import { utf8Encode } from "../../core/hash/utf8";
import { CFG_MAX_FILE_BYTES } from "../../core/limits";
import { FakeBlobs } from "../reconcile/testkit/fakes";
import { olderVersion } from "./cfgNotices";
import { Device, SharedCfgLog } from "./testkit";

const codes = (d: Device, code: string): string[] => d.warnings.filter((w) => w.code === code).map((w) => w.message);

test("olderVersion: dotted numeric compare, text fallback", () => {
	assert.equal(olderVersion("0.5.9", "0.5.10"), true);
	assert.equal(olderVersion("0.5.10", "0.5.9"), false);
	assert.equal(olderVersion("1.0", "1.0.0"), false);
	assert.equal(olderVersion("1.0.0", "1.0.1"), true);
	assert.equal(olderVersion("1.0.0-beta", "1.0.0-rc"), true);
});

test("skip notice: data.json version hold, one warn per distinct set, coalesced with a count", async () => {
	const log = new SharedCfgLog();
	const a = new Device("A", log);
	const b = new Device("B", log);
	a.plugin("dv", "1.0.0", { refresh: 5 });
	a.plugin("tasks", "2.0.0", { mode: "x" });
	await a.pass();
	b.plugin("dv", "0.9.0", { refresh: 1 });
	b.config.set("plugins/dv/manifest.json", { id: "dv", name: "Dataview", version: "0.9.0" });
	await b.pass();
	assert.deepEqual(codes(b, "settings-plugin-version"), [
		"YAOS settings sync is holding plugins/dv/data.json: written by Dataview 1.0.0, this device has 0.9.0. Update the plugin to receive these settings.",
	]);
	await b.pass();
	assert.equal(b.warnings.length, 1, "a steady hold is shown once");
	b.plugin("tasks", "1.0.0", { mode: "y" });
	await b.pass();
	assert.equal(codes(b, "settings-plugin-version")[1],
		"YAOS settings sync is holding 2 plugin settings files until the plugin versions match: Dataview (0.9.0 here, 1.0.0 elsewhere), tasks (1.0.0 here, 2.0.0 elsewhere). Update the plugins so every device runs the same version.");
	await b.pass();
	assert.equal(b.warnings.length, 2);
	// Updating dv applies it; the set shrinks: nothing new to say.
	b.config.set("plugins/dv/manifest.json", { id: "dv", name: "Dataview", version: "1.0.0" });
	await b.pass();
	assert.deepEqual(b.config.json("plugins/dv/data.json"), { refresh: 5 });
	b.plugin("tasks", "2.0.0");
	await b.pass();
	assert.equal(b.warnings.length, 2);
	// A newer device than the writer is told to update the others.
	const c = new Device("C", log);
	c.plugin("dv", "1.2.0");
	await c.pass();
	assert.deepEqual(codes(c, "settings-plugin-version"), [
		"YAOS settings sync is holding plugins/dv/data.json: written by dv 1.0.0, this device has 1.2.0. Update dv on your other devices to sync these settings.",
	]);
});

test("skip notice: enabled elsewhere but not installed here; data.json of an absent plugin is silent", async () => {
	const log = new SharedCfgLog();
	const a = new Device("A", log);
	a.plugin("dv", "1.0.0", { refresh: 5 });
	a.plugin("tasks", "3.0.0");
	a.config.set("community-plugins.json", ["dv", "tasks"]);
	await a.pass();
	const b = new Device("B", log);
	b.config.set("community-plugins.json", []);
	const r = await b.pass();
	assert.deepEqual(r.plan.skipped.map((s) => `${s.file}:${s.key}:${s.reason}`).sort(), [
		"community-plugins.json:dv:not-installed", "community-plugins.json:tasks:not-installed", "plugins/dv/data.json:null:plugin-absent",
	]);
	assert.deepEqual(b.warnings, [{
		code: "settings-plugin-missing",
		message: "YAOS settings sync: 2 plugins are enabled on your other devices but not installed here (dv, tasks); install them to use them here.",
	}]);
	await b.pass();
	assert.equal(b.warnings.length, 1);
	const c = new Device("C", log);
	c.plugin("dv", "1.0.0");
	await c.pass();
	assert.deepEqual(codes(c, "settings-plugin-missing"), [
		"YAOS settings sync: tasks is enabled on your other devices but not installed here; install it to use it here.",
	]);
});

test("skip notice: unparseable local JSON warns once per file", async () => {
	const log = new SharedCfgLog();
	const b = new Device("B", log);
	b.config.set("core-plugins.json", "{ not json");
	await b.pass();
	await b.pass();
	assert.deepEqual(codes(b, "settings-unparseable"), [
		"YAOS settings sync is skipping core-plugins.json: it is not valid JSON. Fix the file to sync it again.",
	]);
	b.config.set("hotkeys.json", "[");
	await b.pass();
	await b.pass();
	assert.deepEqual(codes(b, "settings-unparseable").slice(1), [
		"YAOS settings sync is skipping 2 settings files that are not valid JSON: core-plugins.json, hotkeys.json. Fix them to sync them again.",
	]);
	b.config.set("hotkeys.json", {});
	await b.pass();
	assert.equal(codes(b, "settings-unparseable").length, 2, "fixing one file says nothing");
	b.config.set("hotkeys.json", "[");
	await b.pass();
	assert.equal(codes(b, "settings-unparseable").length, 3, "broken again: warned again");
});

test("size cap: a file over CFG_MAX_FILE_BYTES is neither sent nor written, never deleted, and warns", async () => {
	const log = new SharedCfgLog();
	const blobs = new FakeBlobs();
	const a = new Device("A", log, blobs);
	const b = new Device("B", log, blobs);
	const huge = "x".repeat(CFG_MAX_FILE_BYTES + 1);
	a.config.set("snippets/huge.css", huge);
	a.config.set("snippets/ok.css", ".a{}");
	a.plugin("dv", "1.0.0");
	a.config.set("plugins/dv/data.json", huge);
	const r = await a.pass();
	assert.deepEqual(log.opsBy("A").map((o) => o.t === "filePut" && o.file), ["snippets/ok.css"]);
	assert.equal(a.config.readsOf("snippets/huge.css"), 0, "listed size over the cap: not read");
	assert.deepEqual(r.plan.skipped, [
		{ file: "plugins/dv/data.json", key: null, reason: "too-large" },
		{ file: "snippets/huge.css", key: null, reason: "too-large" },
	]);
	assert.deepEqual(codes(a, "settings-too-large"), [
		"YAOS settings sync skipped 2 settings files larger than 1 MB, the limit for one settings file: plugins/dv/data.json, snippets/huge.css.",
	]);
	// A synced file that grows past the cap is held, not deleted.
	a.config.set("snippets/ok.css", huge);
	await a.pass();
	assert.equal(log.opsBy("A").length, 1, "no fileDel for a held file");
	assert.ok(a.bases().includes("snippets/ok.css"));
	// Receive side: an oversized filePut or JSON projection is not written.
	log.apply("X", [
		{ t: "filePut", file: "snippets/remote.css", content: { t: "inline", bytes: utf8Encode(huge) }, pluginVersion: null },
		{ t: "jsonSet", file: "appearance.json", key: "cssTheme", valueJson: JSON.stringify(huge) },
	]);
	b.config.set("appearance.json", { theme: "obsidian" });
	const rb = await b.pass();
	assert.equal(b.config.text("snippets/remote.css"), null);
	assert.deepEqual(b.config.json("appearance.json"), { theme: "obsidian" });
	assert.deepEqual(rb.plan.skipped.filter((s) => s.reason === "too-large").map((s) => s.file), ["appearance.json", "snippets/remote.css"]);
	assert.equal(b.config.text("snippets/ok.css"), ".a{}", "files under the cap still arrive");
	assert.equal(codes(b, "settings-too-large").length, 1);
});

test("size cap: past CFG_MAX_TOTAL_BYTES files stop in path order, on send and on receive", async () => {
	const log = new SharedCfgLog();
	const blobs = new FakeBlobs();
	const a = new Device("A", log, blobs);
	const b = new Device("B", log, blobs);
	const body = ".a{}".repeat(225_000); // 900 KB
	for (const n of ["a", "b", "c", "d", "e"]) a.config.set(`snippets/${n}.css`, body);
	await a.pass();
	assert.deepEqual(log.opsBy("A").map((o) => o.t === "filePut" && o.file), ["snippets/a.css", "snippets/b.css", "snippets/c.css", "snippets/d.css"]);
	assert.deepEqual(codes(a, "settings-over-cap"), [
		"YAOS settings sync syncs at most 256 settings files and 4 MB in total; snippets/e.css is past that limit and is not synced. Remove settings files you do not need to sync the rest.",
	]);
	b.config.set("snippets/0.css", body);
	const rb = await b.pass();
	assert.deepEqual(rb.written, ["snippets/a.css", "snippets/b.css", "snippets/c.css"]);
	assert.equal(b.config.text("snippets/d.css"), null, "d would take B past the total: not written");
	assert.deepEqual(log.opsBy("B").map((o) => o.t === "filePut" && o.file), ["snippets/0.css"]);
	assert.equal(codes(b, "settings-over-cap").length, 1);
	// A gets 0.css; its own d now falls past the cap too: held (kept, not deleted), and A is told.
	const ra = await a.pass();
	assert.deepEqual(ra.written, ["snippets/0.css"]);
	assert.equal(a.config.text("snippets/d.css"), body);
	assert.equal(codes(a, "settings-over-cap")[1],
		"YAOS settings sync syncs at most 256 settings files and 4 MB in total; 2 files past that limit are not synced: snippets/d.css, snippets/e.css. Remove settings files you do not need to sync the rest.");
	assert.equal((await a.pass()).plan.actions.length + (await b.pass()).plan.actions.length, 0);
	assert.equal(a.warnings.length + b.warnings.length, 3);
});

test("size cap: past CFG_MAX_FILES files stop in path order", async () => {
	const log = new SharedCfgLog();
	const a = new Device("A", log);
	for (let i = 0; i < 300; i++) a.config.set(`snippets/s${String(i).padStart(3, "0")}.css`, `.s${i}{}`);
	const r = await a.pass();
	assert.equal(log.opsBy("A").length, 256);
	assert.equal(r.plan.skipped.filter((s) => s.reason === "over-cap").length, 44);
	assert.ok(!log.opsBy("A").some((o) => o.t === "filePut" && o.file === "snippets/s256.css"));
	assert.deepEqual(codes(a, "settings-over-cap"), [
		"YAOS settings sync syncs at most 256 settings files and 4 MB in total; 44 files past that limit are not synced: snippets/s256.css, snippets/s257.css, snippets/s258.css, snippets/s259.css, snippets/s260.css and 39 more. Remove settings files you do not need to sync the rest.",
	]);
});
