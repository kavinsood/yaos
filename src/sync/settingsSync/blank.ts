import { SETTINGS_SYNC_SKIP_PLUGIN_IDS } from "./types";

export type BlankConfigDirInput = {
	communityPluginIds?: readonly string[] | null;
	snippetFiles?: readonly string[] | null;
	hasHotkeys?: boolean;
	unsure?: boolean;
};

/** A config directory is blank only when every occupancy probe succeeds and finds no user state. */
export function isBlankConfigDir(input: BlankConfigDirInput): boolean {
	if (input.unsure) return false;
	const plugins = input.communityPluginIds;
	const snippets = input.snippetFiles;
	if (plugins == null || snippets == null) return false;
	for (const id of plugins) {
		if (!id) continue;
		if (!(SETTINGS_SYNC_SKIP_PLUGIN_IDS as readonly string[]).includes(id)) return false;
	}
	return snippets.length === 0 && !input.hasHotkeys;
}
