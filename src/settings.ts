import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import * as QRCode from "qrcode";
import type VaultCrdtSyncPlugin from "./main";
import { randomBase64Url } from "./utils/base64url";

/** Controls how external disk edits (git, other editors) are imported into CRDT. */
export type ExternalEditPolicy = "always" | "closed-only" | "never";

export interface VaultSyncSettings {
	/** Cloudflare Worker host, e.g. "https://sync.yourdomain.com" */
	host: string;
	/** Shared secret token for auth. */
	token: string;
	/** Unique vault identifier. Generated randomly if empty on first load. */
	vaultId: string;
	/** Human-readable device name shown in awareness/cursors. */
	deviceName: string;
	/** Enable verbose console.log output for debugging. */
	debug: boolean;
	/** Comma-separated path prefixes to exclude from sync. */
	excludePatterns: string;
	/** Maximum file size in KB to sync via CRDT. Files larger are skipped. */
	maxFileSizeKB: number;
	/**
	 * How to handle external disk modifications (git pull, other editors).
	 *   "always"      — always import into CRDT (default, current behavior)
	 *   "closed-only" — import only for files not open in an editor
	 *   "never"       — never import (CRDT is sole source of truth)
	 */
	externalEditPolicy: ExternalEditPolicy;
	/** Enable attachment (non-markdown) sync via R2 blob store. */
	enableAttachmentSync: boolean;
	/** True once the user has explicitly changed the attachment sync toggle. */
	attachmentSyncExplicitlyConfigured: boolean;
	/** Maximum attachment size in KB. Files larger are skipped. Default 10240 (10 MB). */
	maxAttachmentSizeKB: number;
	/** Number of parallel upload/download slots. */
	attachmentConcurrency: number;
	/** Show remote cursors and selections in the editor. */
	showRemoteCursors: boolean;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
	host: "",
	token: "",
	vaultId: "",
	deviceName: "",
	debug: false,
	excludePatterns: "",
	maxFileSizeKB: 2048,
	externalEditPolicy: "always",
	enableAttachmentSync: true,
	attachmentSyncExplicitlyConfigured: false,
	maxAttachmentSizeKB: 10240,
	// requestUrl cannot be hard-aborted; default to 1 to avoid stacked zombie transfers.
	attachmentConcurrency: 1,
	showRemoteCursors: true,
};

const CLOUDFLARE_DEPLOY_URL = "https://deploy.workers.cloudflare.com/?url=https://github.com/kavinsood/yaos/tree/main/server";

/** Generate a random vault ID (16 bytes, base64url). */
export function generateVaultId(): string {
	return randomBase64Url(16);
}

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

class PairDeviceModal extends Modal {
	private qrCanvas: HTMLCanvasElement | null = null;

	constructor(
		app: App,
		private readonly deepLink: string,
		private readonly mobileUrl: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaos-pair-device-modal");

		contentEl.createEl("h3", { text: "Pair another device" });
		contentEl.createEl("p", {
			text: "Scan this QR code on your phone to open the YAOS setup page. If YAOS is not installed yet, the page will guide you through BRAT first.",
			cls: "yaos-modal-copy",
		});

		const qrWrap = contentEl.createDiv({ cls: "yaos-pair-device-qr-wrap" });

		const loadingEl = qrWrap.createEl("div", {
			text: "Generating QR code...",
			cls: "yaos-pair-device-loading",
		});

		this.qrCanvas = qrWrap.createEl("canvas", { cls: "yaos-pair-device-qr-canvas" });
		this.qrCanvas.hidden = true;

		void QRCode.toCanvas(this.qrCanvas, this.mobileUrl, {
			width: 220,
			margin: 1,
			errorCorrectionLevel: "M",
		}).then(() => {
			loadingEl.remove();
			if (this.qrCanvas) {
				this.qrCanvas.hidden = false;
				this.qrCanvas.setAttr("aria-label", "YAOS mobile setup QR");
			}
		}).catch(() => {
			loadingEl.setText("Could not generate QR code.");
			if (this.qrCanvas) {
				this.qrCanvas.remove();
				this.qrCanvas = null;
			}
		});

		const primaryButtons = contentEl.createDiv({ cls: "modal-button-container" });
		primaryButtons.createEl("button", { text: "Copy mobile setup URL" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.mobileUrl).then(
				() => new Notice("YAOS: mobile setup URL copied."),
				() => new Notice("YAOS: failed to copy mobile setup URL.", 6000),
			);
		});
		primaryButtons.createEl("button", { text: "Open mobile setup page" }).addEventListener("click", () => {
			window.open(this.mobileUrl, "_blank", "noopener");
		});

