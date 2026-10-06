/**
 * Settings projection planner (DESIGN §j.3). Pure: local snapshot + cfgBase +
 * cfg view (committed fold with own pending ops overlaid) -> per-file actions.
 *
 * Per register (json key, plugin id, file):
 *   local == view                       -> in sync; base := local.
 *   local == base (or no base yet and the
 *     view has a register: first contact) -> take the view: write locally.
 *   otherwise                           -> local changed: emit the local op
 *                                          (the fold orders it after the
 *                                          remote one, later seq wins); base := local.
 *
 * Gates: plugins/yaos/** and other non-allowlisted paths are dropped even if a
 * register names them; data.json is written only when the installed manifest
 * version equals the register's pluginVersion and is emitted only with a known
 * local version; data.json is never deleted or fileDel'd; enabling a plugin is
 * projected only when it is installed; YAOS's own enablement is never touched.
 *
 * Size caps (core/limits CFG_MAX_*): a file whose local or incoming content is
 * over CFG_MAX_FILE_BYTES is held. In path order, the first file that would take
 * the synced set past CFG_MAX_FILES or CFG_MAX_TOTAL_BYTES (size after this pass)
 * is held, and so is every later one. A held file is left exactly as it is: no
 * op, no write, cfgBase untouched. Removals and local deletes are never held.
 */
import { canonicalJson, type JsonValue } from "../../core/hash/canvasCanonical";
import { exactFingerprint } from "../../core/hash/markdownLf";
import { sha256Hex } from "../../core/hash/sha256";
import { utf8Decode, utf8Encode } from "../../core/hash/utf8";
import { CFG_MAX_FILE_BYTES, CFG_MAX_FILES, CFG_MAX_TOTAL_BYTES } from "../../core/limits";
import type { CfgFoldState, CfgOp, CfgRegister, ConfigRelPath, ContentHash, DiskFingerprint } from "../../core/types";
import type { CfgBaseRecord } from "../store/schema";
import { CFG_INLINE_MAX_BYTES, CFG_PLUGINS_FILE, canApplyPluginData, cfgJsonKey, classifyConfigPath, isDeviceLocalKey, isSyncablePluginId, type CfgFileClass } from "./allowlist";

export interface CfgLocalFile { readonly bytes: Uint8Array; readonly mtimeMs: number }
export interface CfgLocalSnapshot {
	/** Allowlisted config files present locally. */
	readonly files: ReadonlyMap<ConfigRelPath, CfgLocalFile>;
	/** Installed community plugins: id -> manifest version (null = unreadable manifest). */
	readonly installed: ReadonlyMap<string, string | null>;
	/** Installed community plugins: id -> manifest display name, when it has one. */
	readonly pluginNames: ReadonlyMap<string, string>;
	/** Allowlisted local files left out by the size caps (not in `files`): never emitted, written or deleted. */
	readonly held: ReadonlyMap<ConfigRelPath, CfgHoldReason>;
}
export interface CfgPlanInput {
	readonly local: CfgLocalSnapshot;
	readonly base: ReadonlyMap<ConfigRelPath, CfgBaseRecord>;
	readonly view: CfgFoldState;
	readonly nowMs: number;
}
export type CfgWrite =
	| { readonly t: "bytes"; readonly bytes: Uint8Array }
	| { readonly t: "blob"; readonly hash: ContentHash; readonly size: number }
	| { readonly t: "remove" };
export interface CfgFileAction {
	readonly file: ConfigRelPath;
	readonly ops: readonly CfgOp[];
	/** Blob that must be readable before `ops` are submitted. */
	readonly upload: { readonly hash: ContentHash; readonly bytes: Uint8Array } | null;
	readonly write: CfgWrite | null;
	/** Fingerprint the local file must still have right before the write (null = absent). */
	readonly expect: DiskFingerprint | null;
	/** cfgBase after the action (null = drop). */
	readonly base: CfgBaseRecord | null;
	/** Obsidian must reload to pick the write up. */
	readonly reload: boolean;
}
export type CfgHoldReason = "too-large" | "over-cap";
/**
 * plugin-version: data.json written by another version than the installed one; plugin-absent: data.json of a
 * plugin not installed here; no-manifest: local data.json of a plugin whose manifest has no version.
 */
