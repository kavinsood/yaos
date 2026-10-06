/**
 * Settings-sync clash (DESIGN §j.3; ported legacy settingsSync/clash.ts). Another
 * mechanism that syncs the config dir is enabled in this vault: Obsidian Sync
 * (core plugin "sync" in core-plugins.json) or a known community sync plugin
 * (community-plugins.json). While one is, settings sync emits and applies
 * nothing; note sync is not affected. Pure.
 */
import { utf8Decode } from "../../core/hash/utf8";

export const CFG_CORE_PLUGINS_FILE = "core-plugins.json";
/** Clashing plugin ids -> display names, in detection order (Obsidian Sync first). */
export const CFG_CLASH_CORE: Readonly<Record<string, string>> = { sync: "Obsidian Sync" };
export const CFG_CLASH_COMMUNITY: Readonly<Record<string, string>> = {
	"remotely-save": "Remotely Save",
	"obsidian-livesync": "Self-hosted LiveSync",
	"system3-relay": "Relay",
};

export interface CfgClash {
	readonly id: string;
	readonly name: string;
	readonly core: boolean;
}

function parse(bytes: Uint8Array | null): unknown {
	const text = bytes ? utf8Decode(bytes, true) : null;
	if (text === null) return null;
	try { return JSON.parse(text) as unknown; } catch { return null; }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Enabled core plugin ids: core-plugins.json is `{ id: boolean }` (older Obsidian: an array of ids). */
function enabledCore(v: unknown): Set<string> {
	if (Array.isArray(v)) return new Set(strings(v));
	if (!v || typeof v !== "object") return new Set();
	return new Set(Object.entries(v as Record<string, unknown>).filter(([, on]) => on === true).map(([id]) => id));
}

/** The first enabled clashing plugin, or null (also when the files are missing or unparseable). */
export function detectCfgClash(corePlugins: Uint8Array | null, communityPlugins: Uint8Array | null): CfgClash | null {
	const core = enabledCore(parse(corePlugins));
	for (const [id, name] of Object.entries(CFG_CLASH_CORE)) if (core.has(id)) return { id, name, core: true };
	const community = new Set(strings(parse(communityPlugins)));
	for (const [id, name] of Object.entries(CFG_CLASH_COMMUNITY)) if (community.has(id)) return { id, name, core: false };
	return null;
}

export function clashMessage(c: CfgClash): string {
	const what = c.core ? `${c.name} is enabled for this vault` : `the ${c.name} plugin is enabled`;
	return `YAOS settings sync is paused because ${what}. Turn one of them off. Note sync is not affected.`;
}
