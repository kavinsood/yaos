import { App, Modal, Notice } from "obsidian";

export class RecoveryKitModal extends Modal {
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
			text: "Save this somewhere safe, like a password manager. If you lose all your devices, you will need this exact vault ID and token to recover your notes from your server.",
		});

		const textArea = contentEl.createEl("textarea", { cls: "yaos-settings-modal-textarea" });
		textArea.value = this.recoveryKit;
		textArea.readOnly = true;
		textArea.rows = 10;

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Copy connection details" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.recoveryKit).then(
				() => new Notice("Connection details copied."),
				() => new Notice("Failed to copy the connection details.", 6000),
			);
		});
		buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
