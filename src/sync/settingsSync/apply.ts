/**
 * settingsSync apply runner. Persist the planned batch to IndexedDB before the
 * first mutate; checkpoint each completed step; resume leftover work on boot.
 *
 * Apply order is the step array order (RFC). This module does not call
 * `changeLayout`. Missing installer APIs and restricted mode skip plugin
 * installs and continue file LWW. Backgrounded: pause at installPlugin /
 * installTheme. Partial batch is the contract.
 */

import { Notice, Platform, normalizePath, type App, type PluginManifest } from "obsidian";
import {
	canApplyPluginData,
	type PluginDataGateInput,
} from "./dataJsonGate";
import { isAllowlistedConfigPath, isPluginDataRelPath } from "./allowlist";
import {
	clearApplyQueue,
	loadApplyQueue,
	persistApplyQueue,
	type ApplyQueueScope,
	type PersistedApplyQueue,
} from "./applyQueue";
import { SETTINGS_SYNC_MAX_FILE_BYTES, SETTINGS_SYNC_SKIP_PLUGIN_IDS } from "./types";

const FORBIDDEN_FILES: Record<string, true> = {
	"workspace.json": true,
	"workspace-mobile.json": true,
};
const RESTART_PATHS: Record<string, true> = {
	"app.json": true,
	"hotkeys.json": true,
};

export type ApplyAdapter = {
	write(path: string, data: string): Promise<void>;
	remove?(path: string): Promise<void>;
	mkdir?(path: string): Promise<void>;
	exists?(path: string): Promise<boolean>;
	rmdir?(path: string, recursive?: boolean): Promise<void>;
};

export type ApplyPluginManifest = {
	id: string;
	name?: string;
	version: string;
	minAppVersion?: string;
	isDesktopOnly?: boolean;
	author?: string;
	description?: string;
};

export type ApplyStep =
	| { kind: "file"; path: string; body: string | null }
	| { kind: "install-theme"; name: string; repo: string; version: string }
	| { kind: "install-plugin"; id: string; repo: string; version: string; manifest: ApplyPluginManifest; isDesktopOnly?: boolean }
	| {
		kind: "plugin-data";
		pluginId: string;
		pluginVersion: string;
		body: string;
		localManifestVersion: string;
		intentVersion: string;
		tombstoned?: boolean;
	}
	| { kind: "enable-plugin"; id: string; enabled: boolean; isDesktopOnly?: boolean }
	| { kind: "uninstall-plugin"; id: string }
	| { kind: "uninstall-theme"; name: string };

export type ApplyBatch = {
	key: string;
	steps: ApplyStep[];
};

export type ApplyQueueRunResult = "none" | "invalid" | "paused" | "complete";

export type ApplyContext = {
	app: App;
	adapter: ApplyAdapter;
	configDir: string;
	hostHash: string;
	vaultId: string;
	vaultGeneration: string;
	folderKey: string;
	deviceId: string;
	configDirKey: string;
	indexedDb?: Pick<IDBFactory, "open">;
	isHidden?: () => boolean;
	isMobile?: boolean;
	isActive?: () => boolean;
	notice?: (message: string) => void;
	recordReason?: (code: string, detail?: string) => void;
	refreshWorkspaceNames?: () => void;
	/** Test seam: throw to abort the run without checkpointing the current step. */
	beforeStep?: (index: number, step: ApplyStep) => void | Promise<void>;
};

type CommunityPlugins = NonNullable<App["plugins"]>;

type CustomCss = {
	installTheme?: (theme: { name: string; repo: string }, version?: string) => Promise<void>;
};

type WorkspacesInstance = {
	loadData?: () => unknown;
	changeLayout?: (layout: unknown) => void;
};

type AppExtras = App & {
	customCss?: CustomCss;
	internalPlugins?: {
		getPluginById?: (id: string) => { instance?: WorkspacesInstance } | null;
		plugins?: Record<string, { instance?: WorkspacesInstance }>;
	};
};

/**
 * Write the planned batch to IndexedDB, then run it. Must not mutate disk
 * until that persist has committed.
 */
