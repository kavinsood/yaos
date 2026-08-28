export const SETTINGS_SYNC_FORMAT_VERSION = 1;
export const SETTINGS_SYNC_MAX_FILE_BYTES = 1_000_000;
export const SETTINGS_SYNC_MAX_AGGREGATE_BODY_BYTES = 4_000_000;
export const SETTINGS_SYNC_MAX_SNAPSHOT_REQUEST_BYTES = 6_000_000;
export const SETTINGS_SYNC_MAX_ITEM_REQUEST_BYTES = 1_500_000;
export const SETTINGS_SYNC_MAX_RESPONSE_BYTES = 6_000_000;
export const SETTINGS_SYNC_MAX_FILES = 256;
export const SETTINGS_SYNC_MAX_INTENTS = 256;
export const SETTINGS_SYNC_MAX_THEMES = 64;
export const SETTINGS_SYNC_MAX_PLUGIN_DATA = 256;
export const SETTINGS_SYNC_MAX_TOMBSTONES = 512;
export const SETTINGS_SYNC_MAX_CONFIG_KEY_LENGTH = 64;
export const SETTINGS_SYNC_MAX_PATH_LENGTH = 256;
export const SETTINGS_SYNC_MAX_ID_LENGTH = 128;
export const SETTINGS_SYNC_MAX_REPO_LENGTH = 256;
export const SETTINGS_SYNC_MAX_VERSION_LENGTH = 64;
export const SETTINGS_SYNC_SKIP_PLUGIN_IDS = ["yaos", "yaos-qa-harness"] as const;

export type SettingsSyncFile = {
	path: string;
	sha256: string;
	size: number;
	rev: number;
	bodyBase64: string;
};

export type SettingsSyncIntent = {
	id: string;
	repo: string;
	version: string;
	enabled: boolean;
	rev: number;
};

export type SettingsSyncTheme = {
	name: string;
	repo: string;
	version: string;
	rev: number;
};

export type SettingsSyncTombstone = {
	kind: "plugin" | "theme";
	id: string;
	rev: number;
	deletedAt: number;
};

export type SettingsSyncPluginData = {
	pluginId: string;
	pluginVersion: string;
	sha256: string;
	size: number;
	rev: number;
	bodyBase64: string;
};

export type SettingsSyncUnseeded = { seeded: false };

export type SettingsSyncSeeded = {
	seeded: true;
	envRev: number;
	files: SettingsSyncFile[];
	intents: SettingsSyncIntent[];
	themes: SettingsSyncTheme[];
	tombstones: SettingsSyncTombstone[];
	pluginData: SettingsSyncPluginData[];
};

export type SettingsSyncState = SettingsSyncUnseeded | SettingsSyncSeeded;

export type SettingsSyncSnapshot = {
	files: Array<{ path: string; sha256: string; bodyBase64: string }>;
	intents: Array<{ id: string; repo: string; version: string; enabled: boolean }>;
	themes: Array<{ name: string; repo: string; version: string }>;
	pluginData: Array<{
		pluginId: string;
		pluginVersion: string;
		sha256: string;
		bodyBase64: string;
	}>;
};

export type SettingsSyncFilePut = { path: string; sha256: string; bodyBase64: string };
export type SettingsSyncIntentPut = { id: string; repo: string; version: string; enabled: boolean };
export type SettingsSyncTombstonePut = { kind: "plugin" | "theme"; id: string };
export type SettingsSyncPluginDataPut = {
	pluginId: string;
	pluginVersion: string;
	sha256: string;
	bodyBase64: string;
};

export type SettingsVersionMismatch = {
	pluginId: string;
	localVersion: string;
	pin: string;
	localAhead: boolean;
};
export type SettingsSyncEnvironmentPlugin = {
	readonly id: string;
	readonly version: string;
	readonly enabled: boolean;
};

export type SettingsSyncEnvironmentTheme = {
	readonly name: string;
	readonly version: string;
};


export type SettingsSyncSeedKind = "blank" | "occupied";
export type SettingsSyncReason =
	| "ok"
	| "unsupported"
	| "decision-required"
	| "master-off"
	| "invalid-key"
	| "clash"
	| "deferred"
	| "unseeded"
	| "stopped"
	| "error";

export type SettingsSyncStatus = {
	running: boolean;
	reason: SettingsSyncReason;
	configKey: string | null;
	clashId: string | null;
	seeded: boolean | null;
	deferred: boolean;
	seedKind: SettingsSyncSeedKind | null;
	needsSeed: boolean;
	readonly unknownFiles: readonly string[];
	readonly versionMismatches: readonly SettingsVersionMismatch[];
	readonly pendingApplySteps: number;
	readonly pendingApplyTotal: number;
	readonly environmentPlugins: readonly SettingsSyncEnvironmentPlugin[];
	readonly environmentThemes: readonly SettingsSyncEnvironmentTheme[];
	needsRestart: boolean;
	headline: string | null;
	error: string | null;
};

export function emptySettingsSyncStatus(): SettingsSyncStatus {
	return {
		running: false,
		reason: "stopped",
		configKey: null,
		clashId: null,
		seeded: null,
		deferred: false,
		seedKind: null,
		needsSeed: false,
		unknownFiles: [],
		versionMismatches: [],
		pendingApplySteps: 0,
		pendingApplyTotal: 0,
		environmentPlugins: [],
		environmentThemes: [],
		needsRestart: false,
		headline: null,
		error: null,
	};
}
