import { isBlankConfigDir } from "../../src/sync/settingsSync/blank";
import { suite } from "../harness.ts";

const s = suite("settings-sync-blank");

s.section("blank");
{
	s.check(isBlankConfigDir({ communityPluginIds: ["yaos"], snippetFiles: [] }), "YAOS only is blank");
	s.check(
		isBlankConfigDir({ communityPluginIds: ["yaos", "yaos-qa-harness"], snippetFiles: [] }),
		"YAOS plus QA harness is blank",
	);
	s.check(isBlankConfigDir({ communityPluginIds: [], snippetFiles: [] }), "no plugin or snippet state is blank");
}

s.section("occupied");
{
	s.check(
		!isBlankConfigDir({ communityPluginIds: ["yaos", "calendar"], snippetFiles: [] }),
		"extra community plugin occupies the config directory",
	);
	s.check(
		!isBlankConfigDir({ communityPluginIds: ["yaos"], snippetFiles: ["wide.css"] }),
		"snippet occupies the config directory",
	);
	s.check(
		!isBlankConfigDir({ communityPluginIds: ["yaos"], snippetFiles: [], hasHotkeys: true }),
		"hotkeys occupy the config directory",
	);
	s.check(
		!isBlankConfigDir({ communityPluginIds: ["yaos"], snippetFiles: [], unsure: true }),
		"uncertain probe is occupied",
	);
	s.check(!isBlankConfigDir({ communityPluginIds: null, snippetFiles: [] }), "missing plugin list is occupied");
	s.check(!isBlankConfigDir({ communityPluginIds: ["yaos"], snippetFiles: null }), "missing snippet list is occupied");
}

await s.done();
