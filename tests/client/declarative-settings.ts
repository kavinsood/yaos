import {
	App,
	Plugin,
	type SettingDefinition,
	type SettingDefinitionItem,
} from "obsidian";
import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../../src/settings/settingsStore";
import {
	VaultSyncSettingTab,
	type VaultSyncSettingsHost,
} from "../../src/settings/settingsTab";
import { suite } from "../harness.ts";

const s = suite("declarative-settings");

function collectDefinitions(items: SettingDefinitionItem[]): SettingDefinition[] {
	const definitions: SettingDefinition[] = [];
	for (const item of items) {
		if ("type" in item) {
			if (item.items) definitions.push(...collectDefinitions(item.items));
			continue;
		}
		definitions.push(item);
	}
	return definitions;
}

function createFixture(): {
	tab: VaultSyncSettingTab;
	host: VaultSyncSettingsHost;
	settings: VaultSyncSettings;
	updateReasons: string[];
	attachmentRefreshReasons: string[];
} {
	const settings: VaultSyncSettings = { ...DEFAULT_SETTINGS };
	const updateReasons: string[] = [];
	const attachmentRefreshReasons: string[] = [];
	const host: VaultSyncSettingsHost = {
		settings,
		serverAuthMode: "claim",
		serverSupportsAttachments: true,
		serverMaxBlobUploadBytes: 5 * 1024 * 1024,
		updateSettings: async (mutator, reason) => {
			mutator(settings);
			updateReasons.push(reason ?? "");
		},
		refreshServerCapabilities: async () => {},
		refreshUpdateManifest: async () => {},
		refreshAttachmentSyncRuntime: async (reason) => {
			attachmentRefreshReasons.push(reason ?? "");
		},
		getSettingsStatusSummary: () => ({ state: "connected", label: "Connected" }),
		getUpdateState: () => ({
			serverVersion: "0.3.0",
			latestServerVersion: "0.3.0",
			serverUpdateAvailable: false,
			pluginVersion: "2.0.0",
			latestPluginVersion: "2.0.0",
			pluginUpdateRecommended: false,
			updateRepoUrl: null,
			updateActionUrl: null,
			updateBootstrapUrl: null,
			legacyServerDetected: false,
			pluginCompatibilityWarning: null,
		}),
		buildSetupDeepLink: () => null,
		buildMobileSetupUrl: () => null,
		buildRecoveryKitText: () => null,
	};
	const plugin = Object.create(Plugin.prototype) as Plugin;
	const tab = new VaultSyncSettingTab(new App(), plugin, host);
	return { tab, host, settings, updateReasons, attachmentRefreshReasons };
}

s.section("Declarative settings inventory");
{
	const { tab } = createFixture();
	const items = tab.getSettingDefinitions();
	const definitions = collectDefinitions(items);
	const names = new Set(definitions.map((definition) => definition.name));
	const controlKeys = new Set(
		definitions.flatMap((definition) => definition.control ? [definition.control.key] : []),
	);

	for (const name of [
		"Device name",
		"Exclude paths",
		"Maximum text file size in kilobytes",
		"Sync attachments",
		"Show remote cursors",
		"Server URL",
		"Sync token",
		"Vault ID",
		"Edits from other apps",
		"Frontmatter safety guard",
		"Debug mode",
	]) {
		s.check(names.has(name), `${name} is searchable through a setting definition`);
	}
	for (const key of [
		"deviceName",
		"excludePatterns",
		"maxFileSizeKB",
		"enableAttachmentSync",
		"maxAttachmentSizeKB",
		"attachmentConcurrency",
		"showRemoteCursors",
		"host",
		"token",
		"vaultId",
		"updateRepoUrl",
		"updateRepoBranch",
		"externalEditPolicy",
		"frontmatterGuardEnabled",
		"debug",
	]) {
		s.check(controlKeys.has(key), `${key} has a declarative control`);
	}
	s.check(!("display" in tab), "imperative display fallback is absent");
}

