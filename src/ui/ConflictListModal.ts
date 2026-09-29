import { App, Modal } from "obsidian";
import type { ConflictEpisode } from "../sync/conflictEpisodes";

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
			if (episode.error) row.createEl("p", { text: episode.error });
		}
	}
	onClose(): void {
		this.contentEl.empty();
	}
}
