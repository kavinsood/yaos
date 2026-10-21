/**
 * The local settings record (identity-per-store §8): the plugin fields that belong to this install, not to the vault
 * folder. data.json sits in the folder, and other tools copy or sync it between machines (the last writer wins), so a
 * synced `creating` marker could make a twin think it created the vault, a pending enrollment (SECRET) would travel,
 * conflict-copy labels would collide and a preference would flip. These live in
 * `App.saveLocalStorage(LOCAL_SETTINGS_KEY)` instead, which Obsidian scopes to the vault registration (as the install
 * record, installRecord.ts). One fixed key, not one per vaultId: the label and a pending enrollment exist before a
 * vault is known.
 *
 * Migration (pre-ship, §13): the label and the status bar flag move once from an older data.json when the record
 * lacks them (harmless if a twin takes them too). An older data.json's `creating` and `pendingEnrollment` are dropped,
 * never moved: they may be a twin's. Pure: the storage is injected.
 */

import type { InstallStorage } from "./installRecord";
import { sanitizeCreating } from "./keys/pin";
import { sanitizeDeviceLabel, sanitizePendingEnrollment, storedPart, type LocalPluginFields, type StoredPluginData, type YaosPluginData } from "./ui/api";

export const LOCAL_SETTINGS_KEY = "yaos-local";

/** SECRET: pendingEnrollment (never logged or shown). */
export interface LocalSettings extends LocalPluginFields {
	readonly v: 1;
	/** The clone notice (cloneNotice.ts) was shown on this install: never again. */
	readonly cloneNoticeShown?: true;
}

/** The fields an older data.json carried that are per install now (the next data.json save drops them). */
export const LEGACY_LOCAL_FIELDS: readonly string[] = ["deviceLabel", "showStatusBar", "creating", "pendingEnrollment"];

function asRecord(v: unknown): Record<string, unknown> | null {
	return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function labelOf(v: unknown): string | null {
	return typeof v === "string" && v.trim() ? sanitizeDeviceLabel(v, "Device") : null;
}

/** The four per-install fields of `d`, nothing else. */
export function localPart(d: LocalPluginFields): LocalPluginFields {
	return {
		deviceLabel: d.deviceLabel,
		showStatusBar: d.showStatusBar,
		...(d.pendingEnrollment ? { pendingEnrollment: d.pendingEnrollment } : {}),
		...(d.creating ? { creating: d.creating } : {}),
	};
}

function build(f: LocalPluginFields, cloneNoticeShown: boolean): LocalSettings {
	return { v: 1, ...localPart(f), ...(cloneNoticeShown ? { cloneNoticeShown: true as const } : {}) };
}

/**
 * Tolerant: a field that is missing or malformed takes its default (the label: `legacy`'s, then `fallbackLabel`;
 * the status bar flag: `legacy`'s, then shown). `legacy` is an older data.json (only those two are read from it).
 */
export function sanitizeLocalSettings(raw: unknown, fallbackLabel: string, legacy: unknown = null): LocalSettings {
	const r = asRecord(raw);
	const old = asRecord(legacy);
	const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
	const pending = sanitizePendingEnrollment(r?.pendingEnrollment);
	const creating = sanitizeCreating(r?.creating);
	return build({
		deviceLabel: labelOf(r?.deviceLabel) ?? labelOf(old?.deviceLabel) ?? sanitizeDeviceLabel(fallbackLabel, "Device"),
		showStatusBar: flag(r?.showStatusBar) ?? flag(old?.showStatusBar) ?? true,
		...(pending ? { pendingEnrollment: pending } : {}),
		...(creating ? { creating } : {}),
	}, r?.cloneNoticeShown === true);
}

function read(storage: InstallStorage): unknown {
	try {
		return storage.load(LOCAL_SETTINGS_KEY);
	} catch {
		return null;
	}
}

/** This install's record, migrated from `legacy` (the raw data.json) where it lacks a field; saved when it changed. */
export function loadLocalSettings(storage: InstallStorage, legacy: unknown, fallbackLabel: string): LocalSettings {
	const raw = read(storage);
	const rec = sanitizeLocalSettings(raw, fallbackLabel, legacy);
	if (JSON.stringify(rec) !== JSON.stringify(raw)) storage.save(LOCAL_SETTINGS_KEY, rec);
	return rec;
}

/** The record with the four per-install fields of `f` (the rest of the stored record is kept). */
export function saveLocalFields(storage: InstallStorage, f: LocalPluginFields): void {
	const cur = sanitizeLocalSettings(read(storage), f.deviceLabel);
	const next = build(f, cur.cloneNoticeShown === true);
	if (JSON.stringify(next) !== JSON.stringify(cur)) storage.save(LOCAL_SETTINGS_KEY, next);
}

/** Records that the clone notice was shown; false when it already had been (nothing saved). */
export function markCloneNoticeShown(storage: InstallStorage, fallbackLabel: string): boolean {
	const cur = sanitizeLocalSettings(read(storage), fallbackLabel);
	if (cur.cloneNoticeShown) return false;
	storage.save(LOCAL_SETTINGS_KEY, build(cur, true));
	return true;
}

export function sameLocalFields(a: LocalPluginFields, b: LocalPluginFields): boolean {
	return JSON.stringify(localPart(a)) === JSON.stringify(localPart(b));
}

/** The host's view: data.json's shared fields plus this install's local ones. */
export function withLocal(stored: StoredPluginData, local: LocalPluginFields): YaosPluginData {
	return { ...storedPart(stored), ...localPart(local) };
}

/** Whether a raw data.json still carries a per-install field (rewritten once without it at load). */
export function hasLegacyLocalFields(raw: unknown): boolean {
	const r = asRecord(raw);
	return r !== null && LEGACY_LOCAL_FIELDS.some((k) => k in r);
}
