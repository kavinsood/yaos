import {
	emptySettingsSyncStatus,
	type SettingsSyncSeedKind,
	type SettingsSyncStatus,
	type SettingsVersionMismatch,
} from "./types";

export {
	emptySettingsSyncStatus,
	type SettingsSyncSeedKind,
	type SettingsSyncStatus,
	type SettingsVersionMismatch,
};

export class UnknownRootJsonLog {
	private readonly seen = new Set<string>();

	note(names: readonly string[], debug: boolean): string[] {
		for (const name of names) {
			if (this.seen.has(name)) continue;
			this.seen.add(name);
			if (debug) console.debug("settings.unknown_file_ignored", name);
		}
		return [...this.seen];
	}

	list(): string[] {
		return [...this.seen];
	}
}

export function withStatusPatch(
	current: SettingsSyncStatus,
	patch: Partial<SettingsSyncStatus>,
): SettingsSyncStatus {
	return { ...current, ...patch };
}