		const manualDetails = createDetailsSection(contentEl, "Desktop or manual setup", false);
		const manualBody = manualDetails.createDiv({ cls: "yaos-settings-details-body" });

		manualBody.createEl("h4", { text: "Mobile setup URL" });
		const mobileInput = manualBody.createEl("textarea", { cls: "yaos-settings-modal-textarea" });
		mobileInput.value = this.mobileUrl;
		mobileInput.readOnly = true;
		mobileInput.rows = 3;

		const mobileButtons = manualBody.createDiv({ cls: "modal-button-container" });
		mobileButtons.createEl("button", { text: "Copy mobile setup URL" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.mobileUrl).then(
				() => new Notice("YAOS: mobile setup URL copied."),
				() => new Notice("YAOS: failed to copy mobile setup URL.", 6000),
			);
		});
		mobileButtons.createEl("button", { text: "Open mobile setup page" }).addEventListener("click", () => {
			window.open(this.mobileUrl, "_blank", "noopener");
		});

		manualBody.createEl("h4", { text: "Desktop deep link" });
		const deepInput = manualBody.createEl("textarea", { cls: "yaos-settings-modal-textarea" });
		deepInput.value = this.deepLink;
		deepInput.readOnly = true;
		deepInput.rows = 3;

		const deepButtons = manualBody.createDiv({ cls: "modal-button-container" });
		deepButtons.createEl("button", { text: "Copy desktop deep link" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.deepLink).then(
				() => new Notice("YAOS: desktop deep link copied."),
				() => new Notice("YAOS: failed to copy desktop deep link.", 6000),
			);
		});

		contentEl.createDiv({ cls: "modal-button-container" })
			.createEl("button", { text: "Close" })
			.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
		this.qrCanvas = null;
	}
}

class RecoveryKitModal extends Modal {
	constructor(app: App, private readonly recoveryKit: string) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaos-recovery-kit-modal");

		contentEl.createEl("h3", { text: "Backup connection details" });

		const warning = contentEl.createDiv({ cls: "callout yaos-settings-callout" });
		warning.setAttr("data-callout", "warning");

		const warningTitle = warning.createDiv({ cls: "callout-title" });
		warningTitle.createSpan({ text: "Save this somewhere safe" });

		const warningBody = warning.createDiv({ cls: "callout-content" });
		warningBody.createEl("p", {
			text: "Save this somewhere safe (like a password manager). If you lose all your devices, you will need this exact Vault ID and Token to recover your notes from your server.",
		});

