/** Safety brake review dialog (DESIGN §f.5). Approve / Reject / Later. */

import { Modal, Notice, Setting, type App, type ButtonComponent } from "obsidian";
import type { BrakeReport } from "../../core/types";
import { pendingBrake, type YaosUiHost } from "./api";
import { brakeCopy } from "./brake";
import { errorMessage, plural } from "./format";

export class BrakeModal extends Modal {
	private busy = false;
	private buttons: ButtonComponent[] = [];
	private unsubscribe: (() => void) | null = null;

	constructor(
		app: App,
		private readonly host: YaosUiHost,
		readonly report: BrakeReport,
		private readonly onClosed?: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("yaos-brake-modal");
		const copy = brakeCopy(this.report);
		this.setTitle(copy.title);
		contentEl.createEl("p", { text: copy.reason });
		contentEl.createEl("p", { text: copy.counts });
		if (copy.samplePaths.length > 0) {
			contentEl.createEl("p", { text: "Affected files include:" });
			const list = contentEl.createEl("ul", { cls: "yaos-brake-paths" });
			for (const path of copy.samplePaths) list.createEl("li").createEl("code", { text: path });
			if (copy.moreCount > 0) contentEl.createEl("p", { text: `…and ${plural(copy.moreCount, "more change")}.` });
		}
		contentEl.createEl("p", { text: copy.approveHint });
		contentEl.createEl("p", { text: copy.rejectHint });
		contentEl.createEl("p", { text: "Later keeps everything on hold. Sync of other changes continues; you can review this again from the status bar or the \"Review held changes\" command." });

		this.buttons = [];
		new Setting(contentEl)
			.addButton((b) => { this.buttons.push(b); b.setButtonText("Later").onClick(() => this.close()); })
			.addButton((b) => { this.buttons.push(b); b.setButtonText("Reject").setCta().onClick(() => { void this.decide("rejectBrake"); }); })
			.addButton((b) => { this.buttons.push(b); b.setButtonText("Approve").setWarning().onClick(() => { void this.decide("approveBrake"); }); });

		// Close by itself if the brake is resolved elsewhere (another window, a command).
		this.unsubscribe = this.host.onChange(() => {
			if (this.busy) return;
			if (pendingBrake(this.host)?.id !== this.report.id) this.close();
		});
	}

	private async decide(kind: "approveBrake" | "rejectBrake"): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		for (const b of this.buttons) b.setDisabled(true);
		try {
			await this.host.command({ t: kind, brakeId: this.report.id });
			new Notice(kind === "approveBrake"
				? "YAOS: approved. A recovery snapshot was saved and the held changes are being applied."
				: "YAOS: rejected. Your files were kept.");
			this.busy = false;
			this.close();
		} catch (err) {
			new Notice(`YAOS: could not ${kind === "approveBrake" ? "approve" : "reject"} the held changes: ${errorMessage(err)}`, 8000);
			this.busy = false;
			for (const b of this.buttons) b.setDisabled(false);
		}
	}

	onClose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.buttons = [];
		this.contentEl.empty();
		this.onClosed?.();
	}
}
