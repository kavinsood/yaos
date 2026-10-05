/**
 * Settings projection helpers (DESIGN §c.11, §j.3): pure transforms between
 * fold registers and config-file bytes. The three-way decision (fold vs local
 * vs cfgBase) is the engine's (WP-B cfgProject); these functions only read
 * files into registers and write chosen register values into files.
 *
 * Decisions (wp-a-notes.md):
 * - JSON files are rewritten in `JSON.stringify(_, null, 2)` style: existing
 *   keys keep their local order, new keys are appended in sorted order.
 *   Untouched values are re-serialized from their parsed form.
 * - A local file that is not a UTF-8 JSON object is never overwritten by a
 *   key update (applyJsonKeys returns null); the caller reports it.
 * - Applying updates that change nothing returns the local bytes unchanged.
 * - community-plugins.json = ids whose register is `true`, sorted, 2-space JSON.
 * - plugins/yaos/** is never applied; data.json applies only when the local
 *   manifest version is non-empty and equals the register's pluginVersion.
 */

import type { CfgFoldState, CfgOp, CfgRegister, ConfigRelPath } from "../types";
import { utf8DecodeStrict, utf8Encode } from "../codec/lib0";
import { canonicalJson, tryParseJson } from "./json";
import { jsonRegisterKey, splitJsonRegisterKey, type CfgFileValue } from "./fold";

export const COMMUNITY_PLUGINS_FILE = "community-plugins.json";
export const YAOS_PLUGIN_ID = "yaos";

/** plugins/yaos/** (and the folder itself) is never synced or applied. */
export function isYaosOwnPath(file: ConfigRelPath): boolean {
	return file === `plugins/${YAOS_PLUGIN_ID}` || file.startsWith(`plugins/${YAOS_PLUGIN_ID}/`);
}

/** Plugin id of plugins/<id>/data.json, else null. */
export function pluginIdOfDataJson(file: ConfigRelPath): string | null {
	const m = /^plugins\/([^/]+)\/data\.json$/.exec(file);
	return m ? m[1]! : null;
}

