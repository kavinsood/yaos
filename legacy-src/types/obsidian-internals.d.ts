import type { Plugin, PluginManifest } from "obsidian";

/**
 * Obsidian runtime members that the shipped API surface (obsidian.d.ts) does
 * not declare.
 *
 * This file states each undocumented runtime assumption once. Optional members
 * force every caller to retain a safe fallback or capability-check before use,
 * while still allowing TypeScript to check the boundary.
 */
declare module "obsidian" {
	interface WorkspaceLeaf {
		/**
		 * Obsidian's per-leaf identity, used for workspace serialisation. It is
		 * present on every real leaf but absent on hand-built leaf objects, so
		 * it is declared optional: callers must supply a fallback identity
		 * (they all fall back to the file path).
		 */
		readonly id?: string;
	}

	/**
	 * Optional host adapter for Obsidian's undocumented community-plugin
	 * manager. Callers capability-check every method before use.
	 */
	interface App {
		readonly plugins?: CommunityPluginsManager;
	}

	interface CommunityPluginsManager {
		readonly manifests?: Record<string, PluginManifest & { dir?: string }>;
		readonly plugins?: Record<string, Plugin>;
		readonly enabledPlugins?: Set<string>;
		installPlugin?(repo: string, version: string, manifest: PluginManifest): Promise<void>;
		enablePluginAndSave?(id: string): Promise<boolean>;
		enablePlugin?(id: string): Promise<boolean>;
		disablePluginAndSave?(id: string): Promise<boolean>;
		disablePlugin?(id: string): Promise<void>;
		unloadPlugin?(id: string): Promise<void>;
		setEnable?(enabled: boolean): Promise<void>;
		isEnabled?(): boolean;
		uninstallPlugin?(id: string): Promise<void>;
	}
}
