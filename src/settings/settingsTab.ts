import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	type SettingDefinition,
	type SettingDefinitionItem,
} from "obsidian";
import { PairDeviceModal } from "./PairDeviceModal";
import { DeviceCredentialsModal } from "./DeviceCredentialsModal";
import { ConfirmModal } from "../ui/ConfirmModal";
import {
	attachmentSizeCapKB,
	type ExternalEditPolicy,
	type VaultSyncSettings,
} from "./settingsStore";
import type { SettingsSyncStatus } from "../sync/settingsSync/types";


type DeclarativeSettingKey =
	| "deviceName"
	| "excludePatterns"
	| "maxFileSizeKB"
	| "enableAttachmentSync"
	| "maxAttachmentSizeKB"
	| "attachmentConcurrency"
	| "showRemoteCursors"
	| "host"
	| "pairingCode"
	| "updateRepoUrl"
	| "updateRepoBranch"
	| "externalEditPolicy"
	| "frontmatterGuardEnabled"
	| "settingsSyncEnabled"
	| "settingsSyncAutoInstall"
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
	pluginCompatibilityWarning: string | null;
}

export interface VaultRosterDevice {
	deviceId: string;
	name: string;
	enrolledAt?: number;
	lastSeenAt?: number;
}

export interface VaultSyncSettingsHost {
	settings: VaultSyncSettings;
	serverSupportsAttachments: boolean;
	serverMaxBlobUploadBytes: number | null;
	updateSettings(mutator: (settings: VaultSyncSettings) => void, reason?: string): Promise<void>;
	refreshServerCapabilities(reason?: string): Promise<void>;
	refreshUpdateManifest(reason?: string, force?: boolean): Promise<void>;
	refreshAttachmentSyncRuntime(reason?: string): Promise<void>;
	getSettingsStatusSummary(): { label: string };
	getSettingsSyncStatus(): SettingsSyncStatus;
	refreshSettingsSyncRuntime(): Promise<void>;
	applySettingsSync(): Promise<void>;
	replaceSettingsSyncEnvironment(): Promise<void>;
	seedSettingsSyncFromThisDevice(): Promise<void>;
	takeSettingsSyncSeed(): Promise<void>;
	deferSettingsSyncSeed(): Promise<void>;
	updateSettingsSyncPlugin(pluginId: string): Promise<void>;
	promoteSettingsSyncPlugin(pluginId: string): Promise<void>;
	removeSettingsSyncEnvironmentItem(kind: "plugin" | "theme", id: string): Promise<void>;
	getUpdateState(): SettingsUpdateState;
	mintDevicePairing(): Promise<{ deepLink: string; mobileUrl: string } | null>;
	buildDeviceCredentialsText(): string | null;
	renameThisDevice(name: string): Promise<void>;
	enrollByPaste(host: string, pairingCode: string): Promise<boolean>;
	leaveThisVault(): Promise<void>;
	openServerConsole(): void;
	getFolderName(): string;
	getVaultRoster(): VaultRosterDevice[];
	refreshVaultRoster(): Promise<void>;
	isDeviceOnline(deviceId: string): boolean;
}

const CLOUDFLARE_DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server";
const ATTACHMENT_SETUP_VIDEO_URL = "https://youtu.be/Z7xCMEYfdFM";
const EXTERNAL_EDIT_OPTIONS: Record<ExternalEditPolicy, string> = {
	always: "Always import",
	"closed-only": "Only when file is closed",
	never: "Never import",
};

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

function formatRosterLastSeen(lastSeenAt?: number): string {
	if (typeof lastSeenAt !== "number" || !Number.isFinite(lastSeenAt) || lastSeenAt <= 0) {
		return "Last seen unknown";
	}
	const deltaMs = Date.now() - lastSeenAt;
	if (deltaMs < 60_000) return "Last seen just now";
	if (deltaMs < 3_600_000) return `Last seen ${Math.floor(deltaMs / 60_000)}m ago`;
	if (deltaMs < 86_400_000) return `Last seen ${Math.floor(deltaMs / 3_600_000)}h ago`;
	return `Last seen ${new Date(lastSeenAt).toISOString()}`;
}

