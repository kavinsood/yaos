/**
 * The device check's results (deviceCheck.ts): a summary, one line per step (mark, name, time, detail; the error
 * text under a failed one), the report's notes, and Copy report / Save report. Plain list and paragraph elements,
 * so it wraps on a narrow phone screen and scrolls inside the modal.
 */

import { Modal, Notice, type App } from "obsidian";
import { stepLine, summaryLine, type DeviceCheckRun } from "./deviceCheck";
import { errorMessage } from "./format";

export interface DeviceCheckActions {
	/** Clipboard writer (obsidianEnv.ts copyText). */
	copy(text: string): Promise<void>;
	/** Writes the file next to the diagnostics files; resolves to its vault-relative path. */
	save(name: string, text: string): Promise<string>;
}

export class DeviceCheckModal extends Modal {
	constructor(app: App, private readonly run: DeviceCheckRun, private readonly actions: DeviceCheckActions) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const { report, text, fileName } = this.run;
		contentEl.empty();
		this.setTitle(report.mode === "quick" ? "YAOS device check" : "YAOS large attachment check");
		contentEl.createEl("p", { text: summaryLine(report) });
		const list = contentEl.createEl("ul");
		for (const s of report.steps) {
			const li = list.createEl("li", { text: stepLine(s), cls: s.status === "fail" ? "mod-warning" : undefined });
			if (s.error !== null && s.error !== s.detail) li.createEl("div", { cls: "setting-item-description", text: s.error });
		}
		for (const note of report.notes) contentEl.createEl("p", { cls: "setting-item-description", text: note });
		const savedEl = contentEl.createEl("p", { cls: "setting-item-description" });
		const row = contentEl.createDiv({ cls: "modal-button-container" });
		const copy = row.createEl("button", { text: "Copy report" });
		const save = row.createEl("button", { text: "Save report", cls: "mod-cta" });
		copy.addEventListener("click", () => {
			this.actions.copy(text).then(
				() => { new Notice("YAOS: device check report copied to the clipboard."); },
				(err: unknown) => { new Notice(`YAOS: could not copy the report (${errorMessage(err)}). Use Save report instead.`, 8000); },
			);
		});
		save.addEventListener("click", () => {
			save.disabled = true;
			this.actions.save(fileName, text).then(
				(path) => {
					savedEl.setText(`Saved to ${path}`);
					new Notice(`YAOS: device check report saved to ${path}.`, 8000);
				},
				(err: unknown) => {
					save.disabled = false;
					new Notice(`YAOS: could not save the report: ${errorMessage(err)}`, 8000);
				},
			);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
