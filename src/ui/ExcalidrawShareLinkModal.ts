import { App, Modal, Notice } from "obsidian";

export class ExcalidrawShareLinkModal extends Modal {
	constructor(app: App, private readonly url: string, private readonly expiresAt: number) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h3", { text: "Read-only Excalidraw link" });
		this.contentEl.createEl("p", {
			text: "Anyone with this link can watch the drawing live until it expires. This demo link includes shapes and text; embedded resources are excluded.",
		});
		this.contentEl.createEl("p", { text: `Expires ${new Date(this.expiresAt).toLocaleString()}.` });
		const input = this.contentEl.createEl("textarea");
		input.value = this.url;
		input.readOnly = true;
		input.rows = 5;
		input.addClass("yaos-excalidraw-share-link");
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Copy link", cls: "mod-cta" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.url).then(
				() => new Notice("Excalidraw browser link copied."),
				() => new Notice("Could not copy the link; copy it from the text box.", 6000),
			);
		});
		buttons.createEl("button", { text: "Open in browser" }).addEventListener("click", () => {
			window.open(this.url, "_blank", "noopener");
		});
		buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
