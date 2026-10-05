export const SETTINGS_SYNC_CLASH_CORE = ["sync"] as const;

export const SETTINGS_SYNC_CLASH_COMMUNITY = [
	"remotely-save",
	"obsidian-livesync",
	"system3-relay",
] as const;

/** Return the first conflicting enabled plugin, preferring official Sync. */
export function detectSettingsSyncClash(input: {
	coreEnabled: readonly string[];
	communityEnabled: readonly string[];
}): string | null {
	const core = new Set(input.coreEnabled);
	for (const id of SETTINGS_SYNC_CLASH_CORE) {
		if (core.has(id)) return id;
	}
	const community = new Set(input.communityEnabled);
	for (const id of SETTINGS_SYNC_CLASH_COMMUNITY) {
		if (community.has(id)) return id;
	}
	return null;
}
