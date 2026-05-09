import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { PairDeviceModal } from "./PairDeviceModal";
import { RecoveryKitModal } from "./RecoveryKitModal";
import type { ExternalEditPolicy, VaultSyncSettings } from "./settingsStore";

type SettingsAuthMode = "env" | "claim" | "unclaimed" | "unknown";
type SettingsStatusState = "disconnected" | "loading" | "syncing" | "connected" | "offline" | "error" | "unauthorized";

interface SettingsUpdateState {
	serverVersion: string | null;
	latestServerVersion: string | null;
	serverUpdateAvailable: boolean;
	pluginVersion: string;
	latestPluginVersion: string | null;
	pluginUpdateRecommended: boolean;
	migrationRequired: boolean;
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
	updateSettings(mutator: (settings: VaultSyncSettings) => void, reason?: string): Promise<void>;
	refreshServerCapabilities(reason?: string): Promise<void>;
	refreshUpdateManifest(reason?: string, force?: boolean): Promise<void>;
	refreshAttachmentSyncRuntime(reason?: string): Promise<void>;
	getSettingsStatusSummary(): { state: SettingsStatusState; label: string };
	getUpdateState(): SettingsUpdateState;
	buildSetupDeepLink(): string | null;
	buildMobileSetupUrl(): string | null;
	buildRecoveryKitText(): string | null;
}

const CLOUDFLARE_DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server";

/** Returns true if the host URL is unencrypted and not localhost. */
function isInsecureRemoteHost(host: string): boolean {
	if (!host) return false;
	try {
		const url = new URL(host);
		if (url.protocol !== "http:") return false;
		const h = url.hostname;
		if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return false;
		return true;
	} catch {
		return false;
	}
}

function shortenMiddle(value: string, maxLength = 36): string {
	if (value.length <= maxLength) return value;
	const edge = Math.max(8, Math.floor((maxLength - 3) / 2));
	return `${value.slice(0, edge)}...${value.slice(-edge)}`;
}

function addSectionHeading(containerEl: HTMLElement, title: string): void {
	new Setting(containerEl)
		.setName(title)
		.setHeading();
}

function addCardRow(containerEl: HTMLElement, label: string, value: string): void {
	const row = containerEl.createDiv({ cls: "yaos-settings-card-row" });
	row.createSpan({ text: label, cls: "yaos-settings-card-label" });
	row.createSpan({ text: value, cls: "yaos-settings-card-value" });
}

function statusClass(state: string): string {
	switch (state) {
		case "connected":
			return "is-connected";
		case "offline":
		case "loading":
		case "syncing":
			return "is-busy";
		case "error":
		case "unauthorized":
			return "is-error";
		default:
			return "is-idle";
	}
}

function createDetailsSection(containerEl: HTMLElement, title: string, open = false): HTMLDetailsElement {
	const detailsEl = containerEl.createEl("details", { cls: "yaos-settings-details" });
	detailsEl.open = open;
	detailsEl.createEl("summary", {
		text: title,
		cls: "yaos-settings-details-summary",
	});
	return detailsEl;
}

