// YAOS spike: results modal (summary + full JSON + copy/save buttons).
import { Modal, Notice, type App } from "obsidian";

export interface ResultsModalOptions {
	title: string;
	summary: string[];
	json: string;
	/** Writes the report into the vault and resolves to the created path. */
	onSave?: () => Promise<string>;
}

export type CopyOutcome = "clipboard" | "execCommand" | "failed";

/** navigator.clipboard first; fall back to selecting the textarea + execCommand("copy") (older WebViews, iOS quirks). */
export async function copyText(text: string, fallback: HTMLTextAreaElement | null): Promise<CopyOutcome> {
	try {
		if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
			await navigator.clipboard.writeText(text);
			return "clipboard";
		}
	} catch {
		/* fall through */
	}
	if (!fallback) return "failed";
	const wasReadOnly = fallback.readOnly;
	try {
		fallback.readOnly = false; // iOS will not select inside a readonly textarea
		fallback.focus();
		fallback.select();
		fallback.setSelectionRange(0, fallback.value.length);
		return document.execCommand("copy") ? "execCommand" : "failed";
	} catch {
		return "failed";
	} finally {
		fallback.readOnly = wasReadOnly;
	}
}

export class ResultsModal extends Modal {
	constructor(
		app: App,
		private readonly opts: ResultsModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(this.opts.title);
		const list = contentEl.createEl("ul");
		for (const line of this.opts.summary) list.createEl("li", { text: line });

		const row = contentEl.createDiv({ attr: { style: "display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;" } });
		const copyBtn = row.createEl("button", { text: "Copy report", cls: "mod-cta" });
		const saveBtn = this.opts.onSave ? row.createEl("button", { text: "Save report to vault" }) : null;

		const ta = contentEl.createEl("textarea", {
			attr: { rows: "16", spellcheck: "false", style: "width:100%;font-family:var(--font-monospace);font-size:11px;white-space:pre;" },
		});
		ta.value = this.opts.json;
		ta.readOnly = true;

		copyBtn.addEventListener("click", () => {
			void copyText(this.opts.json, ta).then((how) => {
				new Notice(how === "failed" ? "Copy failed: long-press the text box to select all, or use Save report to vault" : "Copied");
			});
		});
		const onSave = this.opts.onSave;
		if (saveBtn && onSave) {
			saveBtn.addEventListener("click", () => {
				saveBtn.disabled = true;
				onSave().then(
					(path) => new Notice(`Saved ${path}`, 8000),
					(e: unknown) => {
						saveBtn.disabled = false;
						new Notice(`Save failed: ${e instanceof Error ? e.message : String(e)}`, 8000);
					},
				);
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
