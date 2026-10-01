import { App, Modal } from "obsidian";
import type { ConflictEpisode } from "../sync/conflictEpisodes";
import { openModalInMainWindow } from "../host/obsidianHostAdapter";

export class ConflictListModal extends Modal {
	constructor(app: App, private readonly episodes: ConflictEpisode[], private readonly review: (bodyId: string) => void) {
		super(app);
	}
	onOpen(): void {
		this.titleEl.setText("Review YAOS conflicts");
		if (!this.episodes.length) this.contentEl.createEl("p", { text: "No notes need a conflict decision." });
		for (const episode of this.episodes) {
			const row = this.contentEl.createDiv();
			row.createEl("button", { text: episode.path }).addEventListener("click", () => {
				this.close();
				this.review(episode.bodyId);
			});
			for (const part of episode.parts) row.createEl("p", { text: part });
			for (const obstruction of episode.obstructions ?? []) {
				row.createEl("p", { text: `Left untouched during artifact recovery: ${obstruction}` });
			}
			for (const [previous, current] of Object.entries(episode.relocations ?? {})) {
				row.createEl("p", { text: `Recovered artifact: ${previous} → ${current}. Historical links may still reference the previous path.` });
			}
			if (episode.error) row.createEl("p", { text: episode.error });
		}
	}
	onClose(): void {
		this.contentEl.empty();
	}
	open(): void {
		openModalInMainWindow(this.app, this, () => super.open());
	}
}
