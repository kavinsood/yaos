import { test } from "node:test";
import assert from "node:assert/strict";
import { utf8Encode } from "../../core/hash/utf8";
import { FakeBlobs } from "../reconcile/testkit/fakes";
import { CFG_INLINE_MAX_BYTES, CFG_JSON_FILES, classifyConfigPath } from "./allowlist";
import { Device, SharedCfgLog } from "./testkit";

test("allowlist: closed set; yaos dir, workspace layout, plugin code and caches never synced", () => {
	const synced = [
		"app.json", "appearance.json", "hotkeys.json", "core-plugins.json", "core-plugins-migration.json", "graph.json",
		"daily-notes.json", "templates.json", "backlink.json", "page-preview.json", "note-composer.json", "switcher.json",
		"bookmarks.json", "workspaces.json", "community-plugins.json", "snippets/a.css", "themes/Min/theme.css",
		"themes/Min/manifest.json", "plugins/dv/data.json",
	];
	for (const p of synced) assert.ok(classifyConfigPath(p), p);
	assert.deepEqual([...CFG_JSON_FILES].sort(), synced.filter((p) => !p.includes("/") && p !== "community-plugins.json").sort(),
		"root JSON set = legacy SETTINGS_SYNC_ROOT_JSON");
	const never = [
		"workspace.json", "workspace-mobile.json", "file-recovery.json", "publish.json", "types.json",
		"plugins/yaos/data.json", "plugins/yaos/manifest.json", "plugins/yaos/main.js", "plugins/yaos/state/outbox-a.bin",
		"plugins/yaos-qa-harness/data.json", "plugins/dv/main.js", "plugins/dv/styles.css", "plugins/dv/manifest.json",
		"cache/x", "unknown.json", "snippets/.css", "snippets/a/b.css", "themes/Min/x.css", "../app.json",
		"plugins/../data.json", "",
	];
	for (const p of never) assert.equal(classifyConfigPath(p), null, p);
});

test("restored root JSON: graph, bookmarks, saved workspaces sync; workspaces.json `active` stays device-local", async () => {
	const log = new SharedCfgLog();
	const a = new Device("A", log);
	const b = new Device("B", log);
	a.config.set("graph.json", { showTags: true, scale: 1.5 });
	a.config.set("bookmarks.json", { items: [{ type: "file", path: "Inbox.md" }] });
	a.config.set("workspaces.json", { workspaces: { Writing: { main: {} } }, active: "Writing" });
	a.config.set("workspace.json", { main: { id: "a-layout" } });
	a.config.set("workspace-mobile.json", { main: { id: "a-mobile" } });
	await a.pass();
	assert.ok(log.opsBy("A").every((o) => "file" in o && !o.file.startsWith("workspace.") && !o.file.startsWith("workspace-")));
	assert.ok(!log.opsBy("A").some((o) => o.t === "jsonSet" && o.file === "workspaces.json" && o.key === "active"));
	b.config.set("workspaces.json", { workspaces: {}, active: "Mobile" });
	b.config.set("workspace.json", { main: { id: "b-layout" } });
	await b.pass();
	assert.deepEqual(b.config.json("graph.json"), { scale: 1.5, showTags: true });
	assert.deepEqual(b.config.json("bookmarks.json"), { items: [{ type: "file", path: "Inbox.md" }] });
	assert.deepEqual(b.config.json("workspaces.json"), { workspaces: { Writing: { main: {} } }, active: "Mobile" });
	assert.deepEqual(b.config.json("workspace.json"), { main: { id: "b-layout" } }, "workspace.json never written");
	assert.equal(b.config.text("workspace-mobile.json"), null);
	assert.ok(b.notices.includes("settings-reload"));
	// A bookmark added on B reaches A.
	b.config.set("bookmarks.json", { items: [{ type: "file", path: "Inbox.md" }, { type: "search", query: "tag:#todo" }] });
	await b.pass();
	await a.pass();
	assert.deepEqual(a.config.json("bookmarks.json"), { items: [{ type: "file", path: "Inbox.md" }, { type: "search", query: "tag:#todo" }] });
	assert.equal((a.config.json("workspaces.json") as { active: string }).active, "Writing");
	assert.equal((await a.pass()).plan.actions.length + (await b.pass()).plan.actions.length, 0);
});

test("initial upload: per-key jsonSet, device-local keys never emitted, next pass is quiet", async () => {
	const log = new SharedCfgLog();
	const a = new Device("A", log);
	a.config.set("app.json", { vimMode: true, tabSize: 4 });
	a.config.set("appearance.json", { theme: "obsidian", nativeMenus: true });
	a.config.set("workspace.json", { main: {} });
	a.config.set("snippets/wide.css", ".x{}");
	const r = await a.pass();
	assert.deepEqual(log.opsBy("A").map((o) => o.t === "jsonSet" ? `${o.file}:${o.key}=${o.valueJson}` : `${o.t}:${"file" in o ? o.file : ""}`), [
		"app.json:tabSize=4", "app.json:vimMode=true", "appearance.json:theme=\"obsidian\"", "filePut:snippets/wide.css",
	]);
	assert.equal(r.written.length, 0);
	assert.deepEqual(a.bases(), ["app.json", "appearance.json", "snippets/wide.css"]);
	const again = await a.pass();
	assert.equal(again.emitted, 0);
	assert.equal(again.plan.actions.length, 0);
});

