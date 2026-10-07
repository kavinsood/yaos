/**
 * Thin Obsidian runtime adapters for the UI: HTTP via requestUrl (CORS-free on mobile), clipboard,
 * and opening the plugin's settings tab. Not unit-tested (needs the obsidian runtime).
 */

import { requestUrl, type App } from "obsidian";
import type { HttpResponse, RequestFn } from "./pairing";

/**
 * RequestFn backed by Obsidian's requestUrl. Never throws on HTTP status; network failures reject.
 *
 * Headers, including `Origin` and `Cookie` (the creation path, pairing.ts operatorHeaders), are passed as given. On
 * desktop requestUrl runs Electron's `net.request` in the main process and sets each header with `setHeader`, and
 * Electron maps `origin` to the URL loader's origin (the `request-url` IPC handler of Obsidian's app.asar main.js,
 * installer 1.12.7; Electron 39.8.3 `ClientRequest._startRequest`);
 * whether every header arrives as set on mobile is [U] (e2ee-design §23.3). A refused `Origin` is answered 403
 * forbidden_origin, which the caller reports. Response headers come back lower-cased; `set-cookie` may be an array.
 */
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
	const headers: Record<string, string | readonly string[]> = {};
	const raw = res.headers as Readonly<Record<string, unknown>> | undefined;
	for (const [name, value] of Object.entries(raw ?? {})) {
		if (typeof value === "string") headers[name.toLowerCase()] = value;
		else if (Array.isArray(value)) headers[name.toLowerCase()] = value.filter((v): v is string => typeof v === "string");
	}
	const out: HttpResponse = { status: res.status, json, headers };
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
