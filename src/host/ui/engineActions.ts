/**
 * Engine actions offered both in the settings tab and the command palette, so their confirm copy
 * and notices are written once.
 */

import { Notice, type App } from "obsidian";
import type { YaosUiHost } from "./api";
import { confirmAction } from "./confirmModal";
import { errorMessage } from "./format";

export const REBUILD_CACHE_CONFIRM = Object.freeze({
	title: "Rebuild local cache?",
	message: "YAOS discards this device's sync database and rebuilds it from the files in this vault and the server. Unsent edits are kept. Files that differ from the server get conflict copies; nothing is deleted.\n\nThis can take a while on large vaults.",
	confirmText: "Rebuild",
});

/** Asks first, then sends rebuildLocalCache. Resolves when done, failed (with a notice) or cancelled. */
export async function confirmAndRebuildCache(app: App, host: Pick<YaosUiHost, "command">): Promise<void> {
	if (!(await confirmAction(app, REBUILD_CACHE_CONFIRM))) return;
	try {
		await host.command({ t: "rebuildLocalCache" });
		new Notice("YAOS: rebuilding the local cache.");
	} catch (err) {
		new Notice(`YAOS: ${errorMessage(err)}`, 8000);
	}
}

export async function restartSyncEngine(host: Pick<YaosUiHost, "restartEngine">): Promise<void> {
	try {
		await host.restartEngine();
		new Notice("YAOS: sync engine restarted.");
	} catch (err) {
		new Notice(`YAOS: could not restart the sync engine: ${errorMessage(err)}`, 8000);
	}
}