test("first contact adopts the vault; local-only keys are emitted; device-local keys kept", async () => {
	const log = new SharedCfgLog();
	const a = new Device("A", log);
	const b = new Device("B", log);
	a.config.set("appearance.json", { theme: "obsidian", nativeMenus: true, accentColor: "#f00" });
	await a.pass();
	b.config.set("appearance.json", { theme: "moonstone", nativeMenus: false, baseFontSize: 18 });
	await b.pass();
	assert.deepEqual(b.config.json("appearance.json"), { theme: "obsidian", nativeMenus: false, baseFontSize: 18, accentColor: "#f00" });
	assert.ok(b.notices.includes("settings-reload"));
	assert.deepEqual(log.opsBy("B"), [{ t: "jsonSet", file: "appearance.json", key: "baseFontSize", valueJson: "18" }]);
	await a.pass();
	assert.deepEqual(a.config.json("appearance.json"), { theme: "obsidian", nativeMenus: true, accentColor: "#f00", baseFontSize: 18 });
	assert.equal((await a.pass()).plan.actions.length + (await b.pass()).plan.actions.length, 0);
});

test("remote change written when local unchanged; concurrent edit: local op goes first and the later seq wins", async () => {
	const log = new SharedCfgLog();
	const a = new Device("A", log);
	const b = new Device("B", log);
	a.config.set("app.json", { tabSize: 4, foldHeading: true });
	await a.pass();
	await b.pass();
	assert.deepEqual(b.config.json("app.json"), { foldHeading: true, tabSize: 4 });
	// A changes tabSize, B (not yet synced) changes tabSize too and deletes foldHeading.
	a.config.set("app.json", { tabSize: 2, foldHeading: true });
	await a.pass();
	b.config.set("app.json", { tabSize: 8 });
	const writesBefore = b.config.writes;
	await b.pass();
	assert.equal(b.config.writes, writesBefore, "B's own edit is not overwritten");
	assert.deepEqual(log.opsBy("B").slice(-2), [
		{ t: "jsonDel", file: "app.json", key: "foldHeading" },
		{ t: "jsonSet", file: "app.json", key: "tabSize", valueJson: "8" },
	]);
	await a.pass();
	assert.deepEqual(a.config.json("app.json"), { tabSize: 8 });
	assert.equal((await a.pass()).emitted + (await b.pass()).emitted, 0);
});

test("gate: registers naming the yaos dir or yaos itself are never projected", async () => {
	const log = new SharedCfgLog();
	const b = new Device("B", log);
	b.plugin("yaos", "2.1.0", { secret: "local" });
	b.config.set("community-plugins.json", ["yaos"]);
	await b.pass();
	assert.equal(log.opsBy("B").length, 0, "nothing of yaos is emitted");
	// A rogue/old device wrote yaos registers.
	log.apply("X", [
		{ t: "filePut", file: "plugins/yaos/data.json", content: { t: "inline", bytes: utf8Encode("{\"secret\":\"remote\"}") }, pluginVersion: "2.1.0" },
		{ t: "pluginSet", pluginId: "yaos", enabled: false },
		{ t: "filePut", file: "workspace.json", content: { t: "inline", bytes: utf8Encode("{}") }, pluginVersion: null },
	]);
	const r = await b.pass();
	assert.equal(r.written.length, 0);
	assert.deepEqual(b.config.json("plugins/yaos/data.json"), { secret: "local" });
	assert.deepEqual(b.config.json("community-plugins.json"), ["yaos"]);
	assert.equal(b.config.text("workspace.json"), null);
});

test("gate: data.json applied only on an equal installed manifest version", async () => {
	const log = new SharedCfgLog();
	const a = new Device("A", log);
	const b = new Device("B", log);
	a.plugin("dv", "1.0.0", { refresh: 5 });
	await a.pass();
	assert.deepEqual(log.opsBy("A").map((o) => o.t === "filePut" ? [o.file, o.pluginVersion] : o.t), [["plugins/dv/data.json", "1.0.0"]]);
	b.plugin("dv", "0.9.0", { refresh: 1 });
	const r = await b.pass();
	assert.deepEqual(r.plan.skipped.map((s) => s.reason), ["plugin-version"]);
	assert.deepEqual(b.config.json("plugins/dv/data.json"), { refresh: 1 });
	assert.equal(log.opsBy("B").length, 0, "older version does not push over the vault");
	b.plugin("dv", null);
	assert.deepEqual((await b.pass()).plan.skipped.map((s) => s.reason), ["plugin-version"]);
	b.plugin("dv", "1.0.0");
	await b.pass();
	assert.deepEqual(b.config.json("plugins/dv/data.json"), { refresh: 5 });
	// Not installed at all: nothing read, nothing written.
	const c = new Device("C", log);
	await c.pass();
	assert.equal(c.config.text("plugins/dv/data.json"), null);
	// Local delete of data.json is never propagated.
	a.config.files.delete("plugins/dv/data.json");
	await a.pass();
	assert.equal(log.opsBy("A").length, 1);
	await b.pass();
	assert.deepEqual(b.config.json("plugins/dv/data.json"), { refresh: 5 });
});

