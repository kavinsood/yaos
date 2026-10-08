/**
 * YAOS plugin entry (main thread). Wires the Obsidian adapters, the engine
 * carrier (a Blob-URL worker started from this bundle's own source, see
 * bundleSource.ts), the HostRuntime (through YaosController) and the UI.
 * The engine only ever runs in that worker: when it cannot start or dies,
 * the runtime stops and says why (engineHost.ts). Loaded through entry.ts.
 */

import { Notice, Platform, Plugin } from "obsidian";
import { createWorkerHostTransport, type WorkerLike } from "../protocol/workerTransport";
import { workerScript } from "./bundleSource";
import { codeMirrorEditors, collabExtension } from "./collab";
import { ObsidianConfigDir } from "./configDir";
import type { EngineCarrier } from "./engineHost";
import { engineHashOracle } from "./hashOracle";
import { HostRuntime } from "./hostRuntime";
import type { VaultApi } from "./obsidianApi";
import { ObsidianVault } from "./obsidianVault";
import { ObsidianWorkspace, type WorkspaceLike } from "./obsidianWorkspace";
import { BrowserPlatform, browserClock, platformInfoFrom } from "./platform";
import { YaosController } from "./pluginController";
import { ObsidianSideFiles } from "./sideFiles";
import { defaultDeviceName, sanitizePluginData, type YaosUiHost } from "./ui/api";
import { errorMessage } from "./ui/format";
import { obsidianRequest } from "./ui/obsidianEnv";
import { resumePendingEnrollment, type ResumedEnrollment } from "./ui/pairFlow";
import { retireDeviceEnrollment } from "./ui/pairing";
import { registerUi } from "./ui/registerUi";

function resumedEnrollmentNotice(r: ResumedEnrollment | null): void {
	if (r?.ok) new Notice(`YAOS: this device is now paired with ${r.identity.host}.`);
	else if (r && r.final) new Notice(`YAOS: an interrupted pairing could not finish: ${errorMessage(r.error)}`, 8000);
	// Best effort and not awaited, so the engine start does not wait on the old server.
	if (r?.ok && r.replaced) retireDeviceEnrollment(r.replaced, { request: obsidianRequest }).catch((err: unknown) => new Notice(`YAOS: ${errorMessage(err)}`, 9000));
}

/** The engine's carrier. Throws, with the reason, when the worker cannot be built (terminal: EngineHost). */
function workerCarrier(): EngineCarrier {
	if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") {
		throw new Error("this app cannot run background workers (Worker or Blob URLs are unavailable)");
	}
	const script = workerScript();
	if (script === null) throw new Error("the plugin's main.js is not the YAOS bundle, so it cannot start its background worker");
	let url: string | null = null;
	try {
		url = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
		const worker = new Worker(url, { name: "yaos-engine" });
		const transport = createWorkerHostTransport(worker as unknown as WorkerLike);
		const u = url;
		return {
			kind: "worker",
			transport,
			dispose: () => {
				transport.close();
				URL.revokeObjectURL(u);
			},
		};
	} catch (error) {
		if (url) URL.revokeObjectURL(url);
		throw new Error(`creating the background worker failed: ${errorMessage(error)}`);
	}
}

export default class YaosPlugin extends Plugin {
	private controller: YaosController | null = null;

	async onload(): Promise<void> {
		const app = this.app;
		const vaultApi = app.vault as unknown as VaultApi;
		const pluginDir = this.manifest.dir ?? `${app.vault.configDir}/plugins/${this.manifest.id}`;
		const clock = browserClock();
		// Main never hashes (DESIGN §d.2, §f.2): vault preconditions are hashed by the running engine. The vault
		// outlives runtimes (the controller makes a new one per start), so it asks whichever is live.
		let live: HostRuntime | null = null;
		const hashes = engineHashOracle((body) => (live ? live.engine.request(body) : Promise.reject(new Error("sync engine not running"))));
		const insensitive = (app.vault.adapter as unknown as { insensitive?: unknown }).insensitive;
		const caseInsensitive = typeof insensitive === "boolean" ? insensitive : Platform.isMacOS || Platform.isWin || Platform.isIosApp;
		const vault = new ObsidianVault(vaultApi, hashes, caseInsensitive);
		const configDir = new ObsidianConfigDir(vaultApi.adapter, app.vault.configDir);
		const sideFiles = new ObsidianSideFiles(vaultApi.adapter, pluginDir);
		const platform = new BrowserPlatform(platformInfoFrom(Platform, navigator as never, typeof Worker !== "undefined"), document, window, navigator);
		const workspace = new ObsidianWorkspace(app.workspace as unknown as WorkspaceLike, codeMirrorEditors);
		this.registerEditorExtension(collabExtension());
		this.register(() => workspace.dispose());

		const data = sanitizePluginData(await this.loadData(), defaultDeviceName(Platform));
		const controller = new YaosController(data, {
			makeRuntime: (identity, settings, ui, keys) =>
				(live = new HostRuntime({
					clock, vault, configDir, sideFiles, workspace, platform, identity, settings, ui, keys,
					createCarrier: workerCarrier,
					log: (line) => console.debug(`[yaos] ${line}`),
				})),
			saveData: (d) => this.saveData(d),
			notice: (_level, message, timeoutMs) => new Notice(message, timeoutMs),
			log: (line) => console.debug(`[yaos] ${line}`),
			clock,
			// obsidian.d.ts :458 (@since 1.11.4); undefined on an older app, which then holds no key (fail closed).
			secrets: (app as { secretStorage?: typeof app.secretStorage }).secretStorage ?? null,
			localStorage: { load: (k) => app.loadLocalStorage(k) as unknown, save: (k, v) => app.saveLocalStorage(k, v) },
		});
		this.controller = controller;

		const host: YaosUiHost = {
			app,
			pluginVersion: this.manifest.version,
			data: () => controller.data(),
			updateData: (mutate) => controller.updateData(mutate),
			status: () => controller.status(),
			runState: () => controller.runState(),
			onChange: (l) => controller.onChange(l),
			command: (c) => controller.command(c),
			restartEngine: () => controller.restartEngine(),
			brake: () => controller.brake(),
			markCreating: (vaultId) => controller.markCreating(vaultId),
			abandonCreating: (vaultId) => controller.abandonCreating(vaultId),
			rkChecksum: (secret) => controller.rkChecksum(secret),
			vaultKeyForQr: () => controller.vaultKeyForQr(),
			deviceCheck: (mode) => controller.deviceCheck(mode),
			writeDiagnosticsFile: async (name, text) => {
				const dir = `${pluginDir}/diagnostics`;
				if (!(await vaultApi.adapter.exists(dir))) await vaultApi.adapter.mkdir(dir);
				const path = `${dir}/${name.replace(/[\\/:]/g, "_")}`;
				await vaultApi.adapter.write(path, text);
				return path;
			},
		};
		this.register(registerUi(this, host));
		// Start after the vault index is complete (no flood of initial "create" events), and after one
		// retry of an enrollment the last session sent without seeing the answer (none: no request).
		app.workspace.onLayoutReady(() => {
			void resumePendingEnrollment(host, { request: obsidianRequest })
				.then(resumedEnrollmentNotice, () => undefined)
				.then(() => controller.start());
		});
	}

	async onunload(): Promise<void> {
		const c = this.controller;
		this.controller = null;
		await c?.stop();
	}
}
