import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	type SettingDefinition,
	type SettingDefinitionItem,
} from "obsidian";
import { PairDeviceModal } from "./PairDeviceModal";
import { RecoveryKitModal } from "./RecoveryKitModal";
import {
	attachmentSizeCapKB,
	type ExternalEditPolicy,
	type VaultSyncSettings,
} from "./settingsStore";

type SettingsAuthMode = "env" | "claim" | "unclaimed" | "unknown";

type DeclarativeSettingKey =
	| "deviceName"
	| "excludePatterns"
	| "maxFileSizeKB"
	| "enableAttachmentSync"
	| "maxAttachmentSizeKB"
	| "attachmentConcurrency"
	| "showRemoteCursors"
	| "host"
	| "token"
	| "vaultId"
	| "updateRepoUrl"
	| "updateRepoBranch"
	| "externalEditPolicy"
	| "frontmatterGuardEnabled"
	| "debug";

interface SettingsUpdateState {
	serverVersion: string | null;
	latestServerVersion: string | null;
	serverUpdateAvailable: boolean;
	pluginVersion: string;
	latestPluginVersion: string | null;
	pluginUpdateRecommended: boolean;
	updateRepoUrl: string | null;
	updateActionUrl: string | null;
	updateBootstrapUrl: string | null;
	legacyServerDetected: boolean;
	pluginCompatibilityWarning: string | null;
}

export interface VaultSyncSettingsHost {
	settings: VaultSyncSettings;
	serverAuthMode: SettingsAuthMode;
	serverSupportsAttachments: boolean;
	serverMaxBlobUploadBytes: number | null;
	updateSettings(mutator: (settings: VaultSyncSettings) => void, reason?: string): Promise<void>;
	refreshServerCapabilities(reason?: string): Promise<void>;
	refreshUpdateManifest(reason?: string, force?: boolean): Promise<void>;
	refreshAttachmentSyncRuntime(reason?: string): Promise<void>;
	getSettingsStatusSummary(): { label: string };
	getUpdateState(): SettingsUpdateState;
	buildSetupDeepLink(): string | null;
	buildMobileSetupUrl(): string | null;
	buildRecoveryKitText(): string | null;
}

const CLOUDFLARE_DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server";
const ATTACHMENT_SETUP_VIDEO_URL = "https://youtu.be/Z7xCMEYfdFM";
const EXTERNAL_EDIT_OPTIONS: Record<ExternalEditPolicy, string> = {
	always: "Always import",
	"closed-only": "Only when file is closed",
	never: "Never import",
};

function isInsecureRemoteHost(host: string): boolean {
	if (!host) return false;
	try {
		const url = new URL(host);
		if (url.protocol !== "http:") return false;
		const hostname = url.hostname;
		return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]";
	} catch {
		return false;
	}
}

function shortenMiddle(value: string, maxLength = 36): string {
	if (value.length <= maxLength) return value;
	const edge = Math.max(8, Math.floor((maxLength - 3) / 2));
	return `${value.slice(0, edge)}...${value.slice(-edge)}`;
}

function expectStringValue(key: string, value: unknown): string {
	if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
	return value;
}

function expectBooleanValue(key: string, value: unknown): boolean {
	if (typeof value !== "boolean") throw new TypeError(`${key} must be a boolean`);
	return value;
}

