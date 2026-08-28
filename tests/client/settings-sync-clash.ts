import {
	detectSettingsSyncClash,
	SETTINGS_SYNC_CLASH_COMMUNITY,
	SETTINGS_SYNC_CLASH_CORE,
} from "../../src/sync/settingsSync/clash";
import { suite } from "../harness.ts";

const s = suite("settings-sync-clash");

s.section("clash ids");
{
	s.check(SETTINGS_SYNC_CLASH_CORE[0] === "sync", "official Sync core id is sync");
	s.check(
		SETTINGS_SYNC_CLASH_COMMUNITY.slice().sort().join(",")
			=== ["obsidian-livesync", "remotely-save", "system3-relay"].sort().join(","),
		"community clash list is closed",
	);
}

s.section("enabled clashes");
{
	s.check(detectSettingsSyncClash({ coreEnabled: ["sync"], communityEnabled: [] }) === "sync", "core Sync clashes");
	s.check(
		detectSettingsSyncClash({ coreEnabled: [], communityEnabled: ["remotely-save"] }) === "remotely-save",
		"Remotely Save clashes",
	);
	s.check(
		detectSettingsSyncClash({ coreEnabled: [], communityEnabled: ["obsidian-livesync"] }) === "obsidian-livesync",
		"LiveSync clashes",
	);
	s.check(
		detectSettingsSyncClash({ coreEnabled: [], communityEnabled: ["system3-relay"] }) === "system3-relay",
		"system3 relay clashes",
	);
	s.check(
		detectSettingsSyncClash({ coreEnabled: ["sync"], communityEnabled: ["remotely-save"] }) === "sync",
		"core clash wins when both are enabled",
	);
	s.check(
		detectSettingsSyncClash({ coreEnabled: [], communityEnabled: ["obsidian-sync", "calendar"] }) === null,
		"made-up obsidian-sync community id does not clash",
	);
	s.check(
		detectSettingsSyncClash({ coreEnabled: ["file-explorer"], communityEnabled: ["dataview"] }) === null,
		"unrelated plugins do not clash",
	);
}

await s.done();
