import { App, Plugin, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../../src/settings/settingsStore";
import { VaultSyncSettingTab, type VaultSyncSettingsHost } from "../../src/settings/settingsTab";
import { suite } from "../harness.ts";

const s = suite("declarative-settings");

function collectDefinitions(items: SettingDefinitionItem[]): SettingDefinition[] {
	const definitions: SettingDefinition[] = [];
	for (const item of items) {
		if ("type" in item) {
			if (item.items) definitions.push(...collectDefinitions(item.items));
		} else {
			definitions.push(item);
		}
	}
	return definitions;
}

function createFixture(overrides: Partial<VaultSyncSettingsHost> = {}): {
	tab: VaultSyncSettingTab;
	settings: VaultSyncSettings;
	updateReasons: string[];
	attachmentRefreshReasons: string[];
} {
	const settings: VaultSyncSettings = { ...DEFAULT_SETTINGS };
	const updateReasons: string[] = [];
	const attachmentRefreshReasons: string[] = [];
	const host: VaultSyncSettingsHost = {
		settings,
		serverSupportsAttachments: true,
		serverMaxBlobUploadBytes: 5 * 1024 * 1024,
		updateSettings: async (mutator, reason) => {
			mutator(settings);
			updateReasons.push(reason ?? "");
		},
		refreshServerCapabilities: async () => {},
		refreshUpdateManifest: async () => {},
		refreshAttachmentSyncRuntime: async (reason) => { attachmentRefreshReasons.push(reason ?? ""); },
		getSettingsStatusSummary: () => ({ label: "Connected" }),
		getUpdateState: () => ({
			serverVersion: "2.1.0",
			latestServerVersion: "2.1.0",
			serverUpdateAvailable: false,
			pluginVersion: "2.1.0",
			latestPluginVersion: "2.1.0",
			pluginUpdateRecommended: false,
			updateRepoUrl: null,
			updateActionUrl: null,
			updateBootstrapUrl: null,
			legacyServerDetected: false,
			pluginCompatibilityWarning: null,
		}),
		mintDevicePairing: async () => null,
		buildDeviceCredentialsText: () => null,
		renameThisDevice: async () => {},
		enrollByPaste: async () => false,
		leaveThisVault: async () => {},
		openServerConsole: () => {},
		getFolderName: () => "MyNotes",
		getVaultRoster: () => [],
		refreshVaultRoster: async () => {},
		isDeviceOnline: () => false,
		...overrides,
	};
	const tab = new VaultSyncSettingTab(new App(), Object.create(Plugin.prototype) as Plugin, host);
	return { tab, settings, updateReasons, attachmentRefreshReasons };
}

s.section("Unenrolled folder workflow");
{
	const { tab } = createFixture();
	const definitions = collectDefinitions(tab.getSettingDefinitions());
	const names = new Set(definitions.map((definition) => definition.name));
	const keys = new Set(definitions.flatMap((definition) => definition.control ? [definition.control.key] : []));
	for (const name of ["Join this folder", "Server URL", "Pairing code", "Enroll"]) {
		s.check(names.has(name), `${name} is exposed while unenrolled`);
	}
	s.check(keys.has("host") && keys.has("pairingCode"), "join controls accept host and pairing code");
	s.check(!keys.has("deviceToken") && !keys.has("vaultId") && !keys.has("deviceId"), "server-minted membership cannot be typed into settings");
	s.check(!names.has("Setup required"), "legacy setup-required workflow is absent");
}

s.section("Enrollment requires the complete identity tuple");
{
	const { tab, settings } = createFixture();
	settings.host = "https://sync.example";
	settings.deviceToken = "device-token";
	settings.vaultId = "vault-id";
	let names = new Set(collectDefinitions(tab.getSettingDefinitions()).map((definition) => definition.name));
	s.check(names.has("Join this folder"), "missing device id remains unenrolled");
	settings.deviceId = "device-id";
	settings.deviceName = "Mac";
	names = new Set(collectDefinitions(tab.getSettingDefinitions()).map((definition) => definition.name));
	for (const name of ["Status", "Folder", "Vault ID", "This device", "Pair another device", "Device credentials", "Open server console", "Leave this vault", "Refresh roster"]) {
		s.check(names.has(name), `${name} is exposed while enrolled`);
	}
	const vaultId = collectDefinitions(tab.getSettingDefinitions()).find((definition) => definition.name === "Vault ID");
	s.check(!!vaultId && !vaultId.control, "enrolled vault id is read-only");
}

s.section("Device rename and attachment side effects");
{
	const { tab, settings, updateReasons, attachmentRefreshReasons } = createFixture();
	await tab.setControlValue("deviceName", "  My laptop  ");
	s.check(settings.deviceName === "My laptop", "device name is normalized");
	s.check(updateReasons.includes("settings:device-name"), "rename persistence keeps its reason");
	await tab.setControlValue("enableAttachmentSync", false);
	s.check(!settings.enableAttachmentSync && settings.attachmentSyncExplicitlyConfigured, "attachment toggle remains normalized");
	s.check(attachmentRefreshReasons.includes("attachment-toggle"), "attachment toggle refreshes runtime");
}

s.section("Pairing code lifecycle follows completed enrollment");
{
	for (const outcome of ["cancelled", "network failure", "server failure", "malformed response", "failed retirement"]) {
		const { tab, settings } = createFixture({
			enrollByPaste: async () => false,
		});
		settings.host = "https://sync.example";
		await tab.setControlValue("pairingCode", `code-for-${outcome}`);
		const enrolled = await tab.submitEnrollment();
		s.check(!enrolled, `${outcome} does not report a completed enrollment`);
		s.check(
			tab.getControlValue("pairingCode") === `code-for-${outcome}`,
			`${outcome} retains the one-shot pairing code`,
		);
	}

	const malformedFixture = createFixture({
		enrollByPaste: async () => true,
	});
	malformedFixture.settings.host = "https://sync.example";
	await malformedFixture.tab.setControlValue("pairingCode", "malformed-code");
	s.check(
		!await malformedFixture.tab.submitEnrollment(),
		"reported success without a complete identity tuple is rejected",
	);
	s.check(
		malformedFixture.tab.getControlValue("pairingCode") === "malformed-code",
		"incomplete enrollment credentials retain the pairing code",
	);

	let settingsToComplete: VaultSyncSettings | null = null;
	const completedFixture = createFixture({
		enrollByPaste: async () => {
			const target = settingsToComplete;
			if (!target) throw new Error("settings fixture was not initialized");
			target.deviceToken = "new-token";
			target.vaultId = "new-vault";
			target.deviceId = "new-device";
			return true;
		},
	});
	const { tab, settings } = completedFixture;
	settingsToComplete = settings;
	settings.host = "https://sync.example";
	await tab.setControlValue("pairingCode", "completed-code");
	s.check(await tab.submitEnrollment(), "complete enrollment reports success");
	s.check(tab.getControlValue("pairingCode") === "", "complete enrollment clears the pairing code");
}

s.section("Pairing mint failure has one owner");
{
	let mintCalls = 0;
	const { tab } = createFixture({
		mintDevicePairing: async () => {
			mintCalls++;
			return null;
		},
	});
	s.check(!await tab.openPairing(), "mint failure does not open a pairing modal");
	s.check(mintCalls === 1, "settings delegates mint failure reporting exactly once");
}

await s.done();