function expectFiniteNumber(key: string, value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${key} must be a finite number`);
	}
	return value;
}

function validatePositiveInteger(value: number): string | void {
	if (!Number.isInteger(value) || value <= 0) return "Enter a positive whole number.";
}

function isExternalEditPolicy(value: string): value is ExternalEditPolicy {
	return value === "always" || value === "closed-only" || value === "never";
}

export class VaultSyncSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		plugin: Plugin,
		private readonly host: VaultSyncSettingsHost,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const setupIncomplete = !this.host.settings.host || !this.host.settings.token;
		const attachmentsAvailable = this.host.serverSupportsAttachments;
		const attachmentCapKB = attachmentSizeCapKB(this.host.serverMaxBlobUploadBytes);
		const syncStatus = this.host.getSettingsStatusSummary();
		const updateState = this.host.getUpdateState();
		const definitions: SettingDefinitionItem[] = [];

		if (setupIncomplete) {
			definitions.push({
				type: "group",
				heading: "Setup",
				items: [
					{
						name: "Setup required",
						desc: "Deploy and claim a free sync server, then open its setup link to configure Yaos.",
					},
					{
						name: "Deploy your server",
						desc: "Open the one-click Cloudflare deployment page.",
						action: () => this.openUrl(CLOUDFLARE_DEPLOY_URL),
					},
				],
			});
		} else {
			const statusItems: SettingDefinition[] = [
				{ name: "Status", desc: syncStatus.label },
				{ name: "Server", desc: this.host.settings.host },
				{ name: "Vault", desc: shortenMiddle(this.host.settings.vaultId || "Not set") },
				{ name: "This device", desc: this.host.settings.deviceName || "Unnamed" },
				{
					name: "Pair another device",
					desc: "Open a setup code and link for another device.",
					action: () => this.openPairing(),
				},
				{
					name: "Back up connection details",
					desc: "Open a recovery kit containing this vault's connection details.",
					action: () => this.openRecoveryKit(),
				},
			];
			definitions.push({ type: "group", heading: "Sync status", items: statusItems });

			const updateSummary = updateState.serverUpdateAvailable
				? "A server update is available."
				: updateState.pluginUpdateRecommended
					? "This device should update the Yaos plugin soon."
					: "Server and plugin are up to date with the latest cached manifest.";
			const updateItems: SettingDefinition[] = [
				{ name: "Server version", desc: updateState.serverVersion ?? "Unknown" },
				{ name: "Latest server", desc: updateState.latestServerVersion ?? "Unknown" },
				{ name: "Plugin version", desc: updateState.pluginVersion },
				{ name: "Latest plugin", desc: updateState.latestPluginVersion ?? "Unknown" },
				{ name: "Update path", desc: updateState.updateRepoUrl ?? "Not configured" },
				{ name: "Update status", desc: updateSummary },
				{
					name: "Compatibility warning",
					desc: updateState.pluginCompatibilityWarning ?? "",
					visible: () => this.host.getUpdateState().pluginCompatibilityWarning !== null,
				},
				{
					name: "Legacy server detected",
					desc: "Sync continues, but update metadata and one-click updates require a newer server.",
					visible: () => this.host.getUpdateState().legacyServerDetected,
				},
				{
					name: "Refresh update information",
					desc: "Fetch current server capabilities and release metadata.",
					action: () => { void this.refreshUpdateInformation(); },
				},
				{
					name: "Open update action",
					desc: "Open the deployment repository's update workflow.",
					visible: () => this.host.getUpdateState().updateActionUrl !== null,
					action: () => this.openCurrentUpdateAction(),
				},
				{
					name: "Initialize updater",
					desc: "Create the deployment repository's update workflow.",
					visible: () => this.host.getUpdateState().updateBootstrapUrl !== null,
					action: () => this.openCurrentUpdaterBootstrap(),
				},
			];
			definitions.push({ type: "group", heading: "Updates", items: updateItems });
		}

		definitions.push(
			{
				type: "group",
				heading: "This device",
				items: [
					{
						name: "Device name",
						desc: "Shown to other devices in live cursors and presence.",
						control: { type: "text", key: "deviceName", placeholder: "My laptop" },
					},
				],
			},
			{
				type: "group",
				heading: "What syncs",
				items: [
					{
						name: "Exclude paths",
						desc: "Comma-separated path prefixes to skip, such as templates/, .trash/, or daily-notes/.",
						control: { type: "text", key: "excludePatterns", placeholder: "templates/, daily-notes/" },
					},
					{
						name: "Maximum text file size in kilobytes",
						desc: "Text files larger than this are skipped for live document sync.",
						control: {
							type: "number",
							key: "maxFileSizeKB",
							min: 1,
							step: 1,
							validate: validatePositiveInteger,
						},
					},
				],
			},
		);

		const attachmentItems: SettingDefinition[] = [
			{
				name: "Attachment storage",
				desc: attachmentsAvailable
					? "Available on this server. The plugin can sync attachments and snapshots."
					: "Unavailable on this server. Add object storage in Cloudflare, then redeploy.",
			},
			{
				name: "Refresh attachment capability",
				desc: "Refresh server capabilities and the attachment sync runtime.",
				visible: () => Boolean(this.host.settings.host),
				action: () => { void this.refreshAttachmentCapability(); },
			},
			{
				name: "Set up attachment storage",
				desc: "Open the one-minute attachment storage setup video.",
				visible: () => Boolean(this.host.settings.host) && !this.host.serverSupportsAttachments,
				action: () => this.openUrl(ATTACHMENT_SETUP_VIDEO_URL),
			},
			{
				name: "Sync attachments",
				desc: "Sync images, PDF files, and other attachments through object storage.",
				visible: () => this.host.serverSupportsAttachments || !this.host.settings.host,
				control: { type: "toggle", key: "enableAttachmentSync" },
			},
			{
				name: "Maximum attachment size in kilobytes",
				desc: `Attachments larger than this are skipped. Maximum ${attachmentCapKB} KB.`,
				visible: () =>
					(this.host.serverSupportsAttachments || !this.host.settings.host)
					&& this.host.settings.enableAttachmentSync,
				control: {
					type: "number",
					key: "maxAttachmentSizeKB",
					min: 1,
					max: attachmentCapKB,
					step: 1,
					validate: (value) => {
						const integerError = validatePositiveInteger(value);
						if (integerError) return integerError;
						if (value > attachmentCapKB) return `Enter ${attachmentCapKB} or less.`;
						return undefined;
					},
				},
			},
			{
				name: "Parallel transfers",
				desc: "One transfer at a time favors reliability on slow or mobile networks.",
				visible: () =>
					(this.host.serverSupportsAttachments || !this.host.settings.host)
					&& this.host.settings.enableAttachmentSync,
				control: {
					type: "slider",
					key: "attachmentConcurrency",
					min: 1,
					max: 5,
					step: 1,
					displayFormat: (value) => String(value),
				},
			},
		];
		definitions.push({ type: "group", heading: "Attachments", items: attachmentItems });

		definitions.push({
			type: "group",
			heading: "Collaboration",
			items: [
				{
					name: "Show remote cursors",
					desc: "Show other devices' cursors and selections while editing.",
					control: { type: "toggle", key: "showRemoteCursors" },
				},
			],
		});

		definitions.push(
			{
				type: "page",
				name: "Manual connection",
				desc: "View or change this vault's server connection.",
				displayValue: () => this.host.settings.host || "Not configured",
				status: () => (!this.host.settings.host || !this.host.settings.token ? "warning" : null),
				items: [
					{
						name: "Server URL",
						desc: "Usually filled automatically by the setup flow.",
						control: { type: "text", key: "host", placeholder: "Paste the server URL" },
					},
					{
						name: "Unencrypted connection",
						desc: "This remote connection sends the sync token in plaintext. Use HTTPS for production.",
						visible: () => isInsecureRemoteHost(this.host.settings.host),
					},
					{
						name: "Sync token",
						desc: this.tokenDescription(),
						control: { type: "text", key: "token", placeholder: "Paste your sync token" },
					},
				],
			},
			{
				type: "page",
				name: "Advanced",
				desc: "Vault identity, deployment metadata, external edits, safety, and diagnostics.",
				items: [
					{
						name: "Vault ID",
						desc: "Devices syncing the same vault must use exactly the same vault ID.",
						control: { type: "text", key: "vaultId", placeholder: "Generated automatically" },
					},
					{
						name: "Deployment repository URL",
						desc: "Optional. The provider is inferred from this URL.",
						control: { type: "text", key: "updateRepoUrl", placeholder: "Paste the GitHub or GitLab repository URL" },
					},
					{
						name: "Deployment default branch",
						desc: "Used for GitLab pipeline links and provider-native update helpers.",
						control: { type: "text", key: "updateRepoBranch", placeholder: "main" },
					},
					{
						name: "Edits from other apps",
						desc: "Choose how file changes from Git, scripts, or other editors enter sync.",
						control: { type: "dropdown", key: "externalEditPolicy", options: EXTERNAL_EDIT_OPTIONS },
					},
					{
						name: "Frontmatter safety guard",
						desc: "Pause suspicious YAML property updates before they spread.",
						control: { type: "toggle", key: "frontmatterGuardEnabled" },
					},
					{
						name: "Debug mode",
						desc: "Record detailed sync events for an exportable diagnostics trace. Leave off for everyday use.",
						control: { type: "toggle", key: "debug" },
					},
					{
						name: "Reload required",
						desc: "Changing the server URL, sync token, or vault ID requires reloading the plugin.",
						searchable: false,
					},
				],
			},
		);

		return definitions;
	}

	getControlValue(key: string): unknown {
		switch (key as DeclarativeSettingKey) {
			case "deviceName": return this.host.settings.deviceName;
			case "excludePatterns": return this.host.settings.excludePatterns;
			case "maxFileSizeKB": return this.host.settings.maxFileSizeKB;
			case "enableAttachmentSync": return this.host.settings.enableAttachmentSync;
			case "maxAttachmentSizeKB": return this.host.settings.maxAttachmentSizeKB;
			case "attachmentConcurrency": return this.host.settings.attachmentConcurrency;
			case "showRemoteCursors": return this.host.settings.showRemoteCursors;
			case "host": return this.host.settings.host;
			case "token": return this.host.settings.token;
			case "vaultId": return this.host.settings.vaultId;
			case "updateRepoUrl": return this.host.settings.updateRepoUrl;
			case "updateRepoBranch": return this.host.settings.updateRepoBranch;
			case "externalEditPolicy": return this.host.settings.externalEditPolicy;
			case "frontmatterGuardEnabled": return this.host.settings.frontmatterGuardEnabled;
			case "debug": return this.host.settings.debug;
			default: throw new Error(`Unknown Yaos setting: ${key}`);
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key as DeclarativeSettingKey) {
			case "deviceName":
				await this.host.updateSettings((settings) => {
					settings.deviceName = expectStringValue(key, value).trim();
				}, "settings:device-name");
				return;
			case "excludePatterns":
				await this.host.updateSettings((settings) => {
					settings.excludePatterns = expectStringValue(key, value);
				}, "settings:exclude-patterns");
				return;
			case "maxFileSizeKB": {
				const nextValue = expectFiniteNumber(key, value);
				if (validatePositiveInteger(nextValue)) throw new RangeError("maxFileSizeKB must be a positive integer");
				await this.host.updateSettings((settings) => { settings.maxFileSizeKB = nextValue; }, "settings:max-file-size");
				return;
			}
			case "enableAttachmentSync":
				await this.host.updateSettings((settings) => {
					settings.enableAttachmentSync = expectBooleanValue(key, value);
					settings.attachmentSyncExplicitlyConfigured = true;
				}, "settings:attachment-toggle");
				await this.host.refreshAttachmentSyncRuntime("attachment-toggle");
				this.update();
				return;
			case "maxAttachmentSizeKB": {
				const nextValue = expectFiniteNumber(key, value);
				const cap = attachmentSizeCapKB(this.host.serverMaxBlobUploadBytes);
				if (validatePositiveInteger(nextValue) || nextValue > cap) {
					throw new RangeError(`maxAttachmentSizeKB must be an integer between 1 and ${cap}`);
				}
				await this.host.updateSettings((settings) => { settings.maxAttachmentSizeKB = nextValue; }, "settings:max-attachment-size");
				return;
			}
			case "attachmentConcurrency": {
				const nextValue = expectFiniteNumber(key, value);
				if (!Number.isInteger(nextValue) || nextValue < 1 || nextValue > 5) {
					throw new RangeError("attachmentConcurrency must be an integer between 1 and 5");
				}
				await this.host.updateSettings((settings) => { settings.attachmentConcurrency = nextValue; }, "settings:attachment-concurrency");
				return;
			}
			case "showRemoteCursors":
				await this.host.updateSettings((settings) => {
					settings.showRemoteCursors = expectBooleanValue(key, value);
				}, "settings:remote-cursors");
				return;
			case "host":
				await this.host.updateSettings((settings) => { settings.host = expectStringValue(key, value).trim(); }, "settings:host");
				this.update();
				return;
			case "token":
				await this.host.updateSettings((settings) => { settings.token = expectStringValue(key, value).trim(); }, "settings:token");
				this.update();
				return;
			case "vaultId":
				await this.host.updateSettings((settings) => { settings.vaultId = expectStringValue(key, value).trim(); }, "settings:vault-id");
				this.update();
				return;
			case "updateRepoUrl":
				await this.host.updateSettings((settings) => { settings.updateRepoUrl = expectStringValue(key, value).trim(); }, "settings:update-repo-url");
				return;
			case "updateRepoBranch":
				await this.host.updateSettings((settings) => {
					settings.updateRepoBranch = expectStringValue(key, value).trim() || "main";
				}, "settings:update-repo-branch");
				return;
			case "externalEditPolicy": {
				const nextValue = expectStringValue(key, value);
				if (!isExternalEditPolicy(nextValue)) throw new RangeError(`Unsupported external edit policy: ${nextValue}`);
				await this.host.updateSettings((settings) => { settings.externalEditPolicy = nextValue; }, "settings:external-edit-policy");
				return;
			}
			case "frontmatterGuardEnabled":
				await this.host.updateSettings((settings) => {
					settings.frontmatterGuardEnabled = expectBooleanValue(key, value);
				}, "settings:frontmatter-guard");
				return;
			case "debug":
				await this.host.updateSettings((settings) => {
					settings.debug = expectBooleanValue(key, value);
				}, "settings:debug");
				return;
			default:
				throw new Error(`Unknown Yaos setting: ${key}`);
		}
	}

	private tokenDescription(): string {
		switch (this.host.serverAuthMode) {
			case "unclaimed":
				return "Leave blank until you claim the server, then use its setup link.";
			case "env":
				return "Must match the SYNC_TOKEN configured on the server.";
			default:
				return "Usually filled automatically by the setup link after you claim the server.";
		}
	}

	private openPairing(): void {
		const deepLink = this.host.buildSetupDeepLink();
		const mobileUrl = this.host.buildMobileSetupUrl();
		if (!deepLink || !mobileUrl) {
			new Notice("Configure the server URL, sync token, and vault ID before pairing.", 7000);
			return;
		}
		new PairDeviceModal(this.app, deepLink, mobileUrl).open();
	}

	private openRecoveryKit(): void {
		const recoveryKit = this.host.buildRecoveryKitText();
		if (!recoveryKit) {
			new Notice("Configure the server URL, sync token, and vault ID before exporting connection details.", 7000);
			return;
		}
		new RecoveryKitModal(this.app, recoveryKit).open();
	}

	private async refreshUpdateInformation(): Promise<void> {
		await this.host.refreshServerCapabilities("settings-refresh");
		await this.host.refreshUpdateManifest("settings-refresh", true);
		this.update();
	}

	private async refreshAttachmentCapability(): Promise<void> {
		await this.host.refreshServerCapabilities("settings-attachment-refresh");
		await this.host.refreshAttachmentSyncRuntime("capability-refresh");
		this.update();
	}

	private openCurrentUpdateAction(): void {
		const url = this.host.getUpdateState().updateActionUrl;
		if (url) this.openUrl(url);
	}

	private openCurrentUpdaterBootstrap(): void {
		const url = this.host.getUpdateState().updateBootstrapUrl;
		if (url) this.openUrl(url);
	}

	private openUrl(url: string): void {
		window.open(url, "_blank", "noopener");
	}
}