export async function persistAndRunApplyBatch(
	ctx: ApplyContext,
	batch: ApplyBatch,
): Promise<Exclude<ApplyQueueRunResult, "none" | "invalid">> {
	if (batch.key !== ctx.configDirKey) throw new Error("settings apply batch identity mismatch");
	const identity = scopeOf(ctx);
	const record: PersistedApplyQueue = {
		version: 1,
		identity: {
			hostHash: identity.hostHash,
			vaultId: identity.vaultId,
			vaultGeneration: identity.vaultGeneration,
			folderKey: identity.folderKey,
			deviceId: identity.deviceId,
			configDirKey: identity.configDirKey,
		},
		steps: batch.steps,
		nextIndex: 0,
	};
	await persistApplyQueue(identity, record);
	return runPersistedQueue(ctx, record);
}

/** Resume leftover work only for the exact current enrollment/folder/config identity. */
export async function resumeApplyQueue(ctx: ApplyContext): Promise<ApplyQueueRunResult> {
	const record = await loadApplyQueue(scopeOf(ctx));
	if (!record) return "none";
	if (record.steps.some((step) => parseApplyStep(step) === null)) return "invalid";
	return runPersistedQueue(ctx, record);
}

function scopeOf(ctx: ApplyContext): ApplyQueueScope {
	return {
		hostHash: ctx.hostHash,
		vaultId: ctx.vaultId,
		vaultGeneration: ctx.vaultGeneration,
		folderKey: ctx.folderKey,
		deviceId: ctx.deviceId,
		configDirKey: ctx.configDirKey,
		indexedDb: ctx.indexedDb,
	};
}

