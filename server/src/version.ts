export const SERVER_VERSION = "0.4.1";

// Compatibility metadata is intentionally explicit so the plugin can reason
// about safe upgrade paths before we add richer release-manifest logic.
export const SERVER_MIN_PLUGIN_VERSION: string | null = null;
export const SERVER_RECOMMENDED_PLUGIN_VERSION = "1.5.0";
export const SERVER_MIN_COMPATIBLE_SERVER_VERSION_FOR_PLUGIN = "0.2.0";
export const SERVER_MIN_COMPATIBLE_PLUGIN_VERSION_FOR_SERVER = "1.3.3";
// Keep v2 in the supported range during the v2 -> v3 rolling-upgrade window.
// The room-level schema guard still rejects older clients after a v3-aware
// plugin marks that specific room as schema v3.
export const SERVER_MIN_SCHEMA_VERSION = 2;
export const SERVER_MAX_SCHEMA_VERSION = 3;
export const SERVER_MIGRATION_REQUIRED = false;
