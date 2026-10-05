/**
 * Settings-sync allowlist (DESIGN §j.3). Ported from legacy
 * settingsSync/{allowlist, dataJsonGate, configDirKey} and narrowed to the
 * DESIGN set. Everything here is pure.
 *
 * Classes:
 *   json        app.json, appearance.json, hotkeys.json, core-plugins.json  (jsonSet/jsonDel per top-level key)
 *   plugins     community-plugins.json                                     (pluginSet per plugin id)
 *   pluginData  plugins/<id>/data.json                                     (filePut + pluginVersion gate)
 *   file        snippets/<name>.css, themes/<name>/{theme.css,manifest.json} (filePut/fileDel)
 *
 * Never synced: plugins/yaos/** (and the QA harness), workspace*.json, plugin
 * code (main.js, styles.css), caches, anything not listed above.
 */
import type { ConfigRelPath } from "../../core/types";

export const CFG_JSON_FILES = ["app.json", "appearance.json", "hotkeys.json", "core-plugins.json"] as const;
export const CFG_PLUGINS_FILE = "community-plugins.json";
/** Plugin ids whose folders and enablement are never touched by settings sync. */
export const CFG_SKIP_PLUGIN_IDS: readonly string[] = ["yaos", "yaos-qa-harness"];
/** filePut content above this (or non-UTF-8) goes as a blob ref. */
export const CFG_INLINE_MAX_BYTES = 64 * 1024;

/**
 * Device-local top-level keys: never emitted, never overwritten. Platform
 * dependent appearance switches only (decision; DESIGN names no keys).
 */
export const CFG_DEVICE_LOCAL_KEYS: Readonly<Record<string, readonly string[]>> = {
	"appearance.json": ["nativeMenus", "translucency"],
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

/** `version` from a plugin manifest.json, or null when missing/invalid. */
export function manifestVersion(bytes: Uint8Array | null, decode: (b: Uint8Array) => string | null): string | null {
	if (!bytes) return null;
	const text = decode(bytes);
	if (text === null) return null;
	try {
		const v = (JSON.parse(text) as { version?: unknown }).version;
		return typeof v === "string" && v.length > 0 ? v : null;
	} catch {
		return null;
	}
}
