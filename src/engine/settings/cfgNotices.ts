/**
 * Warn notices for what settings sync holds back (DESIGN §j.3). Pure: plan skips +
 * local snapshot + cfg view -> at most one notice per category, naming everything
 * currently held in it, coalesced with a count. `items` identify the holds:
 * CfgSync shows a category again only when it gains an item, so a steady hold is
 * shown once. Skips the user cannot act on (data.json of a plugin not installed
 * here, a remote data.json delete) stay silent.
 */
import { CFG_MAX_FILE_BYTES, CFG_MAX_FILES, CFG_MAX_TOTAL_BYTES } from "../../core/limits";
import type { CfgFoldState, ConfigRelPath } from "../../core/types";
import { classifyConfigPath } from "./allowlist";
import type { CfgLocalSnapshot, CfgPlan, CfgSkipReason } from "./cfgPlan";

export const CFG_NOTICE_CODES = [
	"settings-plugin-version",
	"settings-plugin-missing",
	"settings-unparseable",
	"settings-too-large",
	"settings-over-cap",
] as const;
export type CfgNoticeCode = (typeof CFG_NOTICE_CODES)[number];

export interface CfgNotice {
	readonly code: CfgNoticeCode;
	readonly items: readonly string[];
	readonly message: string;
}

interface Item {
	readonly key: string;
	/** In a coalesced list. */
	readonly short: string;
	/** Alone. */
	readonly long: string;
}

const MAX_LISTED = 5;
const mb = (bytes: number): string => `${bytes / 1_000_000} MB`;

function listed(xs: readonly string[]): string {
	const head = xs.slice(0, MAX_LISTED).join(", ");
	return xs.length > MAX_LISTED ? `${head} and ${xs.length - MAX_LISTED} more` : head;
}

/** a < b on dotted numeric versions ("0.5.9" < "0.5.10"); a non-numeric part compares as text. */
export function olderVersion(a: string, b: string): boolean {
	const x = a.split(".");
	const y = b.split(".");
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const p = x[i] ?? "0";
		const q = y[i] ?? "0";
		if (p === q) continue;
		const n = Number(p);
		const m = Number(q);
		return Number.isInteger(n) && Number.isInteger(m) ? n < m : p < q;
	}
	return false;
}

function build(code: CfgNoticeCode, items: readonly Item[], many: (n: number, list: string) => string): CfgNotice | null {
	if (items.length === 0) return null;
	const message = items.length === 1 ? items[0]!.long : many(items.length, listed(items.map((i) => i.short)));
	return { code, items: items.map((i) => i.key), message };
}

function versionItem(file: ConfigRelPath, reason: CfgSkipReason, local: CfgLocalSnapshot, view: CfgFoldState): Item | null {
	const cls = classifyConfigPath(file);
	if (cls?.t !== "pluginData") return null;
	const name = local.pluginNames.get(cls.pluginId) ?? cls.pluginId;
	const here = local.installed.get(cls.pluginId) ?? null;
	if (reason === "no-manifest") {
		return {
			key: `no-manifest:${file}`,
			short: `${name} (no readable version here)`,
			long: `YAOS settings sync is not sending ${file}: ${name}'s manifest.json has no readable version. Reinstall the plugin to sync these settings.`,
		};
	}
	const writer = view.files.get(file)?.value?.pluginVersion ?? null;
	const by = writer ? `${name} ${writer}` : `an unknown version of ${name}`;
	const key = `version:${file}:${writer ?? ""}:${here ?? ""}`;
	if (here === null) {
		return {
			key,
			short: `${name} (no readable version here, ${writer ?? "unknown"} elsewhere)`,
			long: `YAOS settings sync is holding ${file}: written by ${by}, and the copy installed here has no readable version. Reinstall the plugin to receive these settings.`,
		};
	}
	const advice = writer === null || olderVersion(here, writer)
		? "Update the plugin to receive these settings."
		: `Update ${name} on your other devices to sync these settings.`;
	return {
		key,
		short: `${name} (${here} here, ${writer ?? "unknown"} elsewhere)`,
		long: `YAOS settings sync is holding ${file}: written by ${by}, this device has ${here}. ${advice}`,
	};
}

export function cfgSkipNotices(plan: CfgPlan, local: CfgLocalSnapshot, view: CfgFoldState): CfgNotice[] {
	const versions: Item[] = [];
	const missing: Item[] = [];
	const unparseable: Item[] = [];
	const tooLarge: Item[] = [];
	const overCap: Item[] = [];
	const capPrefix = `YAOS settings sync syncs at most ${CFG_MAX_FILES} settings files and ${mb(CFG_MAX_TOTAL_BYTES)} in total`;
	for (const s of plan.skipped) {
		const f = s.file;
		switch (s.reason) {
			case "plugin-version":
			case "no-manifest": {
				const item = versionItem(f, s.reason, local, view);
				if (item) versions.push(item);
				break;
			}
			case "not-installed":
				if (s.key) missing.push({ key: s.key, short: s.key, long: `YAOS settings sync: ${s.key} is enabled on your other devices but not installed here; install it to use it here.` });
				break;
			case "unparseable":
				unparseable.push({ key: f, short: f, long: `YAOS settings sync is skipping ${f}: it is not valid JSON. Fix the file to sync it again.` });
				break;
			case "too-large":
				tooLarge.push({ key: f, short: f, long: `YAOS settings sync skipped ${f}: it is larger than ${mb(CFG_MAX_FILE_BYTES)}, the limit for one settings file.` });
				break;
			case "over-cap":
				overCap.push({ key: f, short: f, long: `${capPrefix}; ${f} is past that limit and is not synced. Remove settings files you do not need to sync the rest.` });
				break;
			case "plugin-absent":
			case "data-json-delete":
				break;
		}
	}
	return [
		build("settings-plugin-version", versions, (n, list) =>
			`YAOS settings sync is holding ${n} plugin settings files until the plugin versions match: ${list}. Update the plugins so every device runs the same version.`),
		build("settings-plugin-missing", missing, (n, list) =>
			`YAOS settings sync: ${n} plugins are enabled on your other devices but not installed here (${list}); install them to use them here.`),
		build("settings-unparseable", unparseable, (n, list) =>
			`YAOS settings sync is skipping ${n} settings files that are not valid JSON: ${list}. Fix them to sync them again.`),
		build("settings-too-large", tooLarge, (n, list) =>
			`YAOS settings sync skipped ${n} settings files larger than ${mb(CFG_MAX_FILE_BYTES)}, the limit for one settings file: ${list}.`),
		build("settings-over-cap", overCap, (n, list) =>
			`${capPrefix}; ${n} files past that limit are not synced: ${list}. Remove settings files you do not need to sync the rest.`),
	].filter((n): n is CfgNotice => n !== null);
}
