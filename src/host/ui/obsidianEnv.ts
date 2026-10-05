/**
 * Thin Obsidian runtime adapters for the UI: HTTP via requestUrl (CORS-free on mobile), clipboard,
 * and opening the plugin's settings tab. Not unit-tested (needs the obsidian runtime).
 */

import { requestUrl, type App } from "obsidian";
import type { HttpResponse, RequestFn } from "./pairing";

/** RequestFn backed by Obsidian's requestUrl. Never throws on HTTP status; network failures reject. */
export const obsidianRequest: RequestFn = async (req) => {
	const res = await requestUrl({
		url: req.url,
		method: req.method,
		headers: req.headers ? { ...req.headers } : undefined,
		body: req.body,
		throw: false,
	});
	let json: unknown = null;
	try {
		json = res.json as unknown;
	} catch {
		json = null;
	}
	const out: HttpResponse = { status: res.status, json };
	return out;
};

export async function copyText(text: string): Promise<void> {
	await navigator.clipboard.writeText(text);
}

interface AppSettingApi {
	open(): void;
	openTabById(id: string): unknown;
}

/** Opens Settings at this plugin's tab. Uses Obsidian's private `app.setting`; returns false if absent. */
export function openPluginSettings(app: App, pluginId: string): boolean {
	const setting = (app as unknown as { setting?: Partial<AppSettingApi> }).setting;
	if (!setting || typeof setting.open !== "function") return false;
	setting.open();
	if (typeof setting.openTabById === "function") setting.openTabById(pluginId);
	return true;
}