export type CfgSkipReason = "unparseable" | "plugin-version" | "plugin-absent" | "no-manifest" | "not-installed" | "data-json-delete" | CfgHoldReason;
export interface CfgPlan {
	readonly actions: readonly CfgFileAction[];
	readonly skipped: readonly { readonly file: ConfigRelPath; readonly key: string | null; readonly reason: CfgSkipReason }[];
}

const hashText = (s: string): ContentHash => sha256Hex(utf8Encode(s)) as ContentHash;
const H_TRUE = hashText("true");

type Skips = { file: ConfigRelPath; key: string | null; reason: CfgSkipReason }[];

/** Count/total cap over files fed in path order; once one does not fit, nothing more does. */
export class CfgBudget {
	private files = 0;
	private bytes = 0;
	private closed = false;

	/** Admit a file of `size` bytes after this pass (null = absent: always fits, counts nothing). */
	admit(size: number | null): boolean {
		if (size === null) return true;
		if (this.closed || this.files + 1 > CFG_MAX_FILES || this.bytes + size > CFG_MAX_TOTAL_BYTES) {
			this.closed = true;
			return false;
		}
		this.files++;
		this.bytes += size;
		return true;
	}
	close(): void { this.closed = true; }
}

export function planCfg(input: CfgPlanInput): CfgPlan {
	const jsonByFile = new Map<ConfigRelPath, Map<string, CfgRegister<string>>>();
	for (const [k, reg] of input.view.json) {
		const cut = k.indexOf("\u0000");
		if (cut < 0) continue;
		const file = k.slice(0, cut);
		let m = jsonByFile.get(file);
		if (!m) jsonByFile.set(file, (m = new Map()));
		m.set(k.slice(cut + 1), reg);
	}
	const files = new Set<ConfigRelPath>([...input.local.files.keys(), ...input.local.held.keys(), ...input.base.keys(), ...input.view.files.keys(), ...jsonByFile.keys()]);
	if (input.view.plugins.size > 0) files.add(CFG_PLUGINS_FILE);
	const actions: CfgFileAction[] = [];
	const skipped: Skips = [];
	const budget = new CfgBudget();
	for (const file of [...files].sort()) {
		const cls = classifyConfigPath(file);
		if (!cls) continue;
		const held = input.local.held.get(file);
		if (held) {
			if (held === "over-cap") budget.close();
			skipped.push({ file, key: null, reason: held });
			continue;
		}
		const ctx: FileCtx = { file, local: input.local.files.get(file), base: input.base.get(file), nowMs: input.nowMs, skipped: [] };
		const a = cls.t === "json" ? planJson(ctx, jsonByFile.get(file) ?? new Map())
			: cls.t === "plugins" ? planPlugins(ctx, input.view, input.local.installed)
			: planFile(ctx, cls, input.view, input.local.installed);
		const w = a?.write;
		const after = !w ? ctx.local?.bytes.length ?? null : w.t === "bytes" ? w.bytes.length : w.t === "blob" ? w.size : null;
		if (!budget.admit(after)) {
			skipped.push({ file, key: null, reason: "over-cap" });
			continue;
		}
		skipped.push(...ctx.skipped);
		if (a && (a.ops.length > 0 || a.write || !sameBase(ctx.base ?? null, a.base))) actions.push(a);
	}
	return { actions, skipped };
}

interface FileCtx {
	readonly file: ConfigRelPath;
	readonly local: CfgLocalFile | undefined;
	readonly base: CfgBaseRecord | undefined;
	readonly nowMs: number;
	readonly skipped: Skips;
}

function sameBase(a: CfgBaseRecord | null, b: CfgBaseRecord | null): boolean {
	if (!a || !b) return a === b;
	return a.fingerprint === b.fingerprint && canonicalJson(a.keyHashes as JsonValue) === canonicalJson(b.keyHashes as JsonValue);
}

