import { SETTINGS_SYNC_SKIP_PLUGIN_IDS } from "./types";

export const SETTINGS_SYNC_ROOT_JSON = [
	"app.json",
	"appearance.json",
	"hotkeys.json",
	"graph.json",
	"daily-notes.json",
	"templates.json",
	"backlink.json",
	"page-preview.json",
	"note-composer.json",
	"switcher.json",
	"bookmarks.json",
	"workspaces.json",
	"core-plugins.json",
	"core-plugins-migration.json",
] as const;

export const SETTINGS_SYNC_KNOWN_UNSYNCED_ROOT_JSON = [
	"workspace.json",
	"workspace-mobile.json",
	"community-plugins.json",
	"file-recovery.json",
	"publish.json",
	"types.json",
] as const;

export function normalizeConfigRelPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function segmentsOk(segments: readonly string[]): boolean {
	return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Accept only the closed set of paths relative to the active config directory. */
export function isAllowlistedConfigPath(path: string): boolean {
	const normalized = normalizeConfigRelPath(path);
	if (!normalized || normalized.includes("\0")) return false;
	const segments = normalized.split("/");
	if (!segmentsOk(segments)) return false;

	if (segments.length === 1) {
		return (SETTINGS_SYNC_ROOT_JSON as readonly string[]).includes(normalized);
	}
	if (segments.length === 2 && segments[0] === "snippets") {
		const name = segments[1];
		return typeof name === "string" && name.endsWith(".css") && name.length > 4;
	}
	if (segments.length === 3 && segments[0] === "plugins" && segments[2] === "data.json") {
		const id = segments[1];
		return typeof id === "string"
			&& !(SETTINGS_SYNC_SKIP_PLUGIN_IDS as readonly string[]).includes(id);
	}
	return false;
}

export function isPluginDataRelPath(path: string): boolean {
	const segments = normalizeConfigRelPath(path).split("/");
	return segments.length === 3
		&& segments[0] === "plugins"
		&& segments[2] === "data.json"
		&& typeof segments[1] === "string"
		&& segments[1].length > 0
		&& segmentsOk(segments);
}

export function pluginIdFromDataPath(path: string): string | null {
	if (!isPluginDataRelPath(path)) return null;
	return normalizeConfigRelPath(path).split("/")[1] ?? null;
}

export function listUnknownRootJson(names: readonly string[]): string[] {
	const seen = new Set<string>();
	const unknown: string[] = [];
	for (const raw of names) {
		const name = normalizeConfigRelPath(raw);
		if (!name.endsWith(".json") || name.includes("/")) continue;
		if ((SETTINGS_SYNC_ROOT_JSON as readonly string[]).includes(name)) continue;
		if ((SETTINGS_SYNC_KNOWN_UNSYNCED_ROOT_JSON as readonly string[]).includes(name)) continue;
		if (seen.has(name)) continue;
		seen.add(name);
		unknown.push(name);
	}
	return unknown;
}