function parseJsonBytes(bytes: Uint8Array): { readonly value: unknown } | undefined {
	let text: string;
	try {
		text = utf8DecodeStrict(bytes);
	} catch {
		return undefined;
	}
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	return tryParseJson(text);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Top-level entries of a JSON object file, in file order, values as canonical
 * JSON. null if the bytes are not a UTF-8 JSON object.
 */
export function readJsonTopLevel(bytes: Uint8Array): Map<string, string> | null {
	const p = parseJsonBytes(bytes);
	if (!p || !isPlainObject(p.value)) return null;
	const out = new Map<string, string>();
	for (const k of Object.keys(p.value)) {
		const c = canonicalJson(p.value[k]);
		if (c === null) return null;
		out.set(k, c);
	}
	return out;
}

/** Fold registers of one JSON file: top-level key -> register, ascending key. */
export function jsonRegistersOf(state: CfgFoldState, file: ConfigRelPath): Map<string, CfgRegister<string>> {
	const prefix = jsonRegisterKey(file, "");
	const keys: string[] = [];
	for (const k of state.json.keys()) if (k.startsWith(prefix)) keys.push(k);
	keys.sort();
	const out = new Map<string, CfgRegister<string>>();
	for (const k of keys) out.set(splitJsonRegisterKey(k)!.key, state.json.get(k)!);
	return out;
}

/** Files that have at least one json register, ascending. */
export function jsonFilesOf(state: CfgFoldState): ConfigRelPath[] {
	const s = new Set<string>();
	for (const k of state.json.keys()) s.add(splitJsonRegisterKey(k)!.file);
	return [...s].sort();
}

/**
 * Ops that turn `base` into `local` for one JSON file (per top-level key;
 * values canonical). `base` null = no base (every local key is emitted, no
 * deletes). Keys in `deny` are never emitted. Order: ascending key.
 */
export function diffJsonFile(
	file: ConfigRelPath,
	base: ReadonlyMap<string, string> | null,
	local: ReadonlyMap<string, string>,
	deny: ReadonlySet<string> = new Set(),
): CfgOp[] {
	const keys = new Set<string>(local.keys());
	if (base) for (const k of base.keys()) keys.add(k);
	const ops: CfgOp[] = [];
	for (const key of [...keys].sort()) {
		if (deny.has(key)) continue;
		const l = local.get(key);
		const b = base?.get(key);
		if (l !== undefined && l !== b) ops.push({ t: "jsonSet", file, key, valueJson: l });
		else if (l === undefined && b !== undefined) ops.push({ t: "jsonDel", file, key });
	}
	return ops;
}

function prettyEntry(key: string, valueJson: string): string {
	const v = JSON.parse(valueJson) as unknown;
	return `  ${JSON.stringify(key)}: ${JSON.stringify(v, null, 2).replace(/\n/g, "\n  ")}`;
}

/** 2-space JSON text of an ordered list of top-level entries (safe for "__proto__" keys). */
export function writeJsonTopLevel(entries: Iterable<readonly [string, string]>): string {
	const parts: string[] = [];
	for (const [k, v] of entries) parts.push(prettyEntry(k, v));
	return parts.length === 0 ? "{}" : `{\n${parts.join(",\n")}\n}`;
}

/**
 * Applies top-level key updates (key -> canonical valueJson, or null =
 * delete) to a local JSON file. `local` null = file absent. Keys in `deny`
 * are never touched. Returns null if `local` is not a JSON object.
 */
export function applyJsonKeys(
	local: Uint8Array | null,
	updates: ReadonlyMap<string, string | null>,
	deny: ReadonlySet<string> = new Set(),
): { readonly bytes: Uint8Array; readonly changed: boolean } | null {
	const cur = local === null ? new Map<string, string>() : readJsonTopLevel(local);
	if (cur === null) return null;
	const next = new Map(cur);
	let changed = local === null;
	const added: string[] = [];
	for (const [k, v] of updates) {
		if (deny.has(k)) continue;
		if (v === null) {
			if (next.delete(k)) changed = true;
			continue;
		}
		const c = canonicalJson(tryParseJson(v)?.value);
		if (c === null) continue;
		if (!next.has(k)) added.push(k);
		if (next.get(k) !== c) changed = true;
		next.set(k, c);
	}
	if (!changed) return { bytes: local!, changed: false };
	// Re-insert added keys in sorted order after the existing ones.
	const ordered: [string, string][] = [];
	for (const [k, v] of next) if (!added.includes(k)) ordered.push([k, v]);
	for (const k of added.sort()) ordered.push([k, next.get(k)!]);
	return { bytes: utf8Encode(writeJsonTopLevel(ordered)), changed: true };
}

/** Projects every json register of `file` (values and tombstones) onto local bytes. */
export function projectJsonFile(
	state: CfgFoldState,
	file: ConfigRelPath,
	local: Uint8Array | null,
	deny: ReadonlySet<string> = new Set(),
): { readonly bytes: Uint8Array; readonly changed: boolean } | null {
	const updates = new Map<string, string | null>();
	for (const [k, reg] of jsonRegistersOf(state, file)) updates.set(k, reg.value);
	return applyJsonKeys(local, updates, deny);
}

/** Enabled plugin ids (register value true), ascending; the yaos id is never listed. */
export function enabledPlugins(state: CfgFoldState): string[] {
	const ids: string[] = [];
	for (const [id, reg] of state.plugins) if (reg.value === true && id !== YAOS_PLUGIN_ID) ids.push(id);
	return ids.sort();
}

/** community-plugins.json bytes projected from the plugins map. */
export function projectCommunityPlugins(state: CfgFoldState): Uint8Array {
	return utf8Encode(JSON.stringify(enabledPlugins(state), null, 2));
}

/** Plugin ids listed in a local community-plugins.json; null if not a JSON array of strings. */
export function readCommunityPlugins(bytes: Uint8Array): string[] | null {
	const p = parseJsonBytes(bytes);
	if (!p || !Array.isArray(p.value)) return null;
	const out: string[] = [];
	for (const v of p.value) {
		if (typeof v !== "string") return null;
		if (!out.includes(v)) out.push(v);
	}
	return out;
}

/**
 * pluginSet/pluginDel ops turning base membership into local membership
 * (ascending id; yaos excluded). base null = no base: emit pluginSet for
 * every local id. A plugin removed locally becomes pluginSet{enabled:false}
 * (still installed somewhere; uninstall is not inferred from the list).
 */
export function diffCommunityPlugins(base: readonly string[] | null, local: readonly string[]): CfgOp[] {
	const b = new Set(base ?? []);
	const l = new Set(local);
	const ids = [...new Set([...b, ...l])].filter((id) => id !== YAOS_PLUGIN_ID).sort();
	const ops: CfgOp[] = [];
	for (const id of ids) {
		if (l.has(id) && !b.has(id)) ops.push({ t: "pluginSet", pluginId: id, enabled: true });
		else if (!l.has(id) && b.has(id)) ops.push({ t: "pluginSet", pluginId: id, enabled: false });
	}
	return ops;
}

/**
 * plugins/<id>/data.json gate (§c.11): the register holds a value whose
 * pluginVersion is non-empty and equals the local manifest version.
 */
export function canApplyPluginData(localManifestVersion: string | null | undefined, reg: CfgRegister<CfgFileValue> | undefined): boolean {
	if (!reg || reg.value === null) return false;
	const v = reg.value.pluginVersion;
	if (typeof v !== "string" || v.length === 0) return false;
	return typeof localManifestVersion === "string" && localManifestVersion.length > 0 && localManifestVersion === v;
}
