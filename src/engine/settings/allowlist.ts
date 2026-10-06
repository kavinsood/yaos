/**
 * Settings-sync allowlist (DESIGN §j.3). Ported from legacy
 * settingsSync/{allowlist, dataJsonGate, configDirKey}; the root JSON set is
 * the legacy one. Everything here is pure.
 *
 * Classes:
 *   json        CFG_JSON_FILES (core settings files, legacy parity)        (jsonSet/jsonDel per top-level key)
 *   plugins     community-plugins.json                                     (pluginSet per plugin id)
 *   pluginData  plugins/<id>/data.json                                     (filePut + pluginVersion gate)
 *   file        snippets/<name>.css, themes/<name>/{theme.css,manifest.json} (filePut/fileDel)
 *
 * Never synced: plugins/yaos/** (and the QA harness), workspace.json and
 * workspace-mobile.json (open-pane layout), plugin code (main.js, styles.css),
 * caches, anything not listed above. Like legacy, file-recovery.json,
 * publish.json and types.json stay unsynced.
 */
import type { ConfigRelPath } from "../../core/types";

/** Root JSON settings files: the legacy SETTINGS_SYNC_ROOT_JSON set. */
export const CFG_JSON_FILES = [
	"app.json",
	"appearance.json",
	"hotkeys.json",
	"core-plugins.json",
	"core-plugins-migration.json",
	"graph.json",
	"daily-notes.json",
	"templates.json",
	"backlink.json",
	"page-preview.json",
	"note-composer.json",
	"switcher.json",
	"bookmarks.json",
	"workspaces.json",
] as const;
export const CFG_PLUGINS_FILE = "community-plugins.json";
/** Plugin ids whose folders and enablement are never touched by settings sync. */
export const CFG_SKIP_PLUGIN_IDS: readonly string[] = ["yaos", "yaos-qa-harness"];
/** filePut content above this (or non-UTF-8) goes as a blob ref. */
export const CFG_INLINE_MAX_BYTES = 64 * 1024;

/**
 * Device-local top-level keys: never emitted, never overwritten (decision;
 * DESIGN names no keys). Platform-dependent appearance switches, and the
 * saved layout this device last loaded (workspaces.json `active`, rewritten
 * by Obsidian on every switch; the saved layouts themselves sync).
 */
export const CFG_DEVICE_LOCAL_KEYS: Readonly<Record<string, readonly string[]>> = {
	"appearance.json": ["nativeMenus", "translucency"],
	"workspaces.json": ["active"],
};

export type CfgFileClass =
	| { readonly t: "json" }
	| { readonly t: "plugins" }
	| { readonly t: "pluginData"; readonly pluginId: string }
	| { readonly t: "file" };

function segmentOk(s: string): boolean {
	return s !== "" && s !== "." && s !== ".." && !s.includes("\\") && !s.includes("\0");
}

/** null = not synced. `path` must already be config-relative and "/"-separated. */
export function classifyConfigPath(path: ConfigRelPath): CfgFileClass | null {
	if (path.length === 0 || path.startsWith("/") || path.endsWith("/")) return null;
	const seg = path.split("/");
	if (!seg.every(segmentOk)) return null;
	if (seg.length === 1) {
		if ((CFG_JSON_FILES as readonly string[]).includes(path)) return { t: "json" };
		if (path === CFG_PLUGINS_FILE) return { t: "plugins" };
		return null;
	}
	const [a, b, c] = seg;
	if (seg.length === 2 && a === "snippets") return b!.endsWith(".css") && b!.length > 4 ? { t: "file" } : null;
	if (seg.length === 3 && a === "themes") return c === "theme.css" || c === "manifest.json" ? { t: "file" } : null;
	if (seg.length === 3 && a === "plugins" && c === "data.json") {
		return isSyncablePluginId(b!) ? { t: "pluginData", pluginId: b! } : null;
	}
	return null;
}

export function isSyncablePluginId(id: string): boolean {
	return segmentOk(id) && !id.includes("/") && !CFG_SKIP_PLUGIN_IDS.includes(id);
}

export function isDeviceLocalKey(file: ConfigRelPath, key: string): boolean {
	return CFG_DEVICE_LOCAL_KEYS[file]?.includes(key) ?? false;
}

/** Fold key for json registers (CfgFoldState.json). */
export function cfgJsonKey(file: ConfigRelPath, key: string): string {
	return `${file}\u0000${key}`;
}

/**
 * data.json gate (ported dataJsonGate, intent pin dropped: the pin is the
 * register's pluginVersion). Apply only when the locally installed manifest
 * version equals the writer's version, both non-empty.
 */
export function canApplyPluginData(localManifestVersion: string | null, pluginVersion: string | null): boolean {
	return typeof localManifestVersion === "string" && localManifestVersion.length > 0
		&& typeof pluginVersion === "string" && pluginVersion.length > 0
		&& localManifestVersion === pluginVersion;
}

/** Ported configDirKey: basename(app.vault.configDir) sanitized, or null. */
export function sanitizeConfigDirKey(basename: string): string | null {
	if (basename.length === 0 || basename.length > 64) return null;
	if (basename === "." || basename === "..") return null;
	if (basename.includes("/") || basename.includes("\\") || basename.includes("\0")) return null;
	return basename;
}

/** `version` and display `name` from a plugin manifest.json; each null when missing/invalid. */
export function readManifest(bytes: Uint8Array | null, decode: (b: Uint8Array) => string | null): { readonly version: string | null; readonly name: string | null } {
	const text = bytes ? decode(bytes) : null;
	if (text === null) return { version: null, name: null };
	try {
		const m = JSON.parse(text) as { version?: unknown; name?: unknown } | null;
		const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
		return { version: str(m?.version), name: str(m?.name) };
	} catch {
		return { version: null, name: null };
	}
}