test("plugins: enablement projected only for installed plugins; disable propagates", async () => {
	const log = new SharedCfgLog();
	const a = new Device("A", log);
	const b = new Device("B", log);
	a.plugin("dv", "1.0.0");
	a.plugin("tasks", "3.0.0");
	a.config.set("community-plugins.json", ["dv", "tasks"]);
	await a.pass();
	b.plugin("dv", "1.0.0");
	b.plugin("yaos", "2.1.0");
	b.config.set("community-plugins.json", ["yaos"]);
	const r = await b.pass();
	assert.deepEqual(b.config.json("community-plugins.json"), ["yaos", "dv"]);
	assert.deepEqual(r.plan.skipped, [{ file: "community-plugins.json", key: "tasks", reason: "not-installed" }]);
	assert.equal(log.opsBy("B").length, 0);
	b.plugin("tasks", "3.0.0");
	await b.pass();
	assert.deepEqual(b.config.json("community-plugins.json"), ["yaos", "dv", "tasks"]);
	a.config.set("community-plugins.json", ["tasks"]);
	await a.pass();
	assert.deepEqual(log.opsBy("A").at(-1), { t: "pluginSet", pluginId: "dv", enabled: false });
	await b.pass();
	assert.deepEqual(b.config.json("community-plugins.json"), ["yaos", "tasks"]);
});

test("files: large/binary snippets go as blob refs; failed upload defers; fileDel removes; no reload for snippets", async () => {
	const log = new SharedCfgLog();
	const blobs = new FakeBlobs();
	const a = new Device("A", log, blobs);
	const b = new Device("B", log, blobs);
	const big = ".a{}".repeat(CFG_INLINE_MAX_BYTES / 4 + 1);
	a.config.set("snippets/big.css", big);
	blobs.uploadOk = false;
	const r1 = await a.pass();
	assert.deepEqual(r1.deferred, ["snippets/big.css"]);
	assert.equal(log.opsBy("A").length, 0);
	assert.deepEqual(a.bases(), []);
	blobs.uploadOk = true;
	await a.pass();
	const put = log.opsBy("A")[0]!;
	assert.ok(put.t === "filePut" && put.content.t === "blob");
	blobs.available = false;
	assert.deepEqual((await b.pass()).deferred, ["snippets/big.css"]);
	blobs.available = true;
	await b.pass();
	assert.equal(b.config.text("snippets/big.css"), big);
	assert.ok(!b.notices.includes("settings-reload"));
	a.config.files.delete("snippets/big.css");
	await a.pass();
	assert.deepEqual(log.opsBy("A").at(-1), { t: "fileDel", file: "snippets/big.css" });
	await b.pass();
	assert.equal(b.config.text("snippets/big.css"), null);
	assert.deepEqual(b.bases(), []);
});

test("a file changed between snapshot and write is not clobbered; unparseable JSON is left alone", async () => {
	const log = new SharedCfgLog();
	const a = new Device("A", log);
	const b = new Device("B", log);
	a.config.set("hotkeys.json", { "editor:save": [{ key: "S" }] });
	await a.pass();
	b.config.set("hotkeys.json", {});
	await b.pass();
	a.config.set("hotkeys.json", { "editor:save": [{ key: "W" }] });
	await a.pass();
	b.config.onRead = { path: "hotkeys.json", atRead: 2, bytes: utf8Encode(JSON.stringify({ "editor:save": [{ key: "S" }], x: 1 })) };
	const r = await b.pass();
	assert.deepEqual(r.deferred, ["hotkeys.json"]);
	assert.deepEqual(b.config.json("hotkeys.json"), { "editor:save": [{ key: "S" }], x: 1 });
	b.config.onRead = null;
	await b.pass();
	assert.deepEqual(b.config.json("hotkeys.json"), { "editor:save": [{ key: "W" }], x: 1 });
	b.config.set("core-plugins.json", "{ not json");
	const r2 = await b.pass();
	assert.deepEqual(r2.plan.skipped, [{ file: "core-plugins.json", key: null, reason: "unparseable" }]);
	assert.equal(b.config.text("core-plugins.json"), "{ not json");
});
