/**
 * YAOS plugin entry (main thread). Wires the Obsidian adapters, the engine
 * carriers (Blob-URL worker from `virtual:yaos-engine-worker`, inline
 * fallback), the HostRuntime (through YaosController) and the UI.
 *
 * STAND-IN: the inline carrier runs engine/__standins__ (protocol-complete,
 * local only) until WP-C's createEngine lands.
 * INTEGRATION: createInline -> createEngine(pair.engine, { carrier: "inline", makePorts })
 * from engine/runtime/engine.ts.
 */

import { Notice, Platform, Plugin } from "obsidian";
import workerSource from "virtual:yaos-engine-worker";
import { createStandinEngine } from "../engine/__standins__/engine";
import { createInlinePair } from "../protocol/inlineTransport";
import { createWorkerHostTransport, type WorkerLike } from "../protocol/workerTransport";
import { attachCollab, collabCompartmentExtension, editorViewOf } from "./collab";
import { ObsidianConfigDir } from "./configDir";
import type { EngineCarrier } from "./engineHost";
import { createHasher, webCryptoHashPort } from "./hashing";
import { HostRuntime } from "./hostRuntime";
import type { VaultApi } from "./obsidianApi";
import { ObsidianVault } from "./obsidianVault";
import { ObsidianWorkspace, type WorkspaceLike } from "./obsidianWorkspace";
import { BrowserPlatform, browserClock, platformInfoFrom } from "./platform";
import { YaosController } from "./pluginController";
import { ObsidianSideFiles } from "./sideFiles";
import { defaultDeviceName, sanitizePluginData, type YaosUiHost } from "./ui/api";
import { registerUi } from "./ui/registerUi";

function workerCarrier(): EngineCarrier | null {
	if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") return null;
	let url: string | null = null;
	try {
		url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
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
	} catch {
		if (url) URL.revokeObjectURL(url);
		return null;
	}
}

function inlineCarrier(): EngineCarrier {
	const pair = createInlinePair();
	const handle = createStandinEngine(pair.engine, { carrier: "inline", clock: browserClock(), hash: webCryptoHashPort(), hub: null, store: null });
	return {
		kind: "inline",
		transport: pair.host,
		dispose: () => {
			handle.dispose();
			pair.host.close();
		},
	};
}

export default class YaosPlugin extends Plugin {
	private controller: YaosController | null = null;

	async onload(): Promise<void> {
		const app = this.app;
		const vaultApi = app.vault as unknown as VaultApi;
		const pluginDir = this.manifest.dir ?? `${app.vault.configDir}/plugins/${this.manifest.id}`;
		const clock = browserClock();
		const hasher = createHasher(webCryptoHashPort());
		const insensitive = (app.vault.adapter as unknown as { insensitive?: unknown }).insensitive;
		const caseInsensitive = typeof insensitive === "boolean" ? insensitive : Platform.isMacOS || Platform.isWin || Platform.isIosApp;
		const vault = new ObsidianVault(vaultApi, hasher, caseInsensitive);
		const configDir = new ObsidianConfigDir(vaultApi.adapter, app.vault.configDir);
		const sideFiles = new ObsidianSideFiles(vaultApi.adapter, pluginDir);
		const platform = new BrowserPlatform(platformInfoFrom(Platform, navigator as never, typeof Worker !== "undefined"), document, window, navigator);
		const workspace = new ObsidianWorkspace(app.workspace as unknown as WorkspaceLike, (editor, spec) => {
			const cm = editorViewOf(editor);
			return cm ? attachCollab(cm, spec) : null;
		});
		this.registerEditorExtension(collabCompartmentExtension());
		this.register(() => workspace.dispose());

		const data = sanitizePluginData(await this.loadData(), defaultDeviceName(Platform));
		const controller = new YaosController(data, {
			makeRuntime: (identity, settings, ui) =>
				new HostRuntime({
					clock, vault, configDir, sideFiles, workspace, platform, hasher, identity, settings, ui,
					createWorker: workerCarrier,
					createInline: inlineCarrier,
					log: (line) => console.debug(`[yaos] ${line}`),
				}),
			saveData: (d) => this.saveData(d),
			notice: (_level, message) => new Notice(message),
			log: (line) => console.debug(`[yaos] ${line}`),
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
			writeDiagnosticsFile: async (name, text) => {
				const dir = `${pluginDir}/diagnostics`;
				if (!(await vaultApi.adapter.exists(dir))) await vaultApi.adapter.mkdir(dir);
				const path = `${dir}/${name.replace(/[\\/:]/g, "_")}`;
				await vaultApi.adapter.write(path, text);
				return path;
			},
		};
		this.register(registerUi(this, host));
		// Start after the vault index is complete (no flood of initial "create" events).
		app.workspace.onLayoutReady(() => void controller.start());
	}

	async onunload(): Promise<void> {
		const c = this.controller;
		this.controller = null;
		await c?.stop();
	}
}
