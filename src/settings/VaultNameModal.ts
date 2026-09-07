import { type App, Modal } from "obsidian";

export class VaultNameModal extends Modal {
	constructor(
		app: App,
		private readonly initialName: string,
		private readonly onSubmit: (name: string) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Rename shared vault" });
		contentEl.createEl("p", { text: "This changes shared server metadata. It does not rename anyone's local folder." });
		const input = contentEl.createEl("input");
		input.type = "text";
		input.maxLength = 80;
		input.value = this.initialName;
		input.setAttr("aria-label", "Shared vault name");
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const submit = buttons.createEl("button", { text: "Rename", cls: "mod-cta" });
		const update = (): void => { submit.disabled = input.value.trim().length === 0; };
		const finish = (): void => {
			const name = input.value.trim();
			if (!name) return;
			this.close();
			void this.onSubmit(name);
		};
		input.addEventListener("input", update);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") finish();
		});
		submit.addEventListener("click", finish);
		update();
		input.focus();
		input.select();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
