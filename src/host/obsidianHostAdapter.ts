import type { App, PluginManifest, WorkspaceLeaf } from "obsidian";
import { HostPatchRegistry, type HostPatchRelease } from "./hostPatchRegistry";

export type { HostPatchRelease } from "./hostPatchRegistry";

export type CommunityPluginInstallEvent = {
	kind: "installed" | "enabled";
	id: string;
	repo?: string;
	version?: string;
	enabled: boolean;
};

export type CommunityPluginInstallCapability = {
	installPlugin: boolean;
	enablePluginAndSave: boolean;
	setEnable: boolean;
	communityEnabled: boolean;
};

export type ObsidianHostAdapter = {
	communityEnabledIds(): Set<string>;
	communityPluginVersion(id: string): string | undefined;
	communityPluginInstallCapability(): CommunityPluginInstallCapability;
	isCommunityPluginEnabled(id: string): boolean;
	communityPluginsRestricted(): boolean;
	canInstallCommunityPlugins(): boolean;
	installCommunityPlugin(repo: string, version: string, manifest: PluginManifest): Promise<void>;
	enableCommunityPlugin(id: string): Promise<boolean>;
	disableCommunityPlugin(id: string): Promise<boolean>;
	unloadCommunityPlugin(id: string): Promise<void>;
	uninstallCommunityPlugin(id: string): Promise<void>;
	removeCommunityPluginState(id: string): void;
	canInstallTheme(): boolean;
	installTheme(name: string, repo: string, version: string): Promise<void>;
	observeCommunityPluginInstalls(listener: (event: CommunityPluginInstallEvent) => void | Promise<void>): HostPatchRelease;
	refreshWorkspaceNames(): void;
};

type WorkspacePlugin = { loadData?(): unknown };
type AppInternals = App & {
	customCss?: { installTheme?(theme: { name: string; repo: string }, version: string): Promise<void> };
	internalPlugins?: {
		getPluginById?(id: string): { instance?: WorkspacePlugin } | undefined;
		plugins?: { workspaces?: { instance?: WorkspacePlugin } };
	};
};

export function leafIdentity(leaf: WorkspaceLeaf, fallbackPath: string): string {
	return typeof leaf.id === "string" && leaf.id.length > 0 ? leaf.id : fallbackPath;
}

/** The sole runtime boundary for Obsidian's undocumented plugin manager. */
export function createObsidianHostAdapter(app: App, patches = new HostPatchRegistry()): ObsidianHostAdapter {
	return {
		communityEnabledIds(): Set<string> {
			const enabled = app.plugins?.enabledPlugins;
			return enabled instanceof Set ? new Set([...enabled].filter((id): id is string => typeof id === "string")) : new Set();
		},
		communityPluginVersion(id: string): string | undefined {
			const version = app.plugins?.manifests?.[id]?.version;
			return typeof version === "string" ? version : undefined;
		},
		communityPluginInstallCapability(): CommunityPluginInstallCapability {
			const plugins = app.plugins;
			return {
				installPlugin: typeof plugins?.installPlugin === "function",
				enablePluginAndSave: typeof plugins?.enablePluginAndSave === "function",
				setEnable: typeof plugins?.setEnable === "function",
				communityEnabled: plugins?.isEnabled?.() === true,
			};
		},
		isCommunityPluginEnabled(id: string): boolean {
			return app.plugins?.enabledPlugins?.has(id) === true;
		},
		communityPluginsRestricted(): boolean {
			return app.plugins?.isEnabled?.() !== true;
		},
		canInstallCommunityPlugins(): boolean {
			return typeof app.plugins?.installPlugin === "function";
		},
		async installCommunityPlugin(repo, version, manifest): Promise<void> {
			const plugins = app.plugins;
			if (!plugins?.installPlugin) throw new Error("Obsidian does not expose installPlugin.");
			await plugins.installPlugin(repo, version, manifest);
		},
		async enableCommunityPlugin(id): Promise<boolean> {
			const plugins = app.plugins;
			return plugins?.enablePluginAndSave ? await plugins.enablePluginAndSave(id) : false;
		},
		async disableCommunityPlugin(id): Promise<boolean> {
			const plugins = app.plugins;
			if (plugins?.disablePluginAndSave) return await plugins.disablePluginAndSave(id);
			if (plugins?.disablePlugin) {
				await plugins.disablePlugin(id);
				return true;
			}
			return false;
		},
		async unloadCommunityPlugin(id): Promise<void> {
			await app.plugins?.unloadPlugin?.(id);
		},
		async uninstallCommunityPlugin(id): Promise<void> {
			await app.plugins?.uninstallPlugin?.(id);
		},
		removeCommunityPluginState(id): void {
			const plugins = app.plugins;
			plugins?.enabledPlugins?.delete(id);
			if (plugins?.plugins && id in plugins.plugins) delete plugins.plugins[id];
			if (plugins?.manifests && id in plugins.manifests) delete plugins.manifests[id];
		},
		canInstallTheme(): boolean {
			return typeof (app as AppInternals).customCss?.installTheme === "function";
		},
		async installTheme(name, repo, version): Promise<void> {
			const customCss = (app as AppInternals).customCss;
			if (!customCss?.installTheme) throw new Error("Obsidian does not expose installTheme.");
			await customCss.installTheme({ name, repo }, version);
		},
		observeCommunityPluginInstalls(listener): HostPatchRelease {
			const plugins = app.plugins;
			if (!plugins) return () => undefined;
			const releases: HostPatchRelease[] = [];
			releases.push(patches.observe(plugins, "installPlugin", (args) => {
				const [repo, version, manifest] = args;
				const id = (manifest as PluginManifest | undefined)?.id;
				if (typeof id !== "string" || typeof repo !== "string" || typeof version !== "string") return;
				return listener({ kind: "installed", id, repo, version, enabled: plugins.enabledPlugins?.has(id) === true });
			}));
			releases.push(patches.observe(plugins, "enablePluginAndSave", (args, result) => {
				const [id] = args;
				if (result !== true || typeof id !== "string") return;
				return listener({
					kind: "enabled",
					id,
					version: this.communityPluginVersion(id),
					enabled: true,
				});
			}));
			let released = false;
			return () => {
				if (released) return;
				released = true;
				for (const release of releases) release();
			};
		},
		refreshWorkspaceNames(): void {
			const internalPlugins = (app as AppInternals).internalPlugins;
			const workspacePlugin = internalPlugins?.getPluginById?.("workspaces")?.instance
				?? internalPlugins?.plugins?.workspaces?.instance;
			if (typeof workspacePlugin?.loadData === "function") void workspacePlugin.loadData();
		},
	};
}
