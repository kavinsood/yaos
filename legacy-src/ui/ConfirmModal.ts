import { type App, Modal } from "obsidian";

/**
 * Simple confirmation modal with a message and confirm/cancel buttons.
 */
export class ConfirmModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly onConfirm: () => void | Promise<void>,
		private readonly confirmText = "Confirm",
		private readonly cancelText = "Cancel",
		private readonly onCancel?: () => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.message });

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

		buttonRow
			.createEl("button", { text: this.cancelText })
			.addEventListener("click", () => this.close());

		const confirmBtn = buttonRow.createEl("button", {
			text: this.confirmText,
			cls: "mod-warning",
		});
		confirmBtn.addEventListener("click", () => {
			this.confirmed = true;
			this.close();
			void this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.confirmed && this.onCancel) {
			void this.onCancel();
		}
	}
}
