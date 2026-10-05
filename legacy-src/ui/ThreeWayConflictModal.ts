import { type App, Modal } from "obsidian";
import {
	resolveThreeWayText,
	type ThreeWayConflictChoice,
	type ThreeWayMergeResult,
} from "../sync/threeWayMerge";

type ConflictResult = Extract<ThreeWayMergeResult, { kind: "conflict" }>;

export class ThreeWayConflictModal extends Modal {
	private settled = false;
	private readonly choices: Array<ThreeWayConflictChoice | null>;

	constructor(
		app: App,
		private readonly path: string,
		private readonly conflict: ConflictResult,
		private readonly finish: (content: string | null) => void,
		private readonly stillCurrent: () => boolean,
	) {
		super(app);
		this.choices = conflict.conflicts.map(() => null);
	}

	onOpen(): void {
		this.titleEl.setText("Review offline note conflict");
		this.contentEl.createEl("p", {
			text: `${this.path} changed both on disk and in the synchronized body. Choose each overlapping region.`,
		});
		this.conflict.conflicts.forEach((region, index) => {
			const section = this.contentEl.createDiv({ cls: "yaos-three-way-conflict" });
			section.createEl("h3", { text: `Conflict ${index + 1}` });
			const select = section.createEl("select");
			const placeholder = select.createEl("option", { text: "Choose a resolution…" });
			placeholder.value = "";
			for (const [value, label] of [
				["body", "Use synchronized body"],
				["disk", "Use disk version"],
				["base", "Keep common base"],
			] as const) {
				const option = select.createEl("option", { text: label });
				option.value = value;
			}
			select.addEventListener("change", () => {
				this.choices[index] = select.value === ""
					? null
					: select.value as ThreeWayConflictChoice;
				apply.disabled = this.choices.some((choice) => choice === null);
			});

			for (const [label, content] of [
				["Common base", region.base],
				["Disk", region.disk],
				["Synchronized body", region.body],
			] as const) {
				section.createEl("strong", { text: label });
				section.createEl("pre", { text: content || "(empty)" });
			}
		});

		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = buttons.createEl("button", { text: "Preserve for later" });
		cancel.addEventListener("click", () => this.resolve(null));
		const apply = buttons.createEl("button", { text: "Apply resolution", cls: "mod-cta" });
		apply.disabled = true;
		apply.addEventListener("click", () => {
			if (!this.stillCurrent() || this.choices.some((choice) => choice === null)) {
				this.resolve(null);
				return;
			}
			this.resolve(resolveThreeWayText(
				this.conflict,
				this.choices as ThreeWayConflictChoice[],
			));
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) this.resolve(null);
	}

	private resolve(content: string | null): void {
		if (this.settled) return;
		this.settled = true;
		this.finish(content);
		this.close();
	}
}

export function reviewThreeWayConflict(
	app: App,
	path: string,
	conflict: ConflictResult,
	stillCurrent: () => boolean,
): Promise<string | null> {
	return new Promise((resolve) => {
		new ThreeWayConflictModal(app, path, conflict, resolve, stillCurrent).open();
	});
}
