/**
 * The optional clone notice (identity-per-store §8, first bullet). No correctness depends on it: a copied or synced
 * folder is a new device. But a fresh install (its install record names no store yet) that finds other stores'
 * dirs `<configDir>/plugins/yaos/state/<deviceId>/` with a mirror written in the last day is sharing the folder with
 * another sync tool, and two sync tools on one folder make conflict copies. Shown once per install (the flag is in the
 * local settings record, localSettings.ts). Pure: the scan (sideFiles.ts storeDirs) and the clock are the caller's.
 */

import { sideFileDir } from "../ports/vault";

export const CLONE_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A store dir under `state/` and the newest mtime of its mirror files (outbox-a/b, synced-a/b), null for none. */
export interface StoreDirActivity {
	readonly deviceId: string;
	readonly newestMirrorMs: number | null;
}

/** Whether another store's mirror was written within the window around `nowMs` (a skewed future mtime counts too). */
export function cloneNoticeDue(ownDeviceId: string, dirs: readonly StoreDirActivity[], nowMs: number): boolean {
	return dirs.some((d) => d.deviceId !== ownDeviceId
		&& sideFileDir(`${d.deviceId}/`) !== null
		&& d.newestMirrorMs !== null
		&& Math.abs(nowMs - d.newestMirrorMs) <= CLONE_NOTICE_WINDOW_MS);
}

/** `pluginDir` as the plugin knows it (manifest.dir, e.g. ".obsidian/plugins/yaos"): the configDir is not always ".obsidian". */
export function cloneNoticeText(pluginDir: string): string {
	return "YAOS: this vault folder looks synced by another tool as well. YAOS works, but two sync tools on one folder "
		+ `produce conflicting copies; exclude \`${pluginDir.replace(/\/$/, "")}/\` from the other tool.`;
}
