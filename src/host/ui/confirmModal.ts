/** Confirmation dialog. Ported from the old client (adfa7a7:src/ui/ConfirmModal.ts). */

import { Modal, type App } from "obsidian";

export interface ConfirmOptions {
	readonly title: string;
	readonly message: string;
	readonly confirmText?: string;
	readonly cancelText?: string;
	/** Style the confirm button as destructive (default true). */
	readonly destructive?: boolean;
	readonly onConfirm: () => void | Promise<void>;
	readonly onCancel?: () => void;
}

export class ConfirmModal extends Modal {
	private confirmed = false;

	constructor(app: App, private readonly opts: ConfirmOptions) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(this.opts.title);
		for (const paragraph of this.opts.message.split("\n\n")) contentEl.createEl("p", { text: paragraph });
		const row = contentEl.createDiv({ cls: "modal-button-container" });
		row.createEl("button", { text: this.opts.cancelText ?? "Cancel" }).addEventListener("click", () => this.close());
		const confirm = row.createEl("button", {
			text: this.opts.confirmText ?? "Confirm",
			cls: this.opts.destructive === false ? "mod-cta" : "mod-warning",
		});
		confirm.addEventListener("click", () => {
			this.confirmed = true;
			this.close();
			void this.opts.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.confirmed) this.opts.onCancel?.();
	}
}

/** Resolves true when confirmed, false when cancelled or closed. */
export function confirmAction(app: App, opts: Omit<ConfirmOptions, "onConfirm" | "onCancel">): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, { ...opts, onConfirm: () => resolve(true), onCancel: () => resolve(false) }).open();
	});
}