async function runPersistedQueue(
	ctx: ApplyContext,
	record: PersistedApplyQueue,
): Promise<"paused" | "complete"> {
	const scope = scopeOf(ctx);
	let wroteRestartSensitive = false;

	for (let i = record.nextIndex; i < record.steps.length; i++) {
		if (ctx.isActive?.() === false) {
			record.nextIndex = i;
			await persistApplyQueue(scope, record);
			return "paused";
		}
		const step = parseApplyStep(record.steps[i]);
		if (step && shouldPauseForBackground(ctx, step)) {
			record.nextIndex = i;
			await persistApplyQueue(scope, record);
			emitReason(ctx, "settings.backgrounded", stepKindDetail(step));
			if (wroteRestartSensitive) emitRestartNotice(ctx);
			return "paused";
		}
		if (ctx.beforeStep && step) await ctx.beforeStep(i, step);
		if (ctx.isActive?.() === false) {
			record.nextIndex = i;
			await persistApplyQueue(scope, record);
			return "paused";
		}
		try {
			if (!step) emitReason(ctx, "settings.invalid_step", "unrecognized apply step");
			else {
				const result = await executeStep(ctx, step);
				if (result.restartNotice) wroteRestartSensitive = true;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			emitReason(ctx, "settings.apply_step_failed", message);
			emitNotice(ctx, `YAOS: settings apply skipped a step (${message}).`, 8000);
		}
		record.nextIndex = i + 1;
		await persistApplyQueue(scope, record);
	}

	await clearApplyQueue(scope);
	if (wroteRestartSensitive) emitRestartNotice(ctx);
	return "complete";
}

function shouldPauseForBackground(ctx: ApplyContext, step: ApplyStep): boolean {
	if (step.kind !== "install-plugin" && step.kind !== "install-theme") return false;
	if (ctx.isHidden) return ctx.isHidden();
	return typeof document !== "undefined" && document.visibilityState === "hidden";
}

async function executeStep(ctx: ApplyContext, step: ApplyStep): Promise<{ restartNotice: boolean }> {
	switch (step.kind) {
		case "file":
			return { restartNotice: await applyFile(ctx, step.path, step.body) };
		case "install-theme":
			await applyInstallTheme(ctx, step);
			return { restartNotice: false };
		case "install-plugin":
			await applyInstallPlugin(ctx, step);
			return { restartNotice: false };
		case "plugin-data":
			await applyPluginData(ctx, step);
			return { restartNotice: false };
		case "enable-plugin":
			await applyEnablePlugin(ctx, step);
			return { restartNotice: false };
		case "uninstall-plugin":
			await applyUninstallPlugin(ctx, step.id);
			return { restartNotice: false };
		case "uninstall-theme":
			await applyUninstallTheme(ctx, step.name);
			return { restartNotice: false };
	}
}

async function applyFile(
	ctx: ApplyContext,
	relPath: string,
	body: string | null,
	allowPluginData = false,
): Promise<boolean> {
	const path = relPath.replace(/\\/g, "/");
	if (
		!isAllowlistedConfigPath(path)
		|| (isPluginDataRelPath(path) && !allowPluginData)
		|| path in FORBIDDEN_FILES
		|| isYaosPluginPath(path)
	) {
		emitReason(ctx, "settings.forbidden_path", path);
		return false;
	}
	const dest = normalizePath(`${ctx.configDir}/${path}`);
	if (body === null) {
		try {
			await ctx.adapter.remove?.(dest);
		} catch {
			// Absence already holds.
		}
		return false;
	}
	if (utf8Bytes(body) > SETTINGS_SYNC_MAX_FILE_BYTES) {
		emitReason(ctx, "settings.oversized", path);
		emitNotice(ctx, `YAOS: skipped oversized settings file ${path}.`, 8000);
		return false;
	}
	if (path.endsWith(".json")) {
		try {
			JSON.parse(body);
		} catch {
			emitReason(ctx, "settings.invalid_json", path);
			emitNotice(ctx, `YAOS: kept local ${path} (inbound JSON failed quarantine).`, 8000);
			return false;
		}
	}
	await ensureParentDirs(ctx.adapter, dest);
	await ctx.adapter.write(dest, body);
	if (path === "workspaces.json") refreshWorkspaceNames(ctx);
	return path in RESTART_PATHS;
}

async function applyInstallTheme(
	ctx: ApplyContext,
	step: Extract<ApplyStep, { kind: "install-theme" }>,
): Promise<void> {
	const extras: AppExtras = ctx.app;
	const css = extras.customCss;
	if (!css || typeof css.installTheme !== "function") {
		emitReason(ctx, "settings.missing_api", "installTheme");
		emitNotice(ctx, `YAOS: cannot install theme ${step.name} on this Obsidian build.`, 8000);
		return;
	}
	try {
		await css.installTheme({ name: step.name, repo: step.repo }, step.version);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		emitReason(ctx, "settings.install_failed", `${step.name}: ${message}`);
		emitNotice(ctx, `YAOS: theme ${step.name} failed to install (${message}).`, 8000);
	}
}

async function applyInstallPlugin(
	ctx: ApplyContext,
	step: Extract<ApplyStep, { kind: "install-plugin" }>,
): Promise<void> {
	if (isProtectedPluginId(step.id)) {
		emitReason(ctx, "settings.forbidden_plugin", step.id);
		return;
	}
	if (isMobile(ctx) && step.isDesktopOnly) {
		emitReason(ctx, "settings.desktop_only", step.id);
		return;
	}
	const plugins: CommunityPlugins | undefined = ctx.app.plugins;
	if (!plugins || plugins.isEnabled?.() !== true) {
		emitReason(ctx, "settings.restricted", step.id);
		emitNotice(ctx, "YAOS: community plugins are restricted. Plugin install skipped.", 8000);
		return;
	}
	if (typeof plugins.installPlugin !== "function") {
		emitReason(ctx, "settings.missing_api", "installPlugin");
		emitNotice(
			ctx,
			`YAOS: this Obsidian build cannot install plugins. Install manually: obsidian://show-plugin?id=${step.id}`,
			8000,
		);
		return;
	}
	const installed = plugins.manifests?.[step.id];
	if (installed?.version === step.version) return;
	try {
		const manifest: PluginManifest = {
			id: step.manifest.id,
			name: step.manifest.name ?? step.id,
			author: step.manifest.author ?? "",
			version: step.manifest.version,
			minAppVersion: step.manifest.minAppVersion ?? "0.0.0",
			description: step.manifest.description ?? "",
			isDesktopOnly: step.manifest.isDesktopOnly,
		};
		await plugins.installPlugin(step.repo, step.version, manifest);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		emitReason(ctx, "settings.install_failed", `${step.id}: ${message}`);
		emitNotice(ctx, `YAOS: plugin ${step.id} failed to install (${message}).`, 8000);
	}
}

async function applyPluginData(
	ctx: ApplyContext,
	step: Extract<ApplyStep, { kind: "plugin-data" }>,
): Promise<void> {
	if (isProtectedPluginId(step.pluginId)) {
		emitReason(ctx, "settings.forbidden_plugin", step.pluginId);
		return;
	}
	const gate: PluginDataGateInput = {
		pluginId: step.pluginId,
		localManifestVersion: step.localManifestVersion,
		intentVersion: step.intentVersion,
		pluginVersion: step.pluginVersion,
		tombstoned: step.tombstoned === true,
	};
	if (!canApplyPluginData(gate)) {
		emitReason(ctx, "settings.plugin_version_mismatch", step.pluginId);
		emitNotice(
			ctx,
			`YAOS: settingsSync hold — plugin ${step.pluginId} local ${step.localManifestVersion} pin ${step.intentVersion}. Update plugin or promote pin.`,
			10000,
		);
		return;
	}
	await applyFile(ctx, `plugins/${step.pluginId}/data.json`, step.body, true);
}

async function applyEnablePlugin(
	ctx: ApplyContext,
	step: Extract<ApplyStep, { kind: "enable-plugin" }>,
): Promise<void> {
	if (isProtectedPluginId(step.id)) {
		emitReason(ctx, "settings.forbidden_plugin", step.id);
		return;
	}
	if (isMobile(ctx) && step.isDesktopOnly) {
		emitReason(ctx, "settings.desktop_only", step.id);
		return;
	}
	const plugins: CommunityPlugins | undefined = ctx.app.plugins;
	if (!plugins || plugins.isEnabled?.() !== true) {
		emitReason(ctx, "settings.restricted", step.id);
		return;
	}
	if (step.enabled) {
		if (plugins.enabledPlugins?.has(step.id)) return;
		if (!plugins.manifests?.[step.id]) {
			emitReason(ctx, "settings.enable_missing", step.id);
			return;
		}
		if (typeof plugins.enablePluginAndSave !== "function") {
			emitReason(ctx, "settings.missing_api", "enablePluginAndSave");
			emitNotice(
				ctx,
				`YAOS: enable ${step.id} manually: obsidian://show-plugin?id=${step.id}`,
				8000,
			);
			return;
		}
		try {
			await plugins.enablePluginAndSave(step.id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			emitReason(ctx, "settings.enable_failed", `${step.id}: ${message}`);
		}
		return;
	}
	if (plugins.enabledPlugins && !plugins.enabledPlugins.has(step.id)) return;
	if (typeof plugins.disablePluginAndSave !== "function") {
		emitReason(ctx, "settings.missing_api", "disablePluginAndSave");
		return;
	}
	try {
		await plugins.disablePluginAndSave(step.id);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		emitReason(ctx, "settings.disable_failed", `${step.id}: ${message}`);
	}
}

async function applyUninstallPlugin(ctx: ApplyContext, id: string): Promise<void> {
	if (isProtectedPluginId(id)) {
		emitReason(ctx, "settings.forbidden_plugin", id);
		return;
	}
	const plugins = ctx.app.plugins;
	let hostFailed = false;
	try {
		if (plugins?.enabledPlugins?.has(id)) {
			if (typeof plugins.disablePluginAndSave === "function") await plugins.disablePluginAndSave(id);
			else if (typeof plugins.disablePlugin === "function") await plugins.disablePlugin(id);
		}
	} catch (error) {
		hostFailed = true;
		const message = error instanceof Error ? error.message : String(error);
		emitReason(ctx, "settings.disable_failed", `${id}: ${message}`);
	}
	try {
		if (typeof plugins?.unloadPlugin === "function") await plugins.unloadPlugin(id);
	} catch (error) {
		hostFailed = true;
		const message = error instanceof Error ? error.message : String(error);
		emitReason(ctx, "settings.unload_failed", `${id}: ${message}`);
	}
	try {
		if (typeof plugins?.uninstallPlugin === "function") await plugins.uninstallPlugin(id);
	} catch (error) {
		hostFailed = true;
		const message = error instanceof Error ? error.message : String(error);
		emitReason(ctx, "settings.uninstall_failed", `${id}: ${message}`);
	}
	plugins?.enabledPlugins?.delete(id);
	if (plugins?.plugins && id in plugins.plugins) delete plugins.plugins[id];
	if (plugins?.manifests && id in plugins.manifests) delete plugins.manifests[id];
	const folder = normalizePath(`${ctx.configDir}/plugins/${id}`);
	let removed = false;
	try {
		if (ctx.adapter.rmdir) {
			await ctx.adapter.rmdir(folder, true);
			removed = true;
		} else if (ctx.adapter.remove) {
			await ctx.adapter.remove(folder);
			removed = true;
		} else {
			emitReason(ctx, "settings.uninstall_no_rmdir", id);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		emitReason(ctx, "settings.uninstall_rmdir_failed", `${id}: ${message}`);
	}
	if (removed && hostFailed) {
		emitReason(ctx, "settings.plugin_removed_restart", id);
		emitNotice(
			ctx,
			`YAOS: ${id} files were removed, but Obsidian failed to unload the plugin. Restart Obsidian immediately.`,
			12000,
		);
	}
}

async function applyUninstallTheme(ctx: ApplyContext, name: string): Promise<void> {
	if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
		emitReason(ctx, "settings.invalid_theme", name);
		return;
	}
	const folder = normalizePath(`${ctx.configDir}/themes/${name}`);
	try {
		if (ctx.adapter.rmdir) await ctx.adapter.rmdir(folder, true);
		else if (ctx.adapter.remove) await ctx.adapter.remove(folder);
		else {
			emitReason(ctx, "settings.theme_uninstall_no_rmdir", name);
			return;
		}
		emitReason(ctx, "settings.theme_removed_restart", name);
		emitNotice(ctx, `YAOS: removed theme ${name}. Restart Obsidian if it was active.`, 10000);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		emitReason(ctx, "settings.theme_uninstall_failed", `${name}: ${message}`);
	}
}

function refreshWorkspaceNames(ctx: ApplyContext): void {
	if (ctx.refreshWorkspaceNames) {
		ctx.refreshWorkspaceNames();
		return;
	}
	const extras: AppExtras = ctx.app;
	const instance =
		extras.internalPlugins?.getPluginById?.("workspaces")?.instance
		?? extras.internalPlugins?.plugins?.workspaces?.instance;
	if (instance && typeof instance.loadData === "function") {
		void instance.loadData();
	}
}

function parseApplyStep(raw: unknown): ApplyStep | null {
	if (typeof raw !== "object" || raw === null) return null;
	if (!("kind" in raw) || typeof raw.kind !== "string") return null;
	switch (raw.kind) {
		case "file": {
			if (!("path" in raw) || typeof raw.path !== "string") return null;
			if (!("body" in raw)) return null;
			if (raw.body !== null && typeof raw.body !== "string") return null;
			return { kind: "file", path: raw.path, body: raw.body };
		}
		case "install-theme": {
			if (!("name" in raw) || typeof raw.name !== "string") return null;
			if (!("repo" in raw) || typeof raw.repo !== "string") return null;
			if (!("version" in raw) || typeof raw.version !== "string") return null;
			return { kind: "install-theme", name: raw.name, repo: raw.repo, version: raw.version };
		}
		case "install-plugin": {
			if (!("id" in raw) || typeof raw.id !== "string") return null;
			if (!("repo" in raw) || typeof raw.repo !== "string") return null;
			if (!("version" in raw) || typeof raw.version !== "string") return null;
			if (!("manifest" in raw) || typeof raw.manifest !== "object" || raw.manifest === null) return null;
			const manifestRaw = raw.manifest;
			if (!("id" in manifestRaw) || typeof manifestRaw.id !== "string") return null;
			if (!("version" in manifestRaw) || typeof manifestRaw.version !== "string") return null;
			const manifest: ApplyPluginManifest = {
				id: manifestRaw.id,
				version: manifestRaw.version,
			};
			if ("name" in manifestRaw && typeof manifestRaw.name === "string") manifest.name = manifestRaw.name;
			if ("minAppVersion" in manifestRaw && typeof manifestRaw.minAppVersion === "string") {
				manifest.minAppVersion = manifestRaw.minAppVersion;
			}
			if ("isDesktopOnly" in manifestRaw && manifestRaw.isDesktopOnly === true) manifest.isDesktopOnly = true;
			if ("author" in manifestRaw && typeof manifestRaw.author === "string") manifest.author = manifestRaw.author;
			if ("description" in manifestRaw && typeof manifestRaw.description === "string") {
				manifest.description = manifestRaw.description;
			}
			return {
				kind: "install-plugin",
				id: raw.id,
				repo: raw.repo,
				version: raw.version,
				manifest,
				isDesktopOnly: "isDesktopOnly" in raw && raw.isDesktopOnly === true,
			};
		}
		case "plugin-data": {
			if (!("pluginId" in raw) || typeof raw.pluginId !== "string") return null;
			if (!("pluginVersion" in raw) || typeof raw.pluginVersion !== "string") return null;
			if (!("body" in raw) || typeof raw.body !== "string") return null;
			if (!("localManifestVersion" in raw) || typeof raw.localManifestVersion !== "string") return null;
			if (!("intentVersion" in raw) || typeof raw.intentVersion !== "string") return null;
			return {
				kind: "plugin-data",
				pluginId: raw.pluginId,
				pluginVersion: raw.pluginVersion,
				body: raw.body,
				localManifestVersion: raw.localManifestVersion,
				intentVersion: raw.intentVersion,
				tombstoned: "tombstoned" in raw && raw.tombstoned === true,
			};
		}
		case "enable-plugin": {
			if (!("id" in raw) || typeof raw.id !== "string") return null;
			if (!("enabled" in raw) || typeof raw.enabled !== "boolean") return null;
			return {
				kind: "enable-plugin",
				id: raw.id,
				enabled: raw.enabled,
				isDesktopOnly: "isDesktopOnly" in raw && raw.isDesktopOnly === true,
			};
		}
		case "uninstall-plugin": {
			if (!("id" in raw) || typeof raw.id !== "string") return null;
			return { kind: "uninstall-plugin", id: raw.id };
		}
		case "uninstall-theme": {
			if (!("name" in raw) || typeof raw.name !== "string") return null;
			return { kind: "uninstall-theme", name: raw.name };
		}
		default:
			return null;
	}
}

async function ensureParentDirs(adapter: ApplyAdapter, fullPath: string): Promise<void> {
	if (!adapter.mkdir) return;
	const absolute = fullPath.startsWith("/");
	const parts = fullPath.split("/").filter((part) => part.length > 0);
	parts.pop();
	let current = absolute ? "/" : "";
	for (const part of parts) {
		current = current === "" || current === "/" ? `${current}${part}` : `${current}/${part}`;
		try {
			await adapter.mkdir(current);
		} catch {
			// Directory already exists.
		}
	}
}

function isProtectedPluginId(id: string): boolean {
	return (SETTINGS_SYNC_SKIP_PLUGIN_IDS as readonly string[]).includes(id);
}

function isYaosPluginPath(path: string): boolean {
	return path === "plugins/yaos"
		|| path.startsWith("plugins/yaos/")
		|| path === "plugins/yaos-qa-harness"
		|| path.startsWith("plugins/yaos-qa-harness/");
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).length;
}

function isMobile(ctx: ApplyContext): boolean {
	return ctx.isMobile ?? Platform.isMobile;
}

function emitNotice(ctx: ApplyContext, message: string, timeout?: number): void {
	if (ctx.notice) {
		ctx.notice(message);
		return;
	}
	new Notice(message, timeout);
}

function emitReason(ctx: ApplyContext, code: string, detail?: string): void {
	ctx.recordReason?.(code, detail);
}

function emitRestartNotice(ctx: ApplyContext): void {
	emitNotice(
		ctx,
		"YAOS: app.json / hotkeys changed. Restart Obsidian to apply them fully.",
		8000,
	);
}

function stepKindDetail(step: ApplyStep): string {
	switch (step.kind) {
		case "file":
			return step.path;
		case "install-theme":
		case "uninstall-theme":
			return step.name;
		case "install-plugin":
		case "enable-plugin":
		case "uninstall-plugin":
			return step.id;
		case "plugin-data":
			return step.pluginId;
	}
}
