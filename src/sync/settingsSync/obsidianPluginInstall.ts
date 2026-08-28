import { Notice, Platform, apiVersion, requestUrl, type App, type PluginManifest } from "obsidian";
import { ConfirmModal } from "../../ui/ConfirmModal";
import {
	detectPluginInstallCapability,
	planPluginApply,
	type PluginIntent,
} from "./pluginIntent";

export const COMMUNITY_PLUGINS_CATALOG_URL =
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";

export const SMOKE_CALENDAR_INTENT: PluginIntent = {
	id: "calendar",
	repo: "liamcain/obsidian-calendar-plugin",
	version: "",
	enabled: true,
};

export type CatalogEntry = { id: string; repo: string; name?: string };

export type InstallSmokeResult =
	| { kind: "cancelled" }
	| { kind: "failed"; reason: string }
	| { kind: "skipped"; reason: string }
	| { kind: "installed"; id: string; version: string; enabled: boolean };

type CatalogLookup = (id: string) => Promise<CatalogEntry | null>;
type ManifestLookup = (repo: string) => Promise<PluginManifest | null>;

export async function confirmAndSmokeInstallCalendar(app: App): Promise<InstallSmokeResult> {
	return await new Promise((resolve) => {
		new ConfirmModal(
			app,
			"Install Calendar via Obsidian?",
			"This is a settings-sync smoke, not live sync. YAOS will ask Obsidian to download the Calendar community plugin from GitHub using undocumented install APIs, then enable it. Cancel if this vault should stay untouched.",
			() => {
				void runSmokeInstallCalendar(app).then(resolve);
			},
			"Install Calendar",
			"Cancel",
			() => resolve({ kind: "cancelled" }),
		).open();
	});
}

export async function runSmokeInstallCalendar(
	app: App,
	deps: { lookupCatalog?: CatalogLookup; lookupManifest?: ManifestLookup } = {},
): Promise<InstallSmokeResult> {
	const plugins = app.plugins;
	const capability = detectPluginInstallCapability({
		installPlugin: plugins?.installPlugin?.bind(plugins),
		enablePluginAndSave: plugins?.enablePluginAndSave?.bind(plugins),
		setEnable: plugins?.setEnable?.bind(plugins),
		isEnabled: plugins?.isEnabled?.bind(plugins),
	});

	if (typeof plugins?.installPlugin !== "function" || typeof plugins.enablePluginAndSave !== "function") {
		return { kind: "failed", reason: "This Obsidian build does not expose installPlugin/enablePluginAndSave." };
	}
	if (!capability.communityEnabled) {
		return { kind: "failed", reason: "Community plugins are restricted. Turn off Restricted mode, then retry." };
	}

	const catalog = await (deps.lookupCatalog ?? lookupCatalogEntry)(SMOKE_CALENDAR_INTENT.id);
	if (!catalog || catalog.id !== SMOKE_CALENDAR_INTENT.id || !catalog.repo) {
		return { kind: "failed", reason: "Calendar was not found in the community catalog." };
	}
	const manifest = await (deps.lookupManifest ?? lookupRepoManifest)(catalog.repo);
	if (!manifest || manifest.id !== SMOKE_CALENDAR_INTENT.id) {
		return { kind: "failed", reason: "Could not load Calendar's manifest.json from GitHub." };
	}

	const intent: PluginIntent = {
		id: SMOKE_CALENDAR_INTENT.id,
		repo: catalog.repo,
		version: manifest.version,
		enabled: true,
	};
	const alreadyEnabled = plugins.enabledPlugins?.has(intent.id) === true;
	const plan = planPluginApply({
		intent,
		capability,
		installedVersion: plugins.manifests?.[intent.id]?.version ?? null,
		alreadyEnabled,
		manifest,
		isMobile: Platform.isMobile,
		apiVersion,
	});

	if (plan.kind === "desktop-only") {
		return { kind: "skipped", reason: "Calendar is marked desktop-only on this device." };
	}
	if (plan.kind === "min-app-version") {
		return {
			kind: "failed",
			reason: `Calendar requires Obsidian ${plan.minAppVersion}; this app is ${plan.apiVersion}.`,
		};
	}
	if (plan.kind === "already-current") {
		return {
			kind: "skipped",
			reason: alreadyEnabled
				? `Calendar ${intent.version} is already installed and enabled.`
				: `Calendar ${intent.version} is already installed.`,
		};
	}
	if (plan.kind === "unsupported-api" || plan.kind === "restricted" || plan.kind === "unknown-id") {
		return { kind: "failed", reason: `Cannot apply Calendar (${plan.kind}).` };
	}

	try {
		if (plan.kind === "install-then-enable" || plan.kind === "install-only") {
			await plugins.installPlugin(intent.repo, intent.version, manifest);
		}
		let enabled = alreadyEnabled;
		if (plan.kind === "install-then-enable" || plan.kind === "enable-only") {
			enabled = (await plugins.enablePluginAndSave(intent.id)) === true;
		}
		return { kind: "installed", id: intent.id, version: intent.version, enabled };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { kind: "failed", reason: `Obsidian install failed: ${message}` };
	}
}

export function noticeForInstallResult(result: InstallSmokeResult): void {
	if (result.kind === "cancelled") return;
	if (result.kind === "installed") {
		new Notice(
			result.enabled
				? `YAOS: installed ${result.id} ${result.version} via Obsidian.`
				: `YAOS: downloaded ${result.id} ${result.version} but did not enable it.`,
			6000,
		);
		return;
	}
	new Notice(`YAOS: ${result.reason}`, 8000);
}

export async function lookupCatalogEntry(id: string): Promise<CatalogEntry | null> {
	const response = await requestUrl({ url: COMMUNITY_PLUGINS_CATALOG_URL, throw: false });
	if (response.status !== 200 || !Array.isArray(response.json)) return null;
	for (const entry of response.json) {
		if (isCatalogEntry(entry) && entry.id === id) return entry;
	}
	return null;
}

export async function lookupRepoManifest(repo: string): Promise<PluginManifest | null> {
	const response = await requestUrl({
		url: `https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`,
		throw: false,
	});
	if (response.status !== 200 || !isPluginManifest(response.json)) return null;
	return response.json;
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.id === "string" && typeof record.repo === "string";
}

function isPluginManifest(value: unknown): value is PluginManifest {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.id === "string" && typeof record.version === "string";
}