s.section("Separate vault setup preserves the current connection");
{
	const { tab, host, settings, updateReasons } = createFixture();
	settings.host = "https://sync.example.com";
	settings.token = "shared-token";
	settings.vaultId = "existing-vault";
	const originalSettings = JSON.stringify(settings);
	const deepLinkIds: (string | undefined)[] = [];
	const mobileIds: (string | undefined)[] = [];
	host.buildSetupDeepLink = (id) => {
		deepLinkIds.push(id);
		return "obsidian://yaos?action=setup";
	};
	host.buildMobileSetupUrl = (id) => {
		mobileIds.push(id);
		return "https://sync.example.com/mobile-setup";
	};
	const definitions = collectDefinitions(tab.getSettingDefinitions());
	const create = definitions.find((item) => item.name === "Set up a separate vault");
	s.check(typeof create?.action === "function", "configured server exposes separate vault setup");
	const actionEl = {} as HTMLElement;
	await create?.action?.(actionEl, 0);
	await create?.action?.(actionEl, 0);
	s.check(!!deepLinkIds[0] && deepLinkIds[0] !== settings.vaultId, "setup uses a new vault ID");
	s.check(deepLinkIds[0] !== deepLinkIds[1], "each setup generates an independent room");
	s.check(mobileIds[0] === deepLinkIds[0] && mobileIds[1] === deepLinkIds[1], "QR and desktop links target the same new room");
	await definitions.find((item) => item.name === "Pair another device")?.action?.(actionEl, 0);
	s.check(deepLinkIds[2] === undefined && mobileIds[2] === undefined, "existing pairing still uses the current vault");
	s.check(JSON.stringify(settings) === originalSettings, "generating links leaves settings unchanged");
	s.check(updateReasons.length === 0, "generating links does not reconnect or persist settings");
	settings.host = "";
	s.check(!collectDefinitions(tab.getSettingDefinitions()).some((item) => item.name === "Set up a separate vault"), "separate vault setup is hidden until server is configured");
}

s.section("Control persistence and side effects");
{
	const { tab, settings, updateReasons, attachmentRefreshReasons } = createFixture();
	await tab.setControlValue("deviceName", "  My laptop  ");
	s.check(settings.deviceName === "My laptop", "device name is normalized");
	s.check(tab.getControlValue("deviceName") === "My laptop", "control reads the persisted device name");

	await tab.setControlValue("enableAttachmentSync", false);
	s.check(!settings.enableAttachmentSync, "attachment toggle persists");
	s.check(settings.attachmentSyncExplicitlyConfigured, "attachment toggle records explicit configuration");
	s.check(
		attachmentRefreshReasons.includes("attachment-toggle"),
		"attachment toggle refreshes the runtime",
	);

	await tab.setControlValue("updateRepoBranch", "   ");
	s.check(settings.updateRepoBranch === "main", "blank deployment branch normalizes to main");
	s.check(updateReasons.includes("settings:device-name"), "device mutation keeps its reason");
}

s.section("Validation and structural updates");
{
	const { tab, settings } = createFixture();
	let invalidNumberRejected = false;
	try {
		await tab.setControlValue("maxAttachmentSizeKB", 6 * 1024);
	} catch {
		invalidNumberRejected = true;
	}
	s.check(invalidNumberRejected, "attachment size above the server cap is rejected");

	let invalidPolicyRejected = false;
	try {
		await tab.setControlValue("externalEditPolicy", "sometimes");
	} catch {
		invalidPolicyRejected = true;
	}
	s.check(invalidPolicyRejected, "unknown external edit policy is rejected");

	const initialNames = new Set(collectDefinitions(tab.getSettingDefinitions()).map((item) => item.name));
	s.check(initialNames.has("Setup required"), "incomplete configuration exposes setup guidance");
	settings.host = "https://sync.example.com";
	settings.token = "token";
	settings.vaultId = "vault";
	const configuredNames = new Set(collectDefinitions(tab.getSettingDefinitions()).map((item) => item.name));
	s.check(configuredNames.has("Status"), "configured state exposes sync status");
	s.check(!configuredNames.has("Setup required"), "configured state removes setup guidance");
}

await s.done();