export class VaultSyncSettingTab extends PluginSettingTab {
	private pairingCode = "";
	private lastRosterVaultId = "";
	constructor(
		app: App,
		plugin: Plugin,
		private readonly host: VaultSyncSettingsHost,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const setupIncomplete = !this.host.settings.host.trim()
			|| !this.host.settings.deviceToken.trim()
			|| !this.host.settings.vaultId.trim()
			|| !this.host.settings.deviceId.trim();
		const attachmentsAvailable = this.host.serverSupportsAttachments;
		const attachmentCapKB = attachmentSizeCapKB(this.host.serverMaxBlobUploadBytes);
		const syncStatus = this.host.getSettingsStatusSummary();
		const updateState = this.host.getUpdateState();
		const definitions: SettingDefinitionItem[] = [];

		if (setupIncomplete) {
			this.lastRosterVaultId = "";
			definitions.push({
				type: "group",
				heading: "Setup",
				items: [
					{
						name: "Join this folder",
						desc: "Enter the server URL and one-shot pairing code for the vault this Obsidian folder should join.",
					},
					{
						name: "Server URL",
						desc: "The Worker URL from the operator console or pairing page.",
						control: { type: "text", key: "host", placeholder: "https://sync.example.com" },
					},
					{
						name: "Pairing code",
						desc: "One-shot code. It works once and expires in 15 minutes.",
						control: { type: "text", key: "pairingCode", placeholder: "Paste the pairing code" },
					},
					{
						name: "Enroll",
						desc: "Join this folder as a device on that vault.",
						action: () => { void this.submitEnrollment(); },
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
				{ name: "Folder", desc: this.host.getFolderName() },
				{ name: "Vault ID", desc: shortenMiddle(this.host.settings.vaultId) },
				{ name: "This device", desc: this.host.settings.deviceName || "Unnamed" },
				{
					name: "Pair another device",
					desc: "Mint a one-shot pairing code and server-provided setup links.",
					action: () => { void this.openPairing(); },
				},
				{
					name: "Device credentials",
					desc: "Export only this device's host, vault ID, device ID, and device token.",
					action: () => this.openDeviceCredentials(),
				},
				{
					name: "Open server console",
					desc: "Open this Worker in a browser. The operator key stays in the console.",
					action: () => this.host.openServerConsole(),
				},
				{
					name: "Leave this vault",
					desc: "Revoke this device when possible, stop syncing, and keep notes on disk.",
					action: () => { void this.host.leaveThisVault(); },
				},
			];
			definitions.push({ type: "group", heading: "Sync status", items: statusItems });
			definitions.push(this.buildRosterGroup());

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
			definitions.push(this.buildSettingsSyncGroup());
		}

		definitions.push(
			{
				type: "group",
				heading: "This device",
				items: [
					{
						name: "Rename this device",
						desc: "Shown to other devices in live cursors, presence, and the roster.",
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

		definitions.push({
			type: "page",
			name: "Advanced",
			desc: "Deployment metadata, external edits, safety, and diagnostics.",
			items: [
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
			],
		});

		return definitions;
	}

	private buildSettingsSyncGroup(): SettingDefinitionItem {
		const status = this.host.getSettingsSyncStatus();
		const decisionRequired = String(status.reason) === "decision-required";
		const reason = decisionRequired
			? "A remote settings environment exists. Explicitly choose whether this device takes it or replaces it; note sync continues."
			: (() => {
				switch (status.reason) {
					case "ok": return "Running";
					case "unsupported": return status.headline === "settings_format_unsupported"
						? "Server settings format is incompatible; note sync continues."
						: "Server does not support settings sync; note sync continues.";
					case "master-off": return "Off on this device; note sync continues.";
					case "invalid-key": return "The Obsidian configuration folder name is not a valid settings key.";
					case "clash": return "Paused because another settings-sync plugin is enabled.";
					case "deferred": return "Initial seed decision deferred; note sync continues.";
					case "unseeded": return "Waiting for an initial settings environment choice.";
					case "stopped": return "Stopped";
					case "error": return status.error ? `Error: ${status.error}` : "Settings sync error";
					default: return "Stopped";
				}
			})();
		const seedState = decisionRequired
			? `Remote seed available; explicit consent required${status.seedKind ? ` (${status.seedKind} local configuration)` : ""}`
			: status.seeded === true
				? "Seeded and accepted"
				: status.seeded === false
					? `${status.deferred ? "Unseeded; decision deferred" : "Unseeded"}${status.seedKind ? ` (${status.seedKind} local configuration)` : ""}`
					: "Not checked";
		const items: SettingDefinition[] = [
			{
				name: "Sync Obsidian settings",
				desc: "Synchronize this vault's current Obsidian configuration folder. Note sync is independent of this switch.",
				control: { type: "toggle", key: "settingsSyncEnabled" },
			},
			{
				name: "Configuration-folder key",
				desc: status.configKey ?? "Pending enrollment provisioning and capability check",
			},
			{ name: "Settings sync state", desc: reason },
			{ name: "Settings environment", desc: seedState },
			{
				name: "Pending settings apply queue",
				desc: status.pendingApplySteps > 0
					? `${status.pendingApplySteps} of ${status.pendingApplyTotal} steps remain for this exact device and configuration folder.`
					: "No pending apply steps for this device and configuration folder.",
			},
			{
				name: "Apply remote environment",
				desc: "Apply the known remote plugin, theme, and settings environment now.",
				visible: () => {
					const current = this.host.getSettingsSyncStatus();
					return current.seeded === true && String(current.reason) !== "decision-required";
				},
				action: () => this.finishSettingsSyncAction(() => this.host.applySettingsSync()),
			},
			{
				name: decisionRequired ? "Use this device (replace remote)" : "Seed from this device",
				desc: decisionRequired
					? "Replace the existing remote environment with this device's managed configuration."
					: "Create the initial remote settings environment from this device.",
				visible: () => {
					const current = this.host.getSettingsSyncStatus();
					return current.seeded === false || String(current.reason) === "decision-required";
				},
				action: () => {
					const current = this.host.getSettingsSyncStatus();
					if (String(current.reason) === "decision-required") {
						this.confirmSettingsSyncAction(
							"Replace the remote settings environment?",
							"This replaces the shared remote settings environment with this device's current configuration. Other devices will receive these plugin, theme, and settings choices.",
							"Replace remote",
							() => this.host.replaceSettingsSyncEnvironment(),
						);
						return;
					}
					this.finishSettingsSyncAction(() => this.host.seedSettingsSyncFromThisDevice());
				},
			},
			{
				name: "Take the remote seed",
				desc: "Apply a remote seed if another device created it since the last check.",
				visible: () => {
					const current = this.host.getSettingsSyncStatus();
					return current.seeded === false || String(current.reason) === "decision-required";
				},
				action: () => {
					const current = this.host.getSettingsSyncStatus();
					if (String(current.reason) === "decision-required") {
						this.confirmSettingsSyncAction(
							"Take the remote settings environment?",
							current.seedKind === "occupied"
								? "This applies the remote plugin, theme, and settings environment over this device's existing managed configuration."
								: "This applies the remote plugin, theme, and settings environment to this device.",
							"Take remote",
							() => this.host.takeSettingsSyncSeed(),
						);
						return;
					}
					this.finishSettingsSyncAction(() => this.host.takeSettingsSyncSeed());
				},
			},
			{
				name: "Decide initial seed later",
				desc: "Defer the seed choice without pausing note sync.",
				visible: () => {
					const current = this.host.getSettingsSyncStatus();
					return current.seeded === false && !current.deferred;
				},
				action: () => this.finishSettingsSyncAction(() => this.host.deferSettingsSyncSeed()),
			},
			{
				name: "Replace remote settings environment",
				desc: "Replace the seeded remote settings environment with this device's current configuration.",
				visible: () => this.host.getSettingsSyncStatus().seeded === true,
				action: () => this.confirmSettingsSyncAction(
					"Replace the remote settings environment?",
					"This overwrites the shared remote settings environment with this device's current managed configuration.",
					"Replace remote",
					() => this.host.replaceSettingsSyncEnvironment(),
				),
			},
			{
				name: "Automatically install remote plugins and themes",
				desc: "Consent to foreground installation and removal needed by the remote environment. Off by default.",
				control: { type: "toggle", key: "settingsSyncAutoInstall" },
			},
			{
				name: "Settings-sync clash",
				desc: status.clashId ? `Conflicting plugin: ${status.clashId}` : "",
				visible: () => this.host.getSettingsSyncStatus().clashId !== null,
			},
			{
				name: "Ignored unknown configuration files",
				desc: status.unknownFiles.join(", "),
				visible: () => this.host.getSettingsSyncStatus().unknownFiles.length > 0,
			},
			{
				name: "Restart required",
				desc: "Restart Obsidian to finish applying settings changes.",
				visible: () => this.host.getSettingsSyncStatus().needsRestart,
			},
		];
		for (const mismatch of status.versionMismatches) {
			items.push(
				{
					name: `Update ${mismatch.pluginId} to ${mismatch.pin}`,
					desc: `Installed ${mismatch.localVersion || "missing"}; remote pin ${mismatch.pin}.`,
					visible: () => !mismatch.localAhead,
					action: () => this.finishSettingsSyncAction(() => this.host.updateSettingsSyncPlugin(mismatch.pluginId)),
				},
				{
					name: `Promote ${mismatch.pluginId} pin`,
					desc: `Use this device's ${mismatch.localVersion} version as the remote pin.`,
					visible: () => mismatch.localAhead,
					action: () => this.finishSettingsSyncAction(() => this.host.promoteSettingsSyncPlugin(mismatch.pluginId)),
				},
				{
					name: `Remove ${mismatch.pluginId} from settings environment`,
					desc: "Remove the mismatched plugin from the shared settings environment and this device.",
					action: () => this.confirmSettingsSyncRemoval("plugin", mismatch.pluginId),
				},
			);
		}
		for (const plugin of status.environmentPlugins) {
			items.push({
				name: `Environment plugin: ${plugin.id}`,
				desc: `${plugin.version}${plugin.enabled ? " (enabled)" : " (disabled)"}`,
				action: () => this.confirmSettingsSyncRemoval("plugin", plugin.id),
			});
		}
		for (const theme of status.environmentThemes) {
			items.push({
				name: `Environment theme: ${theme.name}`,
				desc: theme.version,
				action: () => this.confirmSettingsSyncRemoval("theme", theme.name),
			});
		}
		return { type: "group", heading: "Obsidian settings sync", items };
	}

	private confirmSettingsSyncAction(
		title: string,
		message: string,
		confirmText: string,
		action: () => Promise<void>,
	): void {
		new ConfirmModal(
			this.app,
			title,
			message,
			() => this.finishSettingsSyncAction(action),
			confirmText,
		).open();
	}

	private confirmSettingsSyncRemoval(kind: "plugin" | "theme", id: string): void {
		this.confirmSettingsSyncAction(
			`Remove ${kind} from the settings environment?`,
			`This removes ${id} from the shared settings environment and from this device. Other devices will observe the removal.`,
			`Remove ${kind}`,
			() => this.host.removeSettingsSyncEnvironmentItem(kind, id),
		);
	}

	private finishSettingsSyncAction(action: () => Promise<void>): void {
		void action()
			.catch((error: unknown) => {
				new Notice(`Settings sync action failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
			})
			.finally(() => this.update());
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
			case "pairingCode": return this.pairingCode;
			case "updateRepoUrl": return this.host.settings.updateRepoUrl;
			case "updateRepoBranch": return this.host.settings.updateRepoBranch;
			case "externalEditPolicy": return this.host.settings.externalEditPolicy;
			case "frontmatterGuardEnabled": return this.host.settings.frontmatterGuardEnabled;
			case "settingsSyncEnabled": return this.host.settings.settingsSyncEnabled;
			case "settingsSyncAutoInstall": return this.host.settings.settingsSyncAutoInstall;
			case "debug": return this.host.settings.debug;
			default: throw new Error(`Unknown Yaos setting: ${key}`);
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key as DeclarativeSettingKey) {
			case "deviceName": {
				const nextName = expectStringValue(key, value).trim();
				await this.host.updateSettings((settings) => {
					settings.deviceName = nextName;
				}, "settings:device-name");
				await this.host.renameThisDevice(nextName);
				return;
			}
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
			case "pairingCode":
				this.pairingCode = expectStringValue(key, value);
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
			case "settingsSyncEnabled":
				await this.host.updateSettings((settings) => {
					settings.settingsSyncEnabled = expectBooleanValue(key, value);
				}, "settings:settings-sync-toggle");
				await this.host.refreshSettingsSyncRuntime();
				this.update();
				return;
			case "settingsSyncAutoInstall":
				await this.host.updateSettings((settings) => {
					settings.settingsSyncAutoInstall = expectBooleanValue(key, value);
				}, "settings:settings-sync-auto-install");
				await this.host.refreshSettingsSyncRuntime();
				this.update();
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

	private buildRosterGroup(): SettingDefinitionItem {
		const vaultId = this.host.settings.vaultId.trim();
		if (this.lastRosterVaultId !== vaultId) {
			this.lastRosterVaultId = vaultId;
			if (vaultId) void this.host.refreshVaultRoster().then(() => this.update());
		}
		const localDeviceId = this.host.settings.deviceId;
		const items: SettingDefinition[] = this.host.getVaultRoster().map((device) => {
			const isThis = device.deviceId === localDeviceId && localDeviceId.length > 0;
			const online = this.host.isDeviceOnline(device.deviceId);
			return {
				name: `${online ? "Online · " : ""}${device.name}${isThis ? " · This device" : ""}`,
				desc: formatRosterLastSeen(device.lastSeenAt),
			};
		});
		if (items.length === 0) {
			items.push({ name: "No devices loaded", desc: "Refresh to load the enrolled device roster." });
		}
		items.push({
			name: "Refresh roster",
			desc: "Reload enrolled devices, online presence, and last-seen times.",
			action: () => { void this.host.refreshVaultRoster().then(() => this.update()); },
		});
		return { type: "group", heading: "On this vault", items };
	}

	async submitEnrollment(): Promise<boolean> {
		const host = this.host.settings.host.trim();
		const pairingCode = this.pairingCode.trim();
		if (!host || !pairingCode) {
			new Notice("Enter the server URL and pairing code.");
			return false;
		}
		const enrolled = await this.host.enrollByPaste(host, pairingCode);
		const completeEnrollment = enrolled
			&& this.host.settings.host.trim().length > 0
			&& this.host.settings.deviceToken.trim().length > 0
			&& this.host.settings.vaultId.trim().length > 0
			&& this.host.settings.deviceId.trim().length > 0;
		if (!completeEnrollment) return false;
		this.pairingCode = "";
		this.update();
		return true;
	}

	async openPairing(): Promise<boolean> {
		const links = await this.host.mintDevicePairing();
		if (!links) return false;
		new PairDeviceModal(this.app, links.deepLink, links.mobileUrl).open();
		return true;
	}

	private openDeviceCredentials(): void {
		const credentials = this.host.buildDeviceCredentialsText();
		if (!credentials) {
			new Notice("Complete device enrollment before exporting credentials.", 7000);
			return;
		}
		new DeviceCredentialsModal(this.app, credentials).open();
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