function parseJson(bytes: Uint8Array): unknown {
	const text = utf8Decode(bytes, true);
	if (text === null) return undefined;
	try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function record(file: ConfigRelPath, bytes: Uint8Array | null, mtimeMs: number, keyHashes: Record<string, ContentHash> | null): CfgBaseRecord | null {
	if (!bytes) return null;
	return { file, fingerprint: exactFingerprint(bytes), size: bytes.length, mtimeMs, keyHashes };
}

function tooLarge(ctx: FileCtx, size: number): boolean {
	if (size <= CFG_MAX_FILE_BYTES) return false;
	ctx.skipped.push({ file: ctx.file, key: null, reason: "too-large" });
	return true;
}

function finish(ctx: FileCtx, ops: CfgOp[], next: Uint8Array | null, keyHashes: Record<string, ContentHash>): CfgFileAction | null {
	if (next && tooLarge(ctx, next.length)) return null;
	const cur = ctx.local?.bytes ?? null;
	const bytes = next ?? cur;
	return {
		file: ctx.file,
		ops,
		upload: null,
		write: next ? { t: "bytes", bytes: next } : null,
		expect: cur ? exactFingerprint(cur) : null,
		base: record(ctx.file, bytes, next ? ctx.nowMs : ctx.local?.mtimeMs ?? ctx.nowMs, keyHashes),
		reload: next !== null,
	};
}

function planJson(ctx: FileCtx, regs: ReadonlyMap<string, CfgRegister<string>>): CfgFileAction | null {
	const missing = ctx.local === undefined;
	const parsed = missing ? {} : parseJson(ctx.local!.bytes);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		ctx.skipped.push({ file: ctx.file, key: null, reason: "unparseable" });
		return null;
	}
	const obj = new Map(Object.entries(parsed as Record<string, unknown>));
	const keys = new Set([...obj.keys(), ...Object.keys(ctx.base?.keyHashes ?? {}), ...regs.keys()]);
	const ops: CfgOp[] = [];
	const hashes: Record<string, ContentHash> = Object.create(null) as Record<string, ContentHash>;
	let changed = false;
	for (const key of [...keys].sort()) {
		if (isDeviceLocalKey(ctx.file, key)) continue;
		const L = obj.has(key) ? canonicalJson(obj.get(key) as JsonValue) : undefined;
		const reg = regs.get(key);
		const hL = L === undefined ? null : hashText(L);
		const hF = reg?.value ? hashText(reg.value) : null;
		const B = ctx.base?.keyHashes?.[key] ?? null;
		if (hL === hF) {
			if (hL) hashes[key] = hL;
			continue;
		}
		if (reg && (missing || hL === B || ctx.base === undefined)) {
			if (reg.value === null) obj.delete(key);
			else obj.set(key, JSON.parse(reg.value) as unknown);
			if (hF) hashes[key] = hF;
			changed = true;
			continue;
		}
		ops.push(L === undefined ? { t: "jsonDel", file: ctx.file, key } : { t: "jsonSet", file: ctx.file, key, valueJson: L });
		if (hL) hashes[key] = hL;
	}
	const next = changed ? utf8Encode(JSON.stringify(Object.fromEntries(obj), null, 2)) : null;
	return finish(ctx, ops, next, hashes);
}

function planPlugins(ctx: FileCtx, view: CfgFoldState, installed: ReadonlyMap<string, string | null>): CfgFileAction | null {
	const missing = ctx.local === undefined;
	const parsed = missing ? [] : parseJson(ctx.local!.bytes);
	if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
		ctx.skipped.push({ file: ctx.file, key: null, reason: "unparseable" });
		return null;
	}
	const list = [...(parsed as string[])];
	const enabled = new Set(list);
	const ids = new Set([...enabled, ...Object.keys(ctx.base?.keyHashes ?? {}), ...view.plugins.keys()]);
	const ops: CfgOp[] = [];
	const hashes: Record<string, ContentHash> = Object.create(null) as Record<string, ContentHash>;
	const add: string[] = [];
	const remove = new Set<string>();
	for (const id of [...ids].sort()) {
		if (!isSyncablePluginId(id)) continue;
		const lv = enabled.has(id);
		const bv = ctx.base?.keyHashes?.[id] !== undefined;
		const reg = view.plugins.get(id);
		const fv = reg?.value === true;
		if ((reg && lv === fv) || (!reg && !lv)) {
			if (lv) hashes[id] = H_TRUE;
			continue;
		}
		if (reg && (missing || lv === bv || ctx.base === undefined)) {
			if (fv && !installed.has(id)) {
				ctx.skipped.push({ file: ctx.file, key: id, reason: "not-installed" });
				if (bv) hashes[id] = H_TRUE;
				continue;
			}
			if (fv) add.push(id);
			else remove.add(id);
			if (fv) hashes[id] = H_TRUE;
			continue;
		}
		ops.push({ t: "pluginSet", pluginId: id, enabled: lv });
		if (lv) hashes[id] = H_TRUE;
	}
	const changed = add.length > 0 || remove.size > 0;
	const next = changed ? utf8Encode(JSON.stringify([...list.filter((id) => !remove.has(id)), ...add], null, 2)) : null;
	return finish(ctx, ops, next, hashes);
}

