import { App, Plugin, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../../src/settings/settingsStore";
import { VaultSyncSettingTab, type VaultSyncSettingsHost } from "../../src/settings/settingsTab";
import { emptySettingsSyncStatus, type SettingsSyncStatus } from "../../src/sync/settingsSync/types";
import { readSource, suite } from "../harness.ts";

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
	const settingsSyncStatus: SettingsSyncStatus = emptySettingsSyncStatus();
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
		getSettingsSyncStatus: () => settingsSyncStatus,
		refreshSettingsSyncRuntime: async () => {},
		applySettingsSync: async () => {},
		replaceSettingsSyncEnvironment: async () => {},
		seedSettingsSyncFromThisDevice: async () => {},
		takeSettingsSyncSeed: async () => {},
		deferSettingsSyncSeed: async () => {},
		updateSettingsSyncPlugin: async () => {},
		promoteSettingsSyncPlugin: async () => {},
		removeSettingsSyncEnvironmentItem: async () => {},
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

s.section("Settings sync controls preserve the current settings surface");
{
	const status: SettingsSyncStatus = {
		...emptySettingsSyncStatus(),
		running: true,
		reason: "ok",
		configKey: ".obsidian",
		seeded: true,
		pendingApplySteps: 2,
		pendingApplyTotal: 5,
		unknownFiles: ["unknown.json"],
		versionMismatches: [{ pluginId: "calendar", localVersion: "1.0.0", pin: "2.0.0", localAhead: false }],
		environmentPlugins: [{ id: "calendar", version: "2.0.0", enabled: true }],
		environmentThemes: [{ name: "Minimal", version: "1.0.0" }],
	};
	const { tab, settings } = createFixture({ getSettingsSyncStatus: () => status });
	settings.host = "https://sync.example";
	settings.deviceToken = "device-token";
	settings.vaultId = "vault-id";
	settings.deviceId = "device-id";
	const definitions = collectDefinitions(tab.getSettingDefinitions());
	const names = new Set(definitions.map((definition) => definition.name));
	const keys = new Set(definitions.flatMap((definition) => definition.control ? [definition.control.key] : []));
	for (const name of [
		"Configuration-folder key",
		"Settings sync state",
		"Settings environment",
		"Pending settings apply queue",
		"Apply remote environment",
		"Replace remote settings environment",
		"Update calendar to 2.0.0",
		"Environment plugin: calendar",
		"Environment theme: Minimal",
		"Sync attachments",
		"Show remote cursors",
	]) {
		s.check(names.has(name), `${name} remains exposed`);
	}
	s.check(
		keys.has("settingsSyncEnabled") && keys.has("settingsSyncAutoInstall"),
		"settings sync master and install-consent controls are declarative",
	);
	await tab.setControlValue("settingsSyncEnabled", true);
	await tab.setControlValue("settingsSyncAutoInstall", true);
	s.check(settings.settingsSyncEnabled && settings.settingsSyncAutoInstall, "settings sync toggles persist");
	const settingsTabSource = readSource("src/settings/settingsTab.ts");
	s.check(
		settingsTabSource.includes("decision-required")
			&& settingsTabSource.includes("explicit consent required"),
		"remote seed remains paused until the settings UI records an explicit decision",
	);
	for (const confirmation of [
		"Take the remote settings environment?",
		"Replace the remote settings environment?",
		"Remove ${kind} from the settings environment?",
	]) {
		s.check(settingsTabSource.includes(confirmation), `${confirmation} is confirmation-gated`);
	}
}
s.section("Seeded settings environment requires an explicit local decision");
{
	const status: SettingsSyncStatus = {
		...emptySettingsSyncStatus(),
		reason: "decision-required",
		configKey: ".obsidian",
		seeded: true,
		needsSeed: true,
		seedKind: "occupied",
	};
	const { tab, settings } = createFixture({ getSettingsSyncStatus: () => status });
	Object.assign(settings, {
		host: "https://sync.example",
		deviceToken: "device-token",
		vaultId: "vault-id",
		deviceId: "device-id",
	});
	const definitions = collectDefinitions(tab.getSettingDefinitions());
	const names = new Set(definitions.map((definition) => definition.name));
	const state = definitions.find((definition) => definition.name === "Settings sync state");
	s.check(names.has("Use this device (replace remote)"), "local choice honestly names the remote replacement");
	s.check(names.has("Take the remote seed"), "remote choice remains available");
	s.check(typeof state?.desc === "string" && state.desc.includes("Explicitly choose"), "decision-required status explains that note sync continues pending consent");
}


s.section("Settings sync commands delegate useful environment decisions");
{
	const commands = readSource("src/commands.ts");
	for (const id of [
		"settings-sync-apply",
		"settings-sync-replace",
		"settings-sync-seed-this-device",
		"settings-sync-take-seed",
		"settings-sync-decide-later",
		"settings-sync-debug-install-calendar",
	]) {
		s.check(commands.includes(`id: "${id}"`), `${id} command is registered`);
	}
	s.check(
		commands.includes("checkCallback: (checking)")
			&& commands.includes("host.isSettingsSyncDebugEnabled()")
			&& commands.includes("host.runSettingsSyncInstallSmoke()"),
		"Calendar install smoke is unavailable outside debug mode and delegates through confirmation",
	);
	const main = readSource("src/main.ts");
	s.check(
		commands.includes('host.runSettingsSyncCommand("replace")')
			&& main.includes("private async confirmSettingsSyncCommand")
			&& main.includes('status.reason === "decision-required"'),
		"destructive settings commands share the explicit confirmation boundary",
	);
	s.check(
		main.includes("confirmAndSmokeInstallCalendar(this.app)")
			&& main.includes("noticeForInstallResult"),
		"debug Calendar smoke confirms before install and reports the result",
	);
}

await s.done();
