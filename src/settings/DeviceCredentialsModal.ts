import { App, Modal, Notice } from "obsidian";

export class DeviceCredentialsModal extends Modal {
	constructor(app: App, private readonly credentials: string) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaos-device-credentials-modal");

		contentEl.createEl("h3", { text: "Device credentials" });

		const warning = contentEl.createDiv({ cls: "callout yaos-settings-callout" });
		warning.setAttr("data-callout", "warning");

		const warningTitle = warning.createDiv({ cls: "callout-title" });
		warningTitle.createSpan({ text: "Private to this device" });

		const warningBody = warning.createDiv({ cls: "callout-content" });
		warningBody.createEl("p", {
			text: "These credentials authorize only this enrolled device. Store them securely. Pair another device instead of sharing them.",
		});

		const textArea = contentEl.createEl("textarea", { cls: "yaos-settings-modal-textarea" });
		textArea.value = this.credentials;
		textArea.readOnly = true;
		textArea.rows = 10;

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Copy device credentials" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.credentials).then(
				() => new Notice("Device credentials copied."),
				() => new Notice("Failed to copy the device credentials.", 6000),
			);
		});
		buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
