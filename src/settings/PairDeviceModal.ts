import { App, Modal, Notice } from "obsidian";
import * as QRCode from "qrcode";

function createDetailsSection(containerEl: HTMLElement, title: string, open = false): HTMLDetailsElement {
	const detailsEl = containerEl.createEl("details", { cls: "yaos-settings-details" });
	detailsEl.open = open;
	detailsEl.createEl("summary", {
		text: title,
		cls: "yaos-settings-details-summary",
	});
	return detailsEl;
}

export class PairDeviceModal extends Modal {
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
			text: "Scan this setup code on your phone to open the setup page. If the plugin is not installed yet, the page will guide you through the beta install flow first.",
			cls: "yaos-modal-copy",
		});

		const qrWrap = contentEl.createDiv({ cls: "yaos-pair-device-qr-wrap" });

		const loadingEl = qrWrap.createEl("div", {
			text: "Generating setup code...",
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
				this.qrCanvas.setAttr("aria-label", "Mobile setup code");
			}
		}).catch(() => {
			loadingEl.setText("Could not generate a setup code.");
			if (this.qrCanvas) {
				this.qrCanvas.remove();
				this.qrCanvas = null;
			}
		});

		const primaryButtons = contentEl.createDiv({ cls: "modal-button-container" });
		primaryButtons.createEl("button", { text: "Copy mobile setup URL" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.mobileUrl).then(
				() => new Notice("Mobile setup URL copied."),
				() => new Notice("Failed to copy the mobile setup URL.", 6000),
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
				() => new Notice("Mobile setup URL copied."),
				() => new Notice("Failed to copy the mobile setup URL.", 6000),
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
				() => new Notice("Desktop deep link copied."),
				() => new Notice("Failed to copy the desktop deep link.", 6000),
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