export class VaultSyncSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		plugin: Plugin,
		private readonly host: VaultSyncSettingsHost,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("yaos-settings-tab");
		const authMode = this.host.serverAuthMode;
		const attachmentsAvailable = this.host.serverSupportsAttachments;
		const setupIncomplete = !this.host.settings.host || !this.host.settings.token;
		const syncStatus = this.host.getSettingsStatusSummary();

		addSectionHeading(containerEl, "YAOS");

		if (setupIncomplete) {
			const callout = containerEl.createDiv({ cls: "callout yaos-settings-setup-callout" });
			callout.setAttr("data-callout", "warning");

			const calloutTitle = callout.createDiv({ cls: "callout-title" });
			calloutTitle.createSpan({ text: "Setup required" });

			const calloutContent = callout.createDiv({ cls: "callout-content" });
			calloutContent.createEl("p", {
				text: "This plugin needs a free sync server to sync your data. It costs $0 and takes about 15 seconds.",
			});

			calloutContent.createEl("p", {
				text: "After deployment, open your server URL, claim the server, then use the setup link.",
				cls: "yaos-settings-setup-hint",
			});

			new Setting(calloutContent)
				.setName("Deploy your server")
				.setDesc("Start one-click deployment in your browser.")
				.addButton((button) =>
					button
						.setButtonText("Open deploy page")
						.setCta()
						.onClick(() => {
							window.open(CLOUDFLARE_DEPLOY_URL, "_blank", "noopener");
						}),
				);
		}

		if (!setupIncomplete) {
			addSectionHeading(containerEl, "Sync status");

			const card = containerEl.createDiv({ cls: "yaos-settings-status-card" });

			const statusLine = card.createDiv({ cls: "yaos-settings-status-line" });

				const titleWrap = statusLine.createDiv({ cls: "yaos-settings-status-copy" });
				titleWrap.createEl("div", {
					text: "Sync is configured",
					cls: "yaos-settings-status-title",
				});
			titleWrap.createEl("div", {
				text: "Use the actions below to pair more devices or back up your connection details.",
				cls: "yaos-settings-status-subtitle",
			});

			statusLine.createSpan({
				text: syncStatus.label,
				cls: `yaos-settings-status-badge ${statusClass(syncStatus.state)}`,
			});

			addCardRow(card, "Status", syncStatus.label);
			addCardRow(card, "Server", this.host.settings.host);
			addCardRow(card, "Vault", shortenMiddle(this.host.settings.vaultId || "(not set)"));
			addCardRow(card, "This device", this.host.settings.deviceName || "(unnamed)");

			const actionRow = card.createDiv({ cls: "modal-button-container yaos-settings-status-actions" });

				actionRow.createEl("button", { text: "Pair another device" }).addEventListener("click", () => {
					const deepLink = this.host.buildSetupDeepLink();
					const mobileUrl = this.host.buildMobileSetupUrl();
					if (!deepLink || !mobileUrl) {
						new Notice("Configure the server URL, sync token, and vault ID before pairing.", 7000);
						return;
					}
					new PairDeviceModal(this.app, deepLink, mobileUrl).open();
			});

				actionRow.createEl("button", { text: "Backup connection details" }).addEventListener("click", () => {
					const recoveryKit = this.host.buildRecoveryKitText();
					if (!recoveryKit) {
						new Notice("Configure the server URL, sync token, and vault ID before exporting connection details.", 7000);
						return;
					}
					new RecoveryKitModal(this.app, recoveryKit).open();
			});
		}

		if (!setupIncomplete) {
			const updateState = this.host.getUpdateState();
			addSectionHeading(containerEl, "Updates");

			const updateCard = containerEl.createDiv({ cls: "yaos-settings-status-card" });
			addCardRow(updateCard, "Server version", updateState.serverVersion ?? "Unknown");
			addCardRow(updateCard, "Latest server", updateState.latestServerVersion ?? "Unknown");
			addCardRow(updateCard, "Plugin version", updateState.pluginVersion);
			addCardRow(updateCard, "Latest plugin", updateState.latestPluginVersion ?? "Unknown");
			addCardRow(
				updateCard,
				"Update path",
				updateState.updateRepoUrl ?? "Not configured",
			);

			const summaryText = updateState.serverUpdateAvailable
				? updateState.migrationRequired
					? "A migration-sensitive server update is available. Use the guided update path."
					: "A server update is available."
				: updateState.pluginUpdateRecommended
					? "This device should update the YAOS plugin soon."
					: "Server and plugin are up to date with the latest cached manifest.";
			updateCard.createEl("p", {
				text: summaryText,
				cls: "yaos-settings-status-subtitle",
			});

			if (updateState.pluginCompatibilityWarning) {
				updateCard.createEl("p", {
					text: updateState.pluginCompatibilityWarning,
					cls: "yaos-settings-security-warning",
				});
			}
			if (updateState.legacyServerDetected) {
				updateCard.createEl("p", {
					text: "Legacy server detected. Sync will continue, but update metadata and 1-click updater features need a newer server.",
					cls: "yaos-settings-security-warning",
				});
			}

			const updateActions = updateCard.createDiv({ cls: "modal-button-container yaos-settings-status-actions" });
			updateActions.createEl("button", { text: "Refresh update info" }).addEventListener("click", () => {
				void this.host.refreshServerCapabilities("settings-refresh");
				void this.host.refreshUpdateManifest("settings-refresh", true).then(() => this.display());
			});
			const updateActionUrl = updateState.updateActionUrl;
			if (updateActionUrl) {
				updateActions.createEl("button", {
					text: "Open update action",
				}).addEventListener("click", () => {
					window.open(updateActionUrl, "_blank", "noopener");
				});
			}
			const bootstrapUrl = updateState.updateBootstrapUrl;
			if (bootstrapUrl) {
				updateActions.createEl("button", { text: "Initialize updater" }).addEventListener("click", () => {
					window.open(bootstrapUrl, "_blank", "noopener");
				});
			}
		}

		addSectionHeading(containerEl, "This device");
		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Shown to other devices in live cursors and presence.")
			.addText((text) =>
				text
					.setPlaceholder("My laptop")
					.setValue(this.host.settings.deviceName)
					.onChange(async (value) => {
						await this.host.updateSettings((settings) => {
							settings.deviceName = value.trim();
						}, "settings:device-name");
					}),
			);

		addSectionHeading(containerEl, "What syncs");
			new Setting(containerEl)
				.setName("Exclude paths")
				.setDesc("Comma-separated path prefixes to skip. Example: templates/, .trash/, daily-notes/")
				.addText((text) =>
					text
						.setPlaceholder("Example: templates/, daily-notes/")
						.setValue(this.host.settings.excludePatterns)
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.excludePatterns = value;
							}, "settings:exclude-patterns");
					}),
			);

			new Setting(containerEl)
				.setName("Max text file size in kilobytes")
				.setDesc("Text files larger than this are skipped for live document sync.")
			.addText((text) =>
				text
					.setPlaceholder("2048")
					.setValue(String(this.host.settings.maxFileSizeKB))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							await this.host.updateSettings((settings) => {
								settings.maxFileSizeKB = n;
							}, "settings:max-file-size");
						}
					}),
			);

				addSectionHeading(containerEl, "Attachments");

			if (this.host.settings.host) {
				new Setting(containerEl)
					.setName("Attachment storage")
					.setDesc(
						attachmentsAvailable
							? "Available on this server. The plugin can sync attachments and snapshots."
							: "Not available on this server. Add object storage in Cloudflare, then redeploy.",
					)
					.addButton((button) =>
						button
						.setButtonText("Refresh")
						.onClick(async () => {
							button.setDisabled(true);
							await this.host.refreshServerCapabilities();
							await this.host.refreshAttachmentSyncRuntime("capability-refresh");
							this.display();
						}),
				);
		}

				if (this.host.settings.host && !attachmentsAvailable) {
					const callout = containerEl.createDiv({ cls: "yaos-settings-attachment-callout" });
					callout.createEl("p", {
						text: "Attachments are not syncing yet.",
					});
					callout.createEl("p", {
						text: "Add object storage to enable attachment sync. It takes about a minute.",
					});
					const link = callout.createEl("a", {
						text: "Watch the 1-minute setup video",
						href: "https://youtu.be/Z7xCMEYfdFM",
					});
					link.setAttr("target", "_blank");
				}

		if (attachmentsAvailable || !this.host.settings.host) {
				new Setting(containerEl)
					.setName("Sync attachments")
					.setDesc(
						"Sync images, PDF files, and other attachments through object storage. This is enabled by default when the server supports it.",
					)
				.addToggle((toggle) =>
					toggle
						.setValue(this.host.settings.enableAttachmentSync)
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.enableAttachmentSync = value;
								settings.attachmentSyncExplicitlyConfigured = true;
							}, "settings:attachment-toggle");
							await this.host.refreshAttachmentSyncRuntime("attachment-toggle");
							this.display();
						}),
				);
		}

			if ((attachmentsAvailable || !this.host.settings.host) && this.host.settings.enableAttachmentSync) {
				new Setting(containerEl)
					.setName("Max attachment size in kilobytes")
					.setDesc("Attachments larger than this are skipped.")
				.addText((text) =>
					text
						.setPlaceholder("10240")
						.setValue(String(this.host.settings.maxAttachmentSizeKB))
						.onChange(async (value) => {
							const n = parseInt(value, 10);
							if (!isNaN(n) && n > 0) {
								await this.host.updateSettings((settings) => {
									settings.maxAttachmentSizeKB = n;
								}, "settings:max-attachment-size");
							}
						}),
				);

			new Setting(containerEl)
				.setName("Parallel transfers")
				.setDesc("Default 1 favors reliability on slow or mobile networks.")
				.addSlider((slider) =>
					slider
						.setLimits(1, 5, 1)
						.setValue(this.host.settings.attachmentConcurrency)
						.setDynamicTooltip()
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.attachmentConcurrency = value;
							}, "settings:attachment-concurrency");
						}),
				);
		}

		addSectionHeading(containerEl, "Collaboration");
		new Setting(containerEl)
			.setName("Show remote cursors")
			.setDesc("Show other devices' cursors and selections while editing.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.showRemoteCursors)
					.onChange(async (value) => {
						await this.host.updateSettings((settings) => {
							settings.showRemoteCursors = value;
						}, "settings:remote-cursors");
					}),
			);

		const manualDetails = createDetailsSection(containerEl, "Manual connection", setupIncomplete);
		const manualBody = manualDetails.createDiv({ cls: "yaos-settings-details-body" });
				if (setupIncomplete) {
					manualBody.createEl("p", {
						text: "Claim your server in the browser, then use the setup link. You can also enter the connection details manually here.",
							cls: "yaos-settings-details-intro",
						});
					}

				new Setting(manualBody)
					.setName("Server URL")
					.setDesc("Your server URL. This is usually filled in automatically by the setup flow.")
					.addText((text) =>
						text
							.setPlaceholder("Paste the server URL")
							.setValue(this.host.settings.host)
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.host = value.trim();
							}, "settings:host");
						this.display();
					}),
			);

			if (isInsecureRemoteHost(this.host.settings.host)) {
				manualBody.createEl("p", {
					text: "This remote connection is unencrypted. Your sync token will be sent in plaintext. Use HTTPS for production.",
					cls: "yaos-settings-security-warning",
				});
			}

			new Setting(manualBody)
				.setName("Sync token")
				.setDesc(
					authMode === "unclaimed"
						? "Leave this blank until you claim the server in a browser, then use the setup link."
						: authMode === "env"
							? "Must match the SYNC_TOKEN configured on the server."
							: "This is usually filled in automatically by the setup link after you claim the server.",
				)
				.addText((text) =>
					text
						.setPlaceholder("Paste your sync token")
						.setValue(this.host.settings.token)
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.token = value.trim();
							}, "settings:token");
						this.display();
					}),
			);

		const advancedDetails = createDetailsSection(containerEl, "Advanced", false);
		const advancedBody = advancedDetails.createDiv({ cls: "yaos-settings-details-body" });

			new Setting(advancedBody)
				.setName("Vault ID")
				.setDesc("Devices syncing the same vault must use exactly the same vault ID. Change only if you know what you are doing.")
				.addText((text) =>
					text
						.setPlaceholder("Generated automatically")
						.setValue(this.host.settings.vaultId)
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.vaultId = value.trim();
							}, "settings:vault-id");
						this.display();
					}),
			);

			new Setting(advancedBody)
				.setName("Deployment repo URL")
				.setDesc("Optional. Example: https://github.com/you/yaos-server. Provider is inferred from this URL.")
				.addText((text) =>
					text
						.setPlaceholder("Paste the generated GitHub or GitLab repo URL")
						.setValue(this.host.settings.updateRepoUrl)
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.updateRepoUrl = value.trim();
							}, "settings:update-repo-url");
							this.display();
						}),
				);

			new Setting(advancedBody)
				.setName("Deployment default branch")
				.setDesc("Used for GitLab pipeline links and future provider-native update helpers.")
				.addText((text) =>
						text
							.setPlaceholder("Default branch (for example, main)")
							.setValue(this.host.settings.updateRepoBranch)
						.onChange(async (value) => {
							await this.host.updateSettings((settings) => {
								settings.updateRepoBranch = value.trim() || "main";
							}, "settings:update-repo-branch");
						}),
				);

			new Setting(advancedBody)
				.setName("Edits from other apps")
				.setDesc("Choose how the plugin handles file changes from Git, scripts, or other editors.")
				.addDropdown((dropdown) =>
					dropdown
						.addOption("always", "Always import")
					.addOption("closed-only", "Only when file is closed")
					.addOption("never", "Never import")
					.setValue(this.host.settings.externalEditPolicy)
					.onChange(async (value) => {
						await this.host.updateSettings((settings) => {
							settings.externalEditPolicy = value as ExternalEditPolicy;
						}, "settings:external-edit-policy");
					}),
			);

		new Setting(advancedBody)
			.setName("Frontmatter safety guard")
			.setDesc("Pause suspicious YAML property updates before they spread. Disable only while troubleshooting valid frontmatter that is being blocked.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.frontmatterGuardEnabled)
					.onChange(async (value) => {
						await this.host.updateSettings((settings) => {
							settings.frontmatterGuardEnabled = value;
						}, "settings:frontmatter-guard");
					}),
			);

		new Setting(advancedBody)
			.setName("Debug logging")
			.setDesc("Enable verbose console logs for troubleshooting.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.host.settings.debug)
					.onChange(async (value) => {
						await this.host.updateSettings((settings) => {
							settings.debug = value;
						}, "settings:debug");
					}),
			);

			advancedBody.createEl("p", {
				text: "Changing the server URL, sync token, or vault ID requires reloading the plugin.",
				cls: "setting-item-description",
			});
	}
}
