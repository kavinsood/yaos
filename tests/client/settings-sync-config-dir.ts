import { sanitizeConfigDirKey } from "../../src/sync/settingsSync/configDirKey";
import { suite } from "../harness.ts";

const s = suite("settings-sync-config-dir");

s.section("accepted keys");
{
	s.check(sanitizeConfigDirKey(".obsidian") === ".obsidian", "default config key is accepted");
	s.check(sanitizeConfigDirKey(".obsidian-mobile") === ".obsidian-mobile", "mobile key is accepted");
	s.check(sanitizeConfigDirKey("MobileConfig") === "MobileConfig", "leading dot is not required");
	s.check(sanitizeConfigDirKey(".obsidian-b") === ".obsidian-b", "named environment is accepted");
	const max = "k".repeat(64);
	s.check(sanitizeConfigDirKey(max) === max, "64-character key is accepted");
}

s.section("rejected keys");
{
	s.check(sanitizeConfigDirKey("") === null, "empty is rejected");
	s.check(sanitizeConfigDirKey(".") === null, "dot is rejected");
	s.check(sanitizeConfigDirKey("..") === null, "dotdot is rejected");
	s.check(sanitizeConfigDirKey("foo/bar") === null, "embedded slash is rejected");
	s.check(sanitizeConfigDirKey("foo\\bar") === null, "embedded backslash is rejected");
	s.check(sanitizeConfigDirKey("../../etc") === null, "traversal is rejected rather than basenamed");
	s.check(sanitizeConfigDirKey("bad\0name") === null, "NUL is rejected");
	s.check(sanitizeConfigDirKey("k".repeat(65)) === null, "65-character key is rejected");
}

await s.done();