function planFile(ctx: FileCtx, cls: CfgFileClass, view: CfgFoldState, installed: ReadonlyMap<string, string | null>): CfgFileAction | null {
	const isData = cls.t === "pluginData";
	const localVer = cls.t === "pluginData" ? installed.get(cls.pluginId) ?? null : null;
	const lb = ctx.local?.bytes ?? null;
	const L = lb ? exactFingerprint(lb) : null;
	const reg = view.files.get(ctx.file);
	const F = reg?.value;
	const hF = F ? (F.content.t === "inline" ? exactFingerprint(F.content.bytes) : (F.content.hash as string as DiskFingerprint)) : null;
	const reload = !ctx.file.startsWith("snippets/");
	const base = (fp: DiskFingerprint | null, size: number, mtimeMs: number): CfgBaseRecord | null =>
		fp ? { file: ctx.file, fingerprint: fp, size, mtimeMs, keyHashes: null } : null;
	const act = (a: Partial<CfgFileAction> & Pick<CfgFileAction, "base">): CfgFileAction =>
		({ file: ctx.file, ops: [], upload: null, write: null, expect: L, reload: false, ...a });
	if (L === hF) return act({ base: base(L, lb?.length ?? 0, ctx.local?.mtimeMs ?? ctx.nowMs) });
	const B = ctx.base?.fingerprint ?? null;
	if (reg && ((ctx.base !== undefined && L === B) || ctx.base === undefined)) {
		if (!F) {
			if (isData) { ctx.skipped.push({ file: ctx.file, key: null, reason: "data-json-delete" }); return null; }
			return act({ write: { t: "remove" }, base: null, reload });
		}
		if (cls.t === "pluginData" && !canApplyPluginData(localVer, F.pluginVersion)) {
			ctx.skipped.push({ file: ctx.file, key: null, reason: installed.has(cls.pluginId) ? "plugin-version" : "plugin-absent" });
			return null;
		}
		const size = F.content.t === "inline" ? F.content.bytes.length : F.content.size;
		if (tooLarge(ctx, size)) return null;
		const write: CfgWrite = F.content.t === "inline" ? { t: "bytes", bytes: F.content.bytes } : { t: "blob", hash: F.content.hash, size: F.content.size };
		return act({ write, base: base(hF, size, ctx.nowMs), reload });
	}
	if (!lb || !L) {
		if (isData) return act({ base: null });
		return act({ ops: [{ t: "fileDel", file: ctx.file }], base: null });
	}
	if (isData && localVer === null) {
		ctx.skipped.push({ file: ctx.file, key: null, reason: "no-manifest" });
		return null;
	}
	const inline = lb.length <= CFG_INLINE_MAX_BYTES && utf8Decode(lb, true) !== null;
	const hash = L as string as ContentHash;
	return act({
		ops: [{ t: "filePut", file: ctx.file, content: inline ? { t: "inline", bytes: lb } : { t: "blob", hash, size: lb.length }, pluginVersion: isData ? localVer : null }],
		upload: inline ? null : { hash, bytes: lb },
		base: base(L, lb.length, ctx.local?.mtimeMs ?? ctx.nowMs),
	});
}
