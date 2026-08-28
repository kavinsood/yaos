import {
	isAllowlistedConfigPath,
	listUnknownRootJson,
} from "../../src/sync/settingsSync/allowlist";
import { suite } from "../harness.ts";

const s = suite("settings-sync-allowlist");

s.section("root JSON allowlist");
{
	s.check(isAllowlistedConfigPath("app.json"), "app.json is allowlisted");
	s.check(isAllowlistedConfigPath("appearance.json"), "appearance.json is allowlisted");
	s.check(isAllowlistedConfigPath("hotkeys.json"), "hotkeys.json is allowlisted");
	s.check(isAllowlistedConfigPath("workspaces.json"), "named workspaces are allowlisted");
	s.check(isAllowlistedConfigPath("core-plugins.json"), "core-plugins.json is allowlisted");
	s.check(isAllowlistedConfigPath("bookmarks.json"), "bookmarks.json is allowlisted");
	s.check(!isAllowlistedConfigPath("workspace.json"), "workspace.json is never allowlisted");
	s.check(!isAllowlistedConfigPath("workspace-mobile.json"), "mobile workspace state is never allowlisted");
	s.check(!isAllowlistedConfigPath("community-plugins.json"), "community plugin projection is local");
	s.check(!isAllowlistedConfigPath("canvas-settings.json"), "unknown root JSON is closed out");
}

s.section("snippets and plugin data");
{
	s.check(isAllowlistedConfigPath("snippets/wide.css"), "CSS snippet is allowlisted");
	s.check(!isAllowlistedConfigPath("snippets/../wide.css"), "snippet traversal is rejected");
	s.check(!isAllowlistedConfigPath("snippets/foo.js"), "non-CSS snippet is rejected");
	s.check(isAllowlistedConfigPath("plugins/dataview/data.json"), "community plugin data is allowlisted");
	s.check(!isAllowlistedConfigPath("plugins/yaos/data.json"), "YAOS data is never synced");
	s.check(!isAllowlistedConfigPath("plugins/yaos-qa-harness/data.json"), "QA harness data is never synced");
	s.check(!isAllowlistedConfigPath("plugins/dataview/main.js"), "plugin binaries are not allowlisted");
}

s.section("unknown root JSON once per name");
{
	const unknown = listUnknownRootJson([
		"workspace.json",
		"workspace-mobile.json",
		"community-plugins.json",
		"canvas-settings.json",
		"canvas-settings.json",
		"app.json",
		"file-recovery.json",
	]);
	s.check(unknown.includes("canvas-settings.json"), "future root JSON is reported as unknown");
	s.check(unknown.filter((name) => name === "canvas-settings.json").length === 1, "unknown name is listed once");
	s.check(!unknown.includes("workspace.json"), "workspace state is known-unsynced");
	s.check(!unknown.includes("app.json"), "allowlisted file is not unknown");
	s.check(!unknown.includes("community-plugins.json"), "community projection is known-unsynced");
}

await s.done();