		const textArea = contentEl.createEl("textarea", { cls: "yaos-settings-modal-textarea" });
		textArea.value = this.recoveryKit;
		textArea.readOnly = true;
		textArea.rows = 10;

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Copy connection details" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.recoveryKit).then(
				() => new Notice("YAOS: connection details copied."),
				() => new Notice("YAOS: failed to copy connection details.", 6000),
			);
		});
		buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class VaultSyncSettingTab extends PluginSettingTab {
	plugin: VaultCrdtSyncPlugin;

	constructor(app: App, plugin: VaultCrdtSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("yaos-settings-tab");
		const authMode = this.plugin.serverAuthMode;
		const attachmentsAvailable = this.plugin.serverSupportsAttachments;
		const setupIncomplete = !this.plugin.settings.host || !this.plugin.settings.token;
		const syncStatus = this.plugin.getSettingsStatusSummary();

		addSectionHeading(containerEl, "YAOS");

		if (setupIncomplete) {
			const callout = containerEl.createDiv({ cls: "callout yaos-settings-setup-callout" });
			callout.setAttr("data-callout", "warning");

			const calloutTitle = callout.createDiv({ cls: "callout-title" });
			calloutTitle.createSpan({ text: "Setup required" });

			const calloutContent = callout.createDiv({ cls: "callout-content" });
			calloutContent.createEl("p", {
				text: "YAOS requires a free Cloudflare Worker to sync your data. It costs $0 and takes about 15 seconds.",
			});

			calloutContent.createEl("p", {
				text: "After deploy, open your Worker URL, claim the server, then use the YAOS setup link.",
				cls: "yaos-settings-setup-hint",
			});

			new Setting(calloutContent)
				.setName("Deploy your server")
				.setDesc("Launch one-click Cloudflare deployment in your browser.")
				.addButton((button) =>
					button
						.setButtonText("Deploy to Cloudflare")
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
				text: "YAOS is configured",
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
			addCardRow(card, "Server", this.plugin.settings.host);
			addCardRow(card, "Vault", shortenMiddle(this.plugin.settings.vaultId || "(not set)"));
			addCardRow(card, "This device", this.plugin.settings.deviceName || "(unnamed)");

			const actionRow = card.createDiv({ cls: "modal-button-container yaos-settings-status-actions" });

			actionRow.createEl("button", { text: "Pair another device" }).addEventListener("click", () => {
				const deepLink = this.plugin.buildSetupDeepLink();
				const mobileUrl = this.plugin.buildMobileSetupUrl();
				if (!deepLink || !mobileUrl) {
					new Notice("YAOS: configure server URL, sync token, and vault ID before pairing.", 7000);
					return;
				}
				new PairDeviceModal(this.app, deepLink, mobileUrl).open();
			});

			actionRow.createEl("button", { text: "Backup connection details" }).addEventListener("click", () => {
				const recoveryKit = this.plugin.buildRecoveryKitText();
				if (!recoveryKit) {
					new Notice("YAOS: configure server URL, sync token, and vault ID before exporting connection details.", 7000);
					return;
				}
				new RecoveryKitModal(this.app, recoveryKit).open();
			});
		}

		addSectionHeading(containerEl, "This device");
		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Shown to other devices in live cursors and presence.")
			.addText((text) =>
				text
					.setPlaceholder("My laptop")
					.setValue(this.plugin.settings.deviceName)
					.onChange(async (value) => {
						this.plugin.settings.deviceName = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		addSectionHeading(containerEl, "What syncs");
		new Setting(containerEl)
			.setName("Exclude paths")
			.setDesc("Comma-separated path prefixes to skip. Example: templates/, .trash/, daily-notes/")
			.addText((text) =>
				text
					.setPlaceholder("templates/, .trash/")
					.setValue(this.plugin.settings.excludePatterns)
					.onChange(async (value) => {
						this.plugin.settings.excludePatterns = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Max text file size (KB)")
			.setDesc("Text files larger than this are skipped for live document sync.")
			.addText((text) =>
				text
					.setPlaceholder("2048")
					.setValue(String(this.plugin.settings.maxFileSizeKB))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.maxFileSizeKB = n;
							await this.plugin.saveSettings();
						}
					}),
			);

			addSectionHeading(containerEl, "Attachments");

		if (this.plugin.settings.host) {
			new Setting(containerEl)
				.setName("Attachment storage")
				.setDesc(
					attachmentsAvailable
						? "Available on this server. YAOS can sync attachments and snapshots."
						: "Not available on this server. Add an R2 binding named YAOS_BUCKET in Cloudflare, then redeploy.",
				)
				.addButton((button) =>
					button
						.setButtonText("Refresh")
						.onClick(async () => {
							button.setDisabled(true);
							await this.plugin.refreshServerCapabilities();
							await this.plugin.refreshAttachmentSyncRuntime("capability-refresh");
							this.display();
						}),
				);
		}

		if (this.plugin.settings.host && !attachmentsAvailable) {
			containerEl.createEl("p", {
				text: "Attachment sync is unavailable on this server. Add an R2 binding named YAOS_BUCKET in Cloudflare to enable it.",
				cls: "yaos-settings-attachment-note",
			});
		}

		if (attachmentsAvailable || !this.plugin.settings.host) {
			new Setting(containerEl)
				.setName("Sync attachments")
				.setDesc(
					"Sync images, PDFs, and other non-markdown files via object storage. Enabled by default when the server supports it.",
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.enableAttachmentSync)
						.onChange(async (value) => {
							this.plugin.settings.enableAttachmentSync = value;
							this.plugin.settings.attachmentSyncExplicitlyConfigured = true;
							await this.plugin.saveSettings();
							await this.plugin.refreshAttachmentSyncRuntime("attachment-toggle");
							this.display();
						}),
				);
		}

		if ((attachmentsAvailable || !this.plugin.settings.host) && this.plugin.settings.enableAttachmentSync) {
			new Setting(containerEl)
				.setName("Max attachment size (KB)")
				.setDesc("Attachments larger than this are skipped.")
				.addText((text) =>
					text
						.setPlaceholder("10240")
						.setValue(String(this.plugin.settings.maxAttachmentSizeKB))
						.onChange(async (value) => {
							const n = parseInt(value, 10);
							if (!isNaN(n) && n > 0) {
								this.plugin.settings.maxAttachmentSizeKB = n;
								await this.plugin.saveSettings();
							}
						}),
				);

			new Setting(containerEl)
				.setName("Parallel transfers")
				.setDesc("Default 1 favors reliability on slow or mobile networks.")
				.addSlider((slider) =>
					slider
						.setLimits(1, 5, 1)
						.setValue(this.plugin.settings.attachmentConcurrency)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.attachmentConcurrency = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		addSectionHeading(containerEl, "Collaboration");
		new Setting(containerEl)
			.setName("Show remote cursors")
			.setDesc("Show other devices' cursors and selections while editing.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showRemoteCursors)
					.onChange(async (value) => {
						this.plugin.settings.showRemoteCursors = value;
						await this.plugin.saveSettings();
						this.plugin.applyCursorVisibility();
					}),
			);

		const manualDetails = createDetailsSection(containerEl, "Manual connection", setupIncomplete);
		const manualBody = manualDetails.createDiv({ cls: "yaos-settings-details-body" });
		if (setupIncomplete) {
			manualBody.createEl("p", {
				text: "Claim your Worker in the browser, then use the YAOS setup link. You can also enter the connection details manually here.",
					cls: "yaos-settings-details-intro",
				});
			}

		new Setting(manualBody)
			.setName("Server URL")
			.setDesc("Your YAOS Worker URL. Usually filled in automatically by the setup flow.")
			.addText((text) =>
				text
					.setPlaceholder("https://...")
					.setValue(this.plugin.settings.host)
					.onChange(async (value) => {
						this.plugin.settings.host = value.trim();
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (isInsecureRemoteHost(this.plugin.settings.host)) {
			manualBody.createEl("p", {
				text: "Warning: using an unencrypted remote connection. Your sync token will be sent in plaintext. Use https:// for production.",
				cls: "yaos-settings-security-warning",
			});
		}

		new Setting(manualBody)
			.setName("Sync token")
			.setDesc(
				authMode === "unclaimed"
					? "Leave this blank until you claim the server in a browser, then use the YAOS setup link."
					: authMode === "env"
						? "Must match the SYNC_TOKEN configured on the server."
						: "Usually filled in automatically by the YAOS setup link after you claim the server.",
			)
			.addText((text) =>
				text
					.setPlaceholder("your-secret-token")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings();
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
					.setPlaceholder("auto-generated")
					.setValue(this.plugin.settings.vaultId)
					.onChange(async (value) => {
						this.plugin.settings.vaultId = value.trim();
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(advancedBody)
			.setName("Edits from other apps")
			.setDesc("Choose how YAOS handles file changes from git, scripts, or other editors.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("always", "Always import")
					.addOption("closed-only", "Only when file is closed")
					.addOption("never", "Never import")
					.setValue(this.plugin.settings.externalEditPolicy)
					.onChange(async (value) => {
						this.plugin.settings.externalEditPolicy = value as ExternalEditPolicy;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(advancedBody)
			.setName("Debug logging")
			.setDesc("Enable verbose console logs for troubleshooting.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debug)
					.onChange(async (value) => {
						this.plugin.settings.debug = value;
						await this.plugin.saveSettings();
					}),
			);

		advancedBody.createEl("p", {
			text: "Changing Server URL, Sync token, or Vault ID requires reloading the plugin.",
			cls: "setting-item-description",
		});
	}
}
